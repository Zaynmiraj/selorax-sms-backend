-- ============================================================
-- SeloraX Messaging App — Automations & Campaigns
-- Run AFTER 005_sms_packages.sql
-- ============================================================

-- 1. Automations — replaces simple templates with full event rules
CREATE TABLE IF NOT EXISTS `app_messaging_automations` (
    `automation_id` INT NOT NULL AUTO_INCREMENT,
    `store_id` INT NOT NULL,
    `installation_id` INT NOT NULL,
    `event_key` VARCHAR(100) NOT NULL,
    `event_label` VARCHAR(255) NOT NULL,
    `event_group` VARCHAR(50) NOT NULL DEFAULT 'order',
    `is_active` TINYINT DEFAULT 0,
    `delivery_mode` ENUM('instant','delayed','off') DEFAULT 'off',
    `delay_minutes` INT DEFAULT 0,
    `template_text` TEXT DEFAULT NULL,
    `template_name` VARCHAR(100) DEFAULT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`automation_id`),
    UNIQUE KEY `idx_auto_store_event` (`store_id`, `event_key`),
    KEY `idx_auto_store` (`store_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Campaigns — bulk/marketing SMS
CREATE TABLE IF NOT EXISTS `app_messaging_campaigns` (
    `campaign_id` INT NOT NULL AUTO_INCREMENT,
    `store_id` INT NOT NULL,
    `installation_id` INT NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `message` TEXT NOT NULL,
    `audience_type` ENUM('manual','filter','csv') NOT NULL DEFAULT 'manual',
    `audience_data` JSON DEFAULT NULL,
    `status` ENUM('draft','scheduled','sending','completed','cancelled') DEFAULT 'draft',
    `scheduled_at` TIMESTAMP NULL DEFAULT NULL,
    `started_at` TIMESTAMP NULL DEFAULT NULL,
    `completed_at` TIMESTAMP NULL DEFAULT NULL,
    `total_recipients` INT DEFAULT 0,
    `sent_count` INT DEFAULT 0,
    `failed_count` INT DEFAULT 0,
    `credits_used` INT DEFAULT 0,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`campaign_id`),
    KEY `idx_campaign_store` (`store_id`),
    KEY `idx_campaign_status` (`status`, `scheduled_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Campaign recipients — individual phone tracking
CREATE TABLE IF NOT EXISTS `app_messaging_campaign_recipients` (
    `recipient_id` INT NOT NULL AUTO_INCREMENT,
    `campaign_id` INT NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `status` ENUM('pending','sent','failed') DEFAULT 'pending',
    `error_message` VARCHAR(255) DEFAULT NULL,
    `sent_at` TIMESTAMP NULL DEFAULT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`recipient_id`),
    KEY `idx_recipient_campaign` (`campaign_id`),
    KEY `idx_recipient_status` (`campaign_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Extend settings with auto-renewal fields
ALTER TABLE `app_messaging_settings`
    ADD COLUMN `auto_renew_enabled` TINYINT DEFAULT 0 AFTER `sms_credits`,
    ADD COLUMN `auto_renew_package_id` INT DEFAULT NULL AFTER `auto_renew_enabled`,
    ADD COLUMN `auto_renew_threshold` INT DEFAULT 50 AFTER `auto_renew_package_id`;
