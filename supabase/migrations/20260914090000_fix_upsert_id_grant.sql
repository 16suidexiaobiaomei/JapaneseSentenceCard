-- Bug: the column-level UPDATE grants added for cards and profiles in
-- the community-sharing migration left out `id` (the primary key each
-- table's client-side sync upserts on). Postgres checks UPDATE
-- privilege on every column named in an ON CONFLICT ... DO UPDATE SET
-- clause at query-parse time — including the conflict-key column
-- itself, even though setting id = excluded.id is a no-op — regardless
-- of whether a row actually conflicts at runtime. Since app.js's
-- pushCard()/pushCardsBulk()/pushProfile() all use
-- .upsert({id, ...}), every one of those calls has been failing with
-- "permission denied for table cards/profiles" (silently swallowed by
-- their try/catch) since that migration went live — not just the
-- share flow, ALL card/profile syncing back to any existing row.
grant update (id) on public.cards to authenticated;
grant update (id) on public.profiles to authenticated;
