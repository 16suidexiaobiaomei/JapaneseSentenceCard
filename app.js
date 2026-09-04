// Sentence Cards — Japanese sentence flashcard SRS
// Vanilla JS, no build step. Persists to localStorage, uses real
// speech synthesis for "generated" audio and MediaRecorder for "your voice".

(() => {
  "use strict";

  const STORAGE_KEY = "sentence-cards-v1";
  const SESSION_SIZE = 10;
  const AUTOPLAY_AUDIO = true;

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
      })),
      reviewLog: {}, // "YYYY-MM-DD" -> count
      profile: { name: "", photo: null },
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
      if (!parsed.profile) parsed.profile = { name: "", photo: null };
      if (typeof parsed.totalActiveMs !== "number") parsed.totalActiveMs = 0;
      parsed.cards.forEach((c) => {
        if (c.stability === undefined) c.stability = null;
        if (c.difficulty === undefined) c.difficulty = null;
        if (c.reps === undefined) c.reps = c.seen || 0;
        if (c.lapses === undefined) c.lapses = 0;
        if (c.lastReviewAt === undefined) c.lastReviewAt = null;
        delete c.box;
        delete c.seen;
      });
      return parsed;
    } catch {
      return makeSeedData();
    }
  }

  let data = loadData();

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
      if (document.visibilityState === "visible" && delta > 0 && delta < 60000) {
        data.totalActiveMs += delta;
        saveData();
      }
    }, 15000);
  })();

  // Transient (not persisted) UI/session state
  let ui = {
    screen: "home",
    sel: [], // selected tags on the tags screen
    query: "",
    filter: "All",
    draft: { editingId: null, front: "", back: "", tags: [], newTag: "", audioMode: "system", recState: "idle", recSec: 0, recording: null },
    profileDraft: { name: "", photo: null },
    session: null, // { queue: [ids], qi, flipped, tags, results }
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

  function reviewsInRange(from, to) {
    let total = 0;
    for (const [key, count] of Object.entries(data.reviewLog)) {
      const d = new Date(key + "T00:00:00");
      if (d >= from && d <= to) total += count;
    }
    return total;
  }

  function reviewsThisWeek() {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - 6);
    from.setHours(0, 0, 0, 0);
    return reviewsInRange(from, to);
  }

  function reviewsThisMonth() {
    const now = new Date();
    return reviewsInRange(new Date(now.getFullYear(), now.getMonth(), 1), now);
  }

  function reviewsThisYear() {
    const now = new Date();
    return reviewsInRange(new Date(now.getFullYear(), 0, 1), now);
  }

  function formatDuration(ms) {
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h <= 0) return m + "m";
    return h + "h " + m + "m";
  }

  // A GitHub-style year of weeks, aligned to full Sun-Sat columns, ending today.
  function yearHeatmapWeeks() {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - 370);
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
    logReviewToday();
    saveData();
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
    return { editingId: null, front: "", back: "", tags: [], newTag: "", audioMode: "system", recState: "idle", recSec: 0, recording: null };
  }

  function openEditCard(card) {
    const isVoice = card.audio && card.audio.type === "voice" && card.audio.data;
    ui.draft = {
      editingId: card.id,
      front: card.front,
      back: card.back,
      tags: card.tags.slice(),
      newTag: "",
      audioMode: isVoice ? "record" : "system",
      recState: isVoice ? "done" : "idle",
      recSec: 0,
      recording: isVoice ? card.audio.data : null,
    };
    ui.screen = "add";
    render();
  }

  function cancelCardForm() {
    const wasEditing = !!ui.draft.editingId;
    ui.draft = blankDraft();
    go(wasEditing ? "browse" : "home");
  }

  function saveCard() {
    const d = ui.draft;
    if (!d.front.trim() || !d.back.trim() || !d.tags.length) return;
    const audio = d.audioMode === "system"
      ? { type: "system" }
      : d.recording
        ? { type: "voice", data: d.recording }
        : null;

    if (d.editingId) {
      const card = data.cards.find((c) => c.id === d.editingId);
      if (card) {
        card.front = d.front.trim();
        card.back = d.back.trim();
        card.tags = d.tags.slice();
        card.audio = audio;
      }
    } else {
      data.cards.unshift({
        id: "c-" + Date.now(),
        front: d.front.trim(),
        romaji: "",
        back: d.back.trim(),
        tags: d.tags.slice(),
        stability: null,
        difficulty: null,
        reps: 0,
        lapses: 0,
        lastReviewAt: null,
        dueAt: Date.now(),
        audio,
        createdAt: Date.now(),
      });
    }
    saveData();
    ui.draft = blankDraft();
    ui.screen = "browse";
    ui.filter = "All";
    ui.query = "";
    render();
  }

  function openProfile() {
    ui.profileDraft = { name: data.profile.name, photo: data.profile.photo };
    go("profile");
  }

  function cancelProfile() {
    go("home");
  }

  function saveProfile() {
    data.profile = { name: ui.profileDraft.name.trim(), photo: ui.profileDraft.photo };
    saveData();
    go("home");
  }

  function handlePhotoFile(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const size = 200;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      URL.revokeObjectURL(url);
      ui.profileDraft.photo = canvas.toDataURL("image/jpeg", 0.85);
      render();
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  // ---------------------------------------------------------------------
  // Small building blocks
  // ---------------------------------------------------------------------

  function avatarNode(profile, size) {
    const initial = profile.name.trim() ? profile.name.trim()[0].toUpperCase() : null;
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

  function statTile(label, value) {
    return h(
      "div",
      { style: { background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "12px", padding: "13px 14px" } },
      h("div", { style: { fontSize: "10.5px", letterSpacing: ".05em", textTransform: "uppercase", color: "#b0aea5" } }, label),
      h("div", { style: { marginTop: "6px", fontFamily: "var(--serif)", fontSize: "19px", color: "#141413" } }, value)
    );
  }

  function screenHome() {
    const tags = allTags();
    const due = dueCards(null);
    const recent = data.cards.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);
    const weeks = yearHeatmapWeeks();
    const allCounts = weeks.flat().filter(Boolean).map((c) => c.count);
    const maxCount = Math.max(1, ...allCounts);

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
          h("div", { style: { width: "26px", height: "26px", borderRadius: "8px", background: "#c96442", color: "#faf9f5", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--serif)", fontSize: "15px", fontWeight: "600" } }, "S"),
          h("div", { style: { fontFamily: "var(--serif)", fontSize: "16px", fontWeight: "500", color: "#141413", letterSpacing: ".1px" } }, "Sentence cards")
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
        h("div", { style: { fontFamily: "var(--serif)", fontSize: "30px", lineHeight: "1.15", color: "#141413", letterSpacing: "-.2px" } }, data.profile.name.trim() ? "Ready for today, " + data.profile.name.trim().split(/\s+/)[0] + "." : "Ready for today."),
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

      h("div", { style: { margin: "24px 20px 0", fontFamily: "var(--serif)", fontSize: "17px", color: "#141413" } }, "Activity"),

      h(
        "div",
        { style: { margin: "12px 20px 0", display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "8px" } },
        statTile("Cards", String(data.cards.length)),
        statTile("This week", String(reviewsThisWeek())),
        statTile("This month", String(reviewsThisMonth())),
        statTile("This year", String(reviewsThisYear())),
        statTile("Longest streak", longestStreak() + "d"),
        statTile("Time in app", formatDuration(data.totalActiveMs))
      ),

      h(
        "div",
        { style: { margin: "14px 20px 0", padding: "16px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "16px" } },
        h("div", { style: { fontSize: "13px", fontWeight: "500", color: "#141413" } }, "Past year"),
        h(
          "div",
          { class: "scrollx", "data-remember-scroll": "home-heatmap", "data-scroll-to-end": "true", style: { marginTop: "12px", alignItems: "flex-start" } },
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

      h("div", { style: { margin: "26px 20px 0", fontFamily: "var(--serif)", fontSize: "17px", color: "#141413" } }, "Recently added"),
      h(
        "div",
        { style: { margin: "12px 20px 0", display: "flex", flexDirection: "column", gap: "1px", background: "#f0eee6", border: "1px solid #f0eee6", borderRadius: "12px", overflow: "hidden" } },
        ...recent.map((c) =>
          h(
            "div",
            { style: { padding: "13px 16px", background: "#faf9f5" } },
            h("div", { style: { fontFamily: "var(--jp)", fontSize: "15px", color: "#141413" } }, c.front),
            h("div", { style: { marginTop: "4px", fontSize: "12px", color: "#5e5d59" } }, c.back)
          )
        )
      ),
      h("div", { style: { height: "24px" } }),

      bottomNav("home")
    );
  }

  function screenTags() {
    const tags = allTags();
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
        h("div", { style: { fontSize: "13px", color: "#5e5d59" } }, "Step 1 of 2")
      ),

      h(
        "div",
        { style: { padding: "18px 20px 0" } },
        h("div", { style: { fontFamily: "var(--serif)", fontSize: "28px", lineHeight: "1.15", color: "#141413" } }, "Which tags today?"),
        h("div", { style: { marginTop: "8px", fontSize: "14px", lineHeight: "1.6", color: "#5e5d59" } }, "Pick one or several. Only cards that are due in those tags enter the session.")
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
            h("span", { style: { fontSize: "11.5px", color: on ? "rgba(250,249,245,.6)" : "#b0aea5" } }, dueCards([t]).length + " due")
          );
        })
      ),

      h(
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

      h(
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
          h("div", { style: { fontSize: "11.5px", color: "#b0aea5" } }, "Reviewed " + c.reps + " times · next review in " + gap)
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
        { style: { marginTop: "30px", display: "flex", flexDirection: "column", gap: "1px", background: "rgba(250,249,245,.1)", borderRadius: "16px", overflow: "hidden" } },
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

  function screenBrowse() {
    const tags = allTags();
    const q = ui.query.trim().toLowerCase();
    const list = data.cards.filter((x) => {
      const okQ = !q || x.front.toLowerCase().includes(q) || x.back.toLowerCase().includes(q) || x.tags.join(" ").toLowerCase().includes(q);
      return okQ && (ui.filter === "All" || x.tags.includes(ui.filter));
    });

    return h(
      "div",
      { style: { minHeight: "100%", background: "#f5f4ed", display: "flex", flexDirection: "column", paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)" } },

      h("div", { style: { padding: "8px 20px 0", fontFamily: "var(--serif)", fontSize: "28px", color: "#141413" } }, "All cards"),

      h(
        "div",
        { style: { margin: "16px 20px 0", display: "flex", alignItems: "center", gap: "10px", padding: "11px 14px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "12px" } },
        icon('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4.5-4.5"/>', 15, "#b0aea5"),
        h("input", { "data-field": "query", value: ui.query, placeholder: "Search sentence, note or tag", style: { flex: "1", border: "none", outline: "none", background: "transparent", fontSize: "14px", color: "#141413" }, oninput: (e) => { ui.query = e.target.value; render(); } })
      ),

      h(
        "div",
        { class: "scrollx", "data-remember-scroll": "browse-filters", style: { margin: "14px 0 0", padding: "0 20px" } },
        ...["All"].concat(tags).map((f) => {
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
                { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" } },
                h("span", { style: { fontSize: "10.5px", color: "#b0aea5" } }, c.audio ? (c.audio.type === "voice" ? "your voice" : "generated") : ""),
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
    const canSave = d.front.trim() && d.back.trim() && d.tags.length;

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
        h("div", { style: { fontSize: "13px", color: "#b0aea5" } }, d.editingId ? "Edit card" : "New card"),
        h("div", { class: canSave ? "tap" : "", style: { fontSize: "14px", fontWeight: "500", color: canSave ? "#c96442" : "#b0aea5" }, onclick: canSave ? saveCard : null }, "Save")
      ),

      h(
        "div",
        { style: { padding: "22px 20px 0" } },
        h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "#b0aea5" } }, "Front · sentence"),
        h("textarea", { "data-field": "front", rows: "2", placeholder: "昨日は泳ぎました。", style: { marginTop: "10px", width: "100%", resize: "none", padding: "16px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "14px", fontFamily: "var(--jp)", fontSize: "19px", lineHeight: "1.5", color: "#141413" }, oninput: (e) => { d.front = e.target.value; render(); } }, d.front)
      ),

      h(
        "div",
        { style: { padding: "20px 20px 0" } },
        h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "#b0aea5" } }, "Back · note"),
        h("textarea", { "data-field": "back", rows: "2", placeholder: "I swam yesterday.", style: { marginTop: "10px", width: "100%", resize: "none", padding: "16px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "14px", fontFamily: "var(--serif)", fontSize: "17px", lineHeight: "1.5", color: "#141413" }, oninput: (e) => { d.back = e.target.value; render(); } }, d.back)
      ),

      h(
        "div",
        { style: { padding: "20px 20px 0" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between" } },
          h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "#b0aea5" } }, "Tags · required"),
          h("div", { style: { fontSize: "11.5px", color: "#b0aea5" } }, d.tags.length ? d.tags.length + " selected" : "pick at least one")
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
          h("input", { "data-field": "newTag", value: d.newTag, placeholder: "New tag", style: { flex: "1", padding: "11px 14px", background: "#faf9f5", border: "1px dashed #ddd8c8", borderRadius: "9999px", fontSize: "13px", color: "#141413" }, oninput: (e) => { d.newTag = e.target.value; render(); }, onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); addNewTag(); } } }),
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
        "We'll greet you by name. Add a photo if you'd like."
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
        h("div", { style: { fontSize: "11px", letterSpacing: ".09em", textTransform: "uppercase", color: "#b0aea5" } }, "Name"),
        h("input", {
          "data-field": "profileName", value: d.name, placeholder: "Your name",
          style: { marginTop: "10px", width: "100%", padding: "16px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "14px", fontFamily: "var(--serif)", fontSize: "19px", color: "#141413" },
          oninput: (e) => { d.name = e.target.value; render(); },
        })
      ),

      h("div", { style: { height: "40px" } })
    );
  }

  // ---------------------------------------------------------------------
  // Render dispatch
  // ---------------------------------------------------------------------

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
      case "tags": content = screenTags(); break;
      case "review": content = ui.session ? screenReview() : screenHome(); break;
      case "done": content = ui.session ? screenDone() : screenHome(); break;
      case "browse": content = screenBrowse(); break;
      case "add": content = screenAdd(); break;
      case "profile": content = screenProfile(); break;
      default: content = screenHome();
    }
    phone.appendChild(content);
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
        }
      }
    }
  }

  render();
})();
