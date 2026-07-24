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

let contacts = {};
let clicks   = [];
let smsLog   = [];
let blastState = { running: false, total: 0, sent: 0, failed: 0, current: null, nextIn: 0, startedAt: null, finishedAt: null };

function genId() { return crypto.randomBytes(4).toString("hex").toUpperCase(); }
function now()   { return new Date().toISOString().replace("T"," ").slice(0,16); }

// Link tracker
app.get("/c/:linkId", (req, res) => {
  const contact = Object.values(contacts).find(c => c.linkId === req.params.linkId);
  if (contact) {
    contact.clicked = true;
    contact.clickedAt = now();
    clicks.push({ ts: now(), name: contact.name, phone: contact.phone });
    console.log("CLICK: " + contact.name);
  }
  res.redirect(302, process.env.CATALOG_URL || "https://wa.me/595992401579");
});

// Cargar contactos
app.post("/api/contacts/load", (req, res) => {
  const { rows } = req.body;
  if (!rows || !rows.length) return res.status(400).json({ error: "Sin contactos" });
  let added = 0;
  rows.forEach(r => {
    if (!r.phone) return;
    const id = genId();
    contacts[id] = { id, name: r.name || "Cliente", phone: r.phone.trim(), linkId: genId(), smsSent: false, smsAt: null, clicked: false, clickedAt: null, failed: false };
    added++;
  });
  res.json({ ok: true, added, total: Object.keys(contacts).length });
});

// Reset total
app.post("/api/reset", (req, res) => {
  contacts = {};
  clicks = [];
  smsLog = [];
  blastState = { running: false, total: 0, sent: 0, failed: 0, current: null, nextIn: 0, startedAt: null, finishedAt: null };
  res.json({ ok: true });
});

// Exportar CSV
app.get("/api/export", (req, res) => {
  const rows = Object.values(contacts);
  let csv = "Nombre,Telefono,SMS Enviado,Fecha Envio,Click,Fecha Click,Estado\n";
  rows.forEach(c => {
    csv += [
      c.name,
      c.phone,
      c.smsSent ? "SI" : "NO",
      c.smsAt || "",
      c.clicked ? "SI" : "NO",
      c.clickedAt || "",
      c.failed ? "FALLIDO" : c.smsSent ? "ENVIADO" : "PENDIENTE"
    ].join(",") + "\n";
  });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=campana-" + now().replace(" ","-").replace(/:/g,"") + ".csv");
  res.send(csv);
});

// Metricas
app.get("/api/metrics", (req, res) => {
  const all = Object.values(contacts);
  res.json({
    total: all.length,
    sent: all.filter(c => c.smsSent).length,
    clicked: all.filter(c => c.clicked).length,
    failed: all.filter(c => c.failed).length,
    clickRate: all.filter(c => c.smsSent).length ? ((all.filter(c => c.clicked).length / all.filter(c => c.smsSent).length) * 100).toFixed(1) : 0,
    recentClicks: clicks.slice(-5).reverse(),
    blastState
  });
});

// Blast status
app.get("/api/blast/status", (req, res) => res.json(blastState));

