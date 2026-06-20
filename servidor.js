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

let blastState = { running: false, total: 0, sent: 0, current: null, failed: 0, startedAt: null, finishedAt: null, nextIn: 0 };

function genId() { return crypto.randomBytes(4).toString("hex").toUpperCase(); }
function now()   { return new Date().toISOString().replace("T"," ").slice(0,16); }

app.get("/c/:linkId", (req, res) => {
  const { linkId } = req.params;
  const contact = Object.values(contacts).find(c => c.linkId === linkId);
  if (contact) {
    contact.clicked = true;
    contact.clickedAt = now();
    contact.clickCount = (contact.clickCount || 0) + 1;
    clicks.push({ ts: now(), linkId, name: contact.name, phone: contact.phone });
    console.log("CLICK: " + contact.name);
  }
  res.redirect(302, process.env.CATALOG_URL || "https://wa.me/595992401579");
});

app.post("/webhook/sms", (req, res) => {
  const { from, message } = req.body;
  const contact = Object.values(contacts).find(c => c.phone === from || c.phone === "+" + from);
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

app.post("/api/contacts/load", (req, res) => {
  const { rows } = req.body;
  if (!rows || !rows.length) return res.status(400).json({ error: "Sin contactos" });
  let added = 0;
  rows.forEach(r => {
    if (!r.phone) return;
    const id = genId();
    contacts[id] = { id, name: r.name || "Cliente", phone: r.phone.trim().replace(/\s/g, ""), linkId: genId(), clicked: false, clickedAt: null, stopped: false, replied: false, smsSent: false, smsAt: null };
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
      body: JSON.stringify({ message: finalMsg, phoneNumbers: [contact.phone] }),
    });
    const data = await response.json();
    if (response.ok) {
      contact.smsSent = true; contact.smsAt = now();
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
      const trackUrl = BASE_URL + "/c/" + contact.linkId;
      const finalMsg = (message || "").replace("{{nombre}}", contact.name.split(" ")[0]).replace("{{link}}", trackUrl);
      try {
        const response = await fetch(SMS_API + "/message", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Basic " + Buffer.from(SMS_USER + ":" + SMS_PASS).toString("base64") },
          body: JSON.stringify({ message: finalMsg, phoneNumbers: [contact.phone] }),
        });
        const data = await response.json();
        if (response.ok) {
          contact.smsSent = true; contact.smsAt = now();
          smsLog.push({ ts: now(), name: contact.name, phone: contact.phone, msg: finalMsg, status: "ENVIADO" });
          blastState.sent++;
        } else {
          blastState.failed++;
          smsLog.push({ ts: now(), name: contact.name, phone: contact.phone, msg: finalMsg, status: "FALLIDO" });
        }
      } catch (err) { blastState.failed++; }
      if (i < targets.length - 1) {
        for (let t = delaySeconds; t > 0; t--) {
          blastState.nextIn = t;
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
    blastState.running = false; blastState.current = null; blastState.finishedAt = now();
    console.log("Blast completado");
  })();
});

app.get("/api/blast/status", (req, res) => res.json(blastState));

app.get("/api/metrics", (req, res) => {
  const all = Object.values(contacts);
  const sent = all.filter(c => c.smsSent);
  const clicked = all.filter(c => c.clicked);
  const stopped = all.filter(c => c.stopped);
  const replied = all.filter(c => c.replied);
  const pending = sent.filter(c => !c.clicked && !c.stopped);
  res.json({ total: all.length, sent: sent.length, clicked: clicked.length, clickRate: sent.length ? ((clicked.length / sent.length) * 100).toFixed(1) : 0, stopped: stopped.length, replied: replied.length, pendingFollowUp: pending.length, recentClicks: clicks.slice(-10).reverse(), smsLog: smsLog.slice(-20).reverse(), contacts: all });
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/", (req, res) => {
  const html = [
    '<!DOCTYPE html>',
    '<html lang="es">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>SMS Marketing - Crediphone</title>',
    '<style>',
    '@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap");',
    '*{box-sizing:border-box;margin:0;padding:0}',
    'body{background:#0a0b0d;color:#e8eaf0;font-family:"IBM Plex Mono",monospace;min-height:100vh}',
    '.header{background:#111318;border-bottom:1px solid #22272f;padding:16px 24px;display:flex;align-items:center;gap:16px}',
    '.logo{font-size:20px;font-weight:800;color:#00e5a0;letter-spacing:2px}',
    '.sub{font-size:10px;color:#5a6070;letter-spacing:1px}',
    '.gws{margin-left:auto;font-size:11px;padding:4px 12px;border-radius:3px;background:#00e5a022;color:#00e5a0;border:1px solid #00e5a044}',
    '.tabs{display:flex;background:#111318;border-bottom:1px solid #22272f}',
    '.tab{padding:12px 20px;border:none;background:transparent;color:#5a6070;font-family:inherit;font-size:12px;font-weight:700;letter-spacing:1px;cursor:pointer;border-bottom:2px solid transparent;transition:all .15s}',
    '.tab.active{color:#00e5a0;border-bottom-color:#00e5a0}',
    '.content{padding:24px;max-width:1000px;margin:0 auto}',
    '.sec{display:none}.sec.active{display:block}',
    '.card{background:#16191f;border:1px solid #22272f;border-radius:6px;padding:20px;margin-bottom:16px}',
    '.lbl{font-size:10px;color:#5a6070;letter-spacing:1px;margin-bottom:8px}',
    'input,textarea,select{width:100%;background:#0a0b0d;border:1px solid #22272f;border-radius:4px;padding:10px 12px;color:#e8eaf0;font-family:inherit;font-size:13px;margin-bottom:12px}',
    'textarea{resize:vertical;min-height:120px}',
    'input:focus,textarea:focus{outline:none;border-color:#00e5a055}',
    '.btn{padding:10px 20px;border-radius:4px;border:none;cursor:pointer;font-family:inherit;font-weight:700;font-size:12px;letter-spacing:1px}',
    '.btn-p{background:#00e5a0;color:#000}',
    '.btn-s{background:#22272f;color:#e8eaf0}',
    '.btn-d{background:#ff454522;color:#ff4545;border:1px solid #ff454544;padding:6px 14px;font-size:11px}',
    '.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}',
    '.stat{background:#16191f;border:1px solid #22272f;border-radius:6px;padding:16px}',
    '.sv{font-size:28px;font-weight:800;font-family:monospace}',
    '.sl{font-size:10px;color:#5a6070;letter-spacing:1px;margin-bottom:6px}',
    '.gn{color:#00e5a0}.yw{color:#f5a623}.rd{color:#ff4545}.bl{color:#4da6ff}',
    'table{width:100%;border-collapse:collapse}',
    'th{padding:10px 14px;text-align:left;font-size:10px;color:#5a6070;letter-spacing:1px;border-bottom:1px solid #22272f}',
    'td{padding:10px 14px;font-size:12px;border-bottom:1px solid #22272f22}',
    '.badge{font-size:10px;padding:2px 8px;border-radius:2px;font-weight:700}',
    '.bg{background:#00e5a022;color:#00e5a0;border:1px solid #00e5a044}',
    '.by{background:#f5a62322;color:#f5a623;border:1px solid #f5a62344}',
    '.br{background:#ff454522;color:#ff4545;border:1px solid #ff454544}',
    '.bb{background:#4da6ff22;color:#4da6ff;border:1px solid #4da6ff44}',
    '#dz{border:2px dashed #22272f;border-radius:6px;padding:32px;text-align:center;cursor:pointer;color:#5a6070;margin-bottom:12px;transition:all .2s}',
    '#dz:hover{border-color:#00e5a0;color:#00e5a0}',
    '.mc{font-size:11px;color:#5a6070;text-align:right;margin-top:-8px;margin-bottom:12px}',
    '.alert{padding:12px 16px;border-radius:4px;margin-bottom:12px;font-size:13px}',
    '.as{background:#00e5a022;color:#00e5a0;border:1px solid #00e5a044}',
    '.ae{background:#ff454522;color:#ff4545;border:1px solid #ff454544}',
    '.ai{background:#4da6ff22;color:#4da6ff;border:1px solid #4da6ff44}',
    '.pvbox{background:#0a0b0d;border:1px solid #22272f;border-radius:4px;padding:12px;max-height:200px;overflow-y:auto;font-size:11px;margin-bottom:12px}',
    '.crow{display:flex;gap:12px;padding:3px 0;border-bottom:1px solid #22272f22}',
    '.cn{color:#e8eaf0;min-width:150px}',
    '.cp{color:#00e5a0}',
    '.trow{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}',
    '.tpl{padding:5px 12px;border-radius:3px;border:1px solid #22272f;background:transparent;color:#5a6070;font-family:inherit;font-size:11px;cursor:pointer}',
    '.tpl:hover{border-color:#00e5a055;color:#00e5a0}',
    '#blastBox{display:none}',
    '#blastBox.show{display:block}',
    '.pc{background:#111318;border:1px solid #00e5a033;border-radius:6px;padding:16px;margin-bottom:16px}',
    '.pbw{background:#22272f;border-radius:3px;height:8px;margin-bottom:12px;overflow:hidden}',
    '.pb{height:100%;background:linear-gradient(90deg,#00e5a0,#00b87a);border-radius:3px;transition:width .5s}',
    '.pg{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;font-size:11px}',
    '.pl{color:#5a6070;margin-bottom:3px}',
    '.pv{font-weight:700;font-size:13px}',
    '.cd{font-size:11px;color:#5a6070;margin-top:10px;text-align:center;padding:8px;background:#22272f22;border-radius:3px}',
    '.hl{color:#f5a623;font-weight:700}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="header">',
    '<div><div class="logo">SMS MARKETING</div><div class="sub">CREDIPHONE - SMSGATE</div></div>',
    '<div class="gws" id="gwStatus">CONECTANDO...</div>',
    '</div>',
    '<div class="tabs">',
    '<button class="tab active" id="tbtn-envio" onclick="goTab(\'envio\')">ENVIAR</button>',
    '<button class="tab" id="tbtn-metricas" onclick="goTab(\'metricas\')">METRICAS</button>',
    '<button class="tab" id="tbtn-contactos" onclick="goTab(\'contactos\')">CONTACTOS</button>',
    '<button class="tab" id="tbtn-logs" onclick="goTab(\'logs\')">LOGS</button>',
    '</div>',
    '<div class="content">',
    '<div id="sec-envio" class="sec active">',
    '<div class="card">',
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">',
    '<div class="lbl" style="margin:0">1. CARGAR CONTACTOS (CSV)</div>',
    '<button class="btn btn-d" onclick="clearList()">Limpiar lista</button>',
    '</div>',
    '<div id="dz" onclick="document.getElementById(\'csvFile\').click()">Arrastra tu CSV aqui o toca para seleccionar<br><small style="font-size:11px;margin-top:8px;display:block">Formato: nombre,telefono (con +595...)</small></div>',
    '<input type="file" id="csvFile" accept=".csv" style="display:none" onchange="loadCSV(this)">',
    '<div id="loadResult"></div>',
    '<div id="previewBox" style="display:none">',
    '<div style="display:flex;justify-content:space-between;margin-bottom:6px">',
    '<div class="lbl" style="margin:0">CONTACTOS CARGADOS</div>',
    '<div class="gn" style="font-size:11px;font-weight:700" id="pvCount"></div>',
    '</div>',
    '<div class="pvbox" id="pvList"></div>',
    '</div>',
    '</div>',
    '<div class="card">',
    '<div class="lbl">2. MENSAJE</div>',
    '<div class="trow">',
    '<span style="font-size:10px;color:#5a6070;align-self:center">PLANTILLAS:</span>',
    '<button class="tpl" onclick="setTpl(\'iphone\')">iPhone cuotas</button>',
    '<button class="tpl" onclick="setTpl(\'oferta\')">Oferta especial</button>',
    '<button class="tpl" onclick="setTpl(\'seguimiento\')">Seguimiento</button>',
    '<button class="tpl" onclick="setTpl(\'clear\')">Limpiar</button>',
    '</div>',
    '<textarea id="smsMsg" placeholder="Escribi tu mensaje... usa {{nombre}} y {{link}}" oninput="updateCounter()"></textarea>',
    '<div class="mc"><span id="charCount">0</span>/160</div>',
    '<div style="font-size:11px;color:#5a6070">Variables: <code style="color:#00e5a0">{{nombre}}</code> - <code style="color:#00e5a0">{{link}}</code></div>',
    '</div>',
    '<div class="card">',
    '<div class="lbl">3. CONFIGURAR ENVIO</div>',
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">',
    '<div><div class="lbl">DELAY ENTRE SMS (seg)</div><input type="number" id="delaySeconds" value="90" min="30" max="300"></div>',
    '<div><div class="lbl">FILTRO</div><select id="filterSent"><option value="true">Solo no enviados</option><option value="false">Todos</option></select></div>',
    '</div>',
    '<div id="sendAlert"></div>',
    '<div style="display:flex;align-items:center;gap:16px">',
    '<button class="btn btn-p" onclick="sendBlast()" id="btnSend">INICIAR CAMPANA</button>',
    '<span style="font-size:11px;color:#5a6070" id="estimado"></span>',
    '</div>',
    '</div>',
    '<div id="blastBox">',
    '<div class="pc">',
    '<div class="lbl">CAMPANA EN CURSO</div>',
    '<div class="pbw"><div class="pb" id="progFill" style="width:0%"></div></div>',
    '<div class="pg">',
    '<div><div class="pl">ENVIADOS</div><div class="pv gn" id="pSent">0</div></div>',
    '<div><div class="pl">TOTAL</div><div class="pv" id="pTotal">0</div></div>',
    '<div><div class="pl">FALLIDOS</div><div class="pv rd" id="pFailed">0</div></div>',
    '</div>',
    '<div class="cd" id="pCountdown"></div>',
    '</div>',
    '</div>',
    '<div class="card">',
    '<div class="lbl">PRUEBA RAPIDA</div>',
    '<input type="text" id="testPhone" placeholder="+595981123456">',
    '<input type="text" id="testName" placeholder="Nombre de prueba">',
    '<button class="btn btn-s" onclick="sendTest()">Enviar SMS de prueba</button>',
    '<div id="testResult" style="margin-top:8px"></div>',
    '</div>',
    '</div>',
    '<div id="sec-metricas" class="sec">',
    '<div class="stats" id="statsGrid"></div>',
    '<div class="card"><div class="lbl">CLICKS EN TIEMPO REAL</div><div id="clicksTable"></div></div>',
    '<div class="card"><div class="lbl">FOLLOW-UP</div><div id="followUp"></div></div>',
    '</div>',
    '<div id="sec-contactos" class="sec">',
    '<div class="card"><table><thead><tr><th>NOMBRE</th><th>TELEFONO</th><th>SMS</th><th>CLICK</th><th>STOP</th></tr></thead><tbody id="contactsTable"></tbody></table></div>',
    '</div>',
    '<div id="sec-logs" class="sec">',
    '<div class="card"><table><thead><tr><th>HORA</th><th>NOMBRE</th><th>TELEFONO</th><th>ESTADO</th></tr></thead><tbody id="logsTable"></tbody></table></div>',
    '</div>',
    '</div>',
    '<script>',
    'var BASE = window.location.origin;',
    'var blastPoll = null;',
    'var TPLS = {',
    '  iphone: "Hola {{nombre}}! Tenemos iPhones originales en cuotas desde 150.000 Gs/mes. Sin tarjeta. Mira modelos: {{link}}",',
    '  oferta: "{{nombre}}, oferta especial 48hs! iPhone con garantia y cuotas fijas. Ver catalogo: {{link}}",',
    '  seguimiento: "Hola {{nombre}}, pudiste ver las opciones de iPhone? Link nuevamente: {{link}}"',
    '};',
    'function goTab(tab) {',
    '  document.querySelectorAll(".tab").forEach(function(t){t.classList.remove("active");});',
    '  document.querySelectorAll(".sec").forEach(function(s){s.classList.remove("active");});',
    '  document.getElementById("tbtn-"+tab).classList.add("active");',
    '  document.getElementById("sec-"+tab).classList.add("active");',
    '  if(tab==="metricas"||tab==="contactos"||tab==="logs") loadMetrics();',
    '}',
    'function setTpl(k){document.getElementById("smsMsg").value=k==="clear"?"":(TPLS[k]||"");updateCounter();}',
    'function updateCounter(){var l=document.getElementById("smsMsg").value.length;var e=document.getElementById("charCount");e.textContent=l;e.style.color=l>160?"#f5a623":"#5a6070";}',
    'var dz=document.getElementById("dz");',
    'dz.addEventListener("dragover",function(e){e.preventDefault();dz.style.borderColor="#00e5a0";});',
    'dz.addEventListener("dragleave",function(){dz.style.borderColor="#22272f";});',
    'dz.addEventListener("drop",function(e){e.preventDefault();dz.style.borderColor="#22272f";if(e.dataTransfer.files[0])processCSV(e.dataTransfer.files[0]);});',
    'function loadCSV(i){if(i.files[0])processCSV(i.files[0]);}',
    'function processCSV(file){',
    '  var r=new FileReader();',
    '  r.onload=function(e){',
    '    var lines=e.target.result.split("\\n").filter(function(l){return l.trim();});',
    '    var rows=[];',
    '    lines.forEach(function(line,i){',
    '      if(i===0&&line.toLowerCase().includes("nombre"))return;',
    '      var p=line.split(",");',
    '      if(p.length>=2){var ph=p[1].trim();if(ph&&/^[+0-9]/.test(ph)&&ph.length>6)rows.push({name:p[0].trim(),phone:ph});}',
    '    });',
    '    fetch(BASE+"/api/contacts/load",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({rows:rows})})',
    '    .then(function(r){return r.json();}).then(function(d){',
    '      document.getElementById("loadResult").innerHTML="<div class=\'alert as\'>"+d.added+" contactos cargados. Total: "+d.total+"</div>";',
    '      showPreview(rows);',
    '    });',
    '  };',
    '  r.readAsText(file);',
    '}',
    'function showPreview(rows){',
    '  if(!rows.length)return;',
    '  document.getElementById("previewBox").style.display="block";',
    '  document.getElementById("pvCount").textContent=rows.length+" contactos";',
    '  document.getElementById("pvList").innerHTML=rows.map(function(r){return "<div class=\'crow\'><span class=\'cn\'>"+r.name+"</span><span class=\'cp\'>"+r.phone+"</span></div>";}).join("");',
    '}',
    'function clearList(){',
    '  if(!confirm("Limpiar toda la lista?"))return;',
    '  fetch(BASE+"/api/contacts/clear",{method:"DELETE"}).then(function(){',
    '    document.getElementById("previewBox").style.display="none";',
    '    document.getElementById("loadResult").innerHTML="<div class=\'alert ai\'>Lista limpiada</div>";',
    '    stopPoll();document.getElementById("blastBox").classList.remove("show");',
    '  });',
    '}',
    'function sendBlast(){',
    '  var msg=document.getElementById("smsMsg").value.trim();',
    '  if(!msg){alert("Escribi el mensaje primero");return;}',
    '  var delay=parseInt(document.getElementById("delaySeconds").value)||90;',
    '  var fs=document.getElementById("filterSent").value==="true";',
    '  fetch(BASE+"/api/sms/blast",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg,delaySeconds:delay,filterSent:fs})})',
    '  .then(function(r){return r.json();}).then(function(d){',
    '    if(!d.ok){document.getElementById("sendAlert").innerHTML="<div class=\'alert ae\'>"+d.error+"</div>";return;}',
    '    document.getElementById("sendAlert").innerHTML="<div class=\'alert as\'>Campana iniciada: "+d.queued+" SMS - ~"+d.estimatedMinutes+" min</div>";',
    '    document.getElementById("btnSend").disabled=true;',
    '    document.getElementById("blastBox").classList.add("show");',
    '    document.getElementById("pTotal").textContent=d.queued;',
    '    startPoll();',
    '  });',
    '}',
    'function startPoll(){',
    '  blastPoll=setInterval(function(){',
    '    fetch(BASE+"/api/blast/status").then(function(r){return r.json();}).then(function(s){',
    '      var pct=s.total>0?Math.round((s.sent/s.total)*100):0;',
    '      document.getElementById("progFill").style.width=pct+"%";',
    '      document.getElementById("pSent").textContent=s.sent;',
    '      document.getElementById("pTotal").textContent=s.total;',
    '      document.getElementById("pFailed").textContent=s.failed;',
    '      if(s.running&&s.current){document.getElementById("pCountdown").innerHTML="Enviando a: <span class=\'hl\'>"+s.current+"</span> - Proximo en <span class=\'hl\'>"+s.nextIn+"s</span>";}',
    '      if(!s.running&&s.finishedAt){stopPoll();document.getElementById("pCountdown").textContent="Campana completada! "+s.sent+" enviados - "+s.failed+" fallidos";document.getElementById("btnSend").disabled=false;}',
    '    });',
    '  },1000);',
    '}',
    'function stopPoll(){if(blastPoll){clearInterval(blastPoll);blastPoll=null;}}',
    'function sendTest(){',
    '  var phone=document.getElementById("testPhone").value.trim();',
    '  var name=document.getElementById("testName").value.trim()||"Amigo";',
    '  if(!phone){alert("Ingresa un numero");return;}',
    '  var msg=document.getElementById("smsMsg").value||"Hola {{nombre}}! SMS de prueba: {{link}}";',
    '  fetch(BASE+"/api/contacts/load",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({rows:[{name:name,phone:phone}]})})',
    '  .then(function(){return fetch(BASE+"/api/contacts");}).then(function(r){return r.json();})',
    '  .then(function(cs){',
    '    var c=cs.find(function(x){return x.phone===phone;});',
    '    if(!c){alert("Error cargando contacto");return;}',
    '    return fetch(BASE+"/api/sms/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contactId:c.id,message:msg})})',
    '    .then(function(r){return r.json();}).then(function(d){',
    '      document.getElementById("testResult").innerHTML=d.ok?"<div class=\'alert as\'>SMS enviado a "+name+"</div>":"<div class=\'alert ae\'>Error: "+JSON.stringify(d.error)+"</div>";',
    '    });',
    '  });',
    '}',
    'function loadMetrics(){',
    '  fetch(BASE+"/api/metrics").then(function(r){return r.json();}).then(function(m){',
    '    document.getElementById("statsGrid").innerHTML=',
    '      "<div class=\'stat\'><div class=\'sl\'>CONTACTOS</div><div class=\'sv\'>"+m.total+"</div></div>"+',
    '      "<div class=\'stat\'><div class=\'sl\'>ENVIADOS</div><div class=\'sv gn\'>"+m.sent+"</div></div>"+',
    '      "<div class=\'stat\'><div class=\'sl\'>CLICKS</div><div class=\'sv bl\'>"+m.clicked+" ("+m.clickRate+"%)</div></div>"+',
    '      "<div class=\'stat\'><div class=\'sl\'>STOP</div><div class=\'sv rd\'>"+m.stopped+"</div></div>"+',
    '      "<div class=\'stat\'><div class=\'sl\'>FOLLOW-UP</div><div class=\'sv yw\'>"+m.pendingFollowUp+"</div></div>";',
    '    document.getElementById("clicksTable").innerHTML=m.recentClicks&&m.recentClicks.length',
    '      ?"<table><thead><tr><th>HORA</th><th>NOMBRE</th><th>TELEFONO</th></tr></thead><tbody>"+m.recentClicks.map(function(c){return "<tr><td style=\'color:#5a6070\'>"+c.ts.slice(5)+"</td><td style=\'color:#00e5a0;font-weight:600\'>"+c.name+"</td><td style=\'color:#5a6070\'>"+c.phone+"</td></tr>";}).join("")+"</tbody></table>"',
    '      :"<div style=\'color:#5a6070;padding:12px\'>Sin clicks aun...</div>";',
    '    var pend=(m.contacts||[]).filter(function(c){return c.smsSent&&!c.clicked&&!c.stopped;});',
    '    document.getElementById("followUp").innerHTML=pend.length',
    '      ?pend.map(function(c){return "<div style=\'padding:10px;background:#f5a62310;border-radius:4px;border:1px solid #f5a62333;margin-bottom:8px\'><div style=\'font-weight:600\'>"+c.name+"</div><div style=\'font-size:11px;color:#5a6070\'>Sin click desde "+(c.smsAt||"-")+"</div></div>";}).join("")',
    '      :"<div style=\'color:#5a6070;padding:12px\'>Sin pendientes</div>";',
    '    document.getElementById("contactsTable").innerHTML=(m.contacts||[]).map(function(c){return "<tr><td style=\'font-weight:600\'>"+c.name+"</td><td style=\'color:#5a6070;font-family:monospace\'>"+c.phone+"</td><td>"+(c.smsSent?"<span class=\'badge bg\'>ENVIADO</span>":"<span class=\'badge by\'>PENDIENTE</span>")+"</td><td>"+(c.clicked?"<span class=\'badge bb\'>CLICK</span>":"-")+"</td><td>"+(c.stopped?"<span class=\'badge br\'>STOP</span>":"-")+"</td></tr>";}).join("");',
    '    document.getElementById("logsTable").innerHTML=(m.smsLog||[]).map(function(l){return "<tr><td style=\'color:#5a6070;font-family:monospace\'>"+l.ts.slice(5)+"</td><td style=\'font-weight:600\'>"+l.name+"</td><td style=\'color:#5a6070\'>"+l.phone+"</td><td>"+(l.status==="ENVIADO"?"<span class=\'badge bg\'>ENVIADO</span>":"<span class=\'badge br\'>FALLIDO</span>")+"</td></tr>";}).join("");',
    '  });',
    '}',
    'function checkGW(){',
    '  fetch(BASE+"/api/metrics").then(function(r){',
    '    if(r.ok){var e=document.getElementById("gwStatus");e.textContent="ONLINE";e.style.color="#00e5a0";}',
    '    return r.json();',
    '  }).then(function(){return fetch(BASE+"/api/blast/status");}).then(function(r){return r.json();})',
    '  .then(function(s){if(s.running){document.getElementById("blastBox").classList.add("show");document.getElementById("pTotal").textContent=s.total;document.getElementById("btnSend").disabled=true;startPoll();}})',
    '  .catch(function(){var e=document.getElementById("gwStatus");e.style.color="#ff4545";e.textContent="OFFLINE";});',
    '}',
    'checkGW();',
    'setInterval(function(){var a=document.querySelector(".sec.active");if(a&&a.id!=="sec-envio")loadMetrics();},15000);',
    '<\/script>',
    '</body>',
    '</html>'
  ].join('\n');
  res.send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("SMS Tracker corriendo en puerto " + PORT); });
