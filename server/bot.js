/* Longship Bot: the Discord app for the LongShip.io server, running on the busterrdust.com Worker.
   - Discord sends slash commands and button clicks to /games/longship/discord (signed by Discord; checked below).
   - Every 10 minutes (the cron in wrangler.jsonc) it:
       1. registers the slash commands if they changed, and
       2. reads the YouTube channel feed and posts any new Longship.io Short to #video-drops, pinging the opt-in
          "Drop Alerts" role.
   - /setup-server (admins only) builds the server: channels, the Drop Alerts role, the welcome and rules posts,
     Community mode, and the anti-spam (AutoMod) rules. It's safe to run again; it skips anything already there.

   The ONE secret is the bot token. It lives in Cloudflare (Workers → busterrdust → Settings → Variables and Secrets,
   name DISCORD_TOKEN, type Secret). Never paste it into this file. Everything in CFG below is public. */

import { VV, handleVV, scheduledVV } from "./vvbot.js";

export const CFG = {
  appId: "1562689816272044124",           // Discord Developer Portal → Longship Bot → General Information → Application ID
  publicKey: "46ea8fe1294fbf787e77d0ee9d9ecc94eaa6ffd67564120b2ffe7fa19462e169",       // same page → Public Key (public, used to check that requests really come from Discord)
  guildId: "1562684014618222736",                 // the LongShip.io server
  ytChannelId: "UCPXLFXpMPLaaIU_VZi1gSFQ",        // Busterrdust on YouTube
  site: "https://busterrdust.com/games/longship/",
};
const FIREBASE_CONFIG = { projectId: "longshipio", apiKey: "AIzaSyB2_bXBgJkOoWoo0Otzjba2u2i3XeWtzTs" };   // public web config (same as the game)

export const API = "https://discord.com/api/v10";
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

/* ---------------- small key/value store (one Durable Object) ---------------- */
export class BotState {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(req) {
    const { op, key, val } = await req.json();
    if (op === "put") { await this.ctx.storage.put(key, val); return json({ ok: true }); }
    return json({ val: (await this.ctx.storage.get(key)) ?? null });
  }
}
const store = env => env.BOT.get(env.BOT.idFromName("longship-bot"));
export const kget = async (env, key) => (await (await store(env).fetch("https://bot/", { method: "POST", body: JSON.stringify({ op: "get", key }) })).json()).val;
export const kput = (env, key, val) => store(env).fetch("https://bot/", { method: "POST", body: JSON.stringify({ op: "put", key, val }) });

