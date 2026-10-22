/* VikingVale Bot: the same Discord app as Longship Bot, working in the "VikingVale testers" server.
   (One app, one token. In that server it goes by the nickname "VikingVale Bot" and has its own commands.)
   - bot.js sends every interaction from the VikingVale server here (it checks the signature first).
   - Every 10 minutes (the same cron) it:
       1. registers the VikingVale slash commands if they changed,
       2. posts new PUBLIC VikingVale videos to #video-drops (unlisted uploads never show up in the public feed), and
       3. when a new GitHub release appears, posts a short heads-up in #announcements. The full changelog still
          comes from release.bat's own Discord post into #patch-notes.
   - /setup-server (admins only) builds the whole server. It's safe to run again: it skips anything that's already there. */

import { json, api, kget, kput, editReply, P, bits, T, youtubeFeed } from "./bot.js";

export const VV = {
  guildId: "1528863985229762733",   // VikingVale testers
  repo: "shrimpey94/VikingVale",
  download: "https://busterrdust.com/games/vikingvale/download",   // → the newest VikingVale.exe on GitHub
  releases: "https://github.com/shrimpey94/VikingVale/releases",
  page: "https://busterrdust.com/games/",
  youtube: "https://www.youtube.com/@Busterrdust-VikingVale-Online",
  trailer: "https://youtu.be/VmMpZmWXUOc",
  nick: "VikingVale Bot",
};
const APP_ID = "1562689816272044124";
const K = k => "vv:" + k;   // VikingVale keys in the shared bot store
const reply = (content, ephemeral, extra = {}) => json({ type: 4, data: { content, flags: ephemeral ? 64 : 0, allowed_mentions: { parse: [] }, ...extra } });

/* ---------------- what the bot knows (from the game's own files) ---------------- */
const PREBETA = [
  "🧪 **VikingVale is in Pre-Beta.** That means:",
  "• **Nothing is permanent yet.** Seasons can reset characters (levels, items, gold, bank) when big updates land.",
  "• **Almost all the art and sound is placeholder:** characters, NPCs, monsters, buildings, music and voices will be replaced with hand-made art, real music and real voice actors.",
  "• Updates come often. The game updates itself when you launch it.",
  "• It isn't finished until it's on **Steam**. Your bug reports and feedback shape what it becomes. 🙏",
].join("\n");

const HOWTO_INSTALL = [
  "**How to start playing** (free, Windows)",
  `1. Download **VikingVale.exe**: ${VV.download}`,
  "2. Run it. Windows may show a blue *\"Windows protected your PC\"* box because the game is new and unsigned. Click **More info → Run anyway**.",
  "3. Make an account on the login screen (you can turn on **auto-login** so it signs you in every time).",
  "4. Pick a **backstory** (a small starting perk) and make your character.",
  "5. Follow the intro tutorial. You can replay it, and open the **Guides**, anytime from **Settings**.",
  "",
  "The game checks for updates every time it starts, so you'll always be on the newest version.",
].join("\n");

const SKILLS = [
  "**The 15 skills** (they level by doing them)",
  "🪓 **Woodcutting**: chop trees (and pick up sticks)",
  "⛏️ **Mining**: mine rocks, stones and rune essence",
  "💎 **Jewelcrafting**: gems that turn up while mining (level 30+ rocks)",
  "🎣 **Fishing**: fishing spots, the reel mini-game, deep-sea fishing and sea monsters",
  "🌱 **Farming**: farm plots plus herbs, mushrooms and berries in the wild",
  "🔨 **Smithing**, 🧵 **Crafting**, 🍲 **Cooking**: turn what you gather into gear, tools and food",
  "🏗️ **Construction**: boats, walls and warband buildings",
  "⚔️ **Melee**, 🏹 **Ranged**, 🔮 **Magic**: the three combat styles (each has a training mini-game in town)",
  "🛡️ **Defence** and ❤️ **Vitality**: grow as you fight",
  "👻 **Soul**: from buried remains (Norse worship is coming in a future update)",
].join("\n");

const TOWNS = [
  "**The five holds**",
  "⚓ **Bjorn's Landing**: where the first Vikings landed and where you start. Peaceful and welcoming, with the best fish on its shores and river.",
  "🏰 **Kjelvik**: the biggest and strongest hold, home of the castle (the only no-PvP safe zone). Attack its folk and the city watch comes in waves.",
  "❄️ **Frostheim**: up in the ice. Where Vikings come to forget and live in peace. (No fishing here.)",
  "🌸 **Ironwood**: a forest of pink trees with the river running through its middle. Its people don't complain... but they may be hiding something.",
  "🔥 **Eastmark**: home of thieves and the Vikings who mean to take over. They want land, and they won't play nice.",
  "",
  "Every town tracks your **reputation** (Hated → Exalted), and caravans trade along the roads between them. Troll and dragon villages are coming in future updates.",
].join("\n");

const BACKSTORIES = [
  "**Backstories** (a small perk you pick when you make your character; anyone can still train any skill)",
  "⚔ **Viking**: raised in the shieldwall. +2% melee damage · +5% Combat XP",
  "🎣 **Fisher**: the sea taught you patience. +10% Fishing XP · +5% Cooking XP",
  "🔨 **Craftsman**: your hands know the weight of tools. +10% Crafting XP · +10% Construction XP",
  "✨ **Mage**: you studied the hidden runes. +10% Magic XP · +2% spell potency",
  "🏹 **Archer**: your eye never misses the wind. +10% Ranged XP · +2% bow accuracy",
].join("\n");

