'use strict';
// Smith forge (打造装备): pick a recipe, place materials in recipe order, then
// keep the furnace inside a moving temperature band through four 5 s stages
// (melting, moulding, forging, chastening). The server simulates the same
// temperature model as the client from the acknowledged heat/cool inputs.
const C = require('../../game/character');
const cat = require('../../game/catalog');
const D = require('./data');
const U = require('./common');

const STAGE_MS = 5000;
const STAGES = 4;
const DURATION_MS = STAGE_MS * STAGES;
const HEAT_RATE = 1150;
const COOL_RATE = -820;
const MIN_T = 20;
const MAX_T = 5000;
const START_T = 450;
const SIM_STEP_MS = 50;
const FREQ = [0.5, 0.75, 1.5, 0.5];
const SLOT_COUNT = 20;
const E = { NOT_HERE: 1, NO_SESSION: 2, BAD_RECIPE: 3, LOCKED: 4, BAD_SLOT: 5, BAD_ITEM: 6, PHASE: 7, NOT_CRAFTSMAN: 8, BAG_FULL: 9, TOO_EARLY: 10, STALE: 12 };

const clampT = (t) => Math.max(MIN_T, Math.min(MAX_T, t));
const smooth = (x) => x * x * (3 - 2 * x);

function targetAt(s, elapsed) {
  const e = Math.max(0, Math.min(DURATION_MS - 1, elapsed));
  const stage = Math.min(3, Math.floor(e / STAGE_MS));
  const f = (e - stage * STAGE_MS) / STAGE_MS;
  const r = (t, x) => s.targets[t] + s.drifts[t] * Math.sin(x * FREQ[t] * Math.PI * 2 + s.phases[t]);
  const a = r(stage, f);
  if (stage === 0) return START_T + (a - START_T) * smooth(Math.min(1, f / 0.7));
  if (f < 0.5) { const prev = r(stage - 1, 1); return prev + (a - prev) * smooth(f / 0.5); }
  return a;
}

class Forge {
  constructor(crafting) { this.crafting = crafting; this.server = crafting.server; }

  register() {
    const s = this.server; const op = s.op; const rp = (fn) => s.requirePlayer((p, d) => fn.call(this, p, d || {}));
    s.on(op.SMITH_FORGE_OPEN, rp(this.open));
    s.on(op.SMITH_FORGE_SELECT, rp(this.select));
    s.on(op.SMITH_FORGE_MATERIAL, rp(this.material));
    s.on(op.SMITH_FORGE_INPUT, rp((p, d) => this.input(p, d, d.heating)));
    s.on(op.SMITH_FORGE_HEAT, rp((p, d) => this.input(p, d, true)));
    s.on(op.SMITH_FORGE_COOL, rp((p, d) => this.input(p, d, false)));
    s.on(op.SMITH_FORGE_FINISH, rp(this.finish));
    s.on(op.SMITH_FORGE_RENEW, rp(this.renew));
    s.on(op.SMITH_FORGE_CLOSE, rp(this.close));
    s.on(op.SMITH_FORGE_NEXT, rp(() => undefined));
    s.on(op.SMITH_FORGE_ACTION, rp(() => undefined));
  }

  err(p, code, message) { p.send(this.server.op.SMITH_FORGE_ERROR, { code, message, serverSeq: this.server.nextSeq() }); }
  level(p) { return D.skillLevel(D.craftState(p.ch).forging.exp); }

  session(p, d) {
    const s = p.interactions.forge;
    if (!s || (d.sessionId && d.sessionId !== s.sessionId)) { this.err(p, E.NO_SESSION, '打造会话已失效，请重新打开。'); return null; }
    return s;
  }

  recipesFor(p) {
    const lvl = this.level(p);
    const owned = new Map();
    for (const it of p.ch.inventory) if (it) owned.set(it.itemId, (owned.get(it.itemId) || 0) + it.count);
    const list = D.RECIPES.filter((r) => r.requiredLevel <= lvl + 20).slice(0, 80);
    return list.map((r) => ({
      itemId: r.itemId, name: r.name, requiredLevel: r.requiredLevel, unlocked: lvl >= r.requiredLevel,
      materials: r.materials.map((m) => ({ itemId: m.itemId, name: cat.getTemplate(m.itemId).name, count: m.count, owned: owned.get(m.itemId) || 0 })),
    }));
  }

