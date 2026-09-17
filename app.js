// Sentence Cards — Japanese sentence flashcard SRS
// Vanilla JS, no build step. Persists to localStorage, uses real
// speech synthesis for "generated" audio and MediaRecorder for "your voice".

(() => {
  "use strict";

  const STORAGE_KEY = "sentence-cards-v1";
  const SESSION_SIZE = 10;
  const AUTOPLAY_AUDIO = true;

  // ---------------------------------------------------------------------
  // Supabase (auth + cloud database). The publishable key is meant to be
  // public — it's rate-limited and Row Level Security on every table is
  // what actually keeps one user's data away from another's.
  // ---------------------------------------------------------------------
  const SUPABASE_URL = "https://asgyhietqpoamagitycs.supabase.co";
  const SUPABASE_KEY = "sb_publishable_oCqtHBphJuPnFgrK87K7PA_XwemlHSO";
  if (!window.supabase) {
    // Nothing to recover here — without this library the app can't do
    // anything — but a visible message beats a permanently blank screen
    // with no console to explain it.
    document.getElementById("app").innerHTML =
      '<div style="padding:60px 24px;text-align:center;font-family:sans-serif;color:var(--text-secondary)">Couldn\'t load a required script. Check your connection and reopen the app.</div>';
    return;
  }
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  // Confirmation-email links must redirect back into the app — passed
  // explicitly so it doesn't depend on the Supabase dashboard's Site URL
  // being set correctly.
  const APP_URL = "https://japanesesentencecards.com/";
  // Inside the native iOS/Android shell there's no same-origin backend to
  // hit with a relative fetch("/api/...") — the page is served from a
  // local/custom scheme, not from japanesesentencecards.com. Route API
  // calls to the deployed site in that case; on the web the relative path
  // already works and stays that way (no reason to force cross-origin).
  const API_BASE = window.Capacitor && window.Capacitor.isNativePlatform() ? "https://japanesesentencecards.com" : "";
  // style.css frames the app as a centered "phone mockup" card on wide
  // viewports — a nice touch on a desktop browser, but wrong inside the
  // native app itself (there's no browser chrome to distinguish it from,
  // and on iPad it just looks like the app doesn't fill the screen).
  if (window.Capacitor && window.Capacitor.isNativePlatform()) {
    document.documentElement.classList.add("native-app");
  }

  // ---------------------------------------------------------------------
  // FSRS (Free Spaced Repetition Scheduler) — v4.5 formulas & default weights.
  //
  // The retrievability/difficulty/stability formulas below are the exact
  // published FSRS-4.5 equations. FSRS_DECAY/FSRS_FACTOR aren't arbitrary:
  // "stability" is DEFINED as the number of days for recall probability to
  // fall to 90%, i.e. R(t=S) = 0.9 — solving (1+FACTOR)^DECAY = 0.9 for
  // FACTOR with DECAY=-0.5 gives exactly 19/81, so the two are self-consistent.
  //
  // FSRS_W is the published *default* parameter set — good out of the box,
  // but a real FSRS deployment additionally *optimizes* these 19 weights
  // per-user from that user's review history (via the separate FSRS
  // optimizer, normally run offline on hundreds+ of reviews). This app
  // does not do that optimization step, so scheduling here uses the same
  // memory model FSRS uses, but generic (non-personalized) weights.
  // ---------------------------------------------------------------------
  const FSRS_DECAY = -0.5;
  const FSRS_FACTOR = 19 / 81;
  const FSRS_W = [
    0.4197, 1.1869, 3.0412, 15.2441, 7.1434, 0.6477, 1.0007, 0.0674,
    1.6597, 0.1712, 1.1178, 2.0225, 0.0904, 0.3025, 2.1214, 0.2498,
    2.9466, 0.4891, 0.6468,
  ];
  const DESIRED_RETENTION = 0.9; // schedule so recall probability is ~90% at the due date
  const AGAIN_RELEARN_MS = 10 * 60 * 1000; // short-term relearn step after "Didn't remember"

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Probability of recall after `elapsedDays` given current `stability`.
  function fsrsRetrievability(elapsedDays, stability) {
    if (!stability || stability <= 0) return 0;
    return Math.pow(1 + (FSRS_FACTOR * elapsedDays) / stability, FSRS_DECAY);
  }

  // rating: 1 = Again, 3 = Good (this app's 2-choice UI only ever uses these two)
  function fsrsInitStability(rating) {
    return Math.max(0.1, FSRS_W[rating - 1]);
  }

  function fsrsInitDifficulty(rating) {
    return clamp(FSRS_W[4] - (rating - 3) * FSRS_W[5], 1, 10);
  }

  function fsrsNextDifficulty(prevDifficulty, rating) {
    const d = prevDifficulty - FSRS_W[6] * (rating - 3);
    const reverted = FSRS_W[7] * fsrsInitDifficulty(4) + (1 - FSRS_W[7]) * d;
    return clamp(reverted, 1, 10);
  }

  function fsrsNextStabilityOnRecall(difficulty, stability, retrievability, rating) {
    const hardPenalty = rating === 2 ? FSRS_W[15] : 1;
    const easyBonus = rating === 4 ? FSRS_W[16] : 1;
    const inc = 1 + Math.exp(FSRS_W[8]) * (11 - difficulty) * Math.pow(stability, -FSRS_W[9]) *
      (Math.exp((1 - retrievability) * FSRS_W[10]) - 1) * hardPenalty * easyBonus;
    return stability * inc;
  }

  function fsrsNextStabilityOnLapse(difficulty, stability, retrievability) {
    const s = FSRS_W[11] * Math.pow(difficulty, -FSRS_W[12]) *
      (Math.pow(stability + 1, FSRS_W[13]) - 1) * Math.exp((1 - retrievability) * FSRS_W[14]);
    return Math.min(s, stability); // a lapse should never increase stability
  }

  // Days until recall probability decays to `retention`, given `stability`.
  function fsrsIntervalDays(stability, retention) {
    return (stability / FSRS_FACTOR) * (Math.pow(retention, 1 / FSRS_DECAY) - 1);
  }

  // 5th element is the kana reading (kuromoji-resolved, matching what
  // /api/romaji would compute) — hardcoded here since these seed cards
  // never pass through that endpoint themselves. See speak().
  const SEED_CARDS = [
    ["昨日は泳ぎました。", "Kinō wa oyogimashita.", "I swam yesterday.", ["Past tense", "Daily life"], "きのうはおよぎました。", "<ruby>昨日<rp>(</rp><rt>きのう</rt><rp>)</rp></ruby>は<ruby>泳<rp>(</rp><rt>およ</rt><rp>)</rp></ruby>ぎました。"],
    ["お会計をお願いします。", "Okaikei o onegai shimasu.", "Could I have the bill, please.", ["Restaurant", "Polite form"], "おかいけいをおねがいします。", "お<ruby>会計<rp>(</rp><rt>かいけい</rt><rp>)</rp></ruby>をお<ruby>願<rp>(</rp><rt>ねが</rt><rp>)</rp></ruby>いします。"],
    ["電車は何時に出ますか。", "Densha wa nanji ni demasu ka.", "What time does the train leave?", ["Travel", "Questions"], "でんしゃはなんじにでますか。", "<ruby>電車<rp>(</rp><rt>でんしゃ</rt><rp>)</rp></ruby>は<ruby>何<rp>(</rp><rt>なん</rt><rp>)</rp></ruby><ruby>時<rp>(</rp><rt>じ</rt><rp>)</rp></ruby>に<ruby>出<rp>(</rp><rt>で</rt><rp>)</rp></ruby>ますか。"],
    ["ちょっと待ってください。", "Chotto matte kudasai.", "Just a moment, please.", ["Polite form", "Daily life"], "ちょっとまってください。", "ちょっと<ruby>待<rp>(</rp><rt>ま</rt><rp>)</rp></ruby>ってください。"],
    ["明日、会議があります。", "Ashita, kaigi ga arimasu.", "I have a meeting tomorrow.", ["Work"], "あした、かいぎがあります。", "<ruby>明日<rp>(</rp><rt>あした</rt><rp>)</rp></ruby>、<ruby>会議<rp>(</rp><rt>かいぎ</rt><rp>)</rp></ruby>があります。"],
    ["これ、いくらですか。", "Kore, ikura desu ka.", "How much is this?", ["Shopping", "Questions"], "これ、いくらですか。", "これ、いくらですか。"],
    ["傘を忘れました。", "Kasa o wasuremashita.", "I forgot my umbrella.", ["Past tense", "Daily life"], "かさをわすれました。", "<ruby>傘<rp>(</rp><rt>かさ</rt><rp>)</rp></ruby>を<ruby>忘<rp>(</rp><rt>わす</rt><rp>)</rp></ruby>れました。"],
    ["日本語で話しましょう。", "Nihongo de hanashimashō.", "Let's speak in Japanese.", ["Daily life"], "にほんごではなしましょう。", "<ruby>日本語<rp>(</rp><rt>にほんご</rt><rp>)</rp></ruby>で<ruby>話<rp>(</rp><rt>はな</rt><rp>)</rp></ruby>しましょう。"],
    ["すみません、道に迷いました。", "Sumimasen, michi ni mayoimashita.", "Excuse me, I'm lost.", ["Travel", "Polite form"], "すみません、みちにまよいました。", "すみません、<ruby>道<rp>(</rp><rt>みち</rt><rp>)</rp></ruby>に<ruby>迷<rp>(</rp><rt>まよ</rt><rp>)</rp></ruby>いました。"],
    ["少し高いと思います。", "Sukoshi takai to omoimasu.", "I think it's a bit expensive.", ["Shopping", "Opinions"], "すこしたかいとおもいます。", "<ruby>少<rp>(</rp><rt>すこ</rt><rp>)</rp></ruby>し<ruby>高<rp>(</rp><rt>たか</rt><rp>)</rp></ruby>いと<ruby>思<rp>(</rp><rt>おも</rt><rp>)</rp></ruby>います。"],
    ["資料を送っておきました。", "Shiryō o okutte okimashita.", "I've sent the documents.", ["Work", "Past tense"], "しりょうをおくっておきました。", "<ruby>資料<rp>(</rp><rt>しりょう</rt><rp>)</rp></ruby>を<ruby>送<rp>(</rp><rt>おく</rt><rp>)</rp></ruby>っておきました。"],
    ["週末は何をしましたか。", "Shūmatsu wa nani o shimashita ka.", "What did you do on the weekend?", ["Questions", "Past tense"], "しゅうまつはなにをしましたか。", "<ruby>週末<rp>(</rp><rt>しゅうまつ</rt><rp>)</rp></ruby>は<ruby>何<rp>(</rp><rt>なに</rt><rp>)</rp></ruby>をしましたか。"],
  ];

  // ---------------------------------------------------------------------
  // Persisted state
  // ---------------------------------------------------------------------

  function makeSeedData() {
    const now = Date.now();
    return {
      userId: null, // whose account this cached blob belongs to (see enterApp)
      pendingDeletes: [], // card ids deleted locally but not yet confirmed deleted in the cloud
      cards: SEED_CARDS.map((c, i) => ({
        id: "seed-" + i,
        front: c[0],
        romaji: c[1],
        back: c[2],
        tags: c[3],
        kana: c[4],
        furigana: c[5],
        stability: null, // null until first reviewed — FSRS memory state
        difficulty: null,
        reps: 0,
        lapses: 0,
        lastReviewAt: null,
        dueAt: now,
        audio: { type: "system" },
        createdAt: now - (SEED_CARDS.length - i) * 1000,
        updatedAt: now - (SEED_CARDS.length - i) * 1000,
      })),
      reviewLog: {}, // "YYYY-MM-DD" -> count
      activeMsLog: {}, // "YYYY-MM-DD" -> ms active that day, for the 7d/30d "Time in app" tile
      profile: { username: "", photo: null },
      totalActiveMs: 0,
      theme: "system", // "light" | "dark" | "system" — device-local, not synced (see applyTheme())
    };
  }

  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return makeSeedData();
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.cards)) return makeSeedData();
      if (!parsed.reviewLog) parsed.reviewLog = {};
      if (!parsed.activeMsLog) parsed.activeMsLog = {};
      if (!parsed.profile) parsed.profile = { username: "", photo: null };
      if (parsed.profile.name !== undefined && !parsed.profile.username) {
        parsed.profile.username = parsed.profile.name;
      }
      delete parsed.profile.name;
      if (typeof parsed.totalActiveMs !== "number") parsed.totalActiveMs = 0;
      if (parsed.theme !== "light" && parsed.theme !== "dark" && parsed.theme !== "system") parsed.theme = "system";
      if (typeof parsed.userId !== "string") parsed.userId = null;
      if (!Array.isArray(parsed.pendingDeletes)) parsed.pendingDeletes = [];
      parsed.cards.forEach((c) => {
        if (c.stability === undefined) c.stability = null;
        if (c.difficulty === undefined) c.difficulty = null;
        if (c.reps === undefined) c.reps = c.seen || 0;
        if (c.lapses === undefined) c.lapses = 0;
        if (c.lastReviewAt === undefined) c.lastReviewAt = null;
        if (c.updatedAt === undefined) c.updatedAt = c.createdAt || Date.now();
        delete c.box;
        delete c.seen;
      });
      return parsed;
    } catch {
      return makeSeedData();
    }
  }

  let data = makeSeedData(); // safe placeholder; real content loads once auth resolves (see bottom of file)

  function saveData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn("Could not save to localStorage", e);
    }
  }

  // Sets the actual light/dark attribute the CSS theme tokens key off
  // (see style.css) — "system" resolves against the OS setting rather
  // than being a third real appearance. Device-local only, deliberately
  // not synced: appearance is a per-screen preference, not account data.
  function applyTheme() {
    const effective = data.theme === "dark" || (data.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", effective);
  }

  function setTheme(theme) {
    data.theme = theme;
    saveData();
    applyTheme();
    render();
  }

  applyTheme();
  if (window.matchMedia) {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (data.theme === "system") applyTheme();
    });
  }

  // Tracks cumulative time the app has been open and visible, for the
  // "Time in app" stat. Approximate (foreground time only), not billing-grade.
  (function trackActiveTime() {
    let lastTick = Date.now();
    setInterval(() => {
      const now = Date.now();
      const delta = now - lastTick;
      lastTick = now;
      if (document.visibilityState === "visible" && delta > 0 && delta < 60000 && ui.screen !== "boot" && ui.screen !== "auth") {
        data.totalActiveMs += delta;
        const key = dateKey(new Date());
        data.activeMsLog[key] = (data.activeMsLog[key] || 0) + delta;
        saveData();
      }
    }, 15000);
  })();

  // Transient (not persisted) UI/session state
  function blankAuthState() {
    return { mode: "login", email: "", password: "", confirm: "", pendingEmail: "", error: "", busy: false };
  }

  function blankPasswordState() {
    return { password: "", confirm: "", error: "", busy: false };
  }

  let ui = {
    screen: "boot", // "boot" | "auth" | the usual app screens, set once auth resolves (see bottom of file)
    sel: [], // selected tags on the tags screen
    query: "",
    filter: "All",
    draft: blankDraft(), // function declaration is hoisted, so this runs fine here
    profileDraft: { username: "", photo: null },
    auth: blankAuthState(),
    pwDraft: blankPasswordState(),
    activityRange: "all", // "all" | "30d" | "7d"
    session: null, // { queue: [ids], qi, flipped, tags, results }
    cardSavedFlash: false,
    cropModal: null, // { imgSrc, natW, natH, zoom, offsetX, offsetY } while cropping a new profile photo
    heatmapTip: null, // { key, count } — the heatmap day currently hovered/tapped
    deletingAccount: false,
    avatarSheetOpen: false,
    emailCopiedFlash: false,
    selectMode: false, // Cards screen: multi-select for bulk tag/delete
    selectedIds: [],
    bulkTagSheet: null, // { query, checked: [] } while the "add tag to N cards" sheet is open
    deleteTagSheet: null, // tag name while its delete-choice sheet is open
    myTagsLoading: false,
    myTagsShared: [], // this account's own shared_tags rows (any status), loaded from Supabase
    myTagsFrozen: false, // derived: profiles.sharing_frozen_until is still in the future
    myTagsFrozenUntil: null, // Date, or null — when the account's sharing pause lifts
    renameTagSheet: null, // { oldName, newName } while the rename sheet is open
    shareDraft: null, // { tagName, selectedIds, backLanguage, description, busy, error } during the share flow
    communityLoading: false,
    communityFeed: [], // active shared_tags rows, loaded on entering Community
    communitySearch: "",
    communityLangFilter: "Any",
    tagDetail: null, // { row, previewCards, loading } while viewing a shared tag's detail
    downloadDraft: null, // { row, name, error, busy } confirming/renaming before a download
  };

  let recTimer = null;
  let mediaRecorder = null;
  let recChunks = [];
  let recStream = null;

  // Scroll positions survive a re-render even though render() rebuilds the
  // whole DOM tree, so tapping a filter chip (etc.) doesn't snap a scroller
  // back to its start. Keyed by a "data-remember-scroll" attribute value.
  const scrollMemory = {};

  // ---------------------------------------------------------------------
  // Derived helpers
  // ---------------------------------------------------------------------

  function dateKey(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function isDue(card, now) {
    return card.dueAt <= now;
  }

  function dueCards(tags) {
    const now = Date.now();
    return data.cards.filter((c) => isDue(c, now) && (!tags || !tags.length || c.tags.some((t) => tags.includes(t))));
  }

  function allTags() {
    const s = [];
    data.cards.forEach((c) => c.tags.forEach((t) => { if (!s.includes(t)) s.push(t); }));
    return s;
  }

  // Same as allTags(), but always includes "Untagged" even when no card
  // currently needs it — so it stays available to filter/review/edit by,
  // rather than only appearing after the fact once a card falls into it.
  function browsableTags() {
    const s = allTags();
    return s.includes(UNTAGGED_TAG) ? s : s.concat(UNTAGGED_TAG);
  }

  function streakDays() {
    const log = data.reviewLog;
    let d = new Date();
    if (!(dateKey(d) in log)) d.setDate(d.getDate() - 1);
    let count = 0;
    while (log[dateKey(d)] > 0) {
      count++;
      d.setDate(d.getDate() - 1);
    }
    return count;
  }

  function longestStreak() {
    const dates = Object.keys(data.reviewLog).filter((k) => data.reviewLog[k] > 0).sort();
    if (!dates.length) return 0;
    let best = 1, cur = 1;
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1] + "T00:00:00");
      const curr = new Date(dates[i] + "T00:00:00");
      const diffDays = Math.round((curr - prev) / 86400000);
      cur = diffDays === 1 ? cur + 1 : 1;
      best = Math.max(best, cur);
    }
    return best;
  }

  // Activity range toggle: "all" | "30d" | "7d" — how many days back each
  // covers for the three stat tiles (Cards/Reviewed/Active days). "all"
  // means every day ever recorded for this account, not a rolling year —
  // Infinity is handled specially in rangeStart() below.
  const ACTIVITY_RANGE_DAYS = { all: Infinity, "30d": 29, "7d": 6 };

  function rangeStart(daysBack) {
    if (daysBack === Infinity) return new Date(0);
    const from = new Date();
    from.setDate(from.getDate() - daysBack);
    from.setHours(0, 0, 0, 0);
    return from;
  }

  // Distinct cards reviewed at least once in the window — a card graded
  // several times (retries, practice) still only counts once.
  function cardsReviewedInLastDays(daysBack) {
    const from = rangeStart(daysBack).getTime();
    return data.cards.filter((c) => c.lastReviewAt && c.lastReviewAt >= from).length;
  }

  function activeDaysInLastDays(daysBack) {
    const from = rangeStart(daysBack);
    const to = new Date();
    let n = 0;
    for (const [key, count] of Object.entries(data.reviewLog)) {
      if (count <= 0) continue;
      const d = new Date(key + "T00:00:00");
      if (d >= from && d <= to) n++;
    }
    return n;
  }

  function cardsAddedInLastDays(daysBack) {
    if (daysBack === Infinity) return data.cards.length;
    const from = rangeStart(daysBack).getTime();
    return data.cards.filter((c) => c.createdAt >= from).length;
  }

  // "All" reports the true lifetime total rather than summing
  // activeMsLog, since that log only exists from whenever this
  // per-day tracking shipped — summing it for "all" would silently
  // under-report time accumulated before that.
  function activeMsInLastDays(daysBack) {
    if (daysBack === Infinity) return data.totalActiveMs;
    const from = rangeStart(daysBack);
    let sum = 0;
    for (const [key, ms] of Object.entries(data.activeMsLog)) {
      if (new Date(key + "T00:00:00") >= from) sum += ms;
    }
    return sum;
  }

  function formatDuration(ms) {
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h <= 0) return m + "m";
    return h + "h " + m + "m";
  }

  // The heatmap's own visible span — independent of the stat-tile range
  // toggle above it (which can go all the way back to "all"). ~6 months:
  // 26 full weeks, so the grid never has a ragged leading week. Recomputed
  // from "today" on every render (see below), so the window is inherently
  // rolling — today's column is always the rightmost, and the oldest day
  // simply stops being included as time passes. Nothing is ever deleted
  // from the database; this only changes how much of it gets drawn.
  const HEATMAP_DAYS = 26 * 7;

  // A GitHub-style grid of weeks (Sun-Sat columns) covering the last `daysBack`
  // days, ending today. All date math here uses local-calendar Date methods
  // (setDate/getDay/setHours), never raw UTC or millisecond arithmetic, so
  // it stays correct across DST transitions and in the user's own timezone.
  function heatmapWeeks(daysBack) {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - daysBack);
    start.setDate(start.getDate() - start.getDay());
    const weeks = [];
    let d = new Date(start);
    while (d <= end) {
      const week = [];
      for (let dow = 0; dow < 7; dow++) {
        week.push(d > end ? null : { count: data.reviewLog[dateKey(d)] || 0, key: dateKey(d) });
        d.setDate(d.getDate() + 1);
      }
      weeks.push(week);
    }
    return weeks;
  }

  function heatLevel(count, max) {
    if (!count) return 0;
    const r = count / max;
    if (r <= 0.25) return 1;
    if (r <= 0.5) return 2;
    if (r <= 0.75) return 3;
    return 4;
  }

  const HEAT_COLORS = ["var(--bg-tint)", "#f1d7bc", "#e6a874", "var(--accent)", "#7a3018"];

  function heatmapTipText(tip) {
    if (!tip) return "Hover or tap a day to see reviews";
    const label = new Date(tip.key + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const n = tip.count === 1 ? "1 review" : tip.count + " reviews";
    return n + " on " + label;
  }

  function dueLabel(card) {
    const now = Date.now();
    if (card.dueAt <= now) return "due now";
    const days = Math.ceil((card.dueAt - now) / 86400000);
    if (days <= 0) return "due now";
    if (days === 1) return "in 1 day";
    return "in " + days + " days";
  }

  function logReviewToday() {
    const key = dateKey(new Date());
    data.reviewLog[key] = (data.reviewLog[key] || 0) + 1;
  }

  // ---------------------------------------------------------------------
  // Cloud sync (Supabase). The app stays offline-first: every mutation
  // below applies to the local `data` blob and localStorage immediately
  // (unchanged from before), and *separately* fires a best-effort push to
  // the cloud that silently no-ops if there's no session or no network —
  // nothing here is ever awaited by the UI. syncNow() is the reconciler
  // that runs on login and periodically, pulling remote changes down and
  // pushing anything local that's newer, so a connection dropping mid-edit
  // just means that edit syncs on the next successful pass instead.
  // ---------------------------------------------------------------------

  async function getSessionSafe() {
    try {
      const { data: { session } } = await sb.auth.getSession();
      return session || null;
    } catch {
      return null;
    }
  }

  function cardToRow(card, userId) {
    return {
      id: card.id,
      user_id: userId,
      front: card.front,
      romaji: card.romaji || "",
      kana: card.kana || "",
      furigana: card.furigana || "",
      back: card.back,
      tags: card.tags,
      stability: card.stability,
      difficulty: card.difficulty,
      reps: card.reps,
      lapses: card.lapses,
      last_review_at: card.lastReviewAt ? new Date(card.lastReviewAt).toISOString() : null,
      due_at: new Date(card.dueAt).toISOString(),
      audio: card.audio,
      created_at: new Date(card.createdAt).toISOString(),
    };
  }

  function rowToCard(row) {
    return {
      id: row.id,
      front: row.front,
      romaji: row.romaji || "",
      kana: row.kana || "",
      furigana: row.furigana || "",
      back: row.back,
      tags: row.tags || [],
      stability: row.stability,
      difficulty: row.difficulty,
      reps: row.reps,
      lapses: row.lapses,
      lastReviewAt: row.last_review_at ? new Date(row.last_review_at).getTime() : null,
      dueAt: new Date(row.due_at).getTime(),
      audio: row.audio,
      sourceSharedTagId: row.source_shared_tag_id || null,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    };
  }

  async function pushCard(card) {
    const session = await getSessionSafe();
    if (!session) return;
    try {
      const { data: row, error } = await sb.from("cards").upsert(cardToRow(card, session.user.id)).select().single();
      if (!error && row) card.updatedAt = new Date(row.updated_at).getTime();
    } catch (e) {
      console.warn("pushCard failed (offline?)", e);
    }
  }

  async function pushCardsBulk(cards) {
    if (!cards.length) return;
    const session = await getSessionSafe();
    if (!session) return;
    try {
      const rows = cards.map((c) => cardToRow(c, session.user.id));
      const { data: savedRows, error } = await sb.from("cards").upsert(rows).select();
      if (!error && savedRows) {
        const byId = new Map(savedRows.map((r) => [r.id, r]));
        cards.forEach((c) => { const r = byId.get(c.id); if (r) c.updatedAt = new Date(r.updated_at).getTime(); });
      }
    } catch (e) {
      console.warn("pushCardsBulk failed (offline?)", e);
    }
  }

  async function pushDeleteCard(id) {
    const session = await getSessionSafe();
    if (!session) return;
    try {
      // Soft delete (see syncNow()'s merge logic for why): a device that
      // hasn't heard about this deletion yet needs to be able to tell "this
      // card was removed" apart from "this card doesn't exist here yet".
      const { error } = await sb.from("cards").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("user_id", session.user.id);
      if (!error) data.pendingDeletes = data.pendingDeletes.filter((x) => x !== id);
    } catch (e) {
      console.warn("pushDeleteCard failed (offline?)", e);
    }
  }

  // Returns an error message on failure (or null on success/offline) so
  // saveProfile() can actually tell the user instead of the save silently
  // not sticking — offline is expected/retried later, a real rejection
  // from the server (e.g. a constraint violation) is not.
  async function pushProfile() {
    const session = await getSessionSafe();
    if (!session) return null;
    try {
      const { error } = await sb.from("profiles").upsert({ id: session.user.id, username: data.profile.username || null, photo: data.profile.photo, total_active_ms: data.totalActiveMs });
      if (error) { console.warn("pushProfile rejected", error); return error.message; }
      return null;
    } catch (e) {
      console.warn("pushProfile failed (offline?)", e);
      return null;
    }
  }

  async function pushReviewDay(day) {
    const session = await getSessionSafe();
    if (!session) return;
    try {
      await sb.from("review_log").upsert({ user_id: session.user.id, day, count: data.reviewLog[day] || 0, active_ms: data.activeMsLog[day] || 0 });
    } catch (e) {
      console.warn("pushReviewDay failed (offline?)", e);
    }
  }

  let syncing = false;

  async function syncNow() {
    if (syncing) return;
    syncing = true;
    try {
      const session = await getSessionSafe();
      if (!session) return;
      const userId = session.user.id;

      // Flush any deletes that couldn't reach the server yet.
      for (const id of data.pendingDeletes.slice()) await pushDeleteCard(id);

      let remoteProfile, remoteCards, remoteLog;
      try {
        [{ data: remoteProfile }, { data: remoteCards }, { data: remoteLog }] = await Promise.all([
          sb.from("profiles").select("*").eq("id", userId).maybeSingle(),
          sb.from("cards").select("*").eq("user_id", userId),
          sb.from("review_log").select("*").eq("user_id", userId),
        ]);
      } catch (e) {
        console.warn("Sync pull failed (offline?)", e);
        return; // keep working from whatever's local
      }

      if (remoteProfile) {
        data.profile = { username: remoteProfile.username || "", photo: remoteProfile.photo || null };
        // "Time in app" is tracked per-device, so two devices naturally
        // drift apart — converge both to whichever has accumulated more,
        // same idea as the review-log merge below. Not a true sum across
        // devices (that would need real delta-tracking, overkill for a
        // vanity stat) — just "never show a lower number than any device
        // has already seen."
        const remoteMs = remoteProfile.total_active_ms || 0;
        if (remoteMs > data.totalActiveMs) data.totalActiveMs = remoteMs;
        else if (data.totalActiveMs > remoteMs) await pushProfile();
      }

      const remoteCounts = {};
      const remoteActiveMs = {};
      (remoteLog || []).forEach((r) => { remoteCounts[r.day] = r.count; remoteActiveMs[r.day] = r.active_ms || 0; });
      const mergedLog = Object.assign({}, data.reviewLog);
      (remoteLog || []).forEach((r) => { mergedLog[r.day] = Math.max(mergedLog[r.day] || 0, r.count); });
      data.reviewLog = mergedLog;
      const mergedActiveMsLog = Object.assign({}, data.activeMsLog);
      (remoteLog || []).forEach((r) => { mergedActiveMsLog[r.day] = Math.max(mergedActiveMsLog[r.day] || 0, r.active_ms || 0); });
      data.activeMsLog = mergedActiveMsLog;

      // A day whose local count or active time is still higher than what
      // the server has means an earlier pushReviewDay() never made it
      // through (offline at the time, tab closed mid-request, etc.) —
      // retry it here so a streak — or the "time in app" tile — recorded
      // on one device isn't silently missing on another.
      for (const day of new Set([...Object.keys(mergedLog), ...Object.keys(mergedActiveMsLog)])) {
        if (mergedLog[day] > (remoteCounts[day] || 0) || (mergedActiveMsLog[day] || 0) > (remoteActiveMs[day] || 0)) await pushReviewDay(day);
      }

      // Rows this device is itself mid-deleting shouldn't count toward
      // "does the server have anything" — otherwise deleting your only
      // card, offline, could momentarily look like a brand-new account.
      const remoteRows = remoteCards || [];
      const remoteRowsExcludingOwnPendingDeletes = remoteRows.filter((r) => !data.pendingDeletes.includes(r.id));

      if (remoteRowsExcludingOwnPendingDeletes.length === 0 && data.cards.length === 0) {
        // Brand new account, nothing local either: start with the example deck.
        data.cards = makeSeedData().cards;
        await pushCardsBulk(data.cards);
      } else if (remoteRowsExcludingOwnPendingDeletes.length === 0) {
        // Brand new account with existing local cards: claim them as the initial cloud set.
        await pushCardsBulk(data.cards);
      } else {
        const localById = new Map(data.cards.map((c) => [c.id, c]));
        const merged = [];
        const toPush = [];
        const seenIds = new Set();
        // Walk every remote row, including tombstoned ones (deleted_at
        // set) — a card can only be told apart from "never synced from
        // this device" if the server still remembers it was deleted.
        for (const row of remoteRows) {
          seenIds.add(row.id);
          if (data.pendingDeletes.includes(row.id)) continue; // we're deleting this ourselves; don't resurrect it mid-flight
          if (row.deleted_at) continue; // tombstoned elsewhere — stays gone, no matter what this device's stale copy looks like
          const localCard = localById.get(row.id);
          if (!localCard) { merged.push(rowToCard(row)); continue; }
          const remoteUpdated = new Date(row.updated_at).getTime();
          if ((localCard.updatedAt || 0) > remoteUpdated) { merged.push(localCard); toPush.push(localCard); }
          else { merged.push(rowToCard(row)); }
        }
        for (const c of data.cards) {
          if (!seenIds.has(c.id) && !data.pendingDeletes.includes(c.id)) { merged.push(c); toPush.push(c); }
        }
        data.cards = merged;
        if (toPush.length) await pushCardsBulk(toPush);
      }

      data.userId = userId;
      saveData();
      render();
      backfillMissingReadings(); // not awaited — runs quietly in the background
    } finally {
      syncing = false;
    }
  }

  // ---------------------------------------------------------------------
  // DOM builder
  // ---------------------------------------------------------------------

  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    attrs = attrs || {};
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else if (k === "class") e.className = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  function icon(svgInner, size = 21, stroke = "currentColor", extraAttrs = {}) {
    const wrap = h("div");
    wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${svgInner}</svg>`;
    const svg = wrap.firstChild;
    for (const [k, v] of Object.entries(extraAttrs)) svg.setAttribute(k, v);
    return svg;
  }

  // Renders a card's front sentence with furigana ruby annotations —
  // card.furigana is server-generated, pre-escaped <ruby> HTML (see
  // api/romaji.js), safe to set as innerHTML even for a card downloaded
  // from someone else's shared tag. Falls back to plain text if it
  // hasn't been generated/backfilled yet.
  function furiganaNode(card, style) {
    const el = h("div", { style });
    if (card.furigana) el.innerHTML = card.furigana;
    else el.textContent = card.front;
    return el;
  }

  // ---------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------

  let voicesReady = [];
  if ("speechSynthesis" in window) {
    const load = () => { voicesReady = speechSynthesis.getVoices(); };
    load();
    speechSynthesis.onvoiceschanged = load;
  }

  function speak(text) {
    if (!("speechSynthesis" in window) || !text) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    const jaVoice = voicesReady.find((v) => v.lang && v.lang.toLowerCase().startsWith("ja"));
    if (jaVoice) u.voice = jaVoice;
    u.rate = 0.95;
    speechSynthesis.speak(u);
  }

  function playCardAudio(card) {
    if (!card) return;
    if (card.audio && card.audio.type === "voice" && card.audio.data) {
      const a = new Audio(card.audio.data);
      a.play().catch(() => {});
    } else {
      // Speaking the kana reading (not raw front text) sidesteps the
      // device voice's own kanji-reading guesses — see generateRomaji().
      speak(card.kana || card.front);
    }
  }

  async function startRecording() {
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      alert("Microphone access was denied or is unavailable.");
      return;
    }
    recChunks = [];
    mediaRecorder = new MediaRecorder(recStream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      recStream.getTracks().forEach((t) => t.stop());
      // iOS puts the audio session into voice-chat mode (with echo
      // cancellation) for the duration of any mic capture, and doesn't
      // undo that just because the tracks stopped — left alone, every
      // later playback of this recording (or any other audio) keeps
      // running through that DSP path and comes out sounding echoey.
      if (window.Capacitor && window.Capacitor.isNativePlatform() && window.Capacitor.Plugins && window.Capacitor.Plugins.AudioSessionFix) {
        window.Capacitor.Plugins.AudioSessionFix.resetForPlayback().catch(() => {});
      }
      const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      const reader = new FileReader();
      reader.onload = () => {
        ui.draft.recording = reader.result;
        render();
      };
      reader.readAsDataURL(blob);
    };
    mediaRecorder.start();
    ui.draft.recState = "active";
    ui.draft.recSec = 0;
    render();
    recTimer = setInterval(() => {
      ui.draft.recSec += 1;
      if (ui.draft.recSec >= 8) {
        stopRecording();
      } else {
        render();
      }
    }, 1000);
  }

  function stopRecording() {
    clearInterval(recTimer);
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    ui.draft.recState = "done";
    render();
  }

  function tapRecord() {
    if (ui.draft.recState === "idle") startRecording();
    else if (ui.draft.recState === "active") stopRecording();
    else if (ui.draft.recording) new Audio(ui.draft.recording).play().catch(() => {});
  }


  // ---------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------

  function go(screen) {
    ui.screen = screen;
    render();
  }

  function cardsMatchingTags(tags) {
    return data.cards.filter((c) => !tags || !tags.length || c.tags.some((t) => tags.includes(t)));
  }

  // practice=true reviews ahead of schedule: pulls from ALL matching cards
  // (not just due ones), soonest-due-first, so answering them still runs
  // through the normal FSRS update — this is a real review, just early.
  function beginSession(tags, practice) {
    const pool = practice ? cardsMatchingTags(tags) : dueCards(tags);
    const queue = pool.slice().sort((a, b) => a.dueAt - b.dueAt).slice(0, SESSION_SIZE).map((c) => c.id);
    if (!queue.length) return;
    ui.session = { queue, qi: 0, flipped: false, tags: tags.length ? tags : ["all tags"], results: { again: 0, good: 0 }, practice: !!practice };
    ui.screen = "review";
    render();
    if (AUTOPLAY_AUDIO) setTimeout(() => playCardAudio(currentCard()), 250);
  }

  function currentCard() {
    if (!ui.session) return null;
    const id = ui.session.queue[ui.session.qi];
    return data.cards.find((c) => c.id === id) || null;
  }

  // Self-graded recall, FSRS-scheduled: the user can flip the card to
  // either side as many times as they like before judging themselves —
  // grading isn't tied to which face is showing. Choosing a grade
  // drives the FSRS memory-state update and immediately advances to
  // the next card in one action.
  function answerCard(remembered) {
    const s = ui.session;
    const c = currentCard();
    if (!s || !c) return;

    const rating = remembered ? 3 : 1; // FSRS rating scale: 1=Again, 3=Good
    const now = Date.now();
    const elapsedDays = c.lastReviewAt ? (now - c.lastReviewAt) / 86400000 : 0;

    if (c.stability == null) {
      c.stability = fsrsInitStability(rating);
      c.difficulty = fsrsInitDifficulty(rating);
    } else {
      const r = fsrsRetrievability(elapsedDays, c.stability);
      c.stability = remembered
        ? fsrsNextStabilityOnRecall(c.difficulty, c.stability, r, rating)
        : fsrsNextStabilityOnLapse(c.difficulty, c.stability, r);
      c.difficulty = fsrsNextDifficulty(c.difficulty, rating);
    }

    c.lastReviewAt = now;
    c.reps += 1;
    if (!remembered) c.lapses += 1;

    if (remembered) {
      const days = fsrsIntervalDays(c.stability, DESIRED_RETENTION);
      c.dueAt = now + Math.max(1, Math.round(days)) * 86400000;
    } else {
      c.dueAt = now + AGAIN_RELEARN_MS; // long-term stability/difficulty above are still updated
    }

    s.results[remembered ? "good" : "again"] += 1;
    c.updatedAt = now;
    logReviewToday();
    saveData();
    pushCard(c);
    pushReviewDay(dateKey(new Date()));
    nextCard();
  }

  function flipCard() {
    const s = ui.session;
    if (!s) return;
    s.flipped = !s.flipped;
    render();
  }

  function nextCard() {
    const s = ui.session;
    if (!s) return;
    const last = s.qi >= s.queue.length - 1;
    if (last) {
      ui.screen = "done";
    } else {
      s.qi += 1;
      s.flipped = false;
    }
    render();
    if (!last && AUTOPLAY_AUDIO) setTimeout(() => playCardAudio(currentCard()), 250);
  }

  function toggleTagSel(t) {
    ui.sel = ui.sel.includes(t) ? ui.sel.filter((x) => x !== t) : ui.sel.concat(t);
    render();
  }

  function openDeleteTagSheet(tag) {
    if (tag === UNTAGGED_TAG) return;
    ui.deleteTagSheet = tag;
    render();
  }

  function closeDeleteTagSheet() {
    ui.deleteTagSheet = null;
    render();
  }

  // Deleting a tag removes it from every card that has it (tags aren't a
  // separate registry — they're just whatever's on data.cards). A card left
  // with none falls back to UNTAGGED_TAG so it's never truly tag-less.
  function deleteTagOnly(tag) {
    const affected = [];
    data.cards.forEach((c) => {
      if (c.tags.includes(tag)) {
        c.tags = c.tags.filter((x) => x !== tag);
        if (!c.tags.length) c.tags = [UNTAGGED_TAG];
        c.updatedAt = Date.now();
        affected.push(c);
      }
    });
    ui.sel = ui.sel.filter((x) => x !== tag);
    if (ui.filter === tag) ui.filter = "All";
    ui.deleteTagSheet = null;
    saveData();
    render();
    pushCardsBulk(affected);
  }

  function deleteTagAndCards(tag) {
    const toDelete = data.cards.filter((c) => c.tags.includes(tag));
    data.cards = data.cards.filter((c) => !c.tags.includes(tag));
    toDelete.forEach((c) => data.pendingDeletes.push(c.id));
    ui.sel = ui.sel.filter((x) => x !== tag);
    if (ui.filter === tag) ui.filter = "All";
    ui.deleteTagSheet = null;
    saveData();
    render();
    toDelete.forEach((c) => pushDeleteCard(c.id));
  }

  // ---------------------------------------------------------------------
  // Cards screen — multi-select (bulk tag / bulk delete)
  // ---------------------------------------------------------------------

  function enterSelectMode() {
    ui.selectMode = true;
    ui.selectedIds = [];
    render();
  }

  function exitSelectMode() {
    ui.selectMode = false;
    ui.selectedIds = [];
    render();
  }

  function toggleCardSelected(id) {
    ui.selectedIds = ui.selectedIds.includes(id) ? ui.selectedIds.filter((x) => x !== id) : ui.selectedIds.concat(id);
    render();
  }

  function toggleSelectAll(visibleIds) {
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => ui.selectedIds.includes(id));
    ui.selectedIds = allSelected ? [] : visibleIds.slice();
    render();
  }

  function bulkDeleteSelected() {
    if (!ui.selectedIds.length) return;
    const n = ui.selectedIds.length;
    if (!confirm("Delete " + n + " card" + (n === 1 ? "" : "s") + "? This can't be undone.")) return;
    const ids = ui.selectedIds.slice();
    data.cards = data.cards.filter((c) => !ids.includes(c.id));
    ids.forEach((id) => data.pendingDeletes.push(id));
    exitSelectMode();
    saveData();
    render();
    ids.forEach((id) => pushDeleteCard(id));
  }

  function openBulkTagSheet() {
    if (!ui.selectedIds.length) return;
    ui.bulkTagSheet = { query: "", checked: [] };
    render();
  }

  function closeBulkTagSheet() {
    ui.bulkTagSheet = null;
    render();
  }

  function toggleBulkTagChecked(tag) {
    const s = ui.bulkTagSheet;
    s.checked = s.checked.includes(tag) ? s.checked.filter((x) => x !== tag) : s.checked.concat(tag);
    render();
  }

  function createBulkTag() {
    const s = ui.bulkTagSheet;
    const t = s.query.trim();
    if (!t) return;
    if (!s.checked.includes(t)) s.checked = s.checked.concat(t);
    s.query = "";
    render();
  }

  function applyBulkTag() {
    const s = ui.bulkTagSheet;
    if (!s || !s.checked.length) return;
    const ids = ui.selectedIds.slice();
    const affected = [];
    data.cards.forEach((c) => {
      if (!ids.includes(c.id)) return;
      let changed = false;
      s.checked.forEach((t) => {
        if (!c.tags.includes(t)) { c.tags = c.tags.filter((x) => x !== UNTAGGED_TAG).concat(t); changed = true; }
      });
      if (changed) { c.updatedAt = Date.now(); affected.push(c); }
    });
    ui.bulkTagSheet = null;
    exitSelectMode();
    saveData();
    render();
    pushCardsBulk(affected);
  }

  // ---------------------------------------------------------------------
  // Community — My tags (rename, share) and the share flow.
  //
  // Cards downloaded from the community carry source_shared_tag_id, so
  // they never count toward "eligible" here — matches the server-side
  // check in share_tag(), which would reject them anyway; this just
  // means the user sees why up front instead of a rejected submission.
  // ---------------------------------------------------------------------

  function eligibleCardsForTag(tag) {
    return cardsMatchingTags([tag]).filter((c) => !c.sourceSharedTagId);
  }

  function formatFrozenUntil(d) {
    return d ? d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : "further notice";
  }

  async function openMyTags() {
    go("myTags");
    ui.myTagsLoading = true;
    render();
    const session = await getSessionSafe();
    if (!session) { ui.myTagsLoading = false; render(); return; }
    try {
      const [{ data: shared }, { data: prof }] = await Promise.all([
        sb.from("shared_tags").select("*").eq("owner_id", session.user.id),
        sb.from("profiles").select("sharing_frozen_until").eq("id", session.user.id).maybeSingle(),
      ]);
      ui.myTagsShared = shared || [];
      ui.myTagsFrozenUntil = prof && prof.sharing_frozen_until ? new Date(prof.sharing_frozen_until) : null;
      ui.myTagsFrozen = !!(ui.myTagsFrozenUntil && ui.myTagsFrozenUntil > new Date());
    } catch (e) {
      console.warn("loading My tags failed (offline?)", e);
    }
    ui.myTagsLoading = false;
    render();
  }

  // Tags aren't a separate registry (see deleteTag() above) and neither
  // is the link to a shared_tags row — matched by name instead. Nothing
  // stops sharing the same name twice (no unique constraint), so this
  // prefers whichever matching row is most recent.
  function sharedRowForTag(tag) {
    const matches = ui.myTagsShared.filter((r) => r.name === tag);
    if (!matches.length) return null;
    return matches.reduce((a, b) => (new Date(b.created_at) > new Date(a.created_at) ? b : a));
  }

  // ---------------------------------------------------------------------
  // Community: browse, tag detail, download
  // ---------------------------------------------------------------------

  async function openCommunity() {
    go("community");
    ui.communityLoading = true;
    render();
    const session = await getSessionSafe();
    if (!session) { ui.communityLoading = false; render(); return; }
    try {
      const { data: feed } = await sb.from("shared_tags").select("*").eq("status", "active").order("download_count", { ascending: false });
      ui.communityFeed = feed || [];
    } catch (e) {
      console.warn("loading Community failed (offline?)", e);
    }
    ui.communityLoading = false;
    render();
  }

  // Distinct back-languages actually present in the feed, plus "Any" —
  // avoids showing filter chips for languages nobody has shared in yet.
  function communityLangChips() {
    const present = new Set(ui.communityFeed.map((r) => r.back_language).filter(Boolean));
    return ["Any"].concat(BACK_LANGUAGES.filter((l) => present.has(l)));
  }

  function communityFilteredFeed() {
    const q = ui.communitySearch.trim().toLowerCase();
    return ui.communityFeed.filter((r) => {
      if (ui.communityLangFilter !== "Any" && r.back_language !== ui.communityLangFilter) return false;
      if (!q) return true;
      return r.name.toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q);
    });
  }

  // "Already added" is derived from the user's own current cards
  // rather than a "have you ever downloaded this" record — deleted_at
  // tombstones are never kept in data.cards (see syncNow()'s merge), so
  // this naturally goes back to false once every card from that source
  // has been deleted, matching what download_shared_tag() itself now
  // checks server-side before allowing a fresh re-add.
  function hasLocalCardsFrom(sharedTagId) {
    return data.cards.some((c) => c.sourceSharedTagId === sharedTagId);
  }

  async function openTagDetail(row) {
    // Every card, not just a preview slice — a partial list isn't
    // enough to judge whether a tag is actually worth downloading.
    ui.tagDetail = { row, previewCards: [], loading: true, reportOpen: false, reportReason: null, reportDetail: "", reportBusy: false, reportError: "", reportSubmitted: false };
    go("tagDetail");
    try {
      const { data: cards } = await sb.from("shared_tag_cards").select("front, back").eq("shared_tag_id", row.id).order("sort_order");
      if (ui.tagDetail && ui.tagDetail.row.id === row.id) ui.tagDetail.previewCards = cards || [];
    } catch (e) {
      console.warn("loading tag detail failed (offline?)", e);
    }
    if (ui.tagDetail && ui.tagDetail.row.id === row.id) ui.tagDetail.loading = false;
    render();
  }

  // A name collision with an existing local tag needs resolving before
  // download_shared_tag() can run — it takes the local tag name
  // up front and just writes straight into it, so a silent collision
  // would quietly merge someone else's deck into an unrelated tag.
  function startDownloadFlow(row) {
    const collision = browsableTags().includes(row.name);
    ui.downloadDraft = { row, name: collision ? row.name + " (" + row.owner_display_name + ")" : row.name, error: "", busy: false };
    render();
  }

  function closeDownloadDraft() {
    ui.downloadDraft = null;
    render();
  }

  async function submitDownload() {
    const d = ui.downloadDraft;
    const name = d.name.trim();
    if (!name || d.busy) return;
    if (browsableTags().includes(name)) { d.error = 'You already have a tag called "' + name + '". Choose a different name.'; render(); return; }
    d.busy = true;
    d.error = "";
    render();
    const { data: count, error } = await sb.rpc("download_shared_tag", { p_shared_tag_id: d.row.id, p_local_tag_name: name });
    d.busy = false;
    if (error) { d.error = error.message; render(); return; }
    ui.downloadDraft = null;
    render();
    await syncNow(); // pulls the newly-copied cards down into data.cards
    alert(count ? 'Added "' + name + '" — ' + count + " cards." : 'You already had this one — nothing new to add.');
  }

  // Pausing is a one-tap toggle — resuming isn't (see openReshareFlow
  // below): a paused tag's card selection may be stale, so bringing it
  // back goes through the full share flow instead of a plain confirm.
  async function toggleUnshareTag(row) {
    if (!confirm('Stop sharing "' + row.name + '"? People who already added it keep their copy.')) return;
    const { error } = await sb.from("shared_tags").update({ status: "unpublished" }).eq("id", row.id);
    if (error) { alert("Couldn't update sharing: " + error.message); return; }
    row.status = "unpublished";
    render();
  }

  function openRenameTagSheet(oldName) {
    ui.renameTagSheet = { oldName, newName: oldName };
    render();
  }

  function closeRenameTagSheet() {
    ui.renameTagSheet = null;
    render();
  }

  function submitRenameTag() {
    const s = ui.renameTagSheet;
    const newName = s.newName.trim();
    if (!newName || newName === s.oldName) { closeRenameTagSheet(); return; }
    if (browsableTags().includes(newName)) { alert('You already have a tag called "' + newName + '".'); return; }
    const affected = [];
    data.cards.forEach((c) => {
      if (c.tags.includes(s.oldName)) {
        c.tags = c.tags.map((t) => (t === s.oldName ? newName : t));
        c.updatedAt = Date.now();
        affected.push(c);
      }
    });
    if (ui.filter === s.oldName) ui.filter = "All";
    ui.renameTagSheet = null;
    saveData();
    render();
    pushCardsBulk(affected);
  }

  function openShareFlow(tagName) {
    const eligible = eligibleCardsForTag(tagName);
    ui.shareDraft = {
      tagName,
      selectedIds: eligible.map((c) => c.id),
      backLanguage: "English",
      description: "",
      busy: false,
      error: "",
      republishId: null,
      langSheetOpen: false,
    };
    go("shareTag");
  }

  // Resuming a paused tag: re-run the full share flow (fresh card
  // selection, editable description/language) pre-filled from what it
  // was shared with before, rather than reviving the old snapshot
  // untouched. republishId tells submitShareTag() to update this row
  // in place instead of creating a new shared_tags row.
  function openReshareFlow(tagName, row) {
    if (ui.myTagsFrozen) { alert("Sharing is paused on this account until " + formatFrozenUntil(ui.myTagsFrozenUntil) + ". Contact us if you think this is a mistake."); return; }
    const eligible = eligibleCardsForTag(tagName);
    ui.shareDraft = {
      tagName,
      selectedIds: eligible.map((c) => c.id),
      backLanguage: row.back_language || "English",
      description: row.description || "",
      busy: false,
      error: "",
      republishId: row.id,
      langSheetOpen: false,
    };
    go("shareTag");
  }

  function toggleShareCardSelected(id) {
    const d = ui.shareDraft;
    d.selectedIds = d.selectedIds.includes(id) ? d.selectedIds.filter((x) => x !== id) : d.selectedIds.concat(id);
    render();
  }

  function toggleShareSelectAll(eligibleIds) {
    const d = ui.shareDraft;
    const allSelected = eligibleIds.length > 0 && eligibleIds.every((id) => d.selectedIds.includes(id));
    d.selectedIds = allSelected ? [] : eligibleIds.slice();
    render();
  }

  async function submitShareTag() {
    const d = ui.shareDraft;
    if (d.busy || d.selectedIds.length < 50) return;
    d.busy = true;
    d.error = "";
    render();
    // share_tag() checks the server's own copy of these cards, not
    // whatever's local — a card added moments ago may not have finished
    // its own (separately async) push yet, which otherwise looks
    // identical to "not yours" from the RPC's point of view.
    const selectedCards = data.cards.filter((c) => d.selectedIds.includes(c.id));
    await pushCardsBulk(selectedCards);
    const { error } = d.republishId
      ? await sb.rpc("republish_shared_tag", {
          p_shared_tag_id: d.republishId,
          p_name: d.tagName,
          p_description: d.description.trim(),
          p_back_language: d.backLanguage,
          p_card_ids: d.selectedIds,
        })
      : await sb.rpc("share_tag", {
          p_name: d.tagName,
          p_description: d.description.trim(),
          p_back_language: d.backLanguage,
          p_card_ids: d.selectedIds,
        });
    d.busy = false;
    if (error) { d.error = error.message; render(); return; }
    const wasRepublish = !!d.republishId;
    ui.shareDraft = null;
    alert('"' + d.tagName + '" is ' + (wasRepublish ? "shared with the community again." : "now shared with the community."));
    openMyTags();
  }

  function toggleDraftTag(t) {
    const d = ui.draft;
    d.tags = d.tags.includes(t) ? d.tags.filter((x) => x !== t) : d.tags.concat(t);
    render();
  }

  function addNewTag() {
    const t = ui.draft.newTag.trim();
    if (t && !ui.draft.tags.includes(t)) ui.draft.tags = ui.draft.tags.concat(t);
    ui.draft.newTag = "";
    render();
  }

  function blankDraft() {
    return {
      editingId: null, front: "", romaji: "", kana: "", furigana: "", back: "", tags: [], newTag: "",
      audioMode: "system", recState: "idle", recSec: 0, recording: null,
      // Romaji auto-fill bookkeeping — see handleFrontBlur().
      // romajiAuto: current d.romaji was set by us and hasn't been hand-edited,
      // so the next auto-generation is free to silently replace it.
      romajiAuto: true,
      romajiSourceFront: "", // front text the last generation attempt used
      romajiSuggestion: null, // pending suggestion when romajiAuto is false
      romajiLoading: false,
    };
  }

  function openEditCard(card) {
    const isVoice = card.audio && card.audio.type === "voice" && card.audio.data;
    ui.draft = {
      editingId: card.id,
      front: card.front,
      romaji: card.romaji || "",
      kana: card.kana || "",
      furigana: card.furigana || "",
      back: card.back,
      tags: card.tags.slice(),
      newTag: "",
      audioMode: isVoice ? "record" : "system",
      recState: isVoice ? "done" : "idle",
      recSec: 0,
      recording: isVoice ? card.audio.data : null,
      // An existing card's romaji is never silently overwritten — editing
      // the front only ever surfaces a suggestion to accept or ignore.
      romajiAuto: false,
      romajiSourceFront: card.front,
      romajiSuggestion: null,
      romajiLoading: false,
    };
    ui.screen = "add";
    render();
  }

  function cancelCardForm() {
    ui.draft = blankDraft();
    go("browse");
  }

  // ---------------------------------------------------------------------
  // Auto-romaji: generated server-side (Vercel function, /api/romaji) so
  // the browser never runs the heavy tokenizer itself — that's what froze
  // the page the first time this was attempted client-side. Online only;
  // offline, the field just stays manual (see handleFrontBlur below).
  // ---------------------------------------------------------------------

  const JAPANESE_RE = /[぀-ヿ一-龯]/;

  // Returns { romaji, kana, furigana } — kana is the same
  // kuromoji-resolved reading as romaji, just in an unambiguous script.
  // It's never shown to the user; speak() uses it instead of raw front
  // text so the device's own TTS can't mispronounce a multi-reading
  // kanji that this conversion already resolved correctly (see speak()
  // below). furigana is pre-escaped, ready-to-render <ruby> HTML shown
  // above the sentence on the back of a review card (see furiganaNode()).
  async function generateRomaji(text) {
    try {
      const res = await fetch(API_BASE + "/api/romaji", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (typeof data.romaji !== "string") return null;
      return {
        romaji: data.romaji,
        kana: typeof data.kana === "string" ? data.kana : "",
        furigana: typeof data.furigana === "string" ? data.furigana : "",
      };
    } catch (e) {
      console.warn("romaji generation failed (offline?)", e);
      return null;
    }
  }

  // Cards created before kana/furigana existed (or added offline) never
  // got them — catch them up quietly, a few at a time, whenever a sync
  // completes. Sequential on purpose: this can run for a while on a
  // large, older collection, and there's no rush — better than bursting
  // many concurrent requests at the romaji endpoint.
  let backfillingReadings = false;
  async function backfillMissingReadings() {
    if (backfillingReadings) return;
    const targets = data.cards.filter((c) => (!c.kana || !c.furigana) && JAPANESE_RE.test(c.front));
    if (!targets.length) return;
    backfillingReadings = true;
    try {
      for (const c of targets) {
        if (!data.cards.includes(c)) continue; // deleted mid-backfill
        const result = await generateRomaji(c.front);
        if (!result || !result.kana) continue;
        c.kana = result.kana;
        c.furigana = result.furigana;
        c.updatedAt = Date.now();
        saveData();
        await pushCard(c);
      }
    } finally {
      backfillingReadings = false;
    }
  }

  async function handleFrontBlur() {
    flushRender(); // reconcile Save-button state etc. immediately on leaving the field
    const d = ui.draft;
    const front = d.front.trim();
    if (!front || front === d.romajiSourceFront) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;

    d.romajiSourceFront = front;
    if (!JAPANESE_RE.test(front)) return; // nothing to convert

    d.romajiLoading = true;
    render();
    const result = await generateRomaji(front);
    d.romajiLoading = false;

    // The user may have changed the front text again while we were
    // waiting — a stale result for old text shouldn't land anywhere.
    if (d.front.trim() !== front) { render(); return; }
    if (result === null) { render(); return; }

    // Unlike romaji, kana/furigana are never shown or hand-edited —
    // always take the fresh conversion for the current front text.
    d.kana = result.kana;
    d.furigana = result.furigana;

    if (d.romajiAuto) {
      d.romaji = result.romaji;
      d.romajiSuggestion = null;
    } else if (result.romaji !== d.romaji) {
      d.romajiSuggestion = result.romaji;
    }
    render();
  }

  function acceptRomajiSuggestion() {
    const d = ui.draft;
    if (!d.romajiSuggestion) return;
    d.romaji = d.romajiSuggestion;
    d.romajiAuto = true;
    d.romajiSuggestion = null;
    render();
  }

  function deleteCard() {
    const id = ui.draft.editingId;
    if (!id) return;
    const card = data.cards.find((c) => c.id === id);
    if (!card) return;
    if (!confirm('Delete this card? "' + card.front + '" — this can\'t be undone.')) return;
    data.cards = data.cards.filter((c) => c.id !== id);
    data.pendingDeletes.push(id);
    saveData();
    ui.draft = blankDraft();
    ui.screen = "browse";
    ui.filter = "All";
    ui.query = "";
    render();
    pushDeleteCard(id);
  }

  function saveCard() {
    const d = ui.draft;
    if (!d.front.trim() || !d.back.trim()) return;

    const front = d.front.trim();
    const romaji = d.romaji.trim();
    const kana = d.kana || "";
    const furigana = d.furigana || "";
    const tags = d.tags.length ? d.tags.slice() : [UNTAGGED_TAG];
    const audio = d.audioMode === "system"
      ? { type: "system" }
      : d.recording
        ? { type: "voice", data: d.recording }
        : null;

    let savedCard;
    if (d.editingId) {
      const card = data.cards.find((c) => c.id === d.editingId);
      if (card) {
        card.front = front;
        card.romaji = romaji;
        card.kana = kana;
        card.furigana = furigana;
        card.back = d.back.trim();
        card.tags = tags;
        card.audio = audio;
        card.updatedAt = Date.now();
      }
      savedCard = card;
    } else {
      savedCard = {
        id: "c-" + Date.now(),
        front,
        romaji,
        kana,
        furigana,
        back: d.back.trim(),
        tags: tags,
        stability: null,
        difficulty: null,
        reps: 0,
        lapses: 0,
        lastReviewAt: null,
        dueAt: Date.now(),
        audio,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      data.cards.unshift(savedCard);
    }
    saveData();
    const wasNewCard = !d.editingId;
    ui.draft = blankDraft();
    if (wasNewCard) {
      // Adding cards is usually a batch activity — stay put so the next
      // one can start right away instead of re-navigating back here.
      ui.cardSavedFlash = true;
      render();
      setTimeout(() => { ui.cardSavedFlash = false; render(); }, 1500);
    } else {
      ui.screen = "browse";
      ui.filter = "All";
      ui.query = "";
      render();
    }
    if (savedCard) pushCard(savedCard);
  }

  function openProfile() {
    ui.profileDraft = { username: data.profile.username, photo: data.profile.photo };
    ui.pwDraft = blankPasswordState();
    ui.avatarSheetOpen = false;
    go("profile");
  }

  function copySupportEmail() {
    const email = "support@japanesesentencecards.com";
    const flash = () => {
      ui.emailCopiedFlash = true;
      render();
      setTimeout(() => { ui.emailCopiedFlash = false; render(); }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(email).then(flash).catch(() => alert("Couldn't copy — email us at " + email));
    } else {
      alert("Email us at " + email);
    }
  }

  // No in-app browser plugin is installed — a plain external https link
  // is enough, since Capacitor's WKWebView already opens links outside
  // the app's own origin in the system browser by default.
  function openSupportPage() {
    window.open("https://japanesesentencecards.com/support.html", "_blank");
  }

  function cancelProfile() {
    go("home");
  }

  async function saveProfile() {
    data.profile = { username: ui.profileDraft.username.trim(), photo: ui.profileDraft.photo };
    saveData();
    go("home");
    const errorMessage = await pushProfile();
    if (errorMessage) alert("Couldn't save your profile to your account: " + errorMessage + "\nIt's saved on this device, but won't sync until this is resolved.");
  }

  async function changePassword() {
    const pw = ui.pwDraft;
    if (pw.busy) return;
    if (pw.password.length < 6) { pw.error = "Password must be at least 6 characters."; render(); return; }
    if (pw.password !== pw.confirm) { pw.error = "Passwords don't match."; render(); return; }
    pw.busy = true;
    pw.error = "";
    render();
    const { error } = await sb.auth.updateUser({ password: pw.password });
    pw.busy = false;
    if (error) {
      pw.error = error.message;
      render();
      return;
    }
    ui.pwDraft = blankPasswordState();
    render();
  }

  // Shared by an explicit "Log out" tap and by onAuthStateChange (which also
  // catches a session expiring, or another tab logging this browser out).
  function resetToAuthScreen() {
    data = makeSeedData();
    ui.auth = blankAuthState();
    ui.screen = "auth";
    render();
  }

  async function logOut() {
    if (!confirm("Log out?")) return;
    resetToAuthScreen();
    await sb.auth.signOut();
  }

  async function deleteAccount() {
    if (ui.deletingAccount) return;
    if (!confirm("Permanently delete your account? This removes your login and every card, tag, and review history you have. This cannot be undone.")) return;
    const session = await getSessionSafe();
    if (!session) { alert("You're not logged in."); return; }
    ui.deletingAccount = true;
    render();
    try {
      const res = await fetch(API_BASE + "/api/delete-account", {
        method: "POST",
        headers: { Authorization: "Bearer " + session.access_token },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to delete account");
      }
      resetToAuthScreen();
      await sb.auth.signOut();
    } catch (e) {
      alert("Couldn't delete your account: " + e.message + "\nPlease check your connection and try again.");
    } finally {
      ui.deletingAccount = false;
      render();
    }
  }

  // ---------------------------------------------------------------------
  // Auth screens (sign up + one-time email code, or log in)
  // ---------------------------------------------------------------------

  // Runs once there's a confirmed session: loads this user's cached data if
  // this browser already had it, otherwise starts from a clean slate, shows
  // the app immediately, then reconciles with the cloud in the background.
  async function enterApp(session) {
    const userId = session.user.id;
    const cached = loadData();
    if (cached.userId === userId) {
      data = cached;
    } else {
      data = makeSeedData();
      data.userId = userId;
      data.cards = []; // avoid flashing the example deck if this turns out to be a returning user
    }
    applyTheme();
    ui.screen = "home";
    render();
    await syncNow();
  }

  async function signUp() {
    const a = ui.auth;
    if (a.busy) return;
    const email = a.email.trim();
    if (!email || a.password.length < 6) { a.error = "Enter an email and a password of at least 6 characters."; render(); return; }
    a.busy = true;
    a.error = "";
    render();
    const { error } = await sb.auth.signUp({ email, password: a.password, options: { emailRedirectTo: APP_URL } });
    a.busy = false;
    if (error) { a.error = error.message; render(); return; }
    a.pendingEmail = email;
    // Keep the password (in memory only) — checkIfConfirmed() below uses it
    // as a fallback sign-in if the confirmation link redirects somewhere
    // that never hands the session back to this tab.
    a.mode = "verify";
    render();
  }

  // Signup confirmation is link-based: the email has a "Confirm email
  // address" link back to this same site. Clicking it (in any tab) lands
  // here with the session already established — supabase-js parses the
  // token straight out of the URL — so our boot check (or the
  // onAuthStateChange listener below) picks it up with no code to type.
  // This button is a manual fallback for whenever that doesn't fire: it
  // also tries signing in directly, since clicking the link confirms the
  // account server-side even if the redirect page itself failed to load.
  async function checkIfConfirmed() {
    const a = ui.auth;
    if (a.busy) return;
    a.busy = true;
    a.error = "";
    render();
    const session = await getSessionSafe();
    if (session) { a.busy = false; ui.auth = blankAuthState(); await enterApp(session); return; }
    const { data, error } = await sb.auth.signInWithPassword({ email: a.pendingEmail, password: a.password });
    a.busy = false;
    if (data && data.session) { ui.auth = blankAuthState(); await enterApp(data.session); return; }
    if (error && /confirm/i.test(error.message)) {
      a.error = "Not confirmed yet — open the link from the confirmation email first.";
    } else {
      a.error = "Not yet — open the link from the confirmation email first.";
    }
    render();
  }

  async function resendConfirmationEmail() {
    const a = ui.auth;
    if (a.busy) return;
    a.busy = true;
    a.error = "";
    render();
    const { error } = await sb.auth.resend({ type: "signup", email: a.pendingEmail });
    a.busy = false;
    a.error = error ? error.message : "Email resent — check your inbox.";
    render();
  }

  async function logIn() {
    const a = ui.auth;
    if (a.busy) return;
    const email = a.email.trim();
    if (!email || !a.password) { a.error = "Enter your email and password."; render(); return; }
    a.busy = true;
    a.error = "";
    render();
    const { data: result, error } = await sb.auth.signInWithPassword({ email, password: a.password });
    a.busy = false;
    if (error) { a.error = error.message; render(); return; }
    ui.auth = blankAuthState();
    await enterApp(result.session);
  }

  function switchAuthMode(mode) {
    ui.auth = blankAuthState();
    ui.auth.mode = mode;
    render();
  }

  async function requestPasswordReset() {
    const a = ui.auth;
    if (a.busy) return;
    const email = a.email.trim();
    if (!email) { a.error = "Enter your email."; render(); return; }
    a.busy = true;
    a.error = "";
    render();
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: APP_URL });
    a.busy = false;
    // Not an error path — reusing a.error just as the "status message" slot,
    // same as resendConfirmationEmail() does above.
    a.error = error ? error.message : "Reset link sent — check your inbox.";
    render();
  }

  // Reached via the PASSWORD_RECOVERY auth event (see onAuthStateChange at
  // the bottom of this file), not from switchAuthMode — clicking the emailed
  // reset link hands this tab a temporary "recovery" session, which is
  // enough for updateUser() to actually change the password.
  async function completePasswordReset() {
    const a = ui.auth;
    if (a.busy) return;
    if (a.password.length < 6) { a.error = "Password must be at least 6 characters."; render(); return; }
    if (a.password !== a.confirm) { a.error = "Passwords don't match."; render(); return; }
    a.busy = true;
    a.error = "";
    render();
    const { error } = await sb.auth.updateUser({ password: a.password });
    a.busy = false;
    if (error) { a.error = error.message; render(); return; }
    const session = await getSessionSafe();
    ui.auth = blankAuthState();
    if (session) await enterApp(session);
    else { ui.screen = "auth"; render(); }
  }

  function handlePhotoFile(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      ui.cropModal = { imgSrc: url, natW: img.naturalWidth, natH: img.naturalHeight, zoom: 1, offsetX: 0, offsetY: 0 };
      render();
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  // ---------------------------------------------------------------------
  // Photo crop modal — drag to reposition, slider to zoom, before it's
  // committed to ui.profileDraft.photo. Drag/zoom updates the DOM directly
  // (bypassing render(), which rebuilds the whole tree on every call) so
  // dragging stays smooth; render() only runs once the gesture ends.
  // ---------------------------------------------------------------------

  const CROP_FRAME = 260;
  const CROP_OUTPUT = 200;

  function cropLayout(m) {
    const baseScale = Math.max(CROP_FRAME / m.natW, CROP_FRAME / m.natH);
    const scale = baseScale * m.zoom;
    const width = m.natW * scale, height = m.natH * scale;
    const left = CROP_FRAME / 2 - width / 2 + m.offsetX;
    const top = CROP_FRAME / 2 - height / 2 + m.offsetY;
    return { left, top, width, height, baseScale };
  }

  function clampCropOffset(m, ox, oy) {
    const { width, height } = cropLayout(Object.assign({}, m, { offsetX: 0, offsetY: 0 }));
    const maxX = Math.max(0, (width - CROP_FRAME) / 2);
    const maxY = Math.max(0, (height - CROP_FRAME) / 2);
    return { offsetX: Math.min(maxX, Math.max(-maxX, ox)), offsetY: Math.min(maxY, Math.max(-maxY, oy)) };
  }

  function paintCropImg() {
    const m = ui.cropModal;
    if (!m) return;
    const el = document.querySelector('[data-field="cropImg"]');
    if (!el) return;
    const { left, top, width, height } = cropLayout(m);
    el.style.left = left + "px";
    el.style.top = top + "px";
    el.style.width = width + "px";
    el.style.height = height + "px";
  }

  function startCropDrag(e) {
    const m = ui.cropModal;
    if (!m) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startOffsetX = m.offsetX, startOffsetY = m.offsetY;
    function onMove(ev) {
      const c = clampCropOffset(m, startOffsetX + (ev.clientX - startX), startOffsetY + (ev.clientY - startY));
      m.offsetX = c.offsetX;
      m.offsetY = c.offsetY;
      paintCropImg();
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function onCropZoomInput(e) {
    const m = ui.cropModal;
    if (!m) return;
    m.zoom = Number(e.target.value);
    const c = clampCropOffset(m, m.offsetX, m.offsetY);
    m.offsetX = c.offsetX;
    m.offsetY = c.offsetY;
    paintCropImg();
  }

  function cancelCropModal() {
    if (ui.cropModal) URL.revokeObjectURL(ui.cropModal.imgSrc);
    ui.cropModal = null;
    render();
  }

  function confirmCropModal() {
    const m = ui.cropModal;
    if (!m) return;
    const img = document.querySelector('[data-field="cropImg"]');
    const k = CROP_OUTPUT / CROP_FRAME;
    const { left, top, width, height } = cropLayout(m);
    const canvas = document.createElement("canvas");
    canvas.width = CROP_OUTPUT;
    canvas.height = CROP_OUTPUT;
    canvas.getContext("2d").drawImage(img, left * k, top * k, width * k, height * k);
    ui.profileDraft.photo = canvas.toDataURL("image/jpeg", 0.85);
    URL.revokeObjectURL(m.imgSrc);
    ui.cropModal = null;
    render();
  }

  function screenCropModal() {
    const m = ui.cropModal;
    const { left, top, width, height } = cropLayout(m);
    return h(
      "div",
      { style: { position: "fixed", inset: "0", background: "rgba(20,20,19,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: "50", padding: "24px" } },
      h(
        "div",
        { style: { background: "var(--bg-page)", borderRadius: "20px", padding: "22px", width: "100%", maxWidth: "340px" } },
        h("div", { style: { fontSize: "15px", fontWeight: "500", color: "var(--text-primary)", textAlign: "center", marginBottom: "16px" } }, "Adjust photo"),
        h(
          "div",
          {
            style: { width: CROP_FRAME + "px", height: CROP_FRAME + "px", margin: "0 auto", borderRadius: "9999px", overflow: "hidden", position: "relative", background: "var(--bg-tint)", touchAction: "none", cursor: "grab" },
            onpointerdown: startCropDrag,
          },
          h("img", { "data-field": "cropImg", src: m.imgSrc, draggable: "false", style: { position: "absolute", left: left + "px", top: top + "px", width: width + "px", height: height + "px", pointerEvents: "none", userSelect: "none" } })
        ),
        h("input", {
          type: "range", min: "1", max: "3", step: "0.01", value: String(m.zoom),
          style: { width: "100%", marginTop: "18px" },
          oninput: onCropZoomInput,
        }),
        h(
          "div",
          { style: { display: "flex", gap: "12px", marginTop: "20px" } },
          h("div", { class: "tap", style: { flex: "1", padding: "13px", borderRadius: "12px", textAlign: "center", fontSize: "14px", color: "var(--text-secondary)", background: "var(--bg-tint)" }, onclick: cancelCropModal }, "Cancel"),
          h("div", { class: "tap", style: { flex: "1", padding: "13px", borderRadius: "12px", textAlign: "center", fontSize: "14px", fontWeight: "500", color: "var(--text-on-accent)", background: "var(--accent)" }, onclick: confirmCropModal }, "Use photo")
        )
      )
    );
  }

  // ---------------------------------------------------------------------
  // Small building blocks
  // ---------------------------------------------------------------------

  function avatarNode(profile, size) {
    const initial = profile.username && profile.username.trim() ? profile.username.trim()[0].toUpperCase() : null;
    const style = {
      width: size + "px", height: size + "px", borderRadius: "9999px", flexShrink: "0",
      display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
      background: profile.photo ? "transparent" : "var(--bg-tint)",
    };
    if (profile.photo) {
      style.backgroundImage = "url(" + profile.photo + ")";
      style.backgroundSize = "cover";
      style.backgroundPosition = "center";
      return h("div", { style });
    }
    if (initial) {
      return h("div", { style }, h("span", { style: { fontFamily: "var(--serif)", fontSize: Math.round(size * 0.45) + "px", color: "var(--accent)" } }, initial));
    }
    return h("div", { style }, icon('<path d="M20 21a8 8 0 10-16 0"/><circle cx="12" cy="8" r="5"/>', Math.round(size * 0.55), "var(--text-faint)"));
  }

  function chipStyle(on) {
    return on
      ? { background: "var(--surface-invert-bg)", border: "1px solid var(--surface-invert-bg)", color: "var(--surface-invert-text)" }
      : { background: "var(--bg-surface)", border: "1px solid var(--border-1)", color: "var(--text-primary)" };
  }

  function bottomNav(active) {
    const item = (screen, label, path, viewBox = "0 0 24 24") => {
      const on = active === screen;
      const wrap = h("div", {
        class: "tap",
        style: { flex: "1", display: "flex", flexDirection: "column", alignItems: "center", gap: "5px", color: on ? "var(--accent)" : "var(--text-secondary)" },
        onclick: screen === "community" ? openCommunity : () => go(screen),
      });
      const svgWrap = h("div");
      svgWrap.innerHTML = `<svg width="21" height="21" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
      wrap.appendChild(svgWrap.firstChild);
      wrap.appendChild(h("span", { style: { fontSize: "10.5px" } }, label));
      return wrap;
    };
    return h(
      "div",
      {
        style: {
          position: "sticky", bottom: "0", marginTop: "auto", display: "flex",
          background: "color-mix(in srgb, var(--bg-page) 92%, transparent)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
          borderTop: "1px solid var(--border-1)", padding: "9px 12px calc(env(safe-area-inset-bottom, 0px) + 18px)",
        },
      },
      item("home", "Review", '<path d="M3 10.5L12 3l9 7.5V21H3z"/>'),
      item("browse", "Cards", '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18"/>'),
      item("community", "Community", '<circle cx="9" cy="8" r="3.2"/><circle cx="17" cy="9.5" r="2.4"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6M16 13.2c2.2.2 3.8 1.7 4.3 4.1"/>')
    );
  }

  // ---------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------

  function logoMark() {
    const lineStyle = { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "var(--text-faint)" };
    return h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: "13px" } },
      h("div", { style: { width: "46px", height: "46px", flexShrink: "0", borderRadius: "13px", background: "var(--accent)", color: "var(--text-on-accent)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--serif)", fontSize: "15px", fontWeight: "600", letterSpacing: ".02em" } }, "JSC"),
      h(
        "div",
        {},
        h("div", { style: lineStyle }, "Japanese"),
        h("div", { style: Object.assign({}, lineStyle, { marginTop: "1px" }) }, "Sentence Card")
      )
    );
  }

  function screenBoot() {
    return h(
      "div",
      { style: { minHeight: "100%", background: "var(--bg-page)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "14px" } },
      logoMark(),
      h("div", { style: { fontSize: "13px", color: "var(--text-faint)" } }, "Loading…")
    );
  }

  function authField(dataField, type, value, placeholder, onInput) {
    return h("input", {
      "data-field": dataField, type, value, placeholder,
      style: { width: "100%", padding: "16px", background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "14px", fontSize: "15px", color: "var(--text-primary)" },
      // No render() on input, same as the app's other free-text fields —
      // it disrupted typing (autocorrect, key-repeat) even debounced. The
      // Log in/Create account button's enabled state only updates once
      // the user leaves the field (below), not on every keystroke.
      oninput: onInput,
      onblur: flushRender,
    });
  }

  function authButton(label, busyLabel, enabled, busy, onClick) {
    return h(
      "div",
      { class: enabled && !busy ? "tap" : "", style: { marginTop: "16px", padding: "16px", borderRadius: "14px", textAlign: "center", fontSize: "15px", fontWeight: "500", background: enabled ? "var(--accent)" : "var(--bg-tint)", color: enabled ? "var(--surface-invert-text)" : "var(--text-faint)" }, onclick: enabled && !busy ? onClick : null },
      busy ? busyLabel : label
    );
  }

  function screenAuth() {
    const a = ui.auth;

    const errorNode = a.error ? h("div", { style: { marginTop: "14px", fontSize: "13px", color: "var(--accent)", lineHeight: "1.5" } }, a.error) : null;

    let title, subtitle, body;

    if (a.mode === "verify") {
      title = "Check your email.";
      subtitle = "We sent a confirmation link to " + a.pendingEmail + ". Open it, then come back here and tap the button below — even if the link itself shows an error page, your account will already be confirmed and ready to use.";
      body = [
        authButton("I've confirmed — check again", "Checking…", true, a.busy, checkIfConfirmed),
        errorNode,
        h("div", { style: { marginTop: "18px", display: "flex", justifyContent: "space-between" } },
          h("div", { class: "tap", style: { fontSize: "13px", color: "var(--text-secondary)" }, onclick: () => switchAuthMode("signup") }, "Use a different email"),
          h("div", { class: "tap", style: { fontSize: "13px", color: "var(--accent)" }, onclick: resendConfirmationEmail }, "Resend email")
        ),
      ];
    } else if (a.mode === "forgot") {
      title = "Reset your password.";
      subtitle = "Enter your email and we'll send you a link to set a new password.";
      body = [
        authField("authEmail", "email", a.email, "Email", (e) => { a.email = e.target.value; }),
        authButton("Send reset link", "Sending…", !!a.email.trim(), a.busy, requestPasswordReset),
        errorNode,
        h("div", { style: { marginTop: "18px", textAlign: "center", fontSize: "13px", color: "var(--text-secondary)" } },
          h("span", { class: "tap", style: { color: "var(--accent)" }, onclick: () => switchAuthMode("login") }, "Back to log in")
        ),
      ];
    } else if (a.mode === "recover") {
      title = "Set a new password.";
      subtitle = "Choose a new password for your account.";
      body = [
        authField("authPassword", "password", a.password, "New password (min 6 characters)", (e) => { a.password = e.target.value; }),
        h("div", { style: { height: "10px" } }),
        authField("authConfirm", "password", a.confirm, "Confirm new password", (e) => { a.confirm = e.target.value; }),
        authButton("Set password", "Saving…", !!(a.password && a.confirm), a.busy, completePasswordReset),
        errorNode,
      ];
    } else if (a.mode === "signup") {
      title = "Create your account.";
      subtitle = "Your cards, tags and review history will sync to any device you log into.";
      body = [
        authField("authEmail", "email", a.email, "Email", (e) => { a.email = e.target.value; }),
        h("div", { style: { height: "10px" } }),
        authField("authPassword", "password", a.password, "Password (min 6 characters)", (e) => { a.password = e.target.value; }),
        authButton("Create account", "Creating…", !!(a.email.trim() && a.password), a.busy, signUp),
        errorNode,
        h("div", { style: { marginTop: "18px", textAlign: "center", fontSize: "13px", color: "var(--text-secondary)" } },
          "Already have an account? ",
          h("span", { class: "tap", style: { color: "var(--accent)" }, onclick: () => switchAuthMode("login") }, "Log in")
        ),
      ];
    } else {
      title = "Welcome back.";
      subtitle = "Log in to pick up right where you left off.";
      body = [
        authField("authEmail", "email", a.email, "Email", (e) => { a.email = e.target.value; }),
        h("div", { style: { height: "10px" } }),
        authField("authPassword", "password", a.password, "Password", (e) => { a.password = e.target.value; }),
        h("div", { style: { marginTop: "10px", textAlign: "right" } },
          h("span", { class: "tap", style: { fontSize: "12.5px", color: "var(--text-secondary)" }, onclick: () => switchAuthMode("forgot") }, "Forgot password?")
        ),
        authButton("Log in", "Logging in…", !!(a.email.trim() && a.password), a.busy, logIn),
        errorNode,
        h("div", { style: { marginTop: "18px", textAlign: "center", fontSize: "13px", color: "var(--text-secondary)" } },
          "New here? ",
          h("span", { class: "tap", style: { color: "var(--accent)" }, onclick: () => switchAuthMode("signup") }, "Create an account")
        ),
      ];
    }

    return h(
      "div",
      { style: { minHeight: "100%", background: "var(--bg-page)", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)" } },
      h("div", { style: { padding: "8px 20px 0" } }, logoMark()),
      h(
        "div",
        { style: { flex: "1", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 20px" } },
        h("div", { style: { fontFamily: "var(--serif)", fontSize: "28px", lineHeight: "1.15", color: "var(--text-primary)" } }, title),
        h("div", { style: { marginTop: "8px", fontSize: "14px", lineHeight: "1.6", color: "var(--text-secondary)" } }, subtitle),
        h("div", { style: { marginTop: "26px" } }, ...body)
      )
    );
  }

  function statTile(label, value) {
    return h(
      "div",
      { style: { background: "var(--bg-page)", borderRadius: "12px", padding: "13px 14px" } },
      h("div", { style: { fontSize: "10.5px", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--text-faint)" } }, label),
      h("div", { style: { marginTop: "6px", fontFamily: "var(--serif)", fontSize: "19px", color: "var(--text-primary)" } }, value)
    );
  }

  function screenHome() {
    const tags = allTags();
    const due = dueCards(null);
    const rangeDays = ACTIVITY_RANGE_DAYS[ui.activityRange];
    const weeks = heatmapWeeks(HEATMAP_DAYS); // heatmap always shows ~6 months; only the tiles respect the range toggle
    const maxCount = Math.max(1, ...weeks.flat().filter(Boolean).map((c) => c.count));

    const dueLine = due.length
      ? due.length + " cards are due across " + tags.filter((t) => dueCards([t]).length).length + " tags. Sessions run " + SESSION_SIZE + " cards at a time."
      : "Nothing due. Add a sentence you heard today.";

    return h(
      "div",
      { style: { minHeight: "100%", background: "var(--bg-page)", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)" } },

      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 20px 14px" } },
        logoMark(),
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "10px" } },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "6px", padding: "5px 11px 5px 9px", borderRadius: "9999px", background: "var(--bg-surface)", border: "1px solid var(--border-1)", fontSize: "12px", color: "var(--text-secondary)" } },
            icon('<path d="M8.5 14.5A2.5 2.5 0 0011 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 11-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 002.5 2.5z"/>', 13, "var(--accent)"),
            h("b", { style: { fontWeight: "600", color: "var(--text-primary)" } }, String(streakDays())), " days"
          ),
          h("div", { class: "tap", style: { borderRadius: "9999px", border: "1px solid var(--border-1)" }, onclick: openProfile }, avatarNode(data.profile, 30))
        )
      ),

      h(
        "div",
        { style: { padding: "6px 20px 0" } },
        h("div", { style: { fontFamily: "var(--serif)", fontSize: "30px", lineHeight: "1.15", color: "var(--text-primary)", letterSpacing: "-.2px" } }, data.profile.username && data.profile.username.trim() ? "Ready for today, " + data.profile.username.trim() + "." : "Ready for today."),
        h("div", { style: { marginTop: "8px", fontSize: "14px", lineHeight: "1.6", color: "var(--text-secondary)" } }, dueLine)
      ),

      h(
        "div",
        { style: { margin: "20px 20px 0", padding: "20px", background: "#141413", borderRadius: "20px" } },
        h(
          "div",
          {},
          h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "#b0aea5" } }, "Due now"),
          h(
            "div",
            { style: { marginTop: "6px", display: "flex", alignItems: "baseline", gap: "7px" } },
            h("span", { style: { fontFamily: "var(--serif)", fontSize: "42px", lineHeight: "1", color: "#faf9f5" } }, String(due.length)),
            h("span", { style: { fontSize: "13px", color: "#b0aea5" } }, "cards")
          )
        ),
        h(
          "div",
          { style: { marginTop: "16px", display: "flex", gap: "9px" } },
          h(
            "div",
            {
              class: due.length ? "tap" : "",
              style: { flex: "1", padding: "13px 16px", borderRadius: "12px", background: due.length ? "#c96442" : "rgba(250,249,245,.06)", color: due.length ? "#faf9f5" : "#b0aea5", fontSize: "14px", fontWeight: "500", textAlign: "center" },
              onclick: due.length ? () => beginSession([]) : null,
            },
            "Review all"
          ),
          h(
            "div",
            { class: "tap", style: { flex: "1", padding: "13px 16px", borderRadius: "12px", background: "rgba(250,249,245,.08)", border: "1px solid rgba(250,249,245,.14)", color: "#faf9f5", fontSize: "14px", fontWeight: "500", textAlign: "center" }, onclick: () => { ui.sel = []; go("tags"); } },
            "By tags"
          )
        ),
        !due.length && data.cards.length
          ? h(
              "div",
              { class: "tap", style: { marginTop: "12px", textAlign: "center", fontSize: "12.5px", color: "#b0aea5" }, onclick: () => beginSession([], true) },
              "Nothing due — practice anyway →"
            )
          : null
      ),

      h(
        "div",
        { style: { margin: "24px 20px 0", padding: "18px", background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "18px" } },

        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
          h("div", { style: { fontFamily: "var(--serif)", fontSize: "17px", color: "var(--text-primary)" } }, "Activity"),
          h(
            "div",
            { style: { display: "flex", gap: "4px", background: "var(--bg-tint)", padding: "3px", borderRadius: "9999px" } },
            ...[["all", "All"], ["30d", "30d"], ["7d", "7d"]].map(([key, label]) => {
              const on = ui.activityRange === key;
              return h(
                "div",
                { class: "tap", style: { padding: "5px 11px", borderRadius: "9999px", fontSize: "12px", fontWeight: on ? "600" : "400", background: on ? "var(--surface-invert-bg)" : "transparent", color: on ? "var(--surface-invert-text)" : "var(--text-secondary)" }, onclick: () => { ui.activityRange = key; render(); } },
                label
              );
            })
          )
        ),

        h(
          "div",
          { style: { marginTop: "14px", display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "8px" } },
          statTile("Cards", String(cardsAddedInLastDays(rangeDays))),
          statTile("Reviewed", String(cardsReviewedInLastDays(rangeDays))),
          statTile("Active days", String(activeDaysInLastDays(rangeDays))),
          statTile("Current streak", streakDays() + "d"),
          statTile("Longest streak", longestStreak() + "d"),
          statTile("Time in app", formatDuration(activeMsInLastDays(rangeDays)))
        ),

        h("div", { style: { marginTop: "14px", fontSize: "12px", color: "var(--text-secondary)" } }, heatmapTipText(ui.heatmapTip)),

        h(
          "div",
          { class: "scrollx", "data-remember-scroll": "home-heatmap", "data-scroll-to-end": "true", style: { marginTop: "8px", alignItems: "flex-start" } },
          ...weeks.map((week) =>
            h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "3px", flexShrink: "0" } },
              ...week.map((cell) =>
                h("div", {
                  style: {
                    width: "10px", height: "10px", borderRadius: "2px",
                    background: cell ? HEAT_COLORS[heatLevel(cell.count, maxCount)] : "transparent",
                    cursor: cell ? "pointer" : "default",
                  },
                  onmouseenter: cell ? () => { ui.heatmapTip = { key: cell.key, count: cell.count }; render(); } : null,
                  onmouseleave: cell ? () => { ui.heatmapTip = null; render(); } : null,
                  onclick: cell ? () => {
                    ui.heatmapTip = (ui.heatmapTip && ui.heatmapTip.key === cell.key) ? null : { key: cell.key, count: cell.count };
                    render();
                  } : null,
                })
              )
            )
          )
        )
      ),

      h("div", { style: { height: "24px" } }),

      bottomNav("home")
    );
  }

  function screenTags() {
    const tags = browsableTags();
    const due = dueCards(null).length;
    const selDue = dueCards(ui.sel).length;
    const n = Math.min(selDue, SESSION_SIZE);
    const practiceN = Math.min(cardsMatchingTags(ui.sel).length, SESSION_SIZE);

    return h(
      "div",
      { style: { minHeight: "100%", background: "var(--bg-page)", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)" } },

      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "10px", padding: "8px 20px 0" } },
        h("div", { class: "tap", style: { width: "34px", height: "34px", borderRadius: "10px", background: "var(--bg-surface)", border: "1px solid var(--border-1)", display: "flex", alignItems: "center", justifyContent: "center" }, onclick: () => go("home") }, icon('<path d="M19 12H5M12 19l-7-7 7-7"/>', 16, "var(--text-primary)")),
        h("div", { style: { fontSize: "13px", color: "var(--text-secondary)" } }, "Step 1 of 2")
      ),

      h(
        "div",
        { style: { padding: "18px 20px 0" } },
        h("div", { style: { fontFamily: "var(--serif)", fontSize: "28px", lineHeight: "1.15", color: "var(--text-primary)" } }, "Which tags today?"),
        h("div", { style: { marginTop: "8px", fontSize: "14px", lineHeight: "1.6", color: "var(--text-secondary)" } }, "Pick one or several. Only cards that are due in those tags enter the session.")
      ),

      h(
        "div",
        { style: { margin: "20px 20px 0", display: "flex", flexWrap: "wrap", gap: "9px" } },
        ...tags.map((t) => {
          const on = ui.sel.includes(t);
          return h(
            "div",
            { class: "tap chip", style: Object.assign({ display: "flex", alignItems: "center", gap: "9px", padding: "11px 15px", borderRadius: "9999px" }, chipStyle(on)), onclick: () => toggleTagSel(t) },
            h("span", { style: { fontSize: "14px" } }, t),
            h("span", { style: { fontSize: "11.5px", color: on ? "color-mix(in srgb, var(--surface-invert-text) 60%, transparent)" : "var(--text-faint)" } }, dueCards([t]).length + " due")
          );
        })
      ),

      h(
        "div",
        { style: { margin: "24px 20px 0", padding: "16px 18px", background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "14px" } },
        h(
          "div",
          { style: { fontSize: "12px", color: "var(--text-secondary)", lineHeight: "1.6" } },
          ui.sel.length
            ? ui.sel.join(" · ") + " — " + selDue + " cards due, " + n + " in this session."
            : "No tags picked yet. Leave it empty to review everything due (" + due + " cards)."
        )
      ),

      h("div", { style: { flex: "1" } }),

      h(
        "div",
        { style: { position: "sticky", bottom: "0", padding: "14px 20px calc(env(safe-area-inset-bottom, 0px) + 22px)", background: "color-mix(in srgb, var(--bg-page) 94%, transparent)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", borderTop: "1px solid var(--border-1)" } },
        n
          ? h(
              "div",
              { class: "tap", style: { padding: "16px", borderRadius: "14px", textAlign: "center", fontSize: "15px", fontWeight: "500", background: "var(--accent)", color: "var(--text-on-accent)" }, onclick: () => beginSession(ui.sel) },
              "Review " + n + " cards"
            )
          : practiceN
            ? h(
                "div",
                { class: "tap", style: { padding: "16px", borderRadius: "14px", textAlign: "center", fontSize: "15px", fontWeight: "500", background: "var(--surface-invert-bg)", color: "var(--surface-invert-text)" }, onclick: () => beginSession(ui.sel, true) },
                "Nothing due — practice " + practiceN + " anyway"
              )
            : h(
                "div",
                { style: { padding: "16px", borderRadius: "14px", textAlign: "center", fontSize: "15px", fontWeight: "500", background: "var(--bg-tint)", color: "var(--text-faint)" } },
                "No cards in these tags"
              )
      )
    );
  }


  function screenReview() {
    const s = ui.session;
    const c = currentCard();
    // Real progress only advances on an actual grade now that flipping
    // is free-form (toggling it back and forth shouldn't move the bar).
    const progressPct = Math.round((s.qi / Math.max(1, s.queue.length)) * 100);

    const audioRow = h(
      "div",
      { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" } },
      h(
        "div",
        { class: "tap", style: { display: "flex", alignItems: "center", gap: "11px", padding: "10px 16px 10px 12px", borderRadius: "9999px", background: "#f5f4ed", border: "1px solid #f0eee6" }, onclick: (e) => { e.stopPropagation(); playCardAudio(c); } },
        icon('<path d="M8 5l11 7-11 7z"/>', 16, "#c96442"),
        h("span", { style: { fontSize: "11.5px", color: "#5e5d59" } }, c.audio && c.audio.type === "voice" ? "your voice" : "play audio")
      ),
      h("div", { style: { fontSize: "12px", color: "#b0aea5" } }, "Tap to flip")
    );

    // The card itself is the flip control — tap either face to see the
    // other, as many times as you like, before grading.
    const flipZone = h(
      "div",
      { class: "tap", style: { marginTop: "18px", flex: "1", background: "#faf9f5", borderRadius: "28px", padding: "34px 26px", display: "flex", flexDirection: "column", boxShadow: "0 4px 24px rgba(0,0,0,.28)" }, onclick: flipCard },
      !s.flipped
        ? h(
            "div",
            { class: "anim-in", style: { flex: "1", display: "flex", flexDirection: "column", justifyContent: "center" } },
            h("div", { style: { fontFamily: "var(--jp)", fontSize: "29px", lineHeight: "1.5", color: "#141413" } }, c.front)
          )
        : h(
            "div",
            { class: "anim-in", style: { display: "flex", flexDirection: "column", flex: "1" } },
            h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "7px", paddingBottom: "18px", borderBottom: "1px solid #f0eee6" } },
              furiganaNode(c, { fontFamily: "var(--jp)", fontSize: "16px", lineHeight: "2.3", color: "#5e5d59" }),
              c.romaji ? h("div", { style: { fontSize: "12.5px", color: "#87867f", letterSpacing: ".2px" } }, c.romaji) : null
            ),
            h("div", { style: { flex: "1", display: "flex", alignItems: "center" } }, h("div", { style: { fontFamily: "var(--serif)", fontSize: "26px", lineHeight: "1.35", color: "#141413" } }, c.back))
          ),
      audioRow
    );

    return h(
      "div",
      { style: { minHeight: "100%", background: "#141413", display: "flex", flexDirection: "column", padding: "calc(env(safe-area-inset-top, 0px) + 30px) 20px 34px" } },

      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "14px" } },
        h("div", { class: "tap", style: { width: "30px", height: "30px", borderRadius: "9999px", background: "rgba(250,249,245,.08)", display: "flex", alignItems: "center", justifyContent: "center" }, onclick: () => go("home") }, icon('<path d="M18 6L6 18M6 6l12 12"/>', 14, "#faf9f5")),
        h("div", { style: { flex: "1", height: "4px", borderRadius: "9999px", background: "rgba(250,249,245,.13)", overflow: "hidden" } }, h("div", { style: { height: "100%", background: "#c96442", width: progressPct + "%" } })),
        h("div", { style: { fontSize: "12px", color: "#b0aea5", fontVariantNumeric: "tabular-nums" } }, (s.qi + 1) + " / " + s.queue.length)
      ),

      h(
        "div",
        { style: { marginTop: "28px", display: "flex", flexWrap: "wrap", gap: "7px" } },
        s.practice ? h("div", { style: { padding: "5px 11px", borderRadius: "9999px", background: "rgba(201,100,66,.18)", color: "#d97757", fontSize: "11px" } }, "practice — not due yet") : null,
        ...s.tags.map((t) => h("div", { style: { padding: "5px 11px", borderRadius: "9999px", background: "rgba(250,249,245,.08)", color: "#b0aea5", fontSize: "11px" } }, t))
      ),

      flipZone,

      h(
        "div",
        { style: { marginTop: "16px", display: "flex", gap: "9px" } },
        h(
          "div",
          { class: "tap", style: { flex: "1", padding: "16px 8px", borderRadius: "14px", textAlign: "center", background: "rgba(250,249,245,.06)", border: "1px solid rgba(250,249,245,.16)" }, onclick: () => answerCard(false) },
          h("div", { style: { fontSize: "14.5px", fontWeight: "500", color: "#faf9f5" } }, "Didn't remember")
        ),
        h(
          "div",
          { class: "tap", style: { flex: "1", padding: "16px 8px", borderRadius: "14px", textAlign: "center", background: "#c96442", border: "1px solid #c96442" }, onclick: () => answerCard(true) },
          h("div", { style: { fontSize: "14.5px", fontWeight: "500", color: "#faf9f5" } }, "Remembered")
        )
      )
    );
  }

  function screenDone() {
    const s = ui.session;
    return h(
      "div",
      { style: { minHeight: "100%", background: "#141413", display: "flex", flexDirection: "column", padding: "calc(env(safe-area-inset-top, 0px) + 56px) 24px 40px" } },
      h("div", { style: { fontFamily: "var(--serif)", fontSize: "32px", lineHeight: "1.15", color: "#faf9f5" } }, "Session complete."),
      h("div", { style: { marginTop: "10px", fontSize: "14px", lineHeight: "1.6", color: "#b0aea5" } }, s.queue.length + " cards reviewed from " + s.tags.join(" · ") + "."),
      h(
        "div",
        { style: { marginTop: "30px", display: "flex", flexShrink: "0", flexDirection: "column", gap: "1px", background: "rgba(250,249,245,.1)", borderRadius: "16px", overflow: "hidden" } },
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", background: "#1a1a18" } }, h("span", { style: { fontSize: "13.5px", color: "#b0aea5" } }, "Didn't remember"), h("span", { style: { fontFamily: "var(--serif)", fontSize: "19px", color: "#d97757" } }, String(s.results.again))),
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", background: "#1a1a18" } }, h("span", { style: { fontSize: "13.5px", color: "#b0aea5" } }, "Remembered"), h("span", { style: { fontFamily: "var(--serif)", fontSize: "19px", color: "#faf9f5" } }, String(s.results.good)))
      ),
      h(
        "div",
        { style: { marginTop: "26px", fontSize: "12.5px", lineHeight: "1.7", color: "#5e5d59" } },
        "Cards you didn't remember come back for a quick retry soon. The rest are scheduled by FSRS based on how well you know each one — " + dueCards(null).length + " cards still due today."
      ),
      h("div", { style: { flex: "1" } }),
      h("div", { class: "tap", style: { padding: "16px", borderRadius: "14px", textAlign: "center", background: "#c96442", color: "#faf9f5", fontSize: "15px", fontWeight: "500" }, onclick: () => go("home") }, "Back to today"),
      h("div", { class: "tap", style: { marginTop: "10px", padding: "16px", borderRadius: "14px", textAlign: "center", border: "1px solid rgba(250,249,245,.16)", color: "#faf9f5", fontSize: "15px" }, onclick: () => { ui.sel = []; go("tags"); } }, "Review other tags")
    );
  }

  const UNTAGGED_TAG = "Untagged"; // automatic fallback so a card is never left with zero tags
  const RECENT_TAG = "Recently added";
  const RECENT_MS = 7 * 86400000;

  // What language the *back* of a shared tag's cards is written in — a
  // real, specific language, since every card in a tag is actually in
  // one. ("Any" belongs on the future community browse *filter*, not
  // here — a tag itself is never actually in "any" language.)
  const BACK_LANGUAGES = [
    "English", "Chinese (Simplified)", "Chinese (Traditional)", "Korean",
    "Spanish", "French", "German", "Portuguese", "Italian", "Russian",
    "Vietnamese", "Thai", "Indonesian", "Arabic", "Hindi", "Turkish",
    "Polish", "Dutch", "Filipino/Tagalog", "Other",
  ];

  function screenBrowse() {
    const tags = browsableTags();
    const q = ui.query.trim().toLowerCase();
    const list = data.cards.filter((x) => {
      const okQ = !q || x.front.toLowerCase().includes(q) || x.back.toLowerCase().includes(q) || x.tags.join(" ").toLowerCase().includes(q);
      const okFilter = ui.filter === "All"
        || (ui.filter === RECENT_TAG ? Date.now() - x.createdAt <= RECENT_MS : x.tags.includes(ui.filter));
      return okQ && okFilter;
    }).sort((a, b) => b.createdAt - a.createdAt);

    if (ui.selectMode) return screenBrowseSelect(list);

    return h(
      "div",
      { style: { minHeight: "100%", background: "var(--bg-page)", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)", position: "relative" } },

      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 20px 0" } },
        h("div", { style: { fontFamily: "var(--serif)", fontSize: "28px", color: "var(--text-primary)" } }, "Cards"),
        h("div", { class: "tap", style: { width: "36px", height: "36px", borderRadius: "18px", background: "var(--surface-invert-bg)", display: "flex", alignItems: "center", justifyContent: "center" }, onclick: () => go("add") }, icon('<path d="M12 5v14M5 12h14"/>', 18, "var(--surface-invert-text)"))
      ),

      h(
        "div",
        { style: { margin: "14px 20px 0", display: "flex", alignItems: "center", gap: "10px", padding: "11px 14px", background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "12px" } },
        icon('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4.5-4.5"/>', 15, "var(--text-faint)"),
        h("input", { "data-field": "query", value: ui.query, placeholder: "Search sentence, note or tag", style: { flex: "1", border: "none", outline: "none", background: "transparent", fontSize: "14px", color: "var(--text-primary)" }, oninput: (e) => { ui.query = e.target.value; if (!e.isComposing) scheduleRender(); }, onblur: flushRender })
      ),

      h(
        "div",
        { class: "scrollx", "data-remember-scroll": "browse-filters", style: { margin: "14px 0 0", padding: "0 20px" } },
        ...["All", RECENT_TAG].concat(tags).map((f) => {
          const on = ui.filter === f;
          const chip = h("div", { class: "tap chip", style: Object.assign({ padding: "8px 14px", borderRadius: "9999px", fontSize: "12.5px", whiteSpace: "nowrap" }, chipStyle(on)), onclick: () => { ui.filter = f; render(); } }, f);
          const deletable = on && f !== "All" && f !== RECENT_TAG && f !== UNTAGGED_TAG;
          if (!deletable) return chip;
          return h(
            "div",
            { style: { position: "relative", flexShrink: "0" } },
            chip,
            h(
              "div",
              { class: "tap", style: { position: "absolute", right: "-4px", top: "-4px", width: "16px", height: "16px", borderRadius: "8px", background: "var(--bg-page)", border: "1px solid var(--border-2b)", display: "flex", alignItems: "center", justifyContent: "center" }, onclick: (e) => { e.stopPropagation(); openDeleteTagSheet(f); } },
              icon('<path d="M6 6l12 12M18 6 6 18"/>', 8, "var(--text-secondary)", { "stroke-width": "3.4" })
            )
          );
        })
      ),

      h(
        "div",
        { style: { margin: "16px 20px 0", display: "flex", alignItems: "center", justifyContent: "space-between" } },
        h("span", { style: { fontSize: "11.5px", color: "var(--text-faint)" } }, list.length + " of " + data.cards.length + " cards"),
        list.length ? h("div", { class: "tap", style: { fontSize: "14px", fontWeight: "500", color: "var(--accent)" }, onclick: enterSelectMode }, "Select") : null
      ),

      h(
        "div",
        { style: { margin: "10px 20px 0", display: "flex", flexDirection: "column", gap: "8px" } },
        ...list.map((c) =>
          h(
            "div",
            { class: "tap row-hover", style: { padding: "15px 16px", background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "12px" }, onclick: () => openEditCard(c) },
            h(
              "div",
              { style: { display: "flex", alignItems: "flex-start", gap: "12px" } },
              h(
                "div",
                { style: { flex: "1", minWidth: "0" } },
                h("div", { style: { fontFamily: "var(--jp)", fontSize: "16px", lineHeight: "1.5", color: "var(--text-primary)" } }, c.front),
                h("div", { style: { marginTop: "5px", fontSize: "13px", color: "var(--text-secondary)" } }, c.back)
              ),
              c.audio
                ? h("div", { class: "tap", style: { width: "30px", height: "30px", borderRadius: "9999px", background: "var(--bg-page)", border: "1px solid var(--border-1)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: "0" }, onclick: (e) => { e.stopPropagation(); playCardAudio(c); } }, icon('<path d="M8 5l11 7-11 7z"/>', 12, "var(--accent)"))
                : icon('<path d="M9 18l6-6-6-6"/>', 15, "var(--text-faintest)", { style: "flex-shrink:0;margin-top:7px" })
            ),
            h(
              "div",
              { style: { marginTop: "11px", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
              ...c.tags.map((t) => h("div", { style: { padding: "4px 9px", borderRadius: "9999px", background: "var(--bg-tint)", color: "var(--text-secondary)", fontSize: "10.5px" } }, t)),
              h(
                "div",
                { style: { marginLeft: "auto" } },
                h("span", { style: { fontSize: "10.5px", color: c.dueAt <= Date.now() ? "var(--accent)" : "var(--text-faint)" } }, dueLabel(c))
              )
            )
          )
        )
      ),
      h("div", { style: { height: "24px" } }),

      bottomNav("browse"),

      ui.deleteTagSheet ? deleteTagSheetNode() : null
    );
  }

  function screenBrowseSelect(list) {
    const ids = list.map((c) => c.id);
    const allSelected = ids.length > 0 && ids.every((id) => ui.selectedIds.includes(id));
    const n = ui.selectedIds.length;

    return h(
      "div",
      { style: { minHeight: "100%", background: "var(--bg-page)", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)", position: "relative" } },

      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 20px 0" } },
        h("div", { class: "tap", style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "15.5px", color: "var(--text-secondary)" }, onclick: exitSelectMode }, icon('<path d="M15 18l-6-6 6-6"/>', 15, "var(--text-secondary)"), "Cards"),
        h("div", { class: "tap", style: { fontSize: "15px", color: "var(--text-secondary)" }, onclick: exitSelectMode }, "Cancel")
      ),

      h(
        "div",
        { style: { padding: "16px 20px 0", display: "flex", flexDirection: "column", gap: "5px" } },
        h("span", { style: { fontSize: "10.5px", letterSpacing: ".09em", textTransform: "uppercase", color: "var(--text-faint)" } }, "Select cards"),
        h("div", { style: { fontFamily: "var(--serif)", fontSize: "26px", fontWeight: "500", color: "var(--text-primary)" } }, ui.filter === "All" ? "All cards" : ui.filter)
      ),

      h(
        "div",
        { style: { margin: "14px 20px 0", display: "flex", alignItems: "center", justifyContent: "space-between" } },
        h(
          "div",
          { class: "tap chip", style: Object.assign({ display: "flex", alignItems: "center", gap: "7px", height: "32px", padding: "0 14px", borderRadius: "9999px", fontSize: "13.5px", fontWeight: "500" }, chipStyle(allSelected)), onclick: () => toggleSelectAll(ids) },
          allSelected ? icon('<path d="m5 13 4.5 4.5L19 7"/>', 13, "var(--surface-invert-text)", { "stroke-width": "2.6" }) : null,
          "All " + ids.length + " cards"
        ),
        h("span", { style: { fontSize: "12px", color: "var(--text-muted)" } }, n + " of " + ids.length + " selected")
      ),

      h(
        "div",
        { style: { flex: "1", overflow: "auto", margin: "14px 20px 0", display: "flex", flexDirection: "column", gap: "8px" } },
        ...list.map((c) => {
          const checked = ui.selectedIds.includes(c.id);
          return h(
            "div",
            { class: "tap", style: { display: "flex", alignItems: "center", gap: "13px", padding: "14px 16px", background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "12px" }, onclick: () => toggleCardSelected(c.id) },
            h(
              "div",
              { style: { width: "21px", height: "21px", borderRadius: "9999px", flexShrink: "0", display: "flex", alignItems: "center", justifyContent: "center", background: checked ? "var(--accent)" : "transparent", border: checked ? "none" : "1.6px solid var(--text-faintest)" } },
              checked ? icon('<path d="m5 13 4.5 4.5L19 7"/>', 11, "var(--text-on-accent)", { "stroke-width": "3.4" }) : null
            ),
            h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "5px", minWidth: "0" } },
              h("span", { style: { fontFamily: "var(--jp)", fontSize: "16px", color: "var(--text-primary)" } }, c.front),
              h("span", { style: { fontSize: "13px", color: "var(--text-secondary)" } }, c.back)
            )
          );
        })
      ),

      h(
        "div",
        { style: { padding: "14px 20px calc(env(safe-area-inset-bottom, 0px) + 18px)", display: "flex", gap: "10px" } },
        h("div", { class: n ? "tap" : "", style: { flex: "1", padding: "16px", borderRadius: "9999px", textAlign: "center", fontSize: "15.5px", fontWeight: "500", background: n ? "var(--surface-invert-bg)" : "var(--bg-tint)", color: n ? "var(--surface-invert-text)" : "var(--text-faint)" }, onclick: n ? openBulkTagSheet : null }, "Add tag"),
        h("div", { class: n ? "tap" : "", style: { width: "112px", flexShrink: "0", padding: "16px", borderRadius: "9999px", textAlign: "center", fontSize: "15.5px", fontWeight: "500", background: "var(--bg-surface)", border: "1px solid var(--border-2b)", color: n ? "var(--danger)" : "#e0b3b3" }, onclick: n ? bulkDeleteSelected : null }, "Delete")
      ),

      ui.bulkTagSheet ? bulkTagSheetNode() : null
    );
  }

  function bulkTagSheetNode() {
    const s = ui.bulkTagSheet;
    const allTagsList = browsableTags().filter((t) => t !== UNTAGGED_TAG);
    const q = s.query.trim().toLowerCase();
    const filtered = q ? allTagsList.filter((t) => t.toLowerCase().includes(q)) : allTagsList;
    const isNew = s.query.trim() && !allTagsList.some((t) => t.toLowerCase() === s.query.trim().toLowerCase()) && !s.checked.includes(s.query.trim());
    const pendingNew = s.checked.filter((t) => !allTagsList.includes(t));

    return h(
      "div",
      { style: { position: "absolute", inset: "0", background: "rgba(20,20,19,.34)", display: "flex", flexDirection: "column", justifyContent: "flex-end", zIndex: "20" }, onclick: closeBulkTagSheet },
      h(
        "div",
        { style: { background: "var(--bg-surface)", borderRadius: "24px 24px 0 0", padding: "20px 20px 24px", display: "flex", flexDirection: "column", gap: "14px", maxHeight: "82%", overflow: "auto" }, onclick: (e) => e.stopPropagation() },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
          h("span", { style: { fontFamily: "var(--serif)", fontSize: "19px", fontWeight: "500" } }, "Add tag to " + ui.selectedIds.length + " card" + (ui.selectedIds.length === 1 ? "" : "s")),
          h("span", { class: "tap", style: { fontSize: "14px", color: "var(--text-secondary)" }, onclick: closeBulkTagSheet }, "Cancel")
        ),
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "9px", padding: "11px 14px", background: "var(--bg-page)", border: "1px solid var(--border-2b)", borderRadius: "12px" } },
          icon('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4.5-4.5"/>', 15, "var(--text-muted)"),
          h("input", { "data-field": "bulkTagQuery", value: s.query, placeholder: "Find or create a tag", style: { flex: "1", border: "none", outline: "none", background: "transparent", fontSize: "14.5px", color: "var(--text-primary)" }, oninput: (e) => { s.query = e.target.value; if (!e.isComposing) scheduleRender(); }, onblur: flushRender })
        ),
        pendingNew.length
          ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px" } }, ...pendingNew.map((t) => h("div", { class: "tap chip", style: Object.assign({ padding: "8px 13px", borderRadius: "9999px", fontSize: "13px", display: "flex", alignItems: "center", gap: "7px" }, chipStyle(true)), onclick: () => toggleBulkTagChecked(t) }, t, icon('<path d="M18 6L6 18M6 6l12 12"/>', 10, "var(--surface-invert-text)"))))
          : null,
        filtered.length
          ? h(
              "div",
              { style: { background: "var(--bg-page)", borderRadius: "16px", overflow: "hidden" } },
              ...filtered.map((t, i) => h(
                "div",
                {},
                i ? h("div", { style: { height: "1px", background: "var(--border-1)" } }) : null,
                h(
                  "div",
                  { class: "tap", style: { padding: "14px 15px", display: "flex", alignItems: "center", justifyContent: "space-between" }, onclick: () => toggleBulkTagChecked(t) },
                  h("span", { style: { fontSize: "15px" } }, t),
                  h(
                    "div",
                    { style: { width: "19px", height: "19px", borderRadius: "9999px", flexShrink: "0", display: "flex", alignItems: "center", justifyContent: "center", background: s.checked.includes(t) ? "var(--accent)" : "transparent", border: s.checked.includes(t) ? "none" : "1.6px solid var(--text-faintest)" } },
                    s.checked.includes(t) ? icon('<path d="m5 13 4.5 4.5L19 7"/>', 11, "var(--text-on-accent)", { "stroke-width": "3.4" }) : null
                  )
                )
              ))
            )
          : null,
        isNew
          ? h("div", { class: "tap", style: { display: "flex", alignItems: "center", gap: "9px", color: "var(--accent)", fontSize: "14.5px", fontWeight: "500" }, onclick: createBulkTag }, icon('<path d="M12 5v14M5 12h14"/>', 17, "var(--accent)"), "Create “" + s.query.trim() + "”")
          : null,
        h(
          "div",
          { class: s.checked.length ? "tap" : "", style: { padding: "16px", borderRadius: "14px", textAlign: "center", fontSize: "15px", fontWeight: "500", background: s.checked.length ? "var(--surface-invert-bg)" : "var(--bg-tint)", color: s.checked.length ? "var(--surface-invert-text)" : "var(--text-faint)" }, onclick: s.checked.length ? applyBulkTag : null },
          "Add to " + ui.selectedIds.length + " card" + (ui.selectedIds.length === 1 ? "" : "s")
        )
      )
    );
  }

  function deleteTagSheetNode() {
    const tag = ui.deleteTagSheet;
    const count = data.cards.filter((c) => c.tags.includes(tag)).length;
    return h(
      "div",
      { style: { position: "absolute", inset: "0", background: "rgba(20,20,19,.34)", display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: "12px", zIndex: "20" }, onclick: closeDeleteTagSheet },
      h(
        "div",
        { style: { background: "var(--bg-surface)", borderRadius: "18px", overflow: "hidden", marginBottom: "10px" }, onclick: (e) => e.stopPropagation() },
        h(
          "div",
          { style: { padding: "15px 18px 13px", display: "flex", flexDirection: "column", gap: "4px", textAlign: "center", background: "var(--bg-page)" } },
          h("span", { style: { fontSize: "12.5px", letterSpacing: ".4px", textTransform: "uppercase", color: "var(--text-muted)" } }, 'Delete "' + tag + '"'),
          h("span", { style: { fontSize: "12.5px", lineHeight: "1.5", color: "var(--text-muted)" } }, count + " card" + (count === 1 ? "" : "s") + " carr" + (count === 1 ? "ies" : "y") + " this tag. Choose what to remove.")
        ),
        h("div", { style: { height: "1px", background: "var(--border-1)" } }),
        h(
          "div",
          { class: "tap", style: { padding: "15px 18px", display: "flex", flexDirection: "column", gap: "3px", alignItems: "center" }, onclick: () => deleteTagOnly(tag) },
          h("span", { style: { fontSize: "17px", fontWeight: "500" } }, "Delete tag only"),
          h("span", { style: { fontSize: "12px", color: "var(--text-muted)", textAlign: "center" } }, "Cards stay in their other tags, or untagged")
        ),
        h("div", { style: { height: "1px", background: "var(--border-1)" } }),
        h(
          "div",
          { class: "tap", style: { padding: "15px 18px", display: "flex", flexDirection: "column", gap: "3px", alignItems: "center" }, onclick: () => deleteTagAndCards(tag) },
          h("span", { style: { fontSize: "17px", color: "var(--danger)" } }, "Delete tag and relevant cards"),
          h("span", { style: { fontSize: "12px", color: "var(--text-muted)", textAlign: "center" } }, "Removes all " + count + " cards carrying this tag")
        )
      ),
      h("div", { class: "tap", style: { background: "var(--bg-surface)", borderRadius: "18px", padding: "17px 16px", textAlign: "center", fontSize: "17px", fontWeight: "500" }, onclick: closeDeleteTagSheet }, "Cancel")
    );
  }

  // Placeholder for now — the actual browse/share/download flows are a
  // separate, larger phase (needs new backend tables). This just gives the
  // nav slot somewhere real to land instead of a dead tab.
  // No "Back: " prefix here — the language filter row above already
  // establishes that this whole section is about the back-card
  // language, so repeating the word on every card was just noise (and
  // on the narrow 2-column grid, a fixed pill height plus that extra
  // text was forcing a wrap that then clipped against the fixed
  // height). Sized to content instead of a fixed height so a long
  // language name can wrap without clipping.
  function communityBackChip(lang, dark) {
    return h(
      "div",
      { style: { padding: "4px 9px", borderRadius: "11px", background: dark ? "#30302e" : "var(--bg-tint)", border: dark ? "none" : "1px solid var(--border-2b)", display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", fontWeight: "500", color: dark ? "#f5f4ed" : "var(--text-secondary)", alignSelf: "flex-start", flexShrink: "0", lineHeight: "1.3" } },
      icon('<path d="M3 6h12M9 3v3M11 17c-3.5-1-5.5-4.5-5.5-11M4 14c4 0 7-2 7-8"/><path d="M13 20l4-11 4 11M14.4 17h5.2"/>', 11, dark ? "#f5f4ed" : "var(--text-secondary)", { style: "flex-shrink:0" }),
      lang
    );
  }

  function communityGridCard(row) {
    const added = hasLocalCardsFrom(row.id);
    return h(
      "div",
      { class: "tap", style: { background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "16px", padding: "14px", display: "flex", flexDirection: "column", gap: "6px", minHeight: "118px" }, onclick: () => openTagDetail(row) },
      h("span", { style: { fontFamily: "var(--serif)", fontSize: "16.5px", fontWeight: "500", color: "var(--text-primary)" } }, row.name),
      h("span", { style: { fontSize: "11.5px", color: "var(--text-muted)" } }, "by " + row.owner_display_name),
      communityBackChip(row.back_language, false),
      h("span", { style: { marginTop: "auto", fontSize: "11.5px", color: "var(--text-muted)" } }, row.card_count + " cards"),
      added
        ? h("span", { style: { display: "flex", alignItems: "center", gap: "5px", fontSize: "11.5px", color: "var(--text-secondary)" } }, icon('<path d="m5 13 4.5 4.5L19 7"/>', 11, "var(--text-secondary)", { "stroke-width": "3" }), "Added")
        : h("span", { style: { fontSize: "11.5px", color: "var(--accent)", fontWeight: "500" } }, row.download_count.toLocaleString() + " downloads")
    );
  }

  function screenCommunity() {
    const filtered = communityFilteredFeed();
    const chips = communityLangChips();
    const isBrowsingDefault = !ui.communitySearch.trim() && ui.communityLangFilter === "Any";
    const hero = isBrowsingDefault && filtered.length ? filtered[0] : null;
    const gridItems = hero ? filtered.slice(1) : filtered;

    return h(
      "div",
      { style: { minHeight: "100%", background: "var(--bg-page)", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)" } },

      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "11px", padding: "0 20px" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
          h("h1", { style: { margin: "0", fontFamily: "var(--serif)", fontSize: "26px", fontWeight: "500", color: "var(--text-primary)" } }, "Community"),
          h("div", { class: "tap", style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "13.5px", fontWeight: "500", color: "var(--accent)" }, onclick: openMyTags }, "My tags", chevronNode())
        ),
        h(
          "div",
          { style: { height: "44px", borderRadius: "22px", background: "var(--bg-surface)", border: "1px solid var(--border-2b)", display: "flex", alignItems: "center", gap: "9px", padding: "0 15px" } },
          icon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>', 15, "var(--text-muted)"),
          h("input", {
            "data-field": "communitySearch", value: ui.communitySearch, placeholder: "Search by keyword",
            style: { flex: "1", border: "none", outline: "none", background: "transparent", fontSize: "14.5px", color: "var(--text-primary)" },
            oninput: (e) => { ui.communitySearch = e.target.value; if (!e.isComposing) scheduleRender(); },
            onblur: flushRender,
          })
        ),
        chips.length > 1
          ? h(
              "div",
              { class: "scrollx", "data-remember-scroll": "community-filters", style: { display: "flex", alignItems: "center", gap: "8px", overflow: "auto" } },
              h("span", { style: { fontSize: "11.5px", color: "var(--text-muted)", flexShrink: "0" } }, "Back"),
              ...chips.map((lang) =>
                h(
                  "div",
                  { class: "tap chip", style: Object.assign({ display: "flex", alignItems: "center", justifyContent: "center", height: "30px", padding: "0 13px", borderRadius: "9999px", fontSize: "12.5px", fontWeight: "500", flexShrink: "0", whiteSpace: "nowrap" }, chipStyle(ui.communityLangFilter === lang)), onclick: () => { ui.communityLangFilter = lang; render(); } },
                  lang
                )
              )
            )
          : null
      ),

      h(
        "div",
        { "data-remember-scroll": "community-feed", style: { flex: "1", overflow: "auto", padding: "14px 20px 18px", display: "flex", flexDirection: "column", gap: "12px" } },
        ui.communityLoading
          ? h("div", { style: { fontSize: "13px", color: "var(--text-faint)", textAlign: "center", padding: "30px 0" } }, "Loading…")
          : filtered.length === 0
            ? h("div", { style: { fontSize: "13.5px", color: "var(--text-muted)", textAlign: "center", padding: "40px 20px", lineHeight: "1.6" } }, "No shared tags match yet — check back soon, or be the first to share one from My Tags.")
            : [
                hero
                  ? h(
                      "div",
                      { class: "tap", style: { background: "#141413", borderRadius: "16px", padding: "14px 16px", display: "flex", flexDirection: "column", gap: "7px" }, onclick: () => openTagDetail(hero) },
                      h("span", { style: { fontSize: "10px", letterSpacing: "1.1px", textTransform: "uppercase", color: "#b0aea5" } }, "Most downloaded"),
                      h("span", { style: { fontFamily: "var(--serif)", fontSize: "20px", fontWeight: "500", color: "#faf9f5", lineHeight: "1.2" } }, hero.name),
                      h("span", { style: { fontSize: "12px", color: "#b0aea5" } }, "by " + hero.owner_display_name),
                      h(
                        "div",
                        { style: { display: "flex", alignItems: "flex-end", justifyContent: "space-between" } },
                        h(
                          "div",
                          { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
                          communityBackChip(hero.back_language, true),
                          h("span", { style: { fontSize: "12.5px", color: "#b0aea5" } }, hero.card_count + " cards")
                        ),
                        h(
                          "div",
                          { style: { height: "32px", padding: "0 14px", borderRadius: "9999px", background: "#d97757", color: "#faf9f5", display: "flex", alignItems: "center", gap: "6px", fontSize: "13.5px", fontWeight: "500", flexShrink: "0" } },
                          icon('<path d="M12 4v12m0 0 4-4m-4 4-4-4M4 20h16"/>', 14, "#faf9f5"),
                          hero.download_count.toLocaleString()
                        )
                      )
                    )
                  : null,
                gridItems.length
                  ? h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" } }, ...gridItems.map((row) => communityGridCard(row)))
                  : null,
              ]
      ),

      bottomNav("community")
    );
  }

  function downloadDraftSheetNode() {
    const d = ui.downloadDraft;
    return h(
      "div",
      { style: { position: "absolute", inset: "0", background: "rgba(20,20,19,.34)", display: "flex", alignItems: "center", justifyContent: "center", padding: "26px", zIndex: "20" }, onclick: closeDownloadDraft },
      h(
        "div",
        { style: { width: "100%", background: "var(--bg-surface)", borderRadius: "20px", padding: "22px 20px", display: "flex", flexDirection: "column", gap: "14px" }, onclick: (e) => e.stopPropagation() },
        h("span", { style: { fontFamily: "var(--serif)", fontSize: "20px", fontWeight: "500" } }, "Add this tag"),
        browsableTags().includes(d.row.name)
          ? h(
              "p",
              { style: { margin: "0", fontSize: "14px", lineHeight: "1.55", color: "var(--text-secondary)" } },
              "You already have a tag called ",
              h("strong", { style: { color: "var(--text-primary)", fontWeight: "500" } }, d.row.name),
              ". Give the downloaded one a different name to keep them apart."
            )
          : h("p", { style: { margin: "0", fontSize: "14px", lineHeight: "1.55", color: "var(--text-secondary)" } }, "This will add " + d.row.card_count + " cards to a local tag."),
        h("input", {
          "data-field": "downloadDraftName", value: d.name, placeholder: "Tag name",
          style: { height: "50px", borderRadius: "12px", background: "var(--bg-page)", border: "1.5px solid var(--accent)", padding: "0 15px", fontFamily: "var(--serif)", fontSize: "17px", color: "var(--text-primary)" },
          oninput: (e) => { d.name = e.target.value; },
          onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); submitDownload(); } },
        }),
        d.error ? h("div", { style: { fontSize: "12.5px", color: "var(--accent)" } }, d.error) : null,
        h(
          "div",
          { style: { display: "flex", gap: "10px", marginTop: "2px" } },
          h("div", { class: "tap", style: { flex: "1", padding: "14px", borderRadius: "12px", textAlign: "center", background: "var(--border-2b)", color: "var(--text-secondary)", fontSize: "15px", fontWeight: "500" }, onclick: closeDownloadDraft }, "Cancel"),
          h("div", { class: d.busy ? "" : "tap", style: { flex: "1", padding: "14px", borderRadius: "12px", textAlign: "center", background: "var(--surface-invert-bg)", color: "var(--surface-invert-text)", fontSize: "15px", fontWeight: "500", opacity: d.busy ? ".6" : "1" }, onclick: d.busy ? null : submitDownload }, d.busy ? "Adding…" : "Add tag")
        )
      )
    );
  }

  function screenTagDetail() {
    const t = ui.tagDetail;
    const row = t.row;
    const added = hasLocalCardsFrom(row.id);

    return h(
      "div",
      { style: { minHeight: "100%", background: "var(--bg-page)", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)", position: "relative" } },

      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 20px 0" } },
        h("div", { class: "tap", style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "15.5px", color: "var(--text-secondary)" }, onclick: () => { ui.tagDetail = null; go("community"); } }, icon('<path d="M15 18l-6-6 6-6"/>', 15, "var(--text-secondary)"), "Community"),
        // Reporting your own tag isn't a meaningful action, so the
        // entry point just isn't shown on it.
        row.owner_id !== data.userId
          ? h(
              "div",
              { class: t.reportSubmitted ? "" : "tap", style: { display: "flex", alignItems: "center", gap: "4px", fontSize: "13.5px", color: "var(--text-muted)" }, onclick: t.reportSubmitted ? null : openReportSheet },
              icon('<path d="M12 9v4.5M12 17h.01M10.3 4.1 2.6 17.4A1.8 1.8 0 0 0 4.2 20h15.6a1.8 1.8 0 0 0 1.6-2.6L13.7 4.1a1.9 1.9 0 0 0-3.4 0z"/>', 15, "var(--text-muted)"),
              t.reportSubmitted ? "Reported" : "Report"
            )
          : null
      ),

      h(
        "div",
        { "data-remember-scroll": "tagDetail", style: { flex: "1", overflow: "auto", padding: "14px 20px 18px", display: "flex", flexDirection: "column", gap: "16px" } },

        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "9px" } },
          h("span", { style: { fontFamily: "var(--serif)", fontSize: "27px", fontWeight: "500", color: "var(--text-primary)", lineHeight: "1.15" } }, row.name),
          h("span", { style: { fontSize: "13px", color: "var(--text-muted)" } }, "by " + row.owner_display_name),
          h(
            "div",
            { style: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "8px" } },
            communityBackChip(row.back_language, false),
            h("span", { style: { fontSize: "13px", color: "var(--text-muted)" } }, row.card_count + " cards · " + row.download_count.toLocaleString() + " downloads")
          )
        ),

        row.description ? h("p", { style: { margin: "0", fontSize: "14.5px", lineHeight: "1.6", color: "var(--text-secondary)" } }, row.description) : null,

        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "9px" } },
          h("span", { style: { fontSize: "10.5px", letterSpacing: ".09em", textTransform: "uppercase", color: "var(--text-secondary)" } }, "Cards in this tag"),
          t.loading
            ? h("div", { style: { fontSize: "13px", color: "var(--text-faint)" } }, "Loading…")
            : h(
                "div",
                { style: { background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "16px", overflow: "hidden" } },
                ...t.previewCards.map((c, i) =>
                  h(
                    "div",
                    {},
                    i ? h("div", { style: { height: "1px", background: "var(--border-1)" } }) : null,
                    h(
                      "div",
                      { style: { padding: "12px 15px", display: "flex", flexDirection: "column", gap: "3px" } },
                      h("span", { style: { fontFamily: "var(--jp)", fontSize: "14.5px", color: "var(--text-primary)" } }, c.front),
                      h("span", { style: { fontSize: "12px", color: "var(--text-muted)" } }, c.back)
                    )
                  )
                )
              )
        )
      ),

      h(
        "div",
        { style: { padding: "14px 20px 18px", background: "var(--bg-page)" } },
        added
          ? h(
              "div",
              { style: { padding: "16px", borderRadius: "14px", textAlign: "center", fontSize: "15px", fontWeight: "500", background: "var(--bg-tint)", color: "var(--text-secondary)", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" } },
              icon('<path d="m5 13 4.5 4.5L19 7"/>', 15, "var(--text-secondary)", { "stroke-width": "3" }),
              "Already added"
            )
          : h(
              "div",
              { class: "tap", style: { padding: "16px", borderRadius: "14px", textAlign: "center", fontSize: "15px", fontWeight: "500", background: "var(--accent)", color: "var(--text-on-accent)", display: "flex", alignItems: "center", justifyContent: "center", gap: "9px" }, onclick: () => startDownloadFlow(row) },
              icon('<path d="M12 4v12m0 0 4-4m-4 4-4-4M4 20h16"/>', 17, "var(--text-on-accent)"),
              "Download tag"
            )
      ),

      ui.downloadDraft ? downloadDraftSheetNode() : null,
      t.reportOpen ? reportSheetNode() : null
    );
  }

  const REPORT_REASONS = [
    { value: "sensitive_content", label: "Sensitive or adult content" },
    { value: "violence_hate", label: "Violence or hateful language" },
    { value: "spam_or_misleading", label: "Spam, ads, or a misleading tag" },
    { value: "low_quality", label: "Repeated or irrelevant content" },
  ];

  function openReportSheet() {
    const t = ui.tagDetail;
    t.reportOpen = true;
    t.reportReason = null;
    t.reportDetail = "";
    t.reportError = "";
    render();
  }

  function closeReportSheet() {
    ui.tagDetail.reportOpen = false;
    render();
  }

  async function submitReport() {
    const t = ui.tagDetail;
    if (!t.reportReason || t.reportBusy) return;
    t.reportBusy = true;
    t.reportError = "";
    render();
    const { error } = await sb.rpc("report_shared_tag", { p_shared_tag_id: t.row.id, p_reason: t.reportReason, p_detail: t.reportDetail.trim() });
    t.reportBusy = false;
    if (error) { t.reportError = error.message; render(); return; }
    t.reportOpen = false;
    t.reportSubmitted = true;
    render();
  }

  function reportSheetNode() {
    const t = ui.tagDetail;
    return h(
      "div",
      { style: { position: "absolute", inset: "0", background: "rgba(20,20,19,.34)", display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: "12px", zIndex: "20" }, onclick: closeReportSheet },
      h(
        "div",
        { style: { background: "var(--bg-surface)", borderRadius: "22px 22px 18px 18px", padding: "20px 20px 22px", display: "flex", flexDirection: "column", gap: "16px" }, onclick: (e) => e.stopPropagation() },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
          h("span", { style: { fontFamily: "var(--serif)", fontSize: "20px", fontWeight: "500" } }, "Report this tag"),
          h("span", { class: "tap", style: { fontSize: "14.5px", color: "var(--text-secondary)" }, onclick: closeReportSheet }, "Cancel")
        ),
        h("p", { style: { margin: "0", fontSize: "13.5px", lineHeight: "1.55", color: "var(--text-secondary)" } }, "Tell us what's wrong. Reported tags are hidden from the feed while we review them."),
        h(
          "div",
          { style: { background: "var(--bg-page)", borderRadius: "14px", overflow: "hidden" } },
          ...REPORT_REASONS.map((r, i) =>
            h(
              "div",
              {},
              i ? h("div", { style: { height: "1px", background: "var(--border-2b)" } }) : null,
              h(
                "div",
                { class: "tap", style: { padding: "14px 15px", display: "flex", alignItems: "center", justifyContent: "space-between" }, onclick: () => { t.reportReason = r.value; render(); } },
                h("span", { style: { fontSize: "15px", color: "var(--text-primary)" } }, r.label),
                h(
                  "div",
                  { style: { width: "19px", height: "19px", borderRadius: "9999px", flexShrink: "0", display: "flex", alignItems: "center", justifyContent: "center", background: t.reportReason === r.value ? "var(--accent)" : "transparent", border: t.reportReason === r.value ? "none" : "1.6px solid var(--text-faintest)" } },
                  t.reportReason === r.value ? icon('<path d="m5 13 4.5 4.5L19 7"/>', 11, "var(--text-on-accent)", { "stroke-width": "3.4" }) : null
                )
              )
            )
          )
        ),
        h("textarea", {
          "data-field": "reportDetail", rows: "3", placeholder: "Add detail (optional)",
          style: { borderRadius: "12px", background: "var(--bg-page)", border: "1px solid var(--border-2b)", padding: "13px 15px", fontSize: "14px", color: "var(--text-primary)", resize: "none" },
          oninput: (e) => { t.reportDetail = e.target.value.slice(0, 500); }, onblur: flushRender,
        }, t.reportDetail),
        t.reportError ? h("div", { style: { fontSize: "12.5px", color: "var(--accent)" } }, t.reportError) : null,
        h(
          "div",
          { class: t.reportReason && !t.reportBusy ? "tap" : "", style: { padding: "16px", borderRadius: "14px", textAlign: "center", fontSize: "15px", fontWeight: "500", background: t.reportReason && !t.reportBusy ? "var(--danger)" : "var(--bg-tint)", color: t.reportReason && !t.reportBusy ? "var(--surface-invert-text)" : "var(--text-faint)" }, onclick: t.reportReason && !t.reportBusy ? submitReport : null },
          t.reportBusy ? "Submitting…" : "Submit report"
        )
      )
    );
  }

  function myTagRow(t) {
    const count = cardsMatchingTags([t]).length;
    const eligible = eligibleCardsForTag(t).length;
    const shared = sharedRowForTag(t);

    let statusText = count + " card" + (count === 1 ? "" : "s");
    let statusColor = "var(--text-muted)";
    if (shared && shared.status === "removed") { statusText = "Removed after being reported"; statusColor = "var(--danger)"; }
    else if (shared && shared.status === "active") { statusText += " · shared publicly"; }
    else if (shared && shared.status === "unpublished") { statusText += " · unpublished"; }
    else if (count > 0 && eligible === 0) { /* no suffix — the "Downloaded" section heading already says this */ }
    else if (eligible < 50) { statusText += " · " + eligible + " original card" + (eligible === 1 ? "" : "s") + " (<50)"; }

    const canToggleShare = shared ? shared.status !== "removed" : eligible >= 50;
    const isLive = shared && shared.status === "active";

    return h(
      "div",
      { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 15px", gap: "10px" } },
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "3px", minWidth: "0" } },
        h("span", { style: { fontSize: "15.5px", fontWeight: "500", color: "var(--text-primary)" } }, t),
        h("span", { style: { fontSize: "12px", color: statusColor } }, statusText)
      ),
      h(
        "div",
        { style: { display: "flex", gap: "15px", alignItems: "center", flexShrink: "0" } },
        h(
          "div",
          { class: canToggleShare ? "tap" : "", onclick: canToggleShare ? (shared ? (isLive ? () => toggleUnshareTag(shared) : () => openReshareFlow(t, shared)) : () => openShareFlow(t)) : null },
          icon('<path d="M12 16V4m0 0 4 4m-4-4-4 4M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/>', 17, isLive ? "var(--text-secondary)" : canToggleShare ? "var(--accent)" : "var(--text-faintest)")
        ),
        h(
          "div",
          { class: "tap", onclick: () => openRenameTagSheet(t) },
          icon('<path d="M4 20h4l10-10-4-4L4 16v4zM14 6l4 4"/>', 17, "var(--text-secondary)")
        )
      )
    );
  }

  function renameTagSheetNode() {
    const s = ui.renameTagSheet;
    return h(
      "div",
      { style: { position: "absolute", inset: "0", background: "rgba(20,20,19,.34)", display: "flex", alignItems: "center", justifyContent: "center", padding: "26px", zIndex: "20" }, onclick: closeRenameTagSheet },
      h(
        "div",
        { style: { width: "100%", background: "var(--bg-surface)", borderRadius: "20px", padding: "22px 20px", display: "flex", flexDirection: "column", gap: "14px" }, onclick: (e) => e.stopPropagation() },
        h("span", { style: { fontFamily: "var(--serif)", fontSize: "20px", fontWeight: "500" } }, "Rename this tag"),
        h("input", {
          value: s.newName,
          style: { height: "50px", borderRadius: "12px", background: "var(--bg-page)", border: "1.5px solid var(--accent)", padding: "0 15px", fontFamily: "var(--serif)", fontSize: "17px", color: "var(--text-primary)" },
          oninput: (e) => { s.newName = e.target.value; },
          onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); submitRenameTag(); } },
        }),
        h(
          "div",
          { style: { display: "flex", gap: "10px", marginTop: "2px" } },
          h("div", { class: "tap", style: { flex: "1", padding: "14px", borderRadius: "12px", textAlign: "center", background: "var(--border-2b)", color: "var(--text-secondary)", fontSize: "15px", fontWeight: "500" }, onclick: closeRenameTagSheet }, "Cancel"),
          h("div", { class: "tap", style: { flex: "1", padding: "14px", borderRadius: "12px", textAlign: "center", background: "var(--surface-invert-bg)", color: "var(--surface-invert-text)", fontSize: "15px", fontWeight: "500" }, onclick: submitRenameTag }, "Save")
        )
      )
    );
  }

  // Splits the user's tags into three groups so "share status" is
  // scannable at a glance instead of buried in each row's status line:
  // - shared: currently live in the community.
  // - downloaded: every card under it came from the community (0
  //   eligible cards), so it can never be shared — a fundamentally
  //   different state from "unshared", not just "not shared yet".
  // - unshared: everything else the user owns (paused/removed shares,
  //   never shared, or a mix of downloaded + the user's own cards —
  //   still shareable using just the eligible ones).
  function myTagsCategorized() {
    const tags = browsableTags().filter((t) => t !== UNTAGGED_TAG);
    const shared = [], unshared = [], downloaded = [];
    tags.forEach((t) => {
      const row = sharedRowForTag(t);
      const eligible = eligibleCardsForTag(t).length;
      const count = cardsMatchingTags([t]).length;
      if (row && row.status === "active") shared.push(t);
      else if (count > 0 && eligible === 0) downloaded.push(t);
      else unshared.push(t);
    });
    return { shared, unshared, downloaded };
  }

  function myTagsSection(title, tags) {
    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "9px" } },
      h("span", { style: { fontSize: "10.5px", letterSpacing: ".09em", textTransform: "uppercase", color: "var(--text-secondary)" } }, title),
      tags.length
        ? settingsCard(...tags.map((t) => myTagRow(t)))
        : h("div", { style: { fontSize: "13px", color: "var(--text-faint)" } }, "None yet.")
    );
  }

  function screenMyTags() {
    const { shared, unshared, downloaded } = myTagsCategorized();
    const anyTags = shared.length + unshared.length + downloaded.length > 0;

    return h(
      "div",
      { style: { minHeight: "100%", background: "var(--bg-page)", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)", position: "relative" } },

      h(
        "div",
        { class: "tap", style: { display: "flex", alignItems: "center", gap: "6px", padding: "8px 20px 0", fontSize: "15.5px", color: "var(--text-secondary)" }, onclick: () => go("community") },
        icon('<path d="M15 18l-6-6 6-6"/>', 15, "var(--text-secondary)"), "Community"
      ),

      h(
        "div",
        { style: { flex: "1", overflow: "auto", padding: "14px 20px 18px", display: "flex", flexDirection: "column", gap: "20px" } },

        h("div", { style: { fontFamily: "var(--serif)", fontSize: "27px", fontWeight: "500", color: "var(--text-primary)" } }, "My tags"),

        ui.myTagsFrozen
          ? h(
              "div",
              { style: { padding: "14px 16px", background: "var(--danger-bg)", border: "1px solid var(--danger-border)", borderRadius: "14px", fontSize: "12.5px", lineHeight: "1.6", color: "var(--danger-text)" } },
              "Sharing is paused on this account until " + formatFrozenUntil(ui.myTagsFrozenUntil) + " after multiple shared tags were removed for violating community guidelines. Contact us if you think this is a mistake."
            )
          : null,

        ui.myTagsLoading
          ? h("div", { style: { fontSize: "13px", color: "var(--text-faint)" } }, "Loading…")
          : anyTags
            ? [myTagsSection("Shared", shared), myTagsSection("Unshared", unshared), myTagsSection("Downloaded", downloaded)]
            : h("div", { style: { fontSize: "13px", color: "var(--text-faint)" } }, "No tags yet — add some cards first.")
      ),

      ui.renameTagSheet ? renameTagSheetNode() : null
    );
  }

  function screenShareTag() {
    const d = ui.shareDraft;
    const eligible = eligibleCardsForTag(d.tagName);
    const eligibleIds = eligible.map((c) => c.id);
    const allEligibleSelected = eligibleIds.length > 0 && eligibleIds.every((id) => d.selectedIds.includes(id));
    const n = d.selectedIds.length;
    return h(
      "div",
      { style: { minHeight: "100%", background: "var(--bg-page)", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)", position: "relative" } },

      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 20px 0" } },
        h("div", { class: "tap", style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "15.5px", color: "var(--text-secondary)" }, onclick: () => { ui.shareDraft = null; go("myTags"); } }, icon('<path d="M15 18l-6-6 6-6"/>', 15, "var(--text-secondary)"), "My tags"),
        h("div", { class: "tap", style: { fontSize: "15px", color: "var(--text-secondary)" }, onclick: () => { ui.shareDraft = null; go("myTags"); } }, "Cancel")
      ),

      h(
        "div",
        { "data-remember-scroll": "shareTag", style: { flex: "1", overflow: "auto", padding: "0 20px 18px", display: "flex", flexDirection: "column", gap: "16px" } },

        h(
          "div",
          { style: { padding: "14px 0 0", display: "flex", flexDirection: "column", gap: "5px" } },
          h("span", { style: { fontSize: "10.5px", letterSpacing: ".09em", textTransform: "uppercase", color: "var(--text-secondary)" } }, d.republishId ? "Re-share tag" : "Share tag"),
          h("div", { style: { fontFamily: "var(--serif)", fontSize: "26px", fontWeight: "500", color: "var(--text-primary)" } }, d.tagName)
        ),

        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
          h(
            "div",
            { class: "tap chip", style: Object.assign({ display: "flex", alignItems: "center", gap: "7px", height: "32px", padding: "0 14px", borderRadius: "9999px", fontSize: "13.5px", fontWeight: "500" }, chipStyle(allEligibleSelected)), onclick: () => toggleShareSelectAll(eligibleIds) },
            allEligibleSelected ? icon('<path d="m5 13 4.5 4.5L19 7"/>', 13, "var(--surface-invert-text)", { "stroke-width": "2.6" }) : null,
            "All " + eligibleIds.length + " cards"
          ),
          h("span", { style: { fontSize: "12px", color: "var(--text-muted)" } }, n + " of " + eligibleIds.length + " selected")
        ),

        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "9px" } },
          h("span", { style: { fontSize: "10.5px", letterSpacing: ".09em", textTransform: "uppercase", color: "var(--text-secondary)" } }, "Cards in this tag"),
          h(
            "div",
            { style: { background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "16px", overflow: "hidden" } },
            ...cardsMatchingTags([d.tagName]).map((c, i) => {
              const ineligible = !!c.sourceSharedTagId;
              const checked = d.selectedIds.includes(c.id);
              return h(
                "div",
                {},
                i ? h("div", { style: { height: "1px", background: "var(--border-1)" } }) : null,
                h(
                  "div",
                  { class: ineligible ? "" : "tap", style: { padding: "12px 15px", display: "flex", alignItems: "center", gap: "12px", opacity: ineligible ? ".55" : "1" }, onclick: ineligible ? null : () => toggleShareCardSelected(c.id) },
                  h(
                    "div",
                    { style: { width: "20px", height: "20px", borderRadius: "9999px", flexShrink: "0", display: "flex", alignItems: "center", justifyContent: "center", background: checked ? "var(--accent)" : "transparent", border: checked ? "none" : "1.6px solid var(--text-faintest)" } },
                    checked ? icon('<path d="m5 13 4.5 4.5L19 7"/>', 11, "var(--text-on-accent)", { "stroke-width": "3.4" }) : null
                  ),
                  h(
                    "div",
                    { style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" } },
                    h("span", { style: { fontFamily: "var(--jp)", fontSize: "14.5px", color: "var(--text-primary)" } }, c.front),
                    h("span", { style: { fontSize: "11.5px", color: "var(--text-muted)" } }, ineligible ? "From community — can't be shared" : c.back)
                  )
                )
              );
            })
          )
        ),

        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "9px" } },
          // A native <select> kept its own internal vertical padding no
          // matter what appearance/line-height/box-height said, biasing
          // the text upward on real devices (and, it turns out, in the
          // simulator too) — CSS just can't fully override that. A
          // plain tappable row opening our own picker sheet sidesteps
          // the OS's <select> rendering entirely, so the text is
          // trivially centered like everything else in this app.
          h(
            "div",
            { class: "tap", style: { height: "46px", borderRadius: "12px", background: "var(--bg-surface)", border: "1px solid var(--border-2b)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 15px" }, onclick: () => { d.langSheetOpen = true; render(); } },
            h("span", { style: { fontSize: "12.5px", color: "var(--text-secondary)" } }, "Back-card language"),
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "6px" } },
              h("span", { style: { fontSize: "14.5px", fontWeight: "500", color: "var(--text-primary)" } }, d.backLanguage),
              icon('<path d="m6 9 6 6 6-6"/>', 13, "var(--text-muted)")
            )
          ),
          h("textarea", {
            "data-field": "shareDescription", rows: "3", placeholder: "Describe this tag for other learners…",
            style: { borderRadius: "12px", background: "var(--bg-surface)", border: "1px solid var(--border-2b)", padding: "12px 15px", fontSize: "14px", color: "var(--text-primary)", resize: "none" },
            // No render() on input, same as the app's other free-text
            // fields (front/back/profile/auth) — this field doesn't filter
            // anything live the way the search boxes do, so there's no
            // reason to risk it. The counter below just lags until blur.
            oninput: (e) => { d.description = e.target.value.slice(0, 500); }, onblur: flushRender,
          }, d.description),
          h("span", { style: { fontSize: "11.5px", color: "var(--text-faint)", textAlign: "right" } }, d.description.length + " / 500"),
          d.error ? h("div", { style: { fontSize: "12.5px", color: "var(--accent)" } }, d.error) : null,
          h(
            "div",
            { class: n >= 50 && !d.busy ? "tap" : "", style: { padding: "16px", borderRadius: "14px", textAlign: "center", fontSize: "15px", fontWeight: "500", background: n >= 50 && !d.busy ? "var(--surface-invert-bg)" : "var(--bg-tint)", color: n >= 50 && !d.busy ? "var(--surface-invert-text)" : "var(--text-faint)" }, onclick: n >= 50 && !d.busy ? submitShareTag : null },
            d.busy ? (d.republishId ? "Re-sharing…" : "Sharing…") : (d.republishId ? "Re-share " : "Share ") + n + " cards"
          ),
          h("span", { style: { fontSize: "11.5px", color: "var(--text-faint)", textAlign: "center" } }, "At least 50 original cards are needed to share a tag.")
        )
      ),

      d.langSheetOpen ? backLanguageSheetNode() : null
    );
  }

  function backLanguageSheetNode() {
    const d = ui.shareDraft;
    return h(
      "div",
      { style: { position: "absolute", inset: "0", background: "rgba(20,20,19,.34)", display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: "12px", zIndex: "20" }, onclick: () => { d.langSheetOpen = false; render(); } },
      h(
        "div",
        { style: { background: "var(--bg-surface)", borderRadius: "18px", overflow: "hidden", marginBottom: "10px", maxHeight: "60vh", display: "flex", flexDirection: "column" }, onclick: (e) => e.stopPropagation() },
        h(
          "div",
          { style: { padding: "15px 18px 13px", textAlign: "center", background: "var(--bg-page)", flexShrink: "0" } },
          h("span", { style: { fontSize: "12.5px", letterSpacing: ".4px", textTransform: "uppercase", color: "var(--text-muted)" } }, "Back-card language")
        ),
        h("div", { style: { height: "1px", background: "var(--border-1)", flexShrink: "0" } }),
        h(
          "div",
          { style: { overflow: "auto" } },
          ...BACK_LANGUAGES.map((lang, i) =>
            h(
              "div",
              {},
              i ? h("div", { style: { height: "1px", background: "var(--border-1)" } }) : null,
              h(
                "div",
                { class: "tap", style: { padding: "15px 18px", display: "flex", alignItems: "center", justifyContent: "space-between" }, onclick: () => { d.backLanguage = lang; d.langSheetOpen = false; render(); } },
                h("span", { style: { fontSize: "16px", color: "var(--text-primary)" } }, lang),
                lang === d.backLanguage ? icon('<path d="m5 13 4.5 4.5L19 7"/>', 15, "var(--accent)", { "stroke-width": "3" }) : null
              )
            )
          )
        )
      )
    );
  }

  function screenAdd() {
    const d = ui.draft;
    const tags = allTags();
    // Waiting out romajiLoading closes a real race: tapping Save (or
    // preview, below) the instant after typing could fire before the
    // in-flight kana/romaji fetch resolves, saving/speaking with the
    // not-yet-populated d.kana and silently falling back to raw front
    // text — reproducing the exact mispronunciation this was meant to fix.
    const canSave = d.front.trim() && d.back.trim() && !d.romajiLoading;

    const audioModePanel = d.audioMode === "system"
      ? h(
          "div",
          { style: { marginTop: "10px", padding: "18px", background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "16px" } },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "15px" } },
            h(
              "div",
              { class: "tap", style: { width: "52px", height: "52px", borderRadius: "9999px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: "0", background: d.front.trim() && !d.romajiLoading ? "var(--bg-page)" : "var(--bg-tint)" }, onclick: () => d.front.trim() && !d.romajiLoading && speak(d.kana || d.front) },
              icon('<path d="M8 5l11 7-11 7z"/>', 19, "var(--accent)")
            ),
            h(
              "div",
              { style: { flex: "1", minWidth: "0" } },
              h("div", { style: { fontSize: "13.5px", color: "var(--text-primary)" } }, d.romajiLoading ? "Getting the reading ready…" : d.front.trim() ? "Tap to preview" : "Type a sentence to generate audio"),
              h("div", { style: { marginTop: "4px", fontSize: "11.5px", color: "var(--text-faint)" } }, "Spoken aloud automatically during review")
            )
          )
        )
      : h(
          "div",
          { style: { marginTop: "10px", padding: "18px", background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "16px", display: "flex", alignItems: "center", gap: "15px" } },
          h(
            "div",
            { class: "tap", style: { width: "52px", height: "52px", borderRadius: "9999px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: "0", background: d.recState === "active" ? "var(--accent-2)" : "var(--surface-invert-bg)" }, onclick: tapRecord },
            d.recState === "idle"
              ? icon('<path d="M12 3a3 3 0 013 3v6a3 3 0 01-6 0V6a3 3 0 013-3z"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>', 21, "var(--surface-invert-text)")
              : d.recState === "active"
                ? h("div", { style: { width: "16px", height: "16px", borderRadius: "3px", background: "var(--text-on-accent)", animation: "sc-rec 1.1s ease-in-out infinite" } })
                : icon('<path d="M8 5l11 7-11 7z"/>', 19, "var(--surface-invert-text)")
          ),
          h(
            "div",
            { style: { flex: "1", minWidth: "0" } },
            h("div", { style: { fontSize: "13.5px", color: "var(--text-primary)" } }, d.recState === "idle" ? "Tap to record your voice" : d.recState === "active" ? "Recording · 0:0" + d.recSec : "Recorded"),
            d.recState !== "idle" ? h("div", { style: { marginTop: "8px", fontSize: "11px", color: "var(--text-faint)" } }, d.recState === "active" ? "Tap again to stop" : "") : null
          ),
          d.recState === "done" ? h("div", { class: "tap", style: { fontSize: "12px", color: "var(--text-secondary)", flexShrink: "0" }, onclick: () => { d.recState = "idle"; d.recording = null; render(); } }, "Redo") : null
        );

    return h(
      "div",
      { style: { minHeight: "100%", background: "var(--bg-page)", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)" } },

      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 20px 0" } },
        h("div", { class: "tap", style: { fontSize: "14px", color: "var(--text-secondary)" }, onclick: cancelCardForm }, "Cancel"),
        h("div", { style: { fontSize: "13px", color: ui.cardSavedFlash ? "var(--success)" : "var(--text-faint)" } }, ui.cardSavedFlash ? "Saved ✓" : d.editingId ? "Edit card" : "New card"),
        h("div", { class: canSave ? "tap" : "", style: { fontSize: "14px", fontWeight: "500", color: canSave ? "var(--accent)" : "var(--text-faint)" }, onclick: canSave ? saveCard : null }, "Save")
      ),

      h(
        "div",
        { style: { padding: "22px 20px 0" } },
        h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "var(--text-faint)" } }, "Front · sentence"),
        h("textarea", { "data-field": "front", rows: "2", placeholder: "昨日は泳ぎました。", style: { marginTop: "10px", width: "100%", resize: "none", padding: "16px", background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "14px", fontFamily: "var(--jp)", fontSize: "19px", lineHeight: "1.5", color: "var(--text-primary)" }, oninput: (e) => { d.front = e.target.value; }, onblur: handleFrontBlur }, d.front)
      ),

      h(
        "div",
        { style: { padding: "16px 20px 0" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
          h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "var(--text-faint)" } }, "Romaji · auto-generated"),
          d.romajiLoading ? h("div", { style: { fontSize: "11px", color: "var(--text-faint)" } }, "Generating…") : null
        ),
        h("input", { "data-field": "romaji", value: d.romaji, placeholder: "Kinō wa oyogimashita.", style: { marginTop: "10px", width: "100%", padding: "14px 16px", background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "14px", fontSize: "14px", color: "var(--text-primary)" }, oninput: (e) => { d.romaji = e.target.value; d.romajiAuto = false; d.romajiSuggestion = null; }, onblur: flushRender }),
        d.romajiSuggestion
          ? h(
              "div",
              { class: "tap", style: { marginTop: "8px", fontSize: "12.5px", color: "var(--accent)" }, onclick: acceptRomajiSuggestion },
              "Suggested: " + d.romajiSuggestion + " · Tap to use"
            )
          : null
      ),

      h(
        "div",
        { style: { padding: "20px 20px 0" } },
        h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "var(--text-faint)" } }, "Back · note"),
        h("textarea", { "data-field": "back", rows: "2", placeholder: "I swam yesterday.", style: { marginTop: "10px", width: "100%", resize: "none", padding: "16px", background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "14px", fontFamily: "var(--serif)", fontSize: "17px", lineHeight: "1.5", color: "var(--text-primary)" }, oninput: (e) => { d.back = e.target.value; }, onblur: flushRender }, d.back)
      ),

      h(
        "div",
        { style: { padding: "20px 20px 0" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between" } },
          h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "var(--text-faint)" } }, "Tags · optional"),
          h("div", { style: { fontSize: "11.5px", color: "var(--text-faint)" } }, d.tags.length ? d.tags.length + " selected" : 'defaults to "' + UNTAGGED_TAG + '"')
        ),
        h(
          "div",
          { style: { marginTop: "11px", display: "flex", flexWrap: "wrap", gap: "8px" } },
          ...tags.concat(d.tags.filter((t) => !tags.includes(t))).map((t) => {
            const on = d.tags.includes(t);
            return h("div", { class: "tap chip", style: Object.assign({ padding: "9px 14px", borderRadius: "9999px", fontSize: "13px" }, chipStyle(on)), onclick: () => toggleDraftTag(t) }, t);
          })
        ),
        h(
          "div",
          { style: { marginTop: "10px", display: "flex", gap: "8px" } },
          h("input", { "data-field": "newTag", value: d.newTag, placeholder: "New tag", style: { flex: "1", padding: "11px 14px", background: "var(--bg-surface)", border: "1px dashed var(--text-faintest)", borderRadius: "9999px", fontSize: "13px", color: "var(--text-primary)" }, oninput: (e) => { d.newTag = e.target.value; }, onblur: flushRender, onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); addNewTag(); } } }),
          h("div", { class: "tap", style: { padding: "11px 18px", borderRadius: "9999px", background: "var(--bg-tint)", color: "var(--text-primary)", fontSize: "13px" }, onclick: addNewTag }, "Add")
        )
      ),

      h(
        "div",
        { style: { padding: "22px 20px 0" } },
        h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "var(--text-faint)" } }, "Audio · optional"),
        h(
          "div",
          { style: { marginTop: "11px", display: "flex", gap: "4px", padding: "4px", background: "var(--bg-tint)", borderRadius: "12px" } },
          ...[
            { key: "system", name: "Generated", note: "Read from the sentence" },
            { key: "record", name: "Your voice", note: "Record it yourself" },
          ].map((m) => {
            const on = d.audioMode === m.key;
            return h(
              "div",
              { class: "tap", style: { flex: "1", padding: "9px 10px", borderRadius: "9px", textAlign: "center", background: on ? "var(--bg-surface)" : "transparent", border: "1px solid " + (on ? "var(--border-3)" : "transparent") }, onclick: () => { d.audioMode = m.key === "record" ? "record" : "system"; render(); } },
              h("div", { style: { fontSize: "13px", fontWeight: "500", color: on ? "var(--text-primary)" : "var(--text-secondary)" } }, m.name),
              h("div", { style: { marginTop: "2px", fontSize: "10.5px", color: on ? "var(--text-secondary)" : "var(--text-faint)" } }, m.note)
            );
          })
        ),
        audioModePanel
      ),

      h("div", { style: { padding: "20px 20px 0", fontSize: "12px", lineHeight: "1.7", color: "var(--text-faint)" } }, "Audio plays automatically when the card appears in review. Generated audio is read from the front of the card — record your own voice instead when pronunciation or intonation is the thing you want to practise."),

      d.editingId
        ? h(
            "div",
            { style: { padding: "26px 20px 0" } },
            h("div", { class: "tap", style: { padding: "16px", borderRadius: "14px", textAlign: "center", border: "1px solid var(--border-1)", color: "var(--accent)", fontSize: "14px", fontWeight: "500" }, onclick: deleteCard }, "Delete card")
          )
        : null,

      h("div", { style: { height: "40px" } })
    );
  }

  function chevronNode() {
    return h("div", { style: { width: "7px", height: "7px", borderRight: "1.6px solid var(--text-faint)", borderBottom: "1.6px solid var(--text-faint)", transform: "rotate(-45deg)", flexShrink: "0" } });
  }

  function settingsRow(label, right, onclick) {
    return h(
      "div",
      { class: onclick ? "tap" : "", style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "15px 16px", gap: "12px" }, onclick: onclick || null },
      h("span", { style: { fontSize: "15.5px", color: "var(--text-primary)", flexShrink: "0", whiteSpace: "nowrap" } }, label),
      h("div", { style: { display: "flex", alignItems: "center", gap: "10px", minWidth: "0" } }, right)
    );
  }

  function centeredRow(label, color, onclick) {
    return h("div", { class: onclick ? "tap" : "", style: { padding: "15px 16px", textAlign: "center", fontSize: "15.5px", color }, onclick: onclick || null }, label);
  }

  function settingsCard(...rows) {
    const withSeps = [];
    rows.forEach((r, i) => {
      if (i) withSeps.push(h("div", { style: { height: "1px", background: "var(--border-1)", marginLeft: "16px" } }));
      withSeps.push(r);
    });
    return h("div", { style: { background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "16px", overflow: "hidden" } }, ...withSeps);
  }

  function subScreenHeader(title, onBack) {
    return h(
      "div",
      { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 20px 0" } },
      h("div", { class: "tap", style: { fontSize: "14px", color: "var(--text-secondary)" }, onclick: onBack }, "Cancel"),
      h("div", { style: { fontSize: "13px", color: "var(--text-faint)" } }, title),
      h("div", { style: { width: "42px" } })
    );
  }

  function screenProfile() {
    const d = ui.profileDraft;

    const fileInput = h("input", {
      type: "file", accept: "image/*", style: { display: "none" },
      onchange: (e) => { const f = e.target.files && e.target.files[0]; if (f) handlePhotoFile(f); e.target.value = ""; },
    });

    const sheet = ui.avatarSheetOpen
      ? h(
          "div",
          { style: { position: "absolute", inset: "0", background: "rgba(20,20,19,.34)", display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: "12px", zIndex: "20" }, onclick: () => { ui.avatarSheetOpen = false; render(); } },
          h(
            "div",
            { style: { background: "var(--bg-surface)", borderRadius: "18px", overflow: "hidden", marginBottom: "10px" }, onclick: (e) => e.stopPropagation() },
            h("div", { style: { padding: "13px 16px 12px", textAlign: "center", fontSize: "12.5px", color: "var(--text-muted)" } }, "Profile photo"),
            h("div", { style: { height: "1px", background: "var(--border-1)" } }),
            h("div", { class: "tap", style: { textAlign: "center", padding: "17px 16px", fontSize: "17px", fontWeight: "500" }, onclick: () => { ui.avatarSheetOpen = false; fileInput.click(); } }, "Change photo"),
            d.photo
              ? h("div", {}, h("div", { style: { height: "1px", background: "var(--border-1)" } }), h("div", { class: "tap", style: { textAlign: "center", padding: "17px 16px", fontSize: "17px", color: "var(--accent)" }, onclick: () => { d.photo = null; ui.avatarSheetOpen = false; render(); } }, "Remove photo"))
              : null
          ),
          h("div", { class: "tap", style: { background: "var(--bg-surface)", borderRadius: "18px", padding: "17px 16px", textAlign: "center", fontSize: "17px", fontWeight: "500" } }, "Cancel")
        )
      : null;

    return h(
      "div",
      { style: { minHeight: "100%", background: "var(--bg-page)", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)", position: "relative" } },

      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 20px 0" } },
        h("div", { class: "tap", style: { fontSize: "14px", color: "var(--text-secondary)" }, onclick: cancelProfile }, "Cancel"),
        h("div", { style: { fontSize: "13px", color: "var(--text-faint)" } }, "Your profile"),
        h("div", { class: "tap", style: { fontSize: "14px", fontWeight: "500", color: "var(--accent)" }, onclick: saveProfile }, "Save")
      ),

      h(
        "div",
        { style: { flex: "1", display: "flex", flexDirection: "column", padding: "0 20px", gap: "22px" } },

        h(
          "div",
          { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "14px", padding: "22px 0 6px" } },
          h(
            "div",
            { class: "tap", style: { position: "relative" }, onclick: () => { ui.avatarSheetOpen = true; render(); } },
            avatarNode(d, 96),
            h(
              "div",
              { style: { position: "absolute", right: "-2px", bottom: "-2px", width: "30px", height: "30px", borderRadius: "9999px", background: "var(--surface-invert-bg)", border: "2.5px solid var(--bg-page)", display: "flex", alignItems: "center", justifyContent: "center" } },
              icon('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3.2"/>', 14, "var(--surface-invert-text)")
            )
          ),
          h("input", {
            "data-field": "profileUsername", value: d.username, placeholder: "Your username",
            style: { width: "220px", border: "none", outline: "none", background: "transparent", textAlign: "center", fontFamily: "var(--serif)", fontSize: "28px", fontWeight: "500", color: "var(--text-primary)", padding: "2px 8px 7px", borderBottom: "1.5px dashed var(--text-faintest)" },
            oninput: (e) => { d.username = e.target.value; },
            onblur: flushRender,
          }),
          fileInput
        ),

        settingsCard(
          settingsRow(
            "Membership",
            [
              h("span", { style: { flexShrink: "0", fontSize: "13px", fontWeight: "500", color: "var(--accent)", background: "var(--danger-bg)", border: "1px solid var(--danger-border)", borderRadius: "12px", padding: "3px 10px" } }, "Free plan"),
              chevronNode(),
            ],
            () => go("membership")
          ),
          settingsRow("Change password", chevronNode(), () => go("changePassword")),
          settingsRow(
            "Appearance",
            h(
              "div",
              { style: { display: "flex", gap: "4px", background: "var(--bg-tint)", padding: "3px", borderRadius: "9999px" } },
              ...[["light", "Light"], ["dark", "Dark"], ["system", "Auto"]].map(([key, label]) => {
                const on = data.theme === key;
                return h(
                  "div",
                  { class: "tap", style: { padding: "5px 11px", borderRadius: "9999px", fontSize: "12px", fontWeight: on ? "600" : "400", background: on ? "var(--surface-invert-bg)" : "transparent", color: on ? "var(--surface-invert-text)" : "var(--text-secondary)" }, onclick: () => setTheme(key) },
                  label
                );
              })
            ),
            null
          ),
          settingsRow("Q&A", chevronNode(), openSupportPage),
          settingsRow(
            "Contact us",
            [
              ui.emailCopiedFlash ? h("span", { style: { fontSize: "13.5px", color: "var(--success)" } }, "Copied ✓") : null,
              chevronNode(),
            ],
            copySupportEmail
          )
        ),

        settingsCard(
          centeredRow("Log out", "var(--text-secondary)", logOut),
          centeredRow(ui.deletingAccount ? "Deleting account…" : "Delete account", ui.deletingAccount ? "#e0a89a" : "var(--accent)", ui.deletingAccount ? null : deleteAccount)
        ),

        h("div", { style: { marginTop: "auto", textAlign: "center", fontSize: "11.5px", color: "var(--text-faint)", letterSpacing: ".3px", padding: "20px 0" } }, "Japanese Sentence Card · v1.0")
      ),

      sheet
    );
  }

  function screenChangePassword() {
    return h(
      "div",
      { style: { minHeight: "100%", background: "var(--bg-page)", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)" } },

      subScreenHeader("Change password", () => go("profile")),

      h(
        "div",
        { style: { padding: "24px 20px 0" } },
        h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "var(--text-faint)" } }, "New password"),
        h("input", {
          "data-field": "pwNew", type: "password", value: ui.pwDraft.password, placeholder: "New password",
          style: { marginTop: "10px", width: "100%", padding: "14px 16px", background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "14px", fontSize: "14px", color: "var(--text-primary)" },
          oninput: (e) => { ui.pwDraft.password = e.target.value; },
          onblur: flushRender,
        }),
        h("input", {
          "data-field": "pwConfirm", type: "password", value: ui.pwDraft.confirm, placeholder: "Confirm new password",
          style: { marginTop: "8px", width: "100%", padding: "14px 16px", background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: "14px", fontSize: "14px", color: "var(--text-primary)" },
          oninput: (e) => { ui.pwDraft.confirm = e.target.value; },
          onblur: flushRender,
        }),
        ui.pwDraft.error ? h("div", { style: { marginTop: "8px", fontSize: "12px", color: "var(--accent)" } }, ui.pwDraft.error) : null,
        h(
          "div",
          { class: ui.pwDraft.password && !ui.pwDraft.busy ? "tap" : "", style: { marginTop: "10px", padding: "13px", borderRadius: "12px", textAlign: "center", background: ui.pwDraft.password && !ui.pwDraft.busy ? "var(--accent)" : "var(--bg-tint)", color: ui.pwDraft.password && !ui.pwDraft.busy ? "var(--text-on-accent)" : "var(--text-primary)", fontSize: "13.5px", fontWeight: "500" }, onclick: ui.pwDraft.password && !ui.pwDraft.busy ? changePassword : null },
          ui.pwDraft.busy ? "Updating…" : "Update password"
        )
      )
    );
  }

  function screenMembership() {
    return h(
      "div",
      { style: { minHeight: "100%", background: "var(--bg-page)", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)" } },

      subScreenHeader("Membership", () => go("profile")),

      h(
        "div",
        { style: { flex: "1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 32px", textAlign: "center", gap: "10px" } },
        h("span", { style: { fontSize: "13px", fontWeight: "500", color: "var(--accent)", background: "var(--danger-bg)", border: "1px solid var(--danger-border)", borderRadius: "12px", padding: "4px 12px" } }, "Free plan"),
        h("div", { style: { marginTop: "10px", fontFamily: "var(--serif)", fontSize: "20px", color: "var(--text-primary)" } }, "More plans are coming soon."),
        h("div", { style: { fontSize: "14px", lineHeight: "1.6", color: "var(--text-secondary)" } }, "Everyone's on the Free plan for now — nothing to do here yet.")
      )
    );
  }

  // ---------------------------------------------------------------------
  // Render dispatch
  // ---------------------------------------------------------------------

  // render() rebuilds the entire DOM tree (see the innerHTML reset below),
  // including destroying and recreating whatever text field is focused —
  // slow, and disruptive enough to native input handling (key-repeat, IME
  // composition, mobile autocorrect) that a short debounce still wasn't
  // enough: ordinary typing has plenty of >200ms gaps between keystrokes,
  // so it kept firing mid-sentence anyway. Free-text fields (front, back,
  // tags, profile, auth) now don't call render() from oninput at all —
  // the browser already shows what you typed with zero help from us;
  // flushRender() reconciles everything else (Save button state, etc.)
  // once you leave the field. scheduleRender() remains only for the
  // search box, where live-updating the results list as you type is the
  // actual point — a search query is short enough that a real debounce
  // rarely lands mid-burst the way it did for longer free-form typing.
  let renderDebounceTimer = null;
  function scheduleRender() {
    clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(() => { renderDebounceTimer = null; render(); }, 400);
  }
  function flushRender() {
    if (renderDebounceTimer) { clearTimeout(renderDebounceTimer); renderDebounceTimer = null; }
    render();
  }

  function render() {
    const root = document.getElementById("app");

    root.querySelectorAll("[data-remember-scroll]").forEach((el) => {
      scrollMemory[el.getAttribute("data-remember-scroll")] = { top: el.scrollTop, left: el.scrollLeft };
    });

    // render() rebuilds the whole DOM tree on every state change, which
    // would otherwise steal focus out from under the user after every
    // keystroke in a text field. Remember which field was focused (by its
    // stable data-field id) and its cursor position, then restore it below.
    let focusInfo = null;
    const active = document.activeElement;
    if (active && root.contains(active) && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      const field = active.getAttribute("data-field");
      if (field) focusInfo = { field, start: active.selectionStart, end: active.selectionEnd };
    }

    root.innerHTML = "";
    const dark = ui.screen === "review" || ui.screen === "done";
    const phone = h("div", { class: "phone" + (dark ? " dark" : ""), "data-remember-scroll": "phone:" + ui.screen });

    let content;
    switch (ui.screen) {
      case "boot": content = screenBoot(); break;
      case "auth": content = screenAuth(); break;
      case "tags": content = screenTags(); break;
      case "review": content = ui.session ? screenReview() : screenHome(); break;
      case "done": content = ui.session ? screenDone() : screenHome(); break;
      case "browse": content = screenBrowse(); break;
      case "add": content = screenAdd(); break;
      case "community": content = screenCommunity(); break;
      case "myTags": content = screenMyTags(); break;
      case "tagDetail": content = ui.tagDetail ? screenTagDetail() : screenCommunity(); break;
      case "shareTag": content = screenShareTag(); break;
      case "profile": content = screenProfile(); break;
      case "changePassword": content = screenChangePassword(); break;
      case "membership": content = screenMembership(); break;
      default: content = screenHome();
    }

    phone.appendChild(content);
    if (ui.cropModal) phone.appendChild(screenCropModal());
    root.appendChild(phone);

    root.querySelectorAll("[data-remember-scroll]").forEach((el) => {
      const m = scrollMemory[el.getAttribute("data-remember-scroll")];
      if (m) { el.scrollTop = m.top; el.scrollLeft = m.left; }
      else if (el.hasAttribute("data-scroll-to-end")) { el.scrollLeft = el.scrollWidth; }
    });

    if (focusInfo) {
      const el = root.querySelector('[data-field="' + focusInfo.field + '"]');
      if (el) {
        el.focus();
        if (typeof focusInfo.start === "number" && el.setSelectionRange) {
          try { el.setSelectionRange(focusInfo.start, focusInfo.end); } catch {}
        } else if (el.value) {
          // Some input types (email, number, ...) don't support
          // setSelectionRange at all — focusing them leaves the caret at
          // position 0, so every keystroke would insert at the *start*
          // instead of the end. Re-assigning the value is a reliable
          // cross-browser way to force the caret to the end instead.
          const v = el.value;
          el.value = "";
          el.value = v;
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Boot: gate the whole app behind auth. Show the app immediately if a
  // (possibly offline-cached) session already exists; otherwise the auth
  // screen. A background timer re-syncs periodically so multi-device
  // changes show up without needing an explicit action.
  // ---------------------------------------------------------------------

  render(); // "boot" screen while we check for a session

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT" && ui.screen !== "auth" && ui.screen !== "boot") resetToAuthScreen();
    // Catches a confirmation link opened in this same tab — supabase-js
    // parses the token out of the URL and fires this before our own
    // signUp()/logIn() would ever have set the screen away from "auth".
    if (event === "SIGNED_IN" && session && (ui.screen === "auth" || ui.screen === "boot")) enterApp(session);
    // Clicking the "reset your password" email link lands here with a
    // temporary recovery session — show the "set a new password" screen
    // instead of whatever was on screen (even a cached logged-in view).
    if (event === "PASSWORD_RECOVERY") {
      ui.auth = blankAuthState();
      ui.auth.mode = "recover";
      ui.screen = "auth";
      render();
    }
  });

  (async () => {
    const session = await getSessionSafe();
    if (session) {
      await enterApp(session);
    } else {
      ui.screen = "auth";
      render();
    }
  })();

  setInterval(() => { syncNow(); }, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncNow();
  });
})();
