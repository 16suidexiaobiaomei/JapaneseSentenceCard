# Apple App Review — Guideline 2.1 reply draft

Submit this text via **both**: (1) "Reply to App Review" in App Store Connect, and (2) pasted into **App Review Information → Notes** on the version page, per Apple's instructions. Fill in the [bracketed] account credentials before sending. Combined text below is well under the 4000-character reply limit.

---

**Note on content moderation:** the Community feature is anonymous tag-sharing (download-only) with no user profiles or messaging between users, so there is no user-to-user "block" feature to demonstrate. Moderation works via the reporting flow shown in the recording: a tag hidden pending review after enough reports, and an account's sharing ability paused for 30 days after two of its tags are removed this way.

**2. App purpose and target audience**
Japanese Sentence Card helps self-directed Japanese language learners (beginner–intermediate) study using example-sentence flashcards with spaced repetition (FSRS). Each card shows a Japanese sentence with automatically generated romaji and furigana, alongside a user-written translation. A Community feature lets users share and download sentence decks other learners have created.

**3. Setup / access instructions**
No account is required to browse the app's own seed deck. An email + one-time code is required to save cards to the cloud and access Community. Demo accounts (see Notes field):
- Free plan: [email] / [password]
- Premium plan: [email] / [password]
Sign-up is also fully functional with any real email if you'd prefer to create your own account directly.

**4. External services used**
- Supabase — authentication and database (accounts, cards, tags).
- Vercel — hosting and serverless functions, including a self-hosted, on-device Japanese-to-romaji/furigana converter (kuromoji library) — no third-party AI or translation API is used for this.
- RevenueCat — subscription/entitlement management for the Premium plan.
- Apple's App Store — all payment processing; we never receive or store card details.
- iOS's built-in text-to-speech (on-device) is used to optionally read a card's sentence aloud.
No analytics, advertising, or tracking SDKs are used anywhere in the app.

**5. Regional differences**
The app functions identically in every region. The only regional variation is the local-currency price for the Premium subscription, which the App Store localizes automatically. There is no other region-gated content or feature.

**6. Regulated industry / protected material**
Not applicable. This is a general-purpose language-learning app; it does not operate in a regulated industry, and all sentence content is either written by the user themselves or voluntarily shared by other users — no licensed or protected third-party material is included.

**7. In-App Purchase overview and navigation**
Users can purchase a Premium subscription (Monthly or Annual, both auto-renewing) that unlocks: unlimited tags (Free is capped at 5), downloading tags shared by other users in Community, and Advanced Settings to customize which readings appear on review cards. To reach the purchase flow: Profile → Membership → "Upgrade to Premium," or tap any Premium prompt shown when a Free-plan limit is hit (the 5-tag limit, tapping Download on a Community tag, or opening Advanced Settings).

---

## Recording checklist (not part of the text reply — for your own reference while filming)

- [ ] Record on a physical device, latest iOS, starting from a cold launch (app not already running).
- [ ] Account registration (real/temporary email) → login → account deletion → attempt login again with the deleted account (should fail).
- [ ] Review a card; review cards filtered by tag.
- [ ] Create a card, assigning it to a new tag.
- [ ] Delete that tag; delete a card.
- [ ] Report a tag in Community (shows the content-moderation mechanism).
- [ ] Upgrade to Premium via sandbox purchase — pause on the paywall long enough to clearly show both plans' title, duration, and price, and tap through both the Privacy Policy and Terms of Use links to prove they open.
- [ ] Download a tag from Community (Premium-gated).
- [ ] Use Advanced Settings to customize card display.
- [ ] Confirm this is filmed against the build actually being submitted (Build 4, once the paywall's legal links are included).
