-- Match the client's shorter upsell wording — this message is only
-- ever seen if a request somehow bypasses the client-side check
-- (stale app version, plan changing mid-flow), but should still read
-- consistently with what the app itself says.
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
  v_plan text;
  v_status text;
  v_still_has boolean;
  v_inserted_count integer;
  v_card_count integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select plan into v_plan from public.profiles where id = v_uid;
  if v_plan is distinct from 'premium' then
    raise exception 'Upgrade to Premium to download tags from the community.';
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
    id, user_id, front, romaji, back, kana, furigana, tags, stability, difficulty, reps, lapses,
    last_review_at, due_at, audio, source_shared_tag_id, created_at, updated_at
  )
  select
    'c-' || replace(gen_random_uuid()::text, '-', ''),
    v_uid, stc.front, stc.romaji, stc.back, stc.kana, stc.furigana, array[p_local_tag_name],
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

-- Same idea for the free tag limit — used to mention every premium
-- benefit; now just states the limit and points to Premium, matching
-- the client's alert() wording.
create or replace function public.enforce_free_tag_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan text;
  v_existing_tags text[];
  v_new_tags text[];
  v_introduced text[];
  v_total integer;
begin
  select plan into v_plan from public.profiles where id = new.user_id;
  if v_plan = 'premium' then
    return new;
  end if;

  select array_agg(distinct t) into v_existing_tags
  from public.cards, unnest(tags) as t
  where user_id = new.user_id and deleted_at is null and t <> 'Untagged';
  v_existing_tags := coalesce(v_existing_tags, '{}');

  select array_agg(distinct t) into v_new_tags
  from unnest(new.tags) as t
  where t <> 'Untagged';
  v_new_tags := coalesce(v_new_tags, '{}');

  select array_agg(distinct t) into v_introduced
  from unnest(v_new_tags) as t
  where t <> all(v_existing_tags);

  if v_introduced is null or array_length(v_introduced, 1) is null then
    return new;
  end if;

  select count(distinct t) into v_total from unnest(v_existing_tags || v_new_tags) as t;

  if v_total > 5 then
    raise exception 'You''ve reached the 5-tag limit for free accounts. Upgrade to Premium for unlimited tags.';
  end if;

  return new;
end;
$$;