/* ---------------- Discord REST ---------------- */
export async function api(env, method, path, body, reason) {
  for (let tries = 0; tries < 5; tries++) {
    const headers = { Authorization: "Bot " + env.DISCORD_TOKEN, "User-Agent": "DiscordBot (https://busterrdust.com, 1.0)" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(reason);
    const r = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await sleep(((j.retry_after || 1) * 1000) + 150); continue; }
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${(await r.text()).slice(0, 300)}`);
    return r.status === 204 ? null : r.json();
  }
  throw new Error(`${method} ${path} → rate limited`);
}
// follow-up to an interaction (uses the interaction token, no bot token needed)
export const editReply = (token, body) => fetch(`${API}/webhooks/${CFG.appId}/${token}/messages/@original`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/* ---------------- request signature check ---------------- */
const hex = h => new Uint8Array((h.match(/../g) || []).map(b => parseInt(b, 16)));
async function verified(req, body) {
  const sig = req.headers.get("X-Signature-Ed25519"), ts = req.headers.get("X-Signature-Timestamp");
  if (!sig || !ts || !CFG.publicKey) return false;
  const data = new TextEncoder().encode(ts + body);
  try {
    const key = await crypto.subtle.importKey("raw", hex(CFG.publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, hex(sig), data);
  } catch (e) {
    const key = await crypto.subtle.importKey("raw", hex(CFG.publicKey), { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }, false, ["verify"]);
    return crypto.subtle.verify("NODE-ED25519", key, hex(sig), data);
  }
}

/* ---------------- what the bot knows ---------------- */
const POWERS = [
  ["⛵", "Swift Oars", "common", "row faster for free (8s)"],
  ["🧲", "Odin's Pull", "common", "nearby gold drifts to you (12s)"],
  ["🍖", "Feast", "uncommon", "+12 shields right away"],
  ["🛡️", "Thor's Ward", "uncommon", "survive one crash (20s)"],
  ["👻", "Ghost Ship", "rare", "sail straight through other ships (7s)"],
  ["🍺", "Mead of Plenty", "rare", "gold counts double (15s)"],
  ["⚡", "Mjölnir", "legendary", "lightning splits the nearest rival's shield wall in half (small ships sink)"],
];
const HOWTO = [
  "**How to play Longship.io**",
  "• Steer with the mouse, a finger drag, or WASD / arrow keys.",
  "• **Row hard**: hold click, Space, or the ROW! button. It's faster but costs shields.",
  "• Gather drifting gold to grow your shield wall (the line of shields behind your ship).",
  "• If your **prow** touches another ship's shields or a rocky isle, you sink. Watch for the ☠ rogues.",
  "• Get other ships to crash into **your** wall to sink them and take their loot. Circling a raider (the classic coil) works great.",
  "• Every voyage earns **plunder**: your biggest wall + 25 for each raider you sink. Spend it in the 🎨 Wardrobe.",
].join("\n");
const FAQ = [
  { k: ["play", "link", "where", "url", "website", "site", "open"], a: () => `Play free in your browser (phone or computer, no download): ${CFG.site}` },
  { k: ["control", "steer", "move", "keys", "keyboard", "mouse", "touch", "how to play", "howto", "tutorial"], a: () => HOWTO },
  { k: ["boost", "row", "faster", "speed", "space"], a: () => "Hold click, Space, or the ROW! button to row hard. You go faster but it costs shields, so don't overdo it." },
  { k: ["power", "rune", "runestone", "ability", "abilities", "pickup"], a: () => "**Power-up runes**\n" + POWERS.map(p => `${p[0]} **${p[1]}** (${p[2]}): ${p[3]}`).join("\n") },
  { k: ["ghost"], a: () => "👻 **Ghost Ship** (rare rune): for 7 seconds you sail straight through other ships. Crash warnings switch off while it's up. Rocky isles still sink you!" },
  { k: ["mjolnir", "mjölnir", "thor", "hammer", "lightning"], a: () => "⚡ **Mjölnir** (legendary rune): lightning splits the nearest rival's shield wall in half and the loose shields spill out as gold. Ships under 20 shields sink outright." },
  { k: ["ward", "shield rune", "survive"], a: () => "🛡️ **Thor's Ward** (uncommon rune): for 20 seconds you survive one crash." },
  { k: ["magnet", "pull", "odin"], a: () => "🧲 **Odin's Pull** (common rune): for 12 seconds nearby gold drifts straight to you." },
  { k: ["mead", "double"], a: () => "🍺 **Mead of Plenty** (rare rune): for 15 seconds every bit of gold counts double." },
  { k: ["save", "progress", "account", "login", "log in", "sign in", "google", "lose", "lost"], a: () => "Sign in with Google from the game's menu and your plunder and unlocks are saved to your account, so you keep them on any device." },
  { k: ["skin", "figurehead", "trail", "wardrobe", "unlock", "cosmetic", "plunder", "buy"], a: () => "Open the 🎨 **Wardrobe** to dress your ship: **skins**, animated **figureheads** and **trails**. You buy most of them with **plunder** (your biggest wall + 25 per raider sunk, earned every voyage). Some special ones unlock by pulling off a feat instead." },
  { k: ["halloween", "season", "seasonal", "limited", "event", "spooky", "pumpkin", "bone"], a: () => "🎃 **Hallowed Seas** runs until **Nov 2**. Halloween skins can only be *earned* during the event, but once you have them they're yours forever. The 🎄 **Yule Raid** winter event starts **Nov 20**." },
  { k: ["winter", "christmas", "yule", "update", "next", "coming"], a: () => "🎄 The **Yule Raid** winter update starts **Nov 20** with new limited-time skins. Watch #announcements!" },
  { k: ["score", "leaderboard", "board", "high score", "top", "rank", "fake"], a: () => "The scoreboard (Today + All-time) only shows **real players**, no fake scores. Try `/scores` to see the top 5 right now." },
  { k: ["multiplayer", "lobby", "lobbies", "friends", "real players", "bots", "online", "server"], a: () => "It's real multiplayer: up to **20 real players** share each sea, and bots fill the empty spots. A new lobby opens when one fills up." },
  { k: ["phone", "mobile", "iphone", "android", "download", "app", "install", "ipad", "tablet"], a: () => `No download needed. It runs in the browser on phones, tablets and computers: ${CFG.site}` },
  { k: ["free", "cost", "price", "pay", "money"], a: () => "Longship.io is **free** to play." },
  { k: ["crash", "sank", "sunk", "die", "died", "dead", "killed"], a: () => "You sink if your **prow** (the front of your ship) touches another ship's shields or a rocky isle. Red warning circles flash on shields you're about to hit. Thor's Ward 🛡️ saves you once, and Ghost Ship 👻 lets you pass through ships." },
  { k: ["bug", "broken", "glitch", "lag", "laggy", "freeze", "crash bug", "hot", "slow"], a: () => "Sorry about that! Please post it in **#bug-reports** with your device (phone/PC + browser) and what happened. Screenshots help a ton." },
  { k: ["idea", "suggest", "suggestion", "feature", "request", "add"], a: () => "Love it. Drop it in **#suggestions** so it gets its own thread and people can vote on it." },
  { k: ["vikingvale", "viking vale", "other game", "rpg"], a: () => "**VikingVale** is Busterrdust's other Viking game: a multiplayer top-down RPG in the works. You can find it on busterrdust.com/games." },
  { k: ["who", "made", "dev", "developer", "creator", "busterrdust"], a: () => "Longship.io is made by **Busterrdust**, a solo indie dev. More games at https://busterrdust.com/games" },
  { k: ["record", "clip", "shorts", "video", "tiktok"], a: () => `New videos drop in **#video-drops**. Want a ping when they do? Use \`/alerts\`. Share your own clips in **#clips-and-highlights**!` },
  { k: ["rule", "rules", "swear", "curse", "cursing"], a: () => "Cursing's fine. Just act like adults: be nice and respectful, no slurs, no spam, no self-promo. Full rules are in **#rules**." },
];
function answer(q) {
  const t = " " + String(q || "").toLowerCase().replace(/[^a-z0-9öäå' ]+/g, " ") + " ";
  let best = null, score = 0;
  for (const f of FAQ) { let s = 0; for (const k of f.k) if (t.includes(" " + k) || (k.length > 4 && t.includes(k))) s += k.length > 4 ? 2 : 1; if (s > score) { score = s; best = f; } }
  return best ? best.a() : "Hmm, I don't know that one yet. 🤔 Try `/howto` or `/powerups`, or ask in **#general** and someone will help.";
}

async function topScores(board) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const base = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;
  const url = (board === "all" ? base : `${base}/daily/${day}`) + `:runQuery?key=${FIREBASE_CONFIG.apiKey}`;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Referer: "https://busterrdust.com/" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "scores" }], orderBy: [{ field: { fieldPath: "score" }, direction: "DESCENDING" }], limit: 5 } }) });
  if (!r.ok) throw new Error("scores " + r.status);
  const rows = (await r.json()).filter(x => x.document).map(x => x.document.fields);
  const medal = ["🥇", "🥈", "🥉", "4.", "5."];
  const title = board === "all" ? "🏆 All-time top 5" : "🏆 Today's top 5";
  if (!rows.length) return `${title}\nNo scores yet${board === "all" ? "" : " today"}. Set sail and claim #1! ${CFG.site}`;
  return `${title}\n` + rows.map((f, i) => `${medal[i]} **${(f.name?.stringValue || "Viking").replace(/[*_`~|<>@]/g, "")}**: ${f.score?.integerValue ?? 0} shields · ${f.kills?.integerValue ?? 0} sunk`).join("\n") + `\n\nThink you can beat them? ${CFG.site}`;
}

/* ---------------- slash commands ---------------- */
const COMMANDS = [
  { name: "play", description: "Get the link to play Longship.io" },
  { name: "howto", description: "How to play: controls, crashing, plunder" },
  { name: "powerups", description: "What every power-up rune does" },
  { name: "scores", description: "Top 5 real players right now",
    options: [{ type: 3, name: "board", description: "Which board", required: false, choices: [{ name: "Today", value: "today" }, { name: "All-time", value: "all" }] }] },
  { name: "ask", description: "Ask Longship Bot a question about the game",
    options: [{ type: 3, name: "question", description: "What do you want to know?", required: true, max_length: 200 }] },
  { name: "alerts", description: "Turn video-drop pings on or off for yourself" },
  { name: "setup-server", description: "Owner only: build or repair the server's channels, roles and anti-spam", default_member_permissions: "8", dm_permission: false },
];
const cmdHash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); };
async function syncCommands(env) {
  const body = JSON.stringify(COMMANDS), h = cmdHash(body);
  if ((await kget(env, "cmdHash")) === h) return;
  await api(env, "PUT", `/applications/${CFG.appId}/guilds/${CFG.guildId}/commands`, COMMANDS);
  await kput(env, "cmdHash", h);
}

const reply = (content, ephemeral) => json({ type: 4, data: { content, flags: ephemeral ? 64 : 0, allowed_mentions: { parse: [] } } });

async function toggleAlerts(env, member) {
  const role = await kget(env, "roleAlerts");
  if (!role) return "Drop alerts aren't set up yet. (The owner needs to run `/setup-server`.)";
  const has = (member.roles || []).includes(role);
  await api(env, has ? "DELETE" : "PUT", `/guilds/${CFG.guildId}/members/${member.user.id}/roles/${role}`, undefined, "Drop Alerts toggle");
  return has ? "🔕 Drop alerts **off**. You won't be pinged for new videos." : "🔔 Drop alerts **on**! You'll get a ping in #video-drops when a new video comes out.";
}

export async function handleDiscord(request, env, ctx) {
  if (request.method !== "POST") return new Response("Longship Bot is awake. ⚓", { status: 200 });
  const body = await request.text();
  if (!(await verified(request, body))) return new Response("bad signature", { status: 401 });
  const it = JSON.parse(body);
  if (it.type === 1) return json({ type: 1 });   // Discord's "are you there?" check
  if (it.guild_id === VV.guildId) return handleVV(it, env, ctx);   // the VikingVale server has its own commands (vvbot.js)

  if (it.type === 3 && it.data.custom_id === "alerts") {   // the 🔔 button in #welcome
    try { return reply(await toggleAlerts(env, it.member), true); } catch (e) { return reply("Couldn't change your alerts right now. Try `/alerts` in a minute.", true); }
  }
  if (it.type !== 2) return reply("🤔", true);
  const name = it.data.name, opt = Object.fromEntries((it.data.options || []).map(o => [o.name, o.value]));
  switch (name) {
    case "play": return reply(`⚔️ **Longship.io**: grow your shield wall, cut off rival raiders, call down Thor's hammer.\nFree in your browser, no download: ${CFG.site}`);
    case "howto": return reply(HOWTO);
    case "powerups": return reply("**Power-up runes** (sail over a glowing rune to grab it)\n" + POWERS.map(p => `${p[0]} **${p[1]}** (${p[2]}): ${p[3]}`).join("\n"));
    case "ask": return reply(`> ${String(opt.question).replace(/\n/g, " ").slice(0, 200)}\n${answer(opt.question)}`);
    case "alerts":
      try { return reply(await toggleAlerts(env, it.member), true); } catch (e) { return reply("Couldn't change your alerts right now. Try again in a minute.", true); }
    case "scores":
      ctx.waitUntil(topScores(opt.board).then(t => editReply(it.token, { content: t, allowed_mentions: { parse: [] } }))
        .catch(() => editReply(it.token, { content: "Couldn't reach the scoreboard right now. Try again in a minute." })));
      return json({ type: 5 });   // "thinking…", filled in a moment later
    case "setup-server":
      ctx.waitUntil(setupServer(env).then(log => editReply(it.token, { content: "✅ **Server setup done.**\n" + log.join("\n").slice(0, 1800) }))
        .catch(e => editReply(it.token, { content: "⚠️ Setup stopped: " + String(e.message || e).slice(0, 1500) })));
      return json({ type: 5, data: { flags: 64 } });
  }
  return reply("I don't know that command.", true);
}

