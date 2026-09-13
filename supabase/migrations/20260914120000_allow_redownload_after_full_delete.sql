-- download_shared_tag() used to gate purely on "has this user EVER
-- downloaded this tag" (a row in shared_tag_downloads) — so once that
-- row existed, downloading again was a silent permanent no-op, even
-- after the user deleted every card that came from it. Gate on "does
-- the user currently still have any live card from this source"
-- instead: blocks a second add while any such card still exists (no
-- duplicates), but allows a fresh add again once they're all gone.
-- download_count still only counts genuinely first-time downloads
-- (shared_tag_downloads row newly inserted) — a re-add isn't a new
-- unique download, so it shouldn't inflate that public counter.
create or replace function public.download_shared_tag(
  p_shared_tag_id uuid,
  p_local_tag_name text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_still_has boolean;
  v_inserted_count integer;
  v_card_count integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select status into v_status from public.shared_tags where id = p_shared_tag_id;
  if v_status is null then
    raise exception 'Tag not found';
  end if;
  if v_status <> 'active' then
    raise exception 'This tag is no longer available';
  end if;

  select exists(
    select 1 from public.cards
    where user_id = v_uid and source_shared_tag_id = p_shared_tag_id and deleted_at is null
  ) into v_still_has;

  if v_still_has then
    return 0;
  end if;

  insert into public.shared_tag_downloads (shared_tag_id, user_id)
  values (p_shared_tag_id, v_uid)
  on conflict (shared_tag_id, user_id) do nothing;
  get diagnostics v_inserted_count = row_count;

  insert into public.cards (
    id, user_id, front, romaji, back, tags, stability, difficulty, reps, lapses,
    last_review_at, due_at, audio, source_shared_tag_id, created_at, updated_at
  )
  select
    'c-' || replace(gen_random_uuid()::text, '-', ''),
    v_uid, stc.front, stc.romaji, stc.back, array[p_local_tag_name],
    null, null, 0, 0, null, now(), null, p_shared_tag_id, now(), now()
  from public.shared_tag_cards stc
  where stc.shared_tag_id = p_shared_tag_id
  order by stc.sort_order;

  get diagnostics v_card_count = row_count;

  if v_inserted_count > 0 then
    update public.shared_tags set download_count = download_count + 1 where id = p_shared_tag_id;
  end if;

  return v_card_count;
end;
$$;
