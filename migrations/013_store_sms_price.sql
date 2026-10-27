-- ============================================================
-- SeloraX Messaging App - per-store SMS price + admin-set default
-- Run AFTER 012_sender_id_global_priorities.sql
--
-- The price per SMS for CUSTOM credit purchases (packages keep their own
-- prices). Resolution: app_messaging_settings.sms_unit_price (store override)
-- → app_messaging_config 'default_sms_unit_price' → 0.70 in code.
-- ============================================================

-- 1. App-wide settings editable from the admin panel (key/value).
CREATE TABLE IF NOT EXISTS `app_messaging_config` (
    `config_key` VARCHAR(64) NOT NULL,
    `config_value` VARCHAR(255) NOT NULL,
    `updated_by_admin_id` INT DEFAULT NULL,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`config_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Same value the app charged before this migration.
INSERT IGNORE INTO `app_messaging_config` (`config_key`, `config_value`)
VALUES ('default_sms_unit_price', '0.70');

-- 2. Optional per-store price. NULL = use the default.
ALTER TABLE `app_messaging_settings`
    ADD COLUMN `sms_unit_price` DECIMAL(10,4) DEFAULT NULL AFTER `sms_credits`;
