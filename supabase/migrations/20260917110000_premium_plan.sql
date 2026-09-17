-- Free/Premium entitlement. plan is set exclusively by the RevenueCat
-- webhook (via service_role, bypassing RLS/grants) once that's wired
-- up — unlike username/photo, this must never be client-writable, so
-- deliberately no grant is added for it (the blanket revoke from
-- community_sharing.sql already denies it by default).
alter table public.profiles add column if not exists plan text not null default 'free' check (plan in ('free', 'premium'));

-- Advanced display settings (Premium-only, enforced client-side —
-- these are just preferences, not something worth gating server-side).
alter table public.profiles add column if not exists show_romaji_on_front boolean not null default false;
alter table public.profiles add column if not exists show_furigana_on_front boolean not null default false;
grant update (show_romaji_on_front, show_furigana_on_front) on public.profiles to authenticated;

-- Free accounts are capped at 5 tags; Premium is unlimited. Enforced
-- here (not just client-side) since cards sync via a plain upsert with
-- no dedicated "create tag" RPC to gate instead.
--
-- Compares against the *current* state of every one of the user's
-- cards, including this row's own pre-write tags (a BEFORE trigger
-- sees the old row, since the update hasn't landed yet) — not just
-- "every other card" — so re-saving a card without touching its tags
-- never counts as "introducing" anything, even if the account already
-- has more than 5 tags from before the limit existed or from a
-- Premium downgrade. Only a genuinely new tag name (not already used
-- anywhere on the account) that would push the total past 5 is
-- blocked; existing tags stay fully usable no matter how many there are.
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
    return new; -- nothing new being introduced — always allowed
  end if;

  select count(distinct t) into v_total from unnest(v_existing_tags || v_new_tags) as t;

  if v_total > 5 then
    raise exception 'Free accounts can use up to 5 tags. Upgrade to Premium for unlimited tags, downloading from Community, and advanced settings.';
  end if;

  return new;
end;
$$;

drop trigger if exists cards_enforce_free_tag_limit on public.cards;
create trigger cards_enforce_free_tag_limit
before insert or update on public.cards
for each row execute function public.enforce_free_tag_limit();

-- Downloading from the Community is Premium-only; sharing your own
-- tags stays open to everyone (unchanged from share_tag()).
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
    raise exception 'Downloading shared tags is a Premium feature. Upgrade to Premium to add tags from the community.';
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
