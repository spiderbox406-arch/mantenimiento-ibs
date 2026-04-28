
const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const multer = require("multer");

const app = express();
const PORT = 3000;
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
    { num:"COST-02", desc:"Máquina de costura 2", area:"Costura", tipo:"Máquina" },
    { num:"COST-03", desc:"Máquina de costura 3", area:"Costura", tipo:"Máquina" },
    { num:"GRAP-01", desc:"Grapadora Flexco 36 pulgadas", area:"Grapado", tipo:"Máquina" },
    { num:"GRAP-02", desc:"Grapadora 2", area:"Grapado", tipo:"Máquina" },
    { num:"VUL-900", desc:"Prensa Beltwin 900", area:"Vulcanizado", tipo:"Máquina" },
    { num:"VUL-1800-1", desc:"Prensa 1800-1", area:"Vulcanizado", tipo:"Máquina" },
    { num:"VUL-1800-2", desc:"Prensa 1800-2", area:"Vulcanizado", tipo:"Máquina" },
    { num:"VUL-3000", desc:"Prensa 3000", area:"Vulcanizado", tipo:"Máquina" },
    { num:"CORTE-CNC", desc:"CNC DCS2500", area:"Corte", tipo:"Máquina" }
  ],
  tickets: []
};

function loadDB(){
  if(!fs.existsSync(DB_FILE)){
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultDB,null,2));
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE,"utf8"));
  // migraciones suaves sin borrar nada
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
function minutes(a,b){ if(!a||!b) return ""; return Math.round((new Date(b)-new Date(a))/60000); }

const storage = multer.diskStorage({
  destination: (req,file,cb)=>cb(null,UPLOAD_DIR),
  filename: (req,file,cb)=>cb(null, Date.now()+"_"+file.originalname.replace(/[^\w.\-]+/g,"_"))
});
const upload = multer({storage});

app.use(express.json({limit:"20mb"}));
app.use(express.urlencoded({extended:true}));
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
    tecnicos: db.users.filter(u=>u.role==="tecnico").map(u=>({username:u.username,name:u.name})),
    equipos: db.equipos
  });
});

app.get("/api/tickets",(req,res)=>{
  const db=loadDB();
  const role=req.query.role, username=req.query.username;
  let tickets=db.tickets;
  if(role==="operaciones"){
    tickets=tickets.filter(t=>t.createdBy===username || ["Pendiente validación","Liberado","Devuelto"].includes(t.estado));
  } else if(role==="tecnico"){
    tickets=tickets.filter(t=>t.tecnicoUsername===username);
  }
  res.json(tickets);
});

app.post("/api/tickets", upload.array("fotos"), (req,res)=>{
  const db=loadDB();
  const files=(req.files||[]).map(f=>"/uploads/"+f.filename);
  const t={
    id:makeId(),
    equipo:req.body.equipo,
    descripcionEquipo:req.body.descripcionEquipo||"",
    area:req.body.area||"",
    tipoEquipo:req.body.tipoEquipo||"",
    reporta:req.body.reporta||"",
    createdBy:req.body.createdBy||"",
    falla:req.body.falla||"",
    prioridad:req.body.prioridad||"Normal",
    estado:"Reportado",
    tecnicoUsername:"",
    tecnicoName:"",
    diagnostico:"",
    solucion:"",
    fotosReporte:files,
    fotosTecnico:[],
    creado:now(),
    asignado:"",
    inicio:"",
    finTecnico:"",
    liberado:"",
    historial:[{fecha:now(),evento:"Reporte creado por operaciones"}]
  };
  db.tickets.unshift(t); saveDB(db); res.json(t);
});

app.post("/api/tickets/:id/asignar",(req,res)=>{
  const db=loadDB();
  const t=db.tickets.find(x=>x.id===req.params.id);
  if(!t) return res.status(404).json({error:"Ticket no encontrado"});
  const tecnico=db.users.find(u=>u.username===req.body.tecnicoUsername && u.role==="tecnico");
  if(!tecnico) return res.status(400).json({error:"Técnico no encontrado"});
  t.tecnicoUsername=tecnico.username;
  t.tecnicoName=tecnico.name;
  t.estado="Asignado";
  t.asignado=now();
  t.historial.push({fecha:now(),evento:"Asignado a "+tecnico.name});
  saveDB(db); res.json(t);
});

app.post("/api/tickets/:id/iniciar",(req,res)=>{
  const db=loadDB(); const t=db.tickets.find(x=>x.id===req.params.id);
  if(!t) return res.status(404).json({error:"Ticket no encontrado"});
  t.estado="En atención"; t.inicio=t.inicio||now();
  t.historial.push({fecha:now(),evento:"Técnico inicia atención"});
  saveDB(db); res.json(t);
});

