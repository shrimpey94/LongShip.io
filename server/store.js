/* Longship.io store: Gold Runes and premium skins, paid through Stripe.

   Who decides what a player owns: only this file. The browser never writes Runes or premium skins.
     - Paying money:  the game asks /api/store/checkout → this makes a Stripe Checkout page at the catalog price →
                      the player pays on Stripe's own page → Stripe calls /api/store/webhook (signed) → Runes or the
                      skin are added to wallets/{uid} in Firestore, once per payment.
     - Spending Runes: the game asks /api/store/buy with the player's sign-in token → the price is checked here and
                      the Runes come off and the skin goes on in one step.
     - Reading:       /api/store/wallet (signed in) and /api/store/catalog (anyone).

   Firestore docs only this Worker writes (the Firestore rules give players no access to them):
     wallets/{uid}         { runes, owned: [skin ids], flagged? }
     purchases/{id}        one per Stripe payment ("cs_…") or Rune spend ("spend_{uid}_{item}"); blocks double credits
     disputes/{id}         a chargeback, so you can decide what to do about that account

   Secrets (Cloudflare → Workers → busterrdust → Settings → Variables and Secrets, type Secret). Never paste them here.
     STRIPE_SECRET_KEY      sk_test_… while testing. A live key (sk_live_…) is refused unless STORE_LIVE is "1".
     STRIPE_WEBHOOK_SECRET  whsec_… from the webhook you add in Stripe for https://busterrdust.com/api/store/webhook
     FIREBASE_SA            the whole JSON file of a Firebase service account (Project settings → Service accounts)
   Plain variable:
     STORE_LIVE             leave unset until the store is fully tested. Set to "1" only on launch day. */

const PROJECT = "longshipio";
const GAME_URL = "https://busterrdust.com/games/longship/";
// Stripe tax category. Required with Stripe Managed Payments (Stripe is the seller of record and handles sales tax).
// txcd_10201000 = "Video Games - non subscription - with permanent rights" (Runes and skins are kept forever).
const TAX_CODE = "txcd_10201000";

/* ---------------- catalog (prices live ONLY here) ----------------
   100 Runes = $1. Skin prices in Runes and in dollars always match.
   Tiers: common 300 / $2.99 · premium 700 / $6.99 · legendary 1,500 / $14.99 · mythic 3,000 / $29.99
   Limited-time items: add from/to (ISO dates, UTC). Outside the window they can't be bought, but owners keep them. */
export const TIERS = { common: [300, 299], premium: [700, 699], legendary: [1500, 1499], mythic: [3000, 2999] };
export const PACKS = [
  { id: "runes_300",   name: "Starter Pouch",  runes: 300,   cents: 299 },
  { id: "runes_550",   name: "Bag of Runes",   runes: 550,   cents: 499,  bonus: "+10%" },
  { id: "runes_2400",  name: "Chest of Runes", runes: 2400,  cents: 1999, bonus: "+20%" },
  { id: "runes_13000", name: "Jarl's Hoard",   runes: 13000, cents: 9999, bonus: "+30%" },
];
export const SKINS = [
  { id: "odin", name: "Odin",  tier: "mythic", blurb: "Two ravens circle your ship. Your victims are carried off by ravens." },
  { id: "thor", name: "Thor",  tier: "mythic", blurb: "Lightning runs along the hull. Your victims are struck by lightning." },
  { id: "loki", name: "Loki",  tier: "mythic", blurb: "Your hull shifts color. Your victims burst into green flame." },
].map(s => ({ ...s, runes: TIERS[s.tier][0], cents: TIERS[s.tier][1] }));

/* Every other cosmetic (ship skins, figureheads, trails) can ALSO be bought with Gold Runes, besides plunder or its feat.
   [id, Runes, season?]. Generated from the game's item lists: plunder cost <=1,000 → 300 · <=4,000 → 700 · <=9,000 → 1,500 ·
   more → 3,000 · feat-only items → 700. Seasonal ones can only be bought while their season is on (calendar in sim.js). */
