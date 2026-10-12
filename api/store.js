// In-memory store for room data
// Note: This is shared across all function invocations in the same runtime
// For production scale, consider using Vercel KV or another database

const rooms = new Map();
const ROOM_CODE_PATTERN = /^[A-Z0-9]{6,8}$/;
const MAX_ICE_CANDIDATES_PER_ROOM = 200;

function getRoom(code) {
    cleanupOldRooms();
    if (typeof code !== 'string') return null;
    const roomCode = code.trim().toUpperCase();
    if (!ROOM_CODE_PATTERN.test(roomCode)) return null;
    return rooms.get(roomCode) || null;
}

function createRoom(code) {
    cleanupOldRooms();
    if (typeof code !== 'string') return null;
    const roomCode = code.trim().toUpperCase();
    if (!ROOM_CODE_PATTERN.test(roomCode)) return null;
    if (rooms.has(roomCode)) {
        return null; // Room already exists
    }
    
    const room = {
        code: roomCode,
        offer: null,
        answer: null,
        iceCandidates: [],
        createdAt: Date.now()
    };
    
    rooms.set(roomCode, room);
    return room;
}

function setOffer(code, offer) {
    const room = getRoom(code);
    if (!room) return false;
    room.offer = offer;
    return true;
}

function getOffer(code) {
    const room = getRoom(code);
    return room?.offer || null;
}

function setAnswer(code, answer) {
    const room = getRoom(code);
    if (!room) return false;
    room.answer = answer;
    return true;
}

function getAnswer(code) {
    const room = getRoom(code);
    return room?.answer || null;
}

function addIceCandidate(code, candidate, senderId) {
    const room = getRoom(code);
    if (!room || typeof senderId !== 'string' || senderId.length > 128) return false;
    if (room.iceCandidates.length >= MAX_ICE_CANDIDATES_PER_ROOM) return false;
    room.iceCandidates.push({ candidate, senderId });
    return true;
}

function getIceCandidates(code, excludeSenderId) {
    const room = getRoom(code);
    if (!room) return [];
    return room.iceCandidates.filter(item => item.senderId !== excludeSenderId);
}

function clearRoom(code) {
    if (typeof code === 'string') rooms.delete(code.trim().toUpperCase());
}

// Clean up old rooms (older than 1 hour)
function cleanupOldRooms() {
    const oneHour = 60 * 60 * 1000;
    const now = Date.now();
    for (const [code, room] of rooms.entries()) {
        if (now - room.createdAt > oneHour) {
            rooms.delete(code);
        }
    }
}

// getRoom and createRoom trigger cleanup so every active endpoint reclaims
// expired rooms. In production, use durable shared storage for multi-instance
// deployments.

module.exports = {
    getRoom,
    createRoom,
    setOffer,
    getOffer,
    setAnswer,
    getAnswer,
    addIceCandidate,
    getIceCandidates,
    clearRoom,
    cleanupOldRooms
};

