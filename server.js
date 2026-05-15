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

// LIMPEZA FORÇADA da sessão (se ativada via variável de ambiente)
const forceClear = process.env.FORCE_CLEAR_SESSION === "true";
const sessionPath = './sessions';

if (forceClear && fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
    console.log('🗑️ Sessão completamente removida por FORCE_CLEAR_SESSION!');
}

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    sock = makeWASocket({
        auth: state,
        browser: ["Chrome", "Linux", "128.0"],
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // 🔍 LOG para ver o que está acontecendo
        console.log("📡 Update recebido:", { connection, hasQR: !!qr });
        
        if (qr) {
            lastQR = await qrcode.toDataURL(qr);
            console.log("✅ QR Code GERADO!");
            
            // Mostra QR como texto nos logs para debug
            try {
                const qrText = await qrcode.toString(qr, { type: 'terminal' });
                console.log("📱 QR Code (texto) - Copie e use um decodificador:");
                console.log(qrText);
                console.log("🔗 Link alternativo para escanear: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qr));
            } catch (err) {
                console.log("QR gerado, mas não foi possível converter para texto");
            }
        }
        
        if (connection === "open") {
            connectionStatus = "connected";
            myJid = sock.user?.id || null;
            lastQR = null;
            console.log("✅ CONECTADO como:", myJid);
        }
        
        if (connection === "close") {
            connectionStatus = "disconnected";
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("🔌 Desconectado. Reconectar?", shouldReconnect);
            if (shouldReconnect) {
                console.log("🔄 Tentando reconectar em 5 segundos...");
                setTimeout(startWhatsApp, 5000);
            }
        }
        
        if (connection === "connecting") {
            connectionStatus = "connecting";
            console.log("🔄 Conectando ao WhatsApp...");
        }
    });
    
    // 📩 Receber e responder mensagens
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages?.[0];
        if (!msg || msg.key.fromMe) return;
        
        const from = msg.key.remoteJid;
        const text = msg.message?.conversation 
            || msg.message?.extendedTextMessage?.text 
            || msg.message?.imageMessage?.caption 
            || "";
        
        if (!text) return;
        
        console.log("📩 Mensagem de", from, ":", text);
        
        // Comando: ajuda
        if (text.toLowerCase() === "/start" || text.toLowerCase() === "ajuda" || text.toLowerCase() === "menu") {
            await sock.sendMessage(from, { 
                text: `🤖 *Bot WhatsApp Online!*\n\n` +
                      `📋 *Comandos disponíveis:*\n` +
                      `• *ajuda* ou *menu* - Mostra esta mensagem\n` +
                      `• *status* - Verifica se o bot está online\n` +
                      `• *agendar <descrição>* - Faz um agendamento\n` +
                      `• *ping* - Testa a resposta do bot\n\n` +
                      `📅 Exemplo: *agendar Consulta dia 20/05*\n\n` +
                      `✅ Bot rodando 24/7!` 
            });
            return;
        }
        
        // Comando: status
        if (text.toLowerCase() === "status" || text.toLowerCase() === "online") {
            await sock.sendMessage(from, { 
                text: `✅ *Bot está online!*\n\n` +
                      `📱 Conectado como: ${myJid?.split("@")[0] || "Desconhecido"}\n` +
                      `⏰ Ativo 24 horas por dia, 7 dias por semana\n` +
                      `🔗 Versão: Baileys WhatsApp Bot` 
            });
            return;
        }
        
        // Comando: ping
        if (text.toLowerCase() === "ping") {
            await sock.sendMessage(from, { text: "🏓 Pong! Bot respondendo normalmente." });
            return;
        }
        
        // Comando: agendar
        if (text.toLowerCase().startsWith("agendar")) {
            const descricao = text.substring(8).trim();
            if (!descricao) {
                await sock.sendMessage(from, { 
                    text: "⚠️ *Formato correto:*\n`agendar <descrição do agendamento>`\n\nExemplo: `agendar Reunião com cliente às 15h`" 
                });
                return;
            }
            
            await sock.sendMessage(from, { 
                text: `✅ *Agendamento recebido!*\n\n` +
                      `📅 *Descrição:* ${descricao}\n` +
                      `⏰ *Data/Hora:* ${new Date().toLocaleString('pt-BR')}\n\n` +
                      `Em breve entraremos em contato para confirmar o horário.` 
            });
            return;
        }
        
        // Resposta padrão para mensagens não reconhecidas
        await sock.sendMessage(from, { 
            text: `👋 Olá! Eu sou o atendente virtual.\n\n` +
                  `Envie *ajuda* para ver todos os comandos disponíveis.\n\n` +
                  `📅 Para agendar algo, use: *agendar <descrição>*` 
        });
    });
}

// ============================================
// ROTAS HTTP - INTERFACE COMPLETA
// ============================================