export const RUNE_ITEMS = Object.fromEntries([
  ["raven",300], ["frost",300], ["jarl",700], ["aurora",700], ["thunder",700], ["kraken",700],
  ["blood",700], ["ember",700], ["valhalla",700], ["ghost",700,"halloween"], ["bone",700,"halloween"], ["pumpkin",300,"halloween"],
  ["candycane",300,"christmas"], ["frostbite",700,"christmas"], ["ginger",700,"christmas"], ["serpent",300], ["ravenh",300], ["bear",700],
  ["skull",700], ["gdragon",700], ["ramh",700], ["firedrake",700], ["frostwyrm",700], ["krakenh",700],
  ["ravens",700], ["phoenix",1500], ["fenrir",1500], ["sleipnir",1500], ["jorm",3000], ["valkyrie",3000],
  ["sol",3000], ["jack",700,"halloween"], ["bat",300,"halloween"], ["wraith",300,"halloween"], ["reindeer",700,"christmas"], ["snowman",300,"christmas"],
  ["yulestar",300,"christmas"], ["glitter",300], ["frostt",300], ["embert",300], ["feathert",700], ["inkt",700],
  ["sparkt",700], ["auroratr",700], ["lightt",700], ["venomt",1500], ["bifrost",1500], ["valkt",3000],
  ["mistt",300,"halloween"], ["pleavest",300,"halloween"], ["snowt",300,"christmas"], ["candyt",300,"christmas"],
].map(([id, runes, season]) => [id, { id, runes, season: season || null }]));
const seasonOn = (season, now = Date.now()) => { if (!season) return true; const S = globalThis.LongshipSim; return !!(S && S.itemWindow(season, now)); };   // item sale window
const onSale = (it, now = Date.now()) => (!it.from || now >= Date.parse(it.from)) && (!it.to || now < Date.parse(it.to));
export function findItem(id) {
  const p = PACKS.find(x => x.id === id); if (p) return { kind: "pack", ...p };
  const s = SKINS.find(x => x.id === id); if (s) return { kind: "skin", ...s };
  const r = RUNE_ITEMS[id]; if (r) return { kind: "item", ...r };   // Runes only
  return null;
}
export const publicCatalog = (env = {}) => ({
  public: env.STORE_PUBLIC === "1",                                   // everyone sees the store (else admins only)
  mode: isLiveKey(env.STRIPE_SECRET_KEY) ? "live" : "test",
  packs: PACKS,
  skins: SKINS.filter(s => onSale(s)).map(({ id, name, tier, blurb, runes, cents, to }) => ({ id, name, tier, blurb, runes, cents, to: to || null })),
  items: Object.fromEntries(Object.values(RUNE_ITEMS).filter(r => seasonOn(r.season)).map(r => [r.id, r.runes])),
});

/* ---------------- small helpers ---------------- */
export const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = s => b64url(enc.encode(s));
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
function sameText(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
// live keys: sk_live_ (standard), rk_live_ (limited permissions) or any newer format with _live_ in it.
// Trimmed, because a pasted secret can pick up a stray space or line break.
const isLiveKey = k => /_live_/.test((k || "").trim());
export function storeOpen(env) {
  const k = env.STRIPE_SECRET_KEY || "";
  if (!k || !env.FIREBASE_SA) return "The store isn't set up yet.";
  if (isLiveKey(k) && env.STORE_LIVE !== "1") return "Live payments are switched off until the store is tested.";
  return null;
}

/* ---------------- who is asking: Firebase sign-in token ----------------
   Google signs these tokens; their public keys are published as JWKs. */
let jwks = { keys: null, until: 0 };
export async function googleKeys(fetcher = fetch) {
  if (jwks.keys && Date.now() < jwks.until) return jwks.keys;
  const r = await fetcher("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
  const age = +((r.headers.get("cache-control") || "").match(/max-age=(\d+)/) || [])[1] || 3600;
  jwks = { keys: (await r.json()).keys, until: Date.now() + age * 1000 };
  return jwks.keys;
}
export async function verifyIdToken(token, keys) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) throw new Error("bad token");
  const head = JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
  const body = JSON.parse(new TextDecoder().decode(unb64url(parts[1])));
  if (head.alg !== "RS256") throw new Error("bad token");
  const jwk = keys.find(k => k.kid === head.kid); if (!jwk) throw new Error("bad token");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64url(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  const now = Date.now() / 1000;
  if (!ok || body.aud !== PROJECT || body.iss !== "https://securetoken.google.com/" + PROJECT
      || !(body.exp > now) || !(body.iat <= now + 300) || !body.sub || body.sub.length > 128) throw new Error("bad token");
  return { uid: body.sub, email: body.email || null };
}
async function whoIs(request, env, deps) {
  const t = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!t) return null;
  try { return await verifyIdToken(t, await (deps.keys || googleKeys)()); } catch (e) { return null; }
}

