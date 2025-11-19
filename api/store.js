// In-memory store for room data
// Note: This is shared across all function invocations in the same runtime
// For production scale, consider using Vercel KV or another database

const rooms = new Map();

function getRoom(code) {
    return rooms.get(code.toUpperCase()) || null;
}

function createRoom(code) {
    const roomCode = code.toUpperCase();
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

function addIceCandidate(code, candidate) {
    const room = getRoom(code);
    if (!room) return false;
    room.iceCandidates.push(candidate);
    return true;
}

function getIceCandidates(code) {
    const room = getRoom(code);
    return room?.iceCandidates || [];
}

function clearRoom(code) {
    rooms.delete(code.toUpperCase());
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

// Cleanup is called on each request to prevent memory leaks
// In production, consider using Vercel KV or another persistent store

module.exports = {
    getRoom,
    createRoom,
    setOffer,
    getOffer,
    setAnswer,
    getAnswer,
    addIceCandidate,
    getIceCandidates,
    clearRoom
};

