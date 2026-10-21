/* busterrdust.com Worker.
   Every page on the site is served straight from the files (this code never runs for them).
   Only /games/longship/lobby comes here: it hands the player to a Longship.io lobby (one Durable Object per lobby). */
import { Lobby } from "./lobby.js";
export { Lobby };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/games/longship/lobby") {
      const n = Math.max(1, Math.min(99, parseInt(url.searchParams.get("n"), 10) || 1));
      return env.LOBBY.get(env.LOBBY.idFromName("lobby-" + n)).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
