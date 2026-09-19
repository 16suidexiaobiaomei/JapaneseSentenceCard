// Vercel serverless function: RevenueCat webhook. This is the ONLY code
// path allowed to write profiles.plan — the client never can (see the
// premium_plan migration: no grant exists for it), so this is the
// actual source of truth behind every premium gate in the app.
//
// Rather than branching on event.type (INITIAL_PURCHASE vs RENEWAL vs
// CANCELLATION vs EXPIRATION vs BILLING_ISSUE, each with different "are
// they still entitled right now" semantics — e.g. CANCELLATION just
// means auto-renew was turned off, the user is still entitled until
// the period actually ends), this re-fetches the subscriber's current
// status directly from RevenueCat's REST API on every event and sets
// plan to whatever's actually true at that moment. More robust than
// trying to get every event-type transition exactly right.

const SUPABASE_URL = "https://asgyhietqpoamagitycs.supabase.co";
const ENTITLEMENT = "premium";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  // RevenueCat sends this back exactly as configured in its dashboard
  // (Integrations -> Webhooks -> Authorization header value).
  const authHeader = req.headers["authorization"] || "";
  if (!process.env.REVENUECAT_WEBHOOK_SECRET || authHeader !== "Bearer " + process.env.REVENUECAT_WEBHOOK_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  // app_user_id is the RevenueCat appUserID, which the client sets to
  // the Supabase auth user id at configure()/logIn() time — so it's
  // directly the profiles.id to update, no separate mapping needed.
  const appUserId = body && body.event && body.event.app_user_id;
  if (!appUserId) {
    // Nothing we can act on (e.g. a malformed test payload) — ack
    // anyway so RevenueCat doesn't keep retrying this one forever.
    res.status(200).json({ ok: true });
    return;
  }

  try {
    const subRes = await fetch("https://api.revenuecat.com/v1/subscribers/" + encodeURIComponent(appUserId), {
      headers: { Authorization: "Bearer " + process.env.REVENUECAT_SECRET_API_KEY },
    });
    if (!subRes.ok) {
      // Unknown/unfetchable subscriber (e.g. RevenueCat's own "Send
      // Test Event" uses a fake id) — nothing to update, not an error.
      res.status(200).json({ ok: true, warning: "subscriber lookup failed" });
      return;
    }
    const subData = await subRes.json();
    const entitlement = subData.subscriber && subData.subscriber.entitlements && subData.subscriber.entitlements[ENTITLEMENT];
    const isActive = !!(entitlement && (!entitlement.expires_date || new Date(entitlement.expires_date) > new Date()));
    const plan = isActive ? "premium" : "free";

    await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(appUserId), {
      method: "PATCH",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ plan }),
    });

    res.status(200).json({ ok: true, plan });
  } catch (e) {
    console.error("revenuecat webhook error", e);
    res.status(500).json({ error: "internal error" });
  }
};
