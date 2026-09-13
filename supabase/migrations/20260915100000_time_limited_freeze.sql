-- Sharing being paused after a 2nd removed tag used to be permanent —
-- the only way back was emailing support. Replaced with a 1-month
-- timed freeze instead: sharing_frozen_until replaces the boolean
-- sharing_frozen, and every "is this account frozen" check becomes
-- "is sharing_frozen_until still in the future" rather than a flag
-- that never clears itself. A further violation while already frozen
-- resets the clock to another month out from now, rather than
-- stacking or being ignored.
alter table public.profiles add column if not exists sharing_frozen_until timestamptz;

-- Must drop this policy before the column beneath it, since its old
-- WITH CHECK still references sharing_frozen directly.
drop policy if exists "shared_tags: owner updates own" on public.shared_tags;

alter table public.profiles drop column if exists sharing_frozen;

create or replace function public.share_tag(
  p_name text,
  p_description text,
  p_back_language text,
  p_card_ids text[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_frozen_until timestamptz;
  v_recent_count integer;
  v_selected_count integer;
  v_eligible_count integer;
  v_shared_tag_id uuid;
  v_display_name text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select sharing_frozen_until into v_frozen_until from public.profiles where id = v_uid;
  if v_frozen_until is not null and v_frozen_until > now() then
    raise exception 'Sharing is paused on this account until % after multiple shared tags were removed for violating community guidelines. Contact support@japanesesentencecards.com if you believe this is a mistake.', to_char(v_frozen_until, 'FMMonth FMDD, YYYY');
  end if;

  select count(*) into v_recent_count
  from public.shared_tags
  where owner_id = v_uid and created_at > now() - interval '30 days';
  if v_recent_count >= 10 then
    raise exception 'You''ve reached the limit of 10 shared tags per month. Try again later.';
  end if;

  v_selected_count := coalesce(array_length(p_card_ids, 1), 0);
  if v_selected_count < 50 then
    raise exception 'At least 50 original cards are needed to share a tag.';
  end if;

  select count(*) into v_eligible_count
  from public.cards
  where id = any(p_card_ids) and user_id = v_uid and source_shared_tag_id is null and deleted_at is null;

  if v_eligible_count <> v_selected_count then
    raise exception 'Some selected cards can''t be shared — they''re either not yours or were downloaded from the community.';
  end if;

  select coalesce(nullif(trim(username), ''), 'A learner') into v_display_name from public.profiles where id = v_uid;

  insert into public.shared_tags (owner_id, name, description, back_language, card_count, status, owner_display_name)
  values (v_uid, p_name, coalesce(p_description, ''), coalesce(p_back_language, 'Any'), v_selected_count, 'active', coalesce(v_display_name, 'A learner'))
  returning id into v_shared_tag_id;

  insert into public.shared_tag_cards (shared_tag_id, front, romaji, back, sort_order)
  select v_shared_tag_id, c.front, c.romaji, c.back, row_number() over (order by c.created_at)
  from public.cards c
  where c.id = any(p_card_ids) and c.user_id = v_uid;

  return v_shared_tag_id;
end;
$$;

create or replace function public.republish_shared_tag(
  p_shared_tag_id uuid,
  p_name text,
  p_description text,
  p_back_language text,
  p_card_ids text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_frozen_until timestamptz;
  v_owner uuid;
  v_status text;
  v_selected_count integer;
  v_eligible_count integer;
  v_display_name text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select owner_id, status into v_owner, v_status from public.shared_tags where id = p_shared_tag_id;
  if v_owner is null then
    raise exception 'Shared tag not found';
  end if;
  if v_owner <> v_uid then
    raise exception 'Not your shared tag';
  end if;
  if v_status <> 'unpublished' then
    raise exception 'Only a paused (unpublished) tag can be re-shared this way';
  end if;

  select sharing_frozen_until into v_frozen_until from public.profiles where id = v_uid;
  if v_frozen_until is not null and v_frozen_until > now() then
    raise exception 'Sharing is paused on this account until % after multiple shared tags were removed for violating community guidelines. Contact support@japanesesentencecards.com if you believe this is a mistake.', to_char(v_frozen_until, 'FMMonth FMDD, YYYY');
  end if;

  v_selected_count := coalesce(array_length(p_card_ids, 1), 0);
  if v_selected_count < 50 then
    raise exception 'At least 50 original cards are needed to share a tag.';
  end if;

  select count(*) into v_eligible_count
  from public.cards
  where id = any(p_card_ids) and user_id = v_uid and source_shared_tag_id is null and deleted_at is null;

  if v_eligible_count <> v_selected_count then
    raise exception 'Some selected cards can''t be shared — they''re either not yours or were downloaded from the community.';
  end if;

  select coalesce(nullif(trim(username), ''), 'A learner') into v_display_name from public.profiles where id = v_uid;

  delete from public.shared_tag_cards where shared_tag_id = p_shared_tag_id;

  insert into public.shared_tag_cards (shared_tag_id, front, romaji, back, sort_order)
  select p_shared_tag_id, c.front, c.romaji, c.back, row_number() over (order by c.created_at)
  from public.cards c
  where c.id = any(p_card_ids) and c.user_id = v_uid;

  update public.shared_tags
  set name = p_name, description = coalesce(p_description, ''), back_language = coalesce(p_back_language, 'Any'),
      card_count = v_selected_count, status = 'active', owner_display_name = coalesce(v_display_name, 'A learner')
  where id = p_shared_tag_id;
end;
$$;

create or replace function public.report_shared_tag(
  p_shared_tag_id uuid,
  p_reason text,
  p_detail text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_report_count integer;
  v_download_count integer;
  v_removed_count integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.shared_tag_reports (shared_tag_id, reporter_id, reason, detail)
  values (p_shared_tag_id, v_uid, p_reason, coalesce(p_detail, ''))
  on conflict (shared_tag_id, reporter_id) do nothing;

  select count(*) into v_report_count
  from public.shared_tag_reports
  where shared_tag_id = p_shared_tag_id;

  select download_count into v_download_count from public.shared_tags where id = p_shared_tag_id;

  if v_report_count >= 3 and v_report_count >= ceil(coalesce(v_download_count, 0) * 0.05) then
    select owner_id into v_owner from public.shared_tags where id = p_shared_tag_id;

    update public.shared_tags set status = 'removed' where id = p_shared_tag_id and status = 'active';

    select count(*) into v_removed_count
    from public.shared_tags
    where owner_id = v_owner and status = 'removed';

    if v_removed_count >= 2 then
      update public.profiles set sharing_frozen_until = now() + interval '1 month' where id = v_owner;
    end if;
  end if;
end;
$$;

-- Owner re-publish RLS gate needs the same "still in the future" check.
drop policy if exists "shared_tags: owner updates own" on public.shared_tags;

create policy "shared_tags: owner updates own" on public.shared_tags
  for update using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid()
    and (
      status <> 'active'
      or not exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.sharing_frozen_until is not null and p.sharing_frozen_until > now()
      )
    )
  );
