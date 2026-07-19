-- ============================================================
-- SeloraX Messaging App - Admin SMS log
-- Run AFTER 010_admin_and_sender_ids.sql
--
-- One NEW table. Records SMS the ADMIN PANEL itself sends (login OTPs today,
-- any future admin-originated sends) — kept separate from customer SMS
-- (app_messaging_logs) and from store credits. Additive: no ALTER, no risk to
-- existing data or the customer flow.
-- ============================================================

CREATE TABLE IF NOT EXISTS `sms_admin_logs` (
    `log_id` INT NOT NULL AUTO_INCREMENT,
    `admin_id` INT DEFAULT NULL,                       -- which admin it concerned (nullable)
    `phone` VARCHAR(20) NOT NULL,                      -- recipient
    `purpose` VARCHAR(50) NOT NULL DEFAULT 'login_otp',
    `status` ENUM('sent','failed') NOT NULL,
    `provider` VARCHAR(50) DEFAULT NULL,
    `provider_response` JSON DEFAULT NULL,             -- redacted before insert (never the OTP)
    `error` VARCHAR(255) DEFAULT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`log_id`),
    KEY `idx_sms_admin_logs_created` (`created_at`),
    KEY `idx_sms_admin_logs_admin` (`admin_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
