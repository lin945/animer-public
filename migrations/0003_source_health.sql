-- 源健康度 + 用户凭据（对标 animeko 的「直连优先 / 被挡则标记」策略）
--
-- 背景：Worker 里没有浏览器，Cloudflare Turnstile / 登录墙类源永远过不去。
-- 与其让用户每次白等，不如把「这个源现在能不能用」记录在案：
--   health = ok       最近一次请求成功
--   health = blocked  被源站反爬/登录墙挡住（403 / CF 挑战 / 空 Forbidden）
--   health = broken   源站故障或结构改版（4xx/5xx、选择器 0 命中）
--   health = unknown  还没探测过
-- 连续失败达到阈值后自动 enabled = 0，用户可在详情页手动重新启用。
--
-- cookie / ua：给「需要 cf_clearance 或登录态」的源留的手动通道。
-- 注意 cf_clearance 绑定 User-Agent，cookie 与 ua 必须成对填写，否则照样被挑战。
--
-- 应用：npx wrangler d1 migrations apply animer-db --local --persist-to .wrangler/state
--       npx wrangler d1 migrations apply animer-db --remote

ALTER TABLE media_sources ADD COLUMN cookie TEXT;
ALTER TABLE media_sources ADD COLUMN ua TEXT;
ALTER TABLE media_sources ADD COLUMN health TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE media_sources ADD COLUMN health_reason TEXT;
ALTER TABLE media_sources ADD COLUMN health_checked_at INTEGER;
ALTER TABLE media_sources ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
-- 手动标记：用户手动关掉的源，自动健康检查不会把它重新打开
ALTER TABLE media_sources ADD COLUMN manual_disabled INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_media_sources_health ON media_sources (health);
CREATE INDEX IF NOT EXISTS idx_media_sources_enabled ON media_sources (enabled);

