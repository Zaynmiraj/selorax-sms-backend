const crypto = require('crypto');
const { connection } = require('../startup/db');
const messaging = require('../models/messaging');
const payment = require('../models/messaging-payment');

let pollInterval = null;
let renewalInterval = null;
let pollInFlight = false;
let renewalInFlight = false;
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
    // Atomic claim: mark due pending jobs as 'processing' in one UPDATE and
    // tag them with a unique claim token in `last_error` so we can then
    // SELECT exactly the rows we just claimed. This eliminates the
    // SELECT-then-UPDATE race where overlapping workers would double-process.
    const claimToken = `__claim:${process.pid}:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`;

    const [claimResult] = await connection.promise().query(/*sql*/`
        UPDATE app_messaging_scheduled
        SET status = 'processing', last_error = ?
        WHERE status = 'pending' AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC
        LIMIT ?
    `, [claimToken, BATCH_SIZE]);

    if (claimResult.affectedRows === 0) return;

    const [jobs] = await connection.promise().query(/*sql*/`
        SELECT * FROM app_messaging_scheduled
        WHERE last_error = ? AND status = 'processing'
    `, [claimToken]);

    for (const job of jobs) {
        try {
            // Re-check store is still enabled — skip (and mark cancelled) if the
            // app was uninstalled while the job was queued.
            const [storeRows] = await connection.promise().query(/*sql*/`
                SELECT is_enabled, auto_sms_enabled FROM app_messaging_settings WHERE store_id = ?
            `, [job.store_id]);
            const store = storeRows[0];
            if (!store || !store.is_enabled) {
                await connection.promise().query(/*sql*/`
                    UPDATE app_messaging_scheduled
                    SET status = 'cancelled', processed_at = NOW(), last_error = 'Store disabled/uninstalled'
                    WHERE job_id = ?
                `, [job.job_id]);
                continue;
            }

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
                    SET status = 'sent', sms_log_id = ?, processed_at = NOW(), attempts = attempts + 1, last_error = NULL
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
 * Check if any stores need auto-renewal of SMS credits.
 */
async function checkAutoRenewals() {
    const [rows] = await connection.promise().query(
        `SELECT s.store_id, s.installation_id, s.sms_credits, s.auto_renew_package_id, s.auto_renew_threshold
         FROM app_messaging_settings s
         WHERE s.auto_renew_enabled = 1
           AND s.auto_renew_package_id IS NOT NULL
           AND s.sms_credits <= s.auto_renew_threshold`
    );

    for (const store of rows) {
        try {
            const [pending] = await connection.promise().query(
                `SELECT 1 FROM app_messaging_purchases
                 WHERE store_id = ? AND status = 'pending'
                   AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR) LIMIT 1`,
                [store.store_id]
            );
            if (pending.length > 0) continue;

            await payment.initiatePurchase(store.store_id, store.auto_renew_package_id);
            console.log(`[AutoRenew] Initiated purchase for store ${store.store_id}`);
        } catch (err) {
            console.error(`[AutoRenew] Failed for store ${store.store_id}:`, err.message);
        }
    }
}

/**
 * Start the scheduler polling loop
 */
function start() {
    if (pollInterval) return;
    console.log('[Scheduler] Started — polling every 10s');
    pollInterval = setInterval(async () => {
        if (pollInFlight) return; // Skip if previous tick is still running
        pollInFlight = true;
        try {
            await processDueJobs();
        } catch (err) {
            console.error('[Scheduler] Poll error:', err.message);
        } finally {
            pollInFlight = false;
        }
    }, POLL_INTERVAL_MS);
    // Don't block process exit
    pollInterval.unref();

    // Auto-renewal check every 60 seconds
    renewalInterval = setInterval(async () => {
        if (renewalInFlight) return;
        renewalInFlight = true;
        try { await checkAutoRenewals(); } catch (err) {
            console.error('[AutoRenew] Check error:', err.message);
        } finally {
            renewalInFlight = false;
        }
    }, 60000);
    renewalInterval.unref();
}

/**
 * Stop the scheduler
 */
function stop() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    if (renewalInterval) {
        clearInterval(renewalInterval);
        renewalInterval = null;
    }
    console.log('[Scheduler] Stopped');
}

module.exports = {
    scheduleJob,
    cancelJobsForOrder,
    cancelAllForStore,
    getScheduledJobs,
    processDueJobs,
    checkAutoRenewals,
    start,
    stop,
};
