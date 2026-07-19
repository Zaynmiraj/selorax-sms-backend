const express = require('express');
const Router = express.Router();
const { connection } = require('../../startup/db');
const asyncMiddleware = require('../../middlewares/asyncMiddleware');
const { validateDatabaseIdentifier } = require('../../models/messaging');

const db = connection.promise();

async function getStoreName(storeId) {
    if (!storeId) return null;
    const platformDb = validateDatabaseIdentifier(process.env.PLATFORM_DATABASE);
    if (!platformDb) return `Store #${storeId}`;
    try {
        const [rows] = await db.query(`SELECT name FROM \`${platformDb}\`.stores WHERE store_id = ?`, [storeId]);
        return rows[0]?.name || `Store #${storeId}`;
    } catch (e) {
        return `Store #${storeId}`;
    }
}

// GET /api/admin/dashboard
Router.get('/', asyncMiddleware(async (req, res) => {
    const [storesRow] = await db.query(`SELECT COUNT(*) as c FROM app_messaging_settings WHERE is_enabled = 1`);
    const totalStores = Number(storesRow[0]?.c) || 0;

    const [creditsRow] = await db.query(`SELECT SUM(sms_credits) as s FROM app_messaging_settings`);
    const totalCredits = Number(creditsRow[0]?.s) || 0;

    const [smsRow] = await db.query(`SELECT COUNT(*) as c FROM app_messaging_logs WHERE status = 'sent'`);
    const overallSmsSent = Number(smsRow[0]?.c) || 0;

    const [topRow] = await db.query(`
        SELECT store_id, COUNT(*) as c 
        FROM app_messaging_logs 
        WHERE status = 'sent' 
        GROUP BY store_id 
        ORDER BY c DESC LIMIT 1
    `);
    const topStoreId = topRow[0]?.store_id || null;
    const topStoreSends = Number(topRow[0]?.c) || 0;
    const topStoreName = await getStoreName(topStoreId);

    // Get last 14 days stats
    const [dailyRows] = await db.query(`
        SELECT DATE(created_at) as date, COUNT(*) as sent_count 
        FROM app_messaging_logs 
        WHERE status = 'sent' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
        GROUP BY date 
        ORDER BY date ASC
    `);

    // Fill in missing days so charts don't look broken
    const dailyStats = [];
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        
        const row = dailyRows.find(r => {
            // some drivers return JS Date, some string
            const rDate = r.date instanceof Date ? r.date.toISOString().split('T')[0] : r.date;
            return rDate === dateStr;
        });
        
        dailyStats.push({
            date: dateStr,
            sent_count: row ? Number(row.sent_count) : 0
        });
    }

    return res.send({
        status: 200,
        stats: {
            totalStores,
            totalCredits,
            overallSmsSent,
            topStore: topStoreId ? { store_id: topStoreId, name: topStoreName, sent: topStoreSends } : null,
            dailyStats
        }
    });
}));

module.exports = Router;
