-- Changes the official "Basic Hiragana" deck's back-card content from a
-- romaji duplicate (e.g. front "あ" / back "a") to the matching katakana
-- character (front "あ" / back "ア") -- romaji stays as-is in the romaji
-- column, still shown as the small reading hint above the answer; only
-- what counts as the "answer" changes. Also renames the local tag to
-- "Basic Hiragana & Katakana" to match the renamed Community tag.
--
-- This only updates the OWNER's (test@test.com) source cards -- the
-- live Community listing is a separate snapshot in shared_tag_cards
-- (see shared_tags/shared_tag_cards and republish_shared_tag() in
-- 20260914100000_republish_shared_tag.sql), populated only through the
-- app's own pause -> edit -> republish flow, same as the original
-- seed_basic_hiragana_deck.sql's own instructions. After this runs, log
-- in as test@test.com, pause "Basic Hiragana" under My tags, then
-- republish it as:
--   name: Basic Hiragana & Katakana
--   description: All 71 hiragana -- including dakuten and handakuten --
--     with the matching katakana on the back instead of romaji, so you
--     learn both scripts from the same card.
--   back language: Katakana
do $$
declare
  v_uid uuid;
begin
  select id into v_uid from auth.users where email = 'test@test.com';
  if v_uid is null then
    raise exception 'test@test.com not found -- update the email above to your official-content account';
  end if;

  update public.cards set back = v.katakana
  from (values
    ('hiragana-01', 'ア'),
    ('hiragana-02', 'イ'),
    ('hiragana-03', 'ウ'),
    ('hiragana-04', 'エ'),
    ('hiragana-05', 'オ'),
    ('hiragana-06', 'カ'),
    ('hiragana-07', 'キ'),
    ('hiragana-08', 'ク'),
    ('hiragana-09', 'ケ'),
    ('hiragana-10', 'コ'),
    ('hiragana-11', 'サ'),
    ('hiragana-12', 'シ'),
    ('hiragana-13', 'ス'),
    ('hiragana-14', 'セ'),
    ('hiragana-15', 'ソ'),
    ('hiragana-16', 'タ'),
    ('hiragana-17', 'チ'),
    ('hiragana-18', 'ツ'),
    ('hiragana-19', 'テ'),
    ('hiragana-20', 'ト'),
    ('hiragana-21', 'ナ'),
    ('hiragana-22', 'ニ'),
    ('hiragana-23', 'ヌ'),
    ('hiragana-24', 'ネ'),
    ('hiragana-25', 'ノ'),
    ('hiragana-26', 'ハ'),
    ('hiragana-27', 'ヒ'),
    ('hiragana-28', 'フ'),
    ('hiragana-29', 'ヘ'),
    ('hiragana-30', 'ホ'),
    ('hiragana-31', 'マ'),
    ('hiragana-32', 'ミ'),
    ('hiragana-33', 'ム'),
    ('hiragana-34', 'メ'),
    ('hiragana-35', 'モ'),
    ('hiragana-36', 'ヤ'),
    ('hiragana-37', 'ユ'),
    ('hiragana-38', 'ヨ'),
    ('hiragana-39', 'ラ'),
    ('hiragana-40', 'リ'),
    ('hiragana-41', 'ル'),
    ('hiragana-42', 'レ'),
    ('hiragana-43', 'ロ'),
    ('hiragana-44', 'ワ'),
    ('hiragana-45', 'ヲ'),
    ('hiragana-46', 'ン'),
    ('hiragana-47', 'ガ'),
    ('hiragana-48', 'ギ'),
    ('hiragana-49', 'グ'),
    ('hiragana-50', 'ゲ'),
    ('hiragana-51', 'ゴ'),
    ('hiragana-52', 'ザ'),
    ('hiragana-53', 'ジ'),
    ('hiragana-54', 'ズ'),
    ('hiragana-55', 'ゼ'),
    ('hiragana-56', 'ゾ'),
    ('hiragana-57', 'ダ'),
    ('hiragana-58', 'ヂ'),
    ('hiragana-59', 'ヅ'),
    ('hiragana-60', 'デ'),
    ('hiragana-61', 'ド'),
    ('hiragana-62', 'バ'),
    ('hiragana-63', 'ビ'),
    ('hiragana-64', 'ブ'),
    ('hiragana-65', 'ベ'),
    ('hiragana-66', 'ボ'),
    ('hiragana-67', 'パ'),
    ('hiragana-68', 'ピ'),
    ('hiragana-69', 'プ'),
    ('hiragana-70', 'ペ'),
    ('hiragana-71', 'ポ')
  ) as v(id, katakana)
  where public.cards.id = v.id and public.cards.user_id = v_uid;

  update public.cards set tags = array['Basic Hiragana & Katakana']
  where user_id = v_uid and tags = array['Basic Hiragana'];
end $$;
