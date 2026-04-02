const express = require('express');
const Router = express.Router();
const auth = require('../middlewares/auth');
const asyncMiddleware = require('../middlewares/asyncMiddleware');
const campaigns = require('../models/messaging-campaigns');
const wallet = require('../models/messaging-wallet');
const platformApi = require('../services/platform-api');
const { calculateSmsParts } = require('../models/messaging');

const BD_PHONE_REGEX = /^(?:\+?880|0)1[3-9]\d{8}$/;

// GET /api/messaging/campaigns — list
Router.get('/', auth, asyncMiddleware(async (req, res) => {
    const { page, limit, status } = req.query;
    const result = await campaigns.list(req.user.store_id, {
        page: Number(page) || 1, limit: Number(limit) || 20, status,
    });
    res.send({ message: 'Campaigns fetched.', data: result, status: 200 });
}));

// GET /api/messaging/campaigns/audience/customers — fetch from platform (or direct DB fallback)
Router.get('/audience/customers', auth, asyncMiddleware(async (req, res) => {
    const store_id = req.user.store_id;
    const { page = 1, limit: rawLimit = 50, search } = req.query;
    const limit = Math.min(Number(rawLimit) || 50, 250);
    const offset = (Number(page) - 1) * limit;

    // Try platform API first
    try {
        const result = await platformApi.get(store_id, '/apps/v1/customers', { page, limit, search });
        return res.send({ message: 'Customers fetched.', data: result?.data, status: 200 });
    } catch (platformErr) {
        // Fallback: query users table directly (shared DB)
        try {
            const { connection } = require('../startup/db');
            let where = 'WHERE store_id = ? AND deleted_at IS NULL';
            const params = [store_id];
            if (search) {
                where += ' AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)';
                const term = `%${search}%`;
                params.push(term, term, term);
            }
            const platformDb = process.env.PLATFORM_DATABASE || 'selorax_dev';
            const [customers] = await connection.promise().query(
                `SELECT user_id, name, phone, email, created_at FROM ${platformDb}.users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            );
            const [countRows] = await connection.promise().query(
                `SELECT COUNT(*) as total FROM ${platformDb}.users ${where}`, params
            );
            return res.send({
                message: 'Customers fetched.',
                data: customers,
                pagination: { page: Number(page), limit, total: countRows[0].total },
                status: 200,
            });
        } catch (dbErr) {
            return res.status(502).send({ message: 'Failed to fetch customers.', status: 502 });
        }
    }
}));

// GET /api/messaging/campaigns/:campaign_id — detail
Router.get('/:campaign_id', auth, asyncMiddleware(async (req, res) => {
    const campaign = await campaigns.getById(Number(req.params.campaign_id), req.user.store_id);
    if (!campaign) return res.status(404).send({ message: 'Campaign not found.', status: 404 });

    const recipients = await campaigns.getRecipients(campaign.campaign_id, {
        page: Number(req.query.page) || 1,
        limit: Number(req.query.limit) || 50,
        status: req.query.recipient_status,
    });

    res.send({ message: 'Campaign fetched.', data: { ...campaign, recipients }, status: 200 });
}));

// POST /api/messaging/campaigns — create
Router.post('/', auth, asyncMiddleware(async (req, res) => {
    const { name, message, audience_type, phones, filters, scheduled_at } = req.body;
    if (!name || !message) return res.status(400).send({ message: 'name and message are required.', status: 400 });

    let phoneList = [];

    if (audience_type === 'manual' || audience_type === 'csv') {
        if (!Array.isArray(phones) || phones.length === 0) {
            return res.status(400).send({ message: 'phones array is required for manual audience.', status: 400 });
        }
        phoneList = phones.map(p => p.toString().replace(/[\s\-()]+/g, '')).filter(p => BD_PHONE_REGEX.test(p));
        if (phoneList.length === 0) return res.status(400).send({ message: 'No valid BD phone numbers found.', status: 400 });
    } else if (audience_type === 'filter') {
        try {
            const result = await platformApi.get(req.user.store_id, '/apps/v1/customers', { ...filters, limit: 10000 });
            const customers = result?.data?.customers || result?.data || [];
            phoneList = customers.map(c => (c.phone || c.customer_phone || '').replace(/[\s\-()]+/g, '')).filter(p => BD_PHONE_REGEX.test(p));
        } catch (err) {
            return res.status(502).send({ message: 'Failed to fetch customers from platform.', status: 502 });
        }
        if (phoneList.length === 0) return res.status(400).send({ message: 'No customers matched the filters.', status: 400 });
    } else {
        return res.status(400).send({ message: 'Invalid audience_type.', status: 400 });
    }

    phoneList = [...new Set(phoneList)]; // deduplicate

    const parts = phoneList.length * calculateSmsParts(message);
    const credits = await wallet.getCredits(req.user.store_id);
    if (credits < parts) {
        return res.status(402).send({
            message: `Not enough SMS credits. Need ${parts}, have ${credits}.`,
            sms_credits: credits, required: parts, status: 402,
        });
    }

    const campaign = await campaigns.create(req.user.store_id, req.installation.installation_id, {
        name, message, audience_type,
        audience_data: audience_type === 'filter' ? filters : { count: phoneList.length },
        scheduled_at,
    });

    await campaigns.addRecipients(campaign.campaign_id, phoneList);
    res.send({ message: 'Campaign created.', data: { ...campaign, total_recipients: phoneList.length }, status: 200 });
}));

// POST /api/messaging/campaigns/:campaign_id/send — start sending
Router.post('/:campaign_id/send', auth, asyncMiddleware(async (req, res) => {
    const campaign = await campaigns.getById(Number(req.params.campaign_id), req.user.store_id);
    if (!campaign) return res.status(404).send({ message: 'Campaign not found.', status: 404 });
    if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
        return res.status(400).send({ message: `Cannot send campaign in '${campaign.status}' status.`, status: 400 });
    }
    await campaigns.updateStatus(campaign.campaign_id, req.user.store_id, 'sending');
    res.send({ message: 'Campaign sending started.', status: 200 });
}));

// POST /api/messaging/campaigns/:campaign_id/cancel
Router.post('/:campaign_id/cancel', auth, asyncMiddleware(async (req, res) => {
    const cancelled = await campaigns.cancel(Number(req.params.campaign_id), req.user.store_id);
    if (!cancelled) return res.status(400).send({ message: 'Campaign cannot be cancelled.', status: 400 });
    res.send({ message: 'Campaign cancelled.', status: 200 });
}));

module.exports = Router;
