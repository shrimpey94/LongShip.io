// Offline tests for server/store.js: fake Stripe, fake Google sign-in keys, and an in-memory Firestore
// that applies writes all-or-nothing with the same preconditions and transforms the real one uses.
// Run: node tests/store.test.mjs
import { handleStore, stripeSignatureOk, verifyIdToken, PACKS, SKINS } from "../server/store.js";

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log("FAIL:", msg); } };
const enc = new TextEncoder();
const b64url = buf => Buffer.from(buf).toString("base64url");

/* ---- fake Google sign-in ---- */
const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
async function idToken(uid, over = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "RS256", kid: "k1" }));
  const b = b64url(JSON.stringify({ aud: "longshipio", iss: "https://securetoken.google.com/longshipio", sub: uid, iat: now, exp: now + 3600, email: uid + "@test.dev", ...over }));
  const s = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, enc.encode(h + "." + b));
  return h + "." + b + "." + b64url(s);
}

/* ---- in-memory Firestore ---- */
function memDb() {
  const docs = new Map(); let clock = 0;
  const key = name => name.split("/documents/")[1];
  return {
    docs,
    name: p => "projects/longshipio/databases/(default)/documents/" + p,
    async get(p) { const d = docs.get(p); return d ? { exists: true, data: structuredClone(d.data), updateTime: d.t } : { exists: false, data: {}, updateTime: null }; },
    async commit(writes) {
      const next = new Map([...docs].map(([k, v]) => [k, { data: structuredClone(v.data), t: v.t }]));
      for (const w of writes) {
        const p = key(w.update.name), cur = next.get(p), pre = w.currentDocument;
        if (pre && "exists" in pre && !!cur !== pre.exists) return "conflict";
        if (pre && pre.updateTime && (!cur || cur.t !== pre.updateTime)) return "conflict";
        const data = cur ? cur.data : {};
        const val = f => "integerValue" in f ? +f.integerValue : "stringValue" in f ? f.stringValue : "booleanValue" in f ? f.booleanValue : "arrayValue" in f ? (f.arrayValue.values || []).map(val) : null;
        const mask = w.updateMask ? w.updateMask.fieldPaths : null;
        const flds = Object.fromEntries(Object.entries(w.update.fields || {}).map(([k, v]) => [k, val(v)]));
        const nd = mask ? { ...data, ...Object.fromEntries(mask.map(k => [k, flds[k]])) } : flds;
        for (const t of w.updateTransforms || []) {
          if (t.increment) nd[t.fieldPath] = (nd[t.fieldPath] || 0) + val(t.increment);
          if (t.removeAllFromArray) { const rm = t.removeAllFromArray.values.map(val); nd[t.fieldPath] = (nd[t.fieldPath] || []).filter(x => !rm.includes(x)); }
          if (t.appendMissingElements) { const a = nd[t.fieldPath] || []; for (const v of t.appendMissingElements.values.map(val)) if (!a.includes(v)) a.push(v); nd[t.fieldPath] = a; }
        }
        next.set(p, { data: nd, t: "t" + (++clock) });
      }
      docs.clear(); for (const [k, v] of next) docs.set(k, v); return "ok";
    },
  };
}

/* ---- fake Stripe ---- */
const stripeCalls = [];
const PI_META = { pi_cs_1: { uid: "alice", item: "runes_300" }, pi_cs_4: { uid: "bob", item: "thor" } };
const fakeFetch = async (url, init = {}) => {
  stripeCalls.push({ url, body: init.body || "" });
  if (url.includes("checkout/sessions")) return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/pay/cs_test_1" }), { status: 200 });
  if (url.includes("payment_intents/")) { const id = url.split("payment_intents/")[1]; const m = PI_META[id] || { uid: "alice" }; return new Response(JSON.stringify({ metadata: m }), { status: 200 }); }
  return new Response("{}", { status: 404 });
};