/* ---------------- /setup-server ---------------- */
export const P = { VIEW: 1n << 10n, SEND: 1n << 11n, REACT: 1n << 6n, THREADS_PUB: 1n << 35n, THREADS_PRIV: 1n << 36n, SEND_THREADS: 1n << 38n };
export const bits = (...b) => b.reduce((a, x) => a | x, 0n).toString();
export const T = { TEXT: 0, VOICE: 2, CATEGORY: 4, NEWS: 5, STAGE: 13, FORUM: 15 };

async function setupServer(env) {
  const G = CFG.guildId, log = [];
  const everyone = G;   // the @everyone role has the server's id
  const readOnly = [{ id: everyone, type: 0, deny: bits(P.SEND, P.THREADS_PUB, P.THREADS_PRIV, P.SEND_THREADS), allow: bits(P.REACT) }];
  const hidden = [{ id: everyone, type: 0, deny: bits(P.VIEW) }];

  // role
  const roles = await api(env, "GET", `/guilds/${G}/roles`);
  let alerts = roles.find(r => r.name === "Drop Alerts");
  if (!alerts) { alerts = await api(env, "POST", `/guilds/${G}/roles`, { name: "Drop Alerts", color: 0xf5b642, mentionable: false, hoist: false }, "Opt-in video drop pings"); log.push("• Made the 🔔 Drop Alerts role"); }
  await kput(env, "roleAlerts", alerts.id);

  // channels (find by name so running again doesn't duplicate anything)
  let chans = await api(env, "GET", `/guilds/${G}/channels`);
  const find = (name, type) => chans.find(c => c.name === name && (type === undefined || c.type === type));
  async function ensure(name, type, parent, extra = {}) {
    let c = find(name) || (type === T.NEWS ? find(name, T.TEXT) : null);
    if (!c) { c = await api(env, "POST", `/guilds/${G}/channels`, { name, type, parent_id: parent || undefined, ...extra }, "Server setup"); chans.push(c); log.push(`• Made ${type === T.CATEGORY ? "category " : type === T.STAGE ? "stage " : "#"}${name}`); }
    else if (parent && c.parent_id !== parent) await api(env, "PATCH", `/channels/${c.id}`, { parent_id: parent, ...(extra.topic ? { topic: extra.topic } : {}) }, "Server setup");
    return c;
  }
  const catStart = await ensure("📜 START HERE", T.CATEGORY, null, { position: 0 });
  const catChat = await ensure("💬 COMMUNITY", T.CATEGORY, null, { position: 1 });
  const catFeed = await ensure("🛠️ FEEDBACK", T.CATEGORY, null, { position: 2 });
  const catLive = await ensure("🔴 LIVE", T.CATEGORY, null, { position: 3 });
  const catStaff = await ensure("🔒 STAFF", T.CATEGORY, null, { position: 9, permission_overwrites: hidden });

  const welcome = await ensure("welcome", T.TEXT, catStart.id, { topic: "Start here: what Longship.io is and how this server works", permission_overwrites: readOnly });
  const rules = await ensure("rules", T.TEXT, catStart.id, { topic: "Server rules", permission_overwrites: readOnly });
  let news = await ensure("announcements", T.TEXT, catStart.id, { topic: "Updates, new seasons and events", permission_overwrites: readOnly });
  const drops = await ensure("video-drops", T.TEXT, catStart.id, { topic: "New Longship.io videos as they drop. Want a ping? /alerts", permission_overwrites: readOnly });
  await ensure("general", T.TEXT, catChat.id, { topic: "Talk Longship.io and anything else (be nice)" });
  await ensure("clips-and-highlights", T.TEXT, catChat.id, { topic: "Your best runs, coils and close calls" });
  await ensure("high-scores", T.TEXT, catChat.id, { topic: "Brag here: screenshots of your best scores" });
  await ensure("skins-and-figureheads", T.TEXT, catChat.id, { topic: "Show off your ship: skins, figureheads, trails" });
  await ensure("ask-the-bot", T.TEXT, catChat.id, { topic: "Use /ask, /howto, /powerups, /scores here" });
  await ensure("live-streams", T.TEXT, catLive.id, { topic: "When Busterrdust goes live on TikTok, it's posted here" });
  const modlog = await ensure("mod-log", T.TEXT, catStaff.id, { topic: "AutoMod alerts and Discord notices (staff only)", permission_overwrites: hidden });

  // Community mode (needed for announcement channels, forums and the stage) + basic anti-raid settings
  const guild = await api(env, "GET", `/guilds/${G}`);
  if (!guild.features.includes("COMMUNITY")) {
    await api(env, "PATCH", `/guilds/${G}`, { features: [...guild.features, "COMMUNITY"], verification_level: 2, explicit_content_filter: 2,
      default_message_notifications: 1, rules_channel_id: rules.id, public_updates_channel_id: modlog.id,
      description: "The official server for Longship.io, a free Viking .io game by Busterrdust." }, "Server setup: Community mode");
    log.push("• Turned on Community mode (members must have accounts older than 5 minutes; media scanned for everyone)");
  } else await api(env, "PATCH", `/guilds/${G}`, { verification_level: Math.max(guild.verification_level, 2), default_message_notifications: 1 }, "Server setup");
  if (news.type === T.TEXT) { news = await api(env, "PATCH", `/channels/${news.id}`, { type: T.NEWS }, "Server setup"); log.push("• #announcements is now an Announcement channel (other servers can follow it)"); }
  if (drops.type === T.TEXT) { await api(env, "PATCH", `/channels/${drops.id}`, { type: T.NEWS }, "Server setup"); }
  chans = await api(env, "GET", `/guilds/${G}/channels`);
  await ensure("bug-reports", T.FORUM, catFeed.id, { topic: "One post per bug: device (phone/PC + browser), what happened, screenshot if you can", available_tags: [{ name: "Phone" }, { name: "PC" }, { name: "Fixed ✅", moderated: true }] });
  await ensure("suggestions", T.FORUM, catFeed.id, { topic: "One idea per post. React 👍 on the ones you want", available_tags: [{ name: "Skins" }, { name: "Gameplay" }, { name: "Planned 🗺️", moderated: true }] });
  await ensure("Live Stage", T.STAGE, catLive.id);
  await kput(env, "channels", { welcome: welcome.id, rules: rules.id, news: news.id, drops: drops.id, modlog: modlog.id });

  // a permanent invite (for YouTube/TikTok bios) and the anti-spam rules
  let invite = await kget(env, "invite");
  if (!invite) { invite = (await api(env, "POST", `/channels/${welcome.id}/invites`, { max_age: 0, max_uses: 0, unique: false }, "Permanent invite")).code; await kput(env, "invite", invite); }
  log.push(`• Permanent invite: https://discord.gg/${invite}`);
  const existing = await api(env, "GET", `/guilds/${G}/auto-moderation/rules`);
  const alert = { type: 2, metadata: { channel_id: modlog.id } };
  const block = msg => ({ type: 1, metadata: { custom_message: msg } });
  const amRules = [
    { name: "Spam filter", event_type: 1, trigger_type: 3, actions: [block("Looks like spam, so it was blocked."), alert] },
    { name: "Mention spam", event_type: 1, trigger_type: 5, trigger_metadata: { mention_total_limit: 5, mention_raid_protection_enabled: true }, actions: [block("Too many pings in one message."), alert, { type: 3, metadata: { duration_seconds: 600 } }] },
    { name: "No slurs", event_type: 1, trigger_type: 4, trigger_metadata: { presets: [3] }, actions: [block("Cursing's fine. Slurs aren't. Keep it respectful."), alert] },
    { name: "No other server invites", event_type: 1, trigger_type: 1, trigger_metadata: { keyword_filter: ["discord.gg/*", "discord.com/invite/*", "discordapp.com/invite/*"], allow_list: [`discord.gg/${invite}`, `discord.com/invite/${invite}`] }, actions: [block("Please don't post other servers' invites."), alert] },
  ];
  for (const r of amRules) if (!existing.find(e => e.name === r.name)) { await api(env, "POST", `/guilds/${G}/auto-moderation/rules`, { ...r, enabled: true }, "Anti-spam"); log.push(`• AutoMod: ${r.name}`); }

  // the welcome + rules posts (posted once; run setup again to re-post if you delete them)
  const posted = (await kget(env, "posted")) || {};
  async function postOnce(key, channelId, msg) {
    if (posted[key]) { try { await api(env, "GET", `/channels/${channelId}/messages/${posted[key]}`); return; } catch (e) { /* deleted: post again */ } }
    const m = await api(env, "POST", `/channels/${channelId}/messages`, msg); posted[key] = m.id; log.push(`• Posted the ${key} message`);
  }
  await postOnce("welcome", welcome.id, {
    embeds: [{ color: 0xf5b642, title: "⚓ Welcome to LongShip.io!",
      description: [
        "**Longship.io** is a free Viking .io game made by **Busterrdust**. Grow your shield wall, cut off rival raiders, and call down Thor's hammer. Plays in your browser on phone or computer, no download.",
        "", "**Find your way around**",
        `• <#${rules.id}>: read these first (short, promise)`,
        `• <#${news.id}>: updates, new seasons and events`,
        `• <#${drops.id}>: new videos the moment they drop`,
        "• **#general**, **#clips-and-highlights**, **#high-scores**, **#skins-and-figureheads**: hang out and show off",
        "• **#bug-reports** and **#suggestions**: one post each, so nothing gets lost",
        "• **#ask-the-bot**: try `/ask`, `/howto`, `/powerups` and `/scores`",
        "", "🔔 Want a ping when a new video drops? Tap the button below (tap again to turn it off).",
      ].join("\n") }],
    components: [{ type: 1, components: [
      { type: 2, style: 1, label: "Get drop alerts", emoji: { name: "🔔" }, custom_id: "alerts" },
      { type: 2, style: 5, label: "Play Longship.io", emoji: { name: "⚔️" }, url: CFG.site },
    ] }],
  });
  await postOnce("rules", rules.id, {
    embeds: [{ color: 0xc0392b, title: "📜 Rules",
      description: [
        "**1. Be nice and respectful.** Banter is fine; bullying, harassment and hate aren't.",
        "**2. Cursing is allowed. Act like adults.** No slurs, nothing NSFW, no gore.",
        "**3. No spam or self-promo.** That includes other servers' invites, scam links and DM advertising.",
        "**4. Keep things in the right channel.** Bugs in #bug-reports, ideas in #suggestions.",
        "**5. No cheating, exploits or impersonating players or Busterrdust.** Found an exploit? Report it in #bug-reports instead of using it.",
        "**6. Follow Discord's Terms and Community Guidelines.**",
        "", "Breaking the rules gets a warning, a timeout, or a ban, depending on how bad it is. Have fun out there. ⚔️",
      ].join("\n") }],
  });
  await kput(env, "posted", posted);
  return log;
}

