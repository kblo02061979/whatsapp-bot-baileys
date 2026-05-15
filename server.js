import express from "express";
import cors from "cors";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// CONFIGURAÇÕES
// ============================================
const PORT = process.env.PORT || 3000;
const SESSION_DIR = process.env.SESSION_DIR || "./sessions/default";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || "default";

// ============================================
// INICIALIZAÇÃO
// ============================================
const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const app = express();

let sock = null;
let lastQRDataURL = null;
let connectionStatus = "disconnected";
let myJid = null;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// FUNÇÃO PARA LIMPAR SESSÃO (se necessário)
// ============================================
function clearSessionIfNeeded() {
    const forceClear = process.env.FORCE_CLEAR_SESSION === "true";
    if (forceClear) {
        const sessionPath = './sessions';
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log('🗑️ Sessão antiga removida por FORCE_CLEAR_SESSION!');
        }
    }
}

// ============================================
// FUNÇÃO PRINCIPAL DO WHATSAPP
// ============================================
async function startWhatsApp() {
    clearSessionIfNeeded();
    
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // QR também aparece no log
        browser: ["Chrome", "Linux", "128.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // 🔹 Quando o QR for gerado
        if (qr) {
            lastQRDataURL = await qrcode.toDataURL(qr);
            console.log("🔹 QR gerado!");
            
            // Salva no terminal também (texto)
            console.log("📱 QR Code (texto):");
            console.log(qr);

            if (supabase) {
                const { error } = await supabase.from("sessoes_do_whatsapp").upsert({
                    id_do_usuario: DEFAULT_USER_ID,
                    qr_code: qr,
                    status: "connecting",
                    atualizacao: new Date().toISOString()
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
                const { error } = await supabase.from("sessoes_do_whatsapp").upsert({
                    id_do_usuario: DEFAULT_USER_ID,
                    status: "connected",
                    jid: myJid,
                    numero: phoneNumber,
                    atualizacao: new Date().toISOString()
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
                const { error } = await supabase.from("sessoes_do_whatsapp").upsert({
                    id_do_usuario: DEFAULT_USER_ID,
                    status: "disconnected",
                    atualizacao: new Date().toISOString()
                });
                if (error) console.error("Erro ao atualizar status no Supabase:", error);
            }

            if (shouldReconnect) {
                console.log("🔄 Tentando reconectar em 5 segundos...");
                setTimeout(startWhatsApp, 5000);
            }
        }

        else if (connection === "connecting") {
            connectionStatus = "connecting";
            console.log("🔄 Conectando ao WhatsApp...");
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
        
        console.log("📩 Mensagem recebida de:", from, "→", text);

        // Comando: agendar
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
            
            await sock.sendMessage(from, { 
                text: "✅ Recebi seu pedido de agendamento! Em breve confirmo o horário. 📅" 
            });
            return;
        }

        // Comando: /start ou ajuda
        if (text.toLowerCase() === "/start" || text.toLowerCase() === "ajuda") {
            await sock.sendMessage(from, { 
                text: "🤖 *Olá! Sou a atendente virtual.*\n\n" +
                      "*Comandos disponíveis:*\n" +
                      "📅 `agendar <descrição>` - Faz um agendamento\n" +
                      "❓ `ajuda` - Mostra esta mensagem\n" +
                      "📊 `status` - Verifica se estou online\n\n" +
                      "Em breve mais funcionalidades!"
            });
            return;
        }

        // Comando: status
        if (text.toLowerCase() === "status") {
            await sock.sendMessage(from, { 
                text: `✅ *Bot está online!*\n\n📱 Conectado como: ${myJid || "Desconhecido"}\n⏰ Ativo 24/7` 
            });
            return;
        }

        // Resposta padrão
        await sock.sendMessage(from, { 
            text: "Olá! 👋 Sou a atendente virtual.\n\n" +
                  "Envie *agendar <detalhes>* para agendar algo 📅\n" +
                  "ou *ajuda* para ver todos os comandos disponíveis." 
        });
    });
}

// ============================================
// ROTAS HTTP
// ============================================

// Rota principal - HTML completo
app.get("/", (_req, res) => {
    res.type("html").send(`
<!DOCTYPE html>
<html lang="pt-br">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
    <title>WhatsApp Bot - Baileys</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
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
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            overflow: hidden;
            animation: fadeIn 0.5s ease;
        }

        @keyframes fadeIn {
            from {
                opacity: 0;
                transform: translateY(20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .header {
            background: #075e54;
            color: white;
            padding: 24px 20px;
            text-align: center;
        }

        .header h1 {
            font-size: 1.5rem;
            font-weight: 600;
            margin-bottom: 8px;
        }

        .header p {
            font-size: 0.85rem;
            opacity: 0.9;
        }

        .status-card {
            padding: 20px;
            background: #f8f9fa;
            border-bottom: 1px solid #e9ecef;
        }

        .status-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 0;
            border-bottom: 1px solid #e9ecef;
        }

        .status-item:last-child {
            border-bottom: none;
        }

        .status-label {
            font-weight: 600;
            color: #495057;
        }

        .status-value {
            font-family: 'Courier New', monospace;
            font-size: 0.85rem;
            color: #212529;
            word-break: break-all;
            text-align: right;
            max-width: 60%;
        }

        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.75rem;
            font-weight: 600;
        }

        .badge-connected {
            background: #d4edda;
            color: #155724;
        }

        .badge-disconnected {
            background: #f8d7da;
            color: #721c24;
        }

        .badge-connecting {
            background: #fff3cd;
            color: #856404;
        }

        .qr-section {
            padding: 30px 20px;
            text-align: center;
            background: white;
        }

        .qr-container {
            background: white;
            padding: 20px;
            border-radius: 16px;
            display: inline-block;
            margin-bottom: 20px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        }

        .qr-container img {
            max-width: 280px;
            width: 100%;
            height: auto;
            border-radius: 12px;
        }

        .qr-placeholder {
            padding: 40px;
            background: #f8f9fa;
            border-radius: 16px;
            color: #6c757d;
            font-size: 0.9rem;
        }

        .loading-spinner {
            display: inline-block;
            width: 40px;
            height: 40px;
            border: 3px solid #f3f3f3;
            border-top: 3px solid #075e54;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 15px;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

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
            transition: all 0.3s ease;
            background: #075e54;
            color: white;
        }

        button:hover {
            background: #054a42;
            transform: translateY(-2px);
        }

        button.secondary {
            background: #6c757d;
        }

        button.secondary:hover {
            background: #5a6268;
        }

        button.danger {
            background: #dc3545;
        }

        button.danger:hover {
            background: #c82333;
        }

        .info-text {
            font-size: 0.8rem;
            color: #6c757d;
            margin-top: 15px;
            text-align: center;
        }

        .footer {
            background: #f8f9fa;
            padding: 15px;
            text-align: center;
            font-size: 0.7rem;
            color: #6c757d;
            border-top: 1px solid #e9ecef;
        }

        .success-box {
            background: #d4edda;
            padding: 15px;
            border-radius: 12px;
            margin-top: 15px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 WhatsApp Bot</h1>
            <p>Baileys Framework - 24/7 Online</p>
        </div>

        <div class="status-card">
            <div class="status-item">
                <span class="status-label">Status da Conexão:</span>
                <span class="status-value" id="statusDisplay">
                    <span class="badge badge-disconnected">Desconectado</span>
                </span>
            </div>
            <div class="status-item">
                <span class="status-label">Meu JID:</span>
                <span class="status-value" id="jidDisplay">-</span>
            </div>
            <div class="status-item">
                <span class="status-label">Última Atualização:</span>
                <span class="status-value" id="lastUpdate">-</span>
            </div>
        </div>

        <div class="qr-section" id="qrSection">
            <div id="qrContent">
                <div class="qr-placeholder">
                    <div class="loading-spinner"></div>
                    <p>🔄 Carregando QR Code...</p>
                    <p style="font-size: 0.8rem; margin-top: 10px;">Aguarde, gerando código de conexão</p>
                </div>
            </div>
            <div class="button-group">
                <button onclick="refreshQR()" class="secondary">🔄 Atualizar QR</button>
                <button onclick="checkStatus()">📊 Verificar Status</button>
                <button onclick="resetConnection()" class="danger">⚠️ Resetar Conexão</button>
            </div>
            <div class="info-text">
                💡 <strong>Como conectar:</strong><br>
                1. Abra WhatsApp > Configurações > Dispositivos vinculados<br>
                2. Toque em "Linkar um dispositivo"<br>
                3. Escaneie o QR Code acima
            </div>
        </div>

        <div class="footer">
            <p>🤖 Bot rodando 24/7 | 🔄 Auto-reconnect ativo</p>
        </div>
    </div>

    <script>
        let refreshInterval = null;
        let isQRVisible = false;

        async function checkStatus() {
            try {
                const response = await fetch('/status');
                const data = await response.json();
                
                updateStatusUI(data);
                
                if (data.status === 'connected') {
                    if (refreshInterval) {
                        clearInterval(refreshInterval);
                        refreshInterval = null;
                    }
                    document.getElementById('qrContent').innerHTML = \`
                        <div class="success-box">
                            ✅ <strong>Bot Conectado!</strong><br>
                            <p style="margin-top: 10px;">O bot está online e respondendo mensagens.</p>
                            <p style="margin-top: 5px; font-size: 0.8rem;">JID: \${data.jid || '-'}</p>
                        </div>
                    \`;
                } else if (data.status === 'disconnected' && !isQRVisible) {
                    loadQRCode();
                }
                
                return data;
            } catch (error) {
                console.error('Erro ao verificar status:', error);
                document.getElementById('statusDisplay').innerHTML = '<span class="badge badge-disconnected">Erro na conexão</span>';
            }
        }

        function updateStatusUI(data) {
            const statusDisplay = document.getElementById('statusDisplay');
            const jidDisplay = document.getElementById('jidDisplay');
            const lastUpdate = document.getElementById('lastUpdate');
            
            let statusHtml = '';
            if (data.status === 'connected') {
                statusHtml = '<span class="badge badge-connected">✅ Conectado</span>';
            } else if (data.status === 'connecting') {
                statusHtml = '<span class="badge badge-connecting">🔄 Conectando...</span>';
            } else {
                statusHtml = '<span class="badge badge-disconnected">❌ Desconectado</span>';
            }
            
            statusDisplay.innerHTML = statusHtml;
            jidDisplay.textContent = data.jid || '-';
            lastUpdate.textContent = new Date().toLocaleTimeString('pt-BR');
        }

        async function loadQRCode() {
            try {
                const response = await fetch('/qr-data');
                const data = await response.json();
                
                if (data.qr) {
                    isQRVisible = true;
                    document.getElementById('qrContent').innerHTML = \`
                        <div class="qr-container">
                            <img src="\${data.qr}" alt="QR Code para conexão">
                        </div>
                        <div class="info-text" style="background: #e8f5e9; padding: 10px; border-radius: 10px;">
                            ✅ QR Code gerado! Escaneie com seu WhatsApp.
                        </div>
                    \`;
                } else if (data.status === 'connected') {
                    document.getElementById('qrContent').innerHTML = \`
                        <div class="success-box">
                            ✅ <strong>Bot já está conectado!</strong><br>
                            <p style="margin-top: 10px;">Não é necessário escanear QR Code.</p>
                        </div>
                    \`;
                } else {
                    document.getElementById('qrContent').innerHTML = \`
                        <div class="qr-placeholder">
                            <p>⏳ Aguardando QR Code...</p>
                            <p style="font-size: 0.8rem; margin-top: 10px;">O bot está iniciando a conexão</p>
                            <button onclick="loadQRCode()" style="margin-top: 15px;">Tentar novamente</button>
                        </div>
                    \`;
                    isQRVisible = false;
                }
            } catch (error) {
                console.error('Erro ao carregar QR:', error);
                document.getElementById('qrContent').innerHTML = \`
                    <div class="qr-placeholder">
                        <p>❌ Erro ao carregar QR Code</p>
                        <button onclick="loadQRCode()" style="margin-top: 15px;">Tentar novamente</button>
                    </div>
                \`;
            }
        }

        async function refreshQR() {
            try {
                await fetch('/refresh-qr', { method: 'POST' });
                document.getElementById('qrContent').innerHTML = \`
                    <div class="qr-placeholder">
                        <div class="loading-spinner"></div>
                        <p>🔄 Solicitando novo QR Code...</p>
                    </div>
                \`;
                isQRVisible = false;
                setTimeout(() => loadQRCode(), 2000);
            } catch (error) {
                console.error('Erro ao dar refresh:', error);
            }
        }

        async function resetConnection() {
            if (confirm('⚠️ ATENÇÃO: Isso vai desconectar o bot e forçar uma nova conexão. Você precisará escanear o QR Code novamente. Continuar?')) {
                try {
                    await fetch('/reset-connection', { method: 'POST' });
                    document.getElementById('qrContent').innerHTML = \`
                        <div class="qr-placeholder">
                            <div class="loading-spinner"></div>
                            <p>🔄 Resetando conexão...</p>
                        </div>
                    \`;
                    isQRVisible = false;
                    setTimeout(() => {
                        checkStatus();
                        loadQRCode();
                    }, 3000);
                } catch (error) {
                    console.error('Erro ao resetar:', error);
                }
            }
        }

        setInterval(() => {
            checkStatus();
        }, 10000);

        setInterval(() => {
            checkStatus().then(data => {
                if (data.status === 'disconnected' && !isQRVisible) {
                    loadQRCode();
                }
            });
        }, 5000);

        checkStatus();
        loadQRCode();
    </script>
</body>
</html>
    `);
});

// Rota do QR Code (HTML simplificado com refresh)
app.get("/qr", (_req, res) => {
    const img = lastQRDataURL
        ? `<img src="${lastQRDataURL}" style="max-width:360px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.15)" />`
        : `<p>⏳ Nenhum QR disponível. Aguardando conexão...</p>`;
    
    res.type("html").send(`
        <html>
            <head>
                <meta charset="utf-8" />
                <meta http-equiv="refresh" content="5">
                <title>QR Code – WhatsApp Bot</title>
                <style>
                    body {
                        font-family: system-ui;
                        display: grid;
                        place-items: center;
                        height: 100vh;
                        margin: 0;
                        background: linear-gradient(135deg, #075e54 0%, #128c7e 100%);
                    }
                    .container {
                        text-align: center;
                        background: white;
                        padding: 30px;
                        border-radius: 20px;
                        box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                    }
                    img {
                        max-width: 300px;
                        border-radius: 12px;
                    }
                    p {
                        color: #666;
                        margin-top: 15px;
                    }
                    a {
                        color: #075e54;
                        text-decoration: none;
                        font-weight: 600;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    ${img}
                    <p>🔄 Atualiza automaticamente a cada 5 segundos</p>
                    <p><a href="/">← Voltar ao painel</a></p>
                </div>
            </body>
        </html>
    `);
});

// API: Status em JSON
app.get("/status", (_req, res) => {
    res.json({
        status: connectionStatus,
        jid: myJid || null,
        timestamp: new Date().toISOString()
    });
});

// API: Dados do QR Code
app.get("/qr-data", (_req, res) => {
    if (lastQRDataURL) {
        res.json({ qr: lastQRDataURL, status: "qr_available" });
    } else if (connectionStatus === "connected") {
        res.json({ qr: null, status: "connected" });
    } else {
        res.json({ qr: null, status: "waiting" });
    }
});

// API: Forçar novo QR Code
app.post("/refresh-qr", async (_req, res) => {
    try {
        if (sock) {
            sock.end(new Error("Forçando novo QR Code"));
        }
        
        const sessionPath = './sessions';
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        
        lastQRDataURL = null;
        setTimeout(() => startWhatsApp(), 2000);
        res.json({ ok: true, message: "QR Code reiniciado" });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// API: Resetar conexão completa
app.post("/reset-connection", async (_req, res) => {
    try {
        if (sock) {
            sock.end(new Error("Resetando conexão"));
        }
        
        const sessionPath = './sessions';
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        
        lastQRDataURL = null;
        connectionStatus = "disconnected";
        myJid = null;
        
        setTimeout(() => startWhatsApp(), 3000);
        res.json({ ok: true, message: "Conexão resetada" });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// API: Enviar mensagem via POST
app.post("/send", async (req, res) => {
    try {
        const { to, message } = req.body;
        
        if (!sock) {
            return res.status(400).json({ ok: false, error: "Socket indisponível" });
        }
        
        if (!to || !message) {
            return res.status(400).json({ ok: false, error: "Informe 'to' e 'message'" });
        }
        
        const jid = to.includes("@s.whatsapp.net") ? to : (to + "@s.whatsapp.net");
        await sock.sendMessage(jid, { text: message });
        
        res.json({ ok: true, message: "Mensagem enviada com sucesso" });
    } catch (error) {
        console.error("Erro ao enviar mensagem:", error);
        res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
});

// ============================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================
app.listen(PORT, () => {
    console.log(`
    ╔════════════════════════════════════════════╗
    ║     🤖 WhatsApp Bot - Baileys             ║
    ║    Servidor rodando na porta ${PORT}         ║
    ╠════════════════════════════════════════════╣
    ║  📱 Painel: http://localhost:${PORT}         ║
    ║  🔗 QR Code: http://localhost:${PORT}/qr     ║
    ╚════════════════════════════════════════════╝
    `);
});

// Inicia o WhatsApp
startWhatsApp().catch(err => {
    console.error("❌ Falha ao iniciar WhatsApp:", err);
});
