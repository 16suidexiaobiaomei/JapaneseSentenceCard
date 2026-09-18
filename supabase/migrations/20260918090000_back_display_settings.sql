-- Premium users can now also turn romaji/furigana off on the BACK of a
-- review card (previously always shown there for everyone) — default
-- true so free accounts, and premium accounts that never touch this,
-- keep today's "always shown on back" behavior unchanged.
alter table public.profiles add column if not exists show_romaji_on_back boolean not null default true;
alter table public.profiles add column if not exists show_furigana_on_back boolean not null default true;
grant update (show_romaji_on_back, show_furigana_on_back) on public.profiles to authenticated;
