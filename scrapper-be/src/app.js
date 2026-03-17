const express = require('express');
const cors = require('cors');

const playwrightRoutes = require('./routes/playwrightRoutes');
const browserRoutes = require('./routes/browserRoutes');
const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/playwright', playwrightRoutes);

app.use('/api/browser', browserRoutes);

module.exports = app;