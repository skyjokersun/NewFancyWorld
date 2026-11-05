'use strict';
// Snooker tables (GameDesk "台球,N" decor). A shot is simulated here with the
// same fixed-step physics as the client's SnookerShotPlayer, so the client can
// replay it from the pre-shot balls and land exactly on the server's result.
// Modes: practice (solo, rules scored but no turn change) and computer
// (against a medium-strength AI that picks shots by simulating candidates).

const FIXED_STEP_MS = 16;
const MAX_SHOT_MS = 25000;
const MAX_SPEED = 1400;
const MIN_SPEED = 90;
const RADIUS = 9.5;
const POCKETS = [{ x: 29, y: 27 }, { x: 510, y: 18 }, { x: 991, y: 27 }, { x: 29, y: 512 }, { x: 510, y: 521 }, { x: 991, y: 512 }];
const LEFT = 29; const RIGHT = 991; const TOP = 27; const BOTTOM = 512; const MOUTH = 26;
const COLORS = ['yellow', 'green', 'brown', 'blue', 'pink', 'black'];
const VALUE = { red: 1, yellow: 2, green: 3, brown: 4, blue: 5, pink: 6, black: 7 };
const NAMES = { red: '红球', yellow: '黄球', green: '绿球', brown: '棕球', blue: '蓝球', pink: '粉球', black: '黑球', cue: '白球' };
const MID_Y = 269.5;
const BAULK_X = 233.5;
const D_RADIUS = 77;
const SPOTS = {
  yellow: { x: BAULK_X, y: MID_Y + D_RADIUS }, green: { x: BAULK_X, y: MID_Y - D_RADIUS }, brown: { x: BAULK_X, y: MID_Y },
  blue: { x: 510, y: MID_Y }, pink: { x: 745.75, y: MID_Y }, black: { x: 896, y: MID_Y },
};
const CUE_START = { x: BAULK_X - 40, y: MID_Y + 30 };
const COMPUTER_ID = 'computer';
const AI_THINK_MS = 1400;

function rackBalls() {
  const balls = [{ id: 'cue', kind: 'cue', x: CUE_START.x, y: CUE_START.y, vx: 0, vy: 0, potted: false }];
  for (const c of COLORS) balls.push({ id: c, kind: c, x: SPOTS[c].x, y: SPOTS[c].y, vx: 0, vy: 0, potted: false });
  const apexX = SPOTS.pink.x + 2 * RADIUS + 1;
  const dx = Math.sqrt(3) * (RADIUS + 0.05);
  let n = 1;
  for (let row = 0; row < 5; row += 1) {
    for (let k = 0; k <= row; k += 1) {
      balls.push({ id: 'red' + n, kind: 'red', x: apexX + row * dx, y: MID_Y + (k - row / 2) * (2 * RADIUS + 0.1), vx: 0, vy: 0, potted: false });
      n += 1;
    }
  }
  return balls;
}

// ---------- physics (mirrors SnookerShotPlayback.ts) ----------
class ShotSim {
  constructor(balls, spin) {
    this.balls = balls.map((b) => Object.assign({}, b));
    this.spin = Object.assign({}, spin, { firstContactApplied: false });
    this.trace = { firstContactBallId: null };
    this.events = [];
  }

  run() {
    let elapsed = 0;
    while (elapsed < MAX_SHOT_MS) {
      this.events.push(...this.step(FIXED_STEP_MS));
      elapsed += FIXED_STEP_MS;
      if (this.balls.every((b) => b.potted || (b.vx === 0 && b.vy === 0))) break;
    }
    for (const b of this.balls) { b.vx = 0; b.vy = 0; }
    return elapsed;
  }

  step(t) {
    const a = Math.max(0, Math.min(100, t));
    const s = Math.max(1, Math.ceil(a / 8));
    const e = a / s / 1e3;
    const n = [];
    for (let o = 0; o < s; o += 1) {
      for (const l of this.balls) if (!(l.potted || Math.abs(l.vx) + Math.abs(l.vy) <= 0)) { l.x += l.vx * e; l.y += l.vy * e; }
      this.resolvePockets(n); this.resolveCushions(n); this.resolveBallCollisions(n); this.applyRollingFriction(e);
    }
    for (const c of this.balls) {
      if (c.potted) { c.vx = 0; c.vy = 0; } else if (Math.hypot(c.vx, c.vy) <= 4) { c.vx = 0; c.vy = 0; }
    }
    return n;
  }

