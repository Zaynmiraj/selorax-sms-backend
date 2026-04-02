-- ============================================================
-- SeloraX Messaging App - Custom SMS purchases
-- Run AFTER 006_automations_campaigns.sql
-- ============================================================

ALTER TABLE `app_messaging_purchases`
    MODIFY COLUMN `package_id` INT NULL,
    ADD COLUMN `purchase_type` ENUM('package','custom') NOT NULL DEFAULT 'package' AFTER `package_id`,
    ADD COLUMN `custom_label` VARCHAR(150) DEFAULT NULL AFTER `purchase_type`,
    ADD COLUMN `unit_price` DECIMAL(10,4) DEFAULT NULL AFTER `custom_label`;
