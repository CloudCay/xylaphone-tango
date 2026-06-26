-- Device-scoped topic cache: dates + topics (+ optional short gist), not full transcripts
CREATE TABLE IF NOT EXISTS topic_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  gist TEXT,
  occurred_on TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  hit_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE(user_id, device_id, topic, occurred_on),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_topic_cache_device_seen ON topic_cache(user_id, device_id, last_seen_at DESC);

-- One-time: fold old verbatim memories into topic rows (legacy device bucket)
INSERT OR IGNORE INTO topic_cache (user_id, device_id, topic, gist, occurred_on, last_seen_at)
SELECT user_id, 'legacy', substr(content, 1, 48), substr(content, 1, 96), date(created_at), created_at
FROM memories
WHERE NOT EXISTS (SELECT 1 FROM topic_cache LIMIT 1);