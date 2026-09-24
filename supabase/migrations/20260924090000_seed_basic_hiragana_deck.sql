-- One-off seed: the official "Basic Hiragana" JSC deck (71 cards: full
-- gojuon + dakuten/handakuten), for the in-app-event Community test.
-- Inserted under the existing official-content account (test@test.com,
-- display name "JSC" -- see backfill_jsc_display_name.sql), matching
-- the "Greetings"/"Cafe & Restaurant" decks already shared from it.
--
-- front = the hiragana character itself; back = its romaji reading
-- (there is no separate "translation" for a single kana, so this
-- deck deliberately uses back for the reading instead). romaji/kana
-- are set directly from the same source data, skipping the usual
-- auto-generation backfill entirely since we already have the exact
-- correct values. furigana is left NULL -- there is no kanji to
-- annotate, so the app correctly falls back to plain text for it.
--
-- After running this, log in as test@test.com in the app and use
-- the real Share Tag flow on "Basic Hiragana" (My tags) -- do NOT
-- insert into shared_tags directly, since that bypasses the real
-- validation share_tag() performs.
do $$
declare
  v_uid uuid;
begin
  select id into v_uid from auth.users where email = 'test@test.com';
  if v_uid is null then
    raise exception 'test@test.com not found -- update the email above to your official-content account';
  end if;

  insert into public.cards (id, user_id, front, romaji, kana, back, tags, reps, lapses, due_at, created_at, updated_at)
  values
    ('hiragana-01', v_uid, 'あ', 'a', 'あ', 'a', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-02', v_uid, 'い', 'i', 'い', 'i', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-03', v_uid, 'う', 'u', 'う', 'u', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-04', v_uid, 'え', 'e', 'え', 'e', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-05', v_uid, 'お', 'o', 'お', 'o', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-06', v_uid, 'か', 'ka', 'か', 'ka', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-07', v_uid, 'き', 'ki', 'き', 'ki', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-08', v_uid, 'く', 'ku', 'く', 'ku', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-09', v_uid, 'け', 'ke', 'け', 'ke', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-10', v_uid, 'こ', 'ko', 'こ', 'ko', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-11', v_uid, 'さ', 'sa', 'さ', 'sa', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-12', v_uid, 'し', 'shi', 'し', 'shi', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-13', v_uid, 'す', 'su', 'す', 'su', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-14', v_uid, 'せ', 'se', 'せ', 'se', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-15', v_uid, 'そ', 'so', 'そ', 'so', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-16', v_uid, 'た', 'ta', 'た', 'ta', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-17', v_uid, 'ち', 'chi', 'ち', 'chi', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-18', v_uid, 'つ', 'tsu', 'つ', 'tsu', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-19', v_uid, 'て', 'te', 'て', 'te', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-20', v_uid, 'と', 'to', 'と', 'to', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-21', v_uid, 'な', 'na', 'な', 'na', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-22', v_uid, 'に', 'ni', 'に', 'ni', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-23', v_uid, 'ぬ', 'nu', 'ぬ', 'nu', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-24', v_uid, 'ね', 'ne', 'ね', 'ne', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-25', v_uid, 'の', 'no', 'の', 'no', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-26', v_uid, 'は', 'ha', 'は', 'ha', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-27', v_uid, 'ひ', 'hi', 'ひ', 'hi', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-28', v_uid, 'ふ', 'fu', 'ふ', 'fu', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-29', v_uid, 'へ', 'he', 'へ', 'he', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-30', v_uid, 'ほ', 'ho', 'ほ', 'ho', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-31', v_uid, 'ま', 'ma', 'ま', 'ma', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-32', v_uid, 'み', 'mi', 'み', 'mi', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-33', v_uid, 'む', 'mu', 'む', 'mu', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-34', v_uid, 'め', 'me', 'め', 'me', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-35', v_uid, 'も', 'mo', 'も', 'mo', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-36', v_uid, 'や', 'ya', 'や', 'ya', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-37', v_uid, 'ゆ', 'yu', 'ゆ', 'yu', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-38', v_uid, 'よ', 'yo', 'よ', 'yo', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-39', v_uid, 'ら', 'ra', 'ら', 'ra', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-40', v_uid, 'り', 'ri', 'り', 'ri', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-41', v_uid, 'る', 'ru', 'る', 'ru', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-42', v_uid, 'れ', 're', 'れ', 're', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-43', v_uid, 'ろ', 'ro', 'ろ', 'ro', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-44', v_uid, 'わ', 'wa', 'わ', 'wa', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-45', v_uid, 'を', 'wo', 'を', 'wo', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-46', v_uid, 'ん', 'n', 'ん', 'n', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-47', v_uid, 'が', 'ga', 'が', 'ga', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-48', v_uid, 'ぎ', 'gi', 'ぎ', 'gi', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-49', v_uid, 'ぐ', 'gu', 'ぐ', 'gu', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-50', v_uid, 'げ', 'ge', 'げ', 'ge', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-51', v_uid, 'ご', 'go', 'ご', 'go', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-52', v_uid, 'ざ', 'za', 'ざ', 'za', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-53', v_uid, 'じ', 'ji', 'じ', 'ji', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-54', v_uid, 'ず', 'zu', 'ず', 'zu', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-55', v_uid, 'ぜ', 'ze', 'ぜ', 'ze', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-56', v_uid, 'ぞ', 'zo', 'ぞ', 'zo', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-57', v_uid, 'だ', 'da', 'だ', 'da', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-58', v_uid, 'ぢ', 'ji', 'ぢ', 'ji', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-59', v_uid, 'づ', 'zu', 'づ', 'zu', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-60', v_uid, 'で', 'de', 'で', 'de', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-61', v_uid, 'ど', 'do', 'ど', 'do', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-62', v_uid, 'ば', 'ba', 'ば', 'ba', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-63', v_uid, 'び', 'bi', 'び', 'bi', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-64', v_uid, 'ぶ', 'bu', 'ぶ', 'bu', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-65', v_uid, 'べ', 'be', 'べ', 'be', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-66', v_uid, 'ぼ', 'bo', 'ぼ', 'bo', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-67', v_uid, 'ぱ', 'pa', 'ぱ', 'pa', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-68', v_uid, 'ぴ', 'pi', 'ぴ', 'pi', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-69', v_uid, 'ぷ', 'pu', 'ぷ', 'pu', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-70', v_uid, 'ぺ', 'pe', 'ぺ', 'pe', array['Basic Hiragana'], 0, 0, now(), now(), now()),
    ('hiragana-71', v_uid, 'ぽ', 'po', 'ぽ', 'po', array['Basic Hiragana'], 0, 0, now(), now(), now())
  on conflict (id) do nothing;
end $$;
