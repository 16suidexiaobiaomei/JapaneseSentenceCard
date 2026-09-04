// Sentence Cards — Japanese sentence flashcard SRS
// Vanilla JS, no build step. Persists to localStorage, uses real
// speech synthesis for "generated" audio and MediaRecorder for "your voice".

(() => {
  "use strict";

  const STORAGE_KEY = "sentence-cards-v1";

  // box index -> interval in days for a "Good" grade landing on that box.
  // box 0 is only reached via "Again" and is handled as a short 10-minute relearn step.
  const INTERVAL_DAYS = [0, 1, 3, 7, 21, 60];
  const INTERVAL_LABELS = ["10 min", "1 day", "3 days", "1 week", "3 weeks", "2 months"];
  const AGAIN_DELAY_MS = 10 * 60 * 1000;
  const DOT_COLORS = ["#c96442", "#d97757", "#5e5d59", "#141413", "#b0aea5", "#8a8778"];
  const SESSION_SIZE = 10;
  const AUTOPLAY_AUDIO = true;

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
        box: 0,
        dueAt: now,
        audio: { type: "system" },
        seen: 0,
        createdAt: now - (SEED_CARDS.length - i) * 1000,
      })),
      reviewLog: {}, // "YYYY-MM-DD" -> count
      profile: { name: "", photo: null },
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

  function totalCards(tag) {
    return data.cards.filter((c) => !tag || c.tags.includes(tag)).length;
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

  function weekData() {
    const log = data.reviewLog;
    const names = ["S", "M", "T", "W", "T", "F", "S"];
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push({ name: names[d.getDay()], count: log[dateKey(d)] || 0 });
    }
    return days;
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

  function beginSession(tags) {
    const queue = dueCards(tags).slice(0, SESSION_SIZE).map((c) => c.id);
    if (!queue.length) return;
    ui.session = { queue, qi: 0, flipped: false, tags: tags.length ? tags : ["all tags"], results: { again: 0, good: 0, easy: 0 } };
    ui.screen = "review";
    render();
    if (AUTOPLAY_AUDIO) setTimeout(() => playCardAudio(currentCard()), 250);
  }

  function currentCard() {
    if (!ui.session) return null;
    const id = ui.session.queue[ui.session.qi];
    return data.cards.find((c) => c.id === id) || null;
  }

  function flipCard() {
    if (!ui.session) return;
    ui.session.flipped = !ui.session.flipped;
    render();
  }

  function gradeCard(kind) {
    const s = ui.session;
    const c = currentCard();
    if (!s || !c) return;

    let box, dueAt;
    if (kind === "again") {
      box = 0;
      dueAt = Date.now() + AGAIN_DELAY_MS;
    } else {
      box = Math.min(5, c.box + (kind === "easy" ? 2 : 1));
      dueAt = Date.now() + INTERVAL_DAYS[box] * 86400000;
    }
    c.box = box;
    c.dueAt = dueAt;
    c.seen += 1;
    s.results[kind] += 1;
    logReviewToday();
    saveData();

    const last = s.qi >= s.queue.length - 1;
    s.flipped = false;
    if (last) {
      ui.screen = "done";
    } else {
      s.qi += 1;
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
        box: 0,
        dueAt: Date.now(),
        audio,
        seen: 0,
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

  function screenHome() {
    const now = Date.now();
    const tags = allTags();
    const due = dueCards(null);
    const week = weekData();
    const maxW = Math.max(1, ...week.map((w) => w.count));
    const recent = data.cards.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);

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
        )
      ),

      h(
        "div",
        { style: { margin: "22px 20px 0", padding: "18px 20px 16px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "16px" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between" } },
          h("div", { style: { fontSize: "13px", fontWeight: "500", color: "#141413" } }, "This week"),
          h("div", { style: { fontSize: "12px", color: "#5e5d59" } }, week.reduce((a, w) => a + w.count, 0) + " reviewed")
        ),
        h(
          "div",
          { style: { marginTop: "16px", display: "flex", alignItems: "flex-end", gap: "9px", height: "62px" } },
          ...week.map((d) =>
            h(
              "div",
              { style: { flex: "1", display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" } },
              h("div", { style: { width: "100%", borderRadius: "5px", background: d.count ? "#c96442" : "#f0eee6", height: Math.round(8 + (d.count / maxW) * 42) + "px" } }),
              h("div", { style: { fontSize: "10.5px", color: d.count ? "#5e5d59" : "#b0aea5" } }, d.name)
            )
          )
        )
      ),

      h(
        "div",
        { style: { margin: "24px 20px 0" } },
        h("div", { style: { fontFamily: "var(--serif)", fontSize: "17px", color: "#141413" } }, "Review by tag")
      ),
      h(
        "div",
        { style: { margin: "12px 20px 0", display: "flex", flexDirection: "column", gap: "8px" } },
        ...tags.map((t, i) => {
          const d = dueCards([t]).length;
          return h(
            "div",
            { class: "tap row-hover", style: { display: "flex", alignItems: "center", gap: "12px", padding: "14px 16px", background: "#faf9f5", border: "1px solid #f0eee6", borderRadius: "12px" }, onclick: () => beginSession([t]) },
            h("div", { style: { width: "7px", height: "7px", borderRadius: "9999px", background: DOT_COLORS[i % DOT_COLORS.length] } }),
            h(
              "div",
              { style: { flex: "1", minWidth: "0" } },
              h("div", { style: { fontSize: "14px", color: "#141413" } }, t),
              h("div", { style: { marginTop: "3px", fontSize: "11.5px", color: "#b0aea5" } }, totalCards(t) + " cards")
            ),
            h("div", { style: { fontSize: "12.5px", color: d ? "#c96442" : "#b0aea5" } }, d ? d + " due" : "clear"),
            icon('<path d="M9 18l6-6-6-6"/>', 15, "#b0aea5")
          );
        })
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
        h(
          "div",
          {
            class: n ? "tap" : "",
            style: { padding: "16px", borderRadius: "14px", textAlign: "center", fontSize: "15px", fontWeight: "500", background: n ? "#c96442" : "#f0eee6", color: n ? "#faf9f5" : "#b0aea5" },
            onclick: n ? () => beginSession(ui.sel) : null,
          },
          n ? "Review " + n + " cards" : "Nothing due in these tags"
        )
      )
    );
  }

  function screenReview() {
    const s = ui.session;
    const c = currentCard();
    const progressPct = Math.round(((s.qi + (s.flipped ? 0.5 : 0)) / Math.max(1, s.queue.length)) * 100);

    const flipZone = h(
      "div",
      { class: "tap", style: { marginTop: "18px", flex: "1", background: "#faf9f5", borderRadius: "28px", padding: "34px 26px", display: "flex", flexDirection: "column", boxShadow: "0 4px 24px rgba(0,0,0,.28)" }, onclick: flipCard }
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
            { class: "tap", style: { display: "flex", alignItems: "center", gap: "11px", padding: "10px 16px 10px 12px", borderRadius: "9999px", background: "#f5f4ed", border: "1px solid #f0eee6" }, onclick: (e) => { e.stopPropagation(); playCardAudio(c); } },
            icon('<path d="M8 5l11 7-11 7z"/>', 16, "#c96442"),
            h("span", { style: { fontSize: "11.5px", color: "#5e5d59" } }, c.audio && c.audio.type === "voice" ? "your voice" : "play audio")
          ),
          h("div", { style: { fontSize: "12px", color: "#b0aea5" } }, "Tap to reveal")
        )
      );
    } else {
      const next = INTERVAL_LABELS[Math.min(5, c.box + 1)];
      flipZone.appendChild(
        h(
          "div",
          { class: "anim-in", style: { display: "flex", flexDirection: "column", height: "100%" } },
          h("div", { style: { fontFamily: "var(--jp)", fontSize: "16px", lineHeight: "1.5", color: "#5e5d59", paddingBottom: "18px", borderBottom: "1px solid #f0eee6" } }, c.front),
          h("div", { style: { flex: "1", display: "flex", alignItems: "center" } }, h("div", { style: { fontFamily: "var(--serif)", fontSize: "26px", lineHeight: "1.35", color: "#141413" } }, c.back)),
          h("div", { style: { fontSize: "11.5px", color: "#b0aea5" } }, "Seen " + c.seen + " times · next in " + next + " if you say good")
        )
      );
    }

    const grades = [
      { name: "Again", kind: "again", iv: INTERVAL_LABELS[0], bg: "rgba(250,249,245,.06)", bd: "rgba(250,249,245,.16)", fg: "#faf9f5", sub: "#b0aea5" },
      { name: "Good", kind: "good", iv: INTERVAL_LABELS[Math.min(5, c.box + 1)], bg: "#c96442", bd: "#c96442", fg: "#faf9f5", sub: "rgba(250,249,245,.75)" },
      { name: "Easy", kind: "easy", iv: INTERVAL_LABELS[Math.min(5, c.box + 2)], bg: "rgba(250,249,245,.06)", bd: "rgba(250,249,245,.16)", fg: "#faf9f5", sub: "#b0aea5" },
    ];

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

      h("div", { style: { marginTop: "28px", display: "flex", flexWrap: "wrap", gap: "7px" } }, ...s.tags.map((t) => h("div", { style: { padding: "5px 11px", borderRadius: "9999px", background: "rgba(250,249,245,.08)", color: "#b0aea5", fontSize: "11px" } }, t))),

      flipZone,

      s.flipped
        ? h(
            "div",
            { style: { marginTop: "16px", display: "flex", gap: "9px" } },
            ...grades.map((g) =>
              h(
                "div",
                { class: "tap", style: { flex: "1", padding: "14px 8px", borderRadius: "14px", textAlign: "center", background: g.bg, border: "1px solid " + g.bd }, onclick: () => gradeCard(g.kind) },
                h("div", { style: { fontSize: "14px", fontWeight: "500", color: g.fg } }, g.name),
                h("div", { style: { marginTop: "4px", fontSize: "11px", color: g.sub } }, g.iv)
              )
            )
          )
        : h("div", { style: { marginTop: "16px", padding: "14px", borderRadius: "14px", textAlign: "center", fontSize: "13px", color: "#b0aea5", border: "1px solid rgba(250,249,245,.12)" } }, "Read it aloud, then reveal the note")
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
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", background: "#1a1a18" } }, h("span", { style: { fontSize: "13.5px", color: "#b0aea5" } }, "Again"), h("span", { style: { fontFamily: "var(--serif)", fontSize: "19px", color: "#d97757" } }, String(s.results.again))),
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", background: "#1a1a18" } }, h("span", { style: { fontSize: "13.5px", color: "#b0aea5" } }, "Good"), h("span", { style: { fontFamily: "var(--serif)", fontSize: "19px", color: "#faf9f5" } }, String(s.results.good))),
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", background: "#1a1a18" } }, h("span", { style: { fontSize: "13.5px", color: "#b0aea5" } }, "Easy"), h("span", { style: { fontFamily: "var(--serif)", fontSize: "19px", color: "#faf9f5" } }, String(s.results.easy)))
      ),
      h(
        "div",
        { style: { marginTop: "26px", fontSize: "12.5px", lineHeight: "1.7", color: "#5e5d59" } },
        "Cards you marked again come back in " + INTERVAL_LABELS[0] + ". The rest are scheduled out to " + INTERVAL_LABELS[2] + " and beyond. " + dueCards(null).length + " cards still due today."
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
