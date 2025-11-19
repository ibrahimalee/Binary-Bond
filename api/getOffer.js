const { getOffer } = require('./store');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        const code = req.method === 'GET' 
            ? req.query.code 
            : req.body?.code;

        if (!code) {
            res.status(400).json({ error: 'Missing code' });
            return;
        }

        const offer = getOffer(code);
        
        if (!offer) {
            res.status(200).json({ offer: null });
            return;
        }

        res.status(200).json({ offer });
    } catch (error) {
        console.error('Error getting offer:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

