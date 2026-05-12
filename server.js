const express = require('express');
const multer = require('multer');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended:true }));

app.use(express.static(__dirname));

const PORT = 5000;

let solicitudes = [];
let unidades = [
    { id:1, nombre:'Silverado', estado:'DISPONIBLE' },
    { id:2, nombre:'NP300', estado:'DISPONIBLE' }
];

app.get('/api/solicitudes', (req,res)=>{
    res.json(solicitudes);
});

app.post('/api/crear-solicitud', (req,res)=>{

    const nueva = {
        folio:'UNI-'+Date.now(),
        empresa:req.body.empresa,
        op:req.body.op,
        tecnico:req.body.tecnico,
        estado:'SOLICITADO',
        unidad:null
    };

    solicitudes.push(nueva);

    res.json({
        ok:true,
        data:nueva
    });
});

app.post('/api/asignar-unidad', (req,res)=>{

    const { folio, unidad } = req.body;

    const solicitud = solicitudes.find(x=>x.folio===folio);

    if(!solicitud){
        return res.status(404).json({
            ok:false,
            error:'Solicitud no encontrada'
        });
    }

    solicitud.unidad = unidad;
    solicitud.estado = 'ASIGNADA';

    res.json({
        ok:true,
        data:solicitud
    });

});

app.post('/api/liberar-unidad', (req,res)=>{

    const {
        checklistCompleto,
        firmas,
        fotos,
        combustible
    } = req.body;

    if(!checklistCompleto || !firmas || !fotos){
        return res.status(400).json({
            ok:false,
            error:'Checklist obligatorio incompleto'
        });
    }

    res.json({
        ok:true,
        mensaje:'Unidad liberada'
    });

});

app.listen(PORT, ()=>{
    console.log('Servidor iniciado en puerto '+PORT);
});