  resolvePockets(t) {
    for (const e of this.balls) {
      if (e.potted) continue;
      this.applyPocketFunnel(e);
      for (const y of POCKETS) {
        const p = e.x - y.x; const x = e.y - y.y;
        const d = p * p + x * x <= 182.25;
        const f = (y.y <= TOP && Math.abs(p) <= MOUTH && e.y <= 14) || (y.y >= BOTTOM && Math.abs(p) <= MOUTH && e.y >= 525)
          || (y.x <= LEFT && Math.abs(x) <= MOUTH && e.x <= 16) || (y.x >= RIGHT && Math.abs(x) <= MOUTH && e.x >= 1004);
        if (d || f) { e.potted = true; e.vx = 0; e.vy = 0; t.push({ type: 'pocket', ballId: e.id }); break; }
      }
    }
  }

  applyPocketFunnel(t) {
    for (const s of POCKETS) {
      const e = s.x - t.x; const u = s.y - t.y;
      const c = s.y <= TOP && Math.abs(e) <= MOUTH && t.y <= 38.5 && (t.vy < 0 || t.y < 36.5);
      const y = s.y >= BOTTOM && Math.abs(e) <= MOUTH && t.y >= 500.5 && (t.vy > 0 || t.y > 502.5);
      const p = s.x <= LEFT && Math.abs(u) <= MOUTH && t.x <= 40.5 && (t.vx < 0 || t.x < 38.5);
      const x = s.x >= RIGHT && Math.abs(u) <= MOUTH && t.x >= 979.5 && (t.vx > 0 || t.x > 981.5);
      if (c || y || p || x) {
        if (c || y) { t.x += 0.09 * e; t.vx += 0.025 * e; }
        if (p || x) { t.y += 0.09 * u; t.vy += 0.025 * u; }
        return;
      }
    }
  }

  resolveCushions(t) {
    for (const e of this.balls) {
      if (e.potted) continue;
      let n = false; let o = 0; let r = 0;
      if (e.x < 38.5 && !this.isVerticalPocketMouth(e.y)) { e.x = 38.5; e.vx = 0.88 * Math.abs(e.vx); n = true; o = 1; } else if (e.x > 981.5 && !this.isVerticalPocketMouth(e.y)) { e.x = 981.5; e.vx = 0.88 * -Math.abs(e.vx); n = true; o = -1; }
      if (e.y < 36.5 && !this.isHorizontalPocketMouth(e.x)) { e.y = 36.5; e.vy = 0.88 * Math.abs(e.vy); n = true; r = 1; } else if (e.y > 502.5 && !this.isHorizontalPocketMouth(e.x)) { e.y = 502.5; e.vy = 0.88 * -Math.abs(e.vy); n = true; r = -1; }
      if (e.kind === 'cue' && Math.abs(this.spin.side) > 0.001) {
        if (o !== 0) e.vy += this.spin.side * Math.abs(e.vx) * 0.16 * o;
        if (r !== 0) e.vx += this.spin.side * Math.abs(e.vy) * 0.16 * -r;
      }
      if (n) t.push({ type: 'cushion', ballId: e.id });
    }
  }

  isHorizontalPocketMouth(t) { return POCKETS.some((i) => (i.y <= TOP || i.y >= BOTTOM) && Math.abs(t - i.x) <= MOUTH); }
  isVerticalPocketMouth(t) { return POCKETS.some((i) => (i.x <= LEFT || i.x >= RIGHT) && Math.abs(t - i.y) <= MOUTH); }

