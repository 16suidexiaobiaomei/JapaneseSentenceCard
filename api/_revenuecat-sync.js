// Shared by the RevenueCat webhook and sync-premium.js: given a RevenueCat
// appUserID (== a Supabase profiles.id), fetches that subscriber's current
// status straight from RevenueCat and writes profiles.plan to match. See
// revenuecat-webhook.js for why this re-fetches "what's true right now"
// instead of trusting the event payload's type.

const SUPABASE_URL = "https://asgyhietqpoamagitycs.supabase.co";
const ENTITLEMENT = "premium";

// Demo/support account ids that should keep showing Premium without a
// real RevenueCat purchase behind them. Checked HERE, not just in the
// daily reconcile-premium.js sweep, since sync-premium.js (triggered by
// the client's own customerInfo-update listener, not just a real
// purchase/restore) and the webhook can also call this for the same
// account — guarding only one of the three callers left the others free
// to still revoke an allowlisted account the moment its device noticed
// there's no real entitlement. See PREMIUM_ALLOWLIST_USER_IDS in Vercel's
// env vars to add or remove one (comma-separated, no spaces).
function isAllowlisted(appUserId) {
  return (process.env.PREMIUM_ALLOWLIST_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(appUserId);
}

async function setPlan(appUserId, plan) {
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
}

async function syncPlanForUser(appUserId) {
  // Actively (re-)writes "premium" rather than just skipping the check,
  // so this is self-healing: an allowlisted account that's already
  // wrongly sitting at "free" (e.g. from before this id was added, or
  // from a future gap like this one) gets corrected the next time
  // anything calls this for it, instead of staying stuck.
  if (isAllowlisted(appUserId)) {
    await setPlan(appUserId, "premium");
    return "premium";
  }

  const subRes = await fetch("https://api.revenuecat.com/v1/subscribers/" + encodeURIComponent(appUserId), {
    headers: { Authorization: "Bearer " + process.env.REVENUECAT_SECRET_API_KEY },
  });
  if (!subRes.ok) {
    const bodyText = await subRes.text().catch(() => "");
    console.warn("syncPlanForUser: subscriber lookup failed", subRes.status, bodyText, "for", appUserId);
    return null; // unknown subscriber — nothing to update
  }

  const subData = await subRes.json();
  const entitlement = subData.subscriber && subData.subscriber.entitlements && subData.subscriber.entitlements[ENTITLEMENT];
  const isActive = !!(entitlement && (!entitlement.expires_date || new Date(entitlement.expires_date) > new Date()));
  const plan = isActive ? "premium" : "free";
  console.log("syncPlanForUser:", appUserId, "entitlement:", JSON.stringify(entitlement), "-> plan:", plan);

  await setPlan(appUserId, plan);
  return plan;
}

module.exports = { syncPlanForUser, SUPABASE_URL };
