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
    clicks.push({ ts: now(), linkId, name: contact.name, phone: contact.phone, ua: req.headers["user-agent"] || "unknown", ip: req.ip });
    console.log("CLICK: " + contact.name + " (" + contact.phone + ")");
  }
  const catalogUrl = process.env.CATALOG_URL || "https://wa.me/595981000000";
  res.redirect(302, catalogUrl);
});

app.post("/webhook/sms", (req, res) => {
  const { from, message } = req.body;
  const contact = Object.values(contacts).find(c => c.phone === from || c.phone === "+" + from);
  if (contact) {
    const msg = (message || "").toUpperCase().trim();
    if (msg === "STOP" || msg === "NO" || msg === "CANCELAR" || msg === "BAJA") {
      contact.stopped = true;
      contact.stoppedAt = now();
    } else {
      contact.replied = true;
      contact.repliedAt = now();
      contact.replyText = message;
    }
  }
  res.json({ ok: true });
});

app.post("/api/contacts/load", (req, res) => {
  const { rows } = req.body;
  if (!rows || !rows.length) return res.status(400).json({ error: "Sin contactos" });
  let added = 0;
  rows.forEach(function(row) {
    const name = row.name;
    const phone = row.phone;
    if (!phone) return;
    const cleanPhone = phone.trim().replace(/\s/g, "");
    const id = genId();
    contacts[id] = { id, name: name || "Cliente", phone: cleanPhone, linkId: genId(), clicked: false, clickedAt: null, stopped: false, replied: false, smsSent: false, smsAt: null };
    added++;
  });
  res.json({ ok: true, added, total: Object.keys(contacts).length });
});

app.post("/api/sms/send", async (req, res) => {
  const { contactId, message } = req.body;
  const contact = contacts[contactId];
  if (!contact) return res.status(404).json({ error: "Contacto no encontrado" });
  if (contact.stopped) return res.status(400).json({ error: "Contacto con STOP" });

  const trackUrl = BASE_URL + "/c/" + contact.linkId;
  const finalMsg = (message || "").replace("{{nombre}}", contact.name.split(" ")[0]).replace("{{link}}", trackUrl);

  try {
    const response = await fetch(SMS_API + "/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Basic " + Buffer.from(SMS_USER + ":" + SMS_PASS).toString("base64") },
      body: JSON.stringify({ message: finalMsg, phoneNumbers: [contact.phone] })
    });
    const data = await response.json();
    if (response.ok) {
      contact.smsSent = true;
      contact.smsAt = now();
      contact.msgId = data.id;
      smsLog.push({ ts: now(), name: contact.name, phone: contact.phone, msg: finalMsg, status: "ENVIADO" });
      res.json({ ok: true, msgId: data.id, trackUrl });
    } else {
      smsLog.push({ ts: now(), name: contact.name, phone: contact.phone, msg: finalMsg, status: "FALLIDO" });
      res.status(500).json({ error: data });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sms/blast", async (req, res) => {
  const { message, delaySeconds = 90, filterSent = true } = req.body;
  let targets = Object.values(contacts).filter(c => !c.stopped);
  if (filterSent) targets = targets.filter(c => !c.smsSent);
  res.json({ ok: true, queued: targets.length, estimatedMinutes: Math.ceil((targets.length * delaySeconds) / 60) });
  (async () => {
    for (const contact of targets) {
      const trackUrl = BASE_URL + "/c/" + contact.linkId;
      const finalMsg = (message || "").replace("{{nombre}}", contact.name.split(" ")[0]).replace("{{link}}", trackUrl);
      try {
        const response = await fetch(SMS_API + "/message", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Basic " + Buffer.from(SMS_USER + ":" + SMS_PASS).toString("base64") },
          body: JSON.stringify({ message: finalMsg, phoneNumbers: [contact.phone] })
        });
        const data = await response.json();
        if (response.ok) {
          contact.smsSent = true;
          contact.smsAt = now();
          smsLog.push({ ts: now(), name: contact.name, phone: contact.phone, msg: finalMsg, status: "ENVIADO" });
          console.log("SMS enviado a " + contact.name);
        } else {
          smsLog.push({ ts: now(), name: contact.name, phone: contact.phone, msg: finalMsg, status: "FALLIDO" });
        }
      } catch (err) {
        console.log("Error " + contact.name + ": " + err.message);
      }
      await new Promise(r => setTimeout(r, delaySeconds * 1000));
    }
    console.log("Blast completado");
  })();
});

