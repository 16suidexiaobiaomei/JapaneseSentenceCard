-- The owner's direct "update status" grant (from the previous
-- migration) lets them toggle active <-> unpublished themselves — but
-- that same toggle could revive a tag that share_tag() would refuse to
-- create fresh once sharing_frozen is set, defeating the whole point
-- of freezing. Re-publishing has to re-check the flag, same as
-- creating a new share does.
drop policy if exists "shared_tags: owner updates own" on public.shared_tags;

create policy "shared_tags: owner updates own" on public.shared_tags
  for update using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid()
    and (
      status <> 'active'
      or not coalesce((select sharing_frozen from public.profiles where id = auth.uid()), false)
    )
  );
