const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs');

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
            printQRInTerminal: true,
            logger: console
        });
        
        sock.ev.on("creds.update", saveCreds);
        
        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            console.log("📡 Update:", { connection, hasQR: !!qr });
            
            if (qr) {
                console.log("✅✅✅ QR Code GERADO! ✅✅✅");
                try {
                    lastQR = await qrcode.toDataURL(qr);
                    console.log("QR convertido para imagem!");
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
    const statusColor = connectionStatus === "connected" ? "#28a745" : 
                        connectionStatus === "connecting" ? "#ffc107" : "#dc3545";
    
    let qrHtml = '';
    if (lastQR) {
        qrHtml = `
            <div style="background:#f5f5f5; padding:20px; border-radius:12px; margin:20px 0;">
                <img src="${lastQR}" style="max-width:280px; width:100%; border-radius:10px;">
                <p style="margin-top:12px;"><strong>📱 Escaneie o QR Code com seu WhatsApp</strong></p>
            </div>
        `;
    } else if (connectionStatus === "connected") {
        qrHtml = `
            <div style="background:#d4edda; padding:15px; border-radius:12px; margin:20px 0; color:#155724;">
                <p>✅ <strong>Bot já está conectado!</strong></p>
                <p>📱 JID: ${myJid || '-'}</p>
                <p>💬 Envie uma mensagem para testar!</p>
            </div>
        `;
    } else {
        qrHtml = `
            <div style="background:#f8f9fa; padding:20px; border-radius:12px; margin:20px 0; text-align:center;">
                <div style="display:inline-block; width:40px; height:40px; border:3px solid #f3f3f3; border-top:3px solid #075e54; border-radius:50%; animation:spin 1s linear infinite;"></div>
                <p style="margin-top:12px;">⏳ Aguardando QR Code...</p>
                <p style="font-size:12px; color:#666;">Atualize a página em alguns segundos</p>
            </div>
        `;
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
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #075e54 0%, #128c7e 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .container {
            max-width: 500px;
            width: 100%;
            background: white;
            border-radius: 32px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        .header {
            background: #075e54;
            color: white;
            padding: 24px 20px;
            text-align: center;
        }
        .header h1 { font-size: 1.5rem; margin-bottom: 8px; }
        .content { padding: 24px; }
        .status-box {
            background: ${statusColor}20;
            border-left: 4px solid ${statusColor};
            padding: 15px;
            border-radius: 12px;
            margin-bottom: 20px;
            text-align: center;
        }
        .status-text { font-size: 1.2rem; font-weight: bold; color: ${statusColor}; }
        .button-group {
            display: flex;
            gap: 12px;
            justify-content: center;
            margin-top: 20px;
        }
        button {
            padding: 10px 20px;
            border: none;
            border-radius: 25px;
            font-size: 0.9rem;
            font-weight: 500;
            cursor: pointer;
            background: #075e54;
            color: white;
        }
        button:hover { background: #054a42; }
        button.danger { background: #dc3545; }
        .info {
            font-size: 0.75rem;
            color: #6c757d;
            text-align: center;
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid #e9ecef;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 WhatsApp Bot</h1>
            <p>Baileys - 24/7</p>
        </div>
        <div class="content">
            <div class="status-box">
                <div class="status-text">${statusText}</div>
                ${myJid ? `<div style="font-size:12px; margin-top:8px;">📱 ${myJid}</div>` : ''}
            </div>
            ${qrHtml}
            <div class="button-group">
                <button onclick="location.reload()">🔄 Atualizar</button>
                <button onclick="resetBot()" class="danger">⚠️ Resetar</button>
            </div>
            <div class="info">
                💡 WhatsApp > Configurações > Dispositivos vinculados > Linkar um dispositivo
            </div>
        </div>
    </div>
    <script>
        async function resetBot() {
            if(confirm('Resetar conexão?')) {
                await fetch('/reset', { method: 'POST' });
                setTimeout(() => location.reload(), 2000);
            }
        }
    </script>
</body>
</html>
    `);
});

app.get("/status", (req, res) => {
    res.json({ status: connectionStatus, jid: myJid });
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

// Inicia o bot
startWhatsApp();
