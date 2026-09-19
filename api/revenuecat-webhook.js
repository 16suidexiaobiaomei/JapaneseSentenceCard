// Vercel serverless function: RevenueCat webhook. Alongside sync-premium.js
// (called directly by the client right after a purchase/restore, so the
// database doesn't lag behind what the user just paid for), this is the
// only other code path allowed to write profiles.plan — the client never
// can on its own (see the premium_plan migration: no grant exists for it).
// This one is the reconciler for everything that happens while the app
// ISN'T open (renewals, cancellations, billing issues, refunds, ...).
//
// Rather than branching on event.type (INITIAL_PURCHASE vs RENEWAL vs
// CANCELLATION vs EXPIRATION vs BILLING_ISSUE, each with different "are
// they still entitled right now" semantics — e.g. CANCELLATION just
// means auto-renew was turned off, the user is still entitled until
// the period actually ends), this re-fetches the subscriber's current
// status directly from RevenueCat's REST API on every event and sets
// plan to whatever's actually true at that moment. More robust than
// trying to get every event-type transition exactly right.

const { syncPlanForUser } = require("./_revenuecat-sync");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  // RevenueCat sends this back exactly as configured in its dashboard
  // (Integrations -> Webhooks -> Authorization header value).
  const authHeader = req.headers["authorization"] || "";
  const expected = process.env.REVENUECAT_WEBHOOK_SECRET ? "Bearer " + process.env.REVENUECAT_WEBHOOK_SECRET : null;
  if (!expected || authHeader !== expected) {
    // Never log the actual secret values — just enough shape info (are
    // they even close, or is one of them simply missing/empty) to tell
    // "wrong value configured" apart from "no header sent at all".
    console.warn(
      "revenuecat webhook: auth mismatch — env var set:", !!process.env.REVENUECAT_WEBHOOK_SECRET,
      "header present:", !!authHeader, "header length:", authHeader.length,
      "expected length:", expected ? expected.length : 0
    );
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
    const plan = await syncPlanForUser(appUserId);
    if (plan === null) {
      // Unknown/unfetchable subscriber (e.g. RevenueCat's own "Send
      // Test Event" uses a fake id) — nothing to update, not an error.
      res.status(200).json({ ok: true, warning: "subscriber lookup failed" });
      return;
    }
    res.status(200).json({ ok: true, plan });
  } catch (e) {
    console.error("revenuecat webhook error", e);
    res.status(500).json({ error: "internal error" });
  }
};
