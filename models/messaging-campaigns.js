const { connection } = require('../startup/db');

/**
 * Create a new campaign.
 * Status is 'scheduled' if scheduled_at is provided, otherwise 'draft'.
 */
async function create(store_id, installation_id, { name, message, audience_type, audience_data, scheduled_at }) {
    const status = scheduled_at ? 'scheduled' : 'draft';

    const [result] = await connection.promise().query(/*sql*/`
        INSERT INTO app_messaging_campaigns
            (store_id, installation_id, name, message, audience_type, audience_data, status, scheduled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        store_id,
        installation_id,
        name,
        message,
        audience_type,
        JSON.stringify(audience_data ?? null),
        status,
        scheduled_at ?? null,
    ]);

    return getById(result.insertId, store_id);
}

/**
 * Get a single campaign by ID, scoped to store.
 */
async function getById(campaign_id, store_id) {
    const [rows] = await connection.promise().query(/*sql*/`
        SELECT * FROM app_messaging_campaigns
        WHERE campaign_id = ? AND store_id = ?
        LIMIT 1
    `, [campaign_id, store_id]);
    return rows[0] || null;
}

/**
 * Paginated list of campaigns for a store, with optional status filter.
 */
async function list(store_id, { page = 1, limit = 20, status } = {}) {
    const offset = (page - 1) * limit;
    let where = 'WHERE store_id = ?';
    const params = [store_id];

    if (status) {
        where += ' AND status = ?';
        params.push(status);
    }

    const [campaigns] = await connection.promise().query(/*sql*/`
        SELECT * FROM app_messaging_campaigns ${where}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const [countRows] = await connection.promise().query(/*sql*/`
        SELECT COUNT(*) as total FROM app_messaging_campaigns ${where}
    `, params);

    return { campaigns, total: countRows[0].total, page, limit };
}

/**
 * Bulk insert recipient phones for a campaign.
 * Updates total_recipients count on the campaign row.
 * Returns affectedRows from the bulk insert.
 */
async function addRecipients(campaign_id, phones) {
    if (!phones || phones.length === 0) return 0;

    const values = phones.map(phone => [campaign_id, phone]);

    const [result] = await connection.promise().query(/*sql*/`
        INSERT INTO app_messaging_campaign_recipients (campaign_id, phone)
        VALUES ?
    `, [values]);

    await connection.promise().query(/*sql*/`
        UPDATE app_messaging_campaigns
        SET total_recipients = (
            SELECT COUNT(*) FROM app_messaging_campaign_recipients
            WHERE campaign_id = ?
        )
        WHERE campaign_id = ?
    `, [campaign_id, campaign_id]);

    return result.affectedRows;
}

/**
 * Paginated recipient list for a campaign, with optional status filter.
 */
async function getRecipients(campaign_id, { page = 1, limit = 20, status } = {}) {
    const offset = (page - 1) * limit;
    let where = 'WHERE campaign_id = ?';
    const params = [campaign_id];

    if (status) {
        where += ' AND status = ?';
        params.push(status);
    }

    const [recipients] = await connection.promise().query(/*sql*/`
        SELECT * FROM app_messaging_campaign_recipients ${where}
        ORDER BY recipient_id ASC
        LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const [countRows] = await connection.promise().query(/*sql*/`
        SELECT COUNT(*) as total FROM app_messaging_campaign_recipients ${where}
    `, params);

    return { recipients, total: countRows[0].total, page, limit };
}

/**
 * Get the next batch of pending recipients for a campaign.
 */
async function getNextBatch(campaign_id, batchSize = 20) {
    const [rows] = await connection.promise().query(/*sql*/`
        SELECT * FROM app_messaging_campaign_recipients
        WHERE campaign_id = ? AND status = 'pending'
        ORDER BY recipient_id ASC
        LIMIT ?
    `, [campaign_id, batchSize]);
    return rows;
}

/**
 * Update a recipient's delivery status.
 * Sets sent_at = NOW() when status is 'sent'.
 */
async function updateRecipientStatus(recipient_id, status, error_message = null) {
    await connection.promise().query(/*sql*/`
        UPDATE app_messaging_campaign_recipients
        SET
            status = ?,
            error_message = ?,
            sent_at = IF(? = 'sent', NOW(), sent_at)
        WHERE recipient_id = ?
    `, [status, error_message, status, recipient_id]);
}

/**
 * Recalculate and update sent_count and failed_count for a campaign
 * based on the current state of its recipients.
 */
async function updateCounts(campaign_id) {
    await connection.promise().query(/*sql*/`
        UPDATE app_messaging_campaigns
        SET
            sent_count = (
                SELECT COUNT(*) FROM app_messaging_campaign_recipients
                WHERE campaign_id = ? AND status = 'sent'
            ),
            failed_count = (
                SELECT COUNT(*) FROM app_messaging_campaign_recipients
                WHERE campaign_id = ? AND status = 'failed'
            )
        WHERE campaign_id = ?
    `, [campaign_id, campaign_id, campaign_id]);
}

/**
 * Update the status of a campaign.
 * Also sets started_at = NOW() when transitioning to 'sending',
 * and completed_at = NOW() when transitioning to 'completed'.
 */
async function updateStatus(campaign_id, store_id, status) {
    await connection.promise().query(/*sql*/`
        UPDATE app_messaging_campaigns
        SET
            status = ?,
            started_at   = IF(? = 'sending',   NOW(), started_at),
            completed_at = IF(? = 'completed', NOW(), completed_at)
        WHERE campaign_id = ? AND store_id = ?
    `, [status, status, status, campaign_id, store_id]);
}

/**
 * Cancel a campaign. Only valid when status is 'draft' or 'scheduled'.
 * Returns true if the update affected a row, false otherwise.
 */
async function cancel(campaign_id, store_id) {
    const [result] = await connection.promise().query(/*sql*/`
        UPDATE app_messaging_campaigns
        SET status = 'cancelled'
        WHERE campaign_id = ? AND store_id = ? AND status IN ('draft', 'scheduled')
    `, [campaign_id, store_id]);
    return result.affectedRows > 0;
}

module.exports = {
    create,
    getById,
    list,
    addRecipients,
    getRecipients,
    getNextBatch,
    updateRecipientStatus,
    updateCounts,
    updateStatus,
    cancel,
};
