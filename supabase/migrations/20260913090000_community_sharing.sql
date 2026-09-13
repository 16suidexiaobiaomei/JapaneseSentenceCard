-- Community: sharing/downloading tag decks between users.
--
-- Unlike everything else in this schema, shared content is meant to be
-- PUBLIC (readable by any logged-in user, not just its owner) — a real
-- shift in trust model, so the share/download/report operations below
-- are Postgres functions (not plain client inserts), each re-checking
-- authorization itself, rather than relying on RLS policies alone to
-- get every edge case right for multi-row, multi-table writes.

-- ---------------------------------------------------------------------
-- shared_tags: one row per publicly shared tag "board".
-- ---------------------------------------------------------------------
create table public.shared_tags (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text not null default '',
  back_language text not null default 'Any',
  card_count integer not null default 0,
  download_count integer not null default 0,
  status text not null default 'active' check (status in ('active', 'unpublished', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index shared_tags_status_idx on public.shared_tags (status);
create index shared_tags_owner_idx on public.shared_tags (owner_id);

create trigger shared_tags_set_updated_at
before update on public.shared_tags
for each row execute function public.set_updated_at();

-- A tag removed after being reported stays removed — the only way back
-- is a manual fix by us (direct SQL, not through the app) after someone
-- emails support to appeal. auth.uid() is null for that direct-SQL path
-- (no PostgREST/user JWT involved) and non-null for anything going
-- through the app, which is what this actually keys off.
create or replace function public.protect_removed_shared_tag()
returns trigger as $$
begin
  if old.status = 'removed' and new.status <> 'removed' and auth.uid() is not null then
    raise exception 'This tag was removed after being reported. Contact support@japanesesentencecards.com to appeal.';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger shared_tags_protect_removed
before update on public.shared_tags
for each row execute function public.protect_removed_shared_tag();

-- ---------------------------------------------------------------------
-- shared_tag_cards: a snapshot of the shared sentences — never the
-- audio, since that could be the owner's own voice recording and
-- publishing that without very explicit separate consent isn't
-- something to do lightly. Not linked back to the source cards either:
-- this is a one-time copy, not a live sync.
-- ---------------------------------------------------------------------
create table public.shared_tag_cards (
  id uuid primary key default gen_random_uuid(),
  shared_tag_id uuid not null references public.shared_tags (id) on delete cascade,
  front text not null,
  romaji text not null default '',
  back text not null,
  sort_order integer not null default 0
);

create index shared_tag_cards_tag_idx on public.shared_tag_cards (shared_tag_id);

-- ---------------------------------------------------------------------
-- shared_tag_downloads: who has added which shared tag — drives the
-- "Added" state and lets download_count be exact rather than a
-- client-incremented guess.
-- ---------------------------------------------------------------------
create table public.shared_tag_downloads (
  shared_tag_id uuid not null references public.shared_tags (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  downloaded_at timestamptz not null default now(),
  primary key (shared_tag_id, user_id)
);

-- ---------------------------------------------------------------------
-- shared_tag_reports: one per (tag, reporter) — a single person
-- reporting the same tag five times shouldn't count as five reports.
-- ---------------------------------------------------------------------
create table public.shared_tag_reports (
  shared_tag_id uuid not null references public.shared_tags (id) on delete cascade,
  reporter_id uuid not null references auth.users (id) on delete cascade,
  reason text not null,
  detail text not null default '',
  created_at timestamptz not null default now(),
  primary key (shared_tag_id, reporter_id)
);

-- ---------------------------------------------------------------------
-- Provenance marker: once a card is downloaded from the community, it
-- can never be shared again — even edited, even from a different tag.
-- Only download_shared_tag() (below) ever sets this; see the column
-- grant revocation further down for why a plain update can't touch it.
-- ---------------------------------------------------------------------
alter table public.cards add column if not exists source_shared_tag_id uuid references public.shared_tags (id) on delete set null;

-- Sharing can be paused account-wide after repeat violations (see
-- report_shared_tag() below) — same reasoning as source_shared_tag_id,
-- this must not be settable by the user themselves.
alter table public.profiles add column if not exists sharing_frozen boolean not null default false;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.shared_tags enable row level security;
alter table public.shared_tag_cards enable row level security;
alter table public.shared_tag_downloads enable row level security;
alter table public.shared_tag_reports enable row level security;

create policy "shared_tags: select active or own" on public.shared_tags
  for select using (status = 'active' or owner_id = auth.uid());

-- Owners may only flip status (share_tag() and download_shared_tag()
-- below own everything else — name, counts, etc. — via security
-- definer, bypassing this grant restriction entirely).
create policy "shared_tags: owner updates own" on public.shared_tags
  for update using (owner_id = auth.uid());
revoke update on public.shared_tags from authenticated;
grant update (status) on public.shared_tags to authenticated;

create policy "shared_tag_cards: select via readable tag" on public.shared_tag_cards
  for select using (exists (
    select 1 from public.shared_tags st
    where st.id = shared_tag_id and (st.status = 'active' or st.owner_id = auth.uid())
  ));

create policy "shared_tag_downloads: select own" on public.shared_tag_downloads
  for select using (user_id = auth.uid());

-- profiles.sharing_frozen: only report_shared_tag()'s security definer
-- path may ever set this — a plain client update must not be able to
-- self-unfreeze. pushProfile() in app.js only ever upserts
-- {username, photo, total_active_ms}, so that's the full safe list.
revoke update on public.profiles from authenticated;
grant update (username, photo, total_active_ms) on public.profiles to authenticated;

-- No insert policies on shared_tags / shared_tag_cards / shared_tag_downloads
-- / shared_tag_reports for regular users — RLS denies by default with no
-- matching policy, so all four are only ever written through the
-- security definer functions below (which run as their owner, not
-- subject to the caller's row/column grants).

-- Same reasoning as shared_tags.status above: only download_shared_tag()
-- may set source_shared_tag_id, so a user can't launder downloaded
-- content by clearing the marker via a raw update.
-- Full column list except source_shared_tag_id — must match what the
-- app's upsert-based sync actually writes (cardToRow() in app.js
-- includes user_id and created_at in its payload, which a
-- merge-duplicates upsert re-sets on every conflict, even though their
-- value never actually changes — omitting them here would silently
-- break normal card syncing, not just the abuse case this is guarding
-- against).
revoke update on public.cards from authenticated;
grant update (user_id, front, romaji, back, tags, stability, difficulty, reps, lapses, last_review_at, due_at, audio, created_at, updated_at, deleted_at) on public.cards to authenticated;

-- ---------------------------------------------------------------------
-- share_tag(): validates and atomically creates a shared tag + its
-- card snapshot. Re-validates everything server-side rather than
-- trusting the client's own card selection, since the anti-re-upload
-- and minimum-card-count rules only mean something if they can't be
-- bypassed by calling the API directly.
-- ---------------------------------------------------------------------
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
  v_frozen boolean;
  v_recent_count integer;
  v_selected_count integer;
  v_eligible_count integer;
  v_shared_tag_id uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select sharing_frozen into v_frozen from public.profiles where id = v_uid;
  if coalesce(v_frozen, false) then
    raise exception 'Sharing is paused on this account after multiple shared tags were removed for violating community guidelines. Contact support@japanesesentencecards.com if you believe this is a mistake.';
  end if;

  select count(*) into v_recent_count
  from public.shared_tags
  where owner_id = v_uid and created_at > now() - interval '30 days';
  if v_recent_count >= 10 then
    raise exception 'You''ve reached the limit of 10 shared tags per month. Try again later.';
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

  insert into public.shared_tags (owner_id, name, description, back_language, card_count, status)
  values (v_uid, p_name, coalesce(p_description, ''), coalesce(p_back_language, 'Any'), v_selected_count, 'active')
  returning id into v_shared_tag_id;

  insert into public.shared_tag_cards (shared_tag_id, front, romaji, back, sort_order)
  select v_shared_tag_id, c.front, c.romaji, c.back, row_number() over (order by c.created_at)
  from public.cards c
  where c.id = any(p_card_ids) and c.user_id = v_uid;

  return v_shared_tag_id;
end;
$$;

grant execute on function public.share_tag(text, text, text, text[]) to authenticated;

-- ---------------------------------------------------------------------
-- download_shared_tag(): copies the snapshot into the caller's own
-- cards (marked with source_shared_tag_id so it can never be
-- re-shared), records the download, and bumps the counter. A repeat
-- call for the same tag is a harmless no-op — the primary key on
-- shared_tag_downloads makes "already downloaded" easy to detect.
-- ---------------------------------------------------------------------
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

  insert into public.shared_tag_downloads (shared_tag_id, user_id)
  values (p_shared_tag_id, v_uid)
  on conflict (shared_tag_id, user_id) do nothing;
  get diagnostics v_inserted_count = row_count;

  if v_inserted_count = 0 then
    return 0;
  end if;

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

  update public.shared_tags set download_count = download_count + 1 where id = p_shared_tag_id;

  return v_card_count;
end;
$$;

grant execute on function public.download_shared_tag(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- report_shared_tag(): records the report; at 3 unique reporters the
-- tag auto-hides (status -> removed), and if that's the reporter's
-- *owner*'s 2nd removed tag, sharing is paused on their account.
-- ---------------------------------------------------------------------
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

  if v_report_count >= 3 then
    select owner_id into v_owner from public.shared_tags where id = p_shared_tag_id;

    update public.shared_tags set status = 'removed' where id = p_shared_tag_id and status = 'active';

    select count(*) into v_removed_count
    from public.shared_tags
    where owner_id = v_owner and status = 'removed';

    if v_removed_count >= 2 then
      update public.profiles set sharing_frozen = true where id = v_owner;
    end if;
  end if;
end;
$$;

grant execute on function public.report_shared_tag(uuid, text, text) to authenticated;
