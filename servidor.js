const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// ── Config desde variables de entorno ─────────────────────────────────────────
const SMS_USER = process.env.SMS_USER || "CLXHSQ";
const SMS_PASS = process.env.SMS_PASS || "g6qz0njve0masq";
const SMS_API  = "https://api.sms-gate.app/3rdparty/v1";
const BASE_URL = process.env.BASE_URL || "https://tu-app.onrender.com";

// ── Base de datos en memoria ──────────────────────────────────────────────────
const contacts = {};
const clicks   = [];
const smsLog   = [];

// ── Estado del blast en tiempo real ──────────────────────────────────────────
let blastState = {
  running: false,
  total: 0,
  sent: 0,
  current: null,
  failed: 0,
  startedAt: null,
  finishedAt: null,
  nextIn: 0,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function genId() { return crypto.randomBytes(4).toString("hex").toUpperCase(); }
function now()   { return new Date().toISOString().replace("T"," ").slice(0,16); }

// ── RUTAS DE TRACKING ─────────────────────────────────────────────────────────
app.get("/c/:linkId", (req, res) => {
  const { linkId } = req.params;
  const contact = Object.values(contacts).find(c => c.linkId === linkId);
  if (contact) {
    contact.clicked    = true;
    contact.clickedAt  = now();
    contact.clickCount = (contact.clickCount || 0) + 1;
    clicks.push({ ts: now(), linkId, name: contact.name, phone: contact.phone, ua: req.headers["user-agent"] || "unknown", ip: req.ip });
    console.log(`✅ CLICK: ${contact.name} (${contact.phone})`);
  }
  const catalogUrl = process.env.CATALOG_URL || "https://wa.me/595981000000";
  res.redirect(302, catalogUrl);
});

app.post("/webhook/sms", (req, res) => {
  const { from, message } = req.body;
  const contact = Object.values(contacts).find(c => c.phone === from || c.phone === `+${from}`);
  if (contact) {
    const msg = (message || "").toUpperCase().trim();
    if (["STOP","NO","CANCELAR","BAJA"].includes(msg)) {
      contact.stopped = true; contact.stoppedAt = now();
    } else {
      contact.replied = true; contact.repliedAt = now(); contact.replyText = message;
    }
  }
  res.json({ ok: true });
});

// ── RUTAS DE CONTACTOS ────────────────────────────────────────────────────────
app.post("/api/contacts/load", (req, res) => {
  const { rows } = req.body;
  if (!rows || !rows.length) return res.status(400).json({ error: "Sin contactos" });
  let added = 0;
  rows.forEach(({ name, phone }) => {
    if (!phone) return;
    const cleanPhone = phone.trim().replace(/\s/g, "");
    const id = genId();
    contacts[id] = { id, name: name || "Cliente", phone: cleanPhone, linkId: genId(), clicked: false, clickedAt: null, stopped: false, replied: false, smsSent: false, smsAt: null };
    added++;
  });
  res.json({ ok: true, added, total: Object.keys(contacts).length });
});

app.delete("/api/contacts/clear", (req, res) => {
  Object.keys(contacts).forEach(k => delete contacts[k]);
  blastState = { running: false, total: 0, sent: 0, current: null, failed: 0, startedAt: null, finishedAt: null, nextIn: 0 };
  res.json({ ok: true });
});

app.get("/api/contacts", (req, res) => res.json(Object.values(contacts)));

// ── RUTAS DE ENVÍO ────────────────────────────────────────────────────────────
app.post("/api/sms/send", async (req, res) => {
  const { contactId, message } = req.body;
  const contact = contacts[contactId];
  if (!contact) return res.status(404).json({ error: "Contacto no encontrado" });
  if (contact.stopped) return res.status(400).json({ error: "Contacto con STOP" });

  const trackUrl = `${BASE_URL}/c/${contact.linkId}`;
  const finalMsg = (message || "").replace("{{nombre}}", contact.name.split(" ")[0]).replace("{{link}}", trackUrl);

  try {
    const response = await fetch(`${SMS_API}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Basic " + Buffer.from(`${SMS_USER}:${SMS_PASS}`).toString("base64") },
      body: JSON.stringify({ message: finalMsg, phoneNumbers: [contact.phone] }),
    });
    const data = await response.json();
    if (response.ok) {
      contact.smsSent = true; contact.smsAt = now(); contact.msgId = data.id;
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
  if (blastState.running) return res.status(400).json({ error: "Ya hay un blast en curso" });

  const { message, delaySeconds = 90, filterSent = true } = req.body;
  let targets = Object.values(contacts).filter(c => !c.stopped);
  if (filterSent) targets = targets.filter(c => !c.smsSent);

  if (!targets.length) return res.status(400).json({ error: "Sin contactos para enviar" });

  blastState = { running: true, total: targets.length, sent: 0, current: null, failed: 0, startedAt: now(), finishedAt: null, nextIn: 0 };
  res.json({ ok: true, queued: targets.length, estimatedMinutes: Math.ceil((targets.length * delaySeconds) / 60) });

  (async () => {
    for (let i = 0; i < targets.length; i++) {
      const contact = targets[i];
      blastState.current = contact.name;
      blastState.nextIn = delaySeconds;

      const trackUrl = `${BASE_URL}/c/${contact.linkId}`;
      const finalMsg = (message || "").replace("{{nombre}}", contact.name.split(" ")[0]).replace("{{link}}", trackUrl);

      try {
        const response = await fetch(`${SMS_API}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Basic " + Buffer.from(`${SMS_USER}:${SMS_PASS}`).toString("base64") },
          body: JSON.stringify({ message: finalMsg, phoneNumbers: [contact.phone] }),
        });
        const data = await response.json();
        if (response.ok) {
          contact.smsSent = true; contact.smsAt = now();
          smsLog.push({ ts: now(), name: contact.name, phone: contact.phone, msg: finalMsg, status: "ENVIADO" });
          blastState.sent++;
          console.log(`✅ [${blastState.sent}/${blastState.total}] ${contact.name}`);
        } else {
          blastState.failed++;
          smsLog.push({ ts: now(), name: contact.name, phone: contact.phone, msg: finalMsg, status: "FALLIDO" });
        }
      } catch (err) {
        blastState.failed++;
        console.log(`❌ Error ${contact.name}:`, err.message);
      }

      if (i < targets.length - 1) {
        // Countdown del delay
        for (let t = delaySeconds; t > 0; t--) {
          blastState.nextIn = t;
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
    blastState.running = false;
    blastState.current = null;
    blastState.finishedAt = now();
    console.log("🎉 Blast completado");
  })();
});