  resolveBallCollisions(t) {
    for (let i = 0; i < this.balls.length; i += 1) {
      const a = this.balls[i];
      if (a.potted) continue;
      for (let s = i + 1; s < this.balls.length; s += 1) {
        const n = this.balls[s];
        if (n.potted) continue;
        const o = n.x - a.x; const r = n.y - a.y; const h = o * o + r * r;
        if (h >= 361) continue;
        const l = Math.max(0.001, Math.sqrt(h)); const v = o / l; const u = r / l; const c = 19 - l;
        a.x -= v * c * 0.5; a.y -= u * c * 0.5; n.x += v * c * 0.5; n.y += u * c * 0.5;
        const y = a.kind === 'cue' ? a : n.kind === 'cue' ? n : null;
        const p = y ? Math.hypot(y.vx, y.vy) : 0;
        const x = (n.vx - a.vx) * v + (n.vy - a.vy) * u;
        if (x < 0) { const d = -1.96 * x / 2; a.vx -= d * v; a.vy -= d * u; n.vx += d * v; n.vy += d * u; }
        const f = a.kind === 'cue' ? a : n.kind === 'cue' ? n : null;
        const M = f === a ? n : f === n ? a : null;
        if (f && M && !this.trace.firstContactBallId && (this.trace.firstContactBallId = M.id, !this.spin.firstContactApplied)) {
          const b = p * this.spin.longitudinal * 0.42; const k = p * this.spin.side * 0.055;
          f.vx += this.spin.directionX * b - this.spin.directionY * k; f.vy += this.spin.directionY * b + this.spin.directionX * k;
          this.spin.firstContactApplied = true;
        }
        t.push({ type: 'ball_hit', ballId: M ? M.id : n.id });
      }
    }
  }

