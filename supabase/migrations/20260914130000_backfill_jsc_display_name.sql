-- The "Greetings" and "Cafe & Restaurant" official decks were shared
-- before the test account's username was set to "JSC", so they
-- snapshotted the "A learner" fallback. One-off backfill so they show
-- "by JSC" like everything shared since — owner_display_name isn't
-- client-writable (see the community-sharing migration), so this
-- can't be fixed from the app itself.
update public.shared_tags
set owner_display_name = 'JSC'
where owner_id = (select id from auth.users where email = 'test@test.com')
  and owner_display_name = 'A learner';
