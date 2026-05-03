
const express = require("express");
const path = require("path");
const multer = require("multer");
const XLSX = require("xlsx");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error("FALTA DATABASE_URL en Render > Ambiente");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }
});

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

function nowISO() {
  return new Date().toISOString();
}

function makeTicketId() {
  return "MTTO-" + Date.now().toString().slice(-9);
}

function minDiff(a, b) {
  if (!a || !b) return 0;
  const v = Math.round((new Date(b) - new Date(a)) / 60000);
  return Math.max(0, v);
}

function clean(v) {
  return String(v ?? "").trim();
}

function lowerClean(v) {
  return clean(v).toLowerCase();
}

function normalizeRole(role) {
  const r = lowerClean(role);
  if (["admin", "administrador"].includes(r)) return "admin";
  if (["gerente", "supervisor", "jefe"].includes(r)) return "gerente";
  if (["operaciones", "produccion", "producción"].includes(r)) return "operaciones";
  if (["tecnico", "técnico", "mantenimiento", "mtto"].includes(r)) return "tecnico";
  return "operaciones";
}

function getCell(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== "") return row[name];
  }
  const keys = Object.keys(row);
  for (const name of names) {
    const wanted = lowerClean(name).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const found = keys.find(k => lowerClean(k).normalize("NFD").replace(/[\u0300-\u036f]/g, "") === wanted);
    if (found && row[found] !== undefined && row[found] !== null && String(row[found]).trim() !== "") return row[found];
  }
  return "";
}

function ticketTimes(t) {
  const current = nowISO();
  const creado = t.creado;
  const asignado = t.asignado || (t.estado === "Reportado" ? current : null);
  const inicio = t.inicio || (t.estado === "Asignado" ? current : null);
  const finTecnico = t.fin_tecnico || (t.estado === "En atención" ? current : null);
  const liberado = t.liberado || (t.estado === "Pendiente validación" ? current : null);

  const esperaAsignacionMin = minDiff(creado, asignado);
  const esperaAtencionMin = minDiff(t.asignado, inicio);
  const reparacionMin = minDiff(t.inicio, finTecnico);
  const esperaLiberacionMin = minDiff(t.fin_tecnico, liberado);
  const muertoTotalMin = minDiff(t.creado, t.liberado || current);

  return {
    esperaAsignacionMin,
    esperaAtencionMin,
    reparacionMin,
    esperaLiberacionMin,
    mttoMin: esperaAsignacionMin + esperaAtencionMin + reparacionMin,
    produccionMin: esperaLiberacionMin,
    muertoTotalMin
  };
}

function responsableActual(estado) {
  if (estado === "Reportado") return "MTTO / Gerencia: pendiente asignación";
  if (estado === "Asignado") return "Técnico: pendiente iniciar";
  if (estado === "En atención") return "MTTO: reparación en proceso";
  if (estado === "Pendiente validación") return "Producción / Operaciones: pendiente liberar";
  if (estado === "Devuelto") return "MTTO: devuelto por producción";
  if (estado === "Liberado") return "Cerrado";
  return "";
}

