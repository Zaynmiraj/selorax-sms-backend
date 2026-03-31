-- ============================================================
-- SeloraX Messaging App - SMS Package-Based Billing
-- Run AFTER 004_scheduling.sql
-- ============================================================

-- 1. SMS packages (predefined purchase options)
CREATE TABLE IF NOT EXISTS `app_messaging_packages` (
    `package_id` INT NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `sms_count` INT NOT NULL,
    `price_per_sms` DECIMAL(10,4) NOT NULL,
    `total_price` DECIMAL(12,2) NOT NULL,
    `is_active` TINYINT DEFAULT 1,
    `sort_order` INT DEFAULT 0,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`package_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed packages
INSERT INTO `app_messaging_packages` (`name`, `sms_count`, `price_per_sms`, `total_price`, `sort_order`)
VALUES
    ('Starter', 1000, 0.60, 600.00, 1),
    ('Business', 5000, 0.50, 2500.00, 2),
    ('Enterprise', 10000, 0.45, 4500.00, 3);

-- 2. Track per-store SMS credits
ALTER TABLE `app_messaging_settings`
    ADD COLUMN `sms_credits` INT DEFAULT 0 AFTER `auto_sms_enabled`;

-- 3. Purchase history (links charge_id to package for credit tracking)
CREATE TABLE IF NOT EXISTS `app_messaging_purchases` (
    `purchase_id` INT NOT NULL AUTO_INCREMENT,
    `store_id` INT NOT NULL,
    `package_id` INT NOT NULL,
    `charge_id` INT DEFAULT NULL,
    `sms_count` INT NOT NULL,
    `amount` DECIMAL(12,2) NOT NULL,
    `status` ENUM('pending','credited','failed') DEFAULT 'pending',
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `credited_at` TIMESTAMP DEFAULT NULL,
    PRIMARY KEY (`purchase_id`),
    KEY `idx_purchase_store` (`store_id`),
    KEY `idx_purchase_charge` (`charge_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
