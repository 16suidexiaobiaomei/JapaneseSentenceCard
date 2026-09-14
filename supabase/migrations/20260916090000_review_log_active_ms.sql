-- The Home screen's "Time in app" (and "Cards") stat tiles ignored the
-- 7d/30d/All toggle entirely — "Cards" always showed the lifetime
-- collection size, and "Time in app" always showed the single
-- lifetime totalActiveMs counter, since no per-day breakdown of
-- active time existed anywhere. review_log already tracks one row per
-- user per day for the review count/streak stats — active_ms rides
-- along on the same row rather than needing a whole new table.
alter table public.review_log add column if not exists active_ms integer not null default 0;
