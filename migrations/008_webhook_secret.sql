-- 8. Add per-store webhook signing secret
ALTER TABLE `app_messaging_settings`
    ADD COLUMN `webhook_signing_secret` VARCHAR(64) DEFAULT NULL AFTER `auto_sms_enabled`;

UPDATE `app_messaging_settings`
SET webhook_signing_secret = REPLACE(UUID(), '-', '')
WHERE webhook_signing_secret IS NULL;
