// Called by the client immediately after a successful purchase or restore,
// so profiles.plan reflects Premium right away instead of waiting on the
// RevenueCat webhook. The webhook can lag by anywhere from a second to
// (during a Vercel cold start or RevenueCat retry backoff) much longer —
// if the app is backgrounded in that window, syncNow()'s next pull would
// read the still-stale "free" row and stomp the optimistic local flag,
// which also means server-enforced gates (the free-tag-limit trigger,
// download_shared_tag()) would genuinely still reject them. This closes
// that race by doing the same "ask RevenueCat what's true, write it to
// Supabase" work the webhook does, but synchronously, right after purchase.
//
// See delete-account.js for why auth works this way: verify the caller's
// own Supabase access token via the public anon key (no client-supplied
// user id is ever trusted), then use the service_role key — which never
// reaches the browser — to write plan (a column with no client grant).

const SUPABASE_URL = "https://asgyhietqpoamagitycs.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_oCqtHBphJuPnFgrK87K7PA_XwemlHSO";
const { syncPlanForUser } = require("./_revenuecat-sync");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Missing access token" });
    return;
  }

  try {
    const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
    });
    if (!userRes.ok) {
      const bodyText = await userRes.text().catch(() => "");
      console.warn("sync-premium: token check failed", userRes.status, bodyText, "token length", token.length);
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }
    const user = await userRes.json();
    if (!user || !user.id) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    if (!process.env.REVENUECAT_SECRET_API_KEY) console.warn("sync-premium: REVENUECAT_SECRET_API_KEY is not set");
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) console.warn("sync-premium: SUPABASE_SERVICE_ROLE_KEY is not set");
    const plan = await syncPlanForUser(user.id);
    console.log("sync-premium: resolved plan for user", user.id, "=", plan);
    res.status(200).json({ ok: true, plan: plan || "free" });
  } catch (e) {
    console.error("sync-premium error", e);
    res.status(500).json({ error: "internal error" });
  }
};
