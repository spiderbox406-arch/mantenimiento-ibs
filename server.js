const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const multer = require("multer");

const app = express();

// 🔥 IMPORTANTE PARA RENDER
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");

fs.mkdirSync(DATA_DIR,{recursive:true});
fs.mkdirSync(UPLOAD_DIR,{recursive:true});

const defaultDB = {
config: { whatsappGerente: "", whatsappTecnicos: {} },
users: [
{ username:"admin", password:"1234", role:"admin", name:"Administrador" },
{ username:"operaciones", password:"1234", role:"operaciones", name:"Operaciones" },
{ username:"gerente", password:"1234", role:"gerente", name:"Gerente MTTO" },
{ username:"juan", password:"1234", role:"tecnico", name:"Juan" },
{ username:"carlos", password:"1234", role:"tecnico", name:"Carlos" }
],
equipos: [
{ num:"COST-01", desc:"Máquina de costura 1", area:"Costura", tipo:"Máquina" },
{ num:"GRAP-01", desc:"Grapadora Flexco 36 pulgadas", area:"Grapado", tipo:"Máquina" },
{ num:"VUL-900", desc:"Prensa Beltwin 900", area:"Vulcanizado", tipo:"Máquina" },
{ num:"CORTE-CNC", desc:"CNC DCS2500", area:"Corte", tipo:"Máquina" }
],
tickets: []
};

function loadDB(){
if(!fs.existsSync(DB_FILE)){
fs.writeFileSync(DB_FILE, JSON.stringify(defaultDB,null,2));
}
const db = JSON.parse(fs.readFileSync(DB_FILE,"utf8"));
db.config = db.config || defaultDB.config;
db.users = db.users || [];
if(!db.users.some(u=>u.username==="admin")) db.users.unshift(defaultDB.users[0]);
db.equipos = db.equipos || defaultDB.equipos;
db.tickets = db.tickets || [];
return db;
}
function saveDB(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)); }
function now(){ return new Date().toISOString(); }
function makeId(){ return "MTTO-" + Date.now().toString().slice(-8); }

const storage = multer.diskStorage({
destination: (req,file,cb)=>cb(null,UPLOAD_DIR),
filename: (req,file,cb)=>cb(null, Date.now()+"*"+file.originalname.replace(/[^\w.-]+/g,"*"))
});
const upload = multer({storage});

app.use(express.json({limit:"20mb"}));
app.use(express.urlencoded({extended:true}));

// 🔥 SERVIR FRONTEND
app.use(express.static(PUBLIC_DIR));

app.post("/api/login",(req,res)=>{
const {username,password}=req.body;
const db=loadDB();
const user=db.users.find(u=>u.username===username && u.password===password);
if(!user) return res.status(401).json({error:"Usuario o contraseña incorrectos"});
res.json({user:{username:user.username, role:user.role, name:user.name}});
});

app.get("/api/bootstrap",(req,res)=>{
const db=loadDB();
res.json({
config: db.config,
users: db.users.map(({password,...u})=>u),
tecnicos: db.users.filter(u=>u.role==="tecnico"),
equipos: db.equipos
});
});

app.post("/api/tickets", upload.array("fotos"), (req,res)=>{
const db=loadDB();
const files=(req.files||[]).map(f=>"/uploads/"+f.filename);
const t={
id:makeId(),
equipo:req.body.equipo,
falla:req.body.falla,
estado:"Reportado",
fotosReporte:files,
creado:now()
};
db.tickets.unshift(t);
saveDB(db);
res.json(t);
});

// 🔥 RUTA PRINCIPAL (IMPORTANTE)
app.get("/", (req,res)=>{
res.sendFile(path.join(PUBLIC_DIR,"index.html"));
});

// 🔥 FALLBACK PARA RENDER
app.get("*",(req,res)=>{
res.sendFile(path.join(PUBLIC_DIR,"index.html"));
});

// 🔥 ARRANQUE
app.listen(PORT,"0.0.0.0",()=>{
console.log("Servidor corriendo");
console.log(`Puerto: ${PORT}`);
});