app.get("/api/metrics", (req, res) => {
  const all     = Object.values(contacts);
  const sent    = all.filter(c => c.smsSent);
  const clicked = all.filter(c => c.clicked);
  const stopped = all.filter(c => c.stopped);
  const replied = all.filter(c => c.replied);
  const pending = sent.filter(c => !c.clicked && !c.stopped);
  res.json({ total: all.length, sent: sent.length, clicked: clicked.length, clickRate: sent.length ? ((clicked.length / sent.length) * 100).toFixed(1) : 0, stopped: stopped.length, replied: replied.length, pendingFollowUp: pending.length, recentClicks: clicks.slice(-10).reverse(), smsLog: smsLog.slice(-20).reverse(), contacts: all });
});

app.get("/api/contacts", (req, res) => {
  res.json(Object.values(contacts));
});

app.get("/", (req, res) => {
  res.send(getHTML());
});

app.get("/health", (req, res) => res.json({ ok: true, contacts: Object.keys(contacts).length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SMS Tracker corriendo en puerto " + PORT));

function getHTML() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SMS Marketing — iPhone Paraguay</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0b0d;color:#e8eaf0;font-family:'IBM Plex Mono',monospace;min-height:100vh}
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
  textarea{resize:vertical;min-height:100px}
  .btn{padding:10px 20px;border-radius:4px;border:none;cursor:pointer;font-family:inherit;font-weight:700;font-size:12px;letter-spacing:1px}
  .btn-primary{background:#00e5a0;color:#000}
  .btn-secondary{background:#22272f;color:#e8eaf0}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}
  .stat{background:#16191f;border:1px solid #22272f;border-radius:6px;padding:16px}
  .stat-val{font-size:28px;font-weight:800;font-family:monospace}
  .stat-label{font-size:10px;color:#5a6070;letter-spacing:1px;margin-bottom:6px}
  .green{color:#00e5a0}.yellow{color:#f5a623}.red{color:#ff4545}.blue{color:#4da6ff}
  table{width:100%;border-collapse:collapse}
  th{padding:10px 14px;text-align:left;font-size:10px;color:#5a6070;letter-spacing:1px;border-bottom:1px solid #22272f}
  td{padding:10px 14px;font-size:12px;border-bottom:1px solid #22272f11}
  .badge{font-size:10px;padding:2px 8px;border-radius:2px;font-weight:700}
  .badge-green{background:#00e5a022;color:#00e5a0;border:1px solid #00e5a044}
  .badge-yellow{background:#f5a62322;color:#f5a623;border:1px solid #f5a62344}
  .badge-red{background:#ff454522;color:#ff4545;border:1px solid #ff454544}
  .badge-blue{background:#4da6ff22;color:#4da6ff;border:1px solid #4da6ff44}
  #dropzone{border:2px dashed #22272f;border-radius:6px;padding:40px;text-align:center;cursor:pointer;color:#5a6070;margin-bottom:12px;transition:all .2s}
  #dropzone:hover,#dropzone.over{border-color:#00e5a0;color:#00e5a0}
  .msg-counter{font-size:11px;color:#5a6070;text-align:right;margin-top:-8px;margin-bottom:12px}
  .alert{padding:12px 16px;border-radius:4px;margin-bottom:12px;font-size:13px}
  .alert-success{background:#00e5a022;color:#00e5a0;border:1px solid #00e5a044}
  .alert-error{background:#ff454522;color:#ff4545;border:1px solid #ff454544}
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="logo">📱 SMS MARKETING</div>
    <div class="sub">IPHONE PARAGUAY · POWERED BY SMSGATE</div>
  </div>
  <div class="status" id="gatewayStatus">● CONECTANDO...</div>
</div>
<div class="tabs">
  <button class="tab active" onclick="switchTab(event,'envio')">✉ ENVIAR</button>
  <button class="tab" onclick="switchTab(event,'metricas')">📊 METRICAS</button>
  <button class="tab" onclick="switchTab(event,'contactos')">👥 CONTACTOS</button>
  <button class="tab" onclick="switchTab(event,'logs')">📋 LOGS</button>
</div>
<div class="content">
  <div id="tab-envio" class="section active">
    <div class="card">
      <div class="label">1. CARGAR CONTACTOS (CSV)</div>
      <div id="dropzone" onclick="document.getElementById('csvFile').click()">
        📂 Arrastra tu CSV aqui o toca para seleccionar<br>
        <small style="font-size:11px;margin-top:8px;display:block">Formato: nombre,telefono (con +595...)</small>
      </div>
      <input type="file" id="csvFile" accept=".csv" style="display:none" onchange="loadCSV(this)">
      <div id="loadResult"></div>
    </div>
    <div class="card">
      <div class="label">2. MENSAJE</div>
      <select id="templateSelect" onchange="applyTemplate()">
        <option value="">— Seleccionar plantilla —</option>
        <option value="iphone">📱 iPhone en cuotas</option>
        <option value="oferta">🔥 Oferta especial</option>
        <option value="seguimiento">🔄 Seguimiento</option>
      </select>
      <div class="label">TEXTO DEL SMS</div>
      <textarea id="smsMsg" placeholder="Hola {{nombre}}, tenes iPhones en cuotas. Mira las opciones: {{link}}" oninput="updateCounter()"></textarea>
      <div class="msg-counter"><span id="charCount">0</span>/160 chars</div>
      <div style="font-size:11px;color:#5a6070;margin-bottom:12px">Variables: <code style="color:#00e5a0">{{nombre}}</code> <code style="color:#00e5a0">{{link}}</code></div>
    </div>
    <div class="card">
      <div class="label">3. CONFIGURAR ENVIO</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div><div class="label">DELAY ENTRE SMS (segundos)</div><input type="number" id="delaySeconds" value="90" min="30" max="300"></div>
        <div><div class="label">FILTRO</div><select id="filterSent"><option value="true">Solo no enviados</option><option value="false">Todos</option></select></div>
      </div>
      <div id="sendAlert"></div>
      <button class="btn btn-primary" onclick="sendBlast()">🚀 INICIAR CAMPAÑA</button>
      <span style="font-size:11px;color:#5a6070;margin-left:12px" id="estimado"></span>
    </div>
    <div class="card">
      <div class="label">PRUEBA RAPIDA — ENVIAR A UN NUMERO</div>
      <input type="text" id="testPhone" placeholder="+595981123456">
      <input type="text" id="testName" placeholder="Nombre de prueba">
      <button class="btn btn-secondary" onclick="sendTest()">Enviar SMS de prueba</button>
      <div id="testResult" style="margin-top:12px"></div>
    </div>
  </div>
  <div id="tab-metricas" class="section">
    <div class="stats" id="statsGrid"></div>
    <div class="card"><div class="label">CLICKS EN TIEMPO REAL</div><div id="clicksTable"></div></div>
    <div class="card"><div class="label">FOLLOW-UP RECOMENDADO</div><div id="followUp"></div></div>
  </div>
  <div id="tab-contactos" class="section">
    <div class="card">
      <table><thead><tr><th>NOMBRE</th><th>TELEFONO</th><th>SMS</th><th>CLICK</th><th>STOP</th></tr></thead>
      <tbody id="contactsTable"></tbody></table>
    </div>
  </div>
  <div id="tab-logs" class="section">
    <div class="card">
      <table><thead><tr><th>HORA</th><th>NOMBRE</th><th>TELEFONO</th><th>ESTADO</th></tr></thead>
      <tbody id="logsTable"></tbody></table>
    </div>
  </div>
</div>
<script>
var BASE = window.location.origin;
var metrics = {};
var TEMPLATES = {
  iphone: "Hola {{nombre}}! Tenemos iPhones originales en cuotas. Sin tarjeta. Mira modelos: {{link}}",
  oferta: "{{nombre}}, oferta especial 48hs! iPhone con garantia y cuotas fijas. Ver catalogo: {{link}}",
  seguimiento: "Hola {{nombre}}, pudiste ver las opciones de iPhone? Link nuevamente: {{link}} Cualquier consulta respondeme."
};

function switchTab(e, tab) {
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
  document.querySelectorAll('.section').forEach(function(s){ s.classList.remove('active'); });
  e.target.classList.add('active');
  document.getElementById('tab-'+tab).classList.add('active');
  if (tab === 'metricas' || tab === 'contactos' || tab === 'logs') loadMetrics();
}

function applyTemplate() {
  var val = document.getElementById('templateSelect').value;
  if (TEMPLATES[val]) { document.getElementById('smsMsg').value = TEMPLATES[val]; updateCounter(); }
}

function updateCounter() {
  var len = document.getElementById('smsMsg').value.length;
  var el = document.getElementById('charCount');
  el.textContent = len;
  el.style.color = len > 160 ? '#f5a623' : '#5a6070';
}

var dz = document.getElementById('dropzone');
dz.addEventListener('dragover', function(e){ e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', function(){ dz.classList.remove('over'); });
dz.addEventListener('drop', function(e){ e.preventDefault(); dz.classList.remove('over'); if(e.dataTransfer.files[0]) processCSV(e.dataTransfer.files[0]); });

function loadCSV(input) { if (input.files[0]) processCSV(input.files[0]); }

function processCSV(file) {
  var reader = new FileReader();
  reader.onload = function(e) {
    var lines = e.target.result.split('\n').filter(function(l){ return l.trim(); });
    var rows = [];
    lines.forEach(function(line, i) {
      if (i === 0 && line.toLowerCase().includes('nombre')) return;
      var parts = line.split(',');
      if (parts.length >= 2) rows.push({ name: parts[0].trim(), phone: parts[1].trim() });
    });
    fetch(BASE+'/api/contacts/load', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ rows: rows }) })
      .then(function(r){ return r.json(); })
      .then(function(data){ document.getElementById('loadResult').innerHTML = '<div class="alert alert-success">✅ '+data.added+' contactos cargados. Total: '+data.total+'</div>'; })
      .catch(function(err){ document.getElementById('loadResult').innerHTML = '<div class="alert alert-error">❌ Error: '+err.message+'</div>'; });
  };
  reader.readAsText(file);
}

function sendBlast() {
  var msg = document.getElementById('smsMsg').value;
  if (!msg) return alert('Escribi el mensaje primero');
  var delay = parseInt(document.getElementById('delaySeconds').value) || 90;
  var filterSent = document.getElementById('filterSent').value === 'true';
  fetch(BASE+'/api/sms/blast', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ message: msg, delaySeconds: delay, filterSent: filterSent }) })
    .then(function(r){ return r.json(); })
    .then(function(data){ document.getElementById('sendAlert').innerHTML = '<div class="alert alert-success">🚀 Campaña iniciada: '+data.queued+' SMS en cola. ~'+data.estimatedMinutes+' min</div>'; })
    .catch(function(err){ document.getElementById('sendAlert').innerHTML = '<div class="alert alert-error">❌ '+err.message+'</div>'; });
}

function sendTest() {
  var phone = document.getElementById('testPhone').value;
  var name = document.getElementById('testName').value || 'Amigo';
  var resultEl = document.getElementById('testResult');
  if (!phone) return alert('Ingresa un numero');
  resultEl.innerHTML = '<div class="alert alert-success" style="opacity:0.6">Enviando...</div>';
  fetch(BASE+'/api/contacts/load', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ rows: [{ name: name, phone: phone }] }) })
    .then(function(r){ return r.json(); })
    .then(function() { return fetch(BASE+'/api/contacts').then(function(r){ return r.json(); }); })
    .then(function(contacts) {
      var contact = contacts.find(function(c){ return c.phone === phone; });
      if (!contact) { resultEl.innerHTML = '<div class="alert alert-error">❌ Error cargando contacto</div>'; return; }
      var msg = document.getElementById('smsMsg').value || 'Hola {{nombre}}! Este es un SMS de prueba: {{link}}';
      return fetch(BASE+'/api/sms/send', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ contactId: contact.id, message: msg }) })
        .then(function(r){ return r.json(); })
        .then(function(data) {
          if (data.ok) {
            resultEl.innerHTML = '<div class="alert alert-success">✅ SMS enviado! Track URL: '+data.trackUrl+'</div>';
          } else {
            resultEl.innerHTML = '<div class="alert alert-error">❌ Error: '+JSON.stringify(data.error)+'</div>';
          }
        });
    })
    .catch(function(err){ resultEl.innerHTML = '<div class="alert alert-error">❌ '+err.message+'</div>'; });
}

function loadMetrics() {
  fetch(BASE+'/api/metrics')
    .then(function(r){ return r.json(); })
    .then(function(data) {
      metrics = data;
      document.getElementById('statsGrid').innerHTML =
        '<div class="stat"><div class="stat-label">CONTACTOS</div><div class="stat-val">'+data.total+'</div></div>'+
        '<div class="stat"><div class="stat-label">SMS ENVIADOS</div><div class="stat-val green">'+data.sent+'</div></div>'+
        '<div class="stat"><div class="stat-label">CLICKS</div><div class="stat-val blue">'+data.clicked+' <span style="font-size:14px;color:#5a6070">('+data.clickRate+'%)</span></div></div>'+
        '<div class="stat"><div class="stat-label">STOP</div><div class="stat-val red">'+data.stopped+'</div></div>'+
        '<div class="stat"><div class="stat-label">FOLLOW-UP</div><div class="stat-val yellow">'+data.pendingFollowUp+'</div></div>';

      var clicksHtml = (data.recentClicks && data.recentClicks.length) ?
        '<table><thead><tr><th>HORA</th><th>NOMBRE</th><th>TELEFONO</th></tr></thead><tbody>'+
        data.recentClicks.map(function(c){ return '<tr><td style="color:#5a6070">'+c.ts.slice(5)+'</td><td style="color:#00e5a0;font-weight:600">'+c.name+'</td><td style="color:#5a6070">'+c.phone+'</td></tr>'; }).join('')+
        '</tbody></table>' : '<div style="color:#5a6070;padding:12px">Sin clicks aun...</div>';
      document.getElementById('clicksTable').innerHTML = clicksHtml;

      var pending = (data.contacts || []).filter(function(c){ return c.smsSent && !c.clicked && !c.stopped; });
      document.getElementById('followUp').innerHTML = pending.length ?
        pending.map(function(c){ return '<div style="display:flex;align-items:center;gap:12px;padding:10px;background:#f5a62310;border-radius:4px;border:1px solid #f5a62333;margin-bottom:8px"><span>⏰</span><div style="flex:1"><div style="font-size:13px;font-weight:600">'+c.name+'</div><div style="font-size:11px;color:#5a6070">Sin click desde '+(c.smsAt||'—')+'</div></div><span style="font-size:10px;padding:2px 8px;background:#f5a62322;color:#f5a623;border-radius:2px">SIN RESPUESTA</span></div>'; }).join('') :
        '<div style="color:#5a6070;padding:12px">✓ Todos con seguimiento</div>';

      document.getElementById('contactsTable').innerHTML = (data.contacts || []).map(function(c){ return '<tr><td style="font-weight:600">'+c.name+'</td><td style="color:#5a6070">'+c.phone+'</td><td>'+(c.smsSent?'<span class="badge badge-green">ENVIADO</span>':'<span class="badge badge-yellow">PENDIENTE</span>')+'</td><td>'+(c.clicked?'<span class="badge badge-blue">✓ CLICK</span>':'—')+'</td><td>'+(c.stopped?'<span class="badge badge-red">STOP</span>':'—')+'</td></tr>'; }).join('');

      document.getElementById('logsTable').innerHTML = (data.smsLog || []).map(function(l){ return '<tr><td style="color:#5a6070">'+l.ts.slice(5)+'</td><td style="font-weight:600">'+l.name+'</td><td style="color:#5a6070">'+l.phone+'</td><td>'+(l.status==='ENVIADO'?'<span class="badge badge-green">ENVIADO</span>':'<span class="badge badge-red">FALLIDO</span>')+'</td></tr>'; }).join('');
    })
    .catch(function(err){ console.log('Error metrics:', err); });
}

function checkGateway() {
  fetch(BASE+'/api/metrics')
    .then(function(r){ if(r.ok){ document.getElementById('gatewayStatus').textContent = '● GATEWAY ONLINE'; } })
    .catch(function(){ document.getElementById('gatewayStatus').style.color='#ff4545'; document.getElementById('gatewayStatus').textContent='● OFFLINE'; });
}

checkGateway();
setInterval(loadMetrics, 15000);
</script>
</body>
</html>`;
}
