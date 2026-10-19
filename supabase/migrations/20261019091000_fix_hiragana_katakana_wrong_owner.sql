-- 20261019090000_hiragana_deck_katakana_on_back.sql looked up
-- test@test.com and silently matched zero rows: ownership of the
-- "hiragana-*" cards was moved to test_premium@test.com back in
-- 20260924100000_move_hiragana_deck_to_test_premium.sql, which that
-- migration's email lookup didn't account for. Redone here against the
-- actual current owner, matching by id instead of user_id so this
-- doesn't repeat the same mistake if ownership ever moves again.
do $$
declare
  v_matched integer;
begin
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
  where public.cards.id = v.id;

  get diagnostics v_matched = row_count;
  if v_matched <> 71 then
    raise exception 'expected to update 71 cards, updated %', v_matched;
  end if;

  update public.cards set tags = array['Basic Hiragana & Katakana']
  where id like 'hiragana-%' and tags = array['Basic Hiragana'];
end $$;
