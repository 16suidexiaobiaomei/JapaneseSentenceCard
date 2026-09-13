-- Temporary: manually freeze the test account to verify the new
-- time-limited freeze end-to-end (share_tag/republish_shared_tag
-- rejection message, and the shared_tags RLS gate on reactivating a
-- paused tag). Reverted by the migration right after this one.
update public.profiles
set sharing_frozen_until = now() + interval '1 month'
where id = (select id from auth.users where email = 'test@test.com');
