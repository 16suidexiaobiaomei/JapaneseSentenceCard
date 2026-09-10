// Deletes the CALLING user's own Supabase Auth account. There is no
// client-callable "delete my own account" method in supabase-js — that
// needs the admin API, which needs the service_role key, which must never
// reach the browser. This function is the one place that key is used: it
// lives only in Vercel's environment variables (set by the project owner,
// never touched by this code's author), read at request time.
//
// cards/profiles/review_log all have `references auth.users on delete
// cascade`, so deleting the auth user here also wipes all of their data —
// no separate cleanup needed.
//
// Plain REST calls rather than the @supabase/supabase-js SDK: the SDK's
// createClient() eagerly constructs a Realtime/WebSocket client we don't
// use, which throws outright on Node runtimes without native WebSocket
// support (confirmed locally on Node 21) — not worth the risk of it doing
// the same on whatever Node version Vercel happens to run.

const SUPABASE_URL = "https://asgyhietqpoamagitycs.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_oCqtHBphJuPnFgrK87K7PA_XwemlHSO";

module.exports = async (req, res) => {
  // Called cross-origin from the native app shell (capacitor://localhost) —
  // needs an explicit CORS allowance and a handled preflight. Auth here is
  // a Bearer token, not cookies, so a wildcard origin carries no risk.
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
    // Verify the token and find out WHO is asking — never trust a
    // client-supplied user id, since anyone could send an arbitrary one.
    // This only needs the public anon key; it just validates the JWT.
    const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
    });
    if (!userRes.ok) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }
    const user = await userRes.json();
    if (!user || !user.id) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) {
      res.status(500).json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set" });
      return;
    }

    const deleteRes = await fetch(SUPABASE_URL + "/auth/v1/admin/users/" + user.id, {
      method: "DELETE",
      headers: { apikey: serviceRoleKey, Authorization: "Bearer " + serviceRoleKey },
    });
    if (!deleteRes.ok) {
      const body = await deleteRes.text();
      res.status(500).json({ error: "Delete failed: " + body });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Unexpected error deleting account" });
  }
};
