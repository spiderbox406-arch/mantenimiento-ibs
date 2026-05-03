const express = require("express");
const path = require("path");
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

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS equipos (
      id SERIAL PRIMARY KEY,
      numero TEXT UNIQUE NOT NULL,
      descripcion TEXT NOT NULL,
      area TEXT DEFAULT '',
      tipo TEXT DEFAULT 'Equipo'
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      equipo TEXT DEFAULT '',
      descripcion TEXT DEFAULT '',
      area TEXT DEFAULT '',
      reporta TEXT DEFAULT '',
      falla TEXT DEFAULT '',
      estado TEXT DEFAULT 'Reportado',
      creado TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    INSERT INTO users (username,password,role,name)
    VALUES 
      ('admin','1234','admin','Administrador'),
      ('operaciones','1234','operaciones','Operaciones'),
      ('gerente','1234','gerente','Gerente MTTO'),
      ('juan','1234','tecnico','Juan'),
      ('carlos','1234','tecnico','Carlos')
    ON CONFLICT (username) DO NOTHING
  `);

  await pool.query(`
    INSERT INTO equipos (numero,descripcion,area,tipo)
    VALUES
      ('COST-01','Máquina de costura 1','Producción','Máquina'),
      ('GRAP-01','Grapadora Flexco 36 pulgadas','Producción','Máquina'),
      ('VUL-900','Prensa Beltwin 900','Producción','Máquina'),
      ('CORTE-CNC','CNC DCS2500','Producción','Máquina')
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
  const result = await pool.query(
    "SELECT id, username, role, name FROM users WHERE username=$1 AND password=$2",
    [username, password]
  );

  if (!result.rows.length) {
    return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  }

  res.json({ user: result.rows[0] });
});

app.get("/api/equipos", async (req, res) => {
  const result = await pool.query("SELECT * FROM equipos ORDER BY numero");
  res.json(result.rows);
});

app.post("/api/equipos", async (req, res) => {
  const { numero, descripcion, area, tipo } = req.body;

  if (!numero || !descripcion) {
    return res.status(400).json({ error: "Falta número o descripción" });
  }

  try {
    await pool.query(
      "INSERT INTO equipos (numero,descripcion,area,tipo) VALUES ($1,$2,$3,$4)",
      [numero, descripcion, area || "", tipo || "Equipo"]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "Equipo ya existe" });
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/tickets", async (req, res) => {
  const result = await pool.query("SELECT * FROM tickets ORDER BY creado DESC");
  res.json(result.rows);
});

app.post("/api/tickets", async (req, res) => {
  const { equipo, descripcion, area, reporta, falla } = req.body;
  const id = "MTTO-" + Date.now();

  await pool.query(
    `INSERT INTO tickets (id,equipo,descripcion,area,reporta,falla,estado,creado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
    [id, equipo || "", descripcion || "", area || "", reporta || "", falla || "", "Reportado"]
  );

  res.json({ ok: true, id });
});

app.get("/api/export", async (req, res) => {
  const result = await pool.query("SELECT * FROM tickets ORDER BY creado DESC");
  const rows = result.rows;
  const headers = Object.keys(rows[0] || { id: "" });
  const csv = [
    headers.join(","),
    ...rows.map(row => headers.map(h => `"${String(row[h] ?? "").replaceAll('"','""')}"`).join(","))
  ].join("\n");

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
      console.log("MANTENIMIENTO IBS listo con Neon");
      console.log("Puerto:", PORT);
    });
  })
  .catch(err => {
    console.error("Error iniciando base de datos:", err);
    process.exit(1);
  });
