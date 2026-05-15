import express from "express";
import cors from "cors";
import makeWASocket, { useMultiFileAuthState, DisconnectReason, makeInMemoryStore } from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import fs from "fs";
import path from "path";

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

// Cria diretório de sessão
if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
}

// Store opcional para debug
const store = makeInMemoryStore({ 
    logger: console 
});

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    sock = makeWASocket({
        auth: state,
        browser: ["Chrome", "Linux", "128.0"],
        printQRInTerminal: false,
        logger: console,
        version: [2, 3000, 1015901307] // Versão específica que funciona
    });
    
    store?.bind(sock.ev);
    
    sock.ev.on("creds.update", saveCreds);
    
    // Evento para QR Code
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log("📡 Update:", { connection, hasQR: !!qr });
        
        // QUANDO O QR CHEGA
        if (qr) {
            console.log("✅✅✅ QR CODE RECEBIDO! ✅✅✅");
            // Converte para DataURL
            lastQR = await qrcode.toDataURL(qr);
            console.log("QR gerado com sucesso!");
        }
        
        // CONECTADO COM SUCESSO
        if (connection === "open") {
            connectionStatus = "connected";
            myJid = sock.user?.id;
            lastQR = null;
            console.log("🎉 CONECTADO COM SUCESSO! 🎉");
            console.log("📱 Seu JID:", myJid);
        }
        
        // FALHA NA CONEXÃO
        if (connection === "close") {
            connectionStatus = "disconnected";
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("🔌 Conexão fechada. Reconectar?", shouldReconnect);
            if (shouldReconnect) {
                console.log("Tentando reconectar em 3 segundos...");
                setTimeout(startWhatsApp, 3000);
            }
        }
        
        if (connection === "connecting") {
            connectionStatus = "connecting";
            console.log("🔄 Conectando ao WhatsApp...");
        }
    });
    
    // EVENTO DE MENSAGENS
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages?.[0];
        if (!msg || msg.key.fromMe) return;
        
        const from = msg.key.remoteJid;
        const text = msg.message?.conversation 
            || msg.message?.extendedTextMessage?.text 
            || "";
        
        if (!text) return;
        
        console.log("📩 Mensagem de:", from, ":", text);
        
        // Comandos do bot
        if (text.toLowerCase() === "oi" || text.toLowerCase() === "olá") {
            await sock.sendMessage(from, { text: "Olá! 👋 Bot online! Envie 'ajuda' para ver os comandos." });
        } 
        else if (text.toLowerCase() === "ajuda" || text.toLowerCase() === "menu") {
            await sock.sendMessage(from, { 
                text: `📋 *Comandos disponíveis:*\n\n` +
                      `• *oi/olá* - Saudação\n` +
                      `• *status* - Verifica se estou online\n` +
                      `• *agendar <descrição>* - Faz um agendamento\n` +
                      `• *ajuda* - Mostra esta mensagem\n\n` +
                      `Exemplo: *agendar Consulta dia 20/05*` 
            });
        }
        else if (text.toLowerCase() === "status") {
            await sock.sendMessage(from, { text: `✅ Bot online! Conectado como: ${myJid?.split("@")[0] || "Desconhecido"}` });
        }
        else if (text.toLowerCase().startsWith("agendar")) {
            const desc = text.substring(8).trim();
            await sock.sendMessage(from, { text: `✅ Agendamento recebido!\n\n📅 ${desc}\n\nEm breve confirmaremos o horário.` });
        }
        else {
            await sock.sendMessage(from, { 
                text: "Olá! 👋 Envie *ajuda* para ver todos os comandos disponíveis." 
            });
        }
    });
}

// ============================================
// ROTAS HTTP
// ============================================

app.get("/", (req, res) => {
    const statusText = connectionStatus === "connected" ? "✅ Conectado" : 
                       connectionStatus === "connecting" ? "🔄 Conectando..." : "❌ Desconectado";
    const statusColor = connectionStatus === "connected" ? "#28a745" : 
                        connectionStatus === "connecting" ? "#ffc107" : "#dc3545";
    
    let qrHtml = '';
    if (lastQR) {
        qrHtml = `
            <div style="background:#f5f5f5; padding:20px; border-radius:10px; margin:20px 0;">
                <img src="${lastQR}" style="max-width:280px; width:100%; border-radius:10px;">
                <p style="margin-top:10px;"><strong>📱 Escaneie o QR Code com seu WhatsApp</strong></p>
            </div>
        `;
    } else if (connectionStatus === "connected") {
        qrHtml = `
            <div style="background:#d4edda; padding:20px; border-radius:10px; margin:20px 0; color:#155724;">
                <p>✅ <strong>Bot já está conectado!</strong></p>
                <p>📱 JID: ${myJid || '-'}</p>
                <p>💬 Envie uma mensagem para testar!</p>
            </div>
        `;
    } else {
        qrHtml = `
            <div style="background:#f8f9fa; padding:20px; border-radius:10px; margin:20px 0;">
                <div style="display:inline-block; width:40px; height:40px; border:3px solid #f3f3f3; border-top:3px solid #075e54; border-radius:50%; animation:spin 1s linear infinite;"></div>
                <p style="margin-top:10px;">⏳ Aguardando QR Code...</p>
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
    <title>WhatsApp Bot - Painel</title>
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
            animation: fadeIn 0.5s ease;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
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
            flex-wrap: wrap;
        }
        button {
            padding: 10px 20px;
            border: none;
            border-radius: 25px;
            font-size: 0.9rem;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.3s;
            background: #075e54;
            color: white;
        }
        button:hover { background: #054a42; transform: translateY(-2px); }
        button.secondary { background: #6c757d; }
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
            <p>Baileys Framework - 24/7 Online</p>
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
                💡 <strong>Como conectar:</strong><br>
                1. Abra WhatsApp > Configurações > Dispositivos vinculados<br>
                2. Toque em "Linkar um dispositivo"<br>
                3. Escaneie o QR Code acima
            </div>
        </div>
    </div>
    <script>
        async function resetBot() {
            if(confirm('⚠️ Isso vai desconectar o bot. Continuar?')) {
                await fetch('/reset', { method: 'POST' });
                location.reload();
            }
        }
    </script>
</body>
</html>
    `);
});

app.get("/qr", (req, res) => {
    if (lastQR) {
        res.send(`<img src="${lastQR}" style="max-width:300px;">`);
    } else {
        res.send("Aguardando QR Code...");
    }
});

app.get("/status", (req, res) => {
    res.json({ status: connectionStatus, jid: myJid });
});

app.post("/reset", async (req, res) => {
    try {
        if (sock) sock.end(new Error("Reset manual"));
        if (fs.existsSync('./sessions')) {
            fs.rmSync('./sessions', { recursive: true, force: true });
        }
        lastQR = null;
        connectionStatus = "disconnected";
        setTimeout(() => startWhatsApp(), 2000);
        res.json({ ok: true });
    } catch(e) {
        res.json({ ok: false, error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║     🤖 WhatsApp Bot Rodando!          ║
║     Porta: ${PORT}                        ║
║     Painel: http://localhost:${PORT}      ║
╚════════════════════════════════════════╝
    `);
});

startWhatsApp().catch(console.error);
