-- Say "Contact us" instead of spelling out the support email in
-- user-facing messages — matches the Profile screen's own "Contact
-- us" row, which already copies the address on tap rather than
-- displaying it. Wording-only change, no logic change.
create or replace function public.protect_removed_shared_tag()
returns trigger as $$
begin
  if old.status = 'removed' and new.status <> 'removed' and auth.uid() is not null then
    raise exception 'This tag was removed after being reported. Contact us to appeal.';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

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
    raise exception 'Sharing is paused on this account until % after multiple shared tags were removed for violating community guidelines. Contact us if you believe this is a mistake.', to_char(v_frozen_until, 'FMMonth FMDD, YYYY');
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
    raise exception 'Sharing is paused on this account until % after multiple shared tags were removed for violating community guidelines. Contact us if you believe this is a mistake.', to_char(v_frozen_until, 'FMMonth FMDD, YYYY');
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
