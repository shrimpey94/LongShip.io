/* One Longship.io lobby: a shared sea for up to MAX_PLAYERS real players, topped up with bots to TOTAL ships.
   - The sea runs here 20 times a second using the same rules file as the game (games/longship/sim.js).
   - Each player's phone moves its own ship and reports where it is; this checks the move is possible, then the server
     decides gold, power-ups, crashes and sinkings for everyone.
   - When a player joins, one bot quietly sails off once nobody can see it; when a player leaves, a bot sails back in.
   - Lobby N only gets players once lobbies 1..N-1 are full (the game tries them in order).
   - Each player only gets updates about ships near what they're looking at. When everyone leaves, the sea stops (no cost). */
import "../games/longship/sim.js";
import { SKINS as STORE_SKINS, verifyIdToken, googleKeys, firestore } from "./store.js";
// Premium skins (bought in the Gold Runes store) are only shown to other players once the server has checked
// the player's wallet. Until then (or if they don't own it) everyone sees the starter skin instead.
const PREMIUM = new Set([...STORE_SKINS.map(s => s.id), "warband"]);   // + the recruit-10-Vikings reward skin
const Sim = globalThis.LongshipSim;

const MAX_PLAYERS = 20;   // real players per lobby (raise this when lobbies get busy)
const TOTAL = 35;         // ships in the sea: real players + bots (rogues and the seasonal boss are extra)
const TICK_MS = 50, F = 3; // 20 ticks a second, each moving the sea 3 frames (at 60fps)
const IDLE_MS = 15 * 60 * 1000;   // a seat is freed after 15 minutes on the start screen without sailing
// Who counts in the lobby number:
//   "sailing"  = has a ship out and their game sent a move in the last 10 seconds (blue dots on the map, plus you)
//   "watching" = on the start/Sunk screen with the tab open and someone touched the mouse, keys or screen in the last 3 minutes
//   anyone else (a tab left open in the background, a phone in a pocket) doesn't count at all
const SAIL_FRESH_MS = 10 * 1000, WATCH_FRESH_MS = 3 * 60 * 1000;
const AWAY_MS = 2 * 60 * 1000;    // no messages at all for 2 minutes (tab hidden or closed) and not sailing: free the seat
const ABANDON_MS = 60 * 1000;     // a ship whose game stopped sending moves for a minute is abandoned: it sinks like leaving
const BAD = /(fuck|shit|bitch|cunt|nigg|fag|dick|cock|pussy|whore|slut|rape|nazi|hitler|porn|sex)/i;
const cleanName = n => { n = String(n || "").replace(/[<>&"'`\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 14); return !n || n === "You" || BAD.test(n.replace(/[^a-z]/gi, "")) ? "Viking" : n; };
const cleanId = v => typeof v === "string" && /^[a-z0-9_]{1,20}$/i.test(v) ? v : null;
const TYPE_IDX = Object.fromEntries(Sim.LOOT_TYPES.map((k, i) => [k, i]));
const POWER_IDX = Object.fromEntries(Sim.POWERS.map((p, i) => [p.id, i]));
const r1 = v => Math.round(v * 10) / 10;

export class Lobby {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.conns = new Set(); this.world = null; this.loop = 0; this.lobbyNo = 0; this.nextConn = 1;
    this.metaAdd = []; this.metaDel = new Set(); this.victimFx = []; this.metaUpd = []; this.ticks = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.lobbyNo = Math.max(1, parseInt(url.searchParams.get("n"), 10) || 1);
    if (request.headers.get("Upgrade") !== "websocket")
      return new Response(JSON.stringify({ lobby: this.lobbyNo, players: this.conns.size, max: MAX_PLAYERS }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    const pair = new WebSocketPair(), client = pair[0], ws = pair[1];
    ws.accept();
    if (this.conns.size >= MAX_PLAYERS) { ws.send('{"t":"full"}'); ws.close(1000, "full"); return new Response(null, { status: 101, webSocket: client }); }
    this.open(ws);
    return new Response(null, { status: 101, webSocket: client });
  }

  newWorld() {
    const L = this;
    this.world = new Sim.World({ season: Sim.seasonOf(new Date()), track: true, bots: TOTAL - 1, hooks: {
      add: s => L.metaAdd.push(s),
      remove: s => L.metaDel.add(s.id),
      sink: (s, by, how) => {
        L.metaDel.add(s.id);
        if (s.conn) { L.ev(s.conn, { k: "sunk", by: by ? by.name : null, how, peak: s.peak || s.len, kills: s.kills }); s.deadAt = L.world.tick; }
        if (by && by.conn) L.ev(by.conn, { k: "kill", name: s.name, kind: s.kind, boss: !!s.boss });
        if (by && PREMIUM.has(by.skinId)) L.victimFx.push([s.id, by.skinId]);   // everyone nearby sees the god skin's victim effect
      },
      ward: s => { if (s.conn) L.ev(s.conn, { k: "ward" }); },
      struck: (v, by, lost) => { if (v.conn) L.ev(v.conn, { k: "struck", by: by ? by.name : null, lost }); },
      grant: (s, p, hit) => { if (s.conn) L.ev(s.conn, { k: "grant", p: POWER_IDX[p.id], hit: !!hit }); },
      eat: (s, g, mult) => { if (s.conn) (s.conn.eat || (s.conn.eat = [])).push(g.v * mult); },
      returned: n => { for (const c of L.conns) L.ev(c, { k: "returned", name: n.name }); },
      fix: s => { if (s.conn) L.ev(s.conn, { k: "fix", x: r1(s.x), y: r1(s.y), a: Math.round(s.a * 1000) / 1000 }); },
    } });
    this.metaAdd = []; this.metaDel.clear(); this.victimFx = []; this.metaUpd = [];
  }

  open(ws) {
    if (!this.world) this.newWorld();
    const c = { id: this.nextConn++, ws, name: "Viking", look: {}, ship: null, cam: { x: Sim.W / 2, y: Sim.W / 2 }, view: 1600, segKnown: new Set(),
                lastIn: 0, msgs: 0, msgWin: Date.now(), active: Date.now(), lastMsg: Date.now(), lastHere: 0, status: "away", ev: [], eat: null };
    this.conns.add(c);
    this.world.setBots(this.botTarget());
    ws.addEventListener("message", e => this.onMsg(c, e.data));
    ws.addEventListener("close", () => this.drop(c));
    ws.addEventListener("error", () => this.drop(c));
    // send the whole sea once
    const w = this.world, bot = w.ships.find(s => s.alive && s.kind === "bot");
    if (bot) c.cam = { x: bot.x, y: bot.y };
    this.countPlayers();
    this.send(c, { t: "init", lobby: this.lobbyNo, max: MAX_PLAYERS, season: w.season, pc: this.sailing, pv: this.watching,
      isles: w.isles.map(o => [o.x, o.y, o.r, o.pts, o.trees]),
      gold: w.gold.map(g => this.goldMsg(g)), pw: this.powersMsg(),
      meta: w.ships.filter(s => s.alive).map(s => this.metaMsg(s)),
      pos: w.ships.filter(s => s.alive).map(s => [s.id, Math.round(s.x), Math.round(s.y), Math.round(s.a * 100), s.len]) });
    this.broadcastCount = true;
    if (!this.loop) this.loop = setInterval(() => this.tick(), TICK_MS);
  }

  // sailing / watching counts (see the top of this file); flags a broadcast when they change
  countPlayers() {
    const now = Date.now(); let sail = 0, watch = 0;
    for (const c of this.conns) {
      const s = c.ship;
      c.status = s && s.alive && now - (s.lastMoveAt || 0) < SAIL_FRESH_MS ? "sail"
        : !(s && s.alive) && now - c.lastMsg < SAIL_FRESH_MS && now - c.lastHere < WATCH_FRESH_MS ? "watch" : "away";
      if (c.status === "sail") sail++; else if (c.status === "watch") watch++;
    }
    if (sail !== this.sailing || watch !== this.watching) { this.sailing = sail; this.watching = watch; this.broadcastCount = true; }
  }

  botTarget() { return Math.max(TOTAL - MAX_PLAYERS, TOTAL - this.conns.size); }

  drop(c) {
    if (!this.conns.has(c)) return;
    this.conns.delete(c);
    if (c.ship && c.ship.alive) this.world.sink(c.ship, null, "left");   // leaving mid-voyage spills your plunder like a sinking
    if (c.ship) c.ship.conn = null;
    if (!this.conns.size) { clearInterval(this.loop); this.loop = 0; this.world = null; this.sailing = this.watching = 0; return; }   // nobody here: stop the sea
    this.world.setBots(this.botTarget());
    this.countPlayers(); this.broadcastCount = true;
  }

  onMsg(c, raw) {
    const now = Date.now();
    if (now - c.msgWin > 1000) { c.msgWin = now; c.msgs = 0; }
    if (++c.msgs > 40 || typeof raw !== "string" || raw.length > 2000) return;   // flood guard
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    c.lastMsg = now;
    if (m.t === "here" || m.t === "sail") c.lastHere = now;   // a real person touched the game
    if (m.t === "hello" || m.t === "sail") {
      if (m.name !== undefined) c.name = cleanName(m.name);
      c.wantSkin = cleanId(m.skin) || "fjord";
      c.look = { skinId: this.allowedSkin(c), fig: cleanId(m.fig) || "dragon", trailId: cleanId(m.trail) };
      if (PREMIUM.has(c.wantSkin) && typeof m.tok === "string" && m.tok.length < 4000) this.checkWallet(c, m.tok);
      if (m.t === "sail") { c.active = now; this.spawn(c); }
    } else if (m.t === "in") {
      if (Number.isFinite(m.cx) && Number.isFinite(m.cy)) c.cam = { x: Sim.clamp(m.cx, 0, Sim.W), y: Sim.clamp(m.cy, 0, Sim.W) };
      if (Number.isFinite(m.v)) c.view = Sim.clamp(m.v, 500, 2600);
      if (c.ship && c.ship.alive && Number.isFinite(m.x) && Number.isFinite(m.y)) { c.active = now; this.applyMove(c, m, now); }
    } else if (m.t === "ping") this.send(c, { t: "pong", c: m.c });
  }

  // premium skin? only if this player's wallet (checked by the server) owns it
  allowedSkin(c) { return !PREMIUM.has(c.wantSkin) || (c.owned && c.owned.has(c.wantSkin)) ? c.wantSkin : "fjord"; }
  async checkWallet(c, tok) {
    const now = Date.now();
    if (c.checking || (c.owned && c.owned.has(c.wantSkin)) || now - (c.checkedAt || 0) < 15000) return;   // at most every 15s per player
    c.checking = true; c.checkedAt = now;
    try {
      const me = await verifyIdToken(tok, await googleKeys());
      const w = await firestore(this.env).get("wallets/" + me.uid);
      c.owned = new Set(w.data.owned || []);
    } catch (e) { c.owned = c.owned || new Set(); }
    c.checking = false;
    const id = this.allowedSkin(c); c.look.skinId = id;
    const s = c.ship;
    if (s && s.alive && s.skinId !== id && this.world) { s.skinId = id; this.metaUpd.push([s.id, id]); }   // swap the look on everyone's screen
  }

  spawn(c) {
    const w = this.world;
    if (c.ship && c.ship.alive) return;
    if (c.ship && !c.ship.gone) w.removeShip(c.ship);
    // somewhere clear: no other ship within 500px
    let x = Sim.W / 2, y = Sim.W / 2;
    for (let t = 0; t < 40; t++) { [x, y] = w.freeSpot(260, 700); if (!w.ships.some(s => s.alive && Sim.d2(s.x, s.y, x, y) < 500 * 500)) break; }
    const a = Math.random() * Math.PI * 2;
    const s = w.makeShip(Object.assign({ name: c.name, kind: "player", x, y, a }, c.look));
    s.remote = true; s.human = true; s.conn = c; c.ship = s; s.lastMoveAt = Date.now(); c.segKnown.clear();
    w.addShip(s);
    this.ev(c, { k: "you", id: s.id, name: s.name, x: r1(x), y: r1(y), a: Math.round(a * 1000) / 1000 });
  }

  // the phone says where its ship is; accept it if a ship could really have sailed there
  applyMove(c, m, now) {
    const s = c.ship, frames = Sim.clamp((now - (s.lastMoveAt || now)) / (1000 / 60), 1, 40);
    s.lastMoveAt = now;
    const dx = m.x - s.x, dy = m.y - s.y, d = Math.hypot(dx, dy), maxD = Sim.MAX_SPEED * frames * 1.4 + 12;
    if (d > maxD) { s.x += dx / d * maxD; s.y += dy / d * maxD; c.needFix = true; }
    else { s.x = m.x; s.y = m.y; }
    if (Number.isFinite(m.a)) { s.a = m.a; s.target = m.a; }
    s.boosting = !!m.b;
  }

  tick() {
    const w = this.world; if (!w) return;
    this.ticks++;
    const now = Date.now();
    w.viewers = [];
    for (const c of this.conns) w.viewers.push(c.ship && c.ship.alive ? c.ship : c.cam);
    w.step(F);
    // sunk players' wrecks leave the sea after a moment; long-idle seats are freed for someone else
    for (const s of w.ships.slice()) if (s.kind === "player" && !s.alive && !s.gone && w.tick > (s.deadAt || 0) + 120) w.removeShip(s);
    for (const c of this.conns) {
      // a ship whose game went quiet (tab hidden, phone locked, closed without a goodbye) is abandoned after a minute
      if (c.ship && c.ship.alive && now - (c.ship.lastMoveAt || now) > ABANDON_MS) w.sink(c.ship, null, "left");
      if (c.needFix && c.ship && c.ship.alive) { c.needFix = false; this.ev(c, { k: "fix", x: r1(c.ship.x), y: r1(c.ship.y), a: Math.round(c.ship.a * 1000) / 1000 }); }
      if (c.eat) { this.ev(c, { k: "eat", v: c.eat }); c.eat = null; }
      if (!(c.ship && c.ship.alive) && (now - c.active > IDLE_MS || now - c.lastMsg > AWAY_MS)) { this.ev(c, { k: "kick" }); this.flush(c, {}); try { c.ws.close(1000, "idle"); } catch (e) {} this.drop(c); }
    }
    if (this.ticks % 20 === 0 && this.world) this.countPlayers();   // once a second
    if (!this.world) return;
    this.broadcast();
    w.goldAdded.length = 0; w.goldRemoved.length = 0; w.powersChanged = false; w.newBolts.length = 0;
    this.metaAdd = []; this.metaDel.clear(); this.victimFx = []; this.metaUpd = []; this.broadcastCount = false;
  }

  broadcast() {
    const w = this.world, far = this.ticks % 10 === 0;
    const shared = {};
    const added = this.metaAdd.filter(s => s.alive);
    if (added.length) shared.ma = added.map(s => this.metaMsg(s));
    if (this.victimFx.length) shared.vx = this.victimFx;   // before md: the browser snapshots the wreck, then removes it
    if (this.metaUpd.length) shared.mu = this.metaUpd;
    if (this.metaDel.size) shared.md = [...this.metaDel];
    if (w.goldAdded.length) shared.ga = w.goldAdded.filter(g => !g.eaten).map(g => this.goldMsg(g));
    if (w.goldRemoved.length) shared.gd = w.goldRemoved.slice();
    if (w.powersChanged) shared.pw = this.powersMsg();
    if (w.newBolts.length) shared.bo = w.newBolts.map(b => [Math.round(b.x1), Math.round(b.y1), Math.round(b.x2), Math.round(b.y2)]);
    if (this.broadcastCount) { shared.pc = this.sailing || 0; shared.pv = this.watching || 0; }
    if (far) shared.f = w.ships.filter(s => s.alive).map(s => [s.id, Math.round(s.x), Math.round(s.y), s.len]);
    for (const c of this.conns) this.flush(c, shared);
  }

  flush(c, shared) {
    const w = this.world; if (!w) return;
    const me = c.ship && c.ship.alive ? c.ship : null, cx = me ? me.x : c.cam.x, cy = me ? me.y : c.cam.y, v = c.view + 350;
    const msg = Object.assign({ t: "s" }, shared), n = [], seg = {};
    if (msg.pv !== undefined && c.status === "watch") msg.pv--;   // "watching" means other people, not you
    let anySeg = false;
    for (const s of w.ships) {
      if (!s.alive) { c.segKnown.delete(s.id); continue; }
      if (s.bx1 < cx - v || s.bx0 > cx + v || s.by1 < cy - v || s.by0 > cy + v) { c.segKnown.delete(s.id); continue; }
      n.push([s.id, r1(s.x), r1(s.y), Math.round(s.a * 100), s.len, this.flags(s)]);
      if (s !== me && !c.segKnown.has(s.id)) { c.segKnown.add(s.id); const a = []; for (const p of s.segs) a.push(Math.round(p.x), Math.round(p.y)); seg[s.id] = a; anySeg = true; }
    }
    if (n.length) msg.n = n;
    if (anySeg) msg.seg = seg;
    if (me) { const b = {}; for (const k in me.buffs) b[k] = [Math.round(me.buffs[k].t), me.buffs[k].max];
      msg.me = { len: me.len, peak: me.peak, kills: me.kills, ward: me.ward || 0, inv: Math.round(me.invuln || 0), b }; }
    if (c.ev.length) { msg.ev = c.ev; c.ev = []; }
    this.send(c, msg);
  }

  flags(s) { return (s.boosting ? 1 : 0) | (s.buffs.ghost ? 2 : 0) | (s.solidify ? 4 : 0) | (s.ward || s.invuln ? 8 : 0) | (s.buffs.magnet ? 16 : 0) | (s.buffs.oars ? 32 : 0); }
  metaMsg(s) { return [s.id, s.name, s.kind, s.skinId, s.fig, s.trailId, s.boss ? 1 : 0, s.human ? 1 : 0]; }
  goldMsg(g) { return [g.id, Math.round(g.x), Math.round(g.y), TYPE_IDX[g.type], Sim.GEM_HUES.indexOf(g.h), g.glow ? 1 : 0]; }
  powersMsg() { return this.world.powers.map(p => [p.id, p.x, p.y, POWER_IDX[p.p.id], Math.round(p.life)]); }
  ev(c, e) { c.ev.push(e); }
  send(c, m) { try { c.ws.send(JSON.stringify(m)); } catch (e) {} }
}
