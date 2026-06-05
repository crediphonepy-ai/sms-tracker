const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const SMS_USER = process.env.SMS_USER || "CLXHSQ";
const SMS_PASS = process.env.SMS_PASS || "g6qz0njve0masq";
const SMS_API  = "https://api.sms-gate.app/3rdparty/v1";
const BASE_URL = process.env.BASE_URL || "https://sms-tracker-production.up.railway.app";

const contacts = {};
const clicks   = [];
const smsLog   = [];

function genId() { return crypto.randomBytes(4).toString("hex").toUpperCase(); }
function now()   { return new Date().toISOString().replace("T"," ").slice(0,16); }

app.get("/c/:linkId", (req, res) => {
  const { linkId } = req.params;
  const contact = Object.values(contacts).find(c => c.linkId === linkId);
  if (contact) {
    contact.clicked   = true;
    contact.clickedAt = now();
    contact.clickCount = (contact.clickCount || 0) + 1;
    clicks.push({ ts: now(), linkId, name: contact.name, phone: contact.phone });
  }
  res.redirect(302, process.env.CATALOG_URL || "https://wa.me/595981000000");
});

app.post("/api/contacts/load", (req, res) => {
  const { rows } = req.body;
  if (!rows || !rows.length) return res.status(400).json({ error: "Sin contactos" });
  let added = 0;
  rows.forEach(function(row) {
    if (!row.phone) return;
    const id = genId();
    contacts[id] = { id, name: row.name || "Cliente", phone: row.phone.trim(), linkId: genId(), clicked: false, stopped: false, replied: false, smsSent: false, smsAt: null };
    added++;
  });
  res.json({ ok: true, added, total: Object.keys(contacts).length });
});

