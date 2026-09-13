-- Temporary: move the test account's freeze into the past to verify
-- it actually lifts automatically once the date passes.
update public.profiles
set sharing_frozen_until = now() - interval '1 day'
where id = (select id from auth.users where email = 'test@test.com');