  // Advances the simulated temperature (and stage scores) up to `now`.
  simulate(s, now) {
    if (s.gameStartedAt == null || s.done) { s.simAt = now; return; }
    const end = Math.min(now, s.gameStartedAt + DURATION_MS);
    while (s.simAt + SIM_STEP_MS <= end) {
      s.simAt += SIM_STEP_MS;
      s.temperature = clampT(s.temperature + (s.heating ? HEAT_RATE : COOL_RATE) * SIM_STEP_MS / 1000);
      const elapsed = s.simAt - s.gameStartedAt;
      const stage = Math.min(3, Math.floor(Math.min(elapsed, DURATION_MS - 1) / STAGE_MS));
      s.samples[stage] += 1;
      if (Math.abs(s.temperature - targetAt(s, elapsed)) <= s.halfWidth) s.hits[stage] += 1;
    }
    if (now > s.simAt && now < s.gameStartedAt + DURATION_MS) {
      const dt = now - s.simAt;
      s.temperature = clampT(s.temperature + (s.heating ? HEAT_RATE : COOL_RATE) * dt / 1000);
      s.simAt = now;
    }
  }

  stageScores(s) { return s.samples.map((n, i) => (n ? Math.round((s.hits[i] / n) * 100) : 0)); }

  phase(s, now) {
    if (s.done) return s.done;
    if (s.gameStartedAt == null) return 'select';
    const e = Math.min(DURATION_MS - 1, now - s.gameStartedAt);
    return ['melting', 'moulding', 'forging', 'chastening'][Math.min(3, Math.floor(e / STAGE_MS))];
  }

  sendState(p, s) {
    const now = Date.now();
    this.simulate(s, now);
    const recipe = s.selectedRecipeId ? D.RECIPE_BY_ID.get(s.selectedRecipeId) : null;
    const placed = [];
    for (let i = 0; i < SLOT_COUNT; i += 1) {
      const ref = s.placed[i];
      const v = ref ? U.viewRef(p, ref, recipe && recipe.materials[i] ? recipe.materials[i].count : undefined) : null;
      placed.push(v || { inventoryIndex: null, item: null });
    }
    const st = {
      sessionId: s.sessionId, phase: this.phase(s, now), recipes: this.recipesFor(p), selectedRecipeId: s.selectedRecipeId,
      placedMaterials: placed, inventoryRevision: p.ch.revision, gameStartedAt: s.gameStartedAt, gameDurationMs: DURATION_MS,
      serverTime: now, temperature: Math.round(s.temperature * 100) / 100, temperatureRate: s.gameStartedAt != null && !s.done ? (s.heating ? HEAT_RATE : COOL_RATE) : 0,
      heating: s.heating, targetTemperature: START_T, targetBandHalfWidth: s.halfWidth,
      temperatureTargets: s.targets, temperatureDrifts: s.drifts, temperaturePhases: s.phases,
      stageScores: this.stageScores(s), inputAckSeq: s.inputAckSeq, serverSeq: this.server.nextSeq(),
    };
    if (s.pendingOutput) st.pendingOutput = true;
    p.send(this.server.op.SMITH_FORGE_STATE, st);
  }

  freshGame(s, p) {
    const lvl = this.level(p);
    const rnd = (a, b) => a + Math.random() * (b - a);
    s.gameStartedAt = null; s.done = null; s.heating = false; s.temperature = MIN_T; s.simAt = Date.now();
    s.targets = [Math.round(rnd(1300, 1800)), Math.round(rnd(800, 1200)), Math.round(rnd(2100, 2700)), Math.round(rnd(500, 900))];
    s.drifts = [Math.round(rnd(120, 260)), Math.round(rnd(120, 260)), Math.round(rnd(150, 320)), Math.round(rnd(100, 220))];
    s.phases = [0, 1, 2, 3].map(() => Math.round(rnd(0, Math.PI * 2) * 1000) / 1000);
    s.halfWidth = 160 + Math.min(140, lvl * 2);
    s.samples = [0, 0, 0, 0]; s.hits = [0, 0, 0, 0];
  }

