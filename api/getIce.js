const { getIceCandidates } = require('./store');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (!['GET', 'POST'].includes(req.method)) {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const code = req.method === 'GET' 
            ? req.query.code 
            : req.body?.code;
        const senderId = req.method === 'GET'
            ? req.query.senderId
            : req.body?.senderId;

        if (!code || !senderId) {
            res.status(400).json({ error: 'Missing code or sender ID' });
            return;
        }

        const candidates = getIceCandidates(code, senderId);
        
        res.status(200).json(candidates);
    } catch (error) {
        console.error('Error getting ICE candidates:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