// The in-game Guides (Settings → Guides), kept in step with scripts/GuideData.gd
const GUIDES = {
  start: ["⭐ Getting Started", [
    "• Click the ground to move. Click a resource (tree, rock, fishing spot, herb) to gather it, or a monster to fight it.",
    "• Gather **Sticks and Stones** first, then open **Crafting** (💎) to make your starter tools.",
    "• Skills level by doing them. Try `/skills` for the full list.",
    "• Visit the five towns (Bjorn's Landing, Kjelvik, Frostheim, Ironwood and Eastmark) to trade, bank, train and take quests.",
    "• Replay the intro tutorial and reopen the Guides anytime from **Settings**."]],
  combat: ["⚔ Combat & PvP", [
    "• Three styles, swapped in the combat panel: **Melee** (⚔) up close, **Ranged** (🏹) with a bow and arrows, **Magic** (🔮) with runes you inscribe.",
    "• Criticals deal bonus damage, shields can **block** and halve a hit, and Defence is split into melee/ranged/magic, so gear for the fight you expect.",
    "• **PvP is toggle-only:** you can only fight flagged players, and attacking someone flags you. You drop loot on death.",
    "• The **Kjelvik castle** is the one no-PvP safe zone. Attack townsfolk there and the city watch answers in escalating waves.",
    "• Monster loot goes straight into the backpack of whoever did the most damage."]],
  thralls: ["⛓ Thralls", [
    "Thralls are captured workers who gather and fight for you while you're logged out.",
    "• **Get one:** a 4% drop from monster kills when you have a free roster slot. Buy more slots in the Thralls tab.",
    "• **Assign:** pick a thrall, a job, a target resource and the **town** to send it to. Higher-tier resources need a higher-tier thrall in the right town.",
    "• **Offline:** thralls work up to a 12-hour shift, then rest. On login you get a report; their haul is in the thrall's backpack and you get the XP.",
    "• **Combat thralls** need FOOD in their backpack. They can **permanently die** if they run out mid-fight.",
    "• Re-assign your thralls each session."]],
  boat: ["⛵ Boats & Sailing", [
    "• Build a boat at a **Construction** bench. Boats need logs and bars; sturdier hulls need a higher Construction level.",
    "• Launch from the water's edge to set sail across deep water.",
    "• At sea you can **deep-sea fish** for bigger, rarer catches, but **sea monsters** will attack. Win the boat fight to keep sailing."]],
  warband: ["🛡 Warbands", [
    "A warband is your clan: shared banking, territory and war.",
    "• Open **Social → Warband** to create one (you become leader) or accept an invite.",
    "• Members share a **clan bank** (a gold pool plus item tabs with per-member withdraw permissions) and appear on the live rankings.",
    "• Leaders invite/kick, set bank permissions, hire trade caravans, pledge the warband to a town and build structures.",
    "• Form **one** alliance with another warband using `/ally` in game."]],
  settlement: ["🏰 Warband Settlements", [
    "Build these from the Construction (🔨) menu, at your feet, on free or claimed land.",
    "• **Banner**: Construction 25 (15 Oak Logs + 5 Iron Bars). Claims the land around it. Up to 12 per warband.",
    "• **Outpost**: Construction 20 (20 Pine Logs + 3 Iron Bars). Up to 3 per banner.",
    "• **Stronghold**: Construction 50 (40 Ironwood Logs + 20 Mithril Bars + 15 Frost Logs). One per warband.",
    "• Rivals can **raid** your structures. Repair them with gold from the clan pool."]],
  runes: ["🔮 Magic Runes", [
    "• Find a **Runestone** (a purple magic node) and right-click it → **Inscribe**.",
    "• Recipes use magic **essence** (and rune dust at higher tiers). Better runes need a higher Magic level, in 10-level steps.",
    "• Equip the Magic style, pick a rune in the rune row and cast. You spend runes as you cast, so stock up before a big fight."]],
  reputation: ["📜 Reputation & Towns", [
    "• Every town tracks your standing, from **Hated** up to **Exalted**.",
    "• Raise it with town quests and good deeds.",
    "• Lose it by attacking townsfolk, smashing town walls, or raiding a town's trade caravan.",
    "• Warbands have their own town standing too, shown in the Reputation tab."]],
  travel: ["🗺 Fast Travel", [
    "• First **discover** a place by visiting it on foot.",
    "• Then pay a gold fee (about 50–300g, by distance) to travel there instantly from the travel menu."]],
  fishing: ["🎣 Fishing & Cooking", [
    "• Equip a fishing pole and click a fishing spot. Higher Fishing unlocks salmon, lobster and shark.",
    "• Take a boat out for deep-sea fishing: bigger catches, but sea monsters.",
    "• **Cook** your catch: cooked food is your main healing in a fight (and it feeds combat thralls)."]],
  training: ["🎯 Training Mini-games", [
    "• **Archery Range**: line up the sweeping crosshair and loose a 5-shot volley. Bullseyes earn far more XP. Bring a bow and arrows.",
    "• **Runestones**: the same idea for Magic. Bring a staff and rune essence.",
    "• **Sparring dummies** in every town train Melee. Bring a melee weapon."]],
};
const guideText = id => { const g = GUIDES[id] || GUIDES.start; return `**${g[0]}**\n${g[1].join("\n")}`; };