const SECRET = "whsec_testsecret";
const env = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: SECRET, FIREBASE_SA: "{}" };
const db = memDb();
const deps = { db, fetch: fakeFetch, keys: async () => [jwk] };
const call = async (path, { method = "POST", body, uid, headers = {}, e = env } = {}) => {
  const h = { ...headers }; if (uid) h.authorization = "Bearer " + await idToken(uid);
  const r = await handleStore(new Request("https://busterrdust.com/api/store/" + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }), e, deps);
  return { status: r.status, body: await r.json() };
};
async function signed(event, t = Math.floor(Date.now() / 1000), secret = SECRET) {
  const raw = JSON.stringify(event);
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign("HMAC", k, enc.encode(t + "." + raw))).toString("hex");
  return { raw, header: `t=${t},v1=${sig}` };
}
const paid = (id, uid, item, cents) => ({ type: "checkout.session.completed", data: { object: { id, payment_status: "paid", amount_total: cents, currency: "usd", payment_intent: "pi_" + id, metadata: { uid, item } } } });
const wallet = uid => (db.docs.get("wallets/" + uid) || { data: {} }).data;

/* ---- tests ---- */
// catalog
let r = await call("catalog", { method: "GET" });
ok(r.status === 200 && r.body.packs.length === 4 && r.body.skins.length === 3, "catalog lists 4 packs and 3 skins");
ok(PACKS[0].cents === 299 && PACKS[0].runes === 300, "starter pack is 300 Runes for $2.99");
ok(SKINS.every(s => s.runes === s.cents + 1), "every skin's Rune price matches its dollar price");

// store closed without secrets, and live keys refused
r = await call("wallet", { method: "GET", uid: "alice", e: {} });
ok(r.status === 503, "store closed when secrets are missing");
r = await call("wallet", { method: "GET", uid: "alice", e: { ...env, STRIPE_SECRET_KEY: "sk_live_x" } });
ok(r.status === 503, "live key refused unless STORE_LIVE=1");

// sign-in required, and forged/expired tokens refused
r = await call("wallet", { method: "GET" });
ok(r.status === 401, "wallet needs sign-in");
r = await call("wallet", { method: "GET", headers: { authorization: "Bearer " + await idToken("alice", { aud: "otherproject" }) } });
ok(r.status === 401, "token for another Firebase project refused");
r = await call("wallet", { method: "GET", headers: { authorization: "Bearer " + await idToken("alice", { exp: 1 }) } });
ok(r.status === 401, "expired token refused");
const good = await idToken("alice"); const forged = good.slice(0, -4) + (good.endsWith("AAAA") ? "BBBB" : "AAAA");
r = await call("wallet", { method: "GET", headers: { authorization: "Bearer " + forged } });
ok(r.status === 401, "token with a broken signature refused");
r = await call("wallet", { method: "GET", uid: "alice" });
ok(r.status === 200 && r.body.runes === 0 && r.body.owned.length === 0, "new player's wallet is empty");

// checkout uses the catalog price, never the browser's
r = await call("checkout", { uid: "alice", body: { item: "runes_300", cents: 1, price: 1 } });
const sbody = decodeURIComponent(stripeCalls.at(-1).body);
ok(r.status === 200 && r.body.url.startsWith("https://checkout.stripe.com"), "checkout returns a Stripe page");
ok(sbody.includes("[unit_amount]=299") && sbody.includes("metadata[uid]=alice") && sbody.includes("metadata[item]=runes_300"), "Stripe gets the catalog price and the player's id");
r = await call("checkout", { uid: "alice", body: { item: "free_gold" } });
ok(r.status === 400, "unknown item refused");

// webhook: bad signatures refused
let ev = await signed(paid("cs_1", "alice", "runes_300", 299));
r = await call("webhook", { body: ev.raw, headers: { "stripe-signature": ev.header.replace(/.$/, ev.header.endsWith("0") ? "1" : "0") } });
ok(r.status === 400 && !wallet("alice").runes, "tampered signature refused, nothing credited");
let old = await signed(paid("cs_1", "alice", "runes_300", 299), Math.floor(Date.now() / 1000) - 3600);
r = await call("webhook", { body: old.raw, headers: { "stripe-signature": old.header } });
ok(r.status === 400, "hour-old (replayed) signature refused");
let wrong = await signed(paid("cs_1", "alice", "runes_300", 299), undefined, "whsec_other");
r = await call("webhook", { body: wrong.raw, headers: { "stripe-signature": wrong.header } });
ok(r.status === 400, "signature from another secret refused");

