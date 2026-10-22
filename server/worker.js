/* busterrdust.com Worker.
   Every page on the site is served straight from the files (this code never runs for them).
   Only two paths come here:
     /games/longship/lobby    → hands the player to a Longship.io lobby (one Durable Object per lobby)
     /games/longship/discord  → Longship Bot, the Discord app for the LongShip.io server (server/bot.js)
   The cron in wrangler.jsonc runs Longship Bot's check for new videos every 10 minutes. */
import { Lobby } from "./lobby.js";
import { BotState, handleDiscord, scheduledBot } from "./bot.js";
export { Lobby, BotState };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/games/longship/lobby") {
      const n = Math.max(1, Math.min(99, parseInt(url.searchParams.get("n"), 10) || 1));
      return env.LOBBY.get(env.LOBBY.idFromName("lobby-" + n)).fetch(request);
    }
    if (url.pathname === "/games/longship/discord") return handleDiscord(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledBot(env).catch(e => console.log("Longship Bot:", e.message)));
  },
};