function ticketOut(row) {
  if (!row) return null;
  const t = {
    id: row.id,
    activo: row.activo,
    activo_descripcion: row.activo_descripcion,
    area: row.area,
    sucursal: row.sucursal,
    solicitante: row.solicitante,
    empleado_solicitante: row.empleado_solicitante,
    telefono_solicitante: row.telefono_solicitante,
    falla: row.falla,
    prioridad: row.prioridad,
    tipo_falla: row.tipo_falla,
    estado: row.estado,
    tecnico_username: row.tecnico_username,
    tecnico_nombre: row.tecnico_nombre,
    diagnostico: row.diagnostico,
    solucion: row.solucion,
    creado: row.creado,
    asignado: row.asignado,
    inicio: row.inicio,
    fin_tecnico: row.fin_tecnico,
    liberado: row.liberado,
    historial: row.historial || []
  };
  return {
    ...t,
    tiempos: ticketTimes(row),
    responsableActual: responsableActual(row.estado)
  };
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empleados (
      id SERIAL PRIMARY KEY,
      numero_empleado TEXT UNIQUE,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      sucursal TEXT DEFAULT '',
      area_asignada TEXT DEFAULT '',
      telefono TEXT DEFAULT '',
      correo TEXT DEFAULT '',
      activo BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS activos (
      id SERIAL PRIMARY KEY,
      numero TEXT UNIQUE NOT NULL,
      descripcion TEXT NOT NULL,
      area TEXT DEFAULT '',
      tipo TEXT DEFAULT 'Equipo',
      sucursal TEXT DEFAULT '',
      ubicacion TEXT DEFAULT '',
      marca TEXT DEFAULT '',
      modelo TEXT DEFAULT '',
      serie TEXT DEFAULT '',
      estado TEXT DEFAULT 'Activo'
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      activo TEXT DEFAULT '',
      activo_descripcion TEXT DEFAULT '',
      area TEXT DEFAULT '',
      sucursal TEXT DEFAULT '',
      solicitante TEXT DEFAULT '',
      empleado_solicitante TEXT DEFAULT '',
      telefono_solicitante TEXT DEFAULT '',
      falla TEXT DEFAULT '',
      prioridad TEXT DEFAULT 'Normal',
      tipo_falla TEXT DEFAULT '',
      estado TEXT DEFAULT 'Reportado',
      tecnico_username TEXT DEFAULT '',
      tecnico_nombre TEXT DEFAULT '',
      diagnostico TEXT DEFAULT '',
      solucion TEXT DEFAULT '',
      creado TIMESTAMPTZ DEFAULT NOW(),
      asignado TIMESTAMPTZ,
      inicio TIMESTAMPTZ,
      fin_tecnico TIMESTAMPTZ,
      liberado TIMESTAMPTZ,
      historial JSONB DEFAULT '[]'::jsonb
    );
  `);

  await pool.query(`
    INSERT INTO empleados (username,password,role,name)
    VALUES
      ('admin','1234','admin','Administrador'),
      ('operaciones','1234','operaciones','Operaciones'),
      ('gerente','1234','gerente','Gerente MTTO'),
      ('juan','1234','tecnico','Juan'),
      ('carlos','1234','tecnico','Carlos')
    ON CONFLICT (username) DO NOTHING
  `);

  await pool.query(`
    INSERT INTO activos (numero,descripcion,area,tipo,sucursal)
    VALUES
      ('COST-01','Máquina de costura 1','Producción','Máquina',''),
      ('GRAP-01','Grapadora Flexco 36 pulgadas','Producción','Máquina',''),
      ('VUL-900','Prensa Beltwin 900','Producción','Máquina',''),
      ('CORTE-CNC','CNC DCS2500','Producción','Máquina','')
    ON CONFLICT (numero) DO NOTHING
  `);
}

app.get("/api/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() AS hora");
    res.json({ ok: true, db: "Neon conectado", hora: r.rows[0].hora });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const r = await pool.query(
    `SELECT id, numero_empleado, username, role, name, sucursal, area_asignada, telefono, correo
     FROM empleados
     WHERE username=$1 AND password=$2 AND activo=true`,
    [username, password]
  );

  if (!r.rows.length) return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  res.json({ user: r.rows[0] });
});

app.get("/api/bootstrap", async (req, res) => {
  const empleados = await pool.query(`SELECT id, numero_empleado, username, role, name, sucursal, area_asignada, telefono, correo, activo FROM empleados ORDER BY name`);
  const activos = await pool.query(`SELECT * FROM activos ORDER BY numero`);
  const tecnicos = empleados.rows.filter(e => e.role === "tecnico" && e.activo);
  res.json({ empleados: empleados.rows, usuarios: empleados.rows, tecnicos, activos: activos.rows, equipos: activos.rows });
});

app.get("/api/activos", async (req, res) => {
  const r = await pool.query("SELECT * FROM activos ORDER BY numero");
  res.json(r.rows);
});

app.post("/api/activos", async (req, res) => {
  const { numero, descripcion, area, tipo, sucursal, ubicacion, marca, modelo, serie, estado } = req.body;
  if (!numero || !descripcion) return res.status(400).json({ error: "Falta número o descripción" });

  try {
    await pool.query(
      `INSERT INTO activos (numero,descripcion,area,tipo,sucursal,ubicacion,marca,modelo,serie,estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [numero, descripcion, area || "", tipo || "Equipo", sucursal || "", ubicacion || "", marca || "", modelo || "", serie || "", estado || "Activo"]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "Activo ya existe" });
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/empleados", async (req, res) => {
  const r = await pool.query("SELECT id, numero_empleado, username, role, name, sucursal, area_asignada, telefono, correo, activo FROM empleados ORDER BY name");
  res.json(r.rows);
});

