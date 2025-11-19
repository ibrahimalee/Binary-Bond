// BinaryBond Signaling Server
const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files
app.use(express.static(path.join(__dirname)));

// Store active rooms and their participants
const rooms = new Map();

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('New client connected');
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'create-room':
                    handleCreateRoom(ws, data.roomCode);
                    break;
                    
                case 'join-room':
                    handleJoinRoom(ws, data.roomCode);
                    break;
                    
                case 'offer':
                    relayMessage(ws, data.roomCode, {
                        type: 'offer',
                        offer: data.offer
                    });
                    break;
                    
                case 'answer':
                    relayMessage(ws, data.roomCode, {
                        type: 'answer',
                        answer: data.answer
                    });
                    break;
                    
                case 'ice-candidate':
                    relayMessage(ws, data.roomCode, {
                        type: 'ice-candidate',
                        candidate: data.candidate
                    });
                    break;
                    
                case 'leave-room':
                    handleLeaveRoom(ws, data.roomCode);
                    break;
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
    if (rooms.has(roomCode)) {
        ws.send(JSON.stringify({
            type: 'room-error',
            message: 'Room already exists'
        }));
        return;
    }
    
    rooms.set(roomCode, [ws]);
    ws.roomCode = roomCode;
    
    ws.send(JSON.stringify({
        type: 'room-created',
        roomCode: roomCode
    }));
    
    console.log(`Room ${roomCode} created`);
}

function handleJoinRoom(ws, roomCode) {
    const participants = rooms.get(roomCode);
    
    if (!participants) {
        ws.send(JSON.stringify({
            type: 'room-error',
            message: 'Room not found'
        }));
        return;
    }
    
    if (participants.length >= 2) {
        ws.send(JSON.stringify({
            type: 'room-error',
            message: 'Room is full'
        }));
        return;
    }
    
    participants.push(ws);
    ws.roomCode = roomCode;
    
    // Notify both participants that they can start the connection
    participants.forEach(participant => {
        participant.send(JSON.stringify({
            type: 'room-joined'
        }));
    });
    
    console.log(`Client joined room ${roomCode}`);
}

function relayMessage(sender, roomCode, message) {
    const participants = rooms.get(roomCode);
    
    if (!participants) return;
    
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
                participant.send(JSON.stringify({
                    type: 'peer-disconnected'
                }));
            }
        });
        
        // Remove empty room
        if (participants.length === 0) {
            rooms.delete(roomCode);
            console.log(`Room ${roomCode} deleted`);
        }
    }
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`BinaryBond signaling server running on http://localhost:${PORT}`);
    console.log('Open this URL in your browser to use the app');
});