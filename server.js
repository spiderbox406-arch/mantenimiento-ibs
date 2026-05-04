require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const multer = require('multer');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
if (!process.env.DATABASE_URL) console.warn('Falta DATABASE_URL. Configúralo en Render/Neon.');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : false
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const uploadDir = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, '_');
    cb(null, Date.now() + '_' + safeName);
  }
});
const uploadImages = multer({
  storage: imageStorage,
  limits: { fileSize: 8 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => {
    if(!file.mimetype.startsWith('image/')) return cb(new Error('Solo se permiten imágenes.'));
    cb(null, true);
  }
});

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  name: 'ibs_sid',
  secret: process.env.SESSION_SECRET || 'dev_secret_cambiar',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function clean(v){ return String(v ?? '').trim(); }
function norm(v){ return clean(v).toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function requireLogin(req,res,next){ if(!req.session.user) return res.status(401).json({error:'Sesión vencida. Inicia sesión otra vez.'}); next(); }
function requireAdmin(req,res,next){ if(!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({error:'Solo administrador.'}); next(); }
function canExportExcel(req){
  return Boolean(req.session.user && (req.session.user.role === 'admin' || req.session.user.can_export === true));
}
function requireCanExport(req,res,next){
  if(!canExportExcel(req)) return res.status(403).json({error:'No tienes permiso para exportar Excel.'});
  next();
}
function publicUser(u){ if(!u) return null; const { password_hash, failed_login_attempts, ...safe } = u; return safe; }
async function logAction(userId, action, details = {}){
  try { await pool.query('insert into user_activity_log(user_id, action, details) values($1,$2,$3)', [userId || null, action, JSON.stringify(details)]); } catch(e){ console.error('logAction', e.message); }
}

function minutesBetween(a, b){
  if(!a || !b) return 0;
  const start = new Date(a).getTime();
  const end = new Date(b).getTime();
  if(!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.max(0, Math.round((end - start) / 60000));
}
function calcTicketTimes(t, nowDate = new Date()){
  const creado = t.creado ? new Date(t.creado) : null;
  const liberado = t.liberado ? new Date(t.liberado) : null;
  const iniciado = t.iniciado ? new Date(t.iniciado) : null;
  const terminado = t.terminado ? new Date(t.terminado) : null;
  const totalEnd = liberado || nowDate;
  const mttoEnd = terminado || (t.estado === 'En atención' ? nowDate : null);
  const muertoTotalMin = creado ? minutesBetween(creado, totalEnd) : 0;
  const mttoMin = iniciado && mttoEnd ? minutesBetween(iniciado, mttoEnd) : 0;
  const esperaInicioMin = creado ? (iniciado ? minutesBetween(creado, iniciado) : minutesBetween(creado, nowDate)) : 0;
  const esperaValidacionMin = terminado ? minutesBetween(terminado, liberado || nowDate) : 0;
  const produccionMin = Math.max(0, muertoTotalMin - mttoMin);
  return { mttoMin, produccionMin, muertoTotalMin, esperaInicioMin, esperaValidacionMin };
}
function decorateTicket(t){
  const tiempos = calcTicketTimes(t);
  return {...t, responsableActual:t.tecnico_username || '', tiempos};
}

async function initDb(){
  await pool.query(`
    create table if not exists users(
      id bigserial primary key,
      numero_empleado text,
      name text not null,
      username text not null unique,
      password_hash text not null,
      role text not null default 'operaciones',
      status text not null default 'activo',
      must_change_password boolean not null default false,
      can_export boolean not null default false,
      area_asignada text,
      sucursal text,
      telefono text,
      correo text,
      failed_login_attempts int not null default 0,
      locked_until timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists activos(
      id bigserial primary key,
      numero text not null unique,
      descripcion text not null,
      area text,
      tipo text,
      sucursal text,
      ubicacion text,
      marca text,
      modelo text,
      usuario text,
      estatus text,
      search_text text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists tickets(
      id bigserial primary key,
      activo text,
      activo_descripcion text,
      area text,
      sucursal text,
      ubicacion text,
      solicitante text,
      empleado_solicitante text,
      telefono_solicitante text,
      falla text not null,
      prioridad text default 'Normal',
      tipo_falla text,
      estado text not null default 'Reportado',
      tecnico_username text,
      diagnostico text,
      solucion text,
      fotos_reporte jsonb not null default '[]'::jsonb,
      fotos_trabajo jsonb not null default '[]'::jsonb,
      creado timestamptz not null default now(),
      asignado timestamptz,
      iniciado timestamptz,
      terminado timestamptz,
      liberado timestamptz,
      mtto_min int default 0,
      produccion_min int default 0,
      created_by bigint references users(id)
    );
    create table if not exists user_activity_log(
      id bigserial primary key,
      user_id bigint references users(id),
      action text not null,
      details jsonb default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
  `);

  // Migraciones seguras para bases Neon existentes
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS numero_empleado text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'activo';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS area_asignada text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS sucursal text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS telefono text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS correo text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts int NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS can_export boolean NOT NULL DEFAULT false;

    ALTER TABLE activos ADD COLUMN IF NOT EXISTS ubicacion text;
    ALTER TABLE activos ADD COLUMN IF NOT EXISTS marca text;
    ALTER TABLE activos ADD COLUMN IF NOT EXISTS modelo text;
    ALTER TABLE activos ADD COLUMN IF NOT EXISTS usuario text;
    ALTER TABLE activos ADD COLUMN IF NOT EXISTS estatus text;
    ALTER TABLE activos ADD COLUMN IF NOT EXISTS search_text text;

    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ubicacion text;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS solicitante text;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS empleado_solicitante text;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS telefono_solicitante text;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tipo_falla text;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tecnico_username text;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS diagnostico text;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS solucion text;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS asignado timestamptz;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS iniciado timestamptz;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS terminado timestamptz;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS liberado timestamptz;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS mtto_min int DEFAULT 0;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS produccion_min int DEFAULT 0;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS fotos_reporte jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS fotos_trabajo jsonb NOT NULL DEFAULT '[]'::jsonb;
  `);


  await pool.query(`
    UPDATE tickets
    SET estado = 'Reportado'
    WHERE estado IS NULL OR trim(estado) = '';
  `);

  // Reparar ID de tickets en bases antiguas:
  // Si id es numérico, se agrega secuencia.
  // Si id es texto, se agrega default tipo MTTO-xxxx.
  await pool.query(`
    DO $$
    DECLARE
      id_type text;
    BEGIN
      SELECT data_type INTO id_type
      FROM information_schema.columns
      WHERE table_name='tickets' AND column_name='id';

      IF id_type IN ('integer','bigint','smallint') THEN
        CREATE SEQUENCE IF NOT EXISTS tickets_id_seq;
        EXECUTE 'ALTER TABLE tickets ALTER COLUMN id SET DEFAULT nextval(''tickets_id_seq'')';
        PERFORM setval('tickets_id_seq', COALESCE((SELECT MAX(id::bigint) FROM tickets),0) + 1, false);
      ELSIF id_type IN ('text','character varying','character') THEN
        EXECUTE 'ALTER TABLE tickets ALTER COLUMN id SET DEFAULT (''MTTO-'' || floor(extract(epoch from clock_timestamp()) * 1000)::text)';
      END IF;
    END $$;
  `);

  const c = await pool.query('select count(*)::int as n from users');
  if(c.rows[0].n === 0){
    const hash = await bcrypt.hash('1234', 12);
    await pool.query(`insert into users(name, username, password_hash, role, status, must_change_password) values($1,$2,$3,$4,$5,$6)`, ['Administrador IBS','admin',hash,'admin','activo',true]);
    console.log('Usuario inicial creado: admin / 1234');
  } else {
    // No se reinicia la contraseña del admin en cada arranque.
    // Solo se corrige si el admin existe pero no tiene password_hash.
    const admin = await pool.query("select id, password_hash from users where lower(username)='admin' limit 1");
    if(admin.rows[0] && !admin.rows[0].password_hash){
      const hash = await bcrypt.hash('1234', 12);
      await pool.query("update users set password_hash=$1, status='activo', role='admin', must_change_password=true, updated_at=now() where id=$2", [hash, admin.rows[0].id]);
      console.log('Admin reparado: admin / 1234');
    }
  }
}


app.get('/api/health', async (req,res)=>{
  try{
    const r = await pool.query('select now() as hora');
    res.json({ok:true, db:'Neon conectado', hora:r.rows[0].hora});
  }catch(e){
    res.status(500).json({ok:false, error:e.message});
  }
});

app.get('/api/me', (req,res)=> res.json({user:req.session.user || null}));
app.post('/api/login', async (req,res)=>{
  const username = clean(req.body.username).toLowerCase();
  const password = String(req.body.password || '');
  if(!username || !password) return res.status(400).json({error:'Usuario y contraseña son obligatorios.'});
  const r = await pool.query('select * from users where lower(username)=lower($1)', [username]);
  const user = r.rows[0];
  if(!user) return res.status(401).json({error:'Usuario o contraseña incorrectos.'});
  if(user.status !== 'activo') return res.status(403).json({error:'Usuario inactivo. Contacta al administrador.'});
  if(user.locked_until && new Date(user.locked_until) > new Date()) return res.status(423).json({error:'Usuario bloqueado temporalmente por intentos fallidos.'});
  const ok = await bcrypt.compare(password, user.password_hash);
  if(!ok){
    const attempts = (user.failed_login_attempts || 0) + 1;
    const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15*60*1000) : null;
    await pool.query('update users set failed_login_attempts=$1, locked_until=$2 where id=$3', [attempts, lockedUntil, user.id]);
    return res.status(401).json({error:'Usuario o contraseña incorrectos.'});
  }
  await pool.query('update users set failed_login_attempts=0, locked_until=null where id=$1', [user.id]);
  req.session.user = publicUser(user);
  await logAction(user.id, 'login', {username});
  res.json({user:req.session.user});
});
app.post('/api/logout', requireLogin, async (req,res)=>{ const uid=req.session.user.id; req.session.destroy(()=>{}); await logAction(uid,'logout'); res.json({ok:true}); });
app.post('/api/change-password', requireLogin, async (req,res)=>{
  const oldPassword = String(req.body.oldPassword || '');
  const newPassword = String(req.body.newPassword || '');
  if(newPassword.length < 6) return res.status(400).json({error:'La nueva contraseña debe tener mínimo 6 caracteres.'});
  const r = await pool.query('select * from users where id=$1', [req.session.user.id]);
  const user = r.rows[0];
  const ok = await bcrypt.compare(oldPassword, user.password_hash);
  if(!ok) return res.status(401).json({error:'La contraseña actual no coincide.'});
  const hash = await bcrypt.hash(newPassword, 12);
  const updated = await pool.query(
    'update users set password_hash=$1, must_change_password=false, failed_login_attempts=0, locked_until=null, updated_at=now() where id=$2 returning *',
    [hash, user.id]
  );
  req.session.user = publicUser(updated.rows[0]);
  await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
  await logAction(user.id, 'change_password');
  res.json({ok:true, user:req.session.user});
});

app.get('/api/bootstrap', requireLogin, async (req,res)=>{
  const [a,t] = await Promise.all([
    pool.query('select * from activos order by numero limit 5000'),
    pool.query("select id, name, username, correo from users where status='activo' and role in ('tecnico','mantenimiento','admin') order by name")
  ]);

  let empleados = [];
  if(req.session.user.role === 'admin'){
    const e = await pool.query('select id, numero_empleado, name, username, role, status, must_change_password, can_export, area_asignada, sucursal, telefono, correo, created_at, updated_at from users order by name limit 2000');
    empleados = e.rows;
  }

  res.json({activos:a.rows, empleados, tecnicos:t.rows});
});

app.get('/api/activos', requireLogin, async (req,res)=>{
  const q = norm(req.query.q || '');
  const params = [];
  let where = '';
  if(q){ params.push('%' + q + '%'); where = 'where search_text like $1'; }
  const r = await pool.query(`select * from activos ${where} order by numero limit 1000`, params);
  res.json(r.rows);
});
app.post('/api/activos', requireAdmin, async (req,res)=>{
  const a = req.body;
  if(!clean(a.numero) || !clean(a.descripcion)) return res.status(400).json({error:'Número y descripción son obligatorios.'});
  const search = norm([a.numero,a.descripcion,a.area,a.tipo,a.sucursal,a.ubicacion,a.marca,a.modelo,a.usuario,a.estatus].join(' '));
  const r = await pool.query(`insert into activos(numero,descripcion,area,tipo,sucursal,ubicacion,marca,modelo,usuario,estatus,search_text)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    on conflict(numero) do update set descripcion=excluded.descripcion, area=excluded.area, tipo=excluded.tipo, sucursal=excluded.sucursal, ubicacion=excluded.ubicacion, marca=excluded.marca, modelo=excluded.modelo, usuario=excluded.usuario, estatus=excluded.estatus, search_text=excluded.search_text, updated_at=now()
    returning *`, [clean(a.numero),clean(a.descripcion),clean(a.area),clean(a.tipo),clean(a.sucursal),clean(a.ubicacion),clean(a.marca),clean(a.modelo),clean(a.usuario),clean(a.estatus||'VIGENTE'),search]);
  await logAction(req.session.user.id, 'upsert_asset', {numero:a.numero});
  res.json(r.rows[0]);
});

app.post('/api/import/activos', requireAdmin, upload.single('archivo'), async (req,res)=>{
  if(!req.file) return res.status(400).json({error:'Sube un archivo Excel.'});
  const wb = XLSX.read(req.file.buffer, { type:'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval:'' });
  let agregados=0, actualizados=0, omitidos=0;
  for(const row of rows){
    const a = {
      numero: row['NUM ACTIVO'] ?? row['numero'] ?? row['NUMERO'] ?? row['No ACTIVO'],
      descripcion: row['DESCRIPCION'] ?? row['DESCRIPCIÓN'] ?? row['descripcion'],
      area: row['AREA'] ?? row['area'],
      tipo: row['TIPO'] ?? row['tipo'],
      sucursal: row['SUCURSAL'] ?? row['sucursal'],
      ubicacion: row['UBICACION'] ?? row['UBICACIÓN'] ?? row['ubicacion'],
      marca: row['MARCA'] ?? row['marca'],
      modelo: row['MODELO'] ?? row['modelo'],
      usuario: row['USUARIO'] ?? row['usuario'],
      estatus: row['ESTATUS'] ?? row['ESTADO'] ?? row['estatus']
    };
    if(!clean(a.numero) || !clean(a.descripcion)){ omitidos++; continue; }
    const search = norm([a.numero,a.descripcion,a.area,a.tipo,a.sucursal,a.ubicacion,a.marca,a.modelo,a.usuario,a.estatus].join(' '));
    const exists = await pool.query('select id from activos where numero=$1', [clean(a.numero)]);
    await pool.query(`insert into activos(numero,descripcion,area,tipo,sucursal,ubicacion,marca,modelo,usuario,estatus,search_text)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      on conflict(numero) do update set descripcion=excluded.descripcion, area=excluded.area, tipo=excluded.tipo, sucursal=excluded.sucursal, ubicacion=excluded.ubicacion, marca=excluded.marca, modelo=excluded.modelo, usuario=excluded.usuario, estatus=excluded.estatus, search_text=excluded.search_text, updated_at=now()`,
      [clean(a.numero),clean(a.descripcion),clean(a.area),clean(a.tipo),clean(a.sucursal),clean(a.ubicacion),clean(a.marca),clean(a.modelo),clean(a.usuario),clean(a.estatus),search]);
    exists.rows.length ? actualizados++ : agregados++;
  }
  await logAction(req.session.user.id, 'import_assets', {agregados,actualizados,omitidos});
  res.json({agregados,actualizados,omitidos,total:rows.length});
});

app.get('/api/users', requireAdmin, async (req,res)=>{
  const q = norm(req.query.q || '');
  let params=[], where='';
  if(q){ params.push('%'+q+'%'); where = `where upper(coalesce(numero_empleado,'')||' '||coalesce(name,'')||' '||coalesce(username,'')||' '||coalesce(role,'')||' '||coalesce(area_asignada,'')||' '||coalesce(sucursal,'')||' '||coalesce(status,'')) like $1`; }
  const r = await pool.query(`select id, numero_empleado, name, username, role, status, must_change_password, can_export, area_asignada, sucursal, telefono, correo, created_at, updated_at from users ${where} order by name`, params);
  res.json(r.rows);
});
app.post('/api/users', requireAdmin, async (req,res)=>{
  const u=req.body; const pass=String(u.password || 'Temp1234');
  if(!clean(u.username) || !clean(u.name)) return res.status(400).json({error:'Usuario y nombre son obligatorios.'});
  const hash=await bcrypt.hash(pass,12);
  const r=await pool.query(`insert into users(numero_empleado,name,username,password_hash,role,status,must_change_password,area_asignada,sucursal,telefono,correo)
    values($1,$2,lower($3),$4,$5,'activo',true,$6,$7,$8,$9) returning id, numero_empleado, name, username, role, status, must_change_password, area_asignada, sucursal, telefono, correo`,
    [clean(u.numero_empleado),clean(u.name),clean(u.username),hash,clean(u.role||'operaciones'),clean(u.area_asignada),clean(u.sucursal),clean(u.telefono),clean(u.correo)]);
  await logAction(req.session.user.id, 'create_user', {username:u.username});
  res.json(r.rows[0]);
});
app.put('/api/users/:id', requireAdmin, async (req,res)=>{
  const u=req.body;
  const r=await pool.query(`update users set numero_empleado=$1,name=$2,username=lower($3),role=$4,status=$5,area_asignada=$6,sucursal=$7,telefono=$8,correo=$9,can_export=$10,updated_at=now() where id=$11 returning id, numero_empleado, name, username, role, status, must_change_password, can_export, area_asignada, sucursal, telefono, correo`,
    [clean(u.numero_empleado),clean(u.name),clean(u.username),clean(u.role),clean(u.status),clean(u.area_asignada),clean(u.sucursal),clean(u.telefono),clean(u.correo),Boolean(u.can_export),req.params.id]);
  await logAction(req.session.user.id, 'update_user', {id:req.params.id});
  res.json(r.rows[0]);
});
app.post('/api/users/:id/reset-password', requireAdmin, async (req,res)=>{
  const pass=String(req.body.password || 'Temp1234');
  if(pass.length < 6) return res.status(400).json({error:'La contraseña debe tener mínimo 6 caracteres.'});
  const hash=await bcrypt.hash(pass,12);
  await pool.query('update users set password_hash=$1,must_change_password=true,failed_login_attempts=0,locked_until=null,updated_at=now() where id=$2',[hash,req.params.id]);
  await logAction(req.session.user.id, 'reset_user_password', {id:req.params.id});
  res.json({ok:true});
});
app.delete('/api/users/:id', requireAdmin, async (req,res)=>{
  if(String(req.params.id) === String(req.session.user.id)) return res.status(400).json({error:'No puedes desactivarte a ti mismo.'});
  await pool.query("update users set status='inactivo', updated_at=now() where id=$1", [req.params.id]);
  await logAction(req.session.user.id, 'deactivate_user', {id:req.params.id});
  res.json({ok:true});
});
app.post('/api/import/empleados', requireAdmin, upload.single('archivo'), async (req,res)=>{
  if(!req.file) return res.status(400).json({error:'Sube un archivo Excel.'});
  const wb=XLSX.read(req.file.buffer,{type:'buffer'}); const ws=wb.Sheets[wb.SheetNames[0]]; const rows=XLSX.utils.sheet_to_json(ws,{defval:''});
  let agregados=0,actualizados=0,omitidos=0;
  for(const row of rows){
    const username=clean(row.usuario ?? row.USUARIO ?? row.username ?? row.USERNAME);
    const name=clean(row.nombre ?? row.NOMBRE ?? row.name ?? row.NAME);
    if(!username || !name){omitidos++; continue;}
    const exists=await pool.query('select id from users where lower(username)=lower($1)',[username]);
    const role=clean(row.rol ?? row.ROL ?? 'operaciones').toLowerCase();
    if(exists.rows.length){
      await pool.query(`update users set numero_empleado=$1,name=$2,role=$3,sucursal=$4,area_asignada=$5,telefono=$6,correo=$7,updated_at=now() where id=$8`, [clean(row.numeroEmpleado ?? row.NUMERO_EMPLEADO ?? row['NUM EMPLEADO']),name,role,clean(row.sucursal ?? row.SUCURSAL),clean(row.areaAsignada ?? row.AREA ?? row.area),clean(row.telefono ?? row.TELEFONO),clean(row.correo ?? row.CORREO),exists.rows[0].id]);
      actualizados++;
    } else {
      const pass=String(row.password ?? row.PASSWORD ?? 'Temp1234'); const hash=await bcrypt.hash(pass,12);
      await pool.query(`insert into users(numero_empleado,name,username,password_hash,role,status,must_change_password,sucursal,area_asignada,telefono,correo) values($1,$2,lower($3),$4,$5,'activo',true,$6,$7,$8,$9)`, [clean(row.numeroEmpleado ?? row.NUMERO_EMPLEADO ?? row['NUM EMPLEADO']),name,username,hash,role,clean(row.sucursal ?? row.SUCURSAL),clean(row.areaAsignada ?? row.AREA ?? row.area),clean(row.telefono ?? row.TELEFONO),clean(row.correo ?? row.CORREO)]);
      agregados++;
    }
  }
  await logAction(req.session.user.id, 'import_users', {agregados,actualizados,omitidos});
  res.json({agregados,actualizados,omitidos,total:rows.length});
});

app.get('/api/tickets', requireLogin, async (req,res)=>{
  const q=norm(req.query.q || ''); let params=[], where='';
  if(q){ params.push('%'+q+'%'); where=`where upper(coalesce(id::text,'')||' '||coalesce(activo,'')||' '||coalesce(activo_descripcion,'')||' '||coalesce(area,'')||' '||coalesce(estado,'')||' '||coalesce(falla,'')||' '||coalesce(solicitante,'')) like $1`; }
  const r=await pool.query(`select * from tickets ${where} order by creado desc limit 1000`, params);
  res.json(r.rows.map(decorateTicket));
});
app.post('/api/tickets', requireLogin, uploadImages.array('fotos_reporte', 6), async (req,res)=>{
  try{
    const t=req.body;

    if(!clean(t.falla)){
      return res.status(400).json({error:'Describe la falla.'});
    }

    const fotosReporte = (req.files || []).map(f => '/uploads/' + f.filename);

    const r = await pool.query(`
      INSERT INTO tickets(
        activo,
        activo_descripcion,
        area,
        sucursal,
        ubicacion,
        solicitante,
        empleado_solicitante,
        telefono_solicitante,
        falla,
        prioridad,
        tipo_falla,
        estado,
        created_by,
        fotos_reporte
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Reportado',$12,$13)
      RETURNING *
    `, [
      clean(t.activo),
      clean(t.activo_descripcion),
      clean(t.area),
      clean(t.sucursal),
      clean(t.ubicacion),
      clean(t.solicitante),
      clean(t.empleado_solicitante),
      clean(t.telefono_solicitante),
      clean(t.falla),
      clean(t.prioridad || 'Normal'),
      clean(t.tipo_falla),
      req.session.user.id,
      JSON.stringify(fotosReporte)
    ]);

    await logAction(req.session.user.id, 'create_ticket', {
      ticket:r.rows[0].id,
      activo:t.activo
    });

    if(typeof notifyTicketCreated === 'function'){
      await notifyTicketCreated(r.rows[0]);
    }

    res.json(r.rows[0]);
  }catch(err){
    console.error('Error creando ticket:', err);
    res.status(500).json({error:err.message});
  }
});
app.post('/api/tickets/:id/asignar', requireLogin, async (req,res)=>{ await pool.query("update tickets set estado='Asignado', tecnico_username=$1, asignado=now() where id=$2",[clean(req.body.tecnico_username),req.params.id]); await logAction(req.session.user.id,'assign_ticket',{id:req.params.id}); res.json({ok:true}); });
app.post('/api/tickets/:id/iniciar', requireLogin, async (req,res)=>{ await pool.query("update tickets set estado='En atención', iniciado=now() where id=$1",[req.params.id]); await logAction(req.session.user.id,'start_ticket',{id:req.params.id}); res.json({ok:true}); });
app.post('/api/tickets/:id/terminar', requireLogin, uploadImages.array('fotos_trabajo', 6), async (req,res)=>{
  const r=await pool.query('select * from tickets where id=$1',[req.params.id]);
  const t=r.rows[0];
  if(!t) return res.status(404).json({error:'Ticket no encontrado.'});
  const now = new Date();
  const iniciado = t.iniciado || now;
  const mttoMin = minutesBetween(iniciado, now);
  const produccionMin = Math.max(0, minutesBetween(t.creado, now) - mttoMin);
  await pool.query("update tickets set estado='Pendiente validación', terminado=now(), diagnostico=$1, solucion=$2, mtto_min=$3, produccion_min=$4 where id=$5",[clean(req.body.diagnostico),clean(req.body.solucion),mttoMin,produccionMin,req.params.id]);
  await logAction(req.session.user.id,'finish_ticket',{id:req.params.id, mttoMin, produccionMin});
  res.json({ok:true});
});
app.post('/api/tickets/:id/liberar', requireLogin, async (req,res)=>{
  const r=await pool.query('select * from tickets where id=$1',[req.params.id]);
  const t=r.rows[0];
  if(!t) return res.status(404).json({error:'Ticket no encontrado.'});
  const now = new Date();
  const tiempos = calcTicketTimes({...t, liberado: now, estado:'Liberado'}, now);
  await pool.query("update tickets set estado='Liberado', liberado=now(), mtto_min=$1, produccion_min=$2 where id=$3",[tiempos.mttoMin, tiempos.produccionMin, req.params.id]);
  await logAction(req.session.user.id,'release_ticket',{id:req.params.id, tiempos});
  res.json({ok:true, tiempos});
});
app.post('/api/tickets/:id/devolver', requireLogin, async (req,res)=>{ await pool.query("update tickets set estado='Devuelto' where id=$1",[req.params.id]); await logAction(req.session.user.id,'return_ticket',{id:req.params.id}); res.json({ok:true}); });

app.get('/api/reportes', requireLogin, async (req,res)=>{
  const [allTickets,est,area,tipo,act,emp] = await Promise.all([
    pool.query('select * from tickets'),
    pool.query('select estado,count(*)::int n from tickets group by estado order by n desc'),
    pool.query("select coalesce(area,'Sin área') area,count(*)::int n from tickets group by coalesce(area,'Sin área') order by n desc"),
    pool.query("select coalesce(tipo_falla,'Sin tipo') tipo,count(*)::int n from tickets group by coalesce(tipo_falla,'Sin tipo') order by n desc"),
    pool.query('select count(*)::int n from activos'),
    pool.query('select count(*)::int n from users')
  ]);
  let mttoMin=0, produccionMin=0, muertoTotalMin=0, esperaInicioMin=0, esperaValidacionMin=0;
  for(const t of allTickets.rows){
    const x = calcTicketTimes(t);
    mttoMin += x.mttoMin;
    produccionMin += x.produccionMin;
    muertoTotalMin += x.muertoTotalMin;
    esperaInicioMin += x.esperaInicioMin;
    esperaValidacionMin += x.esperaValidacionMin;
  }
  const abiertos = allTickets.rows.filter(t=>t.estado !== 'Liberado').length;
  const obj = rows => Object.fromEntries(rows.map(x=>[x.estado||x.area||x.tipo,x.n]));
  res.json({ totalTickets:allTickets.rows.length, abiertos, totalActivos:act.rows[0].n, totalEmpleados:emp.rows[0].n, mttoMin, produccionMin, muertoTotalMin, esperaInicioMin, esperaValidacionMin, porEstado:obj(est.rows), porArea:obj(area.rows), porTipoFalla:obj(tipo.rows) });
});
app.get('/api/export/excel', requireCanExport, async (req,res)=>{
  const [tickets, activos, users] = await Promise.all([pool.query('select * from tickets order by creado desc'),pool.query('select * from activos order by numero'),pool.query('select id,numero_empleado,name,username,role,status,area_asignada,sucursal,telefono,correo,created_at from users order by name')]);
  const wb=XLSX.utils.book_new();
  const ticketRows = tickets.rows.map(t => {
    const tiempos = calcTicketTimes(t);
    return {
      ...t,
      tiempo_muerto_total_min: tiempos.muertoTotalMin,
      tiempo_mtto_min: tiempos.mttoMin,
      tiempo_produccion_min: tiempos.produccionMin,
      espera_inicio_min: tiempos.esperaInicioMin,
      espera_validacion_min: tiempos.esperaValidacionMin
    };
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ticketRows), 'Tickets');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(activos.rows), 'Activos');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(users.rows), 'Usuarios');
  const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Disposition','attachment; filename="reporte-ibs.xlsx"');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.get('*', (req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));
initDb().then(()=> app.listen(PORT, ()=> console.log(`IBS v2 listo en puerto ${PORT}`))).catch(e=>{ console.error(e); process.exit(1); });