app.post("/api/empleados", async (req, res) => {
  const { numero_empleado, username, password, role, name, sucursal, area_asignada, telefono, correo } = req.body;
  if (!username || !name) return res.status(400).json({ error: "Falta usuario o nombre" });

  try {
    await pool.query(
      `INSERT INTO empleados (numero_empleado,username,password,role,name,sucursal,area_asignada,telefono,correo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [numero_empleado || "", username, password || "1234", normalizeRole(role), name, sucursal || "", area_asignada || "", telefono || "", correo || ""]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "Empleado o usuario ya existe" });
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/tickets", async (req, res) => {
  const r = await pool.query("SELECT * FROM tickets ORDER BY creado DESC");
  res.json(r.rows.map(ticketOut));
});

app.post("/api/tickets", async (req, res) => {
  const {
    activo, activo_descripcion, area, sucursal, solicitante, empleado_solicitante,
    telefono_solicitante, falla, prioridad, tipo_falla
  } = req.body;

  const id = makeTicketId();
  const historial = [{ fecha: nowISO(), evento: "Ticket creado" }];

  await pool.query(
    `INSERT INTO tickets (
      id, activo, activo_descripcion, area, sucursal, solicitante, empleado_solicitante,
      telefono_solicitante, falla, prioridad, tipo_falla, estado, historial
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Reportado',$12)`,
    [
      id, activo || "", activo_descripcion || "", area || "", sucursal || "",
      solicitante || "", empleado_solicitante || "", telefono_solicitante || "",
      falla || "", prioridad || "Normal", tipo_falla || "", JSON.stringify(historial)
    ]
  );

  const r = await pool.query("SELECT * FROM tickets WHERE id=$1", [id]);
  res.json(ticketOut(r.rows[0]));
});

app.post("/api/tickets/:id/asignar", async (req, res) => {
  const { tecnico_username } = req.body;
  const tec = await pool.query("SELECT username, name FROM empleados WHERE username=$1 AND role='tecnico'", [tecnico_username]);
  if (!tec.rows.length) return res.status(400).json({ error: "Técnico no encontrado" });

  const old = await pool.query("SELECT historial FROM tickets WHERE id=$1", [req.params.id]);
  if (!old.rows.length) return res.status(404).json({ error: "Ticket no encontrado" });
  const hist = old.rows[0].historial || [];
  hist.push({ fecha: nowISO(), evento: "Asignado a " + tec.rows[0].name });

  const r = await pool.query(
    `UPDATE tickets SET estado='Asignado', tecnico_username=$1, tecnico_nombre=$2, asignado=NOW(), historial=$3 WHERE id=$4 RETURNING *`,
    [tec.rows[0].username, tec.rows[0].name, JSON.stringify(hist), req.params.id]
  );
  res.json(ticketOut(r.rows[0]));
});

app.post("/api/tickets/:id/iniciar", async (req, res) => {
  const old = await pool.query("SELECT historial FROM tickets WHERE id=$1", [req.params.id]);
  if (!old.rows.length) return res.status(404).json({ error: "Ticket no encontrado" });
  const hist = old.rows[0].historial || [];
  hist.push({ fecha: nowISO(), evento: "Técnico inicia atención" });

  const r = await pool.query(
    `UPDATE tickets SET estado='En atención', inicio=COALESCE(inicio,NOW()), historial=$1 WHERE id=$2 RETURNING *`,
    [JSON.stringify(hist), req.params.id]
  );
  res.json(ticketOut(r.rows[0]));
});

app.post("/api/tickets/:id/terminar", async (req, res) => {
  const { diagnostico, solucion } = req.body;
  const old = await pool.query("SELECT historial FROM tickets WHERE id=$1", [req.params.id]);
  if (!old.rows.length) return res.status(404).json({ error: "Ticket no encontrado" });
  const hist = old.rows[0].historial || [];
  hist.push({ fecha: nowISO(), evento: "Técnico termina reparación. Pendiente validación de producción." });

  const r = await pool.query(
    `UPDATE tickets SET estado='Pendiente validación', diagnostico=$1, solucion=$2, fin_tecnico=NOW(), historial=$3 WHERE id=$4 RETURNING *`,
    [diagnostico || "", solucion || "", JSON.stringify(hist), req.params.id]
  );
  res.json(ticketOut(r.rows[0]));
});

app.post("/api/tickets/:id/liberar", async (req, res) => {
  const old = await pool.query("SELECT historial FROM tickets WHERE id=$1", [req.params.id]);
  if (!old.rows.length) return res.status(404).json({ error: "Ticket no encontrado" });
  const hist = old.rows[0].historial || [];
  hist.push({ fecha: nowISO(), evento: "Producción libera equipo" });

  const r = await pool.query(
    `UPDATE tickets SET estado='Liberado', liberado=NOW(), historial=$1 WHERE id=$2 RETURNING *`,
    [JSON.stringify(hist), req.params.id]
  );
  res.json(ticketOut(r.rows[0]));
});

app.post("/api/tickets/:id/devolver", async (req, res) => {
  const old = await pool.query("SELECT historial FROM tickets WHERE id=$1", [req.params.id]);
  if (!old.rows.length) return res.status(404).json({ error: "Ticket no encontrado" });
  const hist = old.rows[0].historial || [];
  hist.push({ fecha: nowISO(), evento: "Producción devuelve ticket a MTTO" });

  const r = await pool.query(
    `UPDATE tickets SET estado='Devuelto', historial=$1 WHERE id=$2 RETURNING *`,
    [JSON.stringify(hist), req.params.id]
  );
  res.json(ticketOut(r.rows[0]));
});

app.post("/api/import/activos", uploadExcel.single("archivo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió archivo" });

  const wb = XLSX.read(req.file.buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  let agregados = 0, actualizados = 0, omitidos = 0;
  const errores = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const numero = clean(getCell(row, ["numero", "número", "num", "equipo", "activo", "no equipo", "numero equipo", "número equipo"]));
    const descripcion = clean(getCell(row, ["descripcion", "descripción", "desc", "nombre", "equipo descripcion", "descripcion equipo"]));

    if (!numero || !descripcion) {
      omitidos++;
      errores.push({ fila: i + 2, error: "Falta número/activo o descripción" });
      continue;
    }

    const data = {
      numero,
      descripcion,
      area: clean(getCell(row, ["area", "área", "departamento"])),
      tipo: clean(getCell(row, ["tipo", "tipo equipo", "categoria", "categoría"])) || "Equipo",
      sucursal: clean(getCell(row, ["sucursal", "planta"])),
      ubicacion: clean(getCell(row, ["ubicacion", "ubicación"])),
      marca: clean(getCell(row, ["marca"])),
      modelo: clean(getCell(row, ["modelo"])),
      serie: clean(getCell(row, ["serie", "serial"])),
      estado: clean(getCell(row, ["estado"])) || "Activo"
    };

    const result = await pool.query(
      `INSERT INTO activos (numero,descripcion,area,tipo,sucursal,ubicacion,marca,modelo,serie,estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (numero) DO UPDATE SET
        descripcion=EXCLUDED.descripcion,
        area=EXCLUDED.area,
        tipo=EXCLUDED.tipo,
        sucursal=EXCLUDED.sucursal,
        ubicacion=EXCLUDED.ubicacion,
        marca=EXCLUDED.marca,
        modelo=EXCLUDED.modelo,
        serie=EXCLUDED.serie,
        estado=EXCLUDED.estado
       RETURNING (xmax = 0) AS inserted`,
      [data.numero,data.descripcion,data.area,data.tipo,data.sucursal,data.ubicacion,data.marca,data.modelo,data.serie,data.estado]
    );

    if (result.rows[0]?.inserted) agregados++; else actualizados++;
  }

  res.json({ ok: true, total: rows.length, agregados, actualizados, omitidos, errores });
});

