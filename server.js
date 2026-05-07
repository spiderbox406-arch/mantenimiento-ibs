require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const multer = require('multer');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
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
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 2 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function clean(v){ return String(v ?? '').trim(); }
function norm(v){ return clean(v).toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
const DEMO_USERNAMES = ['demo','test','usuario','prueba','operador','operaciones_demo','demo_area','area_demo','user_demo'];
const MATRIZ_SUCURSAL = 'CHIHUAHUA';
function sameKey(a,b){ return norm(a) === norm(b); }
function isGlobalRole(role){ return ['admin','gerente','mantenimiento'].includes(String(role||'').toLowerCase()); }
function isGlobalUser(user){ return Boolean(user && isGlobalRole(user.role)); }
function isTecnicoRole(role){ return ['tecnico','mantenimiento','admin','gerente'].includes(String(role||'').toLowerCase()); }
function canManageTickets(user){ return Boolean(user && ['admin','gerente','mantenimiento'].includes(String(user.role||'').toLowerCase())); }
function canWorkTicket(user, ticket){
  if(!user || !ticket) return false;
  const role = String(user.role||'').toLowerCase();
  if(['admin','gerente','mantenimiento'].includes(role)) return true;
  if(role === 'tecnico') return String(ticket.tecnico_username||'').toLowerCase() === String(user.username||'').toLowerCase();
  return false;
}

function canReleaseTicket(user, ticket){
  if(!user || !ticket) return false;
  const role = String(user.role || '').toLowerCase();

  // Admin siempre puede liberar.
  if(role === 'admin') return true;

  // El técnico NO puede liberar equipo.
  if(role === 'tecnico') return false;

  // El usuario/área que reporta puede liberar.
  // Se valida por el created_by cuando existe.
  if(ticket.created_by && String(ticket.created_by) === String(user.id)) return true;

  // Respaldo para usuarios de área/operaciones:
  // misma sucursal y misma área del ticket.
  const userArea = norm(user.area_asignada || '');
  const ticketArea = norm(ticket.area || '');
  const userSucursal = norm(user.sucursal || '');
  const ticketSucursal = norm(ticket.sucursal || '');

  if(userArea && ticketArea && userArea === ticketArea){
    if(!ticketSucursal || !userSucursal || userSucursal === ticketSucursal) return true;
  }

  return false;
}


function addScopedClauses(user, params, clauses, alias=''){
  const p = alias ? alias + '.' : '';
  if(!user || isGlobalUser(user)) return;

  const role = String(user.role || '').toLowerCase();
  const sucursalUsuario = clean(user.sucursal);
  const areaUsuario = clean(user.area_asignada);

  // MEJORA AUTORIZADA:
  // Usuarios de área/operaciones ven SOLO activos/herramientas/tickets de su misma sucursal + área.
  // La comparación es indiferente a mayúsculas, minúsculas, acentos y espacios porque usa norm().
  // Ejemplo: BANDA NEGRA / TIJUANA solo ve BANDA NEGRA / TIJUANA.
  if(['operaciones','usuario_area','usuario'].includes(role)){
    if(sucursalUsuario){
      params.push(norm(sucursalUsuario));
      clauses.push(`upper(coalesce(${p}sucursal,'')) = $${params.length}`);
    }
    if(areaUsuario){
      params.push(norm(areaUsuario));
      clauses.push(`upper(coalesce(${p}area,'')) = $${params.length}`);
    }
    return;
  }

  // Técnicos u otros roles no globales conservan visibilidad por sucursal.
  // No se filtra por área porque mantenimiento atiende varias áreas dentro de su sucursal.
  if(sucursalUsuario){
    params.push(norm(sucursalUsuario));
    clauses.push(`upper(coalesce(${p}sucursal,'')) = $${params.length}`);
  }
}

function addTicketVisibilityClauses(user, params, clauses, alias=''){
  const p = alias ? alias + '.' : '';
  const role = String(user?.role || '').toLowerCase();

  // El técnico debe ver SOLO los tickets asignados a su usuario,
  // sin depender de que coincidan sucursal o área.
  if(role === 'tecnico'){
    params.push(String(user.username || '').toLowerCase());
    clauses.push(`lower(coalesce(${p}tecnico_username,'')) = $${params.length}`);
    return;
  }

  // Gerente / mantenimiento / admin conservan la vista global permitida.
  addScopedClauses(user, params, clauses, alias);
}

function buildWhere(clauses){ return clauses.length ? ' where ' + clauses.join(' and ') : ''; }
async function getUserByUsername(username){
  const r = await pool.query('select id, name, username, role, status, can_export, sucursal, area_asignada, telefono, correo from users where lower(username)=lower($1) limit 1', [clean(username)]);
  return r.rows[0] || null;
}
function requireLogin(req,res,next){ if(!req.session.user) return res.status(401).json({error:'Sesión vencida. Inicia sesión otra vez.'}); next(); }
function requireAdmin(req,res,next){ if(!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({error:'Solo administrador.'}); next(); }
function canExportExcel(req){
  return Boolean(req.session.user && (['admin','gerente'].includes(String(req.session.user.role||'').toLowerCase()) || req.session.user.can_export === true));
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
function secondsBetween(a, b){
  if(!a || !b) return 0;
  const start = new Date(a).getTime();
  const end = new Date(b).getTime();
  if(!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.max(0, Math.round((end - start) / 1000));
}
function calcTicketTimes(t, nowDate = new Date()){
  // Flujo autorizado:
  // MTTO inicia desde que se crea el ticket y sigue hasta que el técnico libera/entrega.
  // Operaciones inicia cuando el técnico libera/entrega y termina cuando Operaciones libera o devuelve.
  // Si Operaciones devuelve, ese tramo queda en Operaciones y MTTO vuelve a sumar desde la devolución.
  const now = nowDate instanceof Date ? nowDate : new Date(nowDate);

  let mttoSeg = Number(t.mtto_seg || 0);
  let prodSeg = Number(t.produccion_seg || 0);

  const estado = String(t.estado || '');
  const mttoAbierto = t.mtto_inicio_actual || ((!t.mtto_seg && ['Reportado','Asignado','En atención','Devuelto'].includes(estado)) ? t.creado : null);
  const opAbierto = t.operacion_inicio_actual || ((!t.produccion_seg && estado === 'Pendiente validación') ? t.terminado : null);

  if(['Reportado','Asignado','En atención','Devuelto'].includes(estado) && mttoAbierto){
    mttoSeg += secondsBetween(mttoAbierto, now);
  }

  if(estado === 'Pendiente validación' && opAbierto){
    prodSeg += secondsBetween(opAbierto, now);
  }

  let muertoTotalSeg = Number(t.total_muerto_seg || 0) || (mttoSeg + prodSeg);

  // Respaldo para tickets viejos guardados antes de esta lógica de tramos.
  if(!muertoTotalSeg && t.creado && t.liberado){
    muertoTotalSeg = secondsBetween(t.creado, t.liberado);
  }
  if(!mttoSeg && t.iniciado && t.terminado){
    mttoSeg = secondsBetween(t.iniciado, t.terminado);
  }
  if(!prodSeg && muertoTotalSeg && mttoSeg){
    prodSeg = Math.max(0, muertoTotalSeg - mttoSeg);
  }

  const mttoMin = Math.floor(mttoSeg / 60);
  const produccionMin = Math.floor(prodSeg / 60);
  const muertoTotalMin = Math.floor(muertoTotalSeg / 60);

  return {
    mttoMin,
    produccionMin,
    muertoTotalMin,
    esperaInicioMin: mttoMin,
    esperaValidacionMin: produccionMin,
    mttoSeg,
    produccionSeg: prodSeg,
    muertoTotalSeg
  };
}
function decorateTicket(t){
  const tiempos = calcTicketTimes(t);
  return {...t, responsableActual:t.tecnico_username || '', tiempos};
}

async function registrarTramoTiempo(clientOrPool, ticketId, tipo, inicio, fin, segundos, origen, usuarioId, nota = ''){
  if(!ticketId || !tipo || !inicio || !fin || !Number.isFinite(Number(segundos)) || Number(segundos) < 0) return;
  try{
    await clientOrPool.query(`
      insert into ticket_time_events(ticket_id, tipo, inicio, fin, segundos, minutos, origen, usuario_id, nota)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `,[String(ticketId), tipo, inicio, fin, Math.floor(Number(segundos)), Math.floor(Number(segundos)/60), origen || '', usuarioId || null, nota || '']);
  }catch(e){
    console.error('registrarTramoTiempo', e.message);
  }
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
    create table if not exists empleados_reportantes(
      id bigserial primary key,
      numero_empleado text,
      nombre text not null,
      sucursal text,
      area text,
      puesto text,
      correo text,
      telefono text,
      status text not null default 'activo',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists ticket_time_events(
      id bigserial primary key,
      ticket_id text not null,
      tipo text not null,
      inicio timestamptz not null,
      fin timestamptz not null,
      segundos int not null default 0,
      minutos int not null default 0,
      origen text,
      usuario_id bigint references users(id),
      nota text,
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
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS mtto_seg int DEFAULT 0;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS produccion_seg int DEFAULT 0;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS total_muerto_seg int DEFAULT 0;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS total_muerto_min int DEFAULT 0;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS mtto_inicio_actual timestamptz;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS operacion_inicio_actual timestamptz;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS fotos_reporte jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS fotos_trabajo jsonb NOT NULL DEFAULT '[]'::jsonb;

    ALTER TABLE empleados_reportantes ADD COLUMN IF NOT EXISTS numero_empleado text;
    ALTER TABLE empleados_reportantes ADD COLUMN IF NOT EXISTS nombre text;
    ALTER TABLE empleados_reportantes ADD COLUMN IF NOT EXISTS sucursal text;
    ALTER TABLE empleados_reportantes ADD COLUMN IF NOT EXISTS area text;
    ALTER TABLE empleados_reportantes ADD COLUMN IF NOT EXISTS puesto text;
    ALTER TABLE empleados_reportantes ADD COLUMN IF NOT EXISTS correo text;
    ALTER TABLE empleados_reportantes ADD COLUMN IF NOT EXISTS telefono text;
    ALTER TABLE empleados_reportantes ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'activo';
  `);

  await pool.query(`
    UPDATE tickets
    SET estado = 'Reportado'
    WHERE estado IS NULL OR trim(estado) = '';
  `);

  // Migración segura de tiempos para tickets existentes.
  // No borra datos: solo abre el tramo correcto cuando todavía no hay acumulados.
  await pool.query(`
    UPDATE tickets
    SET mtto_inicio_actual = creado
    WHERE mtto_inicio_actual IS NULL
      AND estado IN ('Reportado','Asignado','En atención','Devuelto')
      AND liberado IS NULL;

    UPDATE tickets
    SET operacion_inicio_actual = terminado
    WHERE operacion_inicio_actual IS NULL
      AND estado = 'Pendiente validación'
      AND terminado IS NOT NULL
      AND liberado IS NULL;

    UPDATE tickets
    SET total_muerto_seg = coalesce(mtto_seg,0) + coalesce(produccion_seg,0),
        total_muerto_min = floor((coalesce(mtto_seg,0) + coalesce(produccion_seg,0)) / 60.0)::int
    WHERE estado = 'Liberado'
      AND coalesce(total_muerto_seg,0) = 0;
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
  const user = req.session.user;
  const assetParams=[]; const assetClauses=[];
  addScopedClauses(user, assetParams, assetClauses);
  const assetsWhere = buildWhere(assetClauses);

  const [a,t,g,er] = await Promise.all([
    pool.query(`select * from activos ${assetsWhere} order by sucursal, area, numero limit 5000`, assetParams),
    pool.query("select id, name, username, role, can_export, sucursal, area_asignada, telefono, correo from users where status='activo' and role in ('tecnico','mantenimiento','admin') order by sucursal, name"),
    pool.query("select id, name, username, role, can_export, sucursal, area_asignada, telefono, correo from users where status='activo' and role in ('gerente','mantenimiento','admin') order by case when role='gerente' then 0 when role='mantenimiento' then 1 else 2 end, sucursal, name"),
    pool.query("select id, numero_empleado, nombre, sucursal, area, puesto, telefono, correo, status from empleados_reportantes where status='activo' order by sucursal, area, nombre limit 5000")
  ]);

  let empleados = [];
  if(user.role === 'admin'){
    const e = await pool.query('select id, numero_empleado, name, username, role, status, must_change_password, can_export, area_asignada, sucursal, telefono, correo, created_at, updated_at from users order by sucursal, area_asignada, name limit 2000');
    empleados = e.rows;
  }

  res.json({activos:a.rows, empleados, empleados_reportantes:er.rows, tecnicos:t.rows, gerentes:g.rows});
});

app.get('/api/activos', requireLogin, async (req,res)=>{
  const q = norm(req.query.q || '');
  const params = [];
  const clauses = [];
  addScopedClauses(req.session.user, params, clauses);
  if(q){ params.push('%' + q + '%'); clauses.push(`search_text like $${params.length}`); }
  const where = buildWhere(clauses);
  const r = await pool.query(`select * from activos ${where} order by sucursal, area, numero limit 1000`, params);
  res.json(r.rows);
});
app.post('/api/activos', requireAdmin, async (req,res)=>{
  const a = req.body;
  if(!clean(a.numero) || !clean(a.descripcion)) return res.status(400).json({error:'Número y descripción son obligatorios.'});
  const search = norm([a.numero,a.descripcion,a.area,a.tipo,a.sucursal,a.ubicacion,a.marca,a.modelo,a.usuario,a.estatus].join(' '));
  const r = await pool.query(`insert into activos(numero,descripcion,area,tipo,sucursal,ubicacion,marca,modelo,usuario,estatus,search_text)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    on conflict(numero) do update set descripcion=excluded.descripcion, area=excluded.area, tipo=excluded.tipo, sucursal=excluded.sucursal, ubicacion=excluded.ubicacion, marca=excluded.marca, modelo=excluded.modelo, usuario=excluded.usuario, estatus=excluded.estatus, search_text=excluded.search_text, updated_at=now()
    returning *`, [clean(a.numero),clean(a.descripcion),clean(a.area),clean(a.tipo),clean(a.sucursal || 'SIN SUCURSAL'),clean(a.ubicacion),clean(a.marca),clean(a.modelo),clean(a.usuario),clean(a.estatus||'VIGENTE'),search]);
  await logAction(req.session.user.id, 'upsert_asset', {numero:a.numero});
  res.json(r.rows[0]);
});

app.post('/api/import/activos', requireAdmin, upload.single('archivo'), async (req,res)=>{
  if(!req.file) return res.status(400).json({error:'Sube un archivo Excel.'});

  const wb = XLSX.read(req.file.buffer, { type:'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval:'' });

  let agregados=0, actualizados=0, omitidos=0;

  function pick(row, names){
    for(const n of names){
      if(row[n] !== undefined && clean(row[n]) !== '') return clean(row[n]);
    }
    return '';
  }

  for(const row of rows){
    // Formato recibido: ACTIVOS MATRIZ - SUCURSALES.xlsx
    // Solo se toman los campos que ocupa el sistema. Todo lo demás se ignora:
    // FECHA CREACION, PRESTAMO, TIENE FOTO, COSTO, MONEDA, PROVEEDOR, FACTURA, etc.
    const a = {
      numero: pick(row, ['NUM ACTIVO','NUMERO ACTIVO','NÚM ACTIVO','numero','NUMERO','No ACTIVO','NO ACTIVO']),
      descripcion: pick(row, ['DESCRIPCION','DESCRIPCIÓN','descripcion','DESCRIPCION ACTIVO','DESCRIPCIÓN ACTIVO']),
      area: pick(row, ['AREA','ÁREA','area']),
      tipo: pick(row, ['TIPO','tipo']),
      sucursal: pick(row, ['SUCURSAL','sucursal']),
      ubicacion: pick(row, ['UBICACION','UBICACIÓN','ubicacion','LOCALIZACION','LOCALIZACIÓN']),
      marca: pick(row, ['MARCA','marca']),
      modelo: pick(row, ['MODELO','modelo']),
      usuario: pick(row, ['USUARIO','usuario','RESPONSABLE','RESGUARDO']),
      estatus: pick(row, ['ESTATUS','ESTADO','estatus','estado'])
    };

    if(!a.numero || !a.descripcion){
      omitidos++;
      continue;
    }

    const search = norm([
      a.numero,
      a.descripcion,
      a.area,
      a.tipo,
      a.sucursal,
      a.ubicacion,
      a.marca,
      a.modelo,
      a.usuario,
      a.estatus
    ].join(' '));

    const exists = await pool.query('select id from activos where numero=$1', [a.numero]);

    await pool.query(`
      insert into activos(
        numero,descripcion,area,tipo,sucursal,ubicacion,marca,modelo,usuario,estatus,search_text
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      on conflict(numero) do update set
        descripcion=excluded.descripcion,
        area=excluded.area,
        tipo=excluded.tipo,
        sucursal=excluded.sucursal,
        ubicacion=excluded.ubicacion,
        marca=excluded.marca,
        modelo=excluded.modelo,
        usuario=excluded.usuario,
        estatus=excluded.estatus,
        search_text=excluded.search_text,
        updated_at=now()
    `,[
      a.numero,
      a.descripcion,
      a.area,
      a.tipo,
      a.sucursal || 'SIN SUCURSAL',
      a.ubicacion,
      a.marca,
      a.modelo,
      a.usuario,
      a.estatus || 'VIGENTE',
      search
    ]);

    exists.rows.length ? actualizados++ : agregados++;
  }

  await logAction(req.session.user.id, 'import_assets', {
    agregados,
    actualizados,
    omitidos,
    columnas_usadas:['NUM ACTIVO','TIPO','ESTATUS','DESCRIPCION','MARCA','MODELO','SUCURSAL','AREA','UBICACION','USUARIO']
  });

  res.json({
    agregados,
    actualizados,
    omitidos,
    total:rows.length,
    campos_usados:['NUM ACTIVO','TIPO','ESTATUS','DESCRIPCION','MARCA','MODELO','SUCURSAL','AREA','UBICACION','USUARIO']
  });
});


app.post('/api/admin/limpiar-inicio', requireAdmin, async (req,res)=>{
  try{
    const ticketsBorrados = await pool.query('delete from tickets returning id');

    const usuariosBorrados = await pool.query(
      "delete from users where lower(username) <> 'admin' returning id, username"
    );

    await logAction(req.session.user.id, 'clean_start', {
      tickets:ticketsBorrados.rowCount,
      usuarios:usuariosBorrados.rowCount
    });

    res.json({
      ok:true,
      tickets_borrados:ticketsBorrados.rowCount,
      usuarios_borrados:usuariosBorrados.rowCount
    });
  }catch(err){
    console.error('Error limpiando inicio:', err);
    res.status(500).json({error:err.message});
  }
});

app.get('/api/users', requireAdmin, async (req,res)=>{
  const q = norm(req.query.q || '');
  const params=[DEMO_USERNAMES];
  let where = "where not (lower(username)=any($1::text[]) or lower(coalesce(name,'')) like '%demo%')";
  if(q){ params.push('%'+q+'%'); where += ` and upper(coalesce(numero_empleado,'')||' '||coalesce(name,'')||' '||coalesce(username,'')||' '||coalesce(role,'')||' '||coalesce(area_asignada,'')||' '||coalesce(sucursal,'')||' '||coalesce(status,'')) like $2`; }
  const r = await pool.query(`select id, numero_empleado, name, username, role, status, must_change_password, can_export, area_asignada, sucursal, telefono, correo, created_at, updated_at from users ${where} order by name`, params);
  res.json(r.rows);
});
app.post('/api/users', requireAdmin, async (req,res)=>{
  try{
    const u=req.body;

    // La contraseña NO se normaliza ni se cambia a mayúsculas/minúsculas.
    // Se guarda exactamente como la escriba el administrador.
    const pass=String(u.password || 'Temp1234');
    const username = clean(u.username);
    const role = clean(u.role || 'operaciones').toLowerCase();
    const esUsuarioArea = ['operaciones','usuario_area','usuario'].includes(role);

    if(!username) return res.status(400).json({error:'Usuario es obligatorio.'});
    if(pass.length < 6) return res.status(400).json({error:'La contraseña debe tener mínimo 6 caracteres.'});

    // Para usuarios de área, el nombre puede ser el mismo usuario.
    // Esto evita capturar datos repetidos cuando se crea Banda Negra, Corte, Grapado, etc.
    const name = esUsuarioArea ? (clean(u.name) || username) : (clean(u.name) || username);

    if(esUsuarioArea && !clean(u.sucursal)) return res.status(400).json({error:'Sucursal es obligatoria para usuario de área.'});
    if(esUsuarioArea && !clean(u.area_asignada)) return res.status(400).json({error:'Área es obligatoria para usuario de área.'});

    const canExport = Boolean(u.can_export) || role === 'gerente' || role === 'admin';
    const hash=await bcrypt.hash(pass,12);

    const r=await pool.query(`
      insert into users(
        numero_empleado,name,username,password_hash,role,status,must_change_password,
        area_asignada,sucursal,telefono,correo,can_export
      ) values($1,$2,lower($3),$4,$5,'activo',true,$6,$7,$8,$9,$10)
      returning id, numero_empleado, name, username, role, status, must_change_password, can_export, area_asignada, sucursal, telefono, correo
    `,[
      esUsuarioArea ? '' : clean(u.numero_empleado),
      name,
      username,
      hash,
      role,
      clean(u.area_asignada),
      clean(u.sucursal),
      esUsuarioArea ? '' : clean(u.telefono),
      esUsuarioArea ? '' : clean(u.correo),
      canExport
    ]);

    await logAction(req.session.user.id, 'create_user', {username:u.username, role, sucursal:u.sucursal, area_asignada:u.area_asignada});
    res.json(r.rows[0]);
  }catch(err){
    console.error('Error creando usuario:', err);
    if(err.code === '23505') return res.status(400).json({error:'Ese usuario ya existe. Usa otro nombre de usuario.'});
    res.status(500).json({error:err.message});
  }
});
app.post('/api/users/cleanup-demos', requireAdmin, async (req,res)=>{
  const r = await pool.query(
    "delete from users where lower(username)=any($1::text[]) and lower(username) <> 'admin' returning id, username",
    [DEMO_USERNAMES]
  );
  await logAction(req.session.user.id, 'cleanup_demo_users', {deleted:r.rowCount, users:r.rows.map(x=>x.username)});
  res.json({ok:true, deleted:r.rowCount, users:r.rows});
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
  const client = await pool.connect();
  try{
    const id = req.params.id;

    if(String(id) === String(req.session.user.id)){
      return res.status(400).json({error:'No puedes eliminar tu propio usuario admin mientras estás conectado.'});
    }

    await client.query('BEGIN');

    const userResult = await client.query('select id, username from users where id=$1 limit 1', [id]);
    const userToDelete = userResult.rows[0];

    if(!userToDelete){
      await client.query('ROLLBACK');
      return res.status(404).json({error:'Usuario no encontrado.'});
    }

    // Limpiar relaciones para que PostgreSQL permita borrar el usuario.
    // Conserva los tickets, pero les quita la referencia al usuario eliminado.
    await client.query('update tickets set tecnico_username=null where lower(coalesce(tecnico_username, \'\'))=lower($1)', [userToDelete.username]);
    await client.query('update tickets set created_by=null where created_by=$1', [id]);

    // Limpiar logs relacionados si existe relación FK.
    await client.query('update user_activity_log set user_id=null where user_id=$1', [id]);

    const deleted = await client.query('delete from users where id=$1 returning id, username', [id]);

    await client.query('COMMIT');

    await logAction(req.session.user.id, 'delete_user', {
      deleted_id:id,
      deleted_username:userToDelete.username
    });

    res.json({ok:true, deleted:deleted.rows[0]});
  }catch(err){
    try{ await client.query('ROLLBACK'); }catch(e){}
    console.error('Error eliminando usuario:', err);
    res.status(500).json({error:err.message});
  }finally{
    client.release();
  }
});
app.get('/api/empleados-reportantes', requireLogin, async (req,res)=>{
  try{
    const q = norm(req.query.q || '');
    const params = [];
    const clauses = ["status='activo'"];

    if(q){
      params.push('%' + q + '%');
      clauses.push(`upper(coalesce(numero_empleado,'')||' '||coalesce(nombre,'')||' '||coalesce(sucursal,'')||' '||coalesce(area,'')||' '||coalesce(puesto,'')||' '||coalesce(correo,'')||' '||coalesce(telefono,'')) like $${params.length}`);
    }

    const where = buildWhere(clauses);
    const r = await pool.query(`
      select id, numero_empleado, nombre, sucursal, area, puesto, telefono, correo, status
      from empleados_reportantes
      ${where}
      order by sucursal, area, nombre
      limit 1000
    `, params);

    res.json(r.rows);
  }catch(err){
    console.error('Error consultando empleados reportantes:', err);
    res.status(500).json({error:err.message});
  }
});

app.post('/api/import/empleados', requireAdmin, upload.single('archivo'), async (req,res)=>{
  if(!req.file) return res.status(400).json({error:'Sube un archivo Excel.'});

  const wb = XLSX.read(req.file.buffer,{type:'buffer'});
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws,{defval:''});

  let agregados=0, actualizados=0, omitidos=0;

  function keyName(k){
    return String(k || '')
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g,'')
      .replace(/[^A-Z0-9]/g,'');
  }

  function pick(row, names){
    const map = {};
    Object.keys(row).forEach(k => { map[keyName(k)] = row[k]; });
    for(const n of names){
      const v = map[keyName(n)];
      if(v !== undefined && clean(v) !== '') return clean(v);
    }
    return '';
  }

  for(const row of rows){
    const numero = pick(row, [
      'numeroEmpleado','NUMERO_EMPLEADO','NUM EMPLEADO','NO EMPLEADO',
      'NUMERO','NÚMERO','#','EMPLOYEE ID','CODIGO','ID'
    ]);

    const nombre = pick(row, [
      'nombre','NOMBRE','NOMBRE EMPLEADO','EMPLEADO','COLABORADOR','TRABAJADOR','name','NAME'
    ]);

    if(!nombre){
      omitidos++;
      continue;
    }

    const sucursal = pick(row, ['sucursal','SUCURSAL','PLANTA']) || 'CHIHUAHUA';
    const area = pick(row, ['areaAsignada','AREA ASIGNADA','AREA','DEPARTAMENTO','DEPTO','departamento']);
    const puesto = pick(row, ['puesto','PUESTO','rol','ROL','CARGO']);
    const correo = pick(row, ['correo','CORREO','EMAIL','E-MAIL','MAIL','email']);
    const telefono = pick(row, ['telefono','TELEFONO','TELÉFONO','CELULAR','CEL','WHATSAPP']);

    let exists;
    if(numero){
      exists = await pool.query(
        "select id from empleados_reportantes where coalesce(numero_empleado,'')=$1 limit 1",
        [numero]
      );
    }else{
      exists = await pool.query(
        "select id from empleados_reportantes where upper(nombre)=upper($1) and upper(coalesce(sucursal,''))=upper($2) limit 1",
        [nombre, sucursal]
      );
    }

    if(exists.rows.length){
      await pool.query(`
        update empleados_reportantes
        set
          numero_empleado=$1,
          nombre=$2,
          sucursal=$3,
          area=$4,
          puesto=$5,
          correo=$6,
          telefono=$7,
          status='activo',
          updated_at=now()
        where id=$8
      `,[
        numero,
        nombre,
        sucursal,
        area,
        puesto,
        correo,
        telefono,
        exists.rows[0].id
      ]);
      actualizados++;
    }else{
      await pool.query(`
        insert into empleados_reportantes(
          numero_empleado,
          nombre,
          sucursal,
          area,
          puesto,
          correo,
          telefono,
          status
        )
        values($1,$2,$3,$4,$5,$6,$7,'activo')
      `,[
        numero,
        nombre,
        sucursal,
        area,
        puesto,
        correo,
        telefono
      ]);
      agregados++;
    }
  }

  await logAction(req.session.user.id, 'import_empleados_reportantes', {
    agregados,
    actualizados,
    omitidos,
    total: rows.length
  });

  res.json({
    agregados,
    actualizados,
    omitidos,
    total: rows.length,
    tipo:'empleados_reportantes'
  });
});

app.get('/api/tickets', requireLogin, async (req,res)=>{
  const q=norm(req.query.q || '');
  const params=[]; const clauses=[];
  addTicketVisibilityClauses(req.session.user, params, clauses);
  if(q){
    params.push('%'+q+'%');
    clauses.push(`upper(coalesce(id::text,'')||' '||coalesce(activo,'')||' '||coalesce(activo_descripcion,'')||' '||coalesce(area,'')||' '||coalesce(sucursal,'')||' '||coalesce(estado,'')||' '||coalesce(falla,'')||' '||coalesce(solicitante,'')) like $${params.length}`);
  }
  const where = buildWhere(clauses);
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
    const ticketSucursal = isGlobalUser(req.session.user) ? clean(t.sucursal || 'SIN SUCURSAL') : clean(req.session.user.sucursal || t.sucursal || 'SIN SUCURSAL');
    const ticketArea = isGlobalUser(req.session.user) ? clean(t.area || req.session.user.area_asignada || '') : clean(req.session.user.area_asignada || t.area || '');

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
        fotos_reporte,
        mtto_inicio_actual
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Reportado',$12,$13,now())
      RETURNING *
    `, [
      clean(t.activo),
      clean(t.activo_descripcion),
      ticketArea,
      ticketSucursal,
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

    res.json(r.rows[0]);
  }catch(err){
    console.error('Error creando ticket:', err);
    res.status(500).json({error:err.message});
  }
});
app.post('/api/tickets/:id/asignar', requireLogin, async (req,res)=>{
  try{
    if(!canManageTickets(req.session.user)) return res.status(403).json({error:'Solo gerente, mantenimiento o admin puede asignar tickets.'});
    const tecnico = await getUserByUsername(req.body.tecnico_username);
    if(!tecnico || tecnico.status !== 'activo' || !isTecnicoRole(tecnico.role)) return res.status(400).json({error:'Técnico no válido o inactivo.'});

    const qTicket = await pool.query('select * from tickets where id=$1', [req.params.id]);
    const ticket = qTicket.rows[0];
    if(!ticket) return res.status(404).json({error:'Ticket no encontrado.'});

    const ticketSuc = norm(ticket.sucursal);
    const tecnicoSuc = norm(tecnico.sucursal);
    if(ticketSuc && tecnicoSuc && ticketSuc !== tecnicoSuc && tecnicoSuc !== norm(MATRIZ_SUCURSAL)){
      return res.status(400).json({error:'Ese técnico no pertenece a la sucursal del ticket ni a matriz Chihuahua.'});
    }

    const r = await pool.query(
      "update tickets set estado='Asignado', tecnico_username=$1, asignado=coalesce(asignado,now()) where id=$2 returning *",
      [clean(req.body.tecnico_username),req.params.id]
    );
    await logAction(req.session.user.id,'assign_ticket',{id:req.params.id, tecnico:req.body.tecnico_username});
    res.json({ok:true, ticket:decorateTicket(r.rows[0])});
  }catch(err){
    console.error('Error asignando ticket:', err);
    res.status(500).json({error:err.message});
  }
});
app.post('/api/tickets/:id/iniciar', requireLogin, async (req,res)=>{
  try{
    const q = await pool.query('select * from tickets where id=$1',[req.params.id]);
    const t = q.rows[0];
    if(!t) return res.status(404).json({error:'Ticket no encontrado.'});
    if(!canWorkTicket(req.session.user, t)) return res.status(403).json({error:'Solo el técnico asignado, gerente, mantenimiento o admin puede aceptar este trabajo.'});

    const r = await pool.query(
      "update tickets set estado='En atención', iniciado=coalesce(iniciado,now()), mtto_inicio_actual=coalesce(mtto_inicio_actual, creado, now()) where id=$1 returning *",
      [req.params.id]
    );
    await logAction(req.session.user.id,'start_ticket',{id:req.params.id});
    res.json({ok:true, ticket:decorateTicket(r.rows[0])});
  }catch(err){
    console.error('Error iniciando ticket:', err);
    res.status(500).json({error:err.message});
  }
});
app.post('/api/tickets/:id/terminar', requireLogin, uploadImages.array('fotos_trabajo', 6), async (req,res)=>{
  try{
    const q = await pool.query('select * from tickets where id=$1',[req.params.id]);
    const t = q.rows[0];

    if(!t) return res.status(404).json({error:'Ticket no encontrado.'});
    if(!canWorkTicket(req.session.user, t)) return res.status(403).json({error:'Solo el técnico asignado, gerente, mantenimiento o admin puede finalizar este trabajo.'});
    if(!t.iniciado) return res.status(400).json({error:'Primero debes iniciar la atención del ticket.'});

    const fotosTrabajo = (req.files || []).map(f => '/uploads/' + f.filename);
    const terminado = new Date();

    const inicioTramoMtto = t.mtto_inicio_actual || t.creado || t.iniciado;
    const tramoMttoSeg = secondsBetween(inicioTramoMtto, terminado);
    const mttoSeg = Number(t.mtto_seg || 0) + tramoMttoSeg;
    const mttoMin = Math.floor(mttoSeg / 60);
    const prodSegActual = Number(t.produccion_seg || 0);
    const totalSeg = mttoSeg + prodSegActual;

    const up = await pool.query(`
      UPDATE tickets
      SET
        estado='Pendiente validación',
        terminado=$1,
        diagnostico=$2,
        solucion=$3,
        mtto_seg=$4,
        mtto_min=$5,
        produccion_seg=$6,
        produccion_min=$7,
        total_muerto_seg=$8,
        total_muerto_min=$9,
        mtto_inicio_actual=null,
        operacion_inicio_actual=$1,
        fotos_trabajo=coalesce(fotos_trabajo,'[]'::jsonb) || $10::jsonb
      WHERE id=$11
      RETURNING *
    `, [
      terminado,
      clean(req.body.diagnostico),
      clean(req.body.solucion),
      mttoSeg,
      mttoMin,
      prodSegActual,
      Math.floor(prodSegActual / 60),
      totalSeg,
      Math.floor(totalSeg / 60),
      JSON.stringify(fotosTrabajo),
      req.params.id
    ]);

    await registrarTramoTiempo(pool, req.params.id, 'MTTO', inicioTramoMtto, terminado, tramoMttoSeg, 'tecnico_libera', req.session.user.id, 'Tramo de mantenimiento cerrado por técnico');
    await logAction(req.session.user.id,'finish_ticket',{id:req.params.id, tramoMttoSeg, mttoSeg, mttoMin});
    if(up.rows[0] && typeof notifyTicketFinished === 'function') await notifyTicketFinished(up.rows[0]);

    res.json({ok:true, ticket:up.rows[0]});
  }catch(err){
    console.error('Error terminando ticket:', err);
    res.status(500).json({error:err.message});
  }
});
app.post('/api/tickets/:id/liberar', requireLogin, async (req,res)=>{
  try{
    const q = await pool.query('select * from tickets where id=$1',[req.params.id]);
    const t = q.rows[0];

    if(!t) return res.status(404).json({error:'Ticket no encontrado.'});
    if(!t.terminado) return res.status(400).json({error:'Primero mantenimiento debe terminar la reparación.'});
    if(!canReleaseTicket(req.session.user, t)){
      return res.status(403).json({error:'Solo el usuario/área que reportó o el administrador puede liberar este equipo.'});
    }

    const liberado = new Date();

    const mttoSeg = Number(t.mtto_seg || 0);
    const inicioTramoOp = t.operacion_inicio_actual || t.terminado;
    const tramoOpSeg = secondsBetween(inicioTramoOp, liberado);
    const prodSeg = Number(t.produccion_seg || 0) + tramoOpSeg;
    const totalSeg = mttoSeg + prodSeg;

    const mttoMin = Math.floor(mttoSeg / 60);
    const prodMin = Math.floor(prodSeg / 60);
    const totalMin = Math.floor(totalSeg / 60);

    const up = await pool.query(`
      UPDATE tickets
      SET
        estado='Liberado',
        liberado=$1,
        mtto_seg=$2,
        mtto_min=$3,
        produccion_seg=$4,
        produccion_min=$5,
        total_muerto_seg=$6,
        total_muerto_min=$7,
        mtto_inicio_actual=null,
        operacion_inicio_actual=null
      WHERE id=$8
      RETURNING *
    `, [
      liberado,
      mttoSeg,
      mttoMin,
      prodSeg,
      prodMin,
      totalSeg,
      totalMin,
      req.params.id
    ]);

    await registrarTramoTiempo(pool, req.params.id, 'OPERACIONES', inicioTramoOp, liberado, tramoOpSeg, 'operacion_libera', req.session.user.id, 'Operaciones libera definitivamente');
    await logAction(req.session.user.id,'release_ticket',{id:req.params.id, mttoSeg, tramoOpSeg, prodSeg, totalSeg});
    if(up.rows[0] && typeof notifyTicketReleased === 'function') await notifyTicketReleased(up.rows[0]);

    res.json({ok:true, ticket:decorateTicket(up.rows[0])});
  }catch(err){
    console.error('Error liberando ticket:', err);
    res.status(500).json({error:err.message});
  }
});
app.post('/api/tickets/:id/devolver', requireLogin, async (req,res)=>{
  try{
    const q = await pool.query('select * from tickets where id=$1',[req.params.id]);
    const t = q.rows[0];

    if(!t) return res.status(404).json({error:'Ticket no encontrado.'});
    if(!canReleaseTicket(req.session.user, t)){
      return res.status(403).json({error:'Solo el usuario/área que reportó o el administrador puede devolver este equipo.'});
    }

    const devuelto = new Date();
    const inicioTramoOp = t.operacion_inicio_actual || t.terminado;
    const tramoOpSeg = secondsBetween(inicioTramoOp, devuelto);
    const prodSeg = Number(t.produccion_seg || 0) + tramoOpSeg;
    const mttoSeg = Number(t.mtto_seg || 0);
    const totalSeg = mttoSeg + prodSeg;

    await pool.query(`
      update tickets
      set
        estado='Devuelto',
        produccion_seg=$1,
        produccion_min=$2,
        total_muerto_seg=$3,
        total_muerto_min=$4,
        mtto_inicio_actual=$5,
        operacion_inicio_actual=null
      where id=$6
    `,[prodSeg, Math.floor(prodSeg/60), totalSeg, Math.floor(totalSeg/60), devuelto, req.params.id]);

    await registrarTramoTiempo(pool, req.params.id, 'OPERACIONES', inicioTramoOp, devuelto, tramoOpSeg, 'operacion_devuelve', req.session.user.id, 'Operaciones devuelve el equipo a mantenimiento');
    await logAction(req.session.user.id,'return_ticket',{id:req.params.id, tramoOpSeg, prodSeg});
    res.json({ok:true});
  }catch(err){
    console.error('Error devolviendo ticket:', err);
    res.status(500).json({error:err.message});
  }
});

app.get('/api/reportes', requireLogin, async (req,res)=>{
  const params=[]; const clauses=[];
  addTicketVisibilityClauses(req.session.user, params, clauses);
  const where = buildWhere(clauses);
  const assetParams=[]; const assetClauses=[];
  addScopedClauses(req.session.user, assetParams, assetClauses);
  const assetWhere = buildWhere(assetClauses);

  const [allTickets,act,emp] = await Promise.all([
    pool.query(`select * from tickets ${where}`, params),
    pool.query(isGlobalUser(req.session.user) ? 'select count(*)::int n from activos' : `select count(*)::int n from activos ${assetWhere}`, assetParams),
    pool.query('select count(*)::int n from users')
  ]);
  let mttoMin=0, produccionMin=0, muertoTotalMin=0, esperaInicioMin=0, esperaValidacionMin=0;
  const porEstado={}, porArea={}, porTipoFalla={}, porSucursal={}, porActivo={}, porTecnico={};
  for(const t of allTickets.rows){
    const x = calcTicketTimes(t);
    mttoMin += x.mttoMin; produccionMin += x.produccionMin; muertoTotalMin += x.muertoTotalMin;
    esperaInicioMin += x.esperaInicioMin; esperaValidacionMin += x.esperaValidacionMin;
    porEstado[t.estado || 'Sin estado'] = (porEstado[t.estado || 'Sin estado']||0)+1;
    porArea[t.area || 'Sin área'] = (porArea[t.area || 'Sin área']||0)+1;
    porTipoFalla[t.tipo_falla || 'Sin tipo'] = (porTipoFalla[t.tipo_falla || 'Sin tipo']||0)+1;
    porSucursal[t.sucursal || 'Sin sucursal'] = (porSucursal[t.sucursal || 'Sin sucursal']||0)+1;
    porActivo[(t.activo || 'Sin activo') + ' · ' + (t.activo_descripcion || '')] = (porActivo[(t.activo || 'Sin activo') + ' · ' + (t.activo_descripcion || '')]||0)+1;
    porTecnico[t.tecnico_username || 'Sin asignar'] = (porTecnico[t.tecnico_username || 'Sin asignar']||0)+1;
  }
  const abiertos = allTickets.rows.filter(t=>t.estado !== 'Liberado').length;
  res.json({ totalTickets:allTickets.rows.length, abiertos, totalActivos:act.rows[0].n, totalEmpleados:emp.rows[0].n, mttoMin, produccionMin, muertoTotalMin, esperaInicioMin, esperaValidacionMin, porEstado, porArea, porTipoFalla, porSucursal, porActivo, porTecnico });
});
app.get('/api/export/excel', requireCanExport, async (req,res)=>{
  const params=[]; const clauses=[];
  addTicketVisibilityClauses(req.session.user, params, clauses);
  const where = buildWhere(clauses);

  const tramoParams=[]; const tramoClauses=[];
  addTicketVisibilityClauses(req.session.user, tramoParams, tramoClauses, 't');
  const tramoWhere = buildWhere(tramoClauses);

  const assetParams=[]; const assetClauses=[];
  addScopedClauses(req.session.user, assetParams, assetClauses);
  const assetWhere = buildWhere(assetClauses);

  const [tickets, activos, users, tramos] = await Promise.all([
    pool.query(`select * from tickets ${where} order by creado desc`, params),
    pool.query(isGlobalUser(req.session.user) ? 'select * from activos order by numero' : `select * from activos ${assetWhere} order by numero`, assetParams),
    pool.query('select id,numero_empleado,name,username,role,status,area_asignada,sucursal,telefono,correo,created_at from users order by name'),
    pool.query(`
      select
        e.id,
        e.ticket_id,
        e.tipo,
        e.inicio,
        e.fin,
        e.segundos,
        e.minutos,
        e.origen,
        e.usuario_id,
        e.nota,
        e.created_at,
        t.activo,
        t.activo_descripcion,
        t.area,
        t.sucursal,
        t.estado,
        t.tecnico_username,
        t.solicitante
      from ticket_time_events e
      join tickets t on t.id::text = e.ticket_id
      ${tramoWhere}
      order by e.inicio desc
    `, tramoParams)
  ]);

  const wb=XLSX.utils.book_new();
  const ticketRows = tickets.rows.map(t => {
    const tiempos = calcTicketTimes(t);
    return {
      ticket_id: t.id,
      activo: t.activo,
      descripcion: t.activo_descripcion,
      area: t.area,
      sucursal: t.sucursal,
      ubicacion: t.ubicacion,
      solicitante: t.solicitante,
      empleado_solicitante: t.empleado_solicitante,
      telefono_solicitante: t.telefono_solicitante,
      prioridad: t.prioridad,
      tipo_falla: t.tipo_falla,
      estado: t.estado,
      tecnico_username: t.tecnico_username,
      falla: t.falla,
      diagnostico: t.diagnostico,
      solucion: t.solucion,
      creado: t.creado,
      asignado: t.asignado,
      iniciado: t.iniciado,
      terminado_tecnico: t.terminado,
      liberado_operaciones: t.liberado,
      mtto_inicio_actual: t.mtto_inicio_actual,
      operacion_inicio_actual: t.operacion_inicio_actual,
      tiempo_mtto_seg: tiempos.mttoSeg,
      tiempo_mtto_min: tiempos.mttoMin,
      tiempo_operaciones_seg: tiempos.produccionSeg,
      tiempo_operaciones_min: tiempos.produccionMin,
      tiempo_muerto_total_seg: tiempos.muertoTotalSeg,
      tiempo_muerto_total_min: tiempos.muertoTotalMin,
      fotos_reporte: JSON.stringify(t.fotos_reporte || []),
      fotos_trabajo: JSON.stringify(t.fotos_trabajo || [])
    };
  });

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ticketRows), 'Tickets');

  const tramoRows = tramos.rows.map(e => ({
    ticket_id: e.ticket_id,
    tipo: e.tipo,
    inicio: e.inicio,
    fin: e.fin,
    segundos: e.segundos,
    minutos: e.minutos,
    origen: e.origen,
    nota: e.nota,
    usuario_id: e.usuario_id,
    activo: e.activo,
    descripcion: e.activo_descripcion,
    area: e.area,
    sucursal: e.sucursal,
    estado_ticket: e.estado,
    tecnico_username: e.tecnico_username,
    solicitante: e.solicitante,
    creado_en: e.created_at
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tramoRows), 'Tramos_Tiempos');

  const graficaRows = ticketRows.map(t => ({
    ticket_id: t.ticket_id,
    activo: t.activo,
    area: t.area,
    sucursal: t.sucursal,
    tipo_falla: t.tipo_falla,
    estado: t.estado,
    tecnico_username: t.tecnico_username,
    mtto_min: t.tiempo_mtto_min,
    operaciones_min: t.tiempo_operaciones_min,
    total_min: t.tiempo_muerto_total_min
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(graficaRows), 'Base_Graficas');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(activos.rows), 'Activos');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(users.rows), 'Usuarios');
  const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Disposition','attachment; filename="reporte-ibs.xlsx"');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.get('*', (req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));
initDb().then(()=> app.listen(PORT, ()=> console.log(`IBS v2 listo en puerto ${PORT}`))).catch(e=>{ console.error(e); process.exit(1); });
