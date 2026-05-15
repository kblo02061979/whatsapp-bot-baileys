import express from "express";
import cors from "cors";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import fs from "fs";

const PORT = process.env.PORT || 3000;
const app = express();
let sock = null;
let lastQR = null;
let connectionStatus = "disconnected";
let myJid = null;

app.use(cors());
app.use(express.json());

// 🔥 LIMPEZA FORÇADA TOTAL - SEMPRE LIMPA A SESSÃO
const sessionPath = './sessions';
if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
    console.log('🗑️ SESSÃO REMOVIDA COM SUCESSO!');
}

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./sessions');
    
    sock = makeWASocket({
        auth: state,
        browser: ["Chrome", "Linux", "128.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log("📡 Status:", connection, "QR:", !!qr);
        
        // 🔥 QR CODE - FORÇANDO APARECER
        if (qr) {
            lastQR = await qrcode.toDataURL(qr);
            console.log("✅✅✅ QR CODE GERADO! ✅✅✅");
            console.log("URL:", lastQR.substring(0, 100) + "...");
        }
        
        if (connection === "open") {
            connectionStatus = "connected";
            myJid = sock.user?.id;
            lastQR = null;
            console.log("✅ CONECTADO! JID:", myJid);
        }
        
        if (connection === "close") {
            connectionStatus = "disconnected";
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(startWhatsApp, 3000);
        }
        
        if (connection === "connecting") {
            connectionStatus = "connecting";
            console.log("🔄 Conectando...");
        }
    });
    
    // Responde mensagens básicas
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages?.[0];
        if (!msg || msg.key.fromMe) return;
        const from = msg.key.remoteJid;
        const text = msg.message?.conversation || "";
        
        if (text === "oi" || text === "olá") {
            await sock.sendMessage(from, { text: "Olá! Bot online! Envie 'ajuda' para comandos." });
        } else {
            await sock.sendMessage(from, { text: "Bot online! Envie 'ajuda' para ver os comandos." });
        }
    });
}

// ROTA PRINCIPAL - SIMPLES E DIRETA
app.get("/", (req, res) => {
    let qrHtml = '';
    if (lastQR) {
        qrHtml = `<img src="${lastQR}" style="max-width:300px; border-radius:10px;">`;
    } else if (connectionStatus === "connected") {
        qrHtml = '<p style="color:green">✅ BOT CONECTADO! Envie uma mensagem para testar.</p>';
    } else {
        qrHtml = '<p>⏳ Aguardando QR Code... <br><small>Atualize a página em alguns segundos</small></p>';
    }
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="5">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Bot</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            text-align: center;
            padding: 50px;
            background: linear-gradient(135deg, #075e54, #128c7e);
            min-height: 100vh;
            margin: 0;
        }
        .container {
            background: white;
            max-width: 450px;
            margin: auto;
            padding: 30px;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }
        h1 { color: #075e54; margin-bottom: 20px; }
        .status {
            padding: 10px;
            border-radius: 10px;
            margin: 20px 0;
            font-weight: bold;
            background: ${connectionStatus === 'connected' ? '#d4edda' : connectionStatus === 'connecting' ? '#fff3cd' : '#f8d7da'};
            color: ${connectionStatus === 'connected' ? '#155724' : connectionStatus === 'connecting' ? '#856404' : '#721c24'};
        }
        .qr-box {
            background: #f5f5f5;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
        }
        button {
            background: #075e54;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 25px;
            font-size: 16px;
            cursor: pointer;
            margin: 5px;
        }
        button:hover { background: #054a42; }
        .info {
            font-size: 12px;
            color: #666;
            margin-top: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 WhatsApp Bot</h1>
        <div class="status">
            Status: ${connectionStatus === 'connected' ? '✅ Conectado' : connectionStatus === 'connecting' ? '🔄 Conectando...' : '❌ Desconectado'}
        </div>
        <div class="qr-box">
            ${qrHtml}
        </div>
        <button onclick="location.reload()">🔄 Atualizar</button>
        <button onclick="fetch('/reset',{method:'POST'}).then(()=>location.reload())">⚠️ Resetar</button>
        <div class="info">
            💡 Como conectar:<br>
            1. WhatsApp > Configurações > Dispositivos vinculados<br>
            2. Linkar um dispositivo<br>
            3. Escaneie o QR Code
        </div>
    </div>
</body>
</html>
    `);
});

app.post("/reset", async (req, res) => {
    try {
        if (sock) sock.end();
        if (fs.existsSync('./sessions')) {
            fs.rmSync('./sessions', { recursive: true, force: true });
        }
        lastQR = null;
        setTimeout(() => startWhatsApp(), 1000);
        res.json({ ok: true });
    } catch(e) {
        res.json({ ok: false });
    }
});

app.get("/qr", (req, res) => {
    if (lastQR) res.send(`<img src="${lastQR}">`);
    else res.send("Aguardando QR...");
});

app.get("/status", (req, res) => {
    res.json({ status: connectionStatus, jid: myJid });
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

startWhatsApp().catch(console.error);