// Envio masivo
app.post("/api/sms/blast", async (req, res) => {
  if (blastState.running) return res.status(400).json({ error: "Ya hay un blast en curso" });
  const { message, delaySeconds = 60 } = req.body;
  if (!message) return res.status(400).json({ error: "Sin mensaje" });
  const targets = Object.values(contacts).filter(c => !c.smsSent);
  if (!targets.length) return res.status(400).json({ error: "Sin contactos pendientes" });

  blastState = { running: true, total: targets.length, sent: 0, failed: 0, current: null, nextIn: 0, startedAt: now(), finishedAt: null };
  res.json({ ok: true, queued: targets.length, estimatedMinutes: Math.ceil((targets.length * delaySeconds) / 60) });

  (async () => {
    for (let i = 0; i < targets.length; i++) {
      const contact = targets[i];
      blastState.current = contact.name;
      const trackUrl = BASE_URL + "/c/" + contact.linkId;
      const finalMsg = message + " " + trackUrl;

      try {
        const response = await fetch(SMS_API + "/message", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Basic " + Buffer.from(SMS_USER + ":" + SMS_PASS).toString("base64") },
          body: JSON.stringify({ message: finalMsg, phoneNumbers: [contact.phone] })
        });
        if (response.ok) {
          contact.smsSent = true;
          contact.smsAt = now();
          blastState.sent++;
          smsLog.push({ ts: now(), name: contact.name, phone: contact.phone, status: "ENVIADO" });
        } else {
          contact.failed = true;
          blastState.failed++;
          smsLog.push({ ts: now(), name: contact.name, phone: contact.phone, status: "FALLIDO" });
        }
      } catch (err) {
        contact.failed = true;
        blastState.failed++;
      }

      if (i < targets.length - 1) {
        for (let t = delaySeconds; t > 0; t--) {
          blastState.nextIn = t;
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
    blastState.running = false;
    blastState.current = null;
    blastState.finishedAt = now();
    console.log("Blast completado: " + blastState.sent + " enviados, " + blastState.failed + " fallidos");
  })();
});

app.get("/health", (req, res) => res.json({ ok: true }));

// Panel HTML
app.get("/", (req, res) => {
  const lines = [
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
    '.header{background:#111318;border-bottom:1px solid #22272f;padding:20px 32px;display:flex;align-items:center;justify-content:space-between}',
    '.logo{font-size:22px;font-weight:800;color:#00e5a0;letter-spacing:3px}',
    '.sub{font-size:10px;color:#5a6070;letter-spacing:1px;margin-top:2px}',
    '.gws{font-size:11px;padding:6px 14px;border-radius:4px;background:#00e5a022;color:#00e5a0;border:1px solid #00e5a044;font-weight:700}',
    '.main{max-width:900px;margin:0 auto;padding:32px 24px;display:grid;grid-template-columns:1fr 1fr;gap:24px}',
    '.card{background:#16191f;border:1px solid #22272f;border-radius:8px;padding:24px}',
    '.card-full{grid-column:1/-1}',
    '.lbl{font-size:10px;color:#5a6070;letter-spacing:2px;margin-bottom:10px;font-weight:700}',
    'textarea{width:100%;background:#0a0b0d;border:1px solid #22272f;border-radius:6px;padding:14px;color:#e8eaf0;font-family:"IBM Plex Mono",monospace;font-size:13px;resize:vertical;min-height:110px;line-height:1.6}',
    'textarea:focus{outline:none;border-color:#00e5a055}',
    '.counter{font-size:11px;color:#5a6070;text-align:right;margin-top:6px}',
    '.counter span{color:#00e5a0;font-weight:700}',
    '.btn{width:100%;padding:14px;border-radius:6px;border:none;cursor:pointer;font-family:"IBM Plex Mono",monospace;font-weight:700;font-size:13px;letter-spacing:1px;margin-top:12px;transition:opacity .2s}',
    '.btn:hover{opacity:.85}',
    '.btn:disabled{opacity:.4;cursor:not-allowed}',
    '.btn-green{background:#00e5a0;color:#000}',
    '.btn-gray{background:#22272f;color:#e8eaf0}',
    '.btn-red{background:#ff454522;color:#ff4545;border:1px solid #ff454544}',
    '.btn-blue{background:#4da6ff22;color:#4da6ff;border:1px solid #4da6ff44}',
    '.dropzone{border:2px dashed #22272f;border-radius:6px;padding:28px;text-align:center;cursor:pointer;color:#5a6070;transition:all .2s;margin-bottom:0}',
    '.dropzone:hover{border-color:#00e5a0;color:#00e5a0}',
    '.loaded{background:#00e5a015;border:1px solid #00e5a033;border-radius:6px;padding:14px;text-align:center;margin-top:12px}',
    '.loaded-num{font-size:36px;font-weight:800;color:#00e5a0;line-height:1}',
    '.loaded-lbl{font-size:11px;color:#5a6070;margin-top:4px;letter-spacing:1px}',
    '.stats-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:20px}',
    '.stat{background:#0a0b0d;border:1px solid #22272f;border-radius:6px;padding:14px;text-align:center}',
    '.stat-val{font-size:32px;font-weight:800;font-family:monospace;line-height:1}',
    '.stat-lbl{font-size:9px;color:#5a6070;letter-spacing:1px;margin-top:6px}',
    '.gn{color:#00e5a0}.yw{color:#f5a623}.rd{color:#ff4545}.bl{color:#4da6ff}.wh{color:#e8eaf0}',
    '.prog-wrap{background:#22272f;border-radius:4px;height:10px;margin:16px 0;overflow:hidden}',
    '.prog-bar{height:100%;background:linear-gradient(90deg,#00e5a0,#00b87a);border-radius:4px;transition:width .5s;width:0%}',
    '.prog-info{font-size:12px;color:#5a6070;text-align:center;padding:10px;background:#22272f22;border-radius:4px}',
    '.hl{color:#f5a623;font-weight:700}',
    '.alert{padding:12px 16px;border-radius:6px;font-size:13px;margin-top:12px}',
    '.alert-ok{background:#00e5a022;color:#00e5a0;border:1px solid #00e5a044}',
    '.alert-err{background:#ff454522;color:#ff4545;border:1px solid #ff454544}',
    '.recent-clicks{margin-top:16px}',
    '.click-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #22272f22;font-size:12px}',
    '.click-name{color:#00e5a0;font-weight:600}',
    '.click-time{color:#5a6070}',
    '.btn-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:0}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="header">',
    '<div><div class="logo">SMS MARKETING</div><div class="sub">CREDIPHONE · SMSGATE GATEWAY</div></div>',
    '<div class="gws" id="gwStatus">● CONECTANDO...</div>',
    '</div>',
    '<div class="main">',

    // CARGAR CONTACTOS
    '<div class="card">',
    '<div class="lbl">1. CARGAR CONTACTOS</div>',
    '<div class="dropzone" id="dz" onclick="document.getElementById(\'csvFile\').click()">',
    'Arrastra tu CSV aqui<br>o toca para seleccionar<br>',
    '<small style="font-size:10px;margin-top:6px;display:block">nombre,telefono · con +595...</small>',
    '</div>',
    '<input type="file" id="csvFile" accept=".csv" style="display:none" onchange="loadCSV(this)">',
    '<div id="loadedBox" style="display:none" class="loaded">',
    '<div class="loaded-num" id="loadedNum">0</div>',
    '<div class="loaded-lbl">CONTACTOS LISTOS</div>',
    '</div>',
    '<div id="loadAlert"></div>',
    '</div>',

    // MENSAJE
    '<div class="card">',
    '<div class="lbl">2. MENSAJE</div>',
    '<textarea id="smsMsg" placeholder="Escribi tu mensaje exactamente como queres que llegue..." oninput="updateCounter()"></textarea>',
    '<div class="counter"><span id="charCount">0</span> caracteres</div>',
    '<div style="font-size:10px;color:#5a6070;margin-top:8px">El link de tracking se agrega automaticamente al final del mensaje.</div>',
    '</div>',

    // ENVIAR
    '<div class="card card-full">',
    '<div class="lbl">3. CONFIGURAR Y ENVIAR</div>',
    '<div style="display:grid;grid-template-columns:1fr 2fr;gap:16px;align-items:start">',
    '<div>',
    '<div class="lbl">DELAY ENTRE SMS (seg)</div>',
    '<input type="number" id="delaySeconds" value="60" min="30" max="300" style="width:100%;background:#0a0b0d;border:1px solid #22272f;border-radius:4px;padding:10px 12px;color:#e8eaf0;font-family:inherit;font-size:13px">',
    '</div>',
    '<div id="blastAlert"></div>',
    '</div>',
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px">',
    '<button class="btn btn-green" onclick="sendBlast()" id="btnSend">INICIAR CAMPANA</button>',
    '<button class="btn btn-gray" onclick="sendTest()" id="btnTest">ENVIAR PRUEBA A MI NUMERO</button>',
    '</div>',
    '<div class="prog-wrap" id="progWrap" style="display:none">',
    '<div class="prog-bar" id="progBar"></div>',
    '</div>',
    '<div class="prog-info" id="progInfo" style="display:none"></div>',
    '</div>',

    // METRICAS
    '<div class="card card-full">',
    '<div class="lbl">RESULTADO DEL DISPARO</div>',
    '<div class="stats-grid">',
    '<div class="stat"><div class="stat-val wh" id="mTotal">0</div><div class="stat-lbl">TOTAL</div></div>',
    '<div class="stat"><div class="stat-val gn" id="mSent">0</div><div class="stat-lbl">ENVIADOS</div></div>',
    '<div class="stat"><div class="stat-val bl" id="mClicks">0</div><div class="stat-lbl">CLICKS</div></div>',
    '<div class="stat"><div class="stat-val rd" id="mFailed">0</div><div class="stat-lbl">FALLIDOS</div></div>',
    '<div class="stat"><div class="stat-val yw" id="mRate">0%</div><div class="stat-lbl">CLICK RATE</div></div>',
    '</div>',
    '<div class="recent-clicks" id="recentClicks"></div>',
    '<div class="btn-row" style="margin-top:20px">',
    '<a href="/api/export" class="btn btn-blue" style="text-align:center;text-decoration:none;display:block;padding:14px">EXPORTAR CSV PARA SHEETS</a>',
    '<button class="btn btn-red" onclick="resetAll()">RESET TOTAL - NUEVA CAMPANA</button>',
    '</div>',
    '</div>',

    '</div>',
    '<script>',
    'var BASE = window.location.origin;',
    'var poll = null;',

    'function updateCounter(){',
    '  var l = document.getElementById("smsMsg").value.length;',
    '  document.getElementById("charCount").textContent = l;',
    '}',

    'var dz = document.getElementById("dz");',
    'dz.addEventListener("dragover", function(e){e.preventDefault();dz.style.borderColor="#00e5a0";});',
    'dz.addEventListener("dragleave", function(){dz.style.borderColor="#22272f";});',
    'dz.addEventListener("drop", function(e){e.preventDefault();dz.style.borderColor="#22272f";if(e.dataTransfer.files[0])processCSV(e.dataTransfer.files[0]);});',
    'function loadCSV(i){if(i.files[0])processCSV(i.files[0]);}',

    'function processCSV(file){',
    '  var r = new FileReader();',
    '  r.onload = function(e){',
    '    var lines = e.target.result.split("\\n").filter(function(l){return l.trim();});',
    '    var rows = [];',
    '    lines.forEach(function(line, i){',
    '      if(i===0 && line.toLowerCase().includes("nombre")) return;',
    '      var p = line.split(",");',
    '      if(p.length >= 2){',
    '        var ph = p[1].trim();',
    '        if(ph && /^[+0-9]/.test(ph) && ph.length > 6) rows.push({name: p[0].trim(), phone: ph});',
    '      }',
    '    });',
    '    fetch(BASE+"/api/contacts/load",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({rows:rows})})',
    '    .then(function(r){return r.json();}).then(function(d){',
    '      document.getElementById("loadedBox").style.display = "block";',
    '      document.getElementById("loadedNum").textContent = d.total;',
    '      document.getElementById("dz").style.display = "none";',
    '    });',
    '  };',
    '  r.readAsText(file);',
    '}',

    'function sendBlast(){',
    '  var msg = document.getElementById("smsMsg").value.trim();',
    '  if(!msg){alert("Escribi el mensaje primero");return;}',
    '  var delay = parseInt(document.getElementById("delaySeconds").value)||60;',
    '  fetch(BASE+"/api/sms/blast",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg,delaySeconds:delay})})',
    '  .then(function(r){return r.json();}).then(function(d){',
    '    if(!d.ok){document.getElementById("blastAlert").innerHTML="<div class=\'alert alert-err\'>"+d.error+"</div>";return;}',
    '    document.getElementById("blastAlert").innerHTML="<div class=\'alert alert-ok\'>Campana iniciada: "+d.queued+" SMS - ~"+d.estimatedMinutes+" min estimados</div>";',
    '    document.getElementById("btnSend").disabled = true;',
    '    document.getElementById("progWrap").style.display = "block";',
    '    document.getElementById("progInfo").style.display = "block";',
    '    startPoll();',
    '  });',
    '}',

    'function sendTest(){',
    '  var msg = document.getElementById("smsMsg").value.trim();',
    '  if(!msg){alert("Escribi el mensaje primero");return;}',
    '  var phone = prompt("Tu numero de prueba (con +595...):");',
    '  if(!phone) return;',
    '  fetch(BASE+"/api/contacts/load",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({rows:[{name:"TEST",phone:phone}]})})',
    '  .then(function(){return fetch(BASE+"/api/contacts");}).then(function(r){return r.json();})',
    '  .then(function(cs){',
    '    var c = cs.find(function(x){return x.phone===phone;});',
    '    if(!c){alert("Error");return;}',
    '    return fetch(BASE+"/api/sms/blast",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg,delaySeconds:5})})',
    '    .then(function(r){return r.json();}).then(function(d){',
    '      document.getElementById("blastAlert").innerHTML = d.ok ? "<div class=\'alert alert-ok\'>SMS de prueba enviado a "+phone+"</div>" : "<div class=\'alert alert-err\'>Error al enviar</div>";',
    '    });',
    '  });',
    '}',

    'function startPoll(){',
    '  poll = setInterval(function(){',
    '    fetch(BASE+"/api/metrics").then(function(r){return r.json();}).then(function(m){',
    '      var s = m.blastState;',
    '      document.getElementById("mTotal").textContent = m.total;',
    '      document.getElementById("mSent").textContent = m.sent;',
    '      document.getElementById("mClicks").textContent = m.clicked;',
    '      document.getElementById("mFailed").textContent = m.failed;',
    '      document.getElementById("mRate").textContent = m.clickRate+"%";',
    '      var pct = s.total > 0 ? Math.round((s.sent/s.total)*100) : 0;',
    '      document.getElementById("progBar").style.width = pct+"%";',
    '      if(s.running && s.current){',
    '        document.getElementById("progInfo").innerHTML = "Enviando a: <span class=\'hl\'>"+s.current+"</span> &nbsp;·&nbsp; <span class=\'hl\'>"+s.sent+"/"+s.total+"</span> &nbsp;·&nbsp; Proximo en <span class=\'hl\'>"+s.nextIn+"s</span>";',
    '      }',
    '      if(m.recentClicks && m.recentClicks.length){',
    '        document.getElementById("recentClicks").innerHTML = "<div class=\'lbl\' style=\'margin-top:16px\'>CLICKS RECIENTES</div>" + m.recentClicks.map(function(c){return "<div class=\'click-row\'><span class=\'click-name\'>"+c.name+" · "+c.phone+"</span><span class=\'click-time\'>"+c.ts+"</span></div>";}).join("");',
    '      }',
    '      if(!s.running && s.finishedAt){',
    '        stopPoll();',
    '        document.getElementById("progInfo").innerHTML = "Campana completada! <span class=\'hl\'>"+s.sent+" enviados</span> · <span style=\'color:#ff4545\'>"+s.failed+" fallidos</span>";',
    '        document.getElementById("btnSend").disabled = false;',
    '      }',
    '    });',
    '  }, 1000);',
    '}',

    'function stopPoll(){if(poll){clearInterval(poll);poll=null;}}',

    'function resetAll(){',
    '  if(!confirm("Resetear todo? Se borraran contactos, metricas y resultados.")) return;',
    '  fetch(BASE+"/api/reset",{method:"POST"}).then(function(){',
    '    document.getElementById("loadedBox").style.display = "none";',
    '    document.getElementById("dz").style.display = "block";',
    '    document.getElementById("smsMsg").value = "";',
    '    document.getElementById("charCount").textContent = "0";',
    '    document.getElementById("mTotal").textContent = "0";',
    '    document.getElementById("mSent").textContent = "0";',
    '    document.getElementById("mClicks").textContent = "0";',
    '    document.getElementById("mFailed").textContent = "0";',
    '    document.getElementById("mRate").textContent = "0%";',
    '    document.getElementById("recentClicks").innerHTML = "";',
    '    document.getElementById("progWrap").style.display = "none";',
    '    document.getElementById("progInfo").style.display = "none";',
    '    document.getElementById("blastAlert").innerHTML = "";',
    '    document.getElementById("loadAlert").innerHTML = "";',
    '    document.getElementById("btnSend").disabled = false;',
    '    stopPoll();',
    '  });',
    '}',

    'function checkGW(){',
    '  fetch(BASE+"/api/metrics").then(function(r){',
    '    if(r.ok){var e=document.getElementById("gwStatus");e.textContent="● ONLINE";e.style.color="#00e5a0";}',
    '    return r.json();',
    '  }).then(function(m){',
    '    document.getElementById("mTotal").textContent = m.total;',
    '    document.getElementById("mSent").textContent = m.sent;',
    '    document.getElementById("mClicks").textContent = m.clicked;',
    '    document.getElementById("mFailed").textContent = m.failed;',
    '    document.getElementById("mRate").textContent = m.clickRate+"%";',
    '    if(m.total > 0){',
    '      document.getElementById("loadedBox").style.display = "block";',
    '      document.getElementById("loadedNum").textContent = m.total;',
    '      document.getElementById("dz").style.display = "none";',
    '    }',
    '    if(m.blastState && m.blastState.running){',
    '      document.getElementById("progWrap").style.display = "block";',
    '      document.getElementById("progInfo").style.display = "block";',
    '      document.getElementById("btnSend").disabled = true;',
    '      startPoll();',
    '    }',
    '  }).catch(function(){',
    '    var e=document.getElementById("gwStatus");e.style.color="#ff4545";e.textContent="● OFFLINE";',
    '  });',
    '}',

    'checkGW();',
    'setInterval(function(){',
    '  if(!poll){',
    '    fetch(BASE+"/api/metrics").then(function(r){return r.json();}).then(function(m){',
    '      document.getElementById("mClicks").textContent = m.clicked;',
    '      document.getElementById("mRate").textContent = m.clickRate+"%";',
    '      if(m.recentClicks && m.recentClicks.length){',
    '        document.getElementById("recentClicks").innerHTML = "<div class=\'lbl\' style=\'margin-top:16px\'>CLICKS RECIENTES</div>" + m.recentClicks.map(function(c){return "<div class=\'click-row\'><span class=\'click-name\'>"+c.name+" · "+c.phone+"</span><span class=\'click-time\'>"+c.ts+"</span></div>";}).join("");',
    '      }',
    '    });',
    '  }',
    '}, 10000);',
    '<\/script>',
    '</body>',
    '</html>'
  ];
  res.send(lines.join('\n'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("SMS Tracker corriendo en puerto " + PORT); });
