// Shared by the RevenueCat webhook and sync-premium.js: given a RevenueCat
// appUserID (== a Supabase profiles.id), fetches that subscriber's current
// status straight from RevenueCat and writes profiles.plan to match. See
// revenuecat-webhook.js for why this re-fetches "what's true right now"
// instead of trusting the event payload's type.

const SUPABASE_URL = "https://asgyhietqpoamagitycs.supabase.co";
const ENTITLEMENT = "premium";

async function syncPlanForUser(appUserId) {
  const subRes = await fetch("https://api.revenuecat.com/v1/subscribers/" + encodeURIComponent(appUserId), {
    headers: { Authorization: "Bearer " + process.env.REVENUECAT_SECRET_API_KEY },
  });
  if (!subRes.ok) return null; // unknown subscriber — nothing to update

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

  return plan;
}

module.exports = { syncPlanForUser, SUPABASE_URL };
