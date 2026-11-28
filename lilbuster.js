/* Lil Buster: the stream bot. Loaded only by index.html?lilbuster=1 (normal players never get this file).
   He sails the REAL online sea like a decent (not perfect) player, respawns forever, and takes orders from Twitch chat:
     !hunt  go after a smaller ship      !flee  run from the big ones
     !gold  go loot hunting              !boost row hard for a few seconds
   Add &twitch=<channel> to read that channel's chat (read-only, no login). Use &noscore=1 so he never posts scores. */
(() => {
  const G = window.__lb, Sim = G.Sim, W = Sim.W || 8000;
  const QS = new URLSearchParams(location.search), CHANNEL = (QS.get("twitch") || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
  const NAME = "Lil Buster🤖";
  const CHALLENGE_URL = "busterrdust.com/sink";
  const $ = id => document.getElementById(id);
  const ang = (a, b) => Sim.angDiff(a, b);
  const d2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;

  /* ---------- stream overlay ---------- */
  const css = document.createElement("style");
  css.textContent = `
  #start,#over,#zapBtn,#toast,.joy,#joy{display:none!important}
  .lbx{position:fixed;z-index:50;font-family:system-ui,sans-serif;color:#fff;text-shadow:0 2px 6px #000,0 0 2px #000;pointer-events:none}
  #lbTop{left:24px;top:20px;background:rgba(8,20,36,.72);border:3px solid #ffc94a;border-radius:18px;padding:14px 22px}
  #lbTop b{display:block;font:900 30px system-ui;color:#ffc94a}
  #lbTop span{font:900 44px system-ui}
  #lbTop small{display:block;font:700 18px system-ui;opacity:.85;margin-top:4px}
  #lbSide{right:24px;top:250px;width:380px;background:rgba(8,20,36,.72);border:2px solid #4fc3f7;border-radius:16px;padding:14px 18px;font:700 20px system-ui}
  #lbSide h3{margin:0 0 6px;font:900 22px system-ui;color:#4fc3f7}
  #lbSide code{background:#ffc94a;color:#14243a;border-radius:6px;padding:1px 7px;font:900 19px system-ui;text-shadow:none;margin-right:4px}
  #lbFeed div{margin-top:6px;font:700 19px system-ui;animation:lbIn .3s}
  #lbPoll{left:50%;bottom:24px;transform:translateX(-50%);width:520px;background:rgba(8,20,36,.82);border:3px solid #ffc94a;border-radius:16px;padding:12px 18px;font:800 24px system-ui;display:none}
  #lbPoll h3{margin:0 0 6px;font:900 24px system-ui;color:#ffc94a}#lbPoll h3 span{float:right;color:#fff}
  #lbPoll code{background:#ffc94a;color:#14243a;border-radius:6px;padding:0 9px;margin-right:8px;text-shadow:none}#lbPoll b{float:right;color:#4fc3f7}
  #lbPoll small{display:block;margin-top:6px;font:700 17px system-ui;opacity:.8}
  #lbStats{left:24px;bottom:24px;background:rgba(8,20,36,.72);border-radius:14px;padding:12px 18px;font:800 22px system-ui;line-height:1.45}
  #lbStats em{font-style:normal;color:#ffc94a}
  #lbMode{left:50%;top:200px;transform:translateX(-50%);font:900 30px system-ui;background:rgba(8,20,36,.6);border-radius:14px;padding:6px 18px}
  #lbBig{left:50%;top:40%;transform:translate(-50%,-50%);font:900 64px system-ui;text-align:center;opacity:0;transition:opacity .25s}
  #lbBig.on{opacity:1}
  #lbBig small{display:block;font:800 30px system-ui;color:#ffc94a}
  @keyframes lbIn{from{opacity:0;transform:translateX(30px)}to{opacity:1;transform:none}}`;
  document.head.appendChild(css);
  const box = (id, html) => { const d = document.createElement("div"); d.id = id; d.className = "lbx"; d.innerHTML = html; document.body.appendChild(d); return d; };
  box("lbTop", `<b>🤖 LIL BUSTER · SINK THE BOT</b><span>JOIN HIS SEA</span><small>Daily, 1–11 PM Eastern · ${CHALLENGE_URL}</small><small>Watch &amp; chat: twitch.tv/Busterrdust · Free, no download</small>`);
  box("lbSide", `<h3>Boss him around in chat</h3><div><code>!hunt</code><code>!flee</code><code>!gold</code><code>!boost</code></div><div style="font:700 16px system-ui;opacity:.85;margin-top:4px">Plus chat votes every few minutes</div><div id="lbFeed"></div>`);
  const stats = box("lbStats", ""), modeEl = box("lbMode", ""), big = box("lbBig", "");
  const feed = $("lbFeed");
  function say(html) { const d = document.createElement("div"); d.innerHTML = html; feed.prepend(d); while (feed.children.length > 6) feed.lastChild.remove(); }
  let bigT = 0;
  function shout(a, b) { big.innerHTML = a + (b ? `<small>${b}</small>` : ""); big.classList.add("on"); clearTimeout(bigT); bigT = setTimeout(() => big.classList.remove("on"), 4500); }
  const esc = t => String(t).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  /* ---------- his voice ----------
     OBS's browser won't let this page call the PC directly, so each line goes into OBS's log as "LBSAY {...}".
     The helper on the streaming PC (scripts/lil-buster/lilbuster_voice.py) reads it, makes the speech with the
     Kokoro voices, and the "Lil Buster Voice" browser source (http://127.0.0.1:8765/voice) plays it on stream.
     If the helper isn't running he just stays quiet. */
  const pick = a => a[Math.floor(Math.random() * a.length)];
  let lastTalk = 0;
  const mark = (kind, o) => { try { console.error(kind + " " + JSON.stringify(Object.assign({ t: Date.now() }, o))); } catch (e) {} };
  function talk(text, urgent) {
    const now = performance.now();
    if (!urgent && now - lastTalk < 6000) return;            // don't talk over himself all the time
    lastTalk = now; mark("LBSAY", { text: String(text).slice(0, 240), u: urgent ? 1 : 0 });
  }
  const sayName = n => String(n || "").replace(/[_\d]+$/, "").replace(/_/g, " ").slice(0, 20) || "matey";
  const LINES = {
    greet: ["Ahoy {n}! Welcome aboard. Type hunt and I'll go wreck somebody.", "Oh look, {n} showed up! Bow before Lil Buster!",
            "{n}! Finally, someone with taste. Type a command, I dare you.", "Welcome, {n}! Think you can sink me? Come try."],
    hunt: ["Hunting time! {n} wants blood!", "Fine, {n}, I'll go wreck someone. Watch and learn.", "You got it, {n}. Nobody is safe!"],
    flee: ["Run away?! Ugh, fine, {n}. Tactical retreat!", "{n} says flee. I'm not scared, I'm just... fast.", "Okay okay, {n}, I'm running!"],
    gold: ["Treasure! {n} knows what I like.", "Gold hunting for {n}. Shiny!", "Money money money! Thanks, {n}."],
    boost: ["Full speed! Hold on, {n}!", "Rowing hard for {n}!", "Ka-chow! That one's for {n}."],
    sunkHuman: ["Nooo! {n}, I will remember this!", "{n} got me! Lucky shot. Total luck.", "Okay {n}, you got me. Rematch. Right now.",
                "Ugh! {n} sank me! Everybody saw nothing!"],
    sunkOther: ["Who put that there?!", "I meant to do that.", "Nope. Didn't happen. Respawning.", "That ship came out of nowhere!", "Ouch. Okay. Again!"],
    rock: ["A rock! Who put a rock in the ocean?!", "That rock has it out for me."], edge: ["The edge of the world! I found it. Ow."],
    killHuman: ["Get wrecked, {n}!", "Sorry {n}! Not sorry.", "Ha! {n} thought they could take me!", "{n} is now fish food!"],
    joinSea: ["A challenger! {n} just joined my sea.", "{n} is in my waters. Brave. Very brave.", "Uh oh, {n} is here. Come get me!"],
    pollStart: ["Vote time! What should I do next? Type one, two, or three.", "Chat, you're the captain. Vote one, two, or three!"],
    pollWin: ["Chat has spoken: {o}!", "{o} it is! Let's go!", "You heard them: {o}!"],
    lurkers: ["If you just showed up: type exclamation hunt and I'll go after someone. Or join my sea and sink me yourself!"],
  };
  const line = (k, n, o) => pick(LINES[k]).replace(/\{n\}/g, sayName(n)).replace(/\{o\}/g, o || "");

  /* ---------- clips for the daily video (OBS Replay Buffer) ----------
     In OBS, the Browser source needs Page permissions = "Basic access to OBS" and the Replay Buffer turned on.
     When he sinks (or sinks a real player), OBS saves the last 30 s and we write one LBCLIP line to the OBS log
     so the nightly script knows who/what was in that clip. */
  const OBS = window.obsstudio;
  let lastClip = 0;
  /* Watchdog (needs the Browser source's Page permissions = "Full access to OBS"):
     every minute, during his live hours, if the stream dropped (Wi-Fi blip) start it again,
     and make sure the Replay Buffer is running so clips actually get saved. */
  let lastRestart = 0;
  const liveNow = () => { const d = new Date(), m = d.getHours() * 60 + d.getMinutes();
    return (m >= 5 * 60 + 3 && m < 10 * 60 + 57) || (m >= 13 * 60 + 3 && m < 22 * 60 + 57); };   // stays clear of the 5/11/1/11 switch-overs
  function keepReplay() {
    try {
      if (!OBS) return;
      if (OBS.getStatus) OBS.getStatus(st => {
        if (!st) return;
        if (!st.streaming && liveNow() && OBS.startStreaming && Date.now() - lastRestart > 150000) {
          lastRestart = Date.now(); console.error("LBWATCH stream was down, starting it again"); OBS.startStreaming();
        }
        if (!st.replaybuffer && OBS.startReplayBuffer) OBS.startReplayBuffer();
      });
      else if (OBS.startReplayBuffer) OBS.startReplayBuffer();
    } catch (e) {}
  }
  setTimeout(keepReplay, 8000); setInterval(keepReplay, 60000);
  /* Twitch Clip on the channel when a real player is involved (the voice helper on this PC holds the Twitch key).
     Only real-player moments, so the Clips tab stays worth watching; the helper also spaces them 90 s apart. */
  function twitchClip(info) {
    if (!info.human || !info.by) return;
    const title = info.kind === "kill" ? `Lil Buster sank ${info.by} ⚔️` : `${info.by} sank Lil Buster 💀`;
    setTimeout(() => mark("LBTWITCH", { title }), 3000);
  }
  function clip(info) {
    twitchClip(info);
    const now = Date.now(); if (!OBS || !OBS.saveReplayBuffer || now - lastClip < 20000) return;
    lastClip = now;
    setTimeout(() => {   // a moment later, so the sinking itself is in the clip
      try { console.error("LBCLIP " + JSON.stringify(Object.assign({ t: Date.now() }, info))); OBS.saveReplayBuffer(); } catch (e) {}
    }, 2500);
  }

  /* ---------- today's numbers ---------- */
  const day = () => new Date().toDateString();
  let S = { day: day(), best: 0, sunk: 0, sinks: 0, by: "", sailingFor: "" };
  try { const o = JSON.parse(localStorage.getItem("lb_stats") || "{}"); if (o.day === S.day) S = Object.assign(S, o); } catch (e) {}
  const save = () => { try { localStorage.setItem("lb_stats", JSON.stringify(S)); } catch (e) {} };

  G.onSunk = r => {
    if (S.day !== day()) S = { day: day(), best: 0, sunk: 0, sinks: 0, by: "", sailingFor: S.sailingFor };
    S.sunk++; S.best = Math.max(S.best, r.peak || 0);
    const by = r.by && String(r.by);
    const human = by && G.ships.some(s => s.name === by && s.human);
    if (human) { S.by = by; shout(`💀 ${esc(by)} SANK LIL BUSTER!`, `Join the sea 👉 ${CHALLENGE_URL}`); say(`💀 <b>${esc(by)}</b> sank Lil Buster!`); talk(line("sunkHuman", by), true); }
    else if (Math.random() < .5) talk(line(r.how === "rock" ? "rock" : r.how === "edge" ? "edge" : "sunkOther"));
    if (!human) say(r.how === "rock" ? "🪨 Lil Buster hit a rock. Classic." : r.how === "edge" ? "🌊 Lil Buster sailed off the map 😭" : `💥 Lil Buster crashed into ${esc(by || "a ship")}`);
    save(); respawnAt = performance.now() + 3500;
    clip({ kind: "sunk", by: by || "", human: !!human, how: r.how || "", peak: r.peak || 0 });
  };
  G.onKill = v => { S.sinks++; save(); if (v.human || v.kind === "player") {   // online the server says kind "player" for real people
    shout(`⚔️ Lil Buster sank ${esc(v.name)}!`, `Revenge? 👉 ${CHALLENGE_URL}`); say(`⚔️ Lil Buster sank <b>${esc(v.name)}</b>`); talk(line("killHuman", v.name), true);
    clip({ kind: "kill", by: v.name || "", human: true, how: "", peak: (G.player && G.player.len) || 0 }); } };
  G.onJoin = s => { if (s.name === NAME) return; shout(`⚔️ ${esc(s.name)} joined the sea!`, "Get him!"); say(`⛵ <b>${esc(s.name)}</b> joined the sea`); talk(line("joinSea", s.name), true); };

  /* ---------- Twitch chat (read-only, anonymous) ---------- */
  const MODES = { hunt: "🗡️ HUNTING", flee: "🏃 RUNNING AWAY", gold: "💰 LOOT HUNTING", boost: "💨 ROWING HARD", explore: "🧭 EXPLORING" };
  let order = null, orderUntil = 0, boostUntil = 0;
  const lastBy = new Map(), seen = new Set();
  function command(user, cmd) {
    const now = performance.now();
    if ((lastBy.get(user) || 0) > now - 8000) return;      // one order per person every 8 seconds
    lastBy.set(user, now);
    if (cmd === "boost") { boostUntil = now + 3000; }
    else { order = cmd; orderUntil = now + 20000; }
    S.sailingFor = user; save();
    say(`📣 <b>${esc(user)}</b> says <b>${cmd.toUpperCase()}</b>!`);
    talk(line(cmd, user), true);   // chat bossing him around always gets a reaction
  }
  // greetings: by name when someone first chats (Twitch also "joins" lots of lurker bots, so joins only get a no-name hello now and then)
  const toGreet = []; let lastGreet = 0, lastLurk = 0;
  setInterval(() => {
    const now = performance.now();
    if (toGreet.length && now - lastGreet > 15000) { lastGreet = now; talk(line("greet", toGreet.shift()), true); toGreet.length = Math.min(toGreet.length, 2); }
  }, 2000);

  /* ---------- chat votes: every few minutes chat picks his next move ---------- */
  const POLL_OPTS = [["hunt", "Hunt the biggest ship"], ["gold", "Treasure hunt"], ["flee", "Run and hide"], ["boost", "Speed demon"], ["explore", "Sail to a far corner"]];
  const pollBox = box("lbPoll", "");
  let poll = null, nextPoll = performance.now() + 90000;
  function startPoll() {
    const opts = POLL_OPTS.slice().sort(() => Math.random() - .5).slice(0, 3);
    poll = { opts, votes: new Map(), until: performance.now() + 40000 };
    talk(line("pollStart"), true); drawPoll();
  }
  function drawPoll() {
    if (!poll) { pollBox.style.display = "none"; return; }
    const n = [0, 0, 0]; poll.votes.forEach(v => n[v]++);
    const left = Math.max(0, Math.ceil((poll.until - performance.now()) / 1000));
    pollBox.style.display = "block";
    pollBox.innerHTML = `<h3>🗳️ What should Lil Buster do next? <span>${left}s</span></h3>` +
      poll.opts.map((o, i) => `<div><code>${i + 1}</code> ${o[1]} <b>${n[i]}</b></div>`).join("") + `<small>Type 1, 2 or 3 in chat</small>`;
  }
  function endPoll() {
    const n = [0, 0, 0]; poll.votes.forEach(v => n[v]++);
    const total = n[0] + n[1] + n[2];
    if (total) {
      const w = n.indexOf(Math.max(...n)), [cmd, label] = poll.opts[w];
      if (cmd === "boost") boostUntil = performance.now() + 6000; else { order = cmd; orderUntil = performance.now() + 30000; if (cmd === "explore") exploreAt = null; }
      say(`🗳️ Chat voted: <b>${label}</b> (${n[w]} vote${n[w] > 1 ? "s" : ""})`); talk(line("pollWin", null, label), true);
    }
    poll = null; drawPoll(); nextPoll = performance.now() + 150000 + Math.random() * 60000;
  }
  setInterval(() => {
    const now = performance.now();
    if (poll) { if (now > poll.until) endPoll(); else drawPoll(); return; }
    if (now > nextPoll && !(order && now < orderUntil)) startPoll();
  }, 1000);
  let exploreAt = null;
  function chat(user, text) {
    if (!seen.has(user)) { seen.add(user); say(`👋 Welcome aboard, <b>${esc(user)}</b>!`); toGreet.push(user); }
    const v = /^!?\s*([123])\s*$/.exec(text.trim());
    if (v && poll) { poll.votes.set(user, +v[1] - 1); drawPoll(); return; }
    const m = /^!(hunt|flee|gold|boost)\b/i.exec(text.trim()); if (m) command(user, m[1].toLowerCase());
  }
  function twitch() {
    if (!CHANNEL) return;
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    ws.onopen = () => { ws.send("CAP REQ :twitch.tv/tags twitch.tv/membership"); ws.send("PASS SCHMOOPIIE"); ws.send("NICK justinfan" + (10000 + Math.floor(Math.random() * 80000))); ws.send("JOIN #" + CHANNEL); };
    ws.onmessage = e => String(e.data).split("\r\n").forEach(line => {
      if (line.startsWith("PING")) { ws.send("PONG :tmi.twitch.tv"); return; }
      if (/ JOIN #/.test(line)) { const now = performance.now(); if (now - lastLurk > 240000 && !/justinfan/i.test(line)) { lastLurk = now; setTimeout(() => talk(LINES.lurkers[0]), 4000); } return; }
      const m = /^(?:@(\S+) )?:(\w+)!\S+ PRIVMSG #\w+ :(.*)$/.exec(line); if (!m) return;
      const dn = /(?:^|;)display-name=([^;]*)/.exec(m[1] || ""); chat((dn && dn[1]) || m[2], m[3]);
    });
    ws.onclose = () => setTimeout(twitch, 5000);   // chat dropped: reconnect
  }
  twitch();

  /* ---------- the brain ---------- */
  const hand = { a: 0, set: null, ph: Math.random() * 6 };
  let respawnAt = performance.now() + 4000, mood = "gold", moodUntil = 0, goal = null, lastGoal = 0;
  const skip = new WeakSet();                 // loot he gave up on (couldn't reach it)
  let chaseObj = null, chaseSince = 0, spin = 0, lastA = null, straightUntil = 0, escape = null;
  const trail = [];                          // where he's been over the last few seconds (to catch going in circles)
  const TURN_R = (Sim.SPEED || 1.15) / (Sim.TURN || .045);   // his turning circle: a goal inside it can only be orbited
  const shipR = s => 14 + Math.min(24, (s.len || 10) / 10);

  // how far we can sail along heading a before hitting a shield, a rock or the edge (up to `max`)
  function clear(P, a, max) {
    const cx = Math.cos(a), cy = Math.sin(a), me = shipR(P);
    let best = max;
    const hx = P.x, hy = P.y;
    // world edge
    const tx = cx > 0 ? (W - 60 - hx) / cx : cx < 0 ? (60 - hx) / cx : 1e9, ty = cy > 0 ? (W - 60 - hy) / cy : cy < 0 ? (60 - hy) / cy : 1e9;
    best = Math.min(best, tx, ty);
    for (const o of G.isles) {   // rocks (generous circles)
      const ox = o.x - hx, oy = o.y - hy, along = ox * cx + oy * cy; if (along < -o.r || along > best + o.r) continue;
      const side = Math.abs(ox * cy - oy * cx), rr = o.r * 1.05 + me; if (side < rr) best = Math.min(best, Math.max(0, along - Math.sqrt(rr * rr - side * side)));
    }
    for (const s of G.ships) {   // everyone else's shields
      if (s === P || !s.alive || s.hidden || !s.segs) continue;
      if (d2(s.x, s.y, hx, hy) > (max + 400) ** 2) continue;
      const rr = shipR(s) + me * .6;
      for (let i = 0; i < s.segs.length; i += 2) { const g = s.segs[i];
        const ox = g.x - hx, oy = g.y - hy, along = ox * cx + oy * cy; if (along < 0 || along > best) continue;
        if (Math.abs(ox * cy - oy * cx) < rr) best = Math.min(best, along); }
      // their prow is about to move: treat the water just ahead of a ship's head as taken too
      const px = s.x + Math.cos(s.a) * 70 - hx, py = s.y + Math.sin(s.a) * 70 - hy, al = px * cx + py * cy;
      if (al > 0 && al < best && Math.abs(px * cy - py * cx) < rr + 20) best = Math.min(best, al);
    }
    return best;
  }

  function pickGoal(P, now) {
    const want = (order && now < orderUntil) ? order : mood;
    if (want === "explore") {   // chat sent him to a far corner of the map
      if (!exploreAt || d2(exploreAt.x, exploreAt.y, P.x, P.y) < 300 * 300) exploreAt = { x: (P.x < W / 2 ? W * .82 : W * .18) + (Math.random() - .5) * 600, y: (P.y < W / 2 ? W * .82 : W * .18) + (Math.random() - .5) * 600 };
      return { x: exploreAt.x, y: exploreAt.y, kind: "wander" };
    }
    if (want === "hunt") {   // a smaller ship to cut off: aim in front of its prow
      let T = null, bd = 1e18;
      for (const s of G.ships) { if (s === P || !s.alive || s.hidden || s.len >= P.len * .9) continue; const dd = d2(s.x, s.y, P.x, P.y); if (dd < 900 * 900 && dd < bd) { bd = dd; T = s; } }
      if (T) return { x: T.x + Math.cos(T.a) * 150, y: T.y + Math.sin(T.a) * 150, kind: "hunt", boost: bd < 320 * 320 };
    }
    if (want === "flee") {   // away from the biggest ship nearby
      let T = null; for (const s of G.ships) { if (s === P || !s.alive || s.hidden) continue; if (d2(s.x, s.y, P.x, P.y) < 900 * 900 && (!T || s.len > T.len)) T = s; }
      if (T) { const a = Math.atan2(P.y - T.y, P.x - T.x); return { x: P.x + Math.cos(a) * 600, y: P.y + Math.sin(a) * 600, kind: "flee", boost: d2(T.x, T.y, P.x, P.y) < 300 * 300 }; }
    }
    // loot: best value per distance, a bit biased to what's ahead (people don't U-turn for one coin)
    let g = null, bs = 0;
    for (const o of G.gold) { if (o.eaten || o.hidden || skip.has(o)) continue; const dd = Math.sqrt(d2(o.x, o.y, P.x, P.y)); if (dd > 900) continue;
      const ahead = Math.cos(ang(P.a, Math.atan2(o.y - P.y, o.x - P.x)));
      const sc = (o.v || 1) / (60 + dd) * (1.4 + ahead); if (sc > bs) { bs = sc; g = o; } }
    for (const p of G.powers) { if (skip.has(p)) continue; const dd = Math.sqrt(d2(p.x, p.y, P.x, P.y)); if (dd < 700) { const sc = 6 / (60 + dd); if (sc > bs) { bs = sc; g = p; } } }
    if (g) return { x: g.x, y: g.y, kind: "gold", obj: g };
    const a = P.a + (Math.random() - .5); return { x: P.x + Math.cos(a) * 500, y: P.y + Math.sin(a) * 500, kind: "wander" };
  }

  let lastF = performance.now(); const bootAt = performance.now();
  window.__lbChat = chat; window.__lbPoll = () => startPoll();   // for testing
  function frame(now) {
    requestAnimationFrame(frame);
    const P = G.player;
    // status panel
    const humans = G.ships.filter(s => s.human && s.alive && s.name !== NAME).length;
    stats.innerHTML = `Shield wall <em>${P && P.alive ? P.len : "—"}</em> · Sinks today <em>${S.sinks}</em><br>Best today <em>${Math.max(S.best, P && P.alive ? P.len : 0)}</em> · Times sunk <em>${S.sunk}</em><br>` +
      `Real players at sea: <em>${humans}</em>${S.by ? ` · Last to sink him: <em>${esc(S.by)}</em>` : ""}${S.sailingFor ? `<br>Sailing for: <em>${esc(S.sailingFor)}</em>` : ""}`;
    const showMode = order && now < orderUntil ? MODES[order] : now < boostUntil ? MODES.boost : "";
    modeEl.textContent = showMode; modeEl.style.display = showMode ? "" : "none";

    if (!P || !P.alive || !G.running) {   // sunk or not started: sail again after a short breather
      if (now > respawnAt && G.net.on && !G.net.sailing) { $("name").value = NAME; G.start(); respawnAt = now + 6000; }
      else if (now > respawnAt && !G.net.on && now - bootAt > 15000) { $("name").value = NAME; G.start(); respawnAt = now + 6000; }   // server unreachable: keep the stream alive on the bots-only sea
      lastF = now; return;
    }
    const f = Math.min(3, (now - lastF) / 16.7); lastF = now;

    // mood swings like a real player: mostly looting, sometimes feeling brave when big enough
    if (now > moodUntil) { mood = P.len > 60 && Math.random() < .35 ? "hunt" : "gold"; moodUntil = now + 8000 + Math.random() * 12000; }
    if (!goal || now - lastGoal > 450 || d2(goal.x, goal.y, P.x, P.y) < 40 * 40) { goal = pickGoal(P, now); lastGoal = now; }
    // same coin for 4+ seconds = he can't get it (or it's already his): forget it
    if (goal.obj !== chaseObj) { chaseObj = goal.obj || null; chaseSince = now; }
    else if (chaseObj && now - chaseSince > 4000) { skip.add(chaseObj); chaseObj = null; goal = pickGoal(P, now); lastGoal = now; }
    // never orbit: a goal inside his turning circle and off to the side can't be reached, only circled
    { const gd = Math.sqrt(d2(goal.x, goal.y, P.x, P.y)), off = Math.abs(ang(P.a, Math.atan2(goal.y - P.y, goal.x - P.x)));
      if (gd < TURN_R * 2.4 && off > 1.0) { if (goal.obj) skip.add(goal.obj); goal = { x: P.x + Math.cos(P.a) * 450, y: P.y + Math.sin(P.a) * 450, kind: "wander" }; lastGoal = now; } }
    // circling guard (real time, not frames: OBS runs at 30fps): more than ~1 loop of turning in the last 4 s = break out
    const dt = Math.min(200, now - (frame.last || now)); frame.last = now;
    if (lastA !== null) spin = spin * Math.exp(-dt / 4000) + ang(lastA, P.a);
    lastA = P.a;
    // and he must actually GO somewhere: if he's still within a small area after 4 s, pick a spot far away and sail to it
    trail.push({ t: now, x: P.x, y: P.y }); while (trail.length && now - trail[0].t > 4000) trail.shift();
    const stuck = trail.length > 10 && now - trail[0].t > 3800 && Math.sqrt(d2(trail[0].x, trail[0].y, P.x, P.y)) < 110;   // he covers ~280px in 4s going straight
    if ((Math.abs(spin) > Math.PI * 2.1 || stuck) && now > straightUntil) {
      spin = 0; trail.length = 0; if (chaseObj) skip.add(chaseObj);
      let ea = P.a, eb = -1; for (let k = 0; k < 12; k++) { const a = P.a + (k - 6) * .4, c = clear(P, a, 900); if (c > eb) { eb = c; ea = a; } }   // the most open water
      escape = { x: P.x + Math.cos(ea) * 900, y: P.y + Math.sin(ea) * 900, kind: "wander" }; straightUntil = now + 3500;
      if (order && order !== "flee") orderUntil = 0;   // a chat order that sent him in circles is over
    }
    if (now < straightUntil && escape) goal = escape;
    // where he wants to go, then the safest nearby heading if that way is blocked
    let want = Math.atan2(goal.y - P.y, goal.x - P.x);
    const look = 150 + Math.min(220, P.len * 1.2);
    if (clear(P, want, look) < look) {
      let best = want, bs = -1e9;
      for (let k = -8; k <= 8; k++) { const a = P.a + k * .3; const c = clear(P, a, look); const sc = c - Math.abs(ang(want, a)) * 40; if (sc > bs) { bs = sc; best = a; } }
      want = best;
    }
    // Mjolnir held: strike when a big ship is in range ahead (the ⚡ button a player would press)
    if (P.buffs && P.buffs.mjolnir && G.ships.some(s => s !== P && s.alive && !s.hidden && s.len >= 25 && d2(s.x, s.y, P.x, P.y) < 520 * 520 && Math.cos(ang(P.a, Math.atan2(s.y - P.y, s.x - P.x))) > .6)) G.zap();

    // the "hand": sweep toward the heading instead of snapping, with a little thumb wobble
    if (P.target !== hand.set) hand.a = P.a;
    hand.a += Math.max(-.08 * f, Math.min(.08 * f, ang(hand.a, want) * .2));
    hand.ph += (.06 + Math.random() * .04) * f;
    P.target = hand.set = hand.a + Math.sin(hand.ph) * .04 + Math.sin(hand.ph * 2.7 + 1) * .02;
    G.input.active = false;
    G.input.boost = now < boostUntil || (!!goal.boost && P.len > 30);
  }
  requestAnimationFrame(frame);
  say(CHANNEL ? `💬 Reading chat from <b>#${esc(CHANNEL)}</b>` : "💬 (no Twitch channel set)");
})();
