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
      SUPABASE_URL + "/rest/v1/romaji_cache?id=eq." + hash + "&select=romaji",
      { headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] ? rows[0].romaji : null;
  } catch {
    return null;
  }
}

async function writeCache(hash, romaji) {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/romaji_cache", {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates",
      },
      body: JSON.stringify({ id: hash, romaji }),
    });
  } catch {
    // Cache write is a nice-to-have — never fail the request over it.
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    res.status(200).json({ romaji: "" });
    return;
  }
  if (!JAPANESE_RE.test(text)) {
    // Nothing to convert (English, gibberish, etc.) — let the client fall
    // back to a manually-entered romaji instead of guessing.
    res.status(200).json({ romaji: "" });
    return;
  }

  const hash = crypto.createHash("sha256").update(text).digest("hex");

  const cached = await readCache(hash);
  if (cached !== null) {
    res.status(200).json({ romaji: cached });
    return;
  }

  try {
    const kuroshiro = await getKuroshiro();
    const romaji = await kuroshiro.convert(text, { to: "romaji", mode: "spaced", romajiSystem: "hepburn" });
    // Awaited, not fire-and-forget: a serverless function's execution
    // context can be torn down the instant the response is sent, which
    // would silently drop an un-awaited write.
    await writeCache(hash, romaji);
    res.status(200).json({ romaji });
  } catch (e) {
    res.status(500).json({ error: "conversion failed" });
  }
};