  open(p) {
    if (!U.mapIs(p, 'smith')) return this.err(p, E.NOT_HERE, '请到铁匠铺的工作台打造装备。');
    if (p.ch.profession !== 'craftsman') return this.err(p, E.NOT_CRAFTSMAN, '只有工匠才能打造装备。');
    const s = { sessionId: U.newSessionId('forge'), selectedRecipeId: null, placed: new Array(SLOT_COUNT).fill(null), inputAckSeq: 0, pendingOutput: null };
    this.freshGame(s, p);
    p.interactions.forge = s;
    this.sendState(p, s);
  }

  select(p, d) {
    const s = this.session(p, d); if (!s) return;
    if (s.gameStartedAt != null) return this.err(p, E.PHASE, '正在打造中，不能更换目标。');
    const r = D.RECIPE_BY_ID.get(Number(d.recipeId));
    if (!r) return this.err(p, E.BAD_RECIPE, '没有这个打造配方。');
    if (this.level(p) < r.requiredLevel) return this.err(p, E.LOCKED, '需要打造' + r.requiredLevel + '级才能打造' + r.name + '。');
    s.selectedRecipeId = r.itemId;
    s.placed = new Array(SLOT_COUNT).fill(null);
    // Pre-fill slots from the bag where a single stack is enough.
    const used = new Set();
    r.materials.forEach((m, i) => {
      const at = p.ch.inventory.findIndex((it, j) => it && !used.has(j) && it.itemId === m.itemId && it.count >= m.count);
      if (at >= 0) { used.add(at); s.placed[i] = U.invRef(p, at); }
    });
    this.sendState(p, s);
  }

  material(p, d) {
    const s = this.session(p, d); if (!s) return;
    if (s.gameStartedAt != null) return this.err(p, E.PHASE, '正在打造中，不能调整原料。');
    const r = D.RECIPE_BY_ID.get(s.selectedRecipeId);
    if (!r) return this.err(p, E.BAD_RECIPE, '请先选择打造目标。');
    const slot = U.idx(d.slot);
    if (slot == null || slot >= r.materials.length) return this.err(p, E.BAD_SLOT, '请按配方顺序把原料拖入中央第一排对应格子。');
    if (d.inventoryIndex == null) { s.placed[slot] = null; return this.sendState(p, s); }
    const index = U.idx(d.inventoryIndex);
    const it = index == null ? null : p.ch.inventory[index];
    if (!it) return this.err(p, E.STALE, '背包物品已经变化。');
    const need = r.materials[slot];
    if (it.itemId !== need.itemId) return this.err(p, E.BAD_ITEM, '这一格需要放入' + cat.getTemplate(need.itemId).name + '。');
    if (it.count < need.count) return this.err(p, E.BAD_ITEM, cat.getTemplate(need.itemId).name + '数量不足，需要 ' + need.count + ' 个。');
    s.placed.forEach((ref, i) => { if (ref && ref.inventoryIndex === index && i !== slot) s.placed[i] = null; });
    s.placed[slot] = U.invRef(p, index);
    this.sendState(p, s);
  }

  ready(p, s) {
    const r = D.RECIPE_BY_ID.get(s.selectedRecipeId);
    if (!r) return null;
    for (let i = 0; i < r.materials.length; i += 1) {
      const it = U.resolveRef(p, s.placed[i]);
      if (!it || it.itemId !== r.materials[i].itemId || it.count < r.materials[i].count) return null;
    }
    return r;
  }

  input(p, d, heating) {
    const s = this.session(p, d); if (!s) return;
    if (s.done) return;
    const now = Date.now();
    const seq = Number.isInteger(d.inputSeq) ? d.inputSeq : ((s.inputAckSeq % 65535) + 1);
    if (s.gameStartedAt == null) {
      if (!heating) { s.inputAckSeq = seq; return; }
      if (!this.ready(p, s)) return this.err(p, E.BAD_ITEM, '原料不齐，不能开始打造。');
      if (p.findFreeSlot() < 0) return this.err(p, E.BAG_FULL, '背包已满，请先留出一个空位。');
      s.gameStartedAt = now; s.simAt = now; s.temperature = START_T; s.heating = true; s.inputAckSeq = seq;
      return this.sendState(p, s);
    }
    this.simulate(s, now);
    s.heating = !!heating;
    s.inputAckSeq = seq;
    p.send(this.server.op.SMITH_FORGE_SYNC, {
      sessionId: s.sessionId, ackInputSeq: seq, elapsedMs: Math.min(DURATION_MS, now - s.gameStartedAt),
      temperatureCenti: Math.round(s.temperature * 100), heating: s.heating, serverSeq: this.server.nextSeq(),
    });
  }

