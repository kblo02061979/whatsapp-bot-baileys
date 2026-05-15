const express = require('express');
const cors = require('cors');
const venom = require('venom-bot');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const app = express();

let client = null;
let qrCodeData = null;
let connectionStatus = "disconnected";
let myPhone = null;

app.use(cors());
app.use(express.json());

// Limpa sessão anterior
const sessionPath = './tokens';
if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
    console.log('🗑️ Sessão antiga removida!');
}

function startVenom() {
    console.log("🚀 Iniciando Venom...");
    
    venom.create({
        session: 'whatsapp-bot',
        headless: true,
        useChrome: false,
        debug: false,
        logQR: true,
        browserArgs: ['--no-sandbox', '--disable-setuid-sandbox'],
        folderNameToken: 'tokens',
        mkdirFolderToken: './tokens',
        waitForQRCode: true,
        viewport: { width: 800, height: 600 }
    })
    .then((venomClient) => {
        client = venomClient;
        connectionStatus = "connected";
        
        // Pega o número do usuário
        client.getHostDevice().then(device => {
            myPhone = device?.me?.user || 'Desconhecido';
            console.log("🎉 CONECTADO! Número:", myPhone);
        });
        
        console.log("✅ Venom iniciado com sucesso!");
        
        // Evento de QR Code
        client.onStreamChange((stream) => {
            if (stream === 'qrcode') {
                console.log("QR Code gerado!");
            }
        });
        
        // Responde mensagens
        client.onMessage(async (message) => {
            if (message.isGroupMsg) return;
            
            const from = message.from;
            const text = message.body;
            
            console.log("📩 Mensagem de", from, ":", text);
            
            const lowerText = text.toLowerCase();
            
            if (lowerText === "oi" || lowerText === "olá") {
                await client.sendText(from, "Olá! 👋 Bot online! Digite 'ajuda' para comandos.");
            } 
            else if (lowerText === "ajuda" || lowerText === "menu") {
                await client.sendText(from, `📋 *Comandos:*\n\n• *oi/olá* - Saudação\n• *status* - Verifica se estou online\n• *agendar <texto>* - Agendamento\n• *ajuda* - Esta lista`);
            }
            else if (lowerText === "status") {
                await client.sendText(from, `✅ Bot online! Conectado como: ${myPhone || "?"}`);
            }
            else if (lowerText.startsWith("agendar")) {
                const desc = text.substring(8).trim() || "Sem descrição";
                await client.sendText(from, `✅ Agendamento recebido!\n📅 ${desc}\n⏰ ${new Date().toLocaleString('pt-BR')}\n\nEm breve confirmamos.`);
            }
            else {
                await client.sendText(from, "Olá! 👋 Digite *ajuda* para ver os comandos.");
            }
        });
        
    })
    .catch((error) => {
        console.error("Erro ao iniciar Venom:", error);
        connectionStatus = "disconnected";
        setTimeout(startVenom, 10000);
    });
}

// Função para capturar QR Code (via callback do venom)
// Venom já mostra o QR no terminal, vamos expor via rota
let qrInterval = setInterval(async () => {
    if (client) {
        try {
            const qr = await client.getQRCode();
            if (qr) {
                qrCodeData = qr;
                console.log("✅ QR Code capturado!");
            }
        } catch(e) {}
    }
}, 2000);

// ROTA PRINCIPAL
app.get("/", (req, res) => {
    const statusText = connectionStatus === "connected" ? "✅ Conectado" : "❌ Desconectado";
    
    let qrHtml = '';
    if (qrCodeData && connectionStatus !== "connected") {
        qrHtml = `<img src="${qrCodeData}" style="max-width:280px; border-radius:10px;">`;
    } else if (connectionStatus === "connected") {
        qrHtml = `<p>✅ Bot conectado! Número: ${myPhone || '-'}</p>`;
    } else {
        qrHtml = `<p>⏳ Iniciando bot... Aguarde QR Code</p>`;
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
        .status { font-size: 1.2rem; margin: 20px 0; color: ${connectionStatus === 'connected' ? 'green' : 'red'}; }
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
        if (client) client.close();
        if (fs.existsSync('./tokens')) {
            fs.rmSync('./tokens', { recursive: true, force: true });
        }
        qrCodeData = null;
        connectionStatus = "disconnected";
        setTimeout(() => process.exit(0), 1000);
        res.json({ ok: true });
    } catch(e) {
        res.json({ ok: false });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Servidor rodando na porta ${PORT}`);
});

startVenom();
