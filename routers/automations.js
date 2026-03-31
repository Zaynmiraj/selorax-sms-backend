const express = require('express');
const Router = express.Router();
const auth = require('../middlewares/auth');
const asyncMiddleware = require('../middlewares/asyncMiddleware');
const automations = require('../models/messaging-automations');

Router.get('/', auth, asyncMiddleware(async (req, res) => {
    const list = await automations.getAll(req.user.store_id, req.installation.installation_id);
    res.send({
        message: 'Automations fetched.',
        data: { automations: list, variables: automations.TEMPLATE_VARIABLES },
        status: 200,
    });
}));

Router.put('/:automation_id', auth, asyncMiddleware(async (req, res) => {
    const updated = await automations.update(
        Number(req.params.automation_id),
        req.user.store_id,
        req.body
    );
    if (!updated) return res.status(404).send({ message: 'Automation not found.', status: 404 });
    res.send({ message: 'Automation updated.', data: updated, status: 200 });
}));

module.exports = Router;