/* ---------------- every 10 minutes ---------------- */
// The channel's public feed. Only PUBLIC videos are in it, so unlisted uploads are never announced.
export async function youtubeFeed() {
  const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${CFG.ytChannelId}`, { headers: { "User-Agent": "Mozilla/5.0 (LongshipBot)" } });
  if (!r.ok) return null;
  const xml = await r.text(), un = t => t.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => {
    const e = m[1], get = re => ((e.match(re) || [])[1] || "");
    return { id: get(/<yt:videoId>([^<]+)</), title: un(get(/<title>([^<]*)</)).replace(/#shorts/ig, "").trim(), desc: un(get(/<media:description>([\s\S]*?)<\/media:description>/)), published: get(/<published>([^<]+)</) };
  }).filter(v => v.id);
}
export async function scheduledBot(env) {
  if (!env.DISCORD_TOKEN || !CFG.appId) return;
  await scheduledVV(env).catch(e => console.log("VikingVale Bot:", e.message));   // the VikingVale server (vvbot.js)
  await syncCommands(env).catch(e => console.log("commands", e.message));
  const ch = await kget(env, "channels"); if (!ch || !ch.drops) return;   // waits until /setup-server has been run
  const role = await kget(env, "roleAlerts");
  const all = await youtubeFeed(); if (!all) return;
  const entries = all.filter(v => /longship/i.test(v.title + " " + v.desc));
  let seen = await kget(env, "ytSeen");
  if (!seen) { await kput(env, "ytSeen", entries.map(v => v.id)); return; }   // first run: remember what's already out, post nothing
  const fresh = entries.filter(v => !seen.includes(v.id)).reverse();   // oldest first
  for (const v of fresh) {
    const title = v.title;
    await api(env, "POST", `/channels/${ch.drops}/messages`, {
      content: `${role ? `<@&${role}> ` : ""}🎬 **New video just dropped!** ${title}\nhttps://youtube.com/shorts/${v.id}`,
      allowed_mentions: { roles: role ? [role] : [] },
    });
    seen.push(v.id);
  }
  if (fresh.length) await kput(env, "ytSeen", seen.slice(-300));
}
