const playwrightService = require('../services/playwrightService');

exports.runCodegen = async (req, res) =>{
    try {
        const { url } = req.body;

        await playwrightService.startCodegen(url);

        res.json({ success: true, message: "Playwright codegen started"});
    } catch (error) {
        res.status(500).json({ success: false, message: error.message});
    }
};
