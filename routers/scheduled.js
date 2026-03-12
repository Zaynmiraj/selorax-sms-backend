const express = require('express');
const Router = express.Router();
const auth = require('../middlewares/auth');
const asyncMiddleware = require('../middlewares/asyncMiddleware');
const scheduler = require('../services/scheduler');

/**
 * GET /api/messaging/scheduled
 * Get scheduled/pending SMS jobs
 */
Router.get('/', auth, asyncMiddleware(async (req, res) => {
    const { page, limit, status } = req.query;
    const result = await scheduler.getScheduledJobs(req.user.store_id, {
        page: Number(page) || 1,
        limit: Number(limit) || 20,
        status: status || undefined,
    });
    res.send({ message: 'Scheduled jobs fetched.', data: result, status: 200 });
}));

/**
 * POST /api/messaging/scheduled/:job_id/cancel
 * Cancel a specific scheduled job
 */
Router.post('/:job_id/cancel', auth, asyncMiddleware(async (req, res) => {
    const { connection } = require('../startup/db');
    const [result] = await connection.promise().query(/*sql*/`
        UPDATE app_messaging_scheduled
        SET status = 'cancelled', processed_at = NOW()
        WHERE job_id = ? AND store_id = ? AND status = 'pending'
    `, [Number(req.params.job_id), req.user.store_id]);

    if (result.affectedRows === 0) {
        return res.status(404).send({ message: 'Job not found or not cancellable.', status: 404 });
    }
    res.send({ message: 'Scheduled SMS cancelled.', status: 200 });
}));

module.exports = Router;