app.post("/api/import/empleados", uploadExcel.single("archivo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió archivo" });

  const wb = XLSX.read(req.file.buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  let agregados = 0, actualizados = 0, omitidos = 0;
  const errores = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const numeroEmpleado = clean(getCell(row, ["numeroEmpleado", "numero empleado", "número empleado", "empleado", "no empleado"]));
    const name = clean(getCell(row, ["nombre", "name", "empleado nombre", "nombre completo"]));
    let username = clean(getCell(row, ["username", "usuario", "user"]));

    if (!username && numeroEmpleado) username = numeroEmpleado;
    if (!username || !name) {
      omitidos++;
      errores.push({ fila: i + 2, error: "Falta usuario/número empleado o nombre" });
      continue;
    }

    const data = {
      numero_empleado: numeroEmpleado,
      username,
      password: clean(getCell(row, ["password", "contraseña", "contrasena"])) || "1234",
      role: normalizeRole(getCell(row, ["role", "rol", "puesto", "perfil"])),
      name,
      sucursal: clean(getCell(row, ["sucursal", "planta"])),
      area_asignada: clean(getCell(row, ["areaAsignada", "area asignada", "área asignada", "area", "área"])),
      telefono: clean(getCell(row, ["telefono", "teléfono", "celular", "extension", "extensión"])),
      correo: clean(getCell(row, ["correo", "email", "mail"]))
    };

    const result = await pool.query(
      `INSERT INTO empleados (numero_empleado,username,password,role,name,sucursal,area_asignada,telefono,correo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (username) DO UPDATE SET
        numero_empleado=EXCLUDED.numero_empleado,
        password=EXCLUDED.password,
        role=EXCLUDED.role,
        name=EXCLUDED.name,
        sucursal=EXCLUDED.sucursal,
        area_asignada=EXCLUDED.area_asignada,
        telefono=EXCLUDED.telefono,
        correo=EXCLUDED.correo,
        activo=true
       RETURNING (xmax = 0) AS inserted`,
      [data.numero_empleado,data.username,data.password,data.role,data.name,data.sucursal,data.area_asignada,data.telefono,data.correo]
    );

    if (result.rows[0]?.inserted) agregados++; else actualizados++;
  }

  res.json({ ok: true, total: rows.length, agregados, actualizados, omitidos, errores });
});

