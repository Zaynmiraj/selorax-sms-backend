require('dotenv').config();
const express = require('express');
const app = express();

app.set('trust proxy', 1);

const { connect, connection } = require('./startup/db');
require('./startup/routes')(app);

connect();

// Start the SMS scheduler
const scheduler = require('./services/scheduler');
scheduler.start();

const port = process.env.PORT || 5002;
const server = app.listen(port, () => {
    console.log(`[SeloraX Messaging] Running on port ${port}`);
});

// Graceful shutdown
function shutdown(signal) {
    console.log(`[SeloraX Messaging] ${signal} received — shutting down gracefully`);
    scheduler.stop();
    server.close(() => {
        connection.end(() => {
            console.log('[SeloraX Messaging] Shut down complete');
            process.exit(0);
        });
    });
    // Force exit after 10s if graceful fails
    setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
