const { setOffer } = require('./store');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const { code, offer } = req.body;

        if (!code || !offer) {
            res.status(400).json({ error: 'Missing code or offer' });
            return;
        }

        const success = setOffer(code, offer);
        
        if (!success) {
            res.status(404).json({ error: 'Room not found' });
            return;
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error submitting offer:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

