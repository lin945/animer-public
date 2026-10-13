-- D1 初始化 schema（示例表）
-- 应用方式：
--   npx wrangler d1 execute animer-db --remote --file=./migrations/0001_init.sql
-- 或：npx wrangler d1 execute animer-db --local --file=./migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

