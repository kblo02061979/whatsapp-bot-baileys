import express from "express";
import cors from "cors";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import { createClient } from "@supabase/supabase-js";
const fs = require('fs');
const sessionPath = './sessions';
if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
    console.log('✅ Sessão antiga removida!');
}
const PORT = process.env.PORT || 3000;
const SESSION_DIR = process.env.SESSION_DIR || "./sessions/default";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || "default";

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let lastQRDataURL = null;
let connectionStatus = "disconnected";
let myJid = null;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["Chrome", "Linux", "128.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // 🔹 Quando o QR for gerado
    if (qr) {
      lastQRDataURL = await qrcode.toDataURL(qr);
      console.log("🔹 QR gerado, enviando para Supabase...");

      if (supabase) {
        const { error } = await supabase.from("sessões_do_whatsapp").upsert({
          id_do_usuário: DEFAULT_USER_ID,
          qr_code: qr,
          status: "connecting",
          atualização: new Date().toISOString()
        });
        if (error) console.error("❌ Erro ao salvar QR no Supabase:", error);
        else console.log("✅ QR salvo no Supabase!");
      }
    }

    // ✅ Quando a conexão for aberta
    if (connection === "open") {
      connectionStatus = "connected";
      myJid = sock.user?.id || null;
      const phoneNumber = myJid?.split("@")[0]?.replace(/\D/g, "") || null;
      console.log("✅ WhatsApp conectado como:", myJid);
      lastQRDataURL = null;

      if (supabase) {
        const { error } = await supabase.from("sessões_do_whatsapp").upsert({
          id_do_usuário: DEFAULT_USER_ID,
          status: "connected",
          jid: myJid,
          número: phoneNumber,
          atualização: new Date().toISOString()
        });
        if (error) console.error("❌ Erro ao salvar status:", error);
        else console.log(`✅ Status 'connected' salvo no Supabase! Número: ${phoneNumber}`);
      }
    }

    // 🔌 Quando a conexão for fechada
    else if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.error("🔌 Conexão fechada. Reconnect?", shouldReconnect);
      connectionStatus = "disconnected";
      myJid = null;

      if (supabase) {
        const { error } = await supabase.from("sessões_do_whatsapp").upsert({
          id_do_usuário: DEFAULT_USER_ID,
          status: "disconnected",
          atualização: new Date().toISOString()
        });
        if (error) console.error("Erro ao atualizar status no Supabase:", error);
      }

      if (shouldReconnect) setTimeout(startWhatsApp, 2000);
    }

    else if (connection === "connecting") {
      connectionStatus = "connecting";
    }
  });

  // 📩 Receber mensagens
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const text = msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || msg.message?.imageMessage?.caption
      || "";

    if (!text) return;
    console.log("📩", from, "→", text);

    if (text.toLowerCase().startsWith("agendar")) {
      const payload = {
        user_id: DEFAULT_USER_ID,
        cliente_jid: from,
        titulo: "Agendamento WhatsApp",
        detalhes: text,
        starts_at: new Date().toISOString(),
        status: "pending",
        source: "whatsapp"
      };
      if (supabase) {
        const { error } = await supabase.from("agenda").insert([payload]);
        if (error) console.error("Erro ao salvar no Supabase:", error);
      }
      await sock.sendMessage(from, { text: "✅ Recebi seu pedido de agendamento! Em breve confirmo o horário. " });
      return;
    }

    await sock.sendMessage(from, { text: "Olá! Sou a atendente virtual. Envie: agendar <detalhes> 📅" });
  });
}

// 🌐 Rotas HTTP básicas
app.get("/", (_req, res) => {
  res.type("html").send(`
    <html>
      <head><meta charset="utf-8" /></head>
      <body style="font-family: system-ui; padding: 20px">
        <h1>WhatsApp Bot — Baileys</h1>
        <p>Status: <b>${connectionStatus}</b></p>
        <p>Meu JID: <code>${myJid ?? "-"}</code></p>
        <p><a href="/qr">Abrir QR Code</a></p>
      </body>
    </html>
  `);
});

app.get("/qr", (_req, res) => {
  const img = lastQRDataURL
    ? `<img src="${lastQRDataURL}" style="max-width:360px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.15)" />`
    : `<p>Nenhum QR disponível. Talvez já esteja conectado.</p>`;
  res.type("html").send(`
    <html>
      <head><meta charset="utf-8" /><meta http-equiv="refresh" content="5"><title>QR Code – WhatsApp</title></head>
      <body style="font-family:system-ui;display:grid;place-items:center;height:100vh">
        ${img}
        <p style="color:#666">Atualiza automaticamente a cada 5s</p>
        <a href="/">Voltar</a>
      </body>
    </html>
  `);
});

// 📤 Enviar mensagens manualmente via POST
app.post("/send", async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!sock) return res.status(400).json({ ok: false, error: "Socket indisponível" });
    if (!to || !message) return res.status(400).json({ ok: false, error: "Informe 'to' e 'message'" });
    await sock.sendMessage(to.includes("@s.whatsapp.net") ? to : (to + "@s.whatsapp.net"), { text: message });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.listen(PORT, () => console.log(`HTTP server on :${PORT}`));

startWhatsApp().catch(err => console.error("Falha ao iniciar WhatsApp:", err));
