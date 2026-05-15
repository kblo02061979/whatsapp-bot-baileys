const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const app = express();

let sock = null;
let lastQR = null;
let connectionStatus = "disconnected";
let myJid = null;

app.use(cors());
app.use(express.json());

// LIMPEZA TOTAL DA SESSÃO
const sessionDir = './sessions';
if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    console.log('🗑️ Sessão completamente removida!');
}

if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
}

async function startWhatsApp() {
    try {
        console.log("🚀 Iniciando WhatsApp...");
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        console.log("✅ Auth state carregado");
        
        sock = makeWASocket({
            auth: state,
            browser: ["Chrome", "Linux", "128.0"],
            printQRInTerminal: true
        });
        
        sock.ev.on("creds.update", saveCreds);
        
        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            console.log("📡 Update:", { connection, hasQR: !!qr });
            
            if (qr) {
                console.log("✅✅✅ QR Code GERADO! ✅✅✅");
                try {
                    lastQR = await qrcode.toDataURL(qr);
                    console.log("✅ QR convertido para imagem!");
                } catch (err) {
                    console.error("Erro converter QR:", err);
                }
            }
            
            if (connection === "open") {
                connectionStatus = "connected";
                myJid = sock.user?.id;
                lastQR = null;
                console.log("🎉 CONECTADO! JID:", myJid);
            }
            
            if (connection === "close") {
                connectionStatus = "disconnected";
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log("🔌 Desconectado. Reconectar?", shouldReconnect);
                if (shouldReconnect) {
                    setTimeout(startWhatsApp, 5000);
                }
            }
            
            if (connection === "connecting") {
                connectionStatus = "connecting";
                console.log("🔄 Conectando...");
            }
        });
        
        // RESPOSTAS AUTOMÁTICAS
        sock.ev.on("messages.upsert", async (m) => {
            const msg = m.messages?.[0];
            if (!msg || msg.key.fromMe) return;
            
            const from = msg.key.remoteJid;
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
            
            if (!text) return;
            
            console.log("📩 Mensagem de", from, ":", text);
            
            const lowerText = text.toLowerCase();
            
            if (lowerText === "oi" || lowerText === "olá") {
                await sock.sendMessage(from, { text: "Olá! 👋 Bot online! Digite 'ajuda' para comandos." });
            } else if (lowerText === "ajuda" || lowerText === "menu") {
                await sock.sendMessage(from, { 
                    text: `📋 *Comandos:*\n\n• *oi/olá* - Saudação\n• *status* - Verifica se estou online\n• *agendar <texto>* - Agendamento\n• *ajuda* - Esta lista` 
                });
            } else if (lowerText === "status") {
                await sock.sendMessage(from, { text: `✅ Bot online! Conectado como: ${myJid?.split("@")[0] || "Desconhecido"}` });
            } else if (lowerText.startsWith("agendar")) {
                const desc = text.substring(8).trim() || "Sem descrição";
                await sock.sendMessage(from, { text: `✅ Agendamento recebido!\n📅 ${desc}\n⏰ ${new Date().toLocaleString('pt-BR')}\n\nEm breve confirmamos.` });
            } else {
                await sock.sendMessage(from, { text: "Olá! 👋 Digite *ajuda* para ver os comandos." });
            }
        });
        
    } catch (error) {
        console.error("Erro no startWhatsApp:", error);
        setTimeout(startWhatsApp, 5000);
    }
}

// ROTA PRINCIPAL
app.get("/", (req, res) => {
    const statusText = connectionStatus === "connected" ? "✅ Conectado" : 
                       connectionStatus === "connecting" ? "🔄 Conectando..." : "❌ Desconectado";
    
    let qrHtml = '';
    if (lastQR) {
        qrHtml = `<img src="${lastQR}" style="max-width:280px; border-radius:10px;">`;
    } else if (connectionStatus === "connected") {
        qrHtml = `<p>✅ Bot conectado! JID: ${myJid || '-'}</p>`;
    } else {
        qrHtml = `<p>⏳ Aguardando QR Code...<br><small>Atualize a página</small></p>`;
    }
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="5">
    <title>WhatsApp Bot</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            text-align: center;
            padding: 50px;
            background: linear-gradient(135deg, #075e54, #128c7e);
        }
        .container {
            background: white;
            max-width: 400px;
            margin: auto;
            padding: 30px;
            border-radius: 20px;
        }
        h1 { color: #075e54; }
        .status { font-size: 1.2rem; margin: 20px 0; }
        .qr-box { margin: 20px 0; }
        button {
            background: #075e54;
            color: white;
            padding: 10px 20px;
            border: none;
            border-radius: 25px;
            cursor: pointer;
            margin: 5px;
        }
        button:hover { background: #054a42; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 WhatsApp Bot</h1>
        <div class="status">Status: ${statusText}</div>
        <div class="qr-box">${qrHtml}</div>
        <button onclick="location.reload()">🔄 Atualizar</button>
        <button onclick="fetch('/reset',{method:'POST'}).then(()=>location.reload())">⚠️ Resetar</button>
        <p style="font-size:12px; margin-top:20px;">
            📱 WhatsApp > Configurações > Dispositivos vinculados
        </p>
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
        connectionStatus = "disconnected";
        setTimeout(() => startWhatsApp(), 1000);
        res.json({ ok: true });
    } catch(e) {
        res.json({ ok: false });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Servidor rodando na porta ${PORT}`);
    console.log(`📱 Acesse: http://localhost:${PORT}`);
});

startWhatsApp();
