const mysql = require('mysql2');

const connection = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    port: process.env.MYSQL_PORT || 3306,
    connectionLimit: 20,
    maxIdle: 5,
    idleTimeout: 60000,
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000,
});

const connect = () => {
    connection.on('connection', (conn) => {
        console.log(`[Messaging DB] Connection established: ${conn.threadId}`);
        conn.on('error', (err) => console.error('[Messaging DB] Error:', err.code));
    });
};

exports.connect = connect;
exports.connection = connection;
