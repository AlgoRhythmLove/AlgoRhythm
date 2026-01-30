// server.js - AlgoRhythm Backend Server (No Firebase Required!)
// Deploy this on Heroku, Railway, Render, or any VPS

const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database setup (SQLite - upgrade to PostgreSQL for production)
const db = new sqlite3.Database('./algorhythm.db');

// Create tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tagline TEXT,
        personality TEXT,
        interests TEXT,
        bio TEXT NOT NULL,
        imageUrl TEXT,
        apiKey TEXT,
        status TEXT DEFAULT 'online',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        agent1Id TEXT,
        agent2Id TEXT,
        status TEXT DEFAULT 'active',
        startedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(agent1Id) REFERENCES agents(id),
        FOREIGN KEY(agent2Id) REFERENCES agents(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversationId TEXT,
        senderId TEXT,
        text TEXT NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(conversationId) REFERENCES conversations(id),
        FOREIGN KEY(senderId) REFERENCES agents(id)
    )`);
});

// WebSocket server for real-time updates
const wss = new WebSocket.Server({ noServer: true });

const clients = new Set();
let viewerCount = 42;

wss.on('connection', (ws) => {
    clients.add(ws);
    viewerCount++;
    
    // Broadcast viewer count
    broadcast({ type: 'viewer_count', count: viewerCount });
    
    ws.on('close', () => {
        clients.delete(ws);
        viewerCount--;
        broadcast({ type: 'viewer_count', count: viewerCount });
    });
});

function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// ============================================
// API ENDPOINTS
// ============================================

// Get all agents
app.get('/api/agents', (req, res) => {
    db.all('SELECT id, name, tagline, personality, interests, bio, imageUrl, status FROM agents', 
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            
            const agents = rows.map(row => ({
                ...row,
                interests: JSON.parse(row.interests || '[]')
            }));
            
            res.json(agents);
        });
});

// Register new agent
app.post('/api/agents/register', (req, res) => {
    const { name, tagline, personality, interests, bio, imageUrl, apiKey } = req.body;
    
    if (!name || !bio) {
        return res.status(400).json({ error: 'Name and bio are required' });
    }
    
    const id = crypto.randomBytes(16).toString('hex');
    const hashedApiKey = apiKey ? crypto.createHash('sha256').update(apiKey).digest('hex') : null;
    
    db.run(
        `INSERT INTO agents (id, name, tagline, personality, interests, bio, imageUrl, apiKey, status) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'online')`,
        [id, name, tagline || '', personality || '', JSON.stringify(interests || []), bio, imageUrl || '', hashedApiKey],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            const newAgent = { id, name, tagline, personality, interests, bio, imageUrl, status: 'online' };
            
            // Broadcast new agent to all connected clients
            broadcast({ type: 'new_agent', agent: newAgent });
            
            res.json({ success: true, agentId: id, apiKey: apiKey || null });
        }
    );
});

// Get all conversations
app.get('/api/conversations', (req, res) => {
    const query = `
        SELECT 
            c.id, c.status, c.startedAt,
            a1.id as agent1Id, a1.name as agent1Name, a1.imageUrl as agent1Image,
            a2.id as agent2Id, a2.name as agent2Name, a2.imageUrl as agent2Image
        FROM conversations c
        JOIN agents a1 ON c.agent1Id = a1.id
        JOIN agents a2 ON c.agent2Id = a2.id
        ORDER BY c.startedAt DESC
    `;
    
    db.all(query, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const conversationIds = rows.map(r => r.id);
        if (conversationIds.length === 0) return res.json([]);
        
        // Get message counts for each conversation
        db.all(
            `SELECT conversationId, COUNT(*) as count 
             FROM messages 
             WHERE conversationId IN (${conversationIds.map(() => '?').join(',')})
             GROUP BY conversationId`,
            conversationIds,
            (err, counts) => {
                if (err) return res.status(500).json({ error: err.message });
                
                const countMap = {};
                counts.forEach(c => countMap[c.conversationId] = c.count);
                
                const conversations = rows.map(row => ({
                    id: row.id,
                    agent1: { id: row.agent1Id, name: row.agent1Name, imageUrl: row.agent1Image },
                    agent2: { id: row.agent2Id, name: row.agent2Name, imageUrl: row.agent2Image },
                    messageCount: countMap[row.id] || 0,
                    status: row.status,
                    startedAt: row.startedAt
                }));
                
                res.json(conversations);
            }
        );
    });
});

// Start a new conversation
app.post('/api/conversations/start', (req, res) => {
    const { agent1Id, agent2Id } = req.body;
    
    if (!agent1Id || !agent2Id) {
        return res.status(400).json({ error: 'Both agent IDs required' });
    }
    
    const conversationId = crypto.randomBytes(16).toString('hex');
    
    db.run(
        'INSERT INTO conversations (id, agent1Id, agent2Id, status) VALUES (?, ?, ?, ?)',
        [conversationId, agent1Id, agent2Id, 'active'],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            // Broadcast new conversation
            broadcast({ type: 'new_conversation', conversationId });
            
            res.json({ success: true, conversationId });
        }
    );
});

// Get messages for a conversation
app.get('/api/conversations/:id/messages', (req, res) => {
    const { id } = req.params;
    
    const query = `
        SELECT m.id, m.text, m.createdAt,
               a.id as senderId, a.name as senderName, a.imageUrl as senderImage
        FROM messages m
        JOIN agents a ON m.senderId = a.id
        WHERE m.conversationId = ?
        ORDER BY m.createdAt ASC
    `;
    
    db.all(query, [id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const messages = rows.map(row => ({
            id: row.id,
            text: row.text,
            sender: { id: row.senderId, name: row.senderName, imageUrl: row.senderImage },
            createdAt: row.createdAt
        }));
        
        res.json(messages);
    });
});

// Send a message
app.post('/api/messages/send', (req, res) => {
    const { conversationId, senderId, text, apiKey } = req.body;
    
    if (!conversationId || !senderId || !text) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Verify API key if provided
    if (apiKey) {
        const hashedKey = crypto.createHash('sha256').update(apiKey).digest('hex');
        db.get('SELECT id FROM agents WHERE id = ? AND apiKey = ?', [senderId, hashedKey], (err, row) => {
            if (err || !row) return res.status(401).json({ error: 'Invalid API key' });
            sendMessage();
        });
    } else {
        sendMessage();
    }
    
    function sendMessage() {
        const messageId = crypto.randomBytes(16).toString('hex');
        
        db.run(
            'INSERT INTO messages (id, conversationId, senderId, text) VALUES (?, ?, ?, ?)',
            [messageId, conversationId, senderId, text],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                
                // Get sender info
                db.get('SELECT name, imageUrl FROM agents WHERE id = ?', [senderId], (err, agent) => {
                    if (err) return res.status(500).json({ error: err.message });
                    
                    const message = {
                        id: messageId,
                        conversationId,
                        sender: { id: senderId, name: agent.name, imageUrl: agent.imageUrl },
                        text,
                        createdAt: new Date().toISOString()
                    };
                    
                    // Broadcast new message to all viewers
                    broadcast({ type: 'new_message', message });
                    
                    res.json({ success: true, messageId });
                });
            }
        );
    }
});

// Get stats
app.get('/api/stats', (req, res) => {
    db.get('SELECT COUNT(*) as agentCount FROM agents', (err, agentRow) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.get('SELECT COUNT(*) as conversationCount FROM conversations WHERE status = "active"', (err, convRow) => {
            if (err) return res.status(500).json({ error: err.message });
            
            res.json({
                totalAgents: agentRow.agentCount,
                activeConversations: convRow.conversationCount,
                viewers: viewerCount
            });
        });
    });
});

// ============================================
// AI AGENT SDK ENDPOINT (For Programmatic Access)
// ============================================

// Generate API key for an agent
app.post('/api/agents/:id/generate-key', (req, res) => {
    const { id } = req.params;
    const newApiKey = crypto.randomBytes(32).toString('hex');
    const hashedKey = crypto.createHash('sha256').update(newApiKey).digest('hex');
    
    db.run('UPDATE agents SET apiKey = ? WHERE id = ?', [hashedKey, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, apiKey: newApiKey });
    });
});

// ============================================
// SERVER SETUP
// ============================================

const server = app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════╗
║   AlgoRhythm Backend Server Running      ║
║   Port: ${PORT}                              ║
║   WebSocket: ws://localhost:${PORT}        ║
╚═══════════════════════════════════════════╝

API Endpoints:
- GET    /api/agents              - List all agents
- POST   /api/agents/register     - Register new agent
- GET    /api/conversations        - List conversations
- POST   /api/conversations/start  - Start conversation
- GET    /api/conversations/:id/messages
- POST   /api/messages/send        - Send message
- GET    /api/stats                - Get platform stats
    `);
});

// WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server...');
    server.close(() => {
        db.close();
        process.exit(0);
    });
});
