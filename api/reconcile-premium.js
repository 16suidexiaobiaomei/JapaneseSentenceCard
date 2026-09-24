// Scheduled safety net (see vercel.json's `crons`), NOT the primary way
// profiles.plan gets kept correct — that's still the webhook and
// sync-premium.js, which handle the normal case (and now handle
// TRANSFER events too, see revenuecat-webhook.js).
//
// Real-world testing turned up a case those two don't cover: a purchase
// restored under a second app account, on the same device/Apple ID,
// doesn't reliably produce a webhook event telling the FIRST account it
// lost access — either because no TRANSFER event fires for a plain
// restorePurchases() call, or because once a second app_user_id has
// validated the same receipt, RevenueCat stops sending that first
// app_user_id any further lifecycle events for it. Either way, without
// this sweep, the first account's profiles.plan would stay "premium"
// forever, since nothing would ever prompt a re-check of it again.
//
// So: periodically re-verify every account we currently believe is
// premium directly against RevenueCat's own record, independent of
// whatever event RevenueCat did or didn't send.

const { syncPlanForUser } = require("./_revenuecat-sync");

const SUPABASE_URL = "https://asgyhietqpoamagitycs.supabase.co";

module.exports = async (req, res) => {
  // Vercel automatically sends `Authorization: Bearer $CRON_SECRET` for
  // scheduled invocations of this function when that env var is set —
  // this rejects anyone else from triggering it on demand.
  const authHeader = req.headers["authorization"] || "";
  const secret = process.env.CRON_SECRET;
  if (!secret || authHeader !== "Bearer " + secret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const listRes = await fetch(SUPABASE_URL + "/rest/v1/profiles?plan=eq.premium&select=id&limit=1000", {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
      },
    });
    if (!listRes.ok) {
      res.status(500).json({ error: "failed to list premium profiles" });
      return;
    }
    const ids = new Set(rows.map((r) => r.id));

    // Also sweep every allowlisted id even if it's NOT currently marked
    // premium — self-healing, so one that's wrongly sitting at "free"
    // (e.g. from before it was added to the list, or any future gap)
    // gets corrected here too, not just protected once it's already
    // right. syncPlanForUser() itself handles what "allowlisted" means.
    for (const id of (process.env.PREMIUM_ALLOWLIST_USER_IDS || "").split(",").map((id) => id.trim()).filter(Boolean)) {
      ids.add(id);
    }

    let checked = 0;
    let premium = 0;
    let revoked = 0;
    for (const id of ids) {
      checked++;
      const plan = await syncPlanForUser(id);
      if (plan === "premium") premium++;
      else if (plan === "free") revoked++;
    }

    res.status(200).json({ ok: true, checked, premium, revoked });
  } catch (e) {
    console.error("reconcile-premium error", e);
    res.status(500).json({ error: "internal error" });
  }
};
