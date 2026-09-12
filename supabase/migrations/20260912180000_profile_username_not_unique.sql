-- username is a private display label shown only to its own owner (the
-- "Ready for today, X" greeting) — nothing looks profiles up by it, so
-- there was never a real reason for it to be globally unique. In
-- practice this constraint silently broke saving a profile (both name
-- AND photo, since they're upserted together in one row) any time two
-- different accounts happened to pick the same name.
alter table public.profiles drop constraint if exists profiles_username_key;
