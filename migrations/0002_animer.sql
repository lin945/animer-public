-- animer 业务表结构（番剧站点）
-- 应用：npx wrangler d1 execute animer-db --local --file=./migrations/0002_animer.sql
--       npx wrangler d1 execute animer-db --remote --file=./migrations/0002_animer.sql

-- 订阅源：animeko css1.json 订阅（可多个）
CREATE TABLE IF NOT EXISTS subscription_sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL UNIQUE,   -- css1.json 地址
  raw_config    TEXT,                   -- 原始 JSON（备用）
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_synced_at INTEGER,
  created_at    INTEGER NOT NULL
);

-- 播放源站点：从 css1.json 解析出的每个 mediaSource
CREATE TABLE IF NOT EXISTS media_sources (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  name           TEXT NOT NULL,
  icon_url       TEXT,
  homepage       TEXT,
  match_video_url TEXT,                  -- 取流正则（从页面/跳转刮 m3u8/mp4）
  search_config  TEXT,                  -- 搜索/选集选择器 JSON
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (subscription_id) REFERENCES subscription_sources(id)
);

-- 番剧元数据（来自 AniList，缓存）
CREATE TABLE IF NOT EXISTS anime (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  anilist_id   INTEGER UNIQUE,
  title        TEXT NOT NULL,
  title_native TEXT,
  cover_image  TEXT,
  description  TEXT,
  year         INTEGER,
  format       TEXT,
  status       TEXT,
  created_at   INTEGER NOT NULL
);

-- 剧集目录（元数据）
CREATE TABLE IF NOT EXISTS episodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  anime_id    INTEGER NOT NULL,
  episode_no  INTEGER NOT NULL,
  title       TEXT,
  thumbnail   TEXT,
  sources_json TEXT,                    -- [{media_source_id, page_url}]
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (anime_id) REFERENCES anime(id)
);

-- 收藏
CREATE TABLE IF NOT EXISTS favorites (
  user_id    TEXT NOT NULL,
  anime_id   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, anime_id),
  FOREIGN KEY (anime_id) REFERENCES anime(id)
);

-- 观看进度
CREATE TABLE IF NOT EXISTS watch_progress (
  user_id         TEXT NOT NULL,
  anime_id        INTEGER NOT NULL,
  episode_no      INTEGER NOT NULL,
  position_seconds INTEGER NOT NULL DEFAULT 0,
  completed       INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, anime_id, episode_no),
  FOREIGN KEY (anime_id) REFERENCES anime(id)
);

