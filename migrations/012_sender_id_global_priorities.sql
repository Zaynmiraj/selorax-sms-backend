-- ============================================================
-- SeloraX Messaging App - Ordered Global Sender-ID Fallbacks
-- Run AFTER 011_admin_sms_logs.sql
-- ============================================================

ALTER TABLE `sms_sender_ids`
    ADD COLUMN `global_priority` INT UNSIGNED NULL AFTER `label`,
    ADD UNIQUE KEY `idx_sms_sender_ids_global_priority` (`global_priority`);

-- Preserve the previously effective active global default as the first fallback.
-- The deterministic order matches the old getGlobalDefault() selection.
UPDATE `sms_sender_ids`
SET `global_priority` = 1
WHERE `sender_id_pk` = (
    SELECT `sender_id_pk`
    FROM (
        SELECT `sender_id_pk`
        FROM `sms_sender_ids`
        WHERE `is_global_default` = 1 AND `is_active` = 1
        ORDER BY `updated_at` DESC, `sender_id_pk` ASC
        LIMIT 1
    ) AS `legacy_global_default`
);

-- Global fallback order now comes solely from global_priority.
UPDATE `sms_sender_ids`
SET `is_global_default` = 0
WHERE `is_global_default` = 1;