app.get("/api/reportes", async (req, res) => {
  const ticketsR = await pool.query("SELECT * FROM tickets ORDER BY creado DESC");
  const activosR = await pool.query("SELECT COUNT(*)::int AS total FROM activos");
  const empleadosR = await pool.query("SELECT COUNT(*)::int AS total FROM empleados WHERE activo=true");

  const tickets = ticketsR.rows.map(ticketOut);
  const abiertos = tickets.filter(t => t.estado !== "Liberado").length;
  const liberados = tickets.filter(t => t.estado === "Liberado").length;

  const tiempos = tickets.reduce((acc, t) => {
    acc.mttoMin += t.tiempos.mttoMin;
    acc.produccionMin += t.tiempos.produccionMin;
    acc.muertoTotalMin += t.tiempos.muertoTotalMin;
    return acc;
  }, { mttoMin: 0, produccionMin: 0, muertoTotalMin: 0 });

  const porEstado = {};
  const porArea = {};
  const porTipoFalla = {};

  for (const t of tickets) {
    porEstado[t.estado] = (porEstado[t.estado] || 0) + 1;
    porArea[t.area || "Sin área"] = (porArea[t.area || "Sin área"] || 0) + 1;
    porTipoFalla[t.tipo_falla || "Sin tipo"] = (porTipoFalla[t.tipo_falla || "Sin tipo"] || 0) + 1;
  }

  res.json({
    totalTickets: tickets.length,
    abiertos,
    liberados,
    totalActivos: activosR.rows[0].total,
    totalEmpleados: empleadosR.rows[0].total,
    ...tiempos,
    porEstado,
    porArea,
    porTipoFalla,
    tickets
  });
});

