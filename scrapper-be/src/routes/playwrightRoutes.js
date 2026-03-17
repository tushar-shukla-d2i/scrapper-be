const express = require('express');

const router = express.Router();

const playwrightController = require('../controllers/playwrightController');

router.post('/codegen', playwrightController.runCodegen);

module.exports = router;