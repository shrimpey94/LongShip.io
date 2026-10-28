// Offline tests for server/referrals.js. Run: node tests/referrals.test.mjs
import { handleReferrals, RUNES_PER_RECRUIT, REWARD_AT } from "../server/referrals.js";
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


const db = memDb(), CREATED = {};
const env = { FIREBASE_SA: "{}" };
const deps = { db, keys: async () => [jwk], createdAt: async uid => CREATED[uid] ?? Date.now() - 3600e3 };
const call = async (path, uid, body) => { const r = await handleReferrals(new Request("https://x/api/ref/" + path, { method: body ? "POST" : "GET",
  headers: uid ? { authorization: "Bearer " + await idToken(uid) } : {}, body: body && JSON.stringify(body) }), env, deps); return { status: r.status, body: await r.json() }; };
const wallet = uid => (db.docs.get("wallets/" + uid) || { data: {} }).data;

let r = await call("me");
ok(r.status === 401, "needs sign-in");
r = await call("me", "dylan"); const code = r.body.code;
ok(r.status === 200 && /^[A-Z2-9]{6}$/.test(code) && r.body.recruits === 0 && r.body.goal === REWARD_AT, "first visit makes a 6-letter code");
r = await call("me", "dylan"); ok(r.body.code === code, "same code every time");
r = await call("claim", "dylan", { code }); ok(r.status === 409 && wallet("dylan").runes === undefined, "can't recruit yourself");
r = await call("claim", "friend1", { code: "ZZZZZZ" }); ok(r.status === 404 && r.body.final, "unknown code refused");
CREATED.oldtimer = Date.now() - 30 * 864e5;
r = await call("claim", "oldtimer", { code }); ok(r.status === 409 && r.body.final, "old accounts don't count");
r = await call("claim", "friend1", { code: code.toLowerCase() });
ok(r.status === 200 && wallet("dylan").runes === RUNES_PER_RECRUIT, "a new player counts: +10 Runes");
r = await call("claim", "friend1", { code }); ok(r.status === 409 && wallet("dylan").runes === RUNES_PER_RECRUIT, "the same recruit can't count twice");
const two = await Promise.all([call("claim", "friend2", { code }), call("claim", "friend2", { code })]);
ok(two.filter(x => x.status === 200).length === 1 && wallet("dylan").runes === 2 * RUNES_PER_RECRUIT, "a double send counts once");
for (let i = 3; i <= 9; i++) await call("claim", "friend" + i, { code });
ok(!(wallet("dylan").owned || []).includes("warband") && wallet("dylan").runes === 90, "9 recruits: 90 Runes, no skin yet");
await Promise.all([call("claim", "friend10", { code }), call("claim", "friend11", { code })]);
r = await call("me", "dylan");
ok(r.body.recruits === 11 && wallet("dylan").runes === 110 && wallet("dylan").owned.join() === "warband" && r.body.rewardOwned, "10th recruit unlocks the Warband skin (11 counted correctly at once)");
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
