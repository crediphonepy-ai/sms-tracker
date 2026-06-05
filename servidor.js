const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SMS_USER = process.env.SMS_USER || "CLXHSQ";
const SMS_PASS = process.env.SMS_PASS || "g6qz0njve0masq";
const SMS_API  = "https://api.sms-gate.app/3rdparty/v1";
const BASE_URL = process.env.BASE_URL || "https://sms-tracker-production.up.railway.app";

const contacts = {};
const clicks   = [];
const smsLog   = [];

function genId() { return crypto.randomBytes(4).toString("hex").toUpperCase(); }
function now()   { return new Date().toISOString().replace("T", " ").slice(0, 16); }

app.get("/c/:linkId", (req, res) => {
  const { linkId } = req.params;
  const contact = Object.values(contacts).find(c => c.linkId === linkId);
  if (contact) {
    contact.clicked   = true;
    contact.clickedAt = now();
    contact.clickCount = (contact.clickCount || 0) + 1;
    clicks.push({ ts: now(), linkId, name: contact.name, phone: contact.phone });
    console.log("CLICK: " + contact.name);
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
    contacts[id] = {
      id,
      name: row.name || "Cliente",
      phone: row.phone.trim(),
      linkId: genId(),
      clicked: false,
      stopped: false,
      replied: false,
      smsSent: false,
      smsAt: null
    };
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
  const finalMsg = (message || "")
    .replace("{{nombre}}", contact.name.split(" ")[0])
    .replace("{{link}}", trackUrl);
  try {
    const r = await fetch(SMS_API + "/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + Buffer.from(SMS_USER + ":" + SMS_PASS).toString("base64")
      },
      body: JSON.stringify({ message: finalMsg, phoneNumbers: [contact.phone] })
    });
    const data = await r.json();
    if (r.ok) {
      contact.smsSent = true;
      contact.smsAt = now();
      smsLog.push({ ts: now(), name: contact.name, phone: contact.phone, status: "ENVIADO" });
      res.json({ ok: true, trackUrl });
    } else {
      smsLog.push({ ts: now(), name: contact.name, phone: contact.phone, status: "FALLIDO" });
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
    for (const c of targets) {
      const trackUrl = BASE_URL + "/c/" + c.linkId;
      const finalMsg = (message || "")
        .replace("{{nombre}}", c.name.split(" ")[0])
        .replace("{{link}}", trackUrl);
      try {
        const r = await fetch(SMS_API + "/message", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Basic " + Buffer.from(SMS_USER + ":" + SMS_PASS).toString("base64")
          },
          body: JSON.stringify({ message: finalMsg, phoneNumbers: [c.phone] })
        });
        const data = await r.json();
        if (r.ok) {
          c.smsSent = true;
          c.smsAt = now();
          smsLog.push({ ts: now(), name: c.name, phone: c.phone, status: "ENVIADO" });
        } else {
          smsLog.push({ ts: now(), name: c.name, phone: c.phone, status: "FALLIDO" });
        }
      } catch (err) {
        console.log("Error: " + err.message);
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
  const pending = sent.filter(c => !c.clicked && !c.stopped);
  res.json({
    total: all.length,
    sent: sent.length,
    clicked: clicked.length,
    clickRate: sent.length ? ((clicked.length / sent.length) * 100).toFixed(1) : 0,
    stopped: stopped.length,
    pendingFollowUp: pending.length,
    recentClicks: clicks.slice(-10).reverse(),
    smsLog: smsLog.slice(-20).reverse(),
    contacts: all
  });
});

app.get("/api/contacts", (req, res) => {
  res.json(Object.values(contacts));
});

app.get("/health", (req, res) => {
  res.json({ ok: true, contacts: Object.keys(contacts).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SMS Tracker corriendo en puerto " + PORT));
