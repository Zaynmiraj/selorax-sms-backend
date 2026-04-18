const campaigns = require('../models/messaging-campaigns');
const messaging = require('../models/messaging');
const wallet = require('../models/messaging-wallet');
const { connection } = require('../startup/db');

const BATCH_SIZE = 20;
const POLL_INTERVAL_MS = 5000;
let pollInterval = null;
let pollInFlight = false;

/**
 * Process active sending campaigns — called by poll interval.
 */
async function processCampaigns() {
    const [active] = await connection.promise().query(
        `SELECT * FROM app_messaging_campaigns
         WHERE (status = 'sending')
            OR (status = 'scheduled' AND scheduled_at <= NOW())
         ORDER BY created_at ASC LIMIT 5`
    );

    for (const campaign of active) {
        if (campaign.status === 'scheduled') {
            await campaigns.updateStatus(campaign.campaign_id, campaign.store_id, 'sending');
        }
        await processSingleCampaign(campaign);
    }
}

/**
 * Re-read a campaign row; used between batches to detect admin cancellation.
 */
async function refetchCampaign(campaign_id) {
    const [rows] = await connection.promise().query(
        `SELECT status FROM app_messaging_campaigns WHERE campaign_id = ? LIMIT 1`,
        [campaign_id]
    );
    return rows[0] || null;
}

/**
 * Send the next batch of recipients for a campaign.
 */
async function processSingleCampaign(campaign) {
    // Skip if the store has been disabled/uninstalled since the campaign started
    const [settingsRows] = await connection.promise().query(
        `SELECT is_enabled FROM app_messaging_settings WHERE store_id = ? LIMIT 1`,
        [campaign.store_id]
    );
    if (!settingsRows[0] || !settingsRows[0].is_enabled) {
        await connection.promise().query(
            `UPDATE app_messaging_campaign_recipients SET status = 'failed', error_message = 'Store disabled'
             WHERE campaign_id = ? AND status = 'pending'`,
            [campaign.campaign_id]
        );
        await campaigns.updateCounts(campaign.campaign_id);
        await campaigns.updateStatus(campaign.campaign_id, campaign.store_id, 'cancelled');
        console.warn(`[Campaign] ${campaign.campaign_id} cancelled — store ${campaign.store_id} is disabled`);
        return;
    }

    const batch = await campaigns.getNextBatch(campaign.campaign_id, BATCH_SIZE);

    if (batch.length === 0) {
        await campaigns.updateCounts(campaign.campaign_id);
        await campaigns.updateStatus(campaign.campaign_id, campaign.store_id, 'completed');
        console.log(`[Campaign] ${campaign.campaign_id} completed for store ${campaign.store_id}`);
        return;
    }

    for (const recipient of batch) {
        // Re-check campaign state per recipient so a cancellation mid-batch is respected
        const current = await refetchCampaign(campaign.campaign_id);
        if (!current || current.status !== 'sending') {
            console.log(`[Campaign] ${campaign.campaign_id} halted mid-batch — status=${current?.status}`);
            return;
        }

        const hasCredits = await wallet.hasCredits(campaign.store_id, 1);
        if (!hasCredits) {
            console.warn(`[Campaign] ${campaign.campaign_id} — out of credits, completing with remaining failed`);
            // Mark all remaining pending recipients as failed
            await connection.promise().query(
                `UPDATE app_messaging_campaign_recipients SET status = 'failed', error_message = 'Insufficient SMS credits'
                 WHERE campaign_id = ? AND status = 'pending'`,
                [campaign.campaign_id]
            );
            await campaigns.updateCounts(campaign.campaign_id);
            await campaigns.updateStatus(campaign.campaign_id, campaign.store_id, 'completed');
            return;
        }

        try {
            const result = await messaging.sendSms(
                campaign.store_id,
                campaign.installation_id,
                recipient.phone,
                campaign.message,
                { event_topic: 'campaign', resource_id: String(campaign.campaign_id) }
            );

            await campaigns.updateRecipientStatus(
                recipient.recipient_id,
                result.success ? 'sent' : 'failed',
                result.success ? null : 'SMS send failed'
            );
        } catch (err) {
            await campaigns.updateRecipientStatus(recipient.recipient_id, 'failed', err.message);
        }
    }

    await campaigns.updateCounts(campaign.campaign_id);
}

function start() {
    if (pollInterval) return;
    console.log('[CampaignSender] Started — polling every 5s');
    pollInterval = setInterval(async () => {
        if (pollInFlight) return; // Prevent overlapping polls (single-instance race guard)
        pollInFlight = true;
        try { await processCampaigns(); } catch (err) {
            console.error('[CampaignSender] Poll error:', err.message);
        } finally {
            pollInFlight = false;
        }
    }, POLL_INTERVAL_MS);
    pollInterval.unref();
}

function stop() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

module.exports = { processCampaigns, start, stop };
