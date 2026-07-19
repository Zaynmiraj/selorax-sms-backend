/**
 * /api/admin — the SMS admin panel API.
 *
 * Completely separate from the /api/messaging tree used by the embedded store
 * app: its own auth (smsAdminAuth cookie), its own identity table. Adding this
 * router does not change any existing customer-facing behavior.
 */
const express = require('express');
const Router = express.Router();
const smsAdminAuth = require('../../middlewares/smsAdminAuth');

// Public auth endpoints (login/verify are open; /me and /logout self-guard).
Router.use('/auth', require('./auth'));

// Everything below requires an authenticated admin.
Router.use(smsAdminAuth);
Router.use('/sender-ids', require('./sender-ids'));
Router.use('/stores', require('./stores'));
Router.use('/logs', require('./logs'));
Router.use('/admins', require('./admins')); // super_admin only (enforced inside)

module.exports = Router;
