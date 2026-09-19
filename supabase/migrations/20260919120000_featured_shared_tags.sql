-- Lets a tag be pinned to the top of the Community feed for events (e.g.
-- a festival-themed tag) by setting this directly via the SQL editor —
-- deliberately no client grant, same pattern as plan: this is an admin
-- lever, not something any user should be able to set on their own
-- shared tag. NULL (the default) means "not featured, sort normally".
-- Lower numbers show first; if several tags are featured at once, this
-- also controls their order relative to each other.
alter table public.shared_tags add column if not exists featured_rank integer;
