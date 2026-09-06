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
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  // Confirmation-email links must redirect back into the app — passed
  // explicitly so it doesn't depend on the Supabase dashboard's Site URL
  // being set correctly.
  const APP_URL = "https://japanesesentencecards.com/";

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

  const SEED_CARDS = [
    ["昨日は泳ぎました。", "Kinō wa oyogimashita.", "I swam yesterday.", ["Past tense", "Daily life"]],
    ["お会計をお願いします。", "Okaikei o onegai shimasu.", "Could I have the bill, please.", ["Restaurant", "Polite form"]],
    ["電車は何時に出ますか。", "Densha wa nanji ni demasu ka.", "What time does the train leave?", ["Travel", "Questions"]],
    ["ちょっと待ってください。", "Chotto matte kudasai.", "Just a moment, please.", ["Polite form", "Daily life"]],
    ["明日、会議があります。", "Ashita, kaigi ga arimasu.", "I have a meeting tomorrow.", ["Work"]],
    ["これ、いくらですか。", "Kore, ikura desu ka.", "How much is this?", ["Shopping", "Questions"]],
    ["傘を忘れました。", "Kasa o wasuremashita.", "I forgot my umbrella.", ["Past tense", "Daily life"]],
    ["日本語で話しましょう。", "Nihongo de hanashimashō.", "Let's speak in Japanese.", ["Daily life"]],
    ["すみません、道に迷いました。", "Sumimasen, michi ni mayoimashita.", "Excuse me, I'm lost.", ["Travel", "Polite form"]],
    ["少し高いと思います。", "Sukoshi takai to omoimasu.", "I think it's a bit expensive.", ["Shopping", "Opinions"]],
    ["資料を送っておきました。", "Shiryō o okutte okimashita.", "I've sent the documents.", ["Work", "Past tense"]],
    ["週末は何をしましたか。", "Shūmatsu wa nani o shimashita ka.", "What did you do on the weekend?", ["Questions", "Past tense"]],
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
      profile: { username: "", photo: null },
      totalActiveMs: 0,
    };
  }

  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return makeSeedData();
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.cards)) return makeSeedData();
      if (!parsed.reviewLog) parsed.reviewLog = {};
      if (!parsed.profile) parsed.profile = { username: "", photo: null };
      if (parsed.profile.name !== undefined && !parsed.profile.username) {
        parsed.profile.username = parsed.profile.name;
      }
      delete parsed.profile.name;
      if (typeof parsed.totalActiveMs !== "number") parsed.totalActiveMs = 0;
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
        saveData();
      }
    }, 15000);
  })();

  // Transient (not persisted) UI/session state
  function blankAuthState() {
    return { mode: "login", email: "", password: "", pendingEmail: "", error: "", busy: false };
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
    activityRange: "year", // "year" | "30d" | "7d"
    tagsEditMode: false,
    session: null, // { queue: [ids], qi, flipped, tags, results }
    cardSavedFlash: false,
    cropModal: null, // { imgSrc, natW, natH, zoom, offsetX, offsetY } while cropping a new profile photo
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

  // Activity range toggle: "year" | "30d" | "7d" — how many days back each covers.
  const ACTIVITY_RANGE_DAYS = { year: 370, "30d": 29, "7d": 6 };

  function rangeStart(daysBack) {
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

  function formatDuration(ms) {
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h <= 0) return m + "m";
    return h + "h " + m + "m";
  }

  // A GitHub-style grid of weeks (Sun-Sat columns) covering the last `daysBack`
  // days, ending today.
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
        week.push(d > end ? null : { count: data.reviewLog[dateKey(d)] || 0 });
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

  const HEAT_COLORS = ["#f0eee6", "#f1d7bc", "#e6a874", "#c96442", "#7a3018"];

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
      back: row.back,
      tags: row.tags || [],
      stability: row.stability,
      difficulty: row.difficulty,
      reps: row.reps,
      lapses: row.lapses,
      lastReviewAt: row.last_review_at ? new Date(row.last_review_at).getTime() : null,
      dueAt: new Date(row.due_at).getTime(),
      audio: row.audio,
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
      const { error } = await sb.from("cards").delete().eq("id", id).eq("user_id", session.user.id);
      if (!error) data.pendingDeletes = data.pendingDeletes.filter((x) => x !== id);
    } catch (e) {
      console.warn("pushDeleteCard failed (offline?)", e);
    }
  }

  async function pushProfile() {
    const session = await getSessionSafe();
    if (!session) return;
    try {
      await sb.from("profiles").upsert({ id: session.user.id, username: data.profile.username || null, photo: data.profile.photo });
    } catch (e) {
      console.warn("pushProfile failed (offline?)", e);
    }
  }

  async function pushReviewDay(day) {
    const session = await getSessionSafe();
    if (!session) return;
    try {
      await sb.from("review_log").upsert({ user_id: session.user.id, day, count: data.reviewLog[day] || 0 });
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
      }

      const remoteCounts = {};
      (remoteLog || []).forEach((r) => { remoteCounts[r.day] = r.count; });
      const mergedLog = Object.assign({}, data.reviewLog);
      (remoteLog || []).forEach((r) => { mergedLog[r.day] = Math.max(mergedLog[r.day] || 0, r.count); });
      data.reviewLog = mergedLog;

      // A day whose local count is still higher than what the server has
      // means an earlier pushReviewDay() never made it through (offline at
      // the time, tab closed mid-request, etc.) — retry it here so a streak
      // recorded on one device isn't silently missing on another. Unlike
      // cards, review-log pushes had no retry path before this.
      for (const day of Object.keys(mergedLog)) {
        if (mergedLog[day] > (remoteCounts[day] || 0)) await pushReviewDay(day);
      }

      const remoteList = (remoteCards || []).filter((r) => !data.pendingDeletes.includes(r.id));

      if (remoteList.length === 0 && data.cards.length === 0) {
        // Brand new account, nothing local either: start with the example deck.
        data.cards = makeSeedData().cards;
        await pushCardsBulk(data.cards);
      } else if (remoteList.length === 0) {
        // Brand new account with existing local cards: claim them as the initial cloud set.
        await pushCardsBulk(data.cards);
      } else {
        const localById = new Map(data.cards.map((c) => [c.id, c]));
        const merged = [];
        const toPush = [];
        const seenIds = new Set();
        for (const row of remoteList) {
          seenIds.add(row.id);
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
      speak(card.front);
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

  // Self-graded recall, FSRS-scheduled: the user judges "did I remember
  // this?" BEFORE the back note is revealed (so the judgment reflects real
  // recall, not a post-hoc read of the answer). That choice both reveals
  // the back and drives the FSRS memory-state update for this card.
  function answerCard(remembered) {
    const s = ui.session;
    const c = currentCard();
    if (!s || !c || s.flipped) return;

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
    s.flipped = true;
    c.updatedAt = now;
    logReviewToday();
    saveData();
    render();
    pushCard(c);
    pushReviewDay(dateKey(new Date()));
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

  // Deleting a tag removes it from every card that has it (tags aren't a
  // separate registry — they're just whatever's on data.cards). A card left
  // with none falls back to UNTAGGED_TAG so it's never truly tag-less.
  function deleteTag(tag) {
    if (tag === UNTAGGED_TAG) return;
    const count = data.cards.filter((c) => c.tags.includes(tag)).length;
    const msg = 'Delete "' + tag + '"? It will be removed from ' + count + " card" + (count === 1 ? "" : "s")
      + (count ? '. Any left with no tags will be marked "' + UNTAGGED_TAG + '".' : ".");
    if (!confirm(msg)) return;
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
    saveData();
    render();
    pushCardsBulk(affected);
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
      editingId: null, front: "", romaji: "", back: "", tags: [], newTag: "",
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
    const wasEditing = !!ui.draft.editingId;
    ui.draft = blankDraft();
    go(wasEditing ? "browse" : "home");
  }

  // ---------------------------------------------------------------------
  // Auto-romaji: generated server-side (Vercel function, /api/romaji) so
  // the browser never runs the heavy tokenizer itself — that's what froze
  // the page the first time this was attempted client-side. Online only;
  // offline, the field just stays manual (see handleFrontBlur below).
  // ---------------------------------------------------------------------

  const JAPANESE_RE = /[぀-ヿ一-龯]/;

  async function generateRomaji(text) {
    try {
      const res = await fetch("/api/romaji", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return typeof data.romaji === "string" ? data.romaji : null;
    } catch (e) {
      console.warn("romaji generation failed (offline?)", e);
      return null;
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
    const romaji = await generateRomaji(front);
    d.romajiLoading = false;

    // The user may have changed the front text again while we were
    // waiting — a stale result for old text shouldn't land anywhere.
    if (d.front.trim() !== front) { render(); return; }
    if (romaji === null) { render(); return; }

    if (d.romajiAuto) {
      d.romaji = romaji;
      d.romajiSuggestion = null;
    } else if (romaji !== d.romaji) {
      d.romajiSuggestion = romaji;
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
    go("profile");
  }

  function cancelProfile() {
    go("home");
  }

  function saveProfile() {
    data.profile = { username: ui.profileDraft.username.trim(), photo: ui.profileDraft.photo };
    saveData();
    go("home");
    pushProfile();
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
        { style: { background: "#f5f4ed", borderRadius: "20px", padding: "22px", width: "100%", maxWidth: "340px" } },
        h("div", { style: { fontSize: "15px", fontWeight: "500", color: "#141413", textAlign: "center", marginBottom: "16px" } }, "Adjust photo"),
        h(
          "div",
          {
            style: { width: CROP_FRAME + "px", height: CROP_FRAME + "px", margin: "0 auto", borderRadius: "9999px", overflow: "hidden", position: "relative", background: "#e5e2d6", touchAction: "none", cursor: "grab" },
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
          h("div", { class: "tap", style: { flex: "1", padding: "13px", borderRadius: "12px", textAlign: "center", fontSize: "14px", color: "#5e5d59", background: "#eeece3" }, onclick: cancelCropModal }, "Cancel"),
          h("div", { class: "tap", style: { flex: "1", padding: "13px", borderRadius: "12px", textAlign: "center", fontSize: "14px", fontWeight: "500", color: "#faf9f5", background: "#c96442" }, onclick: confirmCropModal }, "Use photo")
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
      background: profile.photo ? "transparent" : "#eae7dd",
    };
    if (profile.photo) {
      style.backgroundImage = "url(" + profile.photo + ")";
      style.backgroundSize = "cover";
      style.backgroundPosition = "center";
      return h("div", { style });
    }
    if (initial) {
      return h("div", { style }, h("span", { style: { fontFamily: "var(--serif)", fontSize: Math.round(size * 0.45) + "px", color: "#c96442" } }, initial));
    }
    return h("div", { style }, icon('<path d="M20 21a8 8 0 10-16 0"/><circle cx="12" cy="8" r="5"/>', Math.round(size * 0.55), "#b0aea5"));
  }

  function chipStyle(on) {
    return on
      ? { background: "#141413", border: "1px solid #141413", color: "#faf9f5" }
      : { background: "#faf9f5", border: "1px solid #f0eee6", color: "#141413" };
  }

  function bottomNav(active) {
    const item = (screen, label, path, viewBox = "0 0 24 24") => {
      const on = active === screen;
      const wrap = h("div", {
        class: "tap",
        style: { flex: "1", display: "flex", flexDirection: "column", alignItems: "center", gap: "5px", color: on ? "#c96442" : "#5e5d59" },
        onclick: () => go(screen),
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
          background: "rgba(245,244,237,.92)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
          borderTop: "1px solid #f0eee6", padding: "9px 12px calc(env(safe-area-inset-bottom, 0px) + 18px)",
        },
      },
      item("home", "Review", '<path d="M3 10.5L12 3l9 7.5V21H3z"/>'),
      item("browse", "Cards", '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18"/>'),
      item("add", "Add", '<path d="M12 5v14M5 12h14"/>')
    );
  }

  // ---------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------

  function logoMark() {
    return h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: "9px" } },
      h("div", { style: { height: "26px", padding: "0 7px", borderRadius: "8px", background: "#c96442", color: "#faf9f5", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--serif)", fontSize: "12px", fontWeight: "600", letterSpacing: ".02em" } }, "JSC"),
      h("div", { style: { fontFamily: "var(--serif)", fontSize: "16px", fontWeight: "500", color: "#141413", letterSpacing: ".1px" } }, "Japanese Sentence Card")
    );
  }

  function screenBoot() {
    return h(
      "div",
      { style: { minHeight: "100%", background: "#f5f4ed", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "14px" } },
      logoMark(),
      h("div", { style: { fontSize: "13px", color: "#b0aea5" } }, "Loading…")
    );
  }

  function authField(dataField, type, value, placeholder, onInput) {
    return h("input", {
      "data-field": dataField, type, value, placeholder,
      style: { width: "100%", padding: "16px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "14px", fontSize: "15px", color: "#141413" },
      oninput: onInput,
      onblur: flushRender,
    });
  }

  function authButton(label, busyLabel, enabled, busy, onClick) {
    return h(
      "div",
      { class: enabled && !busy ? "tap" : "", style: { marginTop: "16px", padding: "16px", borderRadius: "14px", textAlign: "center", fontSize: "15px", fontWeight: "500", background: enabled ? "#c96442" : "#f0eee6", color: enabled ? "#faf9f5" : "#b0aea5" }, onclick: enabled && !busy ? onClick : null },
      busy ? busyLabel : label
    );
  }

  function screenAuth() {
    const a = ui.auth;

    const errorNode = a.error ? h("div", { style: { marginTop: "14px", fontSize: "13px", color: "#c96442", lineHeight: "1.5" } }, a.error) : null;

    let title, subtitle, body;

    if (a.mode === "verify") {
      title = "Check your email.";
      subtitle = "We sent a confirmation link to " + a.pendingEmail + ". Open it, then come back here and tap the button below — even if the link itself shows an error page, your account will already be confirmed and ready to use.";
      body = [
        authButton("I've confirmed — check again", "Checking…", true, a.busy, checkIfConfirmed),
        errorNode,
        h("div", { style: { marginTop: "18px", display: "flex", justifyContent: "space-between" } },
          h("div", { class: "tap", style: { fontSize: "13px", color: "#5e5d59" }, onclick: () => switchAuthMode("signup") }, "Use a different email"),
          h("div", { class: "tap", style: { fontSize: "13px", color: "#c96442" }, onclick: resendConfirmationEmail }, "Resend email")
        ),
      ];
    } else if (a.mode === "signup") {
      title = "Create your account.";
      subtitle = "Your cards, tags and review history will sync to any device you log into.";
      body = [
        authField("authEmail", "email", a.email, "Email", (e) => { a.email = e.target.value; if (!e.isComposing) scheduleRender(); }),
        h("div", { style: { height: "10px" } }),
        authField("authPassword", "password", a.password, "Password (min 6 characters)", (e) => { a.password = e.target.value; if (!e.isComposing) scheduleRender(); }),
        authButton("Create account", "Creating…", !!(a.email.trim() && a.password), a.busy, signUp),
        errorNode,
        h("div", { style: { marginTop: "18px", textAlign: "center", fontSize: "13px", color: "#5e5d59" } },
          "Already have an account? ",
          h("span", { class: "tap", style: { color: "#c96442" }, onclick: () => switchAuthMode("login") }, "Log in")
        ),
      ];
    } else {
      title = "Welcome back.";
      subtitle = "Log in to pick up right where you left off.";
      body = [
        authField("authEmail", "email", a.email, "Email", (e) => { a.email = e.target.value; if (!e.isComposing) scheduleRender(); }),
        h("div", { style: { height: "10px" } }),
        authField("authPassword", "password", a.password, "Password", (e) => { a.password = e.target.value; if (!e.isComposing) scheduleRender(); }),
        authButton("Log in", "Logging in…", !!(a.email.trim() && a.password), a.busy, logIn),
        errorNode,
        h("div", { style: { marginTop: "18px", textAlign: "center", fontSize: "13px", color: "#5e5d59" } },
          "New here? ",
          h("span", { class: "tap", style: { color: "#c96442" }, onclick: () => switchAuthMode("signup") }, "Create an account")
        ),
      ];
    }

    return h(
      "div",
      { style: { minHeight: "100%", background: "#f5f4ed", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)" } },
      h("div", { style: { padding: "8px 20px 0" } }, logoMark()),
      h(
        "div",
        { style: { flex: "1", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 20px" } },
        h("div", { style: { fontFamily: "var(--serif)", fontSize: "28px", lineHeight: "1.15", color: "#141413" } }, title),
        h("div", { style: { marginTop: "8px", fontSize: "14px", lineHeight: "1.6", color: "#5e5d59" } }, subtitle),
        h("div", { style: { marginTop: "26px" } }, ...body)
      )
    );
  }

  function statTile(label, value) {
    return h(
      "div",
      { style: { background: "#f5f4ed", borderRadius: "12px", padding: "13px 14px" } },
      h("div", { style: { fontSize: "10.5px", letterSpacing: ".05em", textTransform: "uppercase", color: "#b0aea5" } }, label),
      h("div", { style: { marginTop: "6px", fontFamily: "var(--serif)", fontSize: "19px", color: "#141413" } }, value)
    );
  }

  function screenHome() {
    const tags = allTags();
    const due = dueCards(null);
    const rangeDays = ACTIVITY_RANGE_DAYS[ui.activityRange];
    const weeks = heatmapWeeks(ACTIVITY_RANGE_DAYS.year); // heatmap always shows the full year; only the tiles respect the range toggle
    const maxCount = Math.max(1, ...weeks.flat().filter(Boolean).map((c) => c.count));

    const dueLine = due.length
      ? due.length + " cards are due across " + tags.filter((t) => dueCards([t]).length).length + " tags. Sessions run " + SESSION_SIZE + " cards at a time."
      : "Nothing due. Add a sentence you heard today.";

    return h(
      "div",
      { style: { minHeight: "100%", background: "#f5f4ed", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)" } },

      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 20px 14px" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "9px" } },
          h("div", { style: { height: "26px", padding: "0 7px", borderRadius: "8px", background: "#c96442", color: "#faf9f5", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--serif)", fontSize: "12px", fontWeight: "600", letterSpacing: ".02em" } }, "JSC"),
          h("div", { style: { fontFamily: "var(--serif)", fontSize: "16px", fontWeight: "500", color: "#141413", letterSpacing: ".1px" } }, "Japanese Sentence Card")
        ),
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "10px" } },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "6px", padding: "5px 11px 5px 9px", borderRadius: "9999px", background: "#faf9f5", border: "1px solid #f0eee6", fontSize: "12px", color: "#5e5d59" } },
            icon('<path d="M8.5 14.5A2.5 2.5 0 0011 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 11-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 002.5 2.5z"/>', 13, "#c96442"),
            h("b", { style: { fontWeight: "600", color: "#141413" } }, String(streakDays())), " days"
          ),
          h("div", { class: "tap", style: { borderRadius: "9999px", border: "1px solid #f0eee6" }, onclick: openProfile }, avatarNode(data.profile, 30))
        )
      ),

      h(
        "div",
        { style: { padding: "6px 20px 0" } },
        h("div", { style: { fontFamily: "var(--serif)", fontSize: "30px", lineHeight: "1.15", color: "#141413", letterSpacing: "-.2px" } }, data.profile.username && data.profile.username.trim() ? "Ready for today, " + data.profile.username.trim() + "." : "Ready for today."),
        h("div", { style: { marginTop: "8px", fontSize: "14px", lineHeight: "1.6", color: "#5e5d59" } }, dueLine)
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
        { style: { margin: "24px 20px 0", padding: "18px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "18px" } },

        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
          h("div", { style: { fontFamily: "var(--serif)", fontSize: "17px", color: "#141413" } }, "Activity"),
          h(
            "div",
            { style: { display: "flex", gap: "4px", background: "#f0eee6", padding: "3px", borderRadius: "9999px" } },
            ...[["year", "All"], ["30d", "30d"], ["7d", "7d"]].map(([key, label]) => {
              const on = ui.activityRange === key;
              return h(
                "div",
                { class: "tap", style: { padding: "5px 11px", borderRadius: "9999px", fontSize: "12px", fontWeight: on ? "600" : "400", background: on ? "#141413" : "transparent", color: on ? "#faf9f5" : "#5e5d59" }, onclick: () => { ui.activityRange = key; render(); } },
                label
              );
            })
          )
        ),

        h(
          "div",
          { style: { marginTop: "14px", display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "8px" } },
          statTile("Cards", String(data.cards.length)),
          statTile("Reviewed", String(cardsReviewedInLastDays(rangeDays))),
          statTile("Active days", String(activeDaysInLastDays(rangeDays))),
          statTile("Current streak", streakDays() + "d"),
          statTile("Longest streak", longestStreak() + "d"),
          statTile("Time in app", formatDuration(data.totalActiveMs))
        ),

        h(
          "div",
          { class: "scrollx", "data-remember-scroll": "home-heatmap", "data-scroll-to-end": "true", style: { marginTop: "16px", alignItems: "flex-start" } },
          ...weeks.map((week) =>
            h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "3px", flexShrink: "0" } },
              ...week.map((cell) =>
                h("div", {
                  style: {
                    width: "10px", height: "10px", borderRadius: "2px",
                    background: cell ? HEAT_COLORS[heatLevel(cell.count, maxCount)] : "transparent",
                  },
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
      { style: { minHeight: "100%", background: "#f5f4ed", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)" } },

      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "10px", padding: "8px 20px 0" } },
        h("div", { class: "tap", style: { width: "34px", height: "34px", borderRadius: "10px", background: "#faf9f5", border: "1px solid #f0eee6", display: "flex", alignItems: "center", justifyContent: "center" }, onclick: () => go("home") }, icon('<path d="M19 12H5M12 19l-7-7 7-7"/>', 16, "#141413")),
        h("div", { style: { fontSize: "13px", color: "#5e5d59" } }, ui.tagsEditMode ? "Manage tags" : "Step 1 of 2"),
        h("div", { style: { flex: "1" } }),
        h("div", { class: "tap", style: { fontSize: "13px", color: "#c96442" }, onclick: () => { ui.tagsEditMode = !ui.tagsEditMode; render(); } }, ui.tagsEditMode ? "Done" : "Edit tags")
      ),

      h(
        "div",
        { style: { padding: "18px 20px 0" } },
        h("div", { style: { fontFamily: "var(--serif)", fontSize: "28px", lineHeight: "1.15", color: "#141413" } }, ui.tagsEditMode ? "Manage your tags." : "Which tags today?"),
        h(
          "div",
          { style: { marginTop: "8px", fontSize: "14px", lineHeight: "1.6", color: "#5e5d59" } },
          ui.tagsEditMode ? 'Tap × to delete a tag from every card. Cards left with none are marked "' + UNTAGGED_TAG + '".' : "Pick one or several. Only cards that are due in those tags enter the session."
        )
      ),

      h(
        "div",
        { style: { margin: "20px 20px 0", display: "flex", flexWrap: "wrap", gap: "9px" } },
        ...tags.map((t) => {
          if (ui.tagsEditMode) {
            const deletable = t !== UNTAGGED_TAG;
            return h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "9px", padding: "11px 12px 11px 15px", borderRadius: "9999px", background: "#faf9f5", border: "1px solid #f0eee6" } },
              h("span", { style: { fontSize: "14px", color: "#141413" } }, t),
              deletable
                ? h("div", { class: "tap", style: { width: "20px", height: "20px", borderRadius: "9999px", background: "#f0eee6", display: "flex", alignItems: "center", justifyContent: "center" }, onclick: () => deleteTag(t) }, icon('<path d="M18 6L6 18M6 6l12 12"/>', 11, "#c96442"))
                : h("span", { style: { fontSize: "10.5px", color: "#b0aea5" } }, "default")
            );
          }
          const on = ui.sel.includes(t);
          return h(
            "div",
            { class: "tap chip", style: Object.assign({ display: "flex", alignItems: "center", gap: "9px", padding: "11px 15px", borderRadius: "9999px" }, chipStyle(on)), onclick: () => toggleTagSel(t) },
            h("span", { style: { fontSize: "14px" } }, t),
            h("span", { style: { fontSize: "11.5px", color: on ? "rgba(250,249,245,.6)" : "#b0aea5" } }, dueCards([t]).length + " due")
          );
        })
      ),

      ui.tagsEditMode ? null : h(
        "div",
        { style: { margin: "24px 20px 0", padding: "16px 18px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "14px" } },
        h(
          "div",
          { style: { fontSize: "12px", color: "#5e5d59", lineHeight: "1.6" } },
          ui.sel.length
            ? ui.sel.join(" · ") + " — " + selDue + " cards due, " + n + " in this session."
            : "No tags picked yet. Leave it empty to review everything due (" + due + " cards)."
        )
      ),

      h("div", { style: { flex: "1" } }),

      ui.tagsEditMode ? null : h(
        "div",
        { style: { position: "sticky", bottom: "0", padding: "14px 20px calc(env(safe-area-inset-bottom, 0px) + 22px)", background: "rgba(245,244,237,.94)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", borderTop: "1px solid #f0eee6" } },
        n
          ? h(
              "div",
              { class: "tap", style: { padding: "16px", borderRadius: "14px", textAlign: "center", fontSize: "15px", fontWeight: "500", background: "#c96442", color: "#faf9f5" }, onclick: () => beginSession(ui.sel) },
              "Review " + n + " cards"
            )
          : practiceN
            ? h(
                "div",
                { class: "tap", style: { padding: "16px", borderRadius: "14px", textAlign: "center", fontSize: "15px", fontWeight: "500", background: "#141413", color: "#faf9f5" }, onclick: () => beginSession(ui.sel, true) },
                "Nothing due — practice " + practiceN + " anyway"
              )
            : h(
                "div",
                { style: { padding: "16px", borderRadius: "14px", textAlign: "center", fontSize: "15px", fontWeight: "500", background: "#f0eee6", color: "#b0aea5" } },
                "No cards in these tags"
              )
      )
    );
  }

  // Human-readable label for the gap between two timestamps (used to show
  // the FSRS-computed next-review schedule right after the user answers).
  function formatGap(ms) {
    if (ms <= 60 * 1000) return "a minute";
    if (ms < 60 * 60 * 1000) return Math.round(ms / 60000) + " minutes";
    const days = Math.round(ms / 86400000);
    if (days <= 0) return "less than a day";
    if (days === 1) return "1 day";
    if (days < 30) return days + " days";
    if (days < 365) return Math.round(days / 30) + " months";
    return (days / 365).toFixed(1) + " years";
  }

  function screenReview() {
    const s = ui.session;
    const c = currentCard();
    const progressPct = Math.round(((s.qi + (s.flipped ? 0.5 : 0)) / Math.max(1, s.queue.length)) * 100);

    const flipZone = h(
      "div",
      { style: { marginTop: "18px", flex: "1", background: "#faf9f5", borderRadius: "28px", padding: "34px 26px", display: "flex", flexDirection: "column", boxShadow: "0 4px 24px rgba(0,0,0,.28)" } }
    );

    if (!s.flipped) {
      flipZone.appendChild(
        h(
          "div",
          { class: "anim-in", style: { flex: "1", display: "flex", flexDirection: "column", justifyContent: "center" } },
          h("div", { style: { fontFamily: "var(--jp)", fontSize: "29px", lineHeight: "1.5", color: "#141413" } }, c.front),
          h("div", { style: { marginTop: "14px", fontSize: "13.5px", color: "#5e5d59", letterSpacing: ".2px" } }, c.romaji || "")
        )
      );
      flipZone.appendChild(
        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" } },
          h(
            "div",
            { class: "tap", style: { display: "flex", alignItems: "center", gap: "11px", padding: "10px 16px 10px 12px", borderRadius: "9999px", background: "#f5f4ed", border: "1px solid #f0eee6" }, onclick: () => playCardAudio(c) },
            icon('<path d="M8 5l11 7-11 7z"/>', 16, "#c96442"),
            h("span", { style: { fontSize: "11.5px", color: "#5e5d59" } }, c.audio && c.audio.type === "voice" ? "your voice" : "play audio")
          ),
          h("div", { style: { fontSize: "12px", color: "#b0aea5" } }, "Recall it, then judge yourself")
        )
      );
    } else {
      const gap = formatGap(c.dueAt - c.lastReviewAt);
      flipZone.appendChild(
        h(
          "div",
          { class: "anim-in", style: { display: "flex", flexDirection: "column", height: "100%" } },
          h("div", { style: { fontFamily: "var(--jp)", fontSize: "16px", lineHeight: "1.5", color: "#5e5d59", paddingBottom: "18px", borderBottom: "1px solid #f0eee6" } }, c.front),
          h("div", { style: { flex: "1", display: "flex", alignItems: "center" } }, h("div", { style: { fontFamily: "var(--serif)", fontSize: "26px", lineHeight: "1.35", color: "#141413" } }, c.back)),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" } },
            h(
              "div",
              { class: "tap", style: { display: "flex", alignItems: "center", gap: "11px", padding: "10px 16px 10px 12px", borderRadius: "9999px", background: "#f5f4ed", border: "1px solid #f0eee6" }, onclick: () => playCardAudio(c) },
              icon('<path d="M8 5l11 7-11 7z"/>', 16, "#c96442"),
              h("span", { style: { fontSize: "11.5px", color: "#5e5d59" } }, c.audio && c.audio.type === "voice" ? "your voice" : "play audio")
            ),
            h("div", { style: { fontSize: "11.5px", color: "#b0aea5" } }, "Reviewed " + c.reps + " · next in " + gap)
          )
        )
      );
    }

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

      s.flipped
        ? h("div", { class: "tap", style: { marginTop: "16px", padding: "16px", borderRadius: "14px", textAlign: "center", background: "#c96442", color: "#faf9f5", fontSize: "15px", fontWeight: "500" }, onclick: nextCard }, "Next card")
        : h(
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

  function screenBrowse() {
    const tags = browsableTags();
    const q = ui.query.trim().toLowerCase();
    const list = data.cards.filter((x) => {
      const okQ = !q || x.front.toLowerCase().includes(q) || x.back.toLowerCase().includes(q) || x.tags.join(" ").toLowerCase().includes(q);
      const okFilter = ui.filter === "All"
        || (ui.filter === RECENT_TAG ? Date.now() - x.createdAt <= RECENT_MS : x.tags.includes(ui.filter));
      return okQ && okFilter;
    });

    return h(
      "div",
      { style: { minHeight: "100%", background: "#f5f4ed", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)" } },

      h("div", { style: { padding: "8px 20px 0", fontFamily: "var(--serif)", fontSize: "28px", color: "#141413" } }, "Cards"),

      h(
        "div",
        { style: { margin: "14px 20px 0", display: "flex", alignItems: "center", gap: "10px", padding: "11px 14px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "12px" } },
        icon('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4.5-4.5"/>', 15, "#b0aea5"),
        h("input", { "data-field": "query", value: ui.query, placeholder: "Search sentence, note or tag", style: { flex: "1", border: "none", outline: "none", background: "transparent", fontSize: "14px", color: "#141413" }, oninput: (e) => { ui.query = e.target.value; if (!e.isComposing) scheduleRender(); }, onblur: flushRender })
      ),

      h(
        "div",
        { class: "scrollx", "data-remember-scroll": "browse-filters", style: { margin: "14px 0 0", padding: "0 20px" } },
        ...["All", RECENT_TAG].concat(tags).map((f) => {
          const on = ui.filter === f;
          return h("div", { class: "tap chip", style: Object.assign({ padding: "8px 14px", borderRadius: "9999px", fontSize: "12.5px", whiteSpace: "nowrap" }, chipStyle(on)), onclick: () => { ui.filter = f; render(); } }, f);
        })
      ),

      h("div", { style: { margin: "16px 20px 0", fontSize: "11.5px", color: "#b0aea5" } }, list.length + " of " + data.cards.length + " cards"),

      h(
        "div",
        { style: { margin: "10px 20px 0", display: "flex", flexDirection: "column", gap: "8px" } },
        ...list.map((c) =>
          h(
            "div",
            { class: "tap row-hover", style: { padding: "15px 16px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "12px" }, onclick: () => openEditCard(c) },
            h(
              "div",
              { style: { display: "flex", alignItems: "flex-start", gap: "12px" } },
              h(
                "div",
                { style: { flex: "1", minWidth: "0" } },
                h("div", { style: { fontFamily: "var(--jp)", fontSize: "16px", lineHeight: "1.5", color: "#141413" } }, c.front),
                h("div", { style: { marginTop: "5px", fontSize: "13px", color: "#5e5d59" } }, c.back)
              ),
              c.audio
                ? h("div", { class: "tap", style: { width: "30px", height: "30px", borderRadius: "9999px", background: "#f5f4ed", border: "1px solid #f0eee6", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: "0" }, onclick: (e) => { e.stopPropagation(); playCardAudio(c); } }, icon('<path d="M8 5l11 7-11 7z"/>', 12, "#c96442"))
                : icon('<path d="M9 18l6-6-6-6"/>', 15, "#ddd8c8", { style: "flex-shrink:0;margin-top:7px" })
            ),
            h(
              "div",
              { style: { marginTop: "11px", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
              ...c.tags.map((t) => h("div", { style: { padding: "4px 9px", borderRadius: "9999px", background: "#f0eee6", color: "#5e5d59", fontSize: "10.5px" } }, t)),
              h(
                "div",
                { style: { marginLeft: "auto" } },
                h("span", { style: { fontSize: "10.5px", color: c.dueAt <= Date.now() ? "#c96442" : "#b0aea5" } }, dueLabel(c))
              )
            )
          )
        )
      ),
      h("div", { style: { height: "24px" } }),

      bottomNav("browse")
    );
  }

  function screenAdd() {
    const d = ui.draft;
    const tags = allTags();
    const canSave = d.front.trim() && d.back.trim();

    const audioModePanel = d.audioMode === "system"
      ? h(
          "div",
          { style: { marginTop: "10px", padding: "18px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "16px" } },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "15px" } },
            h(
              "div",
              { class: "tap", style: { width: "52px", height: "52px", borderRadius: "9999px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: "0", background: d.front.trim() ? "#f5f4ed" : "#f0eee6" }, onclick: () => d.front.trim() && speak(d.front) },
              icon('<path d="M8 5l11 7-11 7z"/>', 19, "#c96442")
            ),
            h(
              "div",
              { style: { flex: "1", minWidth: "0" } },
              h("div", { style: { fontSize: "13.5px", color: "#141413" } }, d.front.trim() ? "Tap to preview" : "Type a sentence to generate audio"),
              h("div", { style: { marginTop: "4px", fontSize: "11.5px", color: "#b0aea5" } }, "Spoken aloud automatically during review")
            )
          )
        )
      : h(
          "div",
          { style: { marginTop: "10px", padding: "18px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "16px", display: "flex", alignItems: "center", gap: "15px" } },
          h(
            "div",
            { class: "tap", style: { width: "52px", height: "52px", borderRadius: "9999px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: "0", background: d.recState === "active" ? "#d97757" : "#141413" }, onclick: tapRecord },
            d.recState === "idle"
              ? icon('<path d="M12 3a3 3 0 013 3v6a3 3 0 01-6 0V6a3 3 0 013-3z"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>', 21, "#faf9f5")
              : d.recState === "active"
                ? h("div", { style: { width: "16px", height: "16px", borderRadius: "3px", background: "#faf9f5", animation: "sc-rec 1.1s ease-in-out infinite" } })
                : icon('<path d="M8 5l11 7-11 7z"/>', 19, "#faf9f5")
          ),
          h(
            "div",
            { style: { flex: "1", minWidth: "0" } },
            h("div", { style: { fontSize: "13.5px", color: "#141413" } }, d.recState === "idle" ? "Tap to record your voice" : d.recState === "active" ? "Recording · 0:0" + d.recSec : "Recorded · tap to play"),
            d.recState !== "idle" ? h("div", { style: { marginTop: "8px", fontSize: "11px", color: "#b0aea5" } }, d.recState === "active" ? "Tap again to stop" : "") : null
          ),
          d.recState === "done" ? h("div", { class: "tap", style: { fontSize: "12px", color: "#5e5d59", flexShrink: "0" }, onclick: () => { d.recState = "idle"; d.recording = null; render(); } }, "Redo") : null
        );

    return h(
      "div",
      { style: { minHeight: "100%", background: "#f5f4ed", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)" } },

      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 20px 0" } },
        h("div", { class: "tap", style: { fontSize: "14px", color: "#5e5d59" }, onclick: cancelCardForm }, "Cancel"),
        h("div", { style: { fontSize: "13px", color: ui.cardSavedFlash ? "#3a9d5d" : "#b0aea5" } }, ui.cardSavedFlash ? "Saved ✓" : d.editingId ? "Edit card" : "New card"),
        h("div", { class: canSave ? "tap" : "", style: { fontSize: "14px", fontWeight: "500", color: canSave ? "#c96442" : "#b0aea5" }, onclick: canSave ? saveCard : null }, "Save")
      ),

      h(
        "div",
        { style: { padding: "22px 20px 0" } },
        h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "#b0aea5" } }, "Front · sentence"),
        h("textarea", { "data-field": "front", rows: "2", placeholder: "昨日は泳ぎました。", style: { marginTop: "10px", width: "100%", resize: "none", padding: "16px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "14px", fontFamily: "var(--jp)", fontSize: "19px", lineHeight: "1.5", color: "#141413" }, oninput: (e) => { d.front = e.target.value; if (!e.isComposing) scheduleRender(); }, onblur: handleFrontBlur }, d.front)
      ),

      h(
        "div",
        { style: { padding: "16px 20px 0" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
          h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "#b0aea5" } }, "Romaji · optional"),
          d.romajiLoading ? h("div", { style: { fontSize: "11px", color: "#b0aea5" } }, "Generating…") : null
        ),
        h("input", { "data-field": "romaji", value: d.romaji, placeholder: "Kinō wa oyogimashita.", style: { marginTop: "10px", width: "100%", padding: "14px 16px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "14px", fontSize: "14px", color: "#141413" }, oninput: (e) => { d.romaji = e.target.value; d.romajiAuto = false; d.romajiSuggestion = null; if (!e.isComposing) scheduleRender(); }, onblur: flushRender }),
        d.romajiSuggestion
          ? h(
              "div",
              { class: "tap", style: { marginTop: "8px", fontSize: "12.5px", color: "#c96442" }, onclick: acceptRomajiSuggestion },
              "Suggested: " + d.romajiSuggestion + " · Tap to use"
            )
          : null
      ),

      h(
        "div",
        { style: { padding: "20px 20px 0" } },
        h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "#b0aea5" } }, "Back · note"),
        h("textarea", { "data-field": "back", rows: "2", placeholder: "I swam yesterday.", style: { marginTop: "10px", width: "100%", resize: "none", padding: "16px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "14px", fontFamily: "var(--serif)", fontSize: "17px", lineHeight: "1.5", color: "#141413" }, oninput: (e) => { d.back = e.target.value; if (!e.isComposing) scheduleRender(); }, onblur: flushRender }, d.back)
      ),

      h(
        "div",
        { style: { padding: "20px 20px 0" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between" } },
          h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "#b0aea5" } }, "Tags · optional"),
          h("div", { style: { fontSize: "11.5px", color: "#b0aea5" } }, d.tags.length ? d.tags.length + " selected" : 'defaults to "' + UNTAGGED_TAG + '"')
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
          h("input", { "data-field": "newTag", value: d.newTag, placeholder: "New tag", style: { flex: "1", padding: "11px 14px", background: "#faf9f5", border: "1px dashed #ddd8c8", borderRadius: "9999px", fontSize: "13px", color: "#141413" }, oninput: (e) => { d.newTag = e.target.value; if (!e.isComposing) scheduleRender(); }, onblur: flushRender, onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); addNewTag(); } } }),
          h("div", { class: "tap", style: { padding: "11px 18px", borderRadius: "9999px", background: "#f0eee6", color: "#141413", fontSize: "13px" }, onclick: addNewTag }, "Add")
        )
      ),

      h(
        "div",
        { style: { padding: "22px 20px 0" } },
        h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "#b0aea5" } }, "Audio · optional"),
        h(
          "div",
          { style: { marginTop: "11px", display: "flex", gap: "4px", padding: "4px", background: "#f0eee6", borderRadius: "12px" } },
          ...[
            { key: "system", name: "Generated", note: "Read from the sentence" },
            { key: "record", name: "Your voice", note: "Record it yourself" },
          ].map((m) => {
            const on = d.audioMode === m.key;
            return h(
              "div",
              { class: "tap", style: { flex: "1", padding: "9px 10px", borderRadius: "9px", textAlign: "center", background: on ? "#faf9f5" : "transparent", border: "1px solid " + (on ? "#e6e3d8" : "transparent") }, onclick: () => { d.audioMode = m.key === "record" ? "record" : "system"; render(); } },
              h("div", { style: { fontSize: "13px", fontWeight: "500", color: on ? "#141413" : "#5e5d59" } }, m.name),
              h("div", { style: { marginTop: "2px", fontSize: "10.5px", color: on ? "#5e5d59" : "#b0aea5" } }, m.note)
            );
          })
        ),
        audioModePanel
      ),

      h("div", { style: { padding: "20px 20px 0", fontSize: "12px", lineHeight: "1.7", color: "#b0aea5" } }, "Audio plays automatically when the card appears in review. Generated audio is read from the front of the card — record your own voice instead when pronunciation or intonation is the thing you want to practise."),

      d.editingId
        ? h(
            "div",
            { style: { padding: "26px 20px 0" } },
            h("div", { class: "tap", style: { padding: "16px", borderRadius: "14px", textAlign: "center", border: "1px solid #f0eee6", color: "#c96442", fontSize: "14px", fontWeight: "500" }, onclick: deleteCard }, "Delete card")
          )
        : null,

      h("div", { style: { height: "40px" } })
    );
  }

  function screenProfile() {
    const d = ui.profileDraft;

    const fileInput = h("input", {
      type: "file", accept: "image/*", style: { display: "none" },
      onchange: (e) => { const f = e.target.files && e.target.files[0]; if (f) handlePhotoFile(f); e.target.value = ""; },
    });

    return h(
      "div",
      { style: { minHeight: "100%", background: "#f5f4ed", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)" } },

      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 20px 0" } },
        h("div", { class: "tap", style: { fontSize: "14px", color: "#5e5d59" }, onclick: cancelProfile }, "Cancel"),
        h("div", { style: { fontSize: "13px", color: "#b0aea5" } }, "Your profile"),
        h("div", { class: "tap", style: { fontSize: "14px", fontWeight: "500", color: "#c96442" }, onclick: saveProfile }, "Save")
      ),

      h(
        "div",
        { style: { padding: "18px 20px 0", fontSize: "14px", lineHeight: "1.6", color: "#5e5d59", fontStyle: "italic" } },
        "We'll greet you by username. Add a photo if you'd like — it follows you to any device you log in on."
      ),

      h(
        "div",
        { style: { margin: "22px 20px 0", display: "flex", alignItems: "center", gap: "14px" } },
        avatarNode(d, 72),
        fileInput,
        h(
          "div",
          { class: "tap", style: { padding: "12px 18px", borderRadius: "12px", background: "#faf9f5", border: "1px solid #f0eee6", fontSize: "14px", color: "#141413" }, onclick: () => fileInput.click() },
          d.photo ? "Change photo" : "Upload photo"
        ),
        d.photo ? h("div", { class: "tap", style: { fontSize: "12.5px", color: "#5e5d59" }, onclick: () => { d.photo = null; render(); } }, "Remove") : null
      ),

      h(
        "div",
        { style: { padding: "24px 20px 0" } },
        h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "#b0aea5" } }, "Username"),
        h("input", {
          "data-field": "profileUsername", value: d.username, placeholder: "Your username",
          style: { marginTop: "10px", width: "100%", padding: "16px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "14px", fontFamily: "var(--serif)", fontSize: "19px", color: "#141413" },
          oninput: (e) => { d.username = e.target.value; if (!e.isComposing) scheduleRender(); },
          onblur: flushRender,
        })
      ),

      h(
        "div",
        { style: { padding: "30px 20px 0" } },
        h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "#b0aea5" } }, "Change password"),
        h("input", {
          "data-field": "pwNew", type: "password", value: ui.pwDraft.password, placeholder: "New password",
          style: { marginTop: "10px", width: "100%", padding: "14px 16px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "14px", fontSize: "14px", color: "#141413" },
          oninput: (e) => { ui.pwDraft.password = e.target.value; if (!e.isComposing) scheduleRender(); },
          onblur: flushRender,
        }),
        h("input", {
          "data-field": "pwConfirm", type: "password", value: ui.pwDraft.confirm, placeholder: "Confirm new password",
          style: { marginTop: "8px", width: "100%", padding: "14px 16px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "14px", fontSize: "14px", color: "#141413" },
          oninput: (e) => { ui.pwDraft.confirm = e.target.value; if (!e.isComposing) scheduleRender(); },
          onblur: flushRender,
        }),
        ui.pwDraft.error ? h("div", { style: { marginTop: "8px", fontSize: "12px", color: "#c96442" } }, ui.pwDraft.error) : null,
        h(
          "div",
          { class: ui.pwDraft.password && !ui.pwDraft.busy ? "tap" : "", style: { marginTop: "10px", padding: "13px", borderRadius: "12px", textAlign: "center", background: "#f0eee6", color: "#141413", fontSize: "13.5px", fontWeight: "500" }, onclick: ui.pwDraft.password && !ui.pwDraft.busy ? changePassword : null },
          ui.pwDraft.busy ? "Updating…" : "Update password"
        )
      ),

      h(
        "div",
        { style: { padding: "30px 20px 0" } },
        h("div", { class: "tap", style: { padding: "14px", borderRadius: "12px", textAlign: "center", border: "1px solid #f0eee6", color: "#5e5d59", fontSize: "13.5px" }, onclick: logOut }, "Log out")
      ),

      h("div", { style: { height: "40px" } })
    );
  }

  // ---------------------------------------------------------------------
  // Render dispatch
  // ---------------------------------------------------------------------

  // render() rebuilds the entire DOM tree (see the innerHTML reset below),
  // including destroying and recreating whatever text field is focused.
  // Calling that on every single keystroke made typing feel sluggish and,
  // worse, could interrupt the browser's native key-repeat when holding
  // Backspace — the field kept getting torn down and refocused mid-repeat.
  // scheduleRender() coalesces bursts of typing/holding a key into one
  // render shortly after they pause, while state itself (d.front, etc.)
  // still updates every keystroke — flushRender() forces it immediately
  // for moments (like leaving the field) that want no lag at all.
  let renderDebounceTimer = null;
  function scheduleRender() {
    clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(() => { renderDebounceTimer = null; render(); }, 200);
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
      case "profile": content = screenProfile(); break;
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