const FAQ = [
  { k: ["download", "install", "get the game", "where", "link", "exe", "how do i play", "start playing", "windows defender", "smartscreen", "protected"], a: () => HOWTO_INSTALL },
  { k: ["mac version", "for mac", "on mac", "linux version", "windows only", "mac", "macos", "linux", "phone", "mobile", "iphone", "android", "steam deck", "console", "xbox", "playstation"], a: () => "Right now VikingVale is **Windows only**. A phone path (a web version) is on the long-term list, and the full release is headed to **Steam**." },
  { k: ["free", "cost", "price", "pay", "money", "buy"], a: () => "VikingVale is **free** to play during Pre-Beta." },
  { k: ["steam", "release", "launch", "when", "finished", "done", "full game"], a: () => "VikingVale is in **Pre-Beta**. The plan is a full release on **Steam** once the real art, music and voice acting are in. Updates land here in #patch-notes along the way." },
  { k: ["placeholder", "art", "graphics", "ugly", "sound", "music", "voice", "voices", "models"], a: () => "Yep, almost all the art and audio is **placeholder** right now. Real 3D models, real music and **real voice actors** are coming before the Steam release." },
  { k: ["reset", "wipe", "progress", "lost", "lose", "permanent", "season"], a: () => "During Pre-Beta, **nothing is permanent**. Big updates can start a fresh season that resets characters (levels, items, gold, bank). Resets are always announced in #announcements first." },
  { k: ["update", "version", "patch", "updater", "latest", "new version"], a: () => "The game **updates itself** every time you launch it. Patch notes are in #patch-notes, and `/version` shows the newest release." },
  { k: ["can't connect", "cant connect", "connect", "offline", "server down", "down", "disconnect", "login", "log in", "password"], a: () => "Can't get in? 1) Close and relaunch so the updater can run. 2) Check #announcements in case the server is down for an update. 3) Forgot your password? Use the reset option on the login screen. Still stuck? Make a post in **#bug-reports** with the tag **Connection/Login**." },
  { k: ["2d", "3d", "camera", "view", "switch"], a: () => "VikingVale has **two views of the same world**: classic 2D and low-poly 3D. You can switch between them at any time; everyone plays on the same server either way." },
  { k: ["skill", "skills", "level", "levels", "xp", "train"], a: () => SKILLS },
  { k: ["town", "towns", "hold", "holds", "kjelvik", "frostheim", "ironwood", "eastmark", "bjorn"], a: () => TOWNS },
  { k: ["backstory", "class", "classes", "perk", "character creation"], a: () => BACKSTORIES },
  { k: ["quest", "quests", "main quest", "token", "tokens", "high seat", "bjarne"], a: () => "There are **25 quests**. The main story starts with **Elder Bjarne in Kjelvik**: an outlander washes ashore, and the hunt for the **Five Tokens** (one per hold) begins. Each quest shows its skill gates. Stuck on one? Ask in **#quests-and-help**." },
  { k: ["pvp", "pk", "player kill", "flag", "flagged", "safe zone"], a: () => guideText("combat") },
  { k: ["combat", "fight", "melee", "ranged", "magic", "attack", "damage"], a: () => guideText("combat") },
  { k: ["thrall", "thralls", "afk", "offline gathering", "workers"], a: () => guideText("thralls") },
  { k: ["boat", "ship", "sail", "sailing", "sea monster", "deep sea"], a: () => guideText("boat") },
  { k: ["warband", "clan", "guild", "alliance", "ally", "clan bank"], a: () => guideText("warband") },
  { k: ["banner", "outpost", "stronghold", "settlement", "claim", "territory", "land", "raid"], a: () => guideText("settlement") },
  { k: ["rune", "runes", "runestone", "inscribe", "essence", "spell"], a: () => guideText("runes") },
  { k: ["reputation", "rep", "exalted", "hated", "standing"], a: () => guideText("reputation") },
  { k: ["fast travel", "teleport", "travel"], a: () => guideText("travel") },
  { k: ["fish", "fishing", "cook", "cooking", "food", "heal", "shark", "lobster"], a: () => guideText("fishing") },
  { k: ["archery", "dummy", "dummies", "minigame", "mini game", "mini-game", "sparring"], a: () => guideText("training") },
  { k: ["trade", "trading", "sell", "auction", "market", "shop", "gold"], a: () => "Trade with players through the **Trade** window (items dropped on the ground can only be picked back up by you). There's also an **auction house** and NPC shopkeepers (right-click a shopkeeper → Trade). Post deals in **#trading-post**." },
  { k: ["dungeon", "frostmaw", "cave", "boss"], a: () => "The first dungeon is **Frostmaw Hollow**, west of Bjorn's Landing: six rooms of goblins and skeletons with a troll boss at the end. Bring food. More dungeons are planned." },
  { k: ["farm", "farming", "seeds", "plots", "crops"], a: () => "**Farming** covers farm plots and wild herbs, mushrooms and berries. Foraging in the wild can turn up seeds for your plots." },
  { k: ["cheat", "cheating", "hack", "exploit", "dupe", "duplicate"], a: () => "The server checks gold, items, XP and combat, so cheated progress gets stripped. Found an exploit? **Don't use it.** Report it in **#bug-reports** with the **Exploit** tag. Using exploits can get you banned." },
  { k: ["bug", "broken", "glitch", "crash", "crashed", "stuck", "lag", "freeze", "error"], a: () => "Sorry! Please make a post in **#bug-reports**: what happened, what you were doing, 2D or 3D, and a screenshot if you can. Pick the tags that fit. Check **#known-issues** first in case it's already on the list." },
  { k: ["idea", "suggest", "suggestion", "feature", "request", "feedback", "balance"], a: () => "Love it. Post it in **#feedback** (one idea per post) so people can react 👍 and it doesn't get lost." },
  { k: ["role", "roles", "ping", "pings", "notify", "notification", "alerts"], a: () => "Pick your pings, home town and playstyle in **#pick-your-roles** (or use `/roles`)." },
  { k: ["longship", "io game", "other game"], a: () => "**Longship.io** is Busterrdust's other Viking game: a free .io game you play in your browser. https://busterrdust.com/games/longship/" },
  { k: ["who", "made", "dev", "developer", "creator", "busterrdust", "solo"], a: () => "VikingVale is made by **Busterrdust**, a solo indie dev. More games at https://busterrdust.com/games" },
  { k: ["rule", "rules", "swear", "curse", "cursing", "language"], a: () => "Cursing's fine. Just act like adults: be nice and respectful, no slurs, no spam, no self-promo. Full rules are in **#rules**." },
];
function answer(q) {
  const t = " " + String(q || "").toLowerCase().replace(/[^a-z0-9öäåðþ' ]+/g, " ") + " ";
  let best = null, score = 0;
  for (const f of FAQ) { let s = 0; for (const k of f.k) if (t.includes(" " + k) || (k.length > 4 && t.includes(k))) s += k.length > 4 ? 2 : 1; if (s > score) { score = s; best = f; } }
  return best ? best.a() : "Hmm, I don't know that one yet. 🤔 Try `/guide`, `/skills` or `/towns`, or ask in **#quests-and-help** and someone will help.";
}

async function latestRelease() {
  const r = await fetch(`https://api.github.com/repos/${VV.repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "VikingValeBot (busterrdust.com)" } });
  if (!r.ok) throw new Error("github " + r.status);
  const j = await r.json();
  return { tag: j.tag_name, name: j.name, url: j.html_url, date: (j.published_at || "").slice(0, 10) };
}

/* ---------------- roles people pick for themselves ---------------- */
const ROLE_GROUPS = {
  pings: { label: "Pings", single: false, roles: [
    { name: "Patch Alerts", emoji: "📢", color: 0xe67e22, desc: "Ping me when a new version comes out" },
    { name: "Video Drops", emoji: "🎬", color: 0xe74c3c, desc: "Ping me when a new video goes public" },
    { name: "Playtest Calls", emoji: "🧪", color: 0x1abc9c, desc: "Ping me for group test sessions" },
  ] },
  town: { label: "Home town", single: true, roles: [
    { name: "Bjorn's Landing", emoji: "⚓", color: 0x3498db, desc: "The harbor where it all began" },
    { name: "Kjelvik", emoji: "🏰", color: 0xf1c40f, desc: "The strongest hold, the Seat" },
    { name: "Frostheim", emoji: "❄️", color: 0xaee6ff, desc: "Peace in the ice" },
    { name: "Ironwood", emoji: "🌸", color: 0xff8ccf, desc: "The pink groves" },
    { name: "Eastmark", emoji: "🔥", color: 0xc0392b, desc: "Thieves and would-be conquerors" },
  ] },
  style: { label: "Playstyle", single: false, roles: [
    { name: "Melee", emoji: "⚔️", color: 0, desc: "Up close and personal" },
    { name: "Ranged", emoji: "🏹", color: 0, desc: "Bow and arrows" },
    { name: "Magic", emoji: "🔮", color: 0, desc: "Runes and staffs" },
    { name: "Skiller", emoji: "⛏️", color: 0, desc: "Gathering, crafting, building" },
    { name: "Angler", emoji: "🎣", color: 0, desc: "Fishing and sea monsters" },
    { name: "PvP", emoji: "🩸", color: 0, desc: "Flag up and fight" },
    { name: "Trader", emoji: "💰", color: 0, desc: "Auctions, deals and caravans" },
  ] },
};
const roleMenus = roleIds => Object.entries(ROLE_GROUPS).map(([g, grp]) => ({ type: 1, components: [{
  type: 3, custom_id: "vvroles:" + g, placeholder: `${grp.label}: pick ${grp.single ? "one" : "any"} (empty to clear)`,
  min_values: 0, max_values: grp.single ? 1 : grp.roles.length,
  options: grp.roles.map(r => ({ label: r.name, value: roleIds[r.name] || r.name, emoji: { name: r.emoji }, description: r.desc })),
}] }));

async function setRoles(env, it, group) {
  const ids = (await kget(env, K("roles"))) || {};
  const grp = ROLE_GROUPS[group]; if (!grp) return "🤔";
  const groupIds = grp.roles.map(r => ids[r.name]).filter(Boolean);
  if (!groupIds.length) return "Roles aren't set up yet. (The owner needs to run `/setup-server`.)";
  const want = new Set((it.data.values || []).filter(v => groupIds.includes(v)));
  const have = new Set((it.member.roles || []).filter(r => groupIds.includes(r)));
  const uid = it.member.user.id;
  for (const r of groupIds) {
    if (want.has(r) && !have.has(r)) await api(env, "PUT", `/guilds/${VV.guildId}/members/${uid}/roles/${r}`, undefined, "Self-assigned role");
    if (!want.has(r) && have.has(r)) await api(env, "DELETE", `/guilds/${VV.guildId}/members/${uid}/roles/${r}`, undefined, "Self-assigned role");
  }
  const names = grp.roles.filter(r => want.has(ids[r.name])).map(r => `${r.emoji} ${r.name}`);
  return names.length ? `✅ **${grp.label}:** ${names.join(", ")}` : `✅ Cleared your **${grp.label}** roles.`;
}

/* ---------------- slash commands ---------------- */
const GUIDE_CHOICES = Object.entries(GUIDES).map(([v, g]) => ({ name: g[0].replace(/^\S+\s/, ""), value: v }));
const COMMANDS = [
  { name: "download", description: "Get VikingVale (free, Windows) and how to install it" },
  { name: "version", description: "The newest VikingVale version and its patch notes" },
  { name: "guide", description: "The in-game guides: combat, thralls, boats, warbands and more",
    options: [{ type: 3, name: "topic", description: "Which guide", required: true, choices: GUIDE_CHOICES }] },
  { name: "skills", description: "All 15 skills and how each one trains" },
  { name: "towns", description: "The five holds of VikingVale" },
  { name: "backstories", description: "The five starting backstories and their perks" },
  { name: "prebeta", description: "What Pre-Beta means (resets, placeholder art, Steam)" },
  { name: "ask", description: "Ask VikingVale Bot a question about the game",
    options: [{ type: 3, name: "question", description: "What do you want to know?", required: true, max_length: 200 }] },
  { name: "roles", description: "Pick your pings, home town and playstyle" },
  { name: "setup-server", description: "Owner only: build or repair the server's channels, roles and anti-spam", default_member_permissions: "8", dm_permission: false },
];
const cmdHash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); };

export async function handleVV(it, env, ctx) {
  if (it.type === 3) {
    const id = it.data.custom_id || "";
    if (id.startsWith("vvroles:")) {
      try { return reply(await setRoles(env, it, id.slice(8)), true); } catch (e) { return reply("Couldn't change your roles right now. Try again in a minute.", true); }
    }
    if (id === "vvroles") { const ids = (await kget(env, K("roles"))) || {}; return reply("Pick what you want (choose nothing in a menu to clear it):", true, { components: roleMenus(ids) }); }
    return reply("🤔", true);
  }
  if (it.type !== 2) return reply("🤔", true);
  const opt = Object.fromEntries((it.data.options || []).map(o => [o.name, o.value]));
  switch (it.data.name) {
    case "download": return reply(HOWTO_INSTALL, false, { components: [{ type: 1, components: [{ type: 2, style: 5, label: "Download VikingVale", emoji: { name: "⬇️" }, url: VV.download }] }] });
    case "guide": return reply(guideText(opt.topic));
    case "skills": return reply(SKILLS);
    case "towns": return reply(TOWNS);
    case "backstories": return reply(BACKSTORIES);
    case "prebeta": return reply(PREBETA);
    case "ask": return reply(`> ${String(opt.question).replace(/\n/g, " ").slice(0, 200)}\n${answer(opt.question)}`);
    case "roles": { const ids = (await kget(env, K("roles"))) || {}; return reply("Pick what you want (choose nothing in a menu to clear it):", true, { components: roleMenus(ids) }); }
    case "version":
      ctx.waitUntil(latestRelease().then(r => editReply(it.token, { content: `🛡️ The newest version is **${r.name || r.tag}** (${r.date}).\nPatch notes: ${r.url}\nThe game updates itself when you launch it. New here? ${VV.download}` }))
        .catch(() => editReply(it.token, { content: `Couldn't reach GitHub right now. All versions: ${VV.releases}` })));
      return json({ type: 5 });
    case "setup-server":
      ctx.waitUntil(setupVV(env).then(log => editReply(it.token, { content: "✅ **VikingVale server setup done.**\n" + log.join("\n").slice(0, 1850) }))
        .catch(e => editReply(it.token, { content: "⚠️ Setup stopped: " + String(e.message || e).slice(0, 1500) })));
      return json({ type: 5, data: { flags: 64 } });
  }
  return reply("I don't know that command.", true);
}

/* ---------------- /setup-server for the VikingVale server ---------------- */
async function setupVV(env) {
  const G = VV.guildId, log = [];
  const everyone = G;
  const readOnly = [{ id: everyone, type: 0, deny: bits(P.SEND, P.THREADS_PUB, P.THREADS_PRIV, P.SEND_THREADS), allow: bits(P.REACT) }];
  const hidden = [{ id: everyone, type: 0, deny: bits(P.VIEW) }];

  try { await api(env, "PATCH", `/guilds/${G}/members/@me`, { nick: VV.nick }, "Bot name in this server"); } catch (e) { /* not important */ }

  // roles (pings, home towns, playstyles)
  const existingRoles = await api(env, "GET", `/guilds/${G}/roles`);
  const roleIds = {};
  for (const grp of Object.values(ROLE_GROUPS)) for (const r of grp.roles) {
    let role = existingRoles.find(x => x.name === r.name);
    if (!role) { role = await api(env, "POST", `/guilds/${G}/roles`, { name: r.name, color: r.color, mentionable: false, hoist: false }, "Self-assign role"); log.push(`• Role ${r.emoji} ${r.name}`); }
    roleIds[r.name] = role.id;
  }
  await kput(env, K("roles"), roleIds);

  // channels: find by name so running again never duplicates anything
  let chans = await api(env, "GET", `/guilds/${G}/channels`);
  const find = (name, type) => chans.find(c => c.name === name && (type === undefined || c.type === type));
  async function rename(oldName, newName, type, extra = {}) {   // reuse Discord's default channels instead of leaving them behind
    const c = find(oldName, type);
    if (c && !find(newName)) { const n = await api(env, "PATCH", `/channels/${c.id}`, { name: newName, ...extra }, "Server setup"); Object.assign(c, n); log.push(`• Renamed ${oldName} → ${newName}`); }
  }
  async function ensure(name, type, parent, extra = {}) {
    let c = find(name) || (type === T.NEWS ? find(name, T.TEXT) : null);
    if (!c) { c = await api(env, "POST", `/guilds/${G}/channels`, { name, type, parent_id: parent || undefined, ...extra }, "Server setup"); chans.push(c); log.push(`• Made ${type === T.CATEGORY ? "category " : type === T.VOICE ? "voice " : type === T.STAGE ? "stage " : "#"}${name}`); }
    else {
      const patch = {};
      if (parent && c.parent_id !== parent) patch.parent_id = parent;
      if (extra.topic && c.topic !== extra.topic && type !== T.FORUM) patch.topic = extra.topic;
      if (extra.position !== undefined && type === T.CATEGORY) patch.position = extra.position;
      if (extra.permission_overwrites && !(c.permission_overwrites || []).length) patch.permission_overwrites = extra.permission_overwrites;
      if (Object.keys(patch).length) Object.assign(c, await api(env, "PATCH", `/channels/${c.id}`, patch, "Server setup"));
    }
    return c;
  }
  await rename("Text Channels", "⚔️ THE VALE", T.CATEGORY);
  await rename("Voice Channels", "🔊 VOICE", T.CATEGORY);
  await rename("updates", "patch-notes", T.TEXT);   // release.bat's changelog webhook keeps posting here after the rename
  await rename("General", "Mead Hall", T.VOICE);

  const catStart = await ensure("📜 START HERE", T.CATEGORY, null, { position: 0 });
  const catNews = await ensure("📣 NEWS", T.CATEGORY, null, { position: 1 });
  const catTest = await ensure("🧪 PRE-BETA TESTING", T.CATEGORY, null, { position: 2 });
  const catVale = await ensure("⚔️ THE VALE", T.CATEGORY, null, { position: 3 });
  const catVoice = await ensure("🔊 VOICE", T.CATEGORY, null, { position: 4 });
  const catStaff = await ensure("🔒 STAFF", T.CATEGORY, null, { position: 9, permission_overwrites: hidden });

  // START HERE
  const welcome = await ensure("welcome", T.TEXT, catStart.id, { topic: "Start here: what VikingVale is and how this server works", permission_overwrites: readOnly });
  const rules = await ensure("rules", T.TEXT, catStart.id, { topic: "Server rules", permission_overwrites: readOnly });
  const howto = await ensure("how-to-play", T.TEXT, catStart.id, { topic: "Download, install and your first hour", permission_overwrites: readOnly });
  const pick = await ensure("pick-your-roles", T.TEXT, catStart.id, { topic: "Pings, home town and playstyle", permission_overwrites: readOnly });
  const faq = await ensure("faq", T.TEXT, catStart.id, { topic: "Quick answers. Ask the bot anything with /ask", permission_overwrites: readOnly });
  // NEWS
  let news = await ensure("announcements", T.TEXT, catNews.id, { topic: "Big news, server status, season resets and playtests", permission_overwrites: readOnly });
  let patch = await ensure("patch-notes", T.TEXT, catNews.id, { topic: "Every release's full changelog (posted automatically by release.bat)", permission_overwrites: readOnly });
  let drops = await ensure("video-drops", T.TEXT, catNews.id, { topic: "New VikingVale videos the moment they go public", permission_overwrites: readOnly });
  const devlog = await ensure("dev-log", T.TEXT, catNews.id, { topic: "Work in progress and sneak peeks from Busterrdust", permission_overwrites: readOnly });
  // PRE-BETA TESTING
  const testerInfo = await ensure("tester-info", T.TEXT, catTest.id, { topic: "What Pre-Beta means and how to give feedback that helps", permission_overwrites: readOnly });
  const known = await ensure("known-issues", T.TEXT, catTest.id, { topic: "Bugs we already know about (check here before reporting)", permission_overwrites: readOnly });
  const sessions = await ensure("playtest-sessions", T.TEXT, catTest.id, { topic: "Group test sessions: when, where, what we're testing" });
  // THE VALE
  const general = await ensure("general", T.TEXT, catVale.id, { topic: "Talk VikingVale and anything else (be nice)" });
  await ensure("quests-and-help", T.TEXT, catVale.id, { topic: "Stuck on a quest or new to the game? Ask here" });
  await ensure("skills-and-gear", T.TEXT, catVale.id, { topic: "Training routes, gear, crafting, thralls" });
  await ensure("screenshots-and-clips", T.TEXT, catVale.id, { topic: "Show off your Viking, your boat, your settlement, 2D or 3D" });
  await ensure("lore-and-towns", T.TEXT, catVale.id, { topic: "The five holds, the Tokens, the trolls and dragons, theories" });
  const askBot = await ensure("ask-the-bot", T.TEXT, catVale.id, { topic: "Try /ask, /guide, /skills, /towns, /version" });
  // VOICE
  await ensure("Mead Hall", T.VOICE, catVoice.id);
  await ensure("Warband Raid I", T.VOICE, catVoice.id);
  await ensure("Warband Raid II", T.VOICE, catVoice.id);
  // STAFF
  const modlog = await ensure("mod-log", T.TEXT, catStaff.id, { topic: "AutoMod alerts and Discord notices (staff only)", permission_overwrites: hidden });
  await ensure("dev-notes", T.TEXT, catStaff.id, { topic: "Private notes and drafts", permission_overwrites: hidden });

  // Community mode (needed for announcement channels, forums and the stage) + anti-raid basics
  const guild = await api(env, "GET", `/guilds/${G}`);
  if (!guild.features.includes("COMMUNITY")) {
    await api(env, "PATCH", `/guilds/${G}`, { features: [...guild.features, "COMMUNITY"], verification_level: 2, explicit_content_filter: 2,
      default_message_notifications: 1, rules_channel_id: rules.id, public_updates_channel_id: modlog.id,
      description: "The official server for VikingVale, a free multiplayer Viking RPG in Pre-Beta by Busterrdust." }, "Server setup: Community mode");
    log.push("• Turned on Community mode (accounts must be 5+ minutes old; media scanned for everyone)");
  } else await api(env, "PATCH", `/guilds/${G}`, { verification_level: Math.max(guild.verification_level, 2), default_message_notifications: 1 }, "Server setup");
  for (const [label, c] of [["announcements", news], ["patch-notes", patch], ["video-drops", drops]]) {
    if (c.type === T.TEXT) { const n = await api(env, "PATCH", `/channels/${c.id}`, { type: T.NEWS }, "Server setup"); if (label === "announcements") news = n; if (label === "patch-notes") patch = n; if (label === "video-drops") drops = n; log.push(`• #${label} is now an Announcement channel`); }
  }
  chans = await api(env, "GET", `/guilds/${G}/channels`);
  const mod = name => ({ name, moderated: true });
  const bugs = await ensure("bug-reports", T.FORUM, catTest.id, { topic: "One post per bug: what happened, what you were doing, 2D or 3D, screenshot if you can. Check #known-issues first.",
    available_tags: [{ name: "Combat" }, { name: "Quests" }, { name: "Skills & Gathering" }, { name: "Map & World" }, { name: "UI" }, { name: "2D" }, { name: "3D" }, { name: "Connection/Login" }, { name: "Crash" }, { name: "Exploit" }, mod("Known 📌"), mod("Fixed ✅")] });
  const feedback = await ensure("feedback", T.FORUM, catTest.id, { topic: "One idea per post. React 👍 on the ones you want",
    available_tags: [{ name: "Gameplay" }, { name: "Balance" }, { name: "Quests & Lore" }, { name: "UI" }, { name: "Art & Audio" }, { name: "New Content" }, mod("Planned 🗺️"), mod("Added ✅")] });
  const guides = await ensure("guides", T.FORUM, catVale.id, { topic: "How-tos for every system. Players can add their own guides too",
    available_tags: [{ name: "Official", moderated: true }, { name: "Player Guide" }, { name: "Beginner" }, { name: "Advanced" }] });
  await ensure("trading-post", T.FORUM, catVale.id, { topic: "One post per deal. Mark it Done when it's traded",
    available_tags: [{ name: "Buying" }, { name: "Selling" }, { name: "Trading" }, { name: "Done" }] });
  await ensure("warband-recruitment", T.FORUM, catVale.id, { topic: "Recruit for your warband or find one to join",
    available_tags: [{ name: "Recruiting" }, { name: "Looking for Warband" }, { name: "Alliance" }, { name: "Casual" }, { name: "PvP" }] });
  await ensure("Playtest Stage", T.STAGE, catVoice.id);
  await kput(env, K("channels"), { welcome: welcome.id, rules: rules.id, news: news.id, patch: patch.id, drops: drops.id, modlog: modlog.id, general: general.id });

  // permanent invite + anti-spam
  let invite = await kget(env, K("invite"));
  if (!invite) { invite = (await api(env, "POST", `/channels/${welcome.id}/invites`, { max_age: 0, max_uses: 0, unique: false }, "Permanent invite")).code; await kput(env, K("invite"), invite); }
  log.push(`• Permanent invite: https://discord.gg/${invite}`);
  const existing = await api(env, "GET", `/guilds/${G}/auto-moderation/rules`);
  const alert = { type: 2, metadata: { channel_id: modlog.id } };
  const block = msg => ({ type: 1, metadata: { custom_message: msg } });
  const amRules = [
    { name: "Spam filter", event_type: 1, trigger_type: 3, actions: [block("Looks like spam, so it was blocked."), alert] },
    { name: "Mention spam", event_type: 1, trigger_type: 5, trigger_metadata: { mention_total_limit: 5, mention_raid_protection_enabled: true }, actions: [block("Too many pings in one message."), alert, { type: 3, metadata: { duration_seconds: 600 } }] },
    { name: "No slurs", event_type: 1, trigger_type: 4, trigger_metadata: { presets: [3] }, actions: [block("Cursing's fine. Slurs aren't. Keep it respectful."), alert] },
    { name: "No other server invites", event_type: 1, trigger_type: 1, trigger_metadata: { keyword_filter: ["discord.gg/*", "discord.com/invite/*", "discordapp.com/invite/*"], allow_list: [`discord.gg/${invite}`, `discord.com/invite/${invite}`, "discord.gg/NjpkAwydk8", "discord.com/invite/NjpkAwydk8"] }, actions: [block("Please don't post other servers' invites."), alert] },
  ];
  for (const r of amRules) if (!existing.find(e => e.name === r.name)) { await api(env, "POST", `/guilds/${G}/auto-moderation/rules`, { ...r, enabled: true }, "Anti-spam"); log.push(`• AutoMod: ${r.name}`); }

  // the posts (each posted once; delete one and run setup again to re-post it)
  const posted = (await kget(env, K("posted"))) || {};
  async function postOnce(key, channelId, msg) {
    if (posted[key]) { try { await api(env, "GET", `/channels/${channelId}/messages/${posted[key]}`); return; } catch (e) { /* deleted: post again */ } }
    const m = await api(env, "POST", `/channels/${channelId}/messages`, { allowed_mentions: { parse: [] }, ...msg }); posted[key] = m.id; log.push(`• Posted ${key}`);
  }
  async function forumOnce(key, forumId, name, content, tagName) {
    if (posted[key]) return;
    const f = (await api(env, "GET", `/guilds/${G}/channels`)).find(c => c.id === forumId);
    const tag = (f?.available_tags || []).find(t => t.name === tagName);
    const th = await api(env, "POST", `/channels/${forumId}/threads`, { name, applied_tags: tag ? [tag.id] : [], message: { content, allowed_mentions: { parse: [] } } }, "Official guide");
    posted[key] = th.id; log.push(`• Forum post: ${name}`);
  }
  const C = id => `<#${id}>`;
  const gold = 0xd4a24c, red = 0xc0392b, green = 0x2e8b57, blue = 0x2c7fb8;

  await postOnce("welcome", welcome.id, {
    embeds: [{ color: gold, title: "⚔️ Welcome to VikingVale!",
      description: [
        "**VikingVale** is a free multiplayer **Viking RPG** made by **Busterrdust**. Train 15 skills, fight monsters and other Vikings, sail to sea-monster waters, trade, run a warband and claim land in one shared, persistent world. Play in **2D or low-poly 3D** and switch any time.",
        "",
        "🧪 It's in **Pre-Beta**: art and sound are placeholders and progress can reset. Read " + C(testerInfo.id) + ".",
        "",
        "**Find your way around**",
        `• ${C(rules.id)}: short, read them first`,
        `• ${C(howto.id)}: download and your first hour`,
        `• ${C(pick.id)}: pings, home town, playstyle`,
        `• ${C(faq.id)}: quick answers (or ask the bot with \`/ask\`)`,
        `• ${C(news.id)} · ${C(patch.id)} · ${C(drops.id)} · ${C(devlog.id)}: news, every update, new videos, sneak peeks`,
        `• ${C(bugs.id)} and ${C(feedback.id)}: one post each so nothing gets lost`,
        `• ${C(general.id)} and the rest of ⚔️ THE VALE: hang out, get help, trade, recruit`,
      ].join("\n"),
      footer: { text: "Made solo by Busterrdust · busterrdust.com/games" } }],
    components: [{ type: 1, components: [
      { type: 2, style: 5, label: "Download (Windows, free)", emoji: { name: "⬇️" }, url: VV.download },
      { type: 2, style: 1, label: "Pick my roles", emoji: { name: "🎭" }, custom_id: "vvroles" },
      { type: 2, style: 5, label: "Watch gameplay", emoji: { name: "🎬" }, url: VV.trailer },
    ] }],
  });
  await postOnce("rules", rules.id, {
    embeds: [{ color: red, title: "📜 Rules",
      description: [
        "**1. Be nice and respectful.** Banter is fine; bullying, harassment and hate aren't.",
        "**2. Cursing is allowed. Act like adults.** No slurs, nothing NSFW, no gore.",
        "**3. No spam or self-promo.** That includes other servers' invites, scam links and DM advertising.",
        "**4. Keep things in the right channel.** Bugs in #bug-reports, ideas in #feedback, deals in #trading-post.",
        "**5. Play fair.** No cheating, botting, exploiting or real-money trading. Found an exploit? Report it (tag **Exploit**) instead of using it.",
        "**6. In-game PvP and rivalries stay in the game.** No personal attacks, doxxing or harassment over a fight.",
        "**7. Don't impersonate players, staff or Busterrdust.**",
        "**8. Follow Discord's Terms and Community Guidelines.**",
        "", "Breaking the rules gets a warning, a timeout, or a ban, depending on how bad it is. In-game rule breaks can also cost your account. Skål! 🍻",
      ].join("\n") }],
  });
  await postOnce("howto", howto.id, {
    embeds: [
      { color: green, title: "⬇️ Download & install", description: HOWTO_INSTALL },
      { color: green, title: "🧭 Your first hour", description: [
        "• **Pick a backstory** (`/backstories` shows the perks). It's a small boost; you can still train anything.",
        "• **Gather sticks and stones**, then open **Crafting** (💎) for your starter tools.",
        "• Chop, mine and fish to level up. Cook your fish: **cooked food is how you heal**.",
        "• Talk to **Elder Bjarne in Kjelvik** to start the main story.",
        "• Train combat at the **archery range**, **runestones** and **sparring dummies** in town.",
        "• Kill monsters for loot (and a 4% chance at a **thrall** who works while you're offline).",
        "• Later: build a **boat**, join or start a **warband**, plant a **banner** and claim land.",
        "",
        `Every system has a full guide in ${C(guides.id)}, and \`/guide\` shows any of them right in chat.`,
      ].join("\n") },
      { color: green, title: "🖥️ 2D or 3D?", description: "VikingVale has two views of the same world: classic **2D** and low-poly **3D** (beta). Switch between them any time; everyone plays on the same server." },
    ],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: "Download VikingVale", emoji: { name: "⬇️" }, url: VV.download }, { type: 2, style: 5, label: "All versions", url: VV.releases }] }],
  });
  await postOnce("roles", pick.id, {
    embeds: [{ color: blue, title: "🎭 Pick your roles",
      description: [
        "Use the menus below. Pick as many as you like (one home town), and pick nothing in a menu to clear it.",
        "",
        "**Pings**: 📢 Patch Alerts · 🎬 Video Drops · 🧪 Playtest Calls",
        "**Home town**: ⚓ Bjorn's Landing · 🏰 Kjelvik · ❄️ Frostheim · 🌸 Ironwood · 🔥 Eastmark",
        "**Playstyle**: ⚔️ Melee · 🏹 Ranged · 🔮 Magic · ⛏️ Skiller · 🎣 Angler · 🩸 PvP · 💰 Trader",
      ].join("\n") }],
    components: roleMenus(roleIds),
  });
  const faqLines = [
    ["Is it free?", "Yes. Free during Pre-Beta."],
    ["What can I play it on?", "Windows for now. The full release is headed to Steam."],
    ["Will my progress be wiped?", "It can be. In Pre-Beta nothing is permanent, and big updates can start a fresh season. Resets are always announced first."],
    ["Why does it look unfinished?", "Most art and sound is placeholder. Real models, music and voice actors are coming before Steam."],
    ["How do updates work?", "The game updates itself when you launch it. Notes go in #patch-notes."],
    ["Can't connect?", "Relaunch so the updater runs, and check #announcements in case the server's down for an update. Still stuck? Post in #bug-reports."],
    ["Where do I start the story?", "Elder Bjarne in Kjelvik."],
    ["How do I heal?", "Eat cooked food."],
    ["Is PvP forced?", "No. It's toggle-only, and the Kjelvik castle is a safe zone."],
    ["How do I get a thrall?", "A 4% drop from monster kills when you have a free roster slot."],
  ];
  await postOnce("faq", faq.id, {
    embeds: [{ color: blue, title: "❓ FAQ", description: faqLines.map(([q, a]) => `**${q}**\n${a}`).join("\n\n") + "\n\nAnything else? Ask the bot: `/ask question:...` in " + C(askBot.id) }],
  });
  await postOnce("tester-info", testerInfo.id, {
    embeds: [
      { color: 0x1abc9c, title: "🧪 You're a Pre-Beta tester", description: PREBETA },
      { color: 0x1abc9c, title: "🐞 Reports that get fixed fast", description: [
        `Make **one post per bug** in ${C(bugs.id)} and include:`,
        "1. **What happened** and what you expected",
        "2. **What you were doing** right before (and where, if you can)",
        "3. **2D or 3D**, and your version (it's on the login screen)",
        "4. A **screenshot or clip** if you can",
        "5. Can you make it happen again? How?",
        "",
        `Pick the tags that fit. Check ${C(known.id)} first.`,
        "Found a way to cheat or dupe? Tag it **Exploit** and please don't use it.",
      ].join("\n") },
      { color: 0x1abc9c, title: "💡 Feedback", description: `Ideas, balance and \"this felt bad\" go in ${C(feedback.id)}, one per post. React 👍 on the ones you agree with. Want a ping for group test sessions? Grab 🧪 **Playtest Calls** in ${C(pick.id)}.` },
    ],
  });
  await postOnce("known-issues", known.id, {
    embeds: [{ color: 0xe67e22, title: "📌 Known issues", description: [
      "Already on the list, no need to report these:",
      "• **Frostmaw Hollow** (the dungeon) still looks like a castle inside, and its monsters can walk through walls.",
      "• Most **art, music and voices** are placeholders.",
      "• Parts of the **map edges** are still being filled in (new monsters, nodes and NPCs coming). Troll and dragon villages are planned.",
      "• The **3D view** is in beta.",
      "",
      `Busterrdust keeps this up to date. Fixed bugs get the ✅ tag in ${C(bugs.id)}.`,
    ].join("\n") }],
  });
  await postOnce("announce-hello", news.id, {
    embeds: [{ color: gold, title: "📣 The VikingVale server just got a lot bigger", description: [
      "New channels for news, patch notes, video drops, bug reports, feedback, guides, trading and warband recruiting, plus **VikingVale Bot**.",
      "",
      `Grab your roles in ${C(pick.id)} to get pinged for new versions, new videos and group playtests.`,
      "Try `/ask`, `/guide`, `/skills`, `/towns` and `/version` in " + C(askBot.id) + ".",
      "", "See you in the Vale. ⚔️",
    ].join("\n") }],
  });
  // the official guides, one forum post each
  for (const [id, g] of Object.entries(GUIDES)) await forumOnce("guide-" + id, guides.id, g[0], `**${g[0]}**\n${g[1].join("\n")}\n\n_Official guide. Add your own tips below!_`, "Official");
  await kput(env, K("posted"), posted);
  return log;
}

