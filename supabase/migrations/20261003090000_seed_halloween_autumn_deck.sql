-- Seed: "Halloween & Autumn" deck (50 cards) for test_premium@test.com,
-- for an in-app event featuring seasonal Community content via
-- featured_rank (see 20260919120000_featured_shared_tags.sql).
-- Same approach as the Core 2K decks: real sentences with kanji whose
-- readings genuinely need the kuromoji tokenizer, so romaji/kana/
-- furigana are left at their column defaults for the app's existing
-- backfillMissingReadings() to fill in via the real /api/romaji
-- conversion, rather than hand-guessed here.
do $$
declare
  v_uid uuid;
begin
  select id into v_uid from auth.users where email = 'test_premium@test.com';
  if v_uid is null then
    raise exception 'test_premium@test.com not found';
  end if;

  insert into public.cards (id, user_id, front, back, tags, reps, lapses, due_at, created_at, updated_at)
  values
    ('halloween-01', v_uid, '今年のハロウィンの仮装は何にしますか。', 'What will you wear for Halloween this year?', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-02', v_uid, '玄関にかぼちゃのランタンを飾りました。', 'I decorated the entrance with a pumpkin lantern.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-03', v_uid, '子供たちはお菓子をもらいに行きました。', 'The kids went out to get candy.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-04', v_uid, '「トリック・オア・トリート」と大きな声で言った。', 'They shouted "Trick or treat!" loudly.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-05', v_uid, '黒猫が夜道を静かに歩いていた。', 'A black cat was quietly walking down the night road.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-06', v_uid, '魔女の帽子をかぶった女の子がかわいい。', 'The girl wearing a witch hat is cute.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-07', v_uid, 'お化け屋敷はとても怖かったです。', 'The haunted house was very scary.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-08', v_uid, 'コウモリが夕暮れの空を飛んでいた。', 'Bats were flying across the evening sky.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-09', v_uid, '庭にジャック・オー・ランタンを置いた。', 'I placed a jack-o''-lantern in the garden.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-10', v_uid, '骸骨の仮装をした男の子を見かけた。', 'I saw a boy dressed as a skeleton.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-11', v_uid, '秋になると紅葉がとてもきれいです。', 'The autumn leaves are very beautiful in fall.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-12', v_uid, '公園で落ち葉を踏んで歩くのが好きです。', 'I like walking and stepping on fallen leaves in the park.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-13', v_uid, '今日は涼しい風が気持ちいいですね。', 'The cool breeze feels nice today.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-14', v_uid, '秋空は高くて澄んでいます。', 'The autumn sky is high and clear.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-15', v_uid, '週末に家族で月見をしました。', 'My family did moon viewing over the weekend.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-16', v_uid, '柿が庭の木にたくさん実りました。', 'Many persimmons grew on the tree in the garden.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-17', v_uid, '畑にかかしを立てました。', 'We put up a scarecrow in the field.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-18', v_uid, '村の秋祭りは来週開かれます。', 'The village''s autumn festival will be held next week.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-19', v_uid, '夜の墓地は不気味な雰囲気でした。', 'The graveyard at night had a spooky atmosphere.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-20', v_uid, '今夜は満月がとても明るいです。', 'The full moon is very bright tonight.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-21', v_uid, '朝晩は冷えるのでセーターを着ます。', 'It''s cold morning and night, so I wear a sweater.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-22', v_uid, '寒いのでマフラーを巻いて出かけた。', 'It was cold, so I went out wearing a scarf.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-23', v_uid, 'もみじの葉が真っ赤に色づきました。', 'The maple leaves turned bright red.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-24', v_uid, 'イチョウの葉が黄色くなってきた。', 'The ginkgo leaves have started turning yellow.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-25', v_uid, '今週末に台風が来るそうです。', 'I heard a typhoon is coming this weekend.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-26', v_uid, '今朝は霧でほとんど何も見えなかった。', 'This morning, I could barely see anything because of the fog.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-27', v_uid, 'フクロウの鳴き声が森から聞こえた。', 'An owl''s call could be heard from the forest.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-28', v_uid, '軒先に大きなクモの巣がありました。', 'There was a big spiderweb under the eaves.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-29', v_uid, '秋雨が一週間ずっと降り続いています。', 'The autumn rain has been falling all week.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-30', v_uid, '栗ご飯はこの季節の楽しみの一つです。', 'Chestnut rice is one of the pleasures of this season.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-31', v_uid, 'さつまいもを焼いて食べました。', 'I baked and ate sweet potatoes.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-32', v_uid, 'きのこ狩りに山へ出かけました。', 'We went to the mountains to pick mushrooms.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-33', v_uid, '今年はりんご狩りに行く予定です。', 'We plan to go apple picking this year.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-34', v_uid, 'ぶどうが店先にたくさん並んでいます。', 'Grapes are lined up at the storefront.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-35', v_uid, '友達とハロウィンパーティーを開いた。', 'I had a Halloween party with my friends.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-36', v_uid, '子供は吸血鬼のコスチュームを選んだ。', 'The child chose a vampire costume.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-37', v_uid, 'ゾンビの仮装をした人たちが通りを歩いた。', 'People dressed as zombies walked down the street.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-38', v_uid, '窓にクモの飾りを貼りました。', 'I put spider decorations on the window.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-39', v_uid, 'ろうそくの明かりが部屋を照らしていた。', 'Candlelight was lighting up the room.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-40', v_uid, '秋の夜長に本を読むのが好きです。', 'I like reading books during the long autumn nights.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-41', v_uid, 'かぼちゃのスープを作って温まりました。', 'I made pumpkin soup and warmed up.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-42', v_uid, '熱い飲み物が恋しい季節になりました。', 'It''s become the season when I crave hot drinks.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-43', v_uid, '街はハロウィンの飾りでいっぱいです。', 'The town is full of Halloween decorations.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-44', v_uid, '仮装パレードを見るために駅前に集まった。', 'People gathered in front of the station to see the costume parade.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-45', v_uid, '怖い映画を見てハロウィンを楽しんだ。', 'We enjoyed Halloween by watching scary movies.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-46', v_uid, '秋の空気はひんやりして気持ちがいい。', 'The autumn air is cool and feels pleasant.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-47', v_uid, '庭の木々がだんだん色づいてきました。', 'The trees in the garden are gradually changing color.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-48', v_uid, '子供たちはお化けの仮装が大好きです。', 'Kids love dressing up as ghosts.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-49', v_uid, '秋の収穫を祝うお祭りが開かれました。', 'A festival was held to celebrate the autumn harvest.', array['Halloween & Autumn'], 0, 0, now(), now(), now()),
    ('halloween-50', v_uid, '今年も楽しいハロウィンになりますように。', 'I hope this year''s Halloween will be fun too.', array['Halloween & Autumn'], 0, 0, now(), now(), now())
  on conflict (id) do nothing;
end $$;