// Rota principal - HTML completo com todas as funcionalidades
app.get("/", (req, res) => {
    const statusColor = connectionStatus === "connected" ? "#28a745" : 
                        connectionStatus === "connecting" ? "#ffc107" : "#dc3545";
    const statusText = connectionStatus === "connected" ? "Conectado ✅" :
                       connectionStatus === "connecting" ? "Conectando... 🔄" : "Desconectado ❌";
    
    res.type("html").send(`
<!DOCTYPE html>
<html lang="pt-br">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
    <title>WhatsApp Bot - Painel de Controle</title>
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

        button.success {
            background: #28a745;
        }

        button.success:hover {
            background: #218838;
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
            color: #155724;
        }

        .warning-box {
            background: #fff3cd;
            padding: 15px;
            border-radius: 12px;
            margin-top: 15px;
            color: #856404;
        }

        .commands-list {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 12px;
            margin-top: 20px;
            text-align: left;
            font-size: 0.8rem;
        }

        .commands-list h4 {
            margin-bottom: 10px;
            color: #075e54;
        }

        .commands-list li {
            margin-left: 20px;
            margin-bottom: 5px;
        }

        .auto-refresh {
            font-size: 0.7rem;
            color: #999;
            margin-top: 10px;
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
                <button onclick="forceClearSession()" class="warning" style="background:#ffc107;color:#333;">🗑️ Limpar Sessão</button>
            </div>
            
            <div class="commands-list">
                <h4>📋 Comandos do Bot (no WhatsApp)</h4>
                <ul>
                    <li><code>ajuda</code> ou <code>menu</code> - Mostra todos os comandos</li>
                    <li><code>status</code> - Verifica se o bot está online</li>
                    <li><code>ping</code> - Testa a resposta do bot</li>
                    <li><code>agendar &lt;descrição&gt;</code> - Faz um agendamento</li>
                </ul>
                <p style="font-size:0.7rem; color:#666; margin-top:10px;">💡 Exemplo: <code>agendar Consulta médica dia 20/05 às 14h</code></p>
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
            <p class="auto-refresh" id="refreshInfo">Atualizando automaticamente a cada 10 segundos</p>
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
                    document.getElementById('qrContent').innerHTML = \`
                        <div class="success-box">
                            ✅ <strong>Bot Conectado!</strong><br>
                            <p style="margin-top: 10px;">O bot está online e respondendo mensagens.</p>
                            <p style="margin-top: 5px; font-size: 0.8rem;">📱 JID: \${data.jid || '-'}</p>
                            <p style="margin-top: 5px; font-size: 0.8rem;">✅ Envie uma mensagem para testar!</p>
                        </div>
                    \`;
                    isQRVisible = false;
                } else if (data.status === 'disconnected' && !isQRVisible) {
                    loadQRCode();
                } else if (data.status === 'connecting') {
                    document.getElementById('qrContent').innerHTML = \`
                        <div class="warning-box">
                            🔄 <strong>Conectando ao WhatsApp...</strong><br>
                            <p style="margin-top: 10px;">Aguardando conexão. Isso pode levar alguns segundos.</p>
                            <div class="loading-spinner" style="margin-top:10px;"></div>
                        </div>
                    \`;
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
                            <br><small>📱 Abra o WhatsApp > Dispositivos vinculados > Linkar um dispositivo</small>
                        </div>
                    \`;
                } else if (data.status === 'connected') {
                    document.getElementById('qrContent').innerHTML = \`
                        <div class="success-box">
                            ✅ <strong>Bot já está conectado!</strong><br>
                            <p style="margin-top: 10px;">Não é necessário escanear QR Code.</p>
                            <p>Envie uma mensagem para testar!</p>
                        </div>
                    \`;
                } else {
                    document.getElementById('qrContent').innerHTML = \`
                        <div class="qr-placeholder">
                            <p>⏳ Aguardando QR Code...</p>
                            <p style="font-size: 0.8rem; margin-top: 10px;">O bot está iniciando a conexão</p>
                            <p style="font-size: 0.7rem; margin-top: 5px;">Verifique os logs do Render para mais detalhes</p>
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
                        <p style="font-size:0.7rem;">\${error.message}</p>
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
                setTimeout(() => loadQRCode(), 3000);
            } catch (error) {
                console.error('Erro ao dar refresh:', error);
                alert('Erro ao solicitar novo QR: ' + error.message);
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
                    }, 5000);
                } catch (error) {
                    console.error('Erro ao resetar:', error);
                    alert('Erro ao resetar conexão: ' + error.message);
                }
            }
        }

        async function forceClearSession() {
            if (confirm('⚠️ ATENÇÃO TOTAL: Isso vai DELETAR a sessão salva e forçar um QR Code NOVO do zero. Você precisará escanear novamente. Continuar?')) {
                try {
                    await fetch('/force-clear-session', { method: 'POST' });
                    document.getElementById('qrContent').innerHTML = \`
                        <div class="qr-placeholder">
                            <div class="loading-spinner"></div>
                            <p>🗑️ Limpando sessão...</p>
                            <p style="font-size:0.7rem;">O bot vai reiniciar em alguns segundos</p>
                        </div>
                    \`;
                    isQRVisible = false;
                    setTimeout(() => {
                        checkStatus();
                        loadQRCode();
                    }, 8000);
                } catch (error) {
                    console.error('Erro ao limpar sessão:', error);
                    alert('Erro ao limpar sessão: ' + error.message);
                }
            }
        }

        // Auto-refresh a cada 10 segundos
        setInterval(() => {
            checkStatus();
        }, 10000);

        // Verificar QR a cada 5 segundos quando desconectado
        setInterval(() => {
            checkStatus().then(data => {
                if (data.status === 'disconnected' && !isQRVisible) {
                    loadQRCode();
                }
            });
        }, 5000);

        // Inicializar
        checkStatus();
        loadQRCode();
        
        // Atualizar horário a cada segundo
        setInterval(() => {
            document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString('pt-BR');
        }, 1000);
    </script>
</body>
</html>
    `);
});