app.get("/api/export/excel", async (req, res) => {
  const activos = (await pool.query("SELECT * FROM activos ORDER BY numero")).rows;
  const empleados = (await pool.query("SELECT id, numero_empleado, username, role, name, sucursal, area_asignada, telefono, correo, activo FROM empleados ORDER BY name")).rows;
  const ticketsRaw = (await pool.query("SELECT * FROM tickets ORDER BY creado DESC")).rows;
  const tickets = ticketsRaw.map(ticketOut).map(t => ({
    id: t.id,
    activo: t.activo,
    descripcion: t.activo_descripcion,
    area: t.area,
    sucursal: t.sucursal,
    solicitante: t.solicitante,
    falla: t.falla,
    prioridad: t.prioridad,
    tipo_falla: t.tipo_falla,
    estado: t.estado,
    tecnico: t.tecnico_nombre,
    creado: t.creado,
    asignado: t.asignado,
    inicio: t.inicio,
    fin_tecnico: t.fin_tecnico,
    liberado: t.liberado,
    esperaAsignacionMin: t.tiempos.esperaAsignacionMin,
    esperaAtencionMin: t.tiempos.esperaAtencionMin,
    reparacionMin: t.tiempos.reparacionMin,
    esperaLiberacionProduccionMin: t.tiempos.esperaLiberacionMin,
    tiempoMTTOMin: t.tiempos.mttoMin,
    tiempoProduccionMin: t.tiempos.produccionMin,
    muertoTotalMin: t.tiempos.muertoTotalMin,
    responsableActual: t.responsableActual,
    diagnostico: t.diagnostico,
    solucion: t.solucion
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(activos), "Activos");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(empleados), "Empleados");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tickets), "Tickets");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  res.setHeader("Content-Disposition", "attachment; filename=mantenimiento_ibs_reporte.xlsx");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buffer);
});

app.get("/api/export", async (req, res) => {
  const ticketsRaw = (await pool.query("SELECT * FROM tickets ORDER BY creado DESC")).rows;
  const rows = ticketsRaw.map(ticketOut).map(t => ({
    id: t.id,
    activo: t.activo,
    descripcion: t.activo_descripcion,
    area: t.area,
    solicitante: t.solicitante,
    falla: t.falla,
    estado: t.estado,
    tecnico: t.tecnico_nombre,
    creado: t.creado,
    asignado: t.asignado,
    inicio: t.inicio,
    fin_tecnico: t.fin_tecnico,
    liberado: t.liberado,
    tiempoMTTOMin: t.tiempos.mttoMin,
    tiempoProduccionMin: t.tiempos.produccionMin,
    muertoTotalMin: t.tiempos.muertoTotalMin,
    responsableActual: t.responsableActual
  }));
  const headers = Object.keys(rows[0] || { id: "" });
  const csv = [headers.join(","), ...rows.map(row => headers.map(h => `"${String(row[h] ?? "").replaceAll('"','""')}"`).join(","))].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=mantenimiento_ibs.csv");
  res.send(csv);
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log("MANTENIMIENTO IBS listo con Neon + Excel + Reportes");
      console.log("Puerto:", PORT);
    });
  })
  .catch(err => {
    console.error("Error iniciando base de datos:", err);
    process.exit(1);
  });
