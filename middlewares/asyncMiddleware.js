module.exports = function (handler) {
    return async (req, res, next) => {
        try {
            await handler(req, res);
        } catch (error) {
            console.error('[Messaging Error]', error.message, error.stack);
            next(error);
        }
    };
};
