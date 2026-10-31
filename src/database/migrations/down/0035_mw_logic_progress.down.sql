-- Rollback for 0035_mw_logic_progress.sql (FHS-395). Manual-only.
DROP TABLE IF EXISTS "mw_logic_certificates";
DROP TABLE IF EXISTS "mw_logic_progress";
