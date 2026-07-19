-- ============================================================
-- SeloraX Messaging App - Admin Panel & Sender-ID Catalog
-- Run AFTER 009_campaign_segment_audience.sql
--
-- Adds two NEW tables only. No ALTER on existing tables, so the
-- live customer flow (sends, automations, campaigns, webhooks) is
-- entirely unaffected by applying this migration.
-- ============================================================

-- 1. Admin users for the /admin panel (own identity, separate from
--    the per-store session-token auth used by the embedded app).
CREATE TABLE IF NOT EXISTS `sms_admins` (
    `admin_id` INT NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(120) DEFAULT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `role` ENUM('super_admin','admin') NOT NULL DEFAULT 'admin',
    `otp` VARCHAR(6) DEFAULT NULL,
    `otp_valid_till` BIGINT DEFAULT NULL,
    `password_hash` VARCHAR(255) DEFAULT NULL,
    `is_active` TINYINT NOT NULL DEFAULT 1,
    `last_login` TIMESTAMP NULL DEFAULT NULL,
    `created_by` INT DEFAULT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`admin_id`),
    UNIQUE KEY `idx_sms_admins_phone` (`phone`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the first super admin. Idempotent: keeps the row as super_admin/active
-- if it already exists; never wipes an existing name.
INSERT INTO `sms_admins` (`name`, `phone`, `role`, `is_active`)
VALUES ('Owner', '01731620933', 'super_admin', 1)
ON DUPLICATE KEY UPDATE `role` = 'super_admin', `is_active` = 1;

-- 2. Global sender-ID catalog. Admin registers Anbernet-approved sender IDs
--    here; stores are then assigned one of these (written to the existing
--    app_messaging_settings.sender_id column). One row may be flagged as the
--    global default for stores that have no explicit assignment.
CREATE TABLE IF NOT EXISTS `sms_sender_ids` (
    `sender_id_pk` INT NOT NULL AUTO_INCREMENT,
    `value` VARCHAR(20) NOT NULL,
    `type` ENUM('numeric','alnum') NOT NULL DEFAULT 'alnum',
    `label` VARCHAR(120) DEFAULT NULL,
    `is_global_default` TINYINT NOT NULL DEFAULT 0,
    `is_active` TINYINT NOT NULL DEFAULT 1,
    `created_by` INT DEFAULT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`sender_id_pk`),
    UNIQUE KEY `idx_sms_sender_ids_value` (`value`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