app.post("/api/tickets/:id/terminar", upload.array("fotos"), (req,res)=>{
  const db=loadDB(); const t=db.tickets.find(x=>x.id===req.params.id);
  if(!t) return res.status(404).json({error:"Ticket no encontrado"});
  t.diagnostico=req.body.diagnostico||"";
  t.solucion=req.body.solucion||"";
  t.fotosTecnico=(req.files||[]).map(f=>"/uploads/"+f.filename);
  t.estado="Pendiente validación";
  t.finTecnico=now();
  t.historial.push({fecha:now(),evento:"Técnico termina reparación/revisión"});
  saveDB(db); res.json(t);
});

app.post("/api/tickets/:id/liberar",(req,res)=>{
  const db=loadDB(); const t=db.tickets.find(x=>x.id===req.params.id);
  if(!t) return res.status(404).json({error:"Ticket no encontrado"});
  t.estado="Liberado"; t.liberado=now();
  t.historial.push({fecha:now(),evento:"Operaciones libera equipo"});
  saveDB(db); res.json(t);
});

app.post("/api/tickets/:id/devolver",(req,res)=>{
  const db=loadDB(); const t=db.tickets.find(x=>x.id===req.params.id);
  if(!t) return res.status(404).json({error:"Ticket no encontrado"});
  t.estado="Devuelto";
  t.historial.push({fecha:now(),evento:"Operaciones devuelve a mantenimiento"});
  saveDB(db); res.json(t);
});

app.post("/api/config",(req,res)=>{
  const db=loadDB(); db.config=req.body; saveDB(db); res.json(db.config);
});

app.post("/api/users",(req,res)=>{
  const db=loadDB();
  const {username,password,role,name}=req.body;
  if(!username||!password||!role||!name) return res.status(400).json({error:"Faltan datos"});
  if(db.users.some(u=>u.username===username)) return res.status(400).json({error:"Usuario ya existe"});
  db.users.push({username,password,role,name}); saveDB(db); res.json({ok:true});
});

app.delete("/api/users/:username",(req,res)=>{
  const db=loadDB();
  if(req.params.username==="admin") return res.status(400).json({error:"No se puede borrar admin principal"});
  db.users=db.users.filter(u=>u.username!==req.params.username);
  saveDB(db); res.json({ok:true});
});

app.post("/api/equipos",(req,res)=>{
  const db=loadDB();
  const {num,desc,area,tipo}=req.body;
  if(!num||!desc) return res.status(400).json({error:"Faltan datos"});
  if(db.equipos.some(e=>e.num===num)) return res.status(400).json({error:"Equipo ya existe"});
  db.equipos.push({num,desc,area:area||"",tipo:tipo||"Equipo"});
  saveDB(db); res.json({ok:true});
});

app.delete("/api/equipos/:num",(req,res)=>{
  const db=loadDB();
  db.equipos=db.equipos.filter(e=>e.num!==req.params.num);
  saveDB(db); res.json({ok:true});
});

app.get("/api/export",(req,res)=>{
  const db=loadDB();
  const rows=db.tickets.map(t=>({
    ticket:t.id,equipo:t.equipo,descripcion:t.descripcionEquipo,area:t.area,reporta:t.reporta,falla:t.falla,
    prioridad:t.prioridad,estado:t.estado,tecnico:t.tecnicoName,creado:t.creado,asignado:t.asignado,
    inicio:t.inicio,finTecnico:t.finTecnico,liberado:t.liberado,
    esperaMin:minutes(t.creado,t.inicio||t.asignado),
    reparacionMin:minutes(t.inicio,t.finTecnico),
    muertoTotalMin:minutes(t.creado,t.liberado||now()),
    diagnostico:t.diagnostico,solucion:t.solucion
  }));
  const headers=Object.keys(rows[0]||{ticket:""});
  const csv=[headers.join(",")].concat(rows.map(r=>headers.map(h=>`"${String(r[h]??"").replaceAll('"','""')}"`).join(","))).join("\n");
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition","attachment; filename=mantenimiento_ibs.csv");
  res.send(csv);
});

app.get("*",(req,res)=>res.sendFile(path.join(PUBLIC_DIR,"index.html")));

app.listen(PORT,"0.0.0.0",()=>{
  const nets=os.networkInterfaces();
  const ips=[];
  for(const name of Object.keys(nets)){
    for(const net of nets[name]){
      if(net.family==="IPv4" && !net.internal) ips.push(net.address);
    }
  }
  console.log("MANTENIMIENTO IBS listo");
  console.log(`Local: http://localhost:${PORT}`);
  ips.forEach(ip=>console.log(`Red interna: http://${ip}:${PORT}`));
});
