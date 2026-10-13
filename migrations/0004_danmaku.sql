-- 自建弹幕仅存用户提交的时间轴文本；视频流与第三方弹幕不落库。
-- 读路径由 KV 缓存，D1 只承担持久化和缓存未命中查询。
CREATE TABLE IF NOT EXISTS danmaku (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL,
  episode_url TEXT NOT NULL,
  time_seconds REAL NOT NULL,
  text TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'rtl',
  color TEXT NOT NULL DEFAULT '#ffffff',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_danmaku_episode_time
  ON danmaku (subject_id, episode_url, time_seconds);