  applyRollingFriction(t) {
    const s = 84 * t;
    for (const n of this.balls) {
      if (n.potted) continue;
      const o = Math.hypot(n.vx, n.vy);
      if (o <= 0) continue;
      const r = Math.max(0, o - s) / o * Math.pow(0.995, 60 * t);
      n.vx *= r; n.vy *= r;
    }
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function speedFor(power) { return MIN_SPEED + (MAX_SPEED - MIN_SPEED) * (clamp(power, 0.08, 1) - 0.08) / 0.92; }

// Sets the cue ball moving and simulates the whole shot.
function simulateShot(balls, shot) {
  const start = balls.map((b) => Object.assign({}, b, { vx: 0, vy: 0 }));
  const cue = start.find((b) => b.id === 'cue');
  const v = speedFor(shot.power);
  cue.vx = shot.aimX * v; cue.vy = shot.aimY * v;
  const spin = { side: clamp(shot.spinX, -1, 1), longitudinal: clamp(shot.spinY, -1, 1), directionX: shot.aimX, directionY: shot.aimY };
  const sim = new ShotSim(start, spin);
  const durationMs = sim.run();
  return { start, end: sim.balls, durationMs, spin, firstContact: sim.trace.firstContactBallId, potted: sim.events.filter((e) => e.type === 'pocket').map((e) => e.ballId) };
}

class Snooker {
  register(server) {
    this.server = server;
    this.op = server.op;
    this.rooms = new Map(); // roomId -> room
    this.byTable = new Map(); // world|map|tableNo -> roomId
    this.eventSeq = 0;
    const need = server.requirePlayer.bind(server);
    server.on(this.op.SNOOKER_JOIN, need((p, d) => this.join(p, d || {})));
    server.on(this.op.SNOOKER_SHOOT, need((p, d) => this.shoot(p, d || {})));
    server.on(this.op.SNOOKER_LEAVE, need((p, d) => this.leave(p, d || {})));
    server.on(this.op.SNOOKER_RESET, need((p, d) => this.reset(p, d || {})));
    server.events.on('tick', (now) => this.tick(now || Date.now()));
    server.events.on('playerMapChanging', (p) => this.drop(p));
    server.events.on('playerLeaving', (p) => this.drop(p));
  }

  err(p, message) { p.send(this.op.SNOOKER_ERROR, { message, serverSeq: this.server.nextSeq() }); }

  tableDecor(mapRef, tableNo) {
    const doc = this.server.maps.rawDoc(mapRef);
    for (const d of (doc && doc.decor) || []) {
      if (String(d.tag || '').toLowerCase() !== 'gamedesk' || !/btable_r\.ale$/i.test(String(d.path || ''))) continue;
      const parts = String(d.extra || '').replace(/^["']|["']$/g, '').split(',').map((x) => x.trim());
      if (parts[0] === '台球' && /^\d+$/.test(parts[1] || '') && String(Number.parseInt(parts[1], 10)) === tableNo) return d;
    }
    return null;
  }

  roomOf(p) { return p.snookerRoomId ? this.rooms.get(p.snookerRoomId) || null : null; }

  join(p, d) {
    const tableNo = String(Number.parseInt(String(d.tableNo || ''), 10));
    const mode = d.mode === 'computer' ? 'computer' : 'practice';
    if (!p.scene || tableNo === 'NaN') return this.err(p, '找不到这张球桌。');
    const desk = this.tableDecor(p.scene.mapRef, tableNo);
    if (!desk) return this.err(p, '这里没有 ' + tableNo + ' 号球桌。');
    if (Math.hypot(p.x - desk.x, p.y + desk.y) > 420) return this.err(p, '请走到球桌旁边再开球。');
    const tableKey = p.scene.key() + '|' + tableNo;
    const busy = this.byTable.get(tableKey);
    if (busy && this.rooms.has(busy) && this.rooms.get(busy).ownerId !== p.id) return this.err(p, tableNo + ' 号球桌正在使用中，请换一张。');
    this.drop(p);
    const room = {
      roomId: 'snk_' + p.id + '_' + Date.now().toString(36), tableKey, tableNo, mode, ownerId: p.id, owner: p,
      balls: rackBalls(), players: [{ playerId: p.id, playerName: p.name, score: 0 }], turnPlayerId: p.id,
      target: 'red', breakScore: 0, phase: 'aiming', shotNo: 0, playback: null, pending: null, computerAim: null, events: [],
      message: mode === 'practice' ? '练习模式：瞄准后按住鼠标蓄力，松开击球。' : '电脑对战：你先开球。',
    };
    if (mode === 'computer') room.players.push({ playerId: COMPUTER_ID, playerName: '电脑（中等）', score: 0 });
    this.rooms.set(room.roomId, room);
    this.byTable.set(tableKey, room.roomId);
    p.snookerRoomId = room.roomId;
    this.sendState(room);
  }

  drop(p) {
    const room = this.roomOf(p);
    p.snookerRoomId = null;
    if (!room) return;
    this.rooms.delete(room.roomId);
    if (this.byTable.get(room.tableKey) === room.roomId) this.byTable.delete(room.tableKey);
  }

  leave(p) { this.drop(p); }

  reset(p, d) {
    const room = this.roomOf(p);
    if (!room || (d.roomId && d.roomId !== room.roomId)) return this.err(p, '你不在这张球桌上。');
    if (room.phase === 'moving') return this.err(p, '球还在滚动，等它们停下再重新摆球。');
    room.balls = rackBalls(); room.target = 'red'; room.breakScore = 0; room.phase = 'aiming';
    room.turnPlayerId = p.id; room.computerAim = null; room.playback = null;
    for (const pl of room.players) pl.score = 0;
    room.message = '球已重新摆好。';
    this.pushEvent(room, 'reset');
    this.sendState(room);
  }

  shoot(p, d) {
    const room = this.roomOf(p);
    if (!room || (d.roomId && d.roomId !== room.roomId)) return this.err(p, '你不在这张球桌上。');
    if (room.phase !== 'aiming') return this.err(p, room.phase === 'finished' ? '本局已结束，点击重新摆球再来一局。' : '球还没停下。');
    if (room.turnPlayerId !== p.id) return this.err(p, '还没轮到你击球。');
    const ax = Number(d.aimX); const ay = Number(d.aimY); const len = Math.hypot(ax, ay);
    if (!Number.isFinite(len) || len < 1e-3) return this.err(p, '请先瞄准。');
    this.fire(room, { aimX: ax / len, aimY: ay / len, power: Number(d.power) || 0.08, spinX: Number(d.spinX) || 0, spinY: Number(d.spinY) || 0 });
  }

  fire(room, shot) {
    const now = Date.now();
    const r = simulateShot(room.balls, shot);
    room.shotNo += 1;
    room.balls = r.start;
    room.phase = 'moving';
    room.computerAim = null;
    room.playback = { shotNo: room.shotNo, startedAt: now, durationMs: r.durationMs, fixedStepMs: FIXED_STEP_MS, spin: r.spin };
    room.pending = { result: r, endsAt: now + r.durationMs, shooter: room.turnPlayerId };
    room.message = '';
    this.pushEvent(room, 'cue_hit');
    this.sendState(room);
  }

  // Applies snooker rules to a finished shot.
  settle(room) {
    const { result: r, shooter } = room.pending;
    room.pending = null; room.playback = null;
    room.balls = r.end;
    const ball = (id) => room.balls.find((b) => b.id === id);
    const target = room.target;
    const first = r.firstContact ? ball(r.firstContact) : null;
    const pots = r.potted.map(ball).filter(Boolean);
    const isTarget = (b) => (target === 'red' ? b.kind === 'red' : target === 'color' ? COLORS.includes(b.kind) : b.kind === target);
    let foul = null;
    if (!first) foul = '白球没有碰到任何球';
    else if (!isTarget(first)) foul = '先碰到了' + NAMES[first.kind] + '，目标是' + (target === 'color' ? '彩球' : NAMES[target]);
    else if (pots.some((b) => b.kind === 'cue')) foul = '白球落袋';
    else if (target === 'color' && pots.some((b) => b.id !== first.id)) foul = '打进了没有选定的球';
    else if (pots.some((b) => !isTarget(b))) foul = '打进了非目标球';
    const redsLeft = () => room.balls.some((b) => b.kind === 'red' && !b.potted);
    const scorer = room.players.find((x) => x.playerId === shooter);
    const other = room.players.find((x) => x.playerId !== shooter) || null;
    let keepTurn = false;
    const parts = [];
    if (foul) {
      const involved = [first, ...pots].filter((b) => b && b.kind !== 'cue').map((b) => VALUE[b.kind]);
      const pen = Math.max(4, ...involved, target === 'color' || target === 'red' ? 0 : VALUE[target]);
      if (other) other.score += pen;
      parts.push('犯规：' + foul + (other ? '，' + other.playerName + ' 得 ' + pen + ' 分' : '（罚 ' + pen + ' 分）'));
      room.breakScore = 0;
    } else if (pots.length) {
      const pts = pots.reduce((s, b) => s + VALUE[b.kind], 0);
      scorer.score += pts; room.breakScore += pts; keepTurn = true;
      parts.push(scorer.playerName + ' 打进' + pots.map((b) => NAMES[b.kind]).join('、') + '，得 ' + pts + ' 分');
    } else {
      room.breakScore = 0;
    }
    // Re-spot colours while reds remain (or after a foul), and the cue ball.
    for (const b of room.balls) {
      if (!b.potted) continue;
      if (b.kind === 'cue') this.respot(room, b, CUE_START);
      else if (COLORS.includes(b.kind) && (redsLeft() || foul || target === 'color' || target === 'red')) this.respot(room, b, SPOTS[b.kind]);
    }
    // Next target.
    if (keepTurn && target === 'red') room.target = 'color';
    else if (redsLeft()) room.target = 'red';
    else {
      const next = COLORS.find((c) => !ball(c).potted);
      room.target = next || 'done';
    }
    if (!keepTurn && room.mode === 'computer' && other) room.turnPlayerId = other.playerId;
    if (room.target === 'done') return this.finish(room);
    room.phase = 'aiming';
    if (!keepTurn && !foul) parts.push(room.mode === 'computer' && other ? '没有进球，换 ' + other.playerName + ' 击球' : '没有进球');
    room.message = parts.join('；');
    if (room.turnPlayerId === COMPUTER_ID) this.planComputer(room);
    this.sendState(room);
  }

  respot(room, b, spot) {
    const free = (x, y) => room.balls.every((o) => o === b || o.potted || Math.hypot(o.x - x, o.y - y) >= 2 * RADIUS + 0.5);
    let pt = null;
    const order = [spot, ...COLORS.slice().reverse().map((c) => SPOTS[c])];
    for (const s of order) if (free(s.x, s.y)) { pt = s; break; }
    for (let dx = 0; !pt && dx < 600; dx += 2) if (free(spot.x + dx, spot.y)) pt = { x: spot.x + dx, y: spot.y };
    b.x = pt ? pt.x : spot.x; b.y = pt ? pt.y : spot.y; b.potted = false; b.vx = 0; b.vy = 0;
  }

  finish(room) {
    room.phase = 'finished';
    const [a, b] = room.players;
    if (room.mode === 'practice') room.message = '清台完成！总分 ' + a.score + ' 分。点击重新摆球再来一局。';
    else if (a.score === b.score) room.message = '本局 ' + a.score + ':' + b.score + ' 打平。';
    else room.message = (a.score > b.score ? a.playerName : b.playerName) + ' 以 ' + Math.max(a.score, b.score) + ':' + Math.min(a.score, b.score) + ' 获胜！';
    this.pushEvent(room, 'game_over');
    this.sendState(room);
  }

  // ---------- computer ----------
  legalTargets(room) {
    return room.balls.filter((b) => !b.potted && b.kind !== 'cue' && (room.target === 'red' ? b.kind === 'red' : room.target === 'color' ? COLORS.includes(b.kind) : b.kind === room.target));
  }

  planComputer(room) {
    const cue = room.balls.find((b) => b.id === 'cue');
    const candidates = [];
    for (const t of this.legalTargets(room)) {
      for (const pk of POCKETS) {
        const tx = pk.x - t.x; const ty = pk.y - t.y; const tl = Math.hypot(tx, ty);
        const gx = t.x - (tx / tl) * 2 * RADIUS; const gy = t.y - (ty / tl) * 2 * RADIUS;
        const cx = gx - cue.x; const cy = gy - cue.y; const cl = Math.hypot(cx, cy);
        if (cl < 1) continue;
        const cut = (cx * tx + cy * ty) / (cl * tl);
        if (cut < 0.35) continue;
        candidates.push({ aimX: cx / cl, aimY: cy / cl, power: clamp(0.28 + (cl + tl) / (cut * 2300), 0.2, 0.9), score: cut / (cl + tl) });
      }
    }
    candidates.sort((x, y) => y.score - x.score);
    let best = null;
    for (const c of candidates.slice(0, 14)) {
      const r = simulateShot(room.balls, { aimX: c.aimX, aimY: c.aimY, power: c.power, spinX: 0, spinY: 0 });
      const first = r.firstContact && room.balls.find((b) => b.id === r.firstContact);
      const legal = first && this.legalTargets(room).some((b) => b.id === first.id) && !r.potted.includes('cue');
      const gain = legal ? r.potted.filter((id) => id === first.id || (room.target === 'red' && id.startsWith('red'))).length : -1;
      const val = (legal ? 1 : -5) + gain * 3;
      if (!best || val > best.val) best = { c, val };
    }
    let shot;
    if (best) {
      // Medium difficulty: a little aiming error.
      const err = (Math.random() - 0.5) * 0.03;
      const a = Math.atan2(best.c.aimY, best.c.aimX) + err;
      shot = { aimX: Math.cos(a), aimY: Math.sin(a), power: best.c.power, spinX: 0, spinY: 0 };
    } else {
      const t = this.legalTargets(room)[0] || room.balls.find((b) => !b.potted && b.kind !== 'cue');
      const dx = t.x - cue.x; const dy = t.y - cue.y; const l = Math.hypot(dx, dy) || 1;
      shot = { aimX: dx / l, aimY: dy / l, power: 0.45, spinX: 0, spinY: 0 };
    }
    const now = Date.now();
    room.computerAim = { startedAt: now, shootAt: now + AI_THINK_MS, aimX: shot.aimX, aimY: shot.aimY, power: shot.power };
    room.computerShot = shot;
  }

  tick(now) {
    for (const room of this.rooms.values()) {
      if (room.phase === 'moving' && room.pending && now >= room.pending.endsAt) this.settle(room);
      else if (room.phase === 'aiming' && room.computerAim && now >= room.computerAim.shootAt) this.fire(room, room.computerShot);
    }
  }

  pushEvent(room, type) {
    this.eventSeq += 1;
    room.events.push({ seq: this.eventSeq, type });
    if (room.events.length > 8) room.events.splice(0, room.events.length - 8);
  }

  sendState(room) {
    const st = {
      roomId: room.roomId, tableNo: room.tableNo, mode: room.mode, phase: room.phase, turnPlayerId: room.turnPlayerId,
      target: room.target === 'done' ? 'black' : room.target, breakScore: room.breakScore, message: room.message,
      players: room.players.map((x) => Object.assign({}, x)), balls: room.balls.map((b) => Object.assign({}, b)),
      events: room.events.slice(), timestamp: Date.now(), serverSeq: this.server.nextSeq(),
    };
    if (room.playback) st.playback = room.playback;
    if (room.computerAim) st.computerAim = room.computerAim;
    room.owner.send(this.op.SNOOKER_STATE, st);
  }
}

module.exports = { Snooker, ShotSim, simulateShot, rackBalls };