app.get("/api/blast/status", (req, res) => res.json(blastState));

// ── RUTAS DE MÉTRICAS ─────────────────────────────────────────────────────────
app.get("/api/metrics", (req, res) => {
  const all     = Object.values(contacts);
  const sent    = all.filter(c => c.smsSent);
  const clicked = all.filter(c => c.clicked);
  const stopped = all.filter(c => c.stopped);
  const replied = all.filter(c => c.replied);
  const pending = sent.filter(c => !c.clicked && !c.stopped);
  res.json({
    total: all.length, sent: sent.length, clicked: clicked.length,
    clickRate: sent.length ? ((clicked.length / sent.length) * 100).toFixed(1) : 0,
    stopped: stopped.length, replied: replied.length, pendingFollowUp: pending.length,
    recentClicks: clicks.slice(-10).reverse(),
    smsLog: smsLog.slice(-20).reverse(),
    contacts: all,
  });
});

// ── PANEL HTML ────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
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
  textarea{resize:vertical;min-height:120px}
  input:focus,textarea:focus{outline:none;border-color:#00e5a055}
  .btn{padding:10px 20px;border-radius:4px;border:none;cursor:pointer;font-family:inherit;font-weight:700;font-size:12px;letter-spacing:1px;transition:opacity .2s}
  .btn:hover{opacity:.85}
  .btn-primary{background:#00e5a0;color:#000}
  .btn-secondary{background:#22272f;color:#e8eaf0}
  .btn-danger{background:#ff454522;color:#ff4545;border:1px solid #ff454544}
  .btn-sm{padding:5px 12px;font-size:11px}
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
  #dropzone{border:2px dashed #22272f;border-radius:6px;padding:32px;text-align:center;cursor:pointer;color:#5a6070;margin-bottom:12px;transition:all .2s}
  #dropzone:hover,#dropzone.active{border-color:#00e5a0;color:#00e5a0}
  .msg-counter{font-size:11px;color:#5a6070;text-align:right;margin-top:-8px;margin-bottom:12px}
  .alert{padding:12px 16px;border-radius:4px;margin-bottom:12px;font-size:13px}
  .alert-success{background:#00e5a022;color:#00e5a0;border:1px solid #00e5a044}
  .alert-error{background:#ff454522;color:#ff4545;border:1px solid #ff454544}
  .alert-info{background:#4da6ff22;color:#4da6ff;border:1px solid #4da6ff44}

  /* Vista previa contactos */
  .contacts-preview{background:#0a0b0d;border:1px solid #22272f;border-radius:4px;padding:12px;max-height:180px;overflow-y:auto;font-size:11px;color:#5a6070;margin-bottom:12px;font-family:'IBM Plex Mono',monospace;line-height:1.8}
  .contacts-preview .c-row{display:flex;gap:12px}
  .contacts-preview .c-name{color:#e8eaf0;min-width:140px}
  .contacts-preview .c-phone{color:#00e5a0}
  .preview-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .preview-count{font-size:11px;color:#00e5a0;font-weight:700}

  /* Templates rápidos */
  .quick-templates{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .tpl-btn{padding:5px 12px;border-radius:3px;border:1px solid #22272f;background:transparent;color:#5a6070;font-family:inherit;font-size:11px;cursor:pointer;transition:all .2s}
  .tpl-btn:hover{border-color:#00e5a055;color:#00e5a0}

  /* Progreso del blast */
  #blastProgress{display:none}
  #blastProgress.visible{display:block}
  .progress-card{background:#111318;border:1px solid #00e5a033;border-radius:6px;padding:16px;margin-bottom:16px}
  .progress-title{font-size:11px;color:#00e5a0;letter-spacing:1px;margin-bottom:12px;font-weight:700}
  .progress-bar-wrap{background:#22272f;border-radius:3px;height:8px;margin-bottom:12px;overflow:hidden}
  .progress-bar-fill{height:100%;background:linear-gradient(90deg,#00e5a0,#00b87a);border-radius:3px;transition:width .5s ease}
  .progress-info{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;font-size:11px}
  .p-item .p-label{color:#5a6070;margin-bottom:3px}
  .p-item .p-val{color:#e8eaf0;font-weight:700;font-size:13px}
  .p-item .p-val.green{color:#00e5a0}
  .p-item .p-val.yellow{color:#f5a623}
  .countdown{font-size:11px;color:#5a6070;margin-top:10px;text-align:center;padding:8px;background:#22272f22;border-radius:3px}
  .current-sending{color:#f5a623;font-weight:700}
  .blast-done{background:#00e5a022;border:1px solid #00e5a044;border-radius:4px;padding:12px;text-align:center;color:#00e5a0;font-weight:700;font-size:13px}
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="logo">📱 SMS MARKETING</div>
    <div class="sub">CREDIPHONE · POWERED BY SMSGATE</div>
  </div>
  <div class="status" id="gatewayStatus">● CONECTANDO...</div>
</div>

<div class="tabs">
  <button class="tab active" onclick="switchTab('envio',this)">✉ ENVIAR</button>
  <button class="tab" onclick="switchTab('metricas',this)">📊 MÉTRICAS</button>
  <button class="tab" onclick="switchTab('contactos',this)">👥 CONTACTOS</button>
  <button class="tab" onclick="switchTab('logs',this)">📋 LOGS</button>
</div>

<div class="content">

  <!-- ENVÍO -->
  <div id="tab-envio" class="section active">

    <!-- 1. Cargar contactos -->
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="label" style="margin:0">1. CARGAR CONTACTOS (CSV)</div>
        <button class="btn btn-danger btn-sm" onclick="clearContacts()">🗑 Limpiar lista</button>
      </div>
      <div id="dropzone" onclick="document.getElementById('csvFile').click()">
        📂 Arrastrá tu CSV aquí o tocá para seleccionar<br>
        <small style="font-size:11px;margin-top:8px;display:block">Formato: nombre,telefono (con +595...)</small>
      </div>
      <input type="file" id="csvFile" accept=".csv" style="display:none" onchange="loadCSV(this)">
      <div id="loadResult"></div>

      <!-- Vista previa de contactos cargados -->
      <div id="contactsPreview" style="display:none">
        <div class="preview-header">
          <div class="label" style="margin:0">CONTACTOS CARGADOS</div>
          <div class="preview-count" id="previewCount"></div>
        </div>
        <div class="contacts-preview" id="previewList"></div>
      </div>
    </div>

    <!-- 2. Mensaje -->
    <div class="card">
      <div class="label">2. ESCRIBÍ TU MENSAJE</div>
      <div class="quick-templates">
        <span style="font-size:10px;color:#5a6070;align-self:center;margin-right:4px">PLANTILLAS RÁPIDAS:</span>
        <button class="tpl-btn" onclick="setTemplate('iphone')">📱 iPhone cuotas</button>
        <button class="tpl-btn" onclick="setTemplate('oferta')">🔥 Oferta especial</button>
        <button class="tpl-btn" onclick="setTemplate('seguimiento')">🔄 Seguimiento</button>
        <button class="tpl-btn" onclick="setTemplate('clear')">✕ Limpiar</button>
      </div>
      <textarea id="smsMsg" placeholder="Escribí tu mensaje acá... Podés usar {{nombre}} y {{link}}" oninput="updateCounter()"></textarea>
      <div class="msg-counter"><span id="charCount" style="color:#5a6070">0</span>/160 chars · <span style="color:#5a6070" id="smsCount">1 SMS</span></div>
      <div style="font-size:11px;color:#5a6070">
        Variables: <code style="color:#00e5a0">{{nombre}}</code> se reemplaza con el nombre · <code style="color:#00e5a0">{{link}}</code> con el link de tracking
      </div>
    </div>

    <!-- 3. Configurar y enviar -->
    <div class="card">
      <div class="label">3. CONFIGURAR ENVÍO</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <div class="label">DELAY ENTRE SMS (seg)</div>
          <input type="number" id="delaySeconds" value="90" min="30" max="300">
        </div>
        <div>
          <div class="label">FILTRO</div>
          <select id="filterSent">
            <option value="true">Solo no enviados</option>
            <option value="false">Todos</option>
          </select>
        </div>
      </div>
      <div id="sendAlert"></div>
      <div style="display:flex;align-items:center;gap:16px">
        <button class="btn btn-primary" onclick="sendBlast()" id="btnSend">🚀 INICIAR CAMPAÑA</button>
        <span style="font-size:11px;color:#5a6070" id="estimado"></span>
      </div>
    </div>

    <!-- Progreso del blast -->
    <div id="blastProgress">
      <div class="progress-card">
        <div class="progress-title">⚡ CAMPAÑA EN CURSO</div>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" id="progressFill" style="width:0%"></div>
        </div>
        <div class="progress-info">
          <div class="p-item">
            <div class="p-label">ENVIADOS</div>
            <div class="p-val green" id="pSent">0</div>
          </div>
          <div class="p-item">
            <div class="p-label">TOTAL</div>
            <div class="p-val" id="pTotal">0</div>
          </div>
          <div class="p-item">
            <div class="p-label">FALLIDOS</div>
            <div class="p-val red" id="pFailed">0</div>
          </div>
        </div>
        <div class="countdown" id="pCountdown"></div>
      </div>
    </div>

    <!-- Prueba rápida -->
    <div class="card">
      <div class="label">PRUEBA RÁPIDA — ENVIAR A UN NÚMERO</div>
      <input type="text" id="testPhone" placeholder="+595981123456">
      <input type="text" id="testName" placeholder="Nombre de prueba">
      <button class="btn btn-secondary" onclick="sendTest()">Enviar SMS de prueba</button>
      <div id="testResult" style="margin-top:8px"></div>
    </div>
  </div>

  <!-- MÉTRICAS -->
  <div id="tab-metricas" class="section">
    <div class="stats" id="statsGrid"></div>
    <div class="card">
      <div class="label">CLICKS EN TIEMPO REAL</div>
      <div id="clicksTable"></div>
    </div>
    <div class="card">
      <div class="label">FOLLOW-UP RECOMENDADO</div>
      <div id="followUp"></div>
    </div>
  </div>

  <!-- CONTACTOS -->
  <div id="tab-contactos" class="section">
    <div class="card">
      <table>
        <thead><tr>
          <th>NOMBRE</th><th>TELÉFONO</th><th>SMS</th><th>CLICK</th><th>STOP</th>
        </tr></thead>
        <tbody id="contactsTable"></tbody>
      </table>
    </div>
  </div>

  <!-- LOGS -->
  <div id="tab-logs" class="section">
    <div class="card">
      <table>
        <thead><tr><th>HORA</th><th>NOMBRE</th><th>TELÉFONO</th><th>ESTADO</th></tr></thead>
        <tbody id="logsTable"></tbody>
      </table>
    </div>
  </div>

</div>

<script>
const BASE = window.location.origin;
let blastPolling = null;
let loadedContacts = [];

const TEMPLATES = {
  iphone: "Hola {{nombre}}! 🍎 Tenemos iPhones originales en cuotas desde $150.000 Gs/mes. Sin tarjeta. Mirá modelos: {{link}}",
  oferta: "{{nombre}}, oferta especial 48hs 🔥 iPhone con garantía y cuotas fijas. Ver catálogo: {{link}}",
  seguimiento: "Hola {{nombre}}, ¿pudiste ver las opciones de iPhone? Link nuevamente: {{link}} Cualquier consulta respondé este mensaje.",
};

function switchTab(tab, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('tab-'+tab).classList.add('active');
  if (['metricas','contactos','logs'].includes(tab)) loadMetrics();
}

function setTemplate(key) {
  if (key === 'clear') { document.getElementById('smsMsg').value = ''; }
  else if (TEMPLATES[key]) { document.getElementById('smsMsg').value = TEMPLATES[key]; }
  updateCounter();
}

function updateCounter() {
  const len = document.getElementById('smsMsg').value.length;
  const el = document.getElementById('charCount');
  el.textContent = len;
  el.style.color = len > 160 ? '#f5a623' : len > 130 ? '#f5a62388' : '#5a6070';
  document.getElementById('smsCount').textContent = len <= 160 ? '1 SMS' : Math.ceil(len/153)+' SMS';
}

// Drag & drop
const dropzone = document.getElementById('dropzone');
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('active'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('active'));
dropzone.addEventListener('drop', e => { e.preventDefault(); dropzone.classList.remove('active'); if(e.dataTransfer.files[0]) processCSV(e.dataTransfer.files[0]); });
function loadCSV(input) { if (input.files[0]) processCSV(input.files[0]); }

function processCSV(file) {
  const reader = new FileReader();
  reader.onload = async e => {
    const lines = e.target.result.split('\n').filter(l => l.trim());
    const rows = [];
    lines.forEach((line, i) => {
      if (i === 0 && line.toLowerCase().includes('nombre')) return;
      const parts = line.split(',');
      if (parts.length >= 2) {
        const phone = parts[1].trim();
        // Validar que sea un número real (no texto como "Capacidad")
        if (phone && /^[+0-9]/.test(phone) && phone.length > 6) {
          rows.push({ name: parts[0].trim(), phone });
        }
      }
    });

    const res = await fetch(BASE+'/api/contacts/load', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ rows })
    });
    const data = await res.json();
    loadedContacts = rows;

    document.getElementById('loadResult').innerHTML =
      \`<div class="alert alert-success">✅ \${data.added} contactos cargados. Total en lista: \${data.total}</div>\`;

    // Mostrar vista previa
    showContactsPreview(rows);
  };
  reader.readAsText(file);
}

function showContactsPreview(rows) {
  if (!rows.length) return;
  const preview = document.getElementById('contactsPreview');
  const list = document.getElementById('previewList');
  const count = document.getElementById('previewCount');
  preview.style.display = 'block';
  count.textContent = rows.length + ' contactos';
  list.innerHTML = rows.map(r =>
    \`<div class="c-row"><span class="c-name">\${r.name}</span><span class="c-phone">\${r.phone}</span></div>\`
  ).join('');
}

async function clearContacts() {
  if (!confirm('¿Limpiar toda la lista de contactos?')) return;
  await fetch(BASE+'/api/contacts/clear', { method: 'DELETE' });
  loadedContacts = [];
  document.getElementById('contactsPreview').style.display = 'none';
  document.getElementById('loadResult').innerHTML = '<div class="alert alert-info">🗑 Lista limpiada</div>';
  stopBlastPolling();
  document.getElementById('blastProgress').classList.remove('visible');
}

async function sendBlast() {
  const msg = document.getElementById('smsMsg').value.trim();
  if (!msg) { alert('Escribí el mensaje primero'); return; }
  const delay = parseInt(document.getElementById('delaySeconds').value) || 90;
  const filterSent = document.getElementById('filterSent').value === 'true';

  const res = await fetch(BASE+'/api/sms/blast', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ message: msg, delaySeconds: delay, filterSent })
  });
  const data = await res.json();

  if (!data.ok) {
    document.getElementById('sendAlert').innerHTML = \`<div class="alert alert-error">❌ \${data.error}</div>\`;
    return;
  }

  document.getElementById('sendAlert').innerHTML =
    \`<div class="alert alert-success">🚀 Campaña iniciada: \${data.queued} SMS · ~\${data.estimatedMinutes} min estimados</div>\`;
  document.getElementById('btnSend').disabled = true;

  // Mostrar panel de progreso
  document.getElementById('blastProgress').classList.add('visible');
  document.getElementById('pTotal').textContent = data.queued;
  startBlastPolling();
}

function startBlastPolling() {
  blastPolling = setInterval(async () => {
    const res = await fetch(BASE+'/api/blast/status');
    const s = await res.json();

    const pct = s.total > 0 ? Math.round((s.sent / s.total) * 100) : 0;
    document.getElementById('progressFill').style.width = pct + '%';
    document.getElementById('pSent').textContent = s.sent;
    document.getElementById('pTotal').textContent = s.total;
    document.getElementById('pFailed').textContent = s.failed;

    if (s.running && s.current) {
      document.getElementById('pCountdown').innerHTML =
        \`Enviando a: <span class="current-sending">\${s.current}</span> · Próximo en <span class="current-sending">\${s.nextIn}s</span>\`;
    }

    if (!s.running && s.finishedAt) {
      stopBlastPolling();
      document.getElementById('pCountdown').innerHTML = '';
      document.getElementById('progressFill').style.width = '100%';
      const prog = document.querySelector('.progress-card');
      prog.innerHTML += \`<div class="blast-done" style="margin-top:12px">🎉 Campaña completada — \${s.sent} enviados · \${s.failed} fallidos</div>\`;
      document.getElementById('btnSend').disabled = false;
    }
  }, 1000);
}

function stopBlastPolling() {
  if (blastPolling) { clearInterval(blastPolling); blastPolling = null; }
}

async function sendTest() {
  const phone = document.getElementById('testPhone').value.trim();
  const name  = document.getElementById('testName').value.trim() || "Amigo";
  if (!phone) { alert('Ingresá un número'); return; }

  const loadRes = await fetch(BASE+'/api/contacts/load', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ rows: [{ name, phone }] })
  });

  const contacts = await fetch(BASE+'/api/contacts').then(r => r.json());
  const contact = contacts.find(c => c.phone === phone);
  if (!contact) { alert('Error cargando contacto'); return; }

  const msg = document.getElementById('smsMsg').value || "Hola {{nombre}}! Este es un SMS de prueba: {{link}}";
  const res = await fetch(BASE+'/api/sms/send', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ contactId: contact.id, message: msg })
  });
  const data = await res.json();
  document.getElementById('testResult').innerHTML = data.ok
    ? \`<div class="alert alert-success">✅ SMS enviado a \${name}</div>\`
    : \`<div class="alert alert-error">❌ Error: \${JSON.stringify(data.error)}</div>\`;
}

async function loadMetrics() {
  const res = await fetch(BASE+'/api/metrics');
  const metrics = await res.json();

  document.getElementById('statsGrid').innerHTML = \`
    <div class="stat"><div class="stat-label">CONTACTOS</div><div class="stat-val">\${metrics.total}</div></div>
    <div class="stat"><div class="stat-label">ENVIADOS</div><div class="stat-val green">\${metrics.sent}</div></div>
    <div class="stat"><div class="stat-label">CLICKS</div><div class="stat-val blue">\${metrics.clicked}<span style="font-size:14px;color:#5a6070"> (\${metrics.clickRate}%)</span></div></div>
    <div class="stat"><div class="stat-label">STOP</div><div class="stat-val red">\${metrics.stopped}</div></div>
    <div class="stat"><div class="stat-label">FOLLOW-UP</div><div class="stat-val yellow">\${metrics.pendingFollowUp}</div></div>
  \`;

  document.getElementById('clicksTable').innerHTML = metrics.recentClicks?.length ? \`
    <table><thead><tr><th>HORA</th><th>NOMBRE</th><th>TELÉFONO</th></tr></thead><tbody>
    \${metrics.recentClicks.map(c => \`<tr>
      <td style="color:#5a6070;font-family:monospace">\${c.ts.slice(5)}</td>
      <td style="color:#00e5a0;font-weight:600">\${c.name}</td>
      <td style="color:#5a6070">\${c.phone}</td>
    </tr>\`).join('')}
    </tbody></table>
  \` : '<div style="color:#5a6070;padding:12px">Sin clicks aún...</div>';

  const pending = (metrics.contacts || []).filter(c => c.smsSent && !c.clicked && !c.stopped);
  document.getElementById('followUp').innerHTML = pending.length ? pending.map(c => \`
    <div style="display:flex;align-items:center;gap:12px;padding:10px;background:#f5a62310;border-radius:4px;border:1px solid #f5a62333;margin-bottom:8px">
      <span>⏰</span>
      <div style="flex:1"><div style="font-size:13px;font-weight:600">\${c.name}</div>
      <div style="font-size:11px;color:#5a6070">Sin click desde \${c.smsAt || '—'}</div></div>
      <span style="font-size:10px;padding:2px 8px;background:#f5a62322;color:#f5a623;border-radius:2px">SIN RESPUESTA</span>
    </div>
  \`).join('') : '<div style="color:#5a6070;padding:12px">✓ Sin pendientes</div>';

  document.getElementById('contactsTable').innerHTML = (metrics.contacts || []).map(c => \`
    <tr>
      <td style="font-weight:600">\${c.name}</td>
      <td style="color:#5a6070;font-family:monospace">\${c.phone}</td>
      <td>\${c.smsSent ? '<span class="badge badge-green">ENVIADO</span>' : '<span class="badge badge-yellow">PENDIENTE</span>'}</td>
      <td>\${c.clicked ? '<span class="badge badge-blue">✓ CLICK</span>' : '—'}</td>
      <td>\${c.stopped ? '<span class="badge badge-red">STOP</span>' : '—'}</td>
    </tr>
  \`).join('');

  document.getElementById('logsTable').innerHTML = (metrics.smsLog || []).map(l => \`
    <tr>
      <td style="color:#5a6070;font-family:monospace">\${l.ts.slice(5)}</td>
      <td style="font-weight:600">\${l.name}</td>
      <td style="color:#5a6070">\${l.phone}</td>
      <td>\${l.status === 'ENVIADO' ? '<span class="badge badge-green">ENVIADO</span>' : '<span class="badge badge-red">FALLIDO</span>'}</td>
    </tr>
  \`).join('');
}

async function checkGateway() {
  try {
    const res = await fetch(BASE+'/api/metrics');
    const el = document.getElementById('gatewayStatus');
    if (res.ok) { el.textContent = '● GATEWAY ONLINE'; el.style.color = '#00e5a0'; }
    // Si hay blast corriendo al cargar, retomar polling
    const status = await fetch(BASE+'/api/blast/status').then(r => r.json());
    if (status.running) {
      document.getElementById('blastProgress').classList.add('visible');
      document.getElementById('pTotal').textContent = status.total;
      document.getElementById('btnSend').disabled = true;
      startBlastPolling();
    }
  } catch {
    const el = document.getElementById('gatewayStatus');
    el.style.color = '#ff4545'; el.textContent = '● OFFLINE';
  }
}

checkGateway();
setInterval(loadMetrics, 15000);
</script>
</body>
</html>`);
});

app.get("/health", (req, res) => res.json({ ok: true, contacts: Object.keys(contacts).length, blastRunning: blastState.running }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 SMS Tracker corriendo en puerto " + PORT));
