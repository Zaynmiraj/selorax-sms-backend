module.exports = function (err, req, res, next) {
    const statusCode = err.status || 500;
    console.error(`[Messaging] ${req.method} ${req.originalUrl} — ${statusCode}:`, err.message);
    if (process.env.NODE_ENV !== 'production') {
        console.error(err.stack);
    }
    res.status(statusCode).send({
        message: err.expose ? err.message : 'Something went wrong.',
        status: statusCode,
    });
};
