const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const activeAgents = new Map();

// ---------------------------------------------------------
// NEURAL MATRIX: Dynamic Fallback for Unlimited Tokens
// ---------------------------------------------------------
const FREE_MODELS = [
    "meta-llama/llama-3-8b-instruct:free",
    "google/gemma-2-9b-it:free",
    "mistralai/mistral-7b-instruct:free",
    "qwen/qwen-2-7b-instruct:free"
];

async function queryMatrix(prompt, context) {
    if (!OPENROUTER_API_KEY) return "Error: API Key missing on server.";
    
    for (const model of FREE_MODELS) {
        try {
            const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                model: model,
                messages: [{ role: 'system', content: context }, { role: 'user', content: prompt }]
            }, {
                headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
                timeout: 15000
            });
            if (res.data?.choices?.length > 0) return res.data.choices[0].message.content.trim();
        } catch (e) {
            console.log(`[!] ${model} busy. Matrix routing to next node...`);
        }
    }
    return "All neural nodes currently overloaded. Matrix recalibrating, try again shortly.";
}

// ---------------------------------------------------------
// MULTI-TENANT WHATSAPP ENGINE
// ---------------------------------------------------------
async function startAgent(agentId, socketId, systemPrompt) {
    const sessionDir = path.join(__dirname, 'sessions', `session_${agentId}`);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop')
    });

    sock.ev.on('creds.update', saveCreds);

    let qrTimeout;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrImage = await qrcode.toDataURL(qr);
            io.to(socketId).emit('qr', { qr: qrImage });
            io.to(socketId).emit('log', `[SECURITY] 5-Minute QR Protocol initiated for ${agentId}.`);
            
            if (qrTimeout) clearTimeout(qrTimeout);
            qrTimeout = setTimeout(() => {
                io.to(socketId).emit('log', `[!] QR Expired. Protocol dictates shutdown. Request a new connection.`);
                io.to(socketId).emit('qr_expired');
                sock.ws.close();
            }, 5 * 60 * 1000);
        }

        if (connection === 'open') {
            if (qrTimeout) clearTimeout(qrTimeout);
            activeAgents.set(agentId, sock);
            io.to(socketId).emit('connected', { agentId });
            io.to(socketId).emit('log', `[+] Engine Linked. AI matrix is now monitoring incoming traffic for ${agentId}.`);
        }

        if (connection === 'close') {
            activeAgents.delete(agentId);
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code !== DisconnectReason.loggedOut) {
                io.to(socketId).emit('log', `[-] Connection unstable. Auto-reconnecting...`);
                setTimeout(() => startAgent(agentId, socketId, systemPrompt), 3000);
            } else {
                io.to(socketId).emit('log', `[-] Device unlinked from phone. Please initialize again to get a new QR code.`);
                io.to(socketId).emit('disconnected');
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@g.us')) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        io.to(socketId).emit('log', `> Received: "${text}" from ${msg.key.remoteJid.split('@')[0]}`);

        const reply = await queryMatrix(text, systemPrompt);
        await sock.sendMessage(msg.key.remoteJid, { text: reply });
        
        io.to(socketId).emit('log', `< Matrix Replied: "${reply.substring(0, 30)}..."`);
    });
}

// ---------------------------------------------------------
// WEB SOCKET API (Frontend Communication)
// ---------------------------------------------------------
io.on('connection', (socket) => {
    socket.on('start_engine', (data) => {
        // Sanitize Agent ID to prevent folder path issues
        const safeId = data.agentId.replace(/[^a-zA-Z0-9_-]/g, '');
        startAgent(safeId, socket.id, data.systemPrompt);
    });
});

server.listen(PORT, () => console.log(`Dashboard Live on Port ${PORT}`));
                                         
