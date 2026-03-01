module.exports = function (err, req, res, next) {
    console.error('[Messaging] Unhandled error:', err.message);
    res.status(500).send({
        message: 'Something went wrong.',
        status: 500,
    });
};