// Rota do QR Code simplificada
app.get("/qr", (req, res) => {
    if (lastQR) {
        res.send(`
            <html>
                <head><meta http-equiv="refresh" content="5"><title>QR Code</title></head>
                <body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#075e54;">
                    <div style="background:white;padding:30px;border-radius:20px;text-align:center;">
                        <img src="${lastQR}" style="max-width:300px;">
                        <p>📱 Escaneie com WhatsApp</p>
                        <a href="/" style="color:#075e54;">← Voltar</a>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <head><meta http-equiv="refresh" content="5"><title>QR Code</title></head>
                <body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#075e54;">
                    <div style="background:white;padding:30px;border-radius:20px;text-align:center;">
                        <p>⏳ Aguardando QR Code...</p>
                        <p><a href="/">← Voltar</a></p>
                    </div>
                </body>
            </html>
        `);
    }
});

// API: Status em JSON
app.get("/status", (req, res) => {
    res.json({
        status: connectionStatus,
        jid: myJid || null,
        timestamp: new Date().toISOString()
    });
});

// API: Dados do QR Code
app.get("/qr-data", (req, res) => {
    if (lastQR) {
        res.json({ qr: lastQR, status: "qr_available" });
    } else if (connectionStatus === "connected") {
        res.json({ qr: null, status: "connected" });
    } else {
        res.json({ qr: null, status: "waiting" });
    }
});

// API: Forçar novo QR Code (refresh)
app.post("/refresh-qr", async (req, res) => {
    try {
        if (sock) {
            sock.end(new Error("Forçando novo QR Code"));
        }
        
        const sessionPath = './sessions';
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        
        lastQR = null;
        connectionStatus = "disconnected";
        setTimeout(() => startWhatsApp(), 2000);
        res.json({ ok: true, message: "QR Code reiniciado" });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// API: Resetar conexão completa
app.post("/reset-connection", async (req, res) => {
    try {
        if (sock) {
            sock.end(new Error("Resetando conexão"));
        }
        
        const sessionPath = './sessions';
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        
        lastQR = null;
        connectionStatus = "disconnected";
        myJid = null;
        
        setTimeout(() => startWhatsApp(), 3000);
        res.json({ ok: true, message: "Conexão resetada" });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// API: Forçar limpeza total da sessão
app.post("/force-clear-session", async (req, res) => {
    try {
        if (sock) {
            sock.end(new Error("Forçando limpeza de sessão"));
        }
        
        const sessionPath = './sessions';
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        
        lastQR = null;
        connectionStatus = "disconnected";
        myJid = null;
        
        // Pequeno delay para garantir limpeza
        setTimeout(() => startWhatsApp(), 1000);
        res.json({ ok: true, message: "Sessão completamente limpa" });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// API: Enviar mensagem via POST (para testes)
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

// API: Health check para UptimeRobot
app.get("/health", (req, res) => {
    res.json({ 
        status: "ok", 
        connected: connectionStatus === "connected",
        uptime: process.uptime()
    });
});

// ============================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════╗
║                                                        ║
║     🤖 WhatsApp Bot - Baileys                         ║
║     Servidor rodando na porta ${PORT}                     ║
║                                                        ║
╠════════════════════════════════════════════════════════╣
║  📱 Painel principal: http://localhost:${PORT}           ║
║  🔗 QR Code direto: http://localhost:${PORT}/qr          ║
║  ❤️ Health check: http://localhost:${PORT}/health        ║
║                                                        ║
╠════════════════════════════════════════════════════════╣
║  💡 Dicas:                                            ║
║  • Acesse o painel para ver o QR Code                 ║
║  • Bot responde a: ajuda, status, ping, agendar       ║
║  • Use FORCE_CLEAR_SESSION=true para reset completo   ║
╚════════════════════════════════════════════════════════╝
    `);
});

// Inicia o WhatsApp
startWhatsApp().catch(err => {
    console.error("❌ Falha ao iniciar WhatsApp:", err);
});
