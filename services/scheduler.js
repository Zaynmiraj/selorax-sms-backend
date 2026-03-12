const { connection } = require('../startup/db');
const messaging = require('../models/messaging');

let pollInterval = null;
const POLL_INTERVAL_MS = 10000; // Check every 10 seconds
const BATCH_SIZE = 20;

/**
 * Schedule an SMS for future delivery
 */
async function scheduleJob(store_id, installation_id, phone, message, scheduledAt, { event_topic, resource_id } = {}) {
    const [result] = await connection.promise().query(/*sql*/`
        INSERT INTO app_messaging_scheduled (store_id, installation_id, phone, message, event_topic, resource_id, scheduled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [store_id, installation_id, phone, message, event_topic || null, resource_id || null, scheduledAt]);
    return result.insertId;
}

/**
 * Cancel pending jobs for a specific order (e.g., when order is cancelled)
 */
async function cancelJobsForOrder(store_id, resource_id) {
    const [result] = await connection.promise().query(/*sql*/`
        UPDATE app_messaging_scheduled
        SET status = 'cancelled', processed_at = NOW()
        WHERE store_id = ? AND resource_id = ? AND status = 'pending'
    `, [store_id, resource_id]);
    return result.affectedRows;
}

/**
 * Cancel all pending jobs for a store (e.g., on app uninstall)
 */
async function cancelAllForStore(store_id) {
    const [result] = await connection.promise().query(/*sql*/`
        UPDATE app_messaging_scheduled
        SET status = 'cancelled', processed_at = NOW()
        WHERE store_id = ? AND status = 'pending'
    `, [store_id]);
    return result.affectedRows;
}

/**
 * Get pending/scheduled jobs for a store (for the frontend)
 */
async function getScheduledJobs(store_id, { page = 1, limit = 20, status } = {}) {
    const offset = (page - 1) * limit;
    let where = 'WHERE store_id = ?';
    const params = [store_id];

    if (status) {
        where += ' AND status = ?';
        params.push(status);
    }

    const [rows] = await connection.promise().query(/*sql*/`
        SELECT * FROM app_messaging_scheduled ${where}
        ORDER BY scheduled_at DESC
        LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const [countRows] = await connection.promise().query(/*sql*/`
        SELECT COUNT(*) as total FROM app_messaging_scheduled ${where}
    `, params);

    return { jobs: rows, total: countRows[0].total, page, limit };
}

/**
 * Process due jobs — called by the poll interval
 */
async function processDueJobs() {
    // Grab a batch of due jobs and mark them processing (atomic)
    const [jobs] = await connection.promise().query(/*sql*/`
        SELECT * FROM app_messaging_scheduled
        WHERE status = 'pending' AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC
        LIMIT ?
    `, [BATCH_SIZE]);

    if (jobs.length === 0) return;

    const jobIds = jobs.map(j => j.job_id);
    await connection.promise().query(/*sql*/`
        UPDATE app_messaging_scheduled SET status = 'processing' WHERE job_id IN (?)
    `, [jobIds]);

    for (const job of jobs) {
        try {
            const result = await messaging.sendSms(
                job.store_id,
                job.installation_id,
                job.phone,
                job.message,
                { event_topic: job.event_topic, resource_id: job.resource_id }
            );

            if (result.success) {
                await connection.promise().query(/*sql*/`
                    UPDATE app_messaging_scheduled
                    SET status = 'sent', sms_log_id = ?, processed_at = NOW(), attempts = attempts + 1
                    WHERE job_id = ?
                `, [result.log_id, job.job_id]);
            } else {
                await handleJobFailure(job, result.error || 'SMS send failed');
            }
        } catch (err) {
            await handleJobFailure(job, err.message);
        }
    }
}

/**
 * Handle a failed job — retry with exponential backoff or mark as failed
 */
async function handleJobFailure(job, errorMsg) {
    const newAttempts = (job.attempts || 0) + 1;

    if (newAttempts >= (job.max_attempts || 3)) {
        // Max retries reached — mark as failed
        await connection.promise().query(/*sql*/`
            UPDATE app_messaging_scheduled
            SET status = 'failed', attempts = ?, last_error = ?, processed_at = NOW()
            WHERE job_id = ?
        `, [newAttempts, errorMsg, job.job_id]);
        console.error(`[Scheduler] Job ${job.job_id} failed permanently after ${newAttempts} attempts: ${errorMsg}`);
    } else {
        // Retry with exponential backoff: 1min, 4min, 9min...
        const backoffMinutes = newAttempts * newAttempts;
        await connection.promise().query(/*sql*/`
            UPDATE app_messaging_scheduled
            SET status = 'pending', attempts = ?, last_error = ?,
                scheduled_at = DATE_ADD(NOW(), INTERVAL ? MINUTE)
            WHERE job_id = ?
        `, [newAttempts, errorMsg, backoffMinutes, job.job_id]);
        console.log(`[Scheduler] Job ${job.job_id} retry #${newAttempts} in ${backoffMinutes}min`);
    }
}

/**
 * Start the scheduler polling loop
 */
function start() {
    if (pollInterval) return;
    console.log('[Scheduler] Started — polling every 10s');
    pollInterval = setInterval(async () => {
        try {
            await processDueJobs();
        } catch (err) {
            console.error('[Scheduler] Poll error:', err.message);
        }
    }, POLL_INTERVAL_MS);
    // Don't block process exit
    pollInterval.unref();
}

/**
 * Stop the scheduler
 */
function stop() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
        console.log('[Scheduler] Stopped');
    }
}

module.exports = {
    scheduleJob,
    cancelJobsForOrder,
    cancelAllForStore,
    getScheduledJobs,
    processDueJobs,
    start,
    stop,
};
