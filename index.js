require('dotenv').config();
const express = require('express');
const app = express();

const { connect } = require('./startup/db');
require('./startup/routes')(app);

connect();

const port = process.env.PORT || 5002;
app.listen(port, () => {
    console.log(`[SeloraX Messaging] Running on port ${port}`);
});
