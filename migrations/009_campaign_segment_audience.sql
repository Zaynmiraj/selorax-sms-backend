-- 009: Add 'segment' to the campaign audience_type ENUM.
-- Campaigns can now target a saved customer segment created in the SeloraX
-- dashboard (resolved live via the platform app API at create time).
ALTER TABLE `app_messaging_campaigns`
  MODIFY COLUMN `audience_type`
  ENUM('manual','filter','csv','segment') NOT NULL DEFAULT 'manual';
