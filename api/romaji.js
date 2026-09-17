// Vercel serverless function: converts a Japanese sentence to romaji.
// Runs kuromoji/kuroshiro server-side so the browser never has to load
// the ~17MB dictionary or run the tokenizer itself (that's what froze the
// page the first time this was attempted client-side).

const crypto = require("crypto");
const path = require("path");
const Kuroshiro = require("kuroshiro").default;
const KuromojiAnalyzer = require("kuroshiro-analyzer-kuromoji");

const SUPABASE_URL = "https://asgyhietqpoamagitycs.supabase.co";
const SUPABASE_KEY = "sb_publishable_oCqtHBphJuPnFgrK87K7PA_XwemlHSO";

const JAPANESE_RE = /[぀-ヿ一-龯]/;

// furigana is stored as HTML (<ruby>/<rt> markup) and rendered via
// innerHTML on-device — including for cards downloaded from other
// users' shared tags. Escaping the sentence before handing it to
// kuroshiro means any stray <, >, & a sentence happens to contain
// comes out as inert text in the ruby-wrapped output, never as live
// markup — a normal Japanese sentence never contains those characters,
// so this has no effect on real input.
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Kept at module scope so a "warm" invocation (the common case under
// steady traffic) reuses the already-initialized tokenizer instead of
// re-parsing the dictionary — only a cold start pays that cost.
let kuroshiroPromise = null;
function getKuroshiro() {
  if (!kuroshiroPromise) {
    const k = new Kuroshiro();
    kuroshiroPromise = k
      .init(new KuromojiAnalyzer({ dictPath: path.join(process.cwd(), "node_modules/kuromoji/dict") }))
      .then(() => k);
  }
  return kuroshiroPromise;
}

async function readCache(hash) {
  try {
    const res = await fetch(
      SUPABASE_URL + "/rest/v1/romaji_cache?id=eq." + hash + "&select=romaji,kana,furigana",
      { headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
  } catch {
    return null;
  }
}

async function writeCache(hash, romaji, kana, furigana) {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/romaji_cache", {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        // merge- not ignore-duplicates: a row can already exist with
        // empty kana/furigana (created before those columns existed),
        // and a recomputation for it needs to actually overwrite that
        // stale row instead of being silently dropped as a "duplicate".
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ id: hash, romaji, kana, furigana }),
    });
  } catch {
    // Cache write is a nice-to-have — never fail the request over it.
  }
}

module.exports = async (req, res) => {
  // The native iOS/Android app calls this cross-origin (from
  // capacitor://localhost, not japanesesentencecards.com), which needs an
  // explicit CORS allowance and a handled preflight. No cookies/credentials
  // are involved, so a wildcard origin is fine here.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    res.status(200).json({ romaji: "", kana: "", furigana: "" });
    return;
  }
  if (!JAPANESE_RE.test(text)) {
    // Nothing to convert (English, gibberish, etc.) — let the client fall
    // back to a manually-entered romaji instead of guessing.
    res.status(200).json({ romaji: "", kana: "", furigana: "" });
    return;
  }

  const hash = crypto.createHash("sha256").update(text).digest("hex");

  // A cache row from before kana/furigana existed has those columns
  // defaulted to '' — treating that as a valid hit would return blank
  // kana/furigana for that sentence forever, since a hit skips the
  // conversion below entirely. Only trust the cache once all three are
  // actually populated; otherwise fall through and (re)compute — see
  // writeCache()'s merge-duplicates for why that safely overwrites it.
  const cached = await readCache(hash);
  if (cached !== null && cached.kana && cached.furigana) {
    res.status(200).json({ romaji: cached.romaji, kana: cached.kana, furigana: cached.furigana });
    return;
  }

  try {
    const kuroshiro = await getKuroshiro();
    const romaji = await kuroshiro.convert(text, { to: "romaji", mode: "spaced", romajiSystem: "hepburn" });
    // kana carries the same kuromoji-resolved reading as romaji, just in
    // an unambiguous script — see speak() in app.js for why this exists:
    // handing raw kanji to the device's own TTS lets it mispronounce
    // multi-reading kanji that this conversion already disambiguates.
    const kana = await kuroshiro.convert(text, { to: "hiragana", mode: "normal" });
    // Ruby-annotated HTML shown above the sentence on the back of a
    // review card. Converted from the escaped text (see escapeHtml)
    // so a malicious sentence in a downloaded shared tag can't inject
    // markup into another user's WebView.
    const furigana = await kuroshiro.convert(escapeHtml(text), { to: "hiragana", mode: "furigana" });
    // Awaited, not fire-and-forget: a serverless function's execution
    // context can be torn down the instant the response is sent, which
    // would silently drop an un-awaited write.
    await writeCache(hash, romaji, kana, furigana);
    res.status(200).json({ romaji, kana, furigana });
  } catch (e) {
    res.status(500).json({ error: "conversion failed" });
  }
};