app.post("/api/sms/send", async (req, res) => {
  const { contactId, message } = req.body;
  const contact = contacts[contactId];
  if (!contact) return res.status(404).json({ error: "No encontrado" });
  if (contact.stopped) return res.status(400).json({ error: "STOP" });
  const trackUrl = BASE_URL + "/c/" + contact.linkId;
  const finalMsg = (message || "").replace("{{nombre}}", contact.name.split(" ")[0]).replace("{{link}}", trackUrl);
  try {
    const r = await fetch(SMS_API + "/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Basic " + Buffer.from(SMS_USER + ":" + SMS_PASS).toString("base64") },
      body: JSON.stringify({ message: finalMsg, phoneNumbers: [contact.phone] })
    });
    const data = await r.json();
    if (r.ok) {
      contact.smsSent = true; contact.smsAt = now();
      smsLog.push({ ts: now(), name: contact.name, phone: contact.phone, status: "ENVIADO" });
      res.json({ ok: true, trackUrl });
    } else {
      smsLog.push({ ts: now(), name: contact.name, phone: contact.phone, status: "FALLIDO" });
      res.status(500).json({ error: data });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/sms/blast", async (req, res) => {
  const { message, delaySeconds = 90, filterSent = true } = req.body;
  let targets = Object.values(contacts).filter(c => !c.stopped);
  if (filterSent) targets = targets.filter(c => !c.smsSent);
  res.json({ ok: true, queued: targets.length, estimatedMinutes: Math.ceil((targets.length * delaySeconds) / 60) });
  (async () => {
    for (const c of targets) {
      const trackUrl = BASE_URL + "/c/" + c.linkId;
      const finalMsg = (message || "").replace("{{nombre}}", c.name.split(" ")[0]).replace("{{link}}", trackUrl);
      try {
        const r = await fetch(SMS_API + "/message", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Basic " + Buffer.from(SMS_USER + ":" + SMS_PASS).toString("base64") }, body: JSON.stringify({ message: finalMsg, phoneNumbers: [c.phone] }) });
        const data = await r.json();
        if (r.ok) { c.smsSent = true; c.smsAt = now(); smsLog.push({ ts: now(), name: c.name, phone: c.phone, status: "ENVIADO" }); }
        else { smsLog.push({ ts: now(), name: c.name, phone: c.phone, status: "FALLIDO" }); }
      } catch (err) { console.log("Error:", err.message); }
      await new Promise(r => setTimeout(r, delaySeconds * 1000));
    }
  })();
});

app.get("/api/metrics", (req, res) => {
  const all = Object.values(contacts);
  const sent = all.filter(c => c.smsSent);
  const clicked = all.filter(c => c.clicked);
  res.json({ total: all.length, sent: sent.length, clicked: clicked.length, clickRate: sent.length ? ((clicked.length/sent.length)*100).toFixed(1) : 0, stopped: all.filter(c=>c.stopped).length, pendingFollowUp: sent.filter(c=>!c.clicked&&!c.stopped).length, recentClicks: clicks.slice(-10).reverse(), smsLog: smsLog.slice(-20).reverse(), contacts: all });
});

app.get("/api/contacts", (req, res) => res.json(Object.values(contacts)));
app.get("/health", (req, res) => res.json({ ok: true, contacts: Object.keys(contacts).length }));

app.get("/", (req, res) => {
  const html = getHTML();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SMS Tracker port " + PORT));

function getHTML() {
const css = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0b0d;color:#e8eaf0;font-family:monospace;min-height:100vh}
.header{background:#111318;border-bottom:1px solid #22272f;padding:16px 24px;display:flex;align-items:center;gap:16px}
.logo{font-size:20px;font-weight:800;color:#00e5a0;letter-spacing:2px}
.sub{font-size:10px;color:#5a6070;letter-spacing:1px}
.status{margin-left:auto;font-size:11px;padding:4px 12px;border-radius:3px;background:#00e5a022;color:#00e5a0;border:1px solid #00e5a044}
.tabs{display:flex;background:#111318;border-bottom:1px solid #22272f}
.tab{padding:12px 20px;border:none;background:transparent;color:#5a6070;font-family:inherit;font-size:12px;font-weight:700;letter-spacing:1px;cursor:pointer;border-bottom:2px solid transparent}
.tab.active{color:#00e5a0;border-bottom-color:#00e5a0}
.content{padding:24px;max-width:1000px;margin:0 auto}
.section{display:none}.section.active{display:block}
.card{background:#16191f;border:1px solid #22272f;border-radius:6px;padding:20px;margin-bottom:16px}
.label{font-size:10px;color:#5a6070;letter-spacing:1px;margin-bottom:8px}
input,textarea,select{width:100%;background:#0a0b0d;border:1px solid #22272f;border-radius:4px;padding:10px 12px;color:#e8eaf0;font-family:inherit;font-size:13px;margin-bottom:12px}
textarea{resize:vertical;min-height:80px}
.btn{padding:10px 20px;border-radius:4px;border:none;cursor:pointer;font-family:inherit;font-weight:700;font-size:12px;letter-spacing:1px}
.btn-primary{background:#00e5a0;color:#000}
.btn-secondary{background:#22272f;color:#e8eaf0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}
.stat{background:#16191f;border:1px solid #22272f;border-radius:6px;padding:16px}
.stat-val{font-size:28px;font-weight:800}
.stat-label{font-size:10px;color:#5a6070;letter-spacing:1px;margin-bottom:6px}
.green{color:#00e5a0}.yellow{color:#f5a623}.red{color:#ff4545}.blue{color:#4da6ff}
table{width:100%;border-collapse:collapse}
th{padding:10px 14px;text-align:left;font-size:10px;color:#5a6070;border-bottom:1px solid #22272f}
td{padding:10px 14px;font-size:12px;border-bottom:1px solid #22272f22}
.badge{font-size:10px;padding:2px 8px;border-radius:2px;font-weight:700}
.bg{background:#00e5a022;color:#00e5a0;border:1px solid #00e5a044}
.by{background:#f5a62322;color:#f5a623;border:1px solid #f5a62344}
.br{background:#ff454522;color:#ff4545;border:1px solid #ff454544}
.bb{background:#4da6ff22;color:#4da6ff;border:1px solid #4da6ff44}
#dz{border:2px dashed #22272f;border-radius:6px;padding:40px;text-align:center;cursor:pointer;color:#5a6070;margin-bottom:12px}
#dz:hover{border-color:#00e5a0;color:#00e5a0}
.alert{padding:12px 16px;border-radius:4px;margin-bottom:12px;font-size:13px}
.as{background:#00e5a022;color:#00e5a0;border:1px solid #00e5a044}
.ae{background:#ff454522;color:#ff4545;border:1px solid #ff454544}
`;

const js = `
var BASE = window.location.origin;

function switchTab(tid) {
  var tabs = document.querySelectorAll('.tab');
  var sections = document.querySelectorAll('.section');
  for(var i=0;i<tabs.length;i++) tabs[i].classList.remove('active');
  for(var i=0;i<sections.length;i++) sections[i].classList.remove('active');
  event.currentTarget.classList.add('active');
  document.getElementById('tab-'+tid).classList.add('active');
  if(tid==='metricas'||tid==='contactos'||tid==='logs') loadMetrics();
}

function applyTemplate() {
  var v = document.getElementById('tpl').value;
  var t = {
    iphone: 'Hola {{nombre}}! Tenemos iPhones en cuotas sin interes. Ver modelos: {{link}}',
    oferta: '{{nombre}}, oferta 48hs! iPhone garantia y cuotas fijas: {{link}}',
    seg: 'Hola {{nombre}}, pudiste ver las opciones? Link: {{link}}'
  };
  if(t[v]) { document.getElementById('msg').value=t[v]; updateCnt(); }
}

function updateCnt() {
  var l = document.getElementById('msg').value.length;
  var el = document.getElementById('cnt');
  el.textContent = l;
  el.style.color = l>160 ? '#f5a623' : '#5a6070';
}

var dz = document.getElementById('dz');
dz.addEventListener('dragover', function(e){ e.preventDefault(); dz.style.borderColor='#00e5a0'; });
dz.addEventListener('dragleave', function(){ dz.style.borderColor='#22272f'; });
dz.addEventListener('drop', function(e){ e.preventDefault(); dz.style.borderColor='#22272f'; if(e.dataTransfer.files[0]) processCSV(e.dataTransfer.files[0]); });

function loadCSV(inp) { if(inp.files[0]) processCSV(inp.files[0]); }

function processCSV(file) {
  var reader = new FileReader();
  reader.onload = function(e) {
    var lines = e.target.result.split('\n').filter(function(l){ return l.trim(); });
    var rows = [];
    lines.forEach(function(line,i){
      if(i===0 && line.toLowerCase().indexOf('nombre')>=0) return;
      var p = line.split(',');
      if(p.length>=2) rows.push({name:p[0].trim(),phone:p[1].trim()});
    });
    fetch(BASE+'/api/contacts/load',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows:rows})})
      .then(function(r){return r.json();})
      .then(function(d){ document.getElementById('lr').innerHTML='<div class="alert as">OK: '+d.added+' contactos. Total: '+d.total+'</div>'; })
      .catch(function(err){ document.getElementById('lr').innerHTML='<div class="alert ae">Error: '+err.message+'</div>'; });
  };
  reader.readAsText(file);
}

function sendBlast() {
  var msg = document.getElementById('msg').value;
  if(!msg) { alert('Escribe el mensaje primero'); return; }
  var delay = parseInt(document.getElementById('delay').value)||90;
  var fs = document.getElementById('fs').value==='true';
  fetch(BASE+'/api/sms/blast',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg,delaySeconds:delay,filterSent:fs})})
    .then(function(r){return r.json();})
    .then(function(d){ document.getElementById('sa').innerHTML='<div class="alert as">Campana iniciada: '+d.queued+' SMS. ~'+d.estimatedMinutes+' min</div>'; })
    .catch(function(err){ document.getElementById('sa').innerHTML='<div class="alert ae">Error: '+err.message+'</div>'; });
}

function sendTest() {
  var phone = document.getElementById('tp').value;
  var name = document.getElementById('tn').value || 'Amigo';
  var res = document.getElementById('tr');
  if(!phone) { alert('Ingresa un numero'); return; }
  res.innerHTML = '<div class="alert as" style="opacity:0.5">Enviando...</div>';
  fetch(BASE+'/api/contacts/load',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows:[{name:name,phone:phone}]})})
    .then(function(r){return r.json();})
    .then(function(){ return fetch(BASE+'/api/contacts').then(function(r){return r.json();}); })
    .then(function(cts){
      var ct = null;
      for(var i=0;i<cts.length;i++){ if(cts[i].phone===phone){ct=cts[i];break;} }
      if(!ct){ res.innerHTML='<div class="alert ae">Error: contacto no encontrado</div>'; return; }
      var msg = document.getElementById('msg').value || 'Hola {{nombre}}! SMS de prueba: {{link}}';
      return fetch(BASE+'/api/sms/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contactId:ct.id,message:msg})})
        .then(function(r){return r.json();})
        .then(function(d){
          if(d.ok){ res.innerHTML='<div class="alert as">SMS enviado! URL: '+d.trackUrl+'</div>'; }
          else { res.innerHTML='<div class="alert ae">Error: '+JSON.stringify(d.error)+'</div>'; }
        });
    })
    .catch(function(err){ res.innerHTML='<div class="alert ae">Error: '+err.message+'</div>'; });
}

function loadMetrics() {
  fetch(BASE+'/api/metrics')
    .then(function(r){return r.json();})
    .then(function(d){
      document.getElementById('sg').innerHTML=
        '<div class="stat"><div class="stat-label">CONTACTOS</div><div class="stat-val">'+d.total+'</div></div>'+
        '<div class="stat"><div class="stat-label">ENVIADOS</div><div class="stat-val green">'+d.sent+'</div></div>'+
        '<div class="stat"><div class="stat-label">CLICKS</div><div class="stat-val blue">'+d.clicked+' ('+d.clickRate+'%)</div></div>'+
        '<div class="stat"><div class="stat-label">STOP</div><div class="stat-val red">'+d.stopped+'</div></div>'+
        '<div class="stat"><div class="stat-label">FOLLOW-UP</div><div class="stat-val yellow">'+d.pendingFollowUp+'</div></div>';

      var ch = (d.recentClicks&&d.recentClicks.length) ?
        '<table><thead><tr><th>HORA</th><th>NOMBRE</th><th>TELEFONO</th></tr></thead><tbody>'+
        d.recentClicks.map(function(c){return '<tr><td>'+c.ts.slice(5)+'</td><td style="color:#00e5a0">'+c.name+'</td><td>'+c.phone+'</td></tr>';}).join('')+
        '</tbody></table>' : '<div style="color:#5a6070;padding:12px">Sin clicks aun...</div>';
      document.getElementById('ct').innerHTML=ch;

      var pending=(d.contacts||[]).filter(function(c){return c.smsSent&&!c.clicked&&!c.stopped;});
      document.getElementById('fu').innerHTML=pending.length ?
        pending.map(function(c){return '<div style="padding:10px;background:#f5a62310;border-radius:4px;border:1px solid #f5a62333;margin-bottom:8px"><strong>'+c.name+'</strong> - sin click desde '+(c.smsAt||'?')+'</div>';}).join('') :
        '<div style="color:#5a6070;padding:12px">Todos con seguimiento</div>';

      document.getElementById('ctb').innerHTML=(d.contacts||[]).map(function(c){
        return '<tr><td><strong>'+c.name+'</strong></td><td>'+c.phone+'</td>'+
          '<td>'+(c.smsSent?'<span class="badge bg">ENVIADO</span>':'<span class="badge by">PENDIENTE</span>')+'</td>'+
          '<td>'+(c.clicked?'<span class="badge bb">CLICK</span>':'—')+'</td>'+
          '<td>'+(c.stopped?'<span class="badge br">STOP</span>':'—')+'</td></tr>';
      }).join('');

      document.getElementById('ltb').innerHTML=(d.smsLog||[]).map(function(l){
        return '<tr><td>'+l.ts.slice(5)+'</td><td><strong>'+l.name+'</strong></td><td>'+l.phone+'</td>'+
          '<td>'+(l.status==='ENVIADO'?'<span class="badge bg">ENVIADO</span>':'<span class="badge br">FALLIDO</span>')+'</td></tr>';
      }).join('');
    })
    .catch(function(err){console.log('metrics error:',err);});
}

function checkGW() {
  fetch(BASE+'/api/metrics')
    .then(function(r){if(r.ok){document.getElementById('gws').textContent='GATEWAY ONLINE';}})
    .catch(function(){document.getElementById('gws').style.color='#ff4545';document.getElementById('gws').textContent='OFFLINE';});
}

checkGW();
setInterval(loadMetrics,15000);
`;

return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>SMS Marketing</title><style>'+css+'</style></head><body>'
+'<div class="header"><div><div class="logo">SMS MARKETING</div><div class="sub">CREDIPHONE - POWERED BY SMSGATE</div></div><div class="status" id="gws">CONECTANDO...</div></div>'
+'<div class="tabs">'
+'<button class="tab active" onclick="switchTab(\'envio\')">ENVIAR</button>'
+'<button class="tab" onclick="switchTab(\'metricas\')">METRICAS</button>'
+'<button class="tab" onclick="switchTab(\'contactos\')">CONTACTOS</button>'
+'<button class="tab" onclick="switchTab(\'logs\')">LOGS</button>'
+'</div>'
+'<div class="content">'
+'<div id="tab-envio" class="section active">'
+'<div class="card"><div class="label">1. CARGAR CONTACTOS (CSV)</div>'
+'<div id="dz" onclick="document.getElementById(\'csvf\').click()">Arrastra tu CSV aqui o toca para seleccionar<br><small>Formato: nombre,telefono</small></div>'
+'<input type="file" id="csvf" accept=".csv" style="display:none" onchange="loadCSV(this)">'
+'<div id="lr"></div></div>'
+'<div class="card"><div class="label">2. MENSAJE</div>'
+'<select id="tpl" onchange="applyTemplate()"><option value="">Seleccionar plantilla</option><option value="iphone">iPhone en cuotas</option><option value="oferta">Oferta especial</option><option value="seg">Seguimiento</option></select>'
+'<textarea id="msg" placeholder="Hola {{nombre}}, ver opciones: {{link}}" oninput="updateCnt()"></textarea>'
+'<div style="font-size:11px;color:#5a6070;text-align:right;margin-top:-8px;margin-bottom:8px"><span id="cnt">0</span>/160</div>'
+'<div style="font-size:11px;color:#5a6070">Variables: {{nombre}} {{link}}</div></div>'
+'<div class="card"><div class="label">3. CONFIGURAR ENVIO</div>'
+'<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
+'<div><div class="label">DELAY (segundos)</div><input type="number" id="delay" value="90" min="30" max="300"></div>'
+'<div><div class="label">FILTRO</div><select id="fs"><option value="true">Solo no enviados</option><option value="false">Todos</option></select></div>'
+'</div><div id="sa"></div>'
+'<button class="btn btn-primary" onclick="sendBlast()">INICIAR CAMPANA</button>'
+'</div>'
+'<div class="card"><div class="label">PRUEBA RAPIDA</div>'
+'<input type="text" id="tp" placeholder="+595981123456">'
+'<input type="text" id="tn" placeholder="Nombre de prueba">'
+'<button class="btn btn-secondary" onclick="sendTest()">Enviar SMS de prueba</button>'
+'<div id="tr" style="margin-top:12px"></div></div>'
+'</div>'
+'<div id="tab-metricas" class="section"><div class="stats" id="sg"></div>'
+'<div class="card"><div class="label">CLICKS EN TIEMPO REAL</div><div id="ct"></div></div>'
+'<div class="card"><div class="label">FOLLOW-UP</div><div id="fu"></div></div></div>'
+'<div id="tab-contactos" class="section"><div class="card">'
+'<table><thead><tr><th>NOMBRE</th><th>TELEFONO</th><th>SMS</th><th>CLICK</th><th>STOP</th></tr></thead><tbody id="ctb"></tbody></table>'
+'</div></div>'
+'<div id="tab-logs" class="section"><div class="card">'
+'<table><thead><tr><th>HORA</th><th>NOMBRE</th><th>TELEFONO</th><th>ESTADO</th></tr></thead><tbody id="ltb"></tbody></table>'
+'</div></div>'
+'</div>'
+'<script>'+js+'<\/script>'
+'</body></html>';
}
