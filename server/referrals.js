/* Longship.io referrals: "recruit a Viking".

   Every signed-in player gets a link like busterrdust.com/games/longship/?ref=AB12CD.
   A recruit COUNTS when someone opens that link, signs in with a brand-new Google sign-in (created in the last
   7 days, never recruited before, not the referrer), and finishes a voyage. Then the referrer gets:
     +RUNES_PER_RECRUIT Gold Runes every time, and the exclusive REWARD_SKIN at REWARD_AT recruits (it can't be bought).

   Endpoints (Firebase sign-in token required):
     GET  /api/ref/me     → { code, recruits, goal, perRecruit, reward, rewardOwned }   (makes your code the first time)
     POST /api/ref/claim  → { code }  called by the recruit's game after their first finished voyage

   Firestore docs only this Worker writes (players have no access in the Firestore rules):
     refcodes/{code}   { uid }                 who owns a code
     referrers/{uid}   { code, recruits }      a referrer's tally
     refby/{uid}       { by, code, at }        who recruited this player (one per player, ever) */
import { json, verifyIdToken, googleKeys, firestore, googleToken, fields, val, walletChange } from "./store.js";

export const RUNES_PER_RECRUIT = 10;
export const REWARD_AT = 10;
export const REWARD_SKIN = "warband";
const NEW_ACCOUNT_MS = 7 * 864e5;
const CODE_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0/O, 1/I/L
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => CODE_ABC[b % CODE_ABC.length]).join("");
export const cleanCode = c => (typeof c === "string" && /^[A-Z2-9]{6}$/.test(c.toUpperCase()) ? c.toUpperCase() : null);

// when this Google sign-in was created (Firebase Auth, read with the Worker's service account)
async function accountCreatedAt(env, uid, fetcher) {
  const r = await fetcher("https://identitytoolkit.googleapis.com/v1/projects/longshipio/accounts:lookup", {
    method: "POST", headers: { authorization: "Bearer " + await googleToken(env, fetcher), "content-type": "application/json" },
    body: JSON.stringify({ localId: [uid] }) });
  if (!r.ok) throw new Error("account lookup failed (" + r.status + ")");
  const u = ((await r.json()).users || [])[0];
  return u ? +u.createdAt : 0;
}

export async function handleReferrals(request, env, deps = {}) {
  const fetcher = deps.fetch || fetch;
  const path = new URL(request.url).pathname.replace(/^\/api\/ref\/?/, "");
  try {
    if (!env.FIREBASE_SA) return json({ error: "Referrals aren't set up yet." }, 503);
    const t = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    let me = null; try { me = t && await verifyIdToken(t, await (deps.keys || googleKeys)()); } catch (e) {}
    if (!me) return json({ error: "Sign in first." }, 401);
    const db = deps.db || firestore(env, fetcher);

    if (path === "me" && request.method === "GET") {
      let r = await db.get("referrers/" + me.uid);
      if (!r.exists) {   // first time: claim a fresh code
        for (let i = 0; i < 5 && !r.exists; i++) {
          const code = newCode();
          const res = await db.commit([
            { update: { name: db.name("refcodes/" + code), fields: fields({ uid: me.uid }) }, currentDocument: { exists: false } },
            { update: { name: db.name("referrers/" + me.uid), fields: fields({ code, recruits: 0 }) }, currentDocument: { exists: false } },
          ]);
          r = await db.get("referrers/" + me.uid);   // "conflict" = code taken, or made a moment ago in another tab
        }
        if (!r.exists) return json({ error: "Try again in a moment." }, 503);
      }
      const w = await db.get("wallets/" + me.uid);
      return json({ code: r.data.code, recruits: r.data.recruits || 0, goal: REWARD_AT, perRecruit: RUNES_PER_RECRUIT, reward: REWARD_SKIN,
        rewardOwned: (w.data.owned || []).includes(REWARD_SKIN) });
    }

    if (path === "claim" && request.method === "POST") {
      const { code: raw } = await request.json().catch(() => ({}));
      const code = cleanCode(raw);
      if (!code) return json({ error: "That invite code isn't valid.", final: true }, 400);
      const owner = await db.get("refcodes/" + code);
      if (!owner.exists) return json({ error: "That invite code isn't valid.", final: true }, 404);
      const by = owner.data.uid;
      if (by === me.uid) return json({ error: "You can't recruit yourself.", final: true }, 409);
      if ((await db.get("refby/" + me.uid)).exists) return json({ error: "You were already recruited.", final: true }, 409);
      const created = await (deps.createdAt || (uid => accountCreatedAt(env, uid, fetcher)))(me.uid);
      if (!created || Date.now() - created > NEW_ACCOUNT_MS) return json({ error: "Invites only count for new players.", final: true }, 409);

      for (let tries = 0; tries < 4; tries++) {
        const ref = await db.get("referrers/" + by);
        const n = (ref.data.recruits || 0) + 1, reward = n >= REWARD_AT;
        const res = await db.commit([
          { update: { name: db.name("refby/" + me.uid), fields: fields({ by, code, at: new Date().toISOString() }) }, currentDocument: { exists: false } },
          { update: { name: db.name("referrers/" + by), fields: { recruits: val(n) } }, updateMask: { fieldPaths: ["recruits"] },
            currentDocument: ref.exists ? { updateTime: ref.updateTime } : { exists: false } },
          walletChange(db, by, { runes: RUNES_PER_RECRUIT, add: reward ? REWARD_SKIN : null }),
        ]);
        if (res === "ok") return json({ ok: true });
        if ((await db.get("refby/" + me.uid)).exists) return json({ error: "You were already recruited.", final: true }, 409);   // a double send
      }
      return json({ error: "Busy, try again." }, 409);
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    console.log("referrals:", e.message);
    return json({ error: "Something went wrong. Try again in a minute." }, 500);
  }
}
