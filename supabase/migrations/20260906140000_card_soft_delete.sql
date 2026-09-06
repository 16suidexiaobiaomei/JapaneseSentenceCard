-- Deletes were hard DELETEs, so a device that hadn't yet heard about a
-- deletion elsewhere would treat its stale local copy as "new" and push
-- it right back up on its next sync, resurrecting it — and then the
-- device that actually deleted it would just pull that copy back down.
-- Soft-deleting instead means every device can see a card was
-- deliberately removed (not just "not created here yet") and keep it
-- gone, no matter which device syncs first.
alter table public.cards add column if not exists deleted_at timestamptz;
