-- Rollback for 0019_tan_nightcrawler.sql (FHS-270).
-- Drops the ChildWorld Journal + Learn tables. CASCADE clears FKs + indexes.
DROP TABLE IF EXISTS "learn_progress" CASCADE;
DROP TABLE IF EXISTS "journal_entries" CASCADE;