// webhook: credits once, even when Stripe sends it twice
r = await call("webhook", { body: ev.raw, headers: { "stripe-signature": ev.header } });
ok(r.status === 200 && r.body.credited === true && wallet("alice").runes === 300, "paid pack credits 300 Runes");
r = await call("webhook", { body: ev.raw, headers: { "stripe-signature": ev.header } });
ok(r.status === 200 && r.body.credited === false && wallet("alice").runes === 300, "same payment again credits nothing");
let unpaid = await signed({ type: "checkout.session.completed", data: { object: { id: "cs_u", payment_status: "unpaid", metadata: { uid: "alice", item: "runes_13000" } } } });
r = await call("webhook", { body: unpaid.raw, headers: { "stripe-signature": unpaid.header } });
ok(wallet("alice").runes === 300, "unpaid (declined/pending) session credits nothing");

// spending Runes
r = await call("buy", { uid: "alice", body: { item: "odin" } });
ok(r.status === 402 && wallet("alice").runes === 300, "can't buy a 3,000-Rune skin with 300");
for (const [id, n] of [["cs_2", "runes_2400"], ["cs_3", "runes_550"]]) { const e2 = await signed(paid(id, "alice", n, 0)); await call("webhook", { body: e2.raw, headers: { "stripe-signature": e2.header } }); }
ok(wallet("alice").runes === 3250, "more packs add up (300 + 2,400 + 550)");
const both = await Promise.all([call("buy", { uid: "alice", body: { item: "odin" } }), call("buy", { uid: "alice", body: { item: "odin" } })]);
ok(both.filter(x => x.status === 200).length === 1 && wallet("alice").runes === 250 && wallet("alice").owned.join() === "odin", "double-click buys once and charges once");
r = await call("buy", { uid: "alice", body: { item: "odin" } });
ok(r.status === 409 && wallet("alice").runes === 250, "can't buy a skin you already own");
r = await call("buy", { uid: "alice", body: { item: "runes_300" } });
ok(r.status === 400, "can't buy Rune packs with Runes");
r = await call("checkout", { uid: "alice", body: { item: "odin" } });
ok(r.status === 409, "can't pay money for a skin you already own");

// buying a skin directly with money
const thor = await signed(paid("cs_4", "bob", "thor", 2999));
r = await call("webhook", { body: thor.raw, headers: { "stripe-signature": thor.header } });
ok(wallet("bob").owned.join() === "thor" && !wallet("bob").runes, "direct skin purchase adds the skin, no Runes");

// refunds and chargebacks take the items back, once
r = await call("catalog", { method: "GET" });
ok(r.body.public === false && r.body.mode === "test", "catalog says test mode and not public by default");
const before = wallet("alice").runes;
let refund = await signed({ type: "charge.refunded", data: { object: { id: "ch_1", payment_intent: "pi_cs_1", refunded: true, amount: 299 } } });
r = await call("webhook", { body: refund.raw, headers: { "stripe-signature": refund.header } });
ok(r.body.reversed === true && wallet("alice").runes === before - 300, "full refund takes the 300 Runes back");
r = await call("webhook", { body: refund.raw, headers: { "stripe-signature": refund.header } });
ok(wallet("alice").runes === before - 300, "the same refund again takes nothing more");
const disp = await signed({ type: "charge.dispute.created", data: { object: { id: "dp_1", payment_intent: "pi_cs_1", amount: 299, reason: "fraudulent" } } });
r = await call("webhook", { body: disp.raw, headers: { "stripe-signature": disp.header } });
ok(db.docs.get("disputes/dp_1") && wallet("alice").flagged === true && wallet("alice").runes === before - 300, "chargeback after a refund is recorded + flagged, but nothing is taken twice");
const partial = await signed({ type: "charge.refunded", data: { object: { id: "ch_4", payment_intent: "pi_cs_4", refunded: false, amount_refunded: 100 } } });
r = await call("webhook", { body: partial.raw, headers: { "stripe-signature": partial.header } });
ok(wallet("bob").owned.join() === "thor", "partial refund changes nothing");
const disp2 = await signed({ type: "charge.dispute.created", data: { object: { id: "dp_2", payment_intent: "pi_cs_4", amount: 2999, reason: "fraudulent" } } });
r = await call("webhook", { body: disp2.raw, headers: { "stripe-signature": disp2.header } });
ok(wallet("bob").owned.length === 0 && wallet("bob").flagged === true, "chargeback on a skin purchase removes the skin and flags the account");

// other players can't see or spend someone else's wallet
r = await call("wallet", { method: "GET", uid: "mallory" });
ok(r.body.runes === 0 && r.body.owned.length === 0, "each player only sees their own wallet");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
