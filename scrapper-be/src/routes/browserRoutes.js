const express = require("express");
const router = express.Router();

const browserController = require("../controllers/browserController");

router.post("/start", browserController.startBrowser);

module.exports = router;