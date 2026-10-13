-- Non-destructive index for admin delta sync and subscription counts.
CREATE INDEX IF NOT EXISTS idx_media_sources_subscription ON media_sources(subscription_id);
