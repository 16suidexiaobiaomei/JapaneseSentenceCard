-- test@test.com hit its 10-shared-tags-per-30-days cap before it could
-- actually share "Basic Hiragana" (the tag itself was never published to
-- Community). Reassigning ownership of those 71 cards to a different
-- account that hasn't hit that cap, so it can be shared from there
-- instead of waiting out the rolling window.
--
-- Note: NOT setting this account's username to "JSC" here -- profiles.
-- username is unique, and test@test.com already holds that value. If
-- "by JSC" branding is wanted on this tag, override shared_tags.
-- owner_display_name directly after sharing (same one-off approach as
-- backfill_jsc_display_name.sql), rather than touching either account's
-- actual username.
do $$
declare
  v_from_uid uuid;
  v_to_uid uuid;
begin
  select id into v_from_uid from auth.users where email = 'test@test.com';
  select id into v_to_uid from auth.users where email = 'test_premium@test.com';

  if v_from_uid is null then
    raise exception 'test@test.com not found';
  end if;
  if v_to_uid is null then
    raise exception 'test_premium@test.com not found -- register this account in the app first';
  end if;

  update public.cards
  set user_id = v_to_uid
  where user_id = v_from_uid
    and id like 'hiragana-%';
end $$;
