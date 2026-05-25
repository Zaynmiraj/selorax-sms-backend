const { connection } = require('../startup/db');

/**
 * Default automation event configs seeded for each store on first access.
 */
const DEFAULT_AUTOMATIONS = [
  { event_key: 'order.placed',          event_label: 'Order Placed',          event_group: 'order' },
  { event_key: 'order.confirmed',       event_label: 'Order Confirmed',       event_group: 'order' },
  { event_key: 'order.shipped',         event_label: 'Order Shipped',         event_group: 'order' },
  { event_key: 'order.delivered',       event_label: 'Order Delivered',       event_group: 'order' },
  { event_key: 'order.cancelled',       event_label: 'Order Cancelled',       event_group: 'order' },
  { event_key: 'order.refunded',        event_label: 'Order Refunded',        event_group: 'order' },
  { event_key: 'order.payment_received', event_label: 'Payment Received',     event_group: 'order' },
  { event_key: 'customer.welcome',      event_label: 'New Customer Welcome',  event_group: 'customer' },
  { event_key: 'customer.updated',      event_label: 'Customer Updated',      event_group: 'customer' },
];

/**
 * Maps platform webhook events to automation event_keys.
 * For 'order.status_changed', the value is an object keyed by order status.
 * For other events, the value is a direct event_key string.
 */
const WEBHOOK_EVENT_MAP = {
  'order.status_changed': {
    processing: 'order.confirmed',
    shipped:    'order.shipped',
    completed:  'order.delivered',
    delivered:  'order.delivered',
    cancelled:  'order.cancelled',
    hold:       'order.cancelled',
    refunded:   'order.refunded',
  },
  // order.created carries the order's initial status. Storefront checkouts
  // create the order as 'pending' (customer placed it → Order Placed). Orders
  // created by the merchant in the dashboard are already confirmed/approved,
  // i.e. 'processing' (→ Order Confirmed). Any other initial status is ignored.
  'order.created': {
    pending:    'order.placed',
    processing: 'order.confirmed',
  },
  'customer.created': 'customer.welcome',
  'customer.updated': 'customer.updated',
};

/**
 * Available template variables per event group.
 */
const TEMPLATE_VARIABLES = {
  order: [
    'order_id', 'order_number', 'customer_name', 'customer_phone',
    'total', 'status', 'tracking_id', 'store_name',
  ],
  customer: [
    'customer_name', 'customer_phone', 'customer_email', 'store_name',
  ],
};

/**
 * Seed DEFAULT_AUTOMATIONS for a store if none exist yet.
 */
async function ensureDefaults(store_id, installation_id) {
  // Seed any default automations the store is missing. Runs on every access so
  // newly-added defaults (e.g. order.placed) are backfilled to existing stores,
  // not just stores installing for the first time.
  const [existing] = await connection.promise().query(/*sql*/`
    SELECT event_key FROM app_messaging_automations
    WHERE store_id = ?
  `, [store_id]);

  const existingKeys = new Set(existing.map((r) => r.event_key));
  const missing = DEFAULT_AUTOMATIONS.filter((d) => !existingKeys.has(d.event_key));

  if (missing.length === 0) return;

  const rows = missing.map(({ event_key, event_label, event_group }) => [
    store_id, installation_id, event_key, event_label, event_group,
  ]);

  await connection.promise().query(/*sql*/`
    INSERT IGNORE INTO app_messaging_automations
      (store_id, installation_id, event_key, event_label, event_group)
    VALUES ?
  `, [rows]);
}

/**
 * Get all automations for a store, seeding defaults if needed.
 */
async function getAll(store_id, installation_id) {
  await ensureDefaults(store_id, installation_id);

  const [rows] = await connection.promise().query(/*sql*/`
    SELECT * FROM app_messaging_automations
    WHERE store_id = ?
    ORDER BY event_group, event_key
  `, [store_id]);

  return rows;
}

/**
 * Get a single active automation by event key.
 */
async function getByEventKey(store_id, event_key) {
  const [rows] = await connection.promise().query(/*sql*/`
    SELECT * FROM app_messaging_automations
    WHERE store_id = ? AND event_key = ? AND is_active = 1
    LIMIT 1
  `, [store_id, event_key]);

  return rows[0] || null;
}

/**
 * Update allowed fields on an automation row and return the updated record.
 */
async function update(automation_id, store_id, updates) {
  const allowed = ['is_active', 'delivery_mode', 'delay_minutes', 'template_text', 'template_name'];
  const sets = [];
  const params = [];

  for (const key of allowed) {
    if (updates[key] !== undefined) {
      sets.push(`\`${key}\` = ?`);
      params.push(updates[key]);
    }
  }

  if (sets.length === 0) return null;
  params.push(automation_id, store_id);

  await connection.promise().query(/*sql*/`
    UPDATE app_messaging_automations
    SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
    WHERE automation_id = ? AND store_id = ?
  `, params);

  const [rows] = await connection.promise().query(/*sql*/`
    SELECT * FROM app_messaging_automations
    WHERE automation_id = ? AND store_id = ?
    LIMIT 1
  `, [automation_id, store_id]);

  return rows[0] || null;
}

/**
 * Resolve a webhook event + optional order status to an automation event_key.
 * Returns null if no mapping is found.
 */
function resolveEventKey(webhookEvent, orderStatus) {
  const mapping = WEBHOOK_EVENT_MAP[webhookEvent];
  if (!mapping) return null;
  if (typeof mapping === 'string') return mapping;
  return mapping[orderStatus] || null;
}

module.exports = {
  DEFAULT_AUTOMATIONS,
  WEBHOOK_EVENT_MAP,
  TEMPLATE_VARIABLES,
  ensureDefaults,
  getAll,
  getByEventKey,
  update,
  resolveEventKey,
};
