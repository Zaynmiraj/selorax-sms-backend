-- ============================================================
-- SeloraX Messaging App - Billing & Extended Tables
-- Run AFTER 002_messaging_app.sql
-- ============================================================

-- 1. Wallet per store
CREATE TABLE IF NOT EXISTS `app_messaging_wallets` (
    `wallet_id` INT NOT NULL AUTO_INCREMENT,
    `store_id` INT NOT NULL,
    `balance` DECIMAL(12,2) DEFAULT 0.00,
    `currency` VARCHAR(3) DEFAULT 'BDT',
    `total_topup` DECIMAL(12,2) DEFAULT 0.00,
    `total_spent` DECIMAL(12,2) DEFAULT 0.00,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`wallet_id`),
    UNIQUE KEY `idx_wallet_store` (`store_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Transaction log
CREATE TABLE IF NOT EXISTS `app_messaging_transactions` (
    `transaction_id` INT NOT NULL AUTO_INCREMENT,
    `store_id` INT NOT NULL,
    `wallet_id` INT NOT NULL,
    `type` ENUM('topup','deduction','refund') NOT NULL,
    `amount` DECIMAL(12,2) NOT NULL,
    `balance_after` DECIMAL(12,2) NOT NULL,
    `description` VARCHAR(255) DEFAULT NULL,
    `payment_method` VARCHAR(50) DEFAULT NULL,
    `payment_reference` VARCHAR(255) DEFAULT NULL,
    `sms_log_id` INT DEFAULT NULL,
    `created_by` INT DEFAULT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`transaction_id`),
    KEY `idx_txn_store` (`store_id`),
    KEY `idx_txn_wallet` (`wallet_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. SMS pricing
CREATE TABLE IF NOT EXISTS `app_messaging_pricing` (
    `pricing_id` INT NOT NULL AUTO_INCREMENT,
    `provider` VARCHAR(50) NOT NULL,
    `sms_type` VARCHAR(20) DEFAULT 'text',
    `cost_per_sms` DECIMAL(10,4) NOT NULL,
    `price_per_sms` DECIMAL(10,4) NOT NULL,
    `is_active` TINYINT DEFAULT 1,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`pricing_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `app_messaging_pricing` (`provider`, `sms_type`, `cost_per_sms`, `price_per_sms`)
VALUES ('bulksms', 'text', 0.25, 0.50)
ON DUPLICATE KEY UPDATE `price_per_sms` = VALUES(`price_per_sms`);

-- 4. SMS templates per installation
CREATE TABLE IF NOT EXISTS `app_messaging_templates` (
    `template_id` INT NOT NULL AUTO_INCREMENT,
    `installation_id` INT NOT NULL,
    `store_id` INT NOT NULL,
    `event_topic` VARCHAR(100) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `template_text` TEXT NOT NULL,
    `is_active` TINYINT DEFAULT 1,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`template_id`),
    UNIQUE KEY `idx_tmpl_install_event` (`installation_id`, `event_topic`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Payment sessions (EPS)
CREATE TABLE IF NOT EXISTS `app_messaging_payment_sessions` (
    `session_id` INT NOT NULL AUTO_INCREMENT,
    `store_id` INT NOT NULL,
    `wallet_id` INT NOT NULL,
    `amount` DECIMAL(12,2) NOT NULL,
    `currency` VARCHAR(3) DEFAULT 'BDT',
    `payment_method` VARCHAR(50) NOT NULL DEFAULT 'eps',
    `status` ENUM('pending','completed','failed','cancelled') DEFAULT 'pending',
    `merchant_transaction_id` VARCHAR(50) DEFAULT NULL,
    `eps_transaction_id` VARCHAR(255) DEFAULT NULL,
    `callback_data` JSON DEFAULT NULL,
    `created_by` INT DEFAULT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `completed_at` TIMESTAMP DEFAULT NULL,
    PRIMARY KEY (`session_id`),
    KEY `idx_ps_store` (`store_id`),
    KEY `idx_ps_merchant_txn` (`merchant_transaction_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Extend settings table with new columns
ALTER TABLE `app_messaging_settings`
    ADD COLUMN `use_own_provider` TINYINT DEFAULT 0 AFTER `is_enabled`,
    ADD COLUMN `provider_endpoint` VARCHAR(255) DEFAULT NULL AFTER `sender_id`,
    ADD COLUMN `auto_sms_enabled` TINYINT DEFAULT 1 AFTER `provider_endpoint`;
