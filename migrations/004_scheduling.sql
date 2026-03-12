-- Scheduled SMS jobs
CREATE TABLE IF NOT EXISTS `app_messaging_scheduled` (
    `job_id` INT NOT NULL AUTO_INCREMENT,
    `store_id` INT NOT NULL,
    `installation_id` INT DEFAULT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `message` TEXT NOT NULL,
    `event_topic` VARCHAR(100) DEFAULT NULL,
    `resource_id` VARCHAR(50) DEFAULT NULL,
    `status` ENUM('pending','processing','sent','failed','cancelled') DEFAULT 'pending',
    `scheduled_at` TIMESTAMP NOT NULL,
    `attempts` INT DEFAULT 0,
    `max_attempts` INT DEFAULT 3,
    `last_error` TEXT DEFAULT NULL,
    `sms_log_id` INT DEFAULT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `processed_at` TIMESTAMP DEFAULT NULL,
    PRIMARY KEY (`job_id`),
    KEY `idx_sched_status_time` (`status`, `scheduled_at`),
    KEY `idx_sched_store` (`store_id`),
    KEY `idx_sched_resource` (`store_id`, `event_topic`, `resource_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add delay_minutes to templates (0 = immediate, >0 = delayed)
ALTER TABLE `app_messaging_templates`
    ADD COLUMN `delay_minutes` INT DEFAULT 0 AFTER `is_active`;
