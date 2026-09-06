-- "Time in app" was tracked purely per-device (localStorage only) and
-- never synced, so two devices for the same account would show different
-- numbers. Storing it on the profile row lets every device converge to
-- whichever is highest (see syncNow() in app.js).
alter table public.profiles add column if not exists total_active_ms bigint not null default 0;
