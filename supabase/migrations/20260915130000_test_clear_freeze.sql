-- Cleanup: clear the test account's freeze back to its normal
-- (never-frozen) state after verifying the time-limited freeze above.
update public.profiles
set sharing_frozen_until = null
where id = (select id from auth.users where email = 'test@test.com');
