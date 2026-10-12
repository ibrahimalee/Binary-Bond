// BinaryBond Signaling Server
const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 });
const ROOM_CODE_PATTERN = /^[A-Z0-9]{6,8}$/;

// Serve only browser assets. Serving the project root exposed server and API
// source files (for example, /server.js and /api/store.js) to every visitor.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get(['/style.css', '/script.js'], (req, res) => {
    res.sendFile(path.join(__dirname, req.path));
});

// Parse JSON and urlencoded bodies for API handlers
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true }));

const apiHandlers = {
    addIce: require('./api/addIce'),
    createRoom: require('./api/createRoom'),
    getAnswer: require('./api/getAnswer'),
    getIce: require('./api/getIce'),
    getOffer: require('./api/getOffer'),
    submitAnswer: require('./api/submitAnswer'),
    submitOffer: require('./api/submitOffer'),
};

// Route API requests to local handlers (helps local dev without Vercel).
// An explicit registry keeps unrecognised paths from being loaded dynamically.
app.all('/api/:handler', async (req, res) => {
    const handler = apiHandlers[req.params.handler];
    if (!handler) {
        return res.status(404).json({ error: 'API endpoint not found' });
    }

    try {
        return await handler(req, res);
    } catch (err) {
        console.error(`API handler error for ${req.params.handler}:`, err instanceof Error ? err.message : err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Store active rooms and their participants
const rooms = new Map();

function normalizeRoomCode(roomCode) {
    if (typeof roomCode !== 'string') return null;
    const normalized = roomCode.trim().toUpperCase();
    return ROOM_CODE_PATTERN.test(normalized) ? normalized : null;
}

function send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function leaveCurrentRoom(ws) {
    if (ws.roomCode) {
        handleLeaveRoom(ws, ws.roomCode);
    }
}

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('New client connected');
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
                send(ws, { type: 'room-error', message: 'Invalid signaling message' });
                return;
            }
            
            switch (data.type) {
                case 'create-room':
                    handleCreateRoom(ws, data.roomCode);
                    break;
                    
                case 'join-room':
                    handleJoinRoom(ws, data.roomCode);
                    break;
                    
                case 'offer':
                    relayMessage(ws, {
                        type: 'offer',
                        offer: data.offer
                    });
                    break;
                    
                case 'answer':
                    relayMessage(ws, {
                        type: 'answer',
                        answer: data.answer
                    });
                    break;
                    
                case 'ice-candidate':
                    relayMessage(ws, {
                        type: 'ice-candidate',
                        candidate: data.candidate
                    });
                    break;
                    
                case 'leave-room':
                    leaveCurrentRoom(ws);
                    break;
                default:
                    send(ws, { type: 'room-error', message: 'Unknown signaling message' });
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });
    
    ws.on('close', () => {
        console.log('Client disconnected');
        // Clean up any rooms this client was in
        for (const [roomCode, participants] of rooms.entries()) {
            if (participants.includes(ws)) {
                handleLeaveRoom(ws, roomCode);
            }
        }
    });
});

function handleCreateRoom(ws, roomCode) {
    const normalizedCode = normalizeRoomCode(roomCode);
    if (!normalizedCode) {
        send(ws, { type: 'room-error', message: 'Invalid room code' });
        return;
    }

    if (rooms.has(normalizedCode)) {
        send(ws, {
            type: 'room-error',
            message: 'Room already exists'
        });
        return;
    }

    leaveCurrentRoom(ws);
    
    rooms.set(normalizedCode, [ws]);
    ws.roomCode = normalizedCode;
    
    send(ws, {
        type: 'room-created',
        roomCode: normalizedCode
    });
    
    console.log(`Room ${normalizedCode} created`);
}

function handleJoinRoom(ws, roomCode) {
    const normalizedCode = normalizeRoomCode(roomCode);
    if (!normalizedCode) {
        send(ws, { type: 'room-error', message: 'Invalid room code' });
        return;
    }

    const participants = rooms.get(normalizedCode);
    
    if (!participants) {
        send(ws, {
            type: 'room-error',
            message: 'Room not found'
        });
        return;
    }

    if (ws.roomCode === normalizedCode && participants.includes(ws)) {
        send(ws, { type: 'room-joined' });
        return;
    }
    
    if (participants.length >= 2) {
        send(ws, {
            type: 'room-error',
            message: 'Room is full'
        });
        return;
    }

    leaveCurrentRoom(ws);
    
    participants.push(ws);
    ws.roomCode = normalizedCode;
    
    // Notify both participants that they can start the connection
    participants.forEach(participant => {
        send(participant, {
            type: 'room-joined'
        });
    });
    
    console.log(`Client joined room ${normalizedCode}`);
}

function relayMessage(sender, message) {
    const roomCode = sender.roomCode;
    const participants = rooms.get(roomCode);
    
    if (!participants || !participants.includes(sender)) {
        send(sender, { type: 'room-error', message: 'Join a room before signaling' });
        return;
    }
    
    participants.forEach(participant => {
        if (participant !== sender && participant.readyState === WebSocket.OPEN) {
            participant.send(JSON.stringify(message));
        }
    });
}

function handleLeaveRoom(ws, roomCode) {
    const participants = rooms.get(roomCode);
    
    if (!participants) return;
    
    const index = participants.indexOf(ws);
    if (index > -1) {
        participants.splice(index, 1);
        
        // Notify other participant
        participants.forEach(participant => {
            if (participant.readyState === WebSocket.OPEN) {
                send(participant, {
                    type: 'peer-disconnected'
                });
            }
        });
        
        // Remove empty room
        if (participants.length === 0) {
            rooms.delete(roomCode);
            console.log(`Room ${roomCode} deleted`);
        }

        if (ws.roomCode === roomCode) {
            ws.roomCode = null;
        }
    }
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`BinaryBond signaling server running on http://localhost:${PORT}`);
    console.log('Open this URL in your browser to use the app');
});
