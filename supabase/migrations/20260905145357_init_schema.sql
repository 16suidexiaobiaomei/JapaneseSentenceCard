-- Sentence Cards: initial multi-user schema.
-- One row per user in profiles/cards/review_log, all protected by
-- Row Level Security so a user can only ever see/change their own rows.

-- ---------------------------------------------------------------------
-- profiles: username (public handle, also used for the "Ready for
-- today, X" greeting) + avatar photo. One row per auth.users row.
-- ---------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text unique,
  photo text, -- base64 data URL, same downscaled format the app already produces
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- cards: one row per flashcard.
-- ---------------------------------------------------------------------
create table public.cards (
  id text primary key, -- client-generated ids (e.g. "seed-0", "c-<timestamp>")
  user_id uuid not null references auth.users (id) on delete cascade,
  front text not null,
  romaji text not null default '',
  back text not null,
  tags text[] not null default '{}',
  stability double precision,
  difficulty double precision,
  reps integer not null default 0,
  lapses integer not null default 0,
  last_review_at timestamptz,
  due_at timestamptz not null,
  audio jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index cards_user_id_idx on public.cards (user_id);
create index cards_user_due_idx on public.cards (user_id, due_at);

-- ---------------------------------------------------------------------
-- review_log: one row per user per calendar day, for the activity
-- heatmap / streak stats.
-- ---------------------------------------------------------------------
create table public.review_log (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  count integer not null default 0,
  primary key (user_id, day)
);

-- ---------------------------------------------------------------------
-- updated_at is maintained by the database, not trusted from the client.
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger cards_set_updated_at
before update on public.cards
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- A profiles row is created automatically the moment someone signs up.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Row Level Security: every table, every user only touches their own rows.
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.cards enable row level security;
alter table public.review_log enable row level security;

create policy "profiles: select own" on public.profiles
  for select using (id = auth.uid());
create policy "profiles: update own" on public.profiles
  for update using (id = auth.uid());
create policy "profiles: insert own" on public.profiles
  for insert with check (id = auth.uid());

create policy "cards: select own" on public.cards
  for select using (user_id = auth.uid());
create policy "cards: insert own" on public.cards
  for insert with check (user_id = auth.uid());
create policy "cards: update own" on public.cards
  for update using (user_id = auth.uid());
create policy "cards: delete own" on public.cards
  for delete using (user_id = auth.uid());

create policy "review_log: select own" on public.review_log
  for select using (user_id = auth.uid());
create policy "review_log: insert own" on public.review_log
  for insert with check (user_id = auth.uid());
create policy "review_log: update own" on public.review_log
  for update using (user_id = auth.uid());
