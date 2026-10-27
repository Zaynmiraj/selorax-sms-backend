/**
 * READ-ONLY export of this app's sender-ID catalog and per-store sender
 * assignments, for the SeloraX Messages platform to import
 * (selorax-messaging-platform: scripts/import-partner-stores.ts).
 *
 * Only SELECTs. Writes one JSON file and nothing else.
 *
 * Run: node scripts/export-for-platform.js [out.json]   (default ./platform-export.json)
 */
require('dotenv').config();
const fs = require('fs');
const { connection } = require('../startup/db');
const { validateDatabaseIdentifier } = require('../models/messaging');

async function main() {
    const out = process.argv[2] || 'platform-export.json';
    const db = connection.promise();

    const [senderIds] = await db.query(/*sql*/`
        SELECT value, label, is_active, global_priority
        FROM sms_sender_ids
        ORDER BY global_priority IS NULL, global_priority ASC, value ASC
    `);
    const [settings] = await db.query(/*sql*/`
        SELECT store_id, is_enabled, sender_id
        FROM app_messaging_settings
        ORDER BY store_id ASC
    `);

    const names = {};
    const platformDb = validateDatabaseIdentifier(process.env.PLATFORM_DATABASE);
    if (platformDb && settings.length) {
        try {
            const ids = settings.map((s) => s.store_id);
            const [rows] = await db.query(
                `SELECT store_id, name, domain FROM \`${platformDb}\`.stores WHERE store_id IN (${ids.map(() => '?').join(',')})`,
                ids
            );
            for (const r of rows) names[r.store_id] = r;
        } catch (e) {
            console.warn(`Store names unavailable (${e.code || e.message}); exporting without them.`);
        }
    }

    const data = {
        exported_at: new Date().toISOString(),
        sender_ids: senderIds.map((s) => ({
            value: s.value,
            label: s.label || null,
            is_active: !!s.is_active,
            global_priority: s.global_priority === null ? null : Number(s.global_priority),
        })),
        stores: settings.map((s) => ({
            store_id: s.store_id,
            name: names[s.store_id]?.name || null,
            domain: names[s.store_id]?.domain || null,
            is_enabled: !!s.is_enabled,
            sender_id: s.sender_id || null,
        })),
    };
    fs.writeFileSync(out, JSON.stringify(data, null, 2));
    console.log(`Wrote ${out}: ${data.sender_ids.length} sender IDs, ${data.stores.length} stores ` +
        `(${data.stores.filter((s) => s.sender_id).length} with an assigned sender).`);
}

main()
    .catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
    })
    .finally(() => connection.end());