/* ---------------- Firestore, as the Worker (service account) ---------------- */
let gtok = { token: null, until: 0 };
async function pemKey(pem) {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), c => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
export async function googleToken(env, fetcher) {
  if (gtok.token && Date.now() < gtok.until) return gtok.token;
  const sa = JSON.parse(env.FIREBASE_SA), now = Math.floor(Date.now() / 1000);
  const unsigned = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." +
    b64urlText(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await pemKey(sa.private_key), enc.encode(unsigned));
  const r = await fetcher("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + unsigned + "." + b64url(sig) });
  const d = await r.json(); if (!d.access_token) throw new Error("Google sign-in for the Worker failed");
  gtok = { token: d.access_token, until: Date.now() + (d.expires_in - 120) * 1000 };
  return gtok.token;
}
const DOCS = `projects/${PROJECT}/databases/(default)/documents`;
const FS = "https://firestore.googleapis.com/v1/";
export const val = v => typeof v === "number" ? { integerValue: String(Math.trunc(v)) } : typeof v === "boolean" ? { booleanValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(val) } } : v === null ? { nullValue: null } : { stringValue: String(v) };
export const fields = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, val(v)]));
const plain = f => { if (!f) return null; if ("integerValue" in f) return +f.integerValue; if ("stringValue" in f) return f.stringValue; if ("booleanValue" in f) return f.booleanValue;
  if ("arrayValue" in f) return (f.arrayValue.values || []).map(plain); if ("timestampValue" in f) return f.timestampValue; return null; };

export function firestore(env, fetcher = fetch) {
  const call = async (method, url, body) => fetcher(url, { method, headers: { authorization: "Bearer " + await googleToken(env, fetcher), "content-type": "application/json" }, body: body && JSON.stringify(body) });
  return {
    async get(path) {
      const r = await call("GET", FS + DOCS + "/" + path);
      if (r.status === 404) return { exists: false, data: {}, updateTime: null };
      if (!r.ok) throw new Error("Firestore read failed (" + r.status + ")");
      const d = await r.json();
      return { exists: true, data: Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, plain(v)])), updateTime: d.updateTime };
    },
    async commit(writes) {   // all or nothing; returns "ok" | "conflict"
      const r = await call("POST", FS + DOCS + ":commit", { writes });
      if (r.ok) return "ok";
      const t = await r.text();
      if (r.status === 409 || /FAILED_PRECONDITION|ALREADY_EXISTS|ABORTED/.test(t)) return "conflict";   // a precondition failed: already credited, or the wallet changed
      throw new Error("Firestore write failed (" + r.status + "): " + t.slice(0, 200));
    },
    name: path => DOCS + "/" + path,
  };
}
// A wallet change that also creates the wallet if it doesn't exist yet, without touching its other fields.
export const walletChange = (db, uid, { runes = 0, add = null, remove = null }, pre) => ({
  update: { name: db.name("wallets/" + uid), fields: {} }, updateMask: { fieldPaths: [] },
  updateTransforms: [
    ...(runes ? [{ fieldPath: "runes", increment: val(runes) }] : []),
    ...(add ? [{ fieldPath: "owned", appendMissingElements: { values: [val(add)] } }] : []),
    ...(remove ? [{ fieldPath: "owned", removeAllFromArray: { values: [val(remove)] } }] : []),
  ],
  ...(pre ? { currentDocument: pre } : {}),
});
const record = (db, id, o) => ({ update: { name: db.name("purchases/" + id), fields: fields({ ...o, at: new Date().toISOString() }) }, currentDocument: { exists: false } });

