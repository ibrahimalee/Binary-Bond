const { createRoom, cleanupOldRooms } = require('./store');

module.exports = async (req, res) => {
    // Clean up old rooms on each request
    cleanupOldRooms();
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST' && req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        // Generate a random room code
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        const room = createRoom(code);
        
        if (!room) {
            // Retry with a new code if collision (unlikely)
            const newCode = Math.random().toString(36).substring(2, 8).toUpperCase();
            const newRoom = createRoom(newCode);
            if (!newRoom) {
                res.status(500).json({ error: 'Failed to create room' });
                return;
            }
            res.status(200).json({ code: newRoom.code, roomCode: newRoom.code });
            return;
        }

        res.status(200).json({ code: room.code, roomCode: room.code });
    } catch (error) {
        console.error('Error creating room:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