/* ---------------- every 10 minutes ---------------- */
export async function scheduledVV(env) {
  const body = JSON.stringify(COMMANDS), h = cmdHash(body);
  if ((await kget(env, K("cmdHash"))) !== h) { await api(env, "PUT", `/applications/${APP_ID}/guilds/${VV.guildId}/commands`, COMMANDS); await kput(env, K("cmdHash"), h); }
  const ch = await kget(env, K("channels")); if (!ch || !ch.drops) return;   // waits for /setup-server
  const roles = (await kget(env, K("roles"))) || {};

  // new public VikingVale videos → #video-drops
  const all = await youtubeFeed();
  if (all) {
    const vids = all.filter(v => !/longship/i.test(v.title) && /viking\s?vale/i.test(v.title + " " + v.desc));
    let seen = await kget(env, K("ytSeen"));
    if (!seen) await kput(env, K("ytSeen"), vids.map(v => v.id));   // first run: remember what's already out, post nothing
    else {
      const fresh = vids.filter(v => !seen.includes(v.id)).reverse();
      for (const v of fresh) {
        const role = roles["Video Drops"];
        await api(env, "POST", `/channels/${ch.drops}/messages`, { content: `${role ? `<@&${role}> ` : ""}🎬 **New VikingVale video!** ${v.title}\nhttps://youtu.be/${v.id}`, allowed_mentions: { roles: role ? [role] : [] } });
        seen.push(v.id);
      }
      if (fresh.length) await kput(env, K("ytSeen"), seen.slice(-300));
    }
  }

  // new GitHub release → a short heads-up in #announcements (checked every half hour to stay well inside GitHub's limits)
  if (new Date().getUTCMinutes() % 30 < 10) {
    const rel = await latestRelease().catch(() => null);
    if (rel && rel.tag) {
      const last = await kget(env, K("lastRelease"));
      if (!last) await kput(env, K("lastRelease"), rel.tag);
      else if (last !== rel.tag) {
        const role = roles["Patch Alerts"];
        await api(env, "POST", `/channels/${ch.news}/messages`, {
          content: `${role ? `<@&${role}> ` : ""}🛡️ **VikingVale ${rel.tag} is out!** Relaunch the game and it updates itself.\nFull notes in <#${ch.patch}> · ${rel.url}\nNew here? ${VV.download}`,
          allowed_mentions: { roles: role ? [role] : [] } });
        await kput(env, K("lastRelease"), rel.tag);
      }
    }
  }
}
