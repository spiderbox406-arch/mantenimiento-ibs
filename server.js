const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// 🔥 CONEXIÓN A NEON
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Middlewares
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 🔥 CREAR TABLAS SI NO EXISTEN
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      role TEXT,
      name TEXT
    );

    CREATE TABLE IF NOT EXISTS equipos (
      id SERIAL PRIMARY KEY,
      numero TEXT UNIQUE,
      descripcion TEXT,
      area TEXT,
      tipo TEXT
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      equipo TEXT,
      descripcion TEXT,
      area TEXT,
      reporta TEXT,
      falla TEXT,
      estado TEXT,
      creado TIMESTAMP
    );
  `);

  // Usuario default
  await pool.query(`
    INSERT INTO users (username,password,role,name)
    VALUES ('admin','1234','admin','Administrador')
    ON CONFLICT (username) DO NOTHING
  `);
}

// LOGIN
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  const result = await pool.query(
    "SELECT * FROM users WHERE username=$1 AND password=$2",
    [username, password]
  );

  if (result.rows.length === 0) {
    return res.status(401).json({ error: "Credenciales incorrectas" });
  }

  res.json({ user: result.rows[0] });
});

// OBTENER EQUIPOS
app.get("/api/equipos", async (req, res) => {
  const result = await pool.query("SELECT * FROM equipos ORDER BY numero");
  res.json(result.rows);
});

// AGREGAR EQUIPO
app.post("/api/equipos", async (req, res) => {
  const { numero, descripcion, area, tipo } = req.body;

  try {
    await pool.query(
      "INSERT INTO equipos (numero,descripcion,area,tipo) VALUES ($1,$2,$3,$4)",
      [numero, descripcion, area, tipo]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: "Equipo ya existe" });
  }
});

// OBTENER TICKETS
app.get("/api/tickets", async (req, res) => {
  const result = await pool.query("SELECT * FROM tickets ORDER BY creado DESC");
  res.json(result.rows);
});

// CREAR TICKET
app.post("/api/tickets", async (req, res) => {
  const { equipo, descripcion, area, reporta, falla } = req.body;

  const id = "MTTO-" + Date.now();

  await pool.query(
    `INSERT INTO tickets 
    (id,equipo,descripcion,area,reporta,falla,estado,creado)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, equipo, descripcion, area, reporta, falla, "Reportado", new Date()]
  );

  res.json({ ok: true });
});

// 🔥 TEST DE CONEXIÓN
app.get("/api/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW()");
    res.json({ ok: true, db: "Neon conectado", hora: r.rows[0].now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// FRONTEND
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// INICIAR
initDB().then(() => {
  app.listen(PORT, () => {
    console.log("Servidor corriendo en puerto " + PORT);
  });
});
