import express from "express";
import cors from "cors";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import fs from "fs";

const PORT = process.env.PORT || 3000;
const SESSION_DIR = "./sessions";

const app = express();
let sock = null;
let lastQR = null;
let connectionStatus = "disconnected";
let myJid = null;

app.use(cors());
app.use(express.json());

// LIMPEZA FORÇADA
const sessionPath = './sessions';
if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
    console.log('🗑️ Sessão completamente removida!');
}

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: ["Chrome", "Linux", "128.0"],
        // Força a geração do QR mesmo se houver sessão
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log("📡 Update recebido:", { connection, hasQR: !!qr });
        
        if (qr) {
            lastQR = await qrcode.toDataURL(qr);
            console.log("✅ QR Code GERADO!");
            // Mostra QR no terminal também
            console.log("📱 QR Code (texto para decodificar):");
            console.log(qr);
        }
        
        if (connection === "open") {
            connectionStatus = "connected";
            myJid = sock.user?.id;
            lastQR = null;
            console.log("✅ CONECTADO como:", myJid);
        }
        
        if (connection === "close") {
            connectionStatus = "disconnected";
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("🔌 Desconectado. Reconectar?", shouldReconnect);
            if (shouldReconnect) {
                setTimeout(startWhatsApp, 3000);
            }
        }
        
        if (connection === "connecting") {
            connectionStatus = "connecting";
            console.log("🔄 Conectando...");
        }
    });
    
    // Responde mensagens
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages?.[0];
        if (!msg || msg.key.fromMe) return;
        
        const from = msg.key.remoteJid;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
        
        if (text === "/start" || text === "ajuda") {
            await sock.sendMessage(from, { 
                text: "🤖 Bot online! Envie 'agendar <texto>' para agendar algo." 
            });
        } else if (text.toLowerCase().startsWith("agendar")) {
            await sock.sendMessage(from, { text: "✅ Agendamento recebido!" });
        } else {
            await sock.sendMessage(from, { 
                text: "Olá! Envie 'ajuda' para ver os comandos." 
            });
        }
    });
}

// ============================================
// ROTAS - VERSÃO SIMPLIFICADA QUE FUNCIONA
// ============================================

app.get("/", (req, res) => {
    const statusColor = connectionStatus === "connected" ? "#28a745" : 
                        connectionStatus === "connecting" ? "#ffc107" : "#dc3545";
    const statusText = connectionStatus === "connected" ? "Conectado ✅" :
                       connectionStatus === "connecting" ? "Conectando... 🔄" : "Desconectado ❌";
    
    res.type("html").send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="3">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Bot</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #075e54, #128c7e);
        }
        .container {
            background: white;
            border-radius: 20px;
            padding: 30px;
            text-align: center;
            max-width: 400px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        }
        .status {
            background: ${statusColor};
            color: white;
            padding: 10px;
            border-radius: 10px;
            margin: 20px 0;
            font-weight: bold;
        }
        .qr-box {
            background: #f5f5f5;
            border-radius: 10px;
            padding: 20px;
            margin: 20px 0;
        }
        img {
            max-width: 100%;
            border-radius: 10px;
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
        button:hover {
            background: #054a42;
        }
        .jid {
            font-size: 12px;
            color: #666;
            margin-top: 20px;
            word-break: break-all;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 WhatsApp Bot</h1>
        <div class="status">${statusText}</div>
        
        <div class="qr-box">
            ${lastQR ? `<img src="${lastQR}" alt="QR Code">` : 
              connectionStatus === "connected" ? "<p>✅ Bot já está conectado!</p>" :
              "<p>⏳ Aguardando QR Code... <br>Atualize a página em alguns segundos.</p>"}
        </div>
        
        <button onclick="location.reload()">🔄 Atualizar</button>
        <button onclick="fetch('/reset-connection', {method:'POST'}).then(()=>location.reload())">
            ⚠️ Resetar Conexão
        </button>
        
        ${myJid ? `<div class="jid">📱 JID: ${myJid}</div>` : ""}
        
        <p style="font-size:12px; color:#999; margin-top:20px;">
            Para conectar: WhatsApp > Dispositivos vinculados > Linkar um dispositivo
        </p>
    </div>
</body>
</html>
    `);
});

app.get("/qr", (req, res) => {
    if (lastQR) {
        res.send(`<img src="${lastQR}">`);
    } else {
        res.send("Aguardando QR Code...");
    }
});

app.get("/status", (req, res) => {
    res.json({ status: connectionStatus, jid: myJid });
});

app.post("/reset-connection", async (req, res) => {
    try {
        if (sock) sock.end(new Error("Reset manual"));
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        lastQR = null;
        connectionStatus = "disconnected";
        setTimeout(() => startWhatsApp(), 1000);
        res.json({ ok: true });
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════╗
║  🤖 WhatsApp Bot Rodando     ║
║  Porta: ${PORT}                  ║
║  Painel: http://localhost:${PORT} ║
╚══════════════════════════════╝
    `);
});

startWhatsApp().catch(console.error);
