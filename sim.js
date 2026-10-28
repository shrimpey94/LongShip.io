/* Longship.io: the shared world rules.
   The same file runs in the browser (bots-only mode, when the server can't be reached)
   and on the lobby server (the real multiplayer sea), so both play by exactly the same rules.
   It has no drawing code: ships carry look ids (skinId / fig / trailId) and the browser turns those into art. */
(function (root) {
  "use strict";

  /* ---------- tuning ---------- */
  const W = 8000;                    // world size
  const SPEED = 1.15, BOOST = 2.3;   // px per frame at 60fps
  const TURN = 0.045;
  const BASE_LEN = 21,   // every ship starts with 21 shields (so an early Mjölnir strike can't sink a brand-new player)
        BOTS = 34, GOLD_TARGET = 5000, ISLES = 22, POWER_TARGET = 34;
  const PSTEP = 3;                   // the wake is remembered as a point every 3px
  const POWERS = [   // rarity 0 common .. 3 legendary
    { id: "oars",   icon: "⛵", name: "Swift Oars",     r: 0, w: 30, dur: 8,  note: "Row faster for free" },
    { id: "magnet", icon: "🧲", name: "Odin's Pull",    r: 0, w: 26, dur: 12, note: "Nearby gold drifts to you" },
    { id: "feast",  icon: "🍖", name: "Feast",          r: 1, w: 15, dur: 0,  note: "+12 shields" },
    { id: "ward",   icon: "🛡️", name: "Thor's Ward",    r: 1, w: 13, dur: 20, note: "Survive one crash" },
    { id: "ghost",  icon: "👻", name: "Ghost Ship",     r: 2, w: 7,  dur: 7,  note: "Sail through ships" },
    { id: "mead",   icon: "🍺", name: "Mead of Plenty", r: 2, w: 6,  dur: 15, note: "Gold counts double" },
    { id: "mjolnir",icon: "⚡", name: "Mjölnir",        r: 3, w: 3,  dur: 0,  note: "Lightning shatters the nearest rival's shield wall" },
  ];
  // loot drifting at sea (value = how much it grows you; 3 value = 1 shield)
  const LOOT = { coin: { v: 1, w: 80 }, silver: { v: 2, w: 9 }, amber: { v: 3, w: 5 }, gem: { v: 5, w: 3.5 }, goblet: { v: 8, w: 1.6 }, horn: { v: 12, w: .7 }, chest: { v: 25, w: 0 } };
  const LOOT_TYPES = Object.keys(LOOT);
  const LOOT_SPAWN = Object.entries(LOOT).filter(([, o]) => o.w > 0), LOOT_W = LOOT_SPAWN.reduce((a, [, o]) => a + o.w, 0);
  const GEM_HUES = [350, 140, 210, 280];
  const NAMES = ["Ragnhild", "Bjorn", "Sigrid", "Ulf", "Astrid", "Leif", "Freydis", "Hakon", "Gunnar", "Thyra", "Eirik", "Solveig", "Knut", "Ingrid",
    "Halfdan", "Brynja", "Orm", "Dagny", "Sven", "Yrsa", "Torvald", "Gudrun", "Arne", "Hilda", "Rolf", "Signy", "Asger", "Liv",
    "Ivar", "Kari", "Njal", "Tove", "Vidar", "Embla"];
  const ROGUE_NAMES = ["Hrafn the Grim", "Skarde Bloodaxe", "Ivar Boneless", "Grima Wolfsbane"];
  const SEASONS = {
    halloween: { boss: { name: "👻 The Flying Dutchman", len: 110, skin: "ghost", fig: "skull" },
      rogues: ["💀 Bonejaw", "💀 Grimtooth", "💀 Rattlebones", "💀 Hollow Eye"], rogueSkin: "bone" },
    christmas: { boss: { name: "😈 Krampus", len: 110, skin: "krampus", fig: "skull" },
      rogues: ["😈 Krampus's Imp", "❄️ Frost Thrall", "❄️ Ice Wraith", "😈 Coal Fiend"], rogueSkin: "krampus" },
  };
  /* ---------- seasons: the ONE calendar the game, lobby and store all use ----------
     start = first day, end = first day AFTER the season (so Halloween runs Oct 1 through Nov 2).
     The sea, bots, boss and title page follow start/end. The season's ITEMS can go on sale earlier (shopStart),
     so Yule skins go on sale the moment the Halloween ones leave, while the sea stays normal until Nov 20.
     Days flip at midnight US Eastern (05:00 UTC). Change a date here and everything follows. */
  const SEASON_DATES = {
    halloween: { start: [10, 1],  end: [11, 3] },
    christmas: { start: [11, 20], end: [1, 3], shopStart: [11, 3] },
  };
  const PREVIEW_MS = 2 * 864e5;   // the next season's items show (greyed out) this long before it starts
  const at = (y, md) => Date.UTC(y, md[0] - 1, md[1], 5);
  function seasonWindows(t, shop) {   // every season window touching the years around time t (shop = when its items sell)
    const y = new Date(t).getUTCFullYear(), out = [];
    for (const yy of [y - 1, y, y + 1]) for (const id in SEASON_DATES) {
      const d = SEASON_DATES[id], s0 = shop && d.shopStart || d.start;
      const start = at(yy, s0), end = at(yy + (d.end[0] < s0[0] ? 1 : 0), d.end);
      out.push({ id, start, end });
    }
    return out.sort((a, b) => a.start - b.start);
  }
  function seasonAt(t) { return seasonWindows(t).find(w => t >= w.start && t < w.end) || null; }
  function nextSeason(t) { return seasonWindows(t).find(w => w.start > t) || null; }
  // when a season's items are on sale / next go on sale
  function itemWindow(id, t) { return seasonWindows(t, true).find(w => w.id === id && t >= w.start && t < w.end) || null; }
  function nextItemWindow(id, t) { return seasonWindows(t, true).find(w => w.id === id && w.start > t) || null; }
  function seasonOf(d) { const w = seasonAt(+d); return w ? w.id : null; }
  // looks the bots can wear (the browser owns the art for every id)
  const BOT_SKINS = { all: ["fjord", "glacier", "forest", "raven", "frost", "jarl", "aurora", "thunder", "kraken", "blood", "ember", "valhalla"],
    halloween: ["ghost", "bone", "pumpkin"], christmas: ["candycane", "frostbite", "ginger"] };
  const BOT_FIGS = { all: ["dragon", "wolf", "serpent", "ravenh", "bear"], halloween: ["jack", "bat", "wraith"], christmas: ["reindeer", "snowman", "yulestar"] };
  const PREMIUM_FIGS = ["gdragon", "ramh", "firedrake", "frostwyrm", "krakenh", "ravens", "phoenix", "fenrir", "sleipnir", "jorm", "valkyrie", "sol"];
  const BOT_TRAILS = { all: ["foam", "glitter", "frostt", "embert", "feathert", "inkt", "sparkt", "auroratr", "lightt", "venomt", "bifrost", "valkt"],
    halloween: ["mistt", "pleavest"], christmas: ["snowt", "candyt"] };

  /* ---------- helpers ---------- */
  const rnd = (a, b) => a + Math.random() * (b - a), clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
  const d2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
  const pick = a => a[(Math.random() * a.length) | 0];
  /* Shield wall growth. "len" is still the shield count (your score); these decide how it looks.
     WALL_*: every shield adds a piece while you're small, then pieces taper off (100 shields ≈ 75 pieces, 300 ≈ 128, 1000 ≈ 191).
     Width (12.5 at the 21-shield start):
       21 → 900 shields:   widens slowly to double (+100%).   100 ≈ +23%, 250 ≈ +43%, 500 ≈ +68%
       900 → 1000:         holds at double
       1000 → 2500:        widens again, up to 60% more (3.2x the start), then stops for good */
  const WALL_FULL = 30, WALL_EASE = 55;
  const segCount = len => len <= WALL_FULL ? len : Math.round(WALL_FULL + WALL_EASE * Math.log(1 + (len - WALL_FULL) / WALL_EASE));
  const R_START = 12.5, R_FIRST_AT = 900, R_AGAIN_AT = 1000, R_MAX_AT = 2500, R_TABLE = new Float32Array(R_MAX_AT + 1);
  for (let n = 0; n <= R_MAX_AT; n++) {
    const first = 1 + Math.pow(Math.min(1, Math.max(0, n - BASE_LEN) / (R_FIRST_AT - BASE_LEN)), 0.6);              // 1x → 2x
    const again = 1 + .6 * Math.pow(Math.min(1, Math.max(0, n - R_AGAIN_AT) / (R_MAX_AT - R_AGAIN_AT)), 0.7);      // then x1.0 → x1.6
    R_TABLE[n] = R_START * first * again;
  }
  const radius = s => R_TABLE[s.len >= R_MAX_AT ? R_MAX_AT : s.len > 0 ? s.len | 0 : 0];
  const gap = s => radius(s);
  let maxR = 24;   // widest ship on the sea this frame: nearby-searches reach this far

  /* ---------- spatial grids: fixed cell arrays emptied and refilled each frame (no garbage) ---------- */
  const CELL = 160, GN = Math.ceil(W / CELL);
  function Grid() { this.cells = Array.from({ length: GN * GN }, () => []); this.used = []; }
  Grid.prototype.clear = function () { for (let j = 0; j < this.used.length; j++) this.cells[this.used[j]].length = 0; this.used.length = 0; };
  Grid.prototype.add = function (x, y, v) { const k = clamp((y / CELL) | 0, 0, GN - 1) * GN + clamp((x / CELL) | 0, 0, GN - 1), a = this.cells[k]; if (!a.length) this.used.push(k); a.push(v); };
  Grid.prototype.near = function (x, y, r, fn) {
    const x0 = clamp(((x - r) / CELL) | 0, 0, GN - 1), x1 = clamp(((x + r) / CELL) | 0, 0, GN - 1);
    const y0 = clamp(((y - r) / CELL) | 0, 0, GN - 1), y1 = clamp(((y + r) / CELL) | 0, 0, GN - 1);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) { const a = this.cells[cy * GN + cx]; for (let j = 0; j < a.length; j++) if (fn(a[j]) === false) return; }
  };

  // places shields along the wake, reusing the same objects every frame, and tracks a bounding box for culling
  function buildSegs(s) {
    const P = s.path, segs = s.segs, sp = gap(s);
    let n = 0, px = s.x, py = s.y, need = sp, k = P.length - 1;
    let o = segs[0] || (segs[0] = { s, i: 0, x: 0, y: 0, warn: -99 }); o.x = px; o.y = py; o.s = s; n = 1;
    let bx0 = px, bx1 = px, by0 = py, by1 = py;
    const want = segCount(s.len);
    while (n <= want && k >= 0) {
      const q = P[k], dx = q.x - px, dy = q.y - py, d = Math.sqrt(dx * dx + dy * dy);
      if (d >= need) { const t = need / d; px += dx * t; py += dy * t; need = sp;
        o = segs[n] || (segs[n] = { s, i: n, x: 0, y: 0, warn: -99 }); o.x = px; o.y = py; o.s = s; n++;
        if (px < bx0) bx0 = px; else if (px > bx1) bx1 = px; if (py < by0) by0 = py; else if (py > by1) by1 = py; }
      else { need -= d; px = q.x; py = q.y; k--; }
    }
    segs.length = n; s.bx0 = bx0; s.bx1 = bx1; s.by0 = by0; s.by1 = by1;
    if (k > 200) P.splice(0, k - 40);   // forget wake older than the stern, in batches
  }
  function pushPath(s) { const lp = s.path[s.path.length - 1]; if (!lp || d2(lp.x, lp.y, s.x, s.y) >= PSTEP * PSTEP) s.path.push({ x: s.x, y: s.y }); }
  // steering + rowing for one ship (also used by the browser to move your own ship instantly in multiplayer)
  function moveShip(s, f) {
    const free = !!s.buffs.oars, boost = (s.boosting && s.len > BASE_LEN) || free;
    const turn = (TURN - Math.min(.015, s.len / 9000)) * f;
    s.a += clamp(angDiff(s.a, s.target), -turn, turn);
    const sp = (boost ? BOOST : SPEED) * (free ? 1.15 : 1) * f;
    s.x += Math.cos(s.a) * sp; s.y += Math.sin(s.a) * sp;
  }
  const MAX_SPEED = BOOST * 1.15;   // fastest legal speed (px per frame), for checking players' reported moves

  /* ===================== the world ===================== */
  // opts: { season, bots, track (server: record changes to send), hooks: { add(s), remove(s), sink(s, by, how), ward(s), grant(s, p, hit), struck(victim, by, lost), eat(s, g, mult), returned(s), fix(s) } }
  function World(opts) {
    opts = opts || {};
    this.season = opts.season || null; this.S = this.season ? SEASONS[this.season] : null;
    this.h = opts.hooks || {}; this.track = !!opts.track;
    this.ships = []; this.gold = []; this.powers = []; this.isles = []; this.bolts = [];
    this.tick = 0; this.nextId = 1; this.respawns = [];
    this.segGrid = new Grid(); this.goldGrid = new Grid();
    this.goldAdded = []; this.goldRemoved = []; this.powersChanged = false; this.newBolts = [];
    this.botTarget = opts.bots === undefined ? BOTS : opts.bots;
    this.viewers = [];   // points real players are looking at (bots far from all of them think less, leaving bots wait until unseen)
    this.makeIsles(); this.spawnGold(GOLD_TARGET);
    for (let i = 0; i < POWER_TARGET; i++) this.spawnPower();
    this.namePool = NAMES.slice().sort(() => Math.random() - .5);
    for (let i = 0; i < this.botTarget; i++) { const b = this.makeShip({ kind: "bot" }); b.len = BASE_LEN + ((Math.random() * 40) | 0); this.addShip(b); }
    const rogues = 1 + ((Math.random() * 3) | 0), rp = (this.S ? this.S.rogues : ROGUE_NAMES.map(n => "☠ " + n)).slice().sort(() => Math.random() - .5);
    for (let i = 0; i < rogues; i++) { const r = this.makeShip({ name: rp[i], kind: "rogue" }); r.len = 30 + ((Math.random() * 30) | 0); this.addShip(r); }
    if (this.S) this.addShip(this.makeBoss());
  }
  const P = World.prototype;

  P.makeIsles = function () {
    const isles = this.isles = [];
    for (let i = 0; i < ISLES; i++) {
      const r = rnd(70, 190), x = rnd(400, W - 400), y = rnd(400, W - 400);
      if (isles.some(o => Math.hypot(o.x - x, o.y - y) < o.r + r + 400)) { i--; continue; }
      const pts = []; for (let k = 0; k < 14; k++) pts.push(Math.round(r * rnd(.82, 1.12)));
      isles.push({ x: Math.round(x), y: Math.round(y), r: Math.round(r), pts, trees: Array.from({ length: (r / 35) | 0 }, () => [Math.round(rnd(-.5, .5) * r), Math.round(rnd(-.5, .5) * r)]) });
    }
  };
  P.inIsle = function (x, y, pad) { return this.isles.some(o => d2(x, y, o.x, o.y) < (o.r + pad) ** 2); };   // generous circle: for spawning
  P.hitIsle = function (x, y, pad) { return hitIsle(this.isles, x, y, pad); };
  // the real, drawn sand line of an isle in the direction of (x, y): ships only run aground on sand you can see
  function coast(o, x, y) {
    let a = Math.atan2(y - o.y, x - o.x); if (a < 0) a += Math.PI * 2;
    const n = o.pts.length, f = a / (Math.PI * 2) * n, k = f | 0, t = f - k;
    return o.pts[k % n] * (1 - t) + o.pts[(k + 1) % n] * t;
  }
  function hitIsle(isles, x, y, pad) {
    for (const o of isles) { const dd = d2(x, y, o.x, o.y); if (dd > (o.r * 1.13 + pad) ** 2) continue; if (dd < (coast(o, x, y) + pad) ** 2) return o; }
    return null;
  }
  P.freeSpot = function (pad, edge = 300) { for (let t = 0; t < 60; t++) { const x = rnd(edge, W - edge), y = rnd(edge, W - edge); if (!this.inIsle(x, y, pad)) return [x, y]; } return [W / 2, W / 2]; };
  // a spot away from every real player's view, so new ships don't pop in on someone's screen
  P.quietSpot = function (pad) {
    let best = null, bestD = -1;
    for (let t = 0; t < 12; t++) { const [x, y] = this.freeSpot(pad, 700); let md = 1e18;
      for (const v of this.viewers) md = Math.min(md, d2(x, y, v.x, v.y));
      if (!this.viewers.length || md > 1500 * 1500) return [x, y]; if (md > bestD) { bestD = md; best = [x, y]; } }
    return best;
  };
  P.spawnGold = function (n, x, y, spread, big) {
    for (let i = 0; i < n; i++) {
      let gx, gy;
      if (x === undefined) { [gx, gy] = this.freeSpot(20); gx += rnd(-200, 200); gy += rnd(-200, 200); }
      else { gx = x + rnd(-spread, spread); gy = y + rnd(-spread, spread); }
      gx = clamp(gx, 30, W - 30); gy = clamp(gy, 30, W - 30); if (this.inIsle(gx, gy, 6)) continue;
      let type = big || "coin";
      if (x === undefined) { let p = Math.random() * LOOT_W; for (const [k, o] of LOOT_SPAWN) { p -= o.w; if (p <= 0) { type = k; break; } } }
      this.addLoot(type, gx, gy, x !== undefined && big ? 1 : 0);
    }
  };
  P.addLoot = function (type, x, y, glow) {
    const g = { id: this.nextId++, x, y, type, v: LOOT[type].v, t: Math.random() * 6, h: GEM_HUES[(Math.random() * 4) | 0], glow: glow ? 60 * 25 : 0 };
    this.gold.push(g); if (this.track) this.goldAdded.push(g); return g;
  };
  // a sunk ship spills its plunder along its hull: bigger ships leave bigger piles with chests and treasure
  P.dropPlunder = function (s) { this.spill(s.segs.length ? s.segs : [{ x: s.x, y: s.y }], Math.round(s.len * 3 * .8)); };
  // scatter loot worth `total` along a run of shield positions (chests for big piles)
  P.spill = function (segs, total) {
    if (!segs.length || total <= 0) return;
    let i = 0;
    const chests = Math.floor(total / 108);
    for (let c = 0; c < chests && total >= 25; c++) { const p = segs[Math.floor(Math.random() * segs.length)];
      if (!this.inIsle(p.x, p.y, 10)) { this.addLoot("chest", p.x + rnd(-10, 10), p.y + rnd(-10, 10), 1); total -= 25; } }
    const order = ["horn", "goblet", "gem", "amber", "silver", "coin"];
    let guard = 0;
    while (total > 0 && guard++ < 2000) {
      const p = segs[i++ % segs.length], room = order.filter(k => LOOT[k].v <= total);
      const k = Math.random() < .55 ? "coin" : room[Math.floor(Math.random() * room.length)] || "coin";
      const x = clamp(p.x + rnd(-14, 14), 20, W - 20), y = clamp(p.y + rnd(-14, 14), 20, W - 20);
      if (!this.inIsle(x, y, 6)) this.addLoot(k, x, y, 1); total -= LOOT[k].v;
    }
  };
  P.spawnPower = function () {
    let tot = POWERS.reduce((a, p) => a + p.w, 0), r = Math.random() * tot, p = POWERS[0];
    for (const q of POWERS) { r -= q.w; if (r <= 0) { p = q; break; } }
    const [x, y] = this.freeSpot(60);
    this.powers.push({ id: this.nextId++, x: Math.round(x), y: Math.round(y), p, life: 60 * rnd(40, 75), t: Math.random() * 6 }); this.powersChanged = true;
  };

  // o: { name, kind: "player" | "bot" | "rogue", skinId, fig, trailId, x, y, a }
  P.makeShip = function (o) {
    const kind = o.kind, sea = this.season;
    const [x, y] = o.x !== undefined ? [o.x, o.y] : kind === "bot" ? this.quietSpot(260) : this.freeSpot(260, 700), a = o.a !== undefined ? o.a : rnd(0, Math.PI * 2);
    let skinId = o.skinId, fig = o.fig, trailId = o.trailId || null, name = o.name;
    if (kind === "rogue") { skinId = skinId || (this.S ? this.S.rogueSkin : "rogue"); fig = "skull"; }
    if (kind === "bot") {
      skinId = pick(BOT_SKINS.all.concat(sea ? BOT_SKINS[sea] : []));
      fig = Math.random() < .3 ? pick(PREMIUM_FIGS) : pick(BOT_FIGS.all.concat(sea ? BOT_FIGS[sea] : []));
      trailId = Math.random() < .3 ? pick(BOT_TRAILS.all.concat(sea ? BOT_TRAILS[sea] : [])) : null;
      if (!name) { name = this.namePool.shift() || pick(NAMES); }
    }
    const s = { id: this.nextId++, name, kind, isPlayer: false, x, y, a, target: a, len: BASE_LEN, path: [], skinId, fig, trailId, alive: true, score: 0, kills: 0, peak: BASE_LEN,
                think: 0, boosting: false, fleeT: 0, buffs: {}, ward: 0, segs: [] };
    for (let i = 160; i >= 1; i--) s.path.push({ x: x - Math.cos(a) * i * PSTEP, y: y - Math.sin(a) * i * PSTEP });
    return s;
  };
  P.addShip = function (s) { this.ships.push(s); buildSegs(s); if (this.h.add) this.h.add(s); return s; };
  P.makeBoss = function () {
    const b = this.makeShip({ name: this.S.boss.name, kind: "rogue", skinId: this.S.boss.skin }); b.boss = true; b.len = this.S.boss.len; b.fig = this.S.boss.fig; return b;
  };
  P.removeShip = function (s) {   // gone for good (a bot dropping off, a player leaving): no plunder
    const i = this.ships.indexOf(s); if (i >= 0) this.ships.splice(i, 1); s.alive = false; s.gone = true;
    if (s.name && s.kind === "bot") this.namePool.push(s.name);
    if (this.h.remove) this.h.remove(s);
  };

  P.sink = function (s, by, how) {
    if (!s.alive) return;
    if (s.ward > 0 && how !== "bolt") { s.ward = 0; delete s.buffs.ward; s.invuln = 90; if (this.h.ward) this.h.ward(s); return; }
    s.alive = false;
    this.dropPlunder(s);
    if (by) by.kills++;
    if (this.h.sink) this.h.sink(s, by, how);
    if (s.kind !== "player" && !s.leaving) this.respawns.push({ at: this.tick + (s.boss ? 2700 : 240), old: s });
    if (s.leaving && s.kind === "bot") this.removeShip(s);
  };

  // keeps the number of bots at the target: extra bots quietly sail off when nobody can see them, missing ones sail in
  P.setBots = function (n) { this.botTarget = n; };
  P.balanceBots = function () {
    const bots = this.ships.filter(s => s.kind === "bot" && !s.gone), pending = this.respawns.filter(r => r.old.kind === "bot").length;
    const staying = bots.filter(s => !s.leaving).length + pending;
    if (staying > this.botTarget) {
      let extra = staying - this.botTarget;
      for (let i = this.respawns.length - 1; i >= 0 && extra > 0; i--) if (this.respawns[i].old.kind === "bot") { this.removeShip(this.respawns[i].old); this.respawns.splice(i, 1); extra--; }
      const cands = bots.filter(s => !s.leaving).map(s => ({ s, d: this.viewers.reduce((m, v) => Math.min(m, d2(s.x, s.y, v.x, v.y)), 1e18) })).sort((a, b) => b.d - a.d);
      for (let i = 0; i < extra && i < cands.length; i++) cands[i].s.leaving = true;
    } else if (staying < this.botTarget) {
      for (const s of bots) if (s.leaving && staying < this.botTarget) { s.leaving = false; return; }
      const b = this.makeShip({ kind: "bot" }); b.len = BASE_LEN + ((Math.random() * 25) | 0); this.addShip(b);
    }
    // a leaving bot disappears once no real player can see it
    for (const s of bots) if (s.leaving && s.alive && !this.viewers.some(v => d2(s.x, s.y, v.x, v.y) < 1400 * 1400)) this.removeShip(s);
  };

  /* ---------- bot brains ----------
     Every bot scores 13 possible headings and picks the safest one that still leads somewhere useful.
     Careful raiders: never chase ships, flee from anything heading at them, only boost to escape.
     Rogues: same survival instincts, but they cut in front of smaller ships and boost to do it. */
  P.danger = function (b, x, y, margin) {
    if (x < 120 || y < 120 || x > W - 120 || y > W - 120) return 3;
    for (const o of this.isles) if (d2(x, y, o.x, o.y) < (o.r + margin + 30) ** 2) return 3;
    let hit = 0;
    this.segGrid.near(x, y, margin + 30 + Math.max(0, maxR - 24), v => {
      if (v.s === b && v.i < 10) return;
      const rr = (radius(v.s) + margin) ** 2;
      if (d2(x, y, v.x, v.y) < rr) { hit = (v.s.buffs.ghost || v.s.solidify) && v.s !== b ? 0 : 2; return false; }
    });
    return hit;
  };
  P.botThink = function (b) {
    if (--b.think > 0) return;
    const far = !this.viewers.some(v => d2(b.x, b.y, v.x, v.y) < 1500 * 1500);   // nobody can see this bot: think less often, check fewer headings
    b.think = (far ? 12 : 5) + ((Math.random() * 4) | 0);
    const r = radius(b), rogue = b.kind === "rogue", ships = this.ships;
    let goal = null, why = "wander";
    let threat = null, tBest = 1e9;
    for (const o of ships) { if (o === b || !o.alive) continue; const dd = d2(o.x, o.y, b.x, b.y);
      if (dd > 380 * 380) continue;
      const toMe = Math.atan2(b.y - o.y, b.x - o.x), facing = Math.abs(angDiff(o.a, toMe)) < .7;
      if ((facing || o.kind === "rogue") && (o.len >= b.len * .7 || o.kind === "rogue") && dd < tBest) { tBest = dd; threat = o; } }
    if (threat && !rogue) { goal = Math.atan2(b.y - threat.y, b.x - threat.x); why = "flee"; b.fleeT = 50; }
    else if (rogue) {
      let prey = null, pBest = 1e9;
      for (const o of ships) { if (o === b || !o.alive || o.kind === "rogue") continue; if (o.len > b.len + 15) continue;
        const dd = d2(o.x, o.y, b.x, b.y); if (dd < 700 * 700 && dd < pBest) { pBest = dd; prey = o; } }
      if (prey) { const lead = 90 + radius(prey) * 3; goal = Math.atan2(prey.y + Math.sin(prey.a) * lead - b.y, prey.x + Math.cos(prey.a) * lead - b.x); why = "hunt"; }
    }
    if (goal === null) {
      let best = null, score = 1e9;
      this.goldGrid.near(b.x, b.y, 420, g => { const dd = d2(g.x, g.y, b.x, b.y); const s = dd / (1 + g.v * .4); if (s < score) { score = s; best = g; } });
      for (const p of this.powers) { const dd = d2(p.x, p.y, b.x, b.y); if (dd < 500 * 500 && dd * .3 < score) { score = dd * .3; best = p; } }
      if (best) { goal = Math.atan2(best.y - b.y, best.x - b.x); why = "feed"; }
      else { b.wander = (b.wander ?? b.a) + rnd(-.4, .4); goal = b.wander; }
    }
    let bestA = goal, bestScore = -1e9;
    for (let k = -6; k <= 6; k += far ? 2 : 1) {
      const a = b.a + k * .26, cost = Math.abs(angDiff(a, goal)) * 1.2 + Math.abs(k) * .05;
      let risk = 0;
      for (const dist of [r * 1.6 + 20, r * 2.4 + 55, r * 3.2 + 100, r * 4 + 160]) {
        const dg = this.danger(b, b.x + Math.cos(a) * dist, b.y + Math.sin(a) * dist, r * .9 + 10);
        risk += dg * (dist < 100 ? 6 : dist < 170 ? 3 : 1.4);
      }
      for (const o of ships) { if (o === b || !o.alive) continue; if (d2(o.x, o.y, b.x, b.y) > 300 * 300) continue;
        const px = o.x + Math.cos(o.a) * 70, py = o.y + Math.sin(o.a) * 70, qx = b.x + Math.cos(a) * 70, qy = b.y + Math.sin(a) * 70;
        if (d2(px, py, qx, qy) < (r + radius(o) + 30) ** 2) risk += rogue ? 1 : 4; }
      const sc = -risk * 10 - cost;
      if (sc > bestScore) { bestScore = sc; bestA = a; }
    }
    b.target = bestA;
    const canBoost = b.len > BASE_LEN + 6;
    b.boosting = canBoost && ((why === "flee" && tBest < 200 * 200) || (rogue && why === "hunt" && Math.random() < .5) || bestScore < -40);
  };

  P.grant = function (s, p) {
    let hit = null;
    if (p.id === "feast") s.len += 12;
    else if (p.id === "ward") { s.ward = 1; s.buffs.ward = { t: p.dur * 60, max: p.dur * 60 }; }
    else if (p.id === "mjolnir") {
      // lightning strikes the nearest rival within 600px: small ships (under 20 shields) sink,
      // bigger ships lose the back half of their shield wall, which spills into the sea as loot
      let tgt = null, best = 1e9;
      for (const o of this.ships) { if (o === s || !o.alive) continue; const dd = d2(o.x, o.y, s.x, s.y); if (dd < 600 * 600 && dd < best) { best = dd; tgt = o; } }
      if (tgt) {
        const mid = tgt.segs[Math.floor(tgt.segs.length / 2)] || tgt;
        const b = { x1: s.x, y1: s.y, x2: mid.x, y2: mid.y, t: 30 }; this.bolts.push(b); if (this.track) this.newBolts.push(b); hit = tgt;
        if (tgt.len < 20) this.sink(tgt, s, "bolt");
        else { const keep = Math.ceil(tgt.len / 2), lost = tgt.len - keep;
          this.spill(tgt.segs.slice(Math.ceil(tgt.segs.length / 2)), Math.round(lost * 3 * .8)); tgt.len = keep; buildSegs(tgt);
          if (this.h.struck) this.h.struck(tgt, s, lost); }
      }
    } else s.buffs[p.id] = { t: p.dur * 60, max: p.dur * 60 };
    if (this.h.grant) this.h.grant(s, p, hit);
  };

  // f = frames elapsed at 60fps. Ships with s.remote are steered by a real player: their position is set from outside (already checked).
  P.step = function (f) {
    const T = this, ships = this.ships;
    this.tick += f;
    this.segGrid.clear(); this.goldGrid.clear();
    for (const s of ships) if (s.alive) { const sg = s.segs; for (let j = 0; j < sg.length; j++) this.segGrid.add(sg[j].x, sg[j].y, sg[j]); }
    for (let j = 0; j < this.gold.length; j++) this.goldGrid.add(this.gold[j].x, this.gold[j].y, this.gold[j]);

    for (const s of ships) {
      if (!s.alive) continue;
      if (s.kind !== "player") this.botThink(s);
      for (const k in s.buffs) { s.buffs[k].t -= f; if (s.buffs[k].t <= 0) { delete s.buffs[k]; if (k === "ward") s.ward = 0; if (k === "ghost") s.solidify = 75; } }
      if (s.invuln) s.invuln = Math.max(0, s.invuln - f);
      if (s.solidify) s.solidify = Math.max(0, s.solidify - f);   // a ghost fading back in can't sink anyone (or be sunk) for ~1s
      if (s.boss && this.season === "halloween") { s.phase = (s.phase || 0) + f; if (s.phase > 540) { s.phase = 0; s.buffs.ghost = { t: 180, max: 180 }; } }
      if (!s.remote) moveShip(s, f);
      const free = !!s.buffs.oars;
      if (s.boosting && !free && s.len > BASE_LEN) { s.drop = (s.drop || 0) + f; if (s.drop >= 22) { s.drop = 0; s.len--; const t = s.segs[s.segs.length - 1]; if (t) this.addLoot("coin", t.x, t.y, 0); } }
      pushPath(s); buildSegs(s);
      if (s.x < 10 || s.y < 10 || s.x > W - 10 || s.y > W - 10) { this.sink(s, null, "edge"); continue; }
      if (hitIsle(this.isles, s.x, s.y, radius(s) * .15)) {
        if (s.ward || s.invuln) { s.a += Math.PI; s.target = s.a; if (s.ward) { s.ward = 0; delete s.buffs.ward; s.invuln = 90; } if (this.h.fix) this.h.fix(s); }
        else { this.sink(s, null, "rock"); continue; } }
      // gold: magnet pulls, then eat
      const r = radius(s) + 7, pull = s.buffs.magnet ? 190 : 0, mult = s.buffs.mead ? 2 : 1;
      this.goldGrid.near(s.x, s.y, Math.max(r, pull), g => {
        if (g.eaten) return; const dd = d2(g.x, g.y, s.x, s.y);
        if (pull && dd < pull * pull) { const d = Math.sqrt(dd) || 1; g.x += (s.x - g.x) / d * 3 * f; g.y += (s.y - g.y) / d * 3 * f; }
        if (dd < r * r) { g.eaten = true; s.score += g.v * mult; while (s.score >= 3) { s.score -= 3; s.len++; } if (T.h.eat) T.h.eat(s, g, mult); }
      });
      for (let i = this.powers.length - 1; i >= 0; i--) { const p = this.powers[i]; if (d2(p.x, p.y, s.x, s.y) < (r + 16) ** 2) { this.powers.splice(i, 1); this.powersChanged = true; this.grant(s, p.p); if (!s.alive) break; } }
    }
    let gw = 0; const gold = this.gold;
    for (let j = 0; j < gold.length; j++) { const g = gold[j]; if (g.eaten) { if (this.track) this.goldRemoved.push(g.id); continue; } if (g.glow) g.glow = Math.max(0, g.glow - f); gold[gw++] = g; }
    gold.length = gw;
    for (const s of ships) if (s.alive && s.len > s.peak) s.peak = s.len;
    // prow vs shields (real players get a slightly smaller prow: their screen is a moment behind the server)
    maxR = 24; for (const s of ships) if (s.alive) { const r = radius(s); if (r > maxR) maxR = r; }
    for (const s of ships) {
      if (!s.alive || s.buffs.ghost || s.invuln || s.solidify) continue;
      const rs = radius(s) * (s.remote ? .45 : .55); let hitBy = null;
      this.segGrid.near(s.x, s.y, 36 + maxR, v => { if (v.s === s || !v.s.alive || v.i === 0 || v.s.buffs.ghost || v.s.solidify) return;
        if (d2(s.x, s.y, v.x, v.y) < (radius(v.s) * .78 + rs) ** 2) { hitBy = v.s; return false; } });
      if (hitBy) this.sink(s, hitBy, "ship");
    }
    if (gold.length < GOLD_TARGET) this.spawnGold(Math.min(20, GOLD_TARGET - gold.length));
    for (let i = this.powers.length - 1; i >= 0; i--) if ((this.powers[i].life -= f) <= 0) { this.powers.splice(i, 1); this.powersChanged = true; }
    if (this.powers.length < POWER_TARGET && Math.random() < .02 * f) this.spawnPower();
    for (let i = this.bolts.length - 1; i >= 0; i--) if ((this.bolts[i].t -= f) <= 0) this.bolts.splice(i, 1);
    // sunk bots, rogues and the boss come back after a while (the boss takes longer)
    for (let i = this.respawns.length - 1; i >= 0; i--) { const r = this.respawns[i]; if (this.tick < r.at) continue; this.respawns.splice(i, 1);
      const old = r.old, idx = ships.indexOf(old);
      const n = old.boss ? this.makeBoss() : this.makeShip({ name: old.name, kind: old.kind, skinId: old.kind === "rogue" ? old.skinId : undefined });
      if (!old.boss) n.len = old.kind === "rogue" ? 25 : BASE_LEN + ((Math.random() * 15) | 0);
      if (idx >= 0) { ships.splice(idx, 1); if (this.h.remove) this.h.remove(old); } this.addShip(n); if (old.boss && this.h.returned) this.h.returned(n); }
    if (this.track || this.viewers.length) this.balanceBots();
  };

  root.LongshipSim = { W, SPEED, BOOST, TURN, BASE_LEN, BOTS, GOLD_TARGET, POWER_TARGET, PSTEP, POWERS, LOOT, LOOT_TYPES, GEM_HUES, SEASONS, MAX_SPEED,
    seasonOf, seasonAt, nextSeason, itemWindow, nextItemWindow, SEASON_DATES, PREVIEW_MS, rnd, clamp, angDiff, d2, radius, gap, segCount, buildSegs, pushPath, moveShip, hitIsle, Grid, World };
})(typeof globalThis !== "undefined" ? globalThis : this);
