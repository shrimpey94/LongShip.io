/* busterrdust.com Worker.
   Every page on the site is served straight from the files (this code never runs for them).
   Only two paths come here:
     /games/longship/lobby    → hands the player to a Longship.io lobby (one Durable Object per lobby)
     /games/longship/discord  → Longship Bot, the Discord app for the LongShip.io server (server/bot.js)
     /api/visits              → the visit counter on the games page (GET reads it, POST adds one visit)
     /api/ref/…               → referrals: invite links, +10 Runes per recruit (server/referrals.js)
     /api/store/…             → the Gold Runes store (server/store.js). Closed until its Stripe + Firebase secrets are set.
   The cron in wrangler.jsonc runs Longship Bot's check for new videos every 10 minutes. */
import { Lobby } from "./lobby.js";
import { BotState, handleDiscord, scheduledBot } from "./bot.js";
import { handleStore } from "./store.js";
import { handleReferrals } from "./referrals.js";
export { Lobby, BotState };

// Visit counter. The page only POSTs once per browser every 30 minutes (refreshing doesn't add more),
// and obvious bots and link previews are ignored. The number lives in the bot's storage under "visits".
const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless|lighthouse|pingdom|curl|wget|python|discord/i;
async function visits(request, env) {
  const store = env.BOT.get(env.BOT.idFromName("site-counters"));
  const human = !BOTS.test(request.headers.get("User-Agent") || "");
  const op = request.method === "POST" && human ? "add" : "get";
  const r = await store.fetch("https://bot/", { method: "POST", body: JSON.stringify({ op, key: "visits" }) });
  const { val } = await r.json();
  return new Response(JSON.stringify({ visits: val || 0 }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/games/longship/lobby") {
      const n = Math.max(1, Math.min(99, parseInt(url.searchParams.get("n"), 10) || 1));
      return env.LOBBY.get(env.LOBBY.idFromName("lobby-" + n)).fetch(request);
    }
    if (url.pathname === "/games/longship/discord") return handleDiscord(request, env, ctx);
    if (url.pathname === "/api/visits") return visits(request, env);
    if (url.pathname.startsWith("/api/store/")) return handleStore(request, env);
    if (url.pathname.startsWith("/api/ref/")) return handleReferrals(request, env);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledBot(env).catch(e => console.log("Longship Bot:", e.message)));
  },
};