  finish(p, d) {
    const s = this.session(p, d); if (!s) return;
    if (s.pendingOutput) return this.deliver(p, s);
    if (s.gameStartedAt == null || s.done) return this.err(p, E.PHASE, '还没有开始打造。');
    const now = Date.now();
    if (now - s.gameStartedAt < DURATION_MS - 400) return this.err(p, E.TOO_EARLY, '打造还没有结束。');
    this.simulate(s, s.gameStartedAt + DURATION_MS);
    const r = this.ready(p, s);
    if (!r) { s.done = 'failed'; this.sendState(p, s); return this.err(p, E.STALE, '原料已经不在背包里，打造中止。'); }
    const scores = this.stageScores(s);
    const avg = scores.reduce((a, b) => a + b, 0) / STAGES;
    const changed = [];
    r.materials.forEach((m, i) => changed.push(U.consumeAt(p, s.placed[i].inventoryIndex, m.count)));
    const success = avg >= 45 && Math.min(...scores) >= 15;
    let messages = [];
    let message;
    if (success) {
      const item = C.makeItem(p.ch, r.itemId, 1);
      const quality = avg >= 90 ? 0.2 : avg >= 75 ? 0.1 : 0;
      if (quality) {
        item.bonusAttrs = item.bonusAttrs.map((a) => { const v = Math.max(a.value + 1, Math.round(a.value * (1 + quality))); return { key: a.key, value: v, display: a.display.replace(/\d+(?=%?$)/, String(v)) }; });
        item.name = (quality >= 0.2 ? '完美的' : '精良的') + item.name;
        item.ext = Object.assign({}, item.ext, { affix: { prefix: { name: quality >= 0.2 ? '完美的' : '精良的', attrs: [] }, suffix: null }, affixVersion: require('../../game/affixes').AFFIX_VERSION });
        require('../../game/affixes').markAffixColour(item);
      }
      item.ext = Object.assign({}, item.ext, { craftedBy: p.name });
      s.pendingOutput = item;
      messages = D.gainSkill(p.ch, 'forging', 10 + r.requiredLevel * 2, '打造');
      message = '打造成功！得到' + item.name + '（四拍得分 ' + scores.join('/') + '）。';
      s.done = 'complete';
    } else {
      D.gainSkill(p.ch, 'forging', 0, '打造', false);
      message = '打造失败，原料已经损耗（四拍得分 ' + scores.join('/') + '）。';
      s.done = 'failed';
    }
    p.commitItems({ inv: changed });
    this.server.store.markDirty();
    if (s.pendingOutput) this.deliver(p, s, true);
    this.sendState(p, s);
    p.send(this.server.op.SMITH_FORGE_RESULT, { sessionId: s.sessionId, success, message, progressionMessages: messages, serverSeq: this.server.nextSeq() });
  }

  deliver(p, s, quiet = false) {
    const changed = p.addItem(s.pendingOutput);
    if (!changed) { if (!quiet) this.err(p, E.BAG_FULL, '背包已满，成品先留在工作台上。'); return false; }
    s.pendingOutput = null;
    p.commitItems({ inv: changed });
    if (!quiet) this.sendState(p, s);
    return true;
  }

  renew(p, d) {
    const s = this.session(p, d); if (!s) return;
    if (s.pendingOutput && !this.deliver(p, s)) return;
    if (!s.done) return this.err(p, E.PHASE, '正在打造中。');
    const recipe = s.selectedRecipeId;
    this.freshGame(s, p);
    s.placed = new Array(SLOT_COUNT).fill(null);
    if (recipe) return this.select(p, { sessionId: s.sessionId, recipeId: recipe });
    this.sendState(p, s);
  }

  close(p, d) {
    const s = p.interactions.forge;
    if (!s || (d.sessionId && d.sessionId !== s.sessionId)) return;
    if (s.pendingOutput) this.deliver(p, s, true);
    delete p.interactions.forge;
  }
}

module.exports = { Forge, targetAt, DURATION_MS };
