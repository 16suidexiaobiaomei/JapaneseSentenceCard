-- Resuming a paused (unpublished) shared tag used to just flip its
-- status back to "active" with a confirm() dialog, keeping whatever
-- card snapshot / description / language it was first shared with —
-- even though the owner's local cards under that tag name may have
-- changed a lot since then. This lets them redo the whole selection,
-- description and back-language, same as a first share, but updating
-- the existing row in place (same id, same download_count/history)
-- instead of creating a duplicate.
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
  v_frozen boolean;
  v_owner uuid;
  v_status text;
  v_selected_count integer;
  v_eligible_count integer;
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

  select sharing_frozen into v_frozen from public.profiles where id = v_uid;
  if coalesce(v_frozen, false) then
    raise exception 'Sharing is paused on this account after multiple shared tags were removed for violating community guidelines. Contact support@japanesesentencecards.com if you believe this is a mistake.';
  end if;

  v_selected_count := coalesce(array_length(p_card_ids, 1), 0);
  if v_selected_count < 50 then
    raise exception 'At least 50 cards are needed to share a tag.';
  end if;

  select count(*) into v_eligible_count
  from public.cards
  where id = any(p_card_ids) and user_id = v_uid and source_shared_tag_id is null and deleted_at is null;

  if v_eligible_count <> v_selected_count then
    raise exception 'Some selected cards can''t be shared — they''re either not yours or were downloaded from the community.';
  end if;

  delete from public.shared_tag_cards where shared_tag_id = p_shared_tag_id;

  insert into public.shared_tag_cards (shared_tag_id, front, romaji, back, sort_order)
  select p_shared_tag_id, c.front, c.romaji, c.back, row_number() over (order by c.created_at)
  from public.cards c
  where c.id = any(p_card_ids) and c.user_id = v_uid;

  update public.shared_tags
  set name = p_name, description = coalesce(p_description, ''), back_language = coalesce(p_back_language, 'Any'),
      card_count = v_selected_count, status = 'active'
  where id = p_shared_tag_id;
end;
$$;

grant execute on function public.republish_shared_tag(uuid, text, text, text, text[]) to authenticated;
