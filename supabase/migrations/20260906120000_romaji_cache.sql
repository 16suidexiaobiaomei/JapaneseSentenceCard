-- Shared cache for auto-generated romaji, keyed by a hash of the source
-- sentence. Not user-specific (no user_id) — the same Japanese sentence
-- always converts to the same romaji, so every user benefits from a
-- conversion any user has already triggered. Non-sensitive, so it's open
-- to read/insert via the publishable key, protected only from update/delete.
create table public.romaji_cache (
  id text primary key, -- sha256 hex of the trimmed source sentence
  romaji text not null,
  created_at timestamptz not null default now()
);

alter table public.romaji_cache enable row level security;

create policy "romaji_cache: select all" on public.romaji_cache
  for select using (true);
create policy "romaji_cache: insert all" on public.romaji_cache
  for insert with check (true);