/* ---------------- Stripe ---------------- */
const form = (o, pre = "") => Object.entries(o).flatMap(([k, v]) => {
  const key = pre ? `${pre}[${k}]` : k;
  return v && typeof v === "object" ? form(v, key) : v === undefined ? [] : [encodeURIComponent(key) + "=" + encodeURIComponent(v)];
});
async function stripe(env, fetcher, method, path, body) {
  const r = await fetcher("https://api.stripe.com/v1/" + path, { method, headers: { authorization: "Bearer " + (env.STRIPE_SECRET_KEY || "").trim(), "content-type": "application/x-www-form-urlencoded" }, body: body && form(body).join("&") });
  const d = await r.json(); if (!r.ok) throw new Error("Stripe: " + ((d.error && d.error.message) || r.status));
  return d;
}
// Stripe signs every webhook: header "t=<time>,v1=<hmac>" over "<time>.<raw body>" with the whsec_ secret.
export async function stripeSignatureOk(raw, header, secret, nowSec = Date.now() / 1000) {
  const parts = Object.fromEntries((header || "").split(",").map(p => p.split("=")).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = (header || "").split(",").filter(p => p.trim().startsWith("v1=")).map(p => p.trim().slice(3));
  if (!parts.t || !sigs.length || Math.abs(nowSec - +parts.t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await crypto.subtle.sign("HMAC", key, enc.encode(parts.t + "." + raw)));
  return sigs.some(s => sameText(s, want));
}

/* ---------------- the endpoints ---------------- */
export async function handleStore(request, env, deps = {}) {
  const fetcher = deps.fetch || fetch;
  const path = new URL(request.url).pathname.replace(/^\/api\/store\/?/, "");
  try {
    if (path === "catalog") return json(publicCatalog(env));

    const closed = storeOpen(env);
    if (closed) return json({ error: closed }, 503);
    const db = deps.db || firestore(env, fetcher);

    if (path === "webhook" && request.method === "POST") return webhook(request, env, db, fetcher);

    const me = await whoIs(request, env, deps);
    if (!me) return json({ error: "Sign in first." }, 401);

    if (path === "wallet") {
      const w = await db.get("wallets/" + me.uid);
      return json({ runes: w.data.runes || 0, owned: w.data.owned || [] });
    }

    if (request.method !== "POST") return json({ error: "Not found" }, 404);
    const { item: id } = await request.json().catch(() => ({}));
    const it = findItem(id);
    if (!it) return json({ error: "That item doesn't exist." }, 400);

    if (path === "checkout") {
      if (it.kind === "item") return json({ error: "That one is bought with Gold Runes." }, 400);
      if (it.kind === "skin") {
        if (!onSale(it)) return json({ error: "That skin isn't for sale right now." }, 409);
        const w = await db.get("wallets/" + me.uid);
        if ((w.data.owned || []).includes(it.id)) return json({ error: "You already own that skin." }, 409);
      }
      const s = await stripe(env, fetcher, "POST", "checkout/sessions", {
        mode: "payment",
        success_url: GAME_URL + "?store=paid",
        cancel_url: GAME_URL + "?store=cancel",
        client_reference_id: me.uid,
        customer_email: me.email || undefined,
        line_items: { 0: { quantity: 1, price_data: { currency: "usd", unit_amount: it.cents,
          product_data: { name: it.kind === "pack" ? `${it.name} · ${it.runes.toLocaleString("en-US")} Gold Runes` : `${it.name} skin (Longship.io)`,
            tax_code: TAX_CODE } } } },
        metadata: { uid: me.uid, item: it.id },
        payment_intent_data: { metadata: { uid: me.uid, item: it.id } },
        // (no custom_text: Stripe Managed Payments, on by default for this account, doesn't allow it. The store screen shows the terms.)
      });
      return json({ url: s.url });
    }

    if (path === "buy") {
      if (it.kind === "pack") return json({ error: "Rune packs are bought with money, not Runes." }, 400);
      if (!onSale(it) || !seasonOn(it.season)) return json({ error: "That isn't for sale right now." }, 409);
      for (let tries = 0; tries < 4; tries++) {
        const w = await db.get("wallets/" + me.uid);
        const runes = w.data.runes || 0, owned = w.data.owned || [];
        if (owned.includes(it.id)) return json({ error: "You already own that.", runes, owned }, 409);
        if (runes < it.runes) return json({ error: `You need ${(it.runes - runes).toLocaleString("en-US")} more Runes.`, runes, owned }, 402);
        const res = await db.commit([
          walletChange(db, me.uid, { runes: -it.runes, add: it.id }, w.exists ? { updateTime: w.updateTime } : { exists: false }),
          record(db, `spend_${me.uid}_${it.id}`, { uid: me.uid, item: it.id, kind: "spend", runes: it.runes }),
        ]);
        if (res === "ok") return json({ ok: true, runes: runes - it.runes, owned: [...owned, it.id] });
        // someone else changed the wallet at the same moment (or a double click): read again and retry
      }
      return json({ error: "Busy, try again." }, 409);
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    console.log("store:", e.message);
    // Stripe's own error messages are safe to show (no keys in them) and say exactly what to fix.
    if (e.message.startsWith("Stripe: ")) return json({ error: e.message }, 502);
    return json({ error: "Something went wrong. Nothing was charged twice; try again in a minute." }, 500);
  }
}

async function webhook(request, env, db, fetcher) {
  const raw = await request.text();
  if (!(await stripeSignatureOk(raw, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET || ""))) return json({ error: "bad signature" }, 400);
  const ev = JSON.parse(raw), o = ev.data && ev.data.object || {};

  if ((ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") && o.payment_status === "paid") {
    const uid = o.metadata && o.metadata.uid, it = findItem(o.metadata && o.metadata.item);
    if (!uid || !it) { console.log("store: paid session with no uid/item", o.id); return json({ ok: true }); }
    if (o.amount_total !== it.cents || (o.currency || "").toLowerCase() !== "usd") console.log("store: amount mismatch on", o.id, o.amount_total, it.cents);
    const res = await db.commit([
      record(db, o.id, { uid, item: it.id, kind: it.kind, cents: o.amount_total || 0, runes: it.kind === "pack" ? it.runes : 0, pi: o.payment_intent || "" }),
      walletChange(db, uid, it.kind === "pack" ? { runes: it.runes } : { add: it.id }),
    ]);
    return json({ ok: true, credited: res === "ok" });   // "conflict" = this payment was already credited (Stripe retried)
  }

  // No refunds from Busterrdust. But if Stripe (Managed Payments) refunds a payment in full, or the buyer's bank
  // starts a chargeback, everything that payment bought is taken back: Runes come off (the balance can go below
  // zero if they were already spent) and a bought skin is removed. Each payment is reversed at most once.
  const fullRefund = ev.type === "charge.refunded" && o.refunded === true;
  if (fullRefund || ev.type === "charge.dispute.created") {
    const pi = o.payment_intent || "";
    let meta = {};
    try { if (pi) meta = (await stripe(env, fetcher, "GET", "payment_intents/" + pi)).metadata || {}; } catch (e) {}
    const uid = meta.uid || "", it = findItem(meta.item);
    const writes = [];
    if (ev.type === "charge.dispute.created")
      writes.push({ update: { name: db.name("disputes/" + o.id), fields: fields({ uid, pi, cents: o.amount || 0, reason: o.reason || "", at: new Date().toISOString() }) } });
    if (uid && it && pi) {
      writes.push({ update: { name: db.name("reversals/" + pi), fields: fields({ uid, item: it.id, why: fullRefund ? "refund" : "chargeback", at: new Date().toISOString() }) }, currentDocument: { exists: false } });
      writes.push(walletChange(db, uid, it.kind === "pack" ? { runes: -it.runes } : { remove: it.id }));
    }
    if (uid && ev.type === "charge.dispute.created") writes.push({ update: { name: db.name("wallets/" + uid), fields: fields({ flagged: true }) }, updateMask: { fieldPaths: ["flagged"] } });
    let res = writes.length ? await db.commit(writes) : "ok";
    if (res === "conflict" && ev.type === "charge.dispute.created")   // already reversed by a refund: still record the dispute + flag, take nothing twice
      res = await db.commit(writes.filter(w => /\/(disputes)\//.test(w.update.name) || (w.updateMask && w.updateMask.fieldPaths[0] === "flagged")));
    return json({ ok: true, reversed: !!(uid && it) && res === "ok" });
  }
  return json({ ok: true, ignored: ev.type });
}
