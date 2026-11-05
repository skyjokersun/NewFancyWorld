'use strict';
// GM tool on its own port (page at /, API at /api): lists accounts and characters, and edits level, profession,
// experience, gold, skill points, level lock, bans and passwords. It runs on its own
// port (19810 by default) and asks for the password kept in admin-password.txt.
// Changes to an online character take effect in the game right away.
const fs = require('fs');
const path = require('path');
const C = require('./game/character');
const cat = require('./game/catalog');
const { protocol } = cat;
const D = require('./features/crafting/data');
const A = require('./game/affixes');
const { hashPassword, validPassword, EMAIL_RE } = require('./game/accounts');
const { LOGIN_PAGE } = require('./admin-auth');

const PAGE = path.join(__dirname, 'admin.html');
const { PATCH } = require('./version');
const MAX_GOLD = 2e9;

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('请求太大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('JSON 格式不正确')); } });
    req.on('error', reject);
  });
}

// The visitor's own address. Behind a Cloudflare tunnel (or another reverse proxy)
// every request comes from the proxy, so wrong passwords counted by that address
// would lock everyone out together; the proxy passes the real one in a header.
function clientIp(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff) return xff;
  return req.socket.remoteAddress || '';
}

function intIn(v, lo, hi, what) {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < lo || n > hi) throw new Error(what + '必须是 ' + lo + '–' + hi + ' 之间的整数');
  return n;
}

function summary(game, ch) {
  const online = game.playersById.get(ch.id);
  return {
    id: ch.id, name: ch.name, world: ch.world, online: !!online,
    profession: ch.profession, professionName: C.PROFESSION_LABELS[ch.profession] || ch.profession,
    combatLevel: C.combatLevel(ch), professionLevel: C.professionLevel(ch),
    gold: ch.gold || 0, mapRef: online ? online.scene.mapRef : ch.mapRef,
  };
}

const CRAFT_NAMES = { mining: '采矿', smelting: '炼矿', forging: '打造', fusion: '物品加工（融合）', repair: '装备修理' };
function detail(game, ch) {
  const pexp = ch.professionExp || {};
  return Object.assign(summary(game, ch), {
    accountId: ch.accountId, createdAt: ch.createdAt, playSeconds: ch.playSeconds || 0,
    combatExp: ch.combatExp || 0,
    professionExp: pexp[ch.profession] || 0,
    professionLevels: Object.fromEntries(Object.entries(pexp).map(([k, v]) => [k, C.levelForExp(v || 0)])),
    communityExp: ch.communityExp || 0,
    skillPoints: ch.skillPoints || 0,
    combatLevelLock: Number.isInteger(ch.combatLevelLock) ? ch.combatLevelLock : null,
    hp: Math.round(ch.hp || 0), stamina: Math.round(ch.stamina || 0),
    alignment: ch.alignment || 0, reputation: ch.reputation || 0, appearance: Object.assign({}, ch.appearance),
    combatSkills: Object.fromEntries(C.COMBAT_SKILL_IDS.map((k) => [k, (ch.combatSkills && ch.combatSkills[k]) || 0])),
    spentSkillPoints: C.spentSkillPoints(ch), skillPointCap: C.SKILL_POINT_TOTAL_CAP,
    stats: statsView(game, ch),
    cloudUntil: (ch.mounts && ch.mounts.cloudUntil) || 0,
    riding: C.ridingMount(ch),
    craft: Object.fromEntries(Object.entries(D.craftState(ch)).filter(([k]) => k !== 'ores').map(([k, v]) => [k, Object.assign({ name: CRAFT_NAMES[k] }, D.skillSummary(v))])),
    inventory: (ch.inventory || []).map((it, index) => it && itemView(it, index)).filter(Boolean),
    equipment: Object.entries(ch.equipment || {}).filter(([, it]) => it).map(([slot, it]) => Object.assign(itemView(it), { slot })),
  });
}

// What the character's numbers come to (the online copy when it is in the game).
function statsView(game, ch) {
  const p = game.playersById.get(ch.id);
  const st = p && p.stats ? p.stats : C.computeStats(ch);
  return {
    core: Object.assign({}, st.core), maxHp: st.maxHp, maxStamina: st.maxStamina, attack: st.attack, breakPower: st.breakPower,
    defense: st.defense, maxWeight: st.maxWeight, moveSpeed: st.moveSpeed, attackSpeed: st.attackSpeed, attackRange: st.attackRange,
  };
}

// ---------- items ----------
const SLOT_NAMES = { weapon: '武器', helmet: '头盔', shoulder: '护肩', armor: '盔甲', knee: '护膝', boots: '鞋子', necklace: '项链', gloves: '手套' };

function itemView(it, index) {
  const a = D.affixOf(it);
  return {
    index, itemId: it.itemId, name: it.name, count: it.count || 1,
    slot: cat.slotForTemplate(cat.getTemplate(it.itemId)) || null,
    attrs: (it.bonusAttrs || []).map((x) => x.display || x.key + '+' + x.value),
    prefix: a.prefix ? a.prefix.name : null, suffix: a.suffix ? a.suffix.name : null,
    prefixItemId: a.prefix && it.ext ? it.ext.fusedPrefixMaterialId || null : null,
    suffixItemId: a.suffix && it.ext ? it.ext.fusedAttributeMaterialId || null : null,
  };
}

function minLevel(t) {
  const e = t.requirement && (t.requirement.professionLevels || [])[0];
  return e ? e.minLevel || 0 : 0;
}

// Categories for the item picker: equipment by slot, everything else by kind.
function itemCategory(t) {
  const slot = cat.slotForTemplate(t);
  if (slot) return SLOT_NAMES[slot];
  if (cat.blindBoxes.has(t.itemId) || /盲盒/.test(t.name)) return '盲盒';
  // Fusion gems and 印刻, including admin-made ones and the 小酒窝 special stones.
  if (D.engravingInfo(t.itemId) || D.gemInfo(t.itemId)) return '宝石与印刻';
  if (D.MATERIAL_SHOP.includes(t.itemId) || /矿|锭|条$/.test(t.name)) return '矿石与材料';
  if (t.tab === 'medicine') return '药品';
  if (t.tab === 'book' || cat.skillBooks.has(t.itemId)) return '技能书';
  return '其他';
}
const ITEM_CATEGORIES = [...Object.values(SLOT_NAMES), '药品', '技能书', '宝石与印刻', '矿石与材料', '盲盒', '其他'];

let itemList = null;
function itemsCatalog() {
  if (!itemList) {
    itemList = [...cat.templates.values()].filter((t) => t && t.name && t.itemId > 0)
      .map((t) => ({ itemId: t.itemId, name: t.name, category: itemCategory(t), slot: cat.slotForTemplate(t) || null, slotName: SLOT_NAMES[cat.slotForTemplate(t)] || '', stackable: !cat.slotForTemplate(t), level: minLevel(t), attrs: (t.bonusAttrs || []).map((x) => x.display).filter(Boolean) }))
      .sort((a, b) => a.itemId - b.itemId);
  }
  return itemList;
}

// Items a merchant can sell: what the game's shop window knows how to show.
let sellableList = null;
function sellableItems() {
  if (!sellableList) {
    const ids = new Set(cat.catalogs.shop.map((x) => x.itemId));
    for (const id of cat.blindBoxes.keys()) ids.add(id);
    ids.add(cat.CUSTOM.FIREWORK);
    for (const id of D.MATERIAL_SHOP) ids.add(id);
    sellableList = [...ids].map((id) => cat.getTemplate(id)).filter((t) => t && t.name)
      .map((t) => ({ itemId: t.itemId, name: t.name, tab: t.tab || (cat.blindBoxes.get(t.itemId) || {}).tab || 'misc', price: t.buyPrice || 0 }))
      .sort((a, b) => a.itemId - b.itemId);
  }
  return sellableList;
}

// Prefixes are the fusion engravings (印刻), suffixes the gems; each gives its own bonus.
let affixList = null;
function affixCatalog() {
  if (!affixList) {
    const view = (t, name, grade) => ({ itemId: t.itemId, name, grade, source: t.name, attrs: (t.bonusAttrs || []).map((x) => x.display).filter(Boolean) });
    const prefixes = []; const suffixes = [];
    for (const t of cat.templates.values()) {
      const e = t && D.engravingInfo(t.itemId); if (e) prefixes.push(view(t, e.prefix, e.grade));
      const g = t && D.gemInfo(t.itemId); if (g) suffixes.push(view(t, g.suffix, g.grade));
    }
    const order = (a, b) => a.name.localeCompare(b.name, 'zh') || a.grade - b.grade;
    affixList = { prefixes: prefixes.sort(order), suffixes: suffixes.sort(order) };
  }
  return affixList;
}

function affixPart(kind, itemId) {
  if (itemId === null || itemId === undefined || itemId === '') return null;
  const list = affixCatalog()[kind === 'prefix' ? 'prefixes' : 'suffixes'];
  const a = list.find((x) => x.itemId === Number(itemId));
  if (!a) throw new Error('没有这个' + (kind === 'prefix' ? '前缀' : '后缀'));
  const t = cat.getTemplate(a.itemId);
  return { name: a.name, attrs: (t.bonusAttrs || []).map((x) => Object.assign({}, x)) };
}

function setAffix(item, body) {
  const affix = D.normalizedAffix(item);
  const ext = Object.assign({}, item.ext);
  if (body.prefixItemId !== undefined) { affix.prefix = affixPart('prefix', body.prefixItemId); if (affix.prefix) ext.fusedPrefixMaterialId = Number(body.prefixItemId); }
  if (body.suffixItemId !== undefined) { affix.suffix = affixPart('suffix', body.suffixItemId); if (affix.suffix) ext.fusedAttributeMaterialId = Number(body.suffixItemId); }
  item.ext = ext;
  D.rebuildItem(item, affix);
}

function putInBag(ch, item) {
  const inv = ch.inventory;
  if (C.canStack(item, item)) {
    for (let i = 0; i < inv.length; i += 1) if (inv[i] && C.canStack(inv[i], item)) { inv[i].count += item.count; return [i]; }
  }
  const free = inv.findIndex((x) => !x);
  if (free < 0) return null;
  inv[free] = item;
  return [free];
}

// body: {action:'add', itemId, count, prefixItemId, suffixItemId}
//       {action:'remove', index, count}   {action:'affix', index, prefixItemId, suffixItemId}
//       {action:'count', index, count}    (sets the stack size of a stackable item)
function editItems(game, ch, body) {
  const p = game.playersById.get(ch.id);
  const changed = []; const done = [];
  if (body.action === 'add') {
    const t = cat.getTemplate(Number(body.itemId));
    if (!t) throw new Error('没有这个物品：' + body.itemId);
    const slot = cat.slotForTemplate(t);
    const count = intIn(body.count === undefined ? 1 : body.count, 1, slot ? 40 : 9999, '数量');
    // Equipment does not stack: one bag slot each.
    for (let n = 0; n < (slot ? count : 1); n += 1) {
      const item = C.makeItem(ch, t.itemId, slot ? 1 : count);
      if (slot && (body.prefixItemId || body.suffixItemId)) setAffix(item, { prefixItemId: body.prefixItemId || null, suffixItemId: body.suffixItemId || null });
      const at = putInBag(ch, item);
      if (!at) { if (!n) throw new Error('背包满了'); done.push('背包满了，只放进 ' + n + ' 件'); break; }
      changed.push(...at);
      if (!n) done.push('放入背包：' + item.name + (slot ? (count > 1 ? ' ×' + count : '') : ' ×' + count));
    }
  } else if (body.action === 'remove' || body.action === 'affix' || body.action === 'count') {
    const index = intIn(body.index, 0, ch.inventory.length - 1, '格子');
    const it = ch.inventory[index];
    if (!it) throw new Error('这个格子是空的');
    if (body.action === 'remove') {
      const count = body.count === undefined ? it.count || 1 : intIn(body.count, 1, it.count || 1, '数量');
      if (count >= (it.count || 1)) ch.inventory[index] = null; else it.count -= count;
      done.push('删除：' + it.name + ' ×' + count);
    } else if (body.action === 'count') {
      if (cat.slotForTemplate(cat.getTemplate(it.itemId))) throw new Error('装备不能叠加，不能改数量');
      const count = intIn(body.count, 1, 9999, '数量');
      done.push('数量：' + it.name + ' ' + (it.count || 1) + ' → ' + count);
      it.count = count;
    } else {
      if (!cat.slotForTemplate(cat.getTemplate(it.itemId))) throw new Error('只有装备可以加前后缀');
      const before = it.name;
      setAffix(it, body);
      done.push('前后缀：' + before + ' → ' + it.name);
    }
    changed.push(index);
  } else throw new Error('不认识的操作');
  if (p) {
    p.commitItems({ inv: changed });
    p.send(game.op.CHAT_MESSAGE, game.systemChat('管理员修改了你的背包：' + done.join('，')));
  } else {
    ch.revision = (ch.revision || 0) + 1;
  }
  game.store.markDirty();
  return done;
}

function accountsList(game) {
  const chars = game.store.data.characters;
  return Object.values(game.store.data.accounts)
    .sort((a, b) => (b.lastLoginAt || b.createdAt || 0) - (a.lastLoginAt || a.createdAt || 0))
    .map((a) => ({
      id: a.id, email: a.email, banned: !!a.banned, createdAt: a.createdAt, lastLoginAt: a.lastLoginAt || null,
      servicePoints: a.servicePoints == null ? game.config.startServicePoints : a.servicePoints, pointsGranted: a.servicePoints != null,
      characters: Object.values(a.characters || {}).map((id) => chars[id]).filter(Boolean).map((ch) => summary(game, ch)),
    }));
}

// Applies an edit to a character. Every field is optional.
function editCharacter(game, ch, body) {
  const p = game.playersById.get(ch.id);
  const done = [];
  const before = C.combatLevel(ch);
  if (body.profession !== undefined && body.profession !== ch.profession) {
    const models = protocol.PROFESSION_MODEL_OPTIONS;
    if (!models[body.profession]) throw new Error('没有这个职业：' + body.profession);
    ch.profession = body.profession;
    ch.professionExp = Object.assign({ [body.profession]: 0 }, ch.professionExp);
    ch.appearance = Object.assign({}, ch.appearance, { model: C.modelFor(body.profession, ch.appearance && ch.appearance.gender, ch.appearance && ch.appearance.model) });
    done.push('职业 → ' + C.PROFESSION_LABELS[body.profession]);
  }
  if (body.combatExp !== undefined) { ch.combatExp = intIn(body.combatExp, 0, Number.MAX_SAFE_INTEGER, '战斗经验'); done.push('战斗经验 → ' + ch.combatExp); }
  if (body.combatLevel !== undefined) {
    const L = intIn(body.combatLevel, 1, C.LEVEL_CAP, '战斗等级');
    ch.combatExp = C.cumulativeExpForLevel(L);
    if (Number.isInteger(ch.combatLevelLock)) ch.combatLevelLock = L;
    done.push('战斗等级 → ' + L);
  }
  if (body.combatLevelLock !== undefined) {
    ch.combatLevelLock = body.combatLevelLock ? C.combatLevel(Object.assign({}, ch, { combatLevelLock: null })) : null;
    done.push(ch.combatLevelLock ? '锁定战斗等级在 ' + ch.combatLevelLock : '解除等级锁定');
  }
  const prof = ch.profession;
  if (body.professionExp !== undefined) {
    ch.professionExp = Object.assign({}, ch.professionExp, { [prof]: intIn(body.professionExp, 0, Number.MAX_SAFE_INTEGER, '职业经验') });
    done.push('职业经验 → ' + ch.professionExp[prof]);
  }
  if (body.professionLevel !== undefined) {
    const L = intIn(body.professionLevel, 1, C.LEVEL_CAP, '职业等级');
    ch.professionExp = Object.assign({}, ch.professionExp, { [prof]: C.cumulativeExpForLevel(L) });
    done.push('职业等级 → ' + L);
  }
  if (body.communityExp !== undefined) { ch.communityExp = intIn(body.communityExp, 0, Number.MAX_SAFE_INTEGER, '社区经验'); done.push('社区经验 → ' + ch.communityExp); }
  if (body.gold !== undefined) { ch.gold = intIn(body.gold, 0, MAX_GOLD, '金钱'); done.push('金钱 → ' + ch.gold); }
  let skillPoints = body.skillPoints === undefined ? undefined : intIn(body.skillPoints, 0, 100000, '技能点');
  if (body.combatSkills && typeof body.combatSkills === 'object') {
    const names = { ranged_weapon: '远程', melee_weapon: '近身', mechanics: '机械', magic: '魔法', quick_heal: '快速愈合', judgement: '判断力' };
    const next = Object.assign({}, ch.combatSkills);
    for (const [k, v] of Object.entries(body.combatSkills)) {
      if (!C.COMBAT_SKILL_IDS.includes(k)) throw new Error('没有这个战斗技能：' + k);
      next[k] = intIn(v, 0, C.SKILL_LEVEL_CAP, names[k]);
    }
    const spent = Object.values(next).reduce((n, v) => n + (Number(v) || 0), 0);
    if (spent > C.SKILL_POINT_TOTAL_CAP) throw new Error('战斗技能加起来最多 ' + C.SKILL_POINT_TOTAL_CAP + ' 点，现在是 ' + spent + ' 点');
    const changed = C.COMBAT_SKILL_IDS.filter((k) => (next[k] || 0) !== ((ch.combatSkills && ch.combatSkills[k]) || 0));
    if (changed.length) {
      ch.combatSkills = next;
      done.push('战斗技能 → ' + changed.map((k) => names[k] + ' ' + next[k]).join('，'));
      // Unspent points never push the total past the cap.
      if (skillPoints === undefined && (ch.skillPoints || 0) + spent > C.SKILL_POINT_TOTAL_CAP) skillPoints = C.SKILL_POINT_TOTAL_CAP - spent;
    }
  }
  // Twelfth batch: the five craft proficiencies, by level (the exp becomes that level's start).
  if (body.craftLevels && typeof body.craftLevels === 'object') {
    const st = D.craftState(ch);
    for (const [k, v] of Object.entries(body.craftLevels)) {
      if (!CRAFT_NAMES[k]) throw new Error('没有这个工匠技能：' + k);
      const L = intIn(v, 1, D.SKILL_CAP, CRAFT_NAMES[k]);
      if (D.skillLevel(st[k].exp) === L) continue;
      st[k].exp = D.skillTotals[L];
      done.push(CRAFT_NAMES[k] + ' → ' + L + ' 级（' + D.skillTitle(L) + '）');
    }
    if (p) p.paramsDirty = true;
  }
  if (body.cloudDays !== undefined) {
    const days = Number(body.cloudDays);
    if (!Number.isFinite(days) || days < 0 || days > 3650) throw new Error('筋斗云剩余天数须在 0–3650 之间');
    ch.mounts = Object.assign({}, ch.mounts, { cloudUntil: days > 0 ? Date.now() + Math.round(days * 864e5) : 0 });
    if (!days && ch.mounts.riding === 'cloud') ch.mounts.riding = null;
    done.push(days > 0 ? '筋斗云剩余 ' + days + ' 天' : '收回筋斗云');
  }
  if (body.name !== undefined && body.name !== ch.name) {
    const name = String(body.name).trim();
    if (p) throw new Error('角色在线时不能改名，请先让他下线');
    if (!name || Array.from(name).length > 16) throw new Error('名字须为 1–16 个字');
    const taken = Object.values(game.store.data.characters).some((c) => c !== ch && c.world === ch.world && c.name.toLowerCase() === name.toLowerCase());
    if (taken) throw new Error('同一区里已有叫「' + name + '」的角色');
    ch.name = name; done.push('名字 → ' + name);
  }
  if (!done.length && skillPoints === undefined) return done;
  const levelChanged = C.combatLevel(ch) !== before;
  const gained = C.settleLevelPoints(ch);
  // A skill point count typed in by hand wins over the level-up points.
  if (skillPoints !== undefined) {
    const max = Math.max(0, C.SKILL_POINT_TOTAL_CAP - C.spentSkillPoints(ch));
    ch.skillPoints = Math.min(skillPoints, max);
    done.push('技能点 → ' + ch.skillPoints + (skillPoints > max ? '（已分配 ' + C.spentSkillPoints(ch) + ' 点，总数最多 ' + C.SKILL_POINT_TOTAL_CAP + ' 点）' : ''));
  } else if (gained) done.push('升级获得 ' + gained + ' 点技能点');
  const unfit = C.unequipUnfit(ch);
  if (unfit.moved.length) done.push('不符合要求的装备放回背包：' + unfit.moved.join('、'));
  if (unfit.stuck.length) done.push('背包满了，没能卸下：' + unfit.stuck.join('、'));
  if (p) {
    if (body.cloudDays !== undefined && game.features.mounts) game.features.mounts.sendState(p);
    p.recompute(true);
    if (levelChanged || body.profession !== undefined) { p.ch.hp = p.stats.maxHp; p.ch.stamina = p.stats.maxStamina; }
    if (unfit.moved.length) p.commitItems({ inv: unfit.inv, equip: unfit.equip, params: false });
    p.paramsDirty = true;
    p.flushParams();
    p.markDirty();
    p.send(game.op.CHAT_MESSAGE, game.systemChat('管理员修改了你的角色：' + done.join('，')));
  } else {
    const stats = C.computeStats(ch);
    if (levelChanged) { ch.hp = stats.maxHp; ch.stamina = stats.maxStamina; }
    ch.hp = Math.min(ch.hp, stats.maxHp); ch.stamina = Math.min(ch.stamina, stats.maxStamina);
  }
  game.store.markDirty();
  return done;
}

function editAccount(game, acc, body) {
  const done = [];
  if (body.banned !== undefined) {
    acc.banned = !!body.banned;
    done.push(acc.banned ? '已封禁' : '已解封');
    if (acc.banned) for (const id of Object.values(acc.characters || {})) kick(game, id, '你的账号已被封禁。');
  }
  if (body.password !== undefined) {
    if (!validPassword(body.password)) throw new Error('密码须为 8–128 个字符');
    acc.password = hashPassword(body.password);
    done.push('密码已重置');
  }
  if (body.servicePoints !== undefined) {
    acc.servicePoints = intIn(body.servicePoints, 0, 1e9, '服务点');
    done.push('服务点已改为 ' + acc.servicePoints);
  }
  if (done.length) game.store.markDirty();
  return done;
}

// Deletes the account and all its characters for good: the e-mail can register
// again. Online characters are kicked first; their party place, stall, bank safe
// and garden plots are released.
function deleteAccount(game, acc) {
  const data = game.store.data;
  const f = game.features;
  const names = [];
  for (const id of Object.values(acc.characters || {})) {
    const ch = data.characters[id];
    if (!ch) continue;
    names.push(ch.name);
    kick(game, id, '你的账号已被管理员删除。');
    const party = f.party && f.party.partyOf(id);
    if (party) f.party.removeMember(party, id, ch.name + ' 离开了队伍。');
    const stall = f.interaction && f.interaction.stalls[id];
    if (stall) { delete f.interaction.stalls[id]; f.interaction.stallChanged(stall, true); }
    const coffers = game.store.bucket('bankCoffers');
    for (const [n, c] of Object.entries(coffers)) if (c && c.ownerId === id) delete coffers[n];
    for (const plots of Object.values(game.store.bucket('gardens'))) {
      for (const [k, plot] of Object.entries(plots || {})) if (plot && plot.ownerId === id) delete plots[k];
    }
    delete data.characters[id];
  }
  // Sessions still on the character screen hold the account object too.
  for (const sess of game.sessions.values ? game.sessions.values() : game.sessions) {
    if (sess.account === acc) { sess.account = null; sess.close(4002, 'admin'); }
  }
  delete data.accounts[acc.email];
  game.store.markDirty();
  return ['已删除账号 ' + acc.email + (names.length ? '，以及角色：' + names.join('、') : '')];
}

function kick(game, charId, why) {
  const p = game.playersById.get(charId);
  if (!p) return false;
  p.send(game.op.CHAT_MESSAGE, game.systemChat(why));
  const s = p.session;
  game.leaveWorld(p, 'admin');
  s.player = null; s.account = null;
  s.close(4002, 'admin');
  return true;
}

// ---------- character export / import ----------
// The file holds the whole character record (bag, gear, levels, skills, gold, looks...).
// The bank safe, stall and garden plots belong to the account or the world and stay out.
const CHAR_FORMAT = 'qiyu-character';
const KEEP_ON_IMPORT = ['id', 'accountId', 'world', 'name', 'createdAt'];
const IMPORT_LIMIT = 8 * 1024 * 1024;

function exportCharacter(game, ch) {
  const p = game.playersById.get(ch.id);
  const rec = JSON.parse(JSON.stringify(p ? p.ch : ch));
  if (p) { rec.mapRef = p.scene.mapRef; rec.x = Math.round(p.x); rec.y = Math.round(p.y); }
  return { format: CHAR_FORMAT, version: 1, exportedAt: new Date().toISOString(), name: ch.name, character: rec };
}

// Checks an exported file and returns a clean copy of its character record plus notes.
function readCharacterFile(game, file) {
  const rec = file && file.format === CHAR_FORMAT && file.character;
  if (!rec || typeof rec !== 'object') throw new Error('文件格式不对：请选择从这里导出的角色文件');
  if (!protocol.PROFESSION_MODEL_OPTIONS[rec.profession]) throw new Error('文件里的职业无效：' + rec.profession);
  const notes = [];
  const out = JSON.parse(JSON.stringify(rec));
  const keepItem = (it) => {
    if (!it) return null;
    if (!cat.getTemplate(Number(it.itemId))) { notes.push('去掉了这个服务端没有的物品 ' + (it.name || it.itemId)); return null; }
    A.migrateItem(it);
    return it;
  };
  const inv = Array.isArray(out.inventory) ? out.inventory.slice(0, C.INV_SIZE) : [];
  while (inv.length < C.INV_SIZE) inv.push(null);
  out.inventory = inv.map(keepItem);
  const eq = {};
  for (const slot of cat.EQUIP_SLOTS) eq[slot] = keepItem(out.equipment && out.equipment[slot]);
  out.equipment = eq;
  out.gold = Math.max(0, Math.min(MAX_GOLD, Math.floor(Number(out.gold) || 0)));
  if (!out.mapRef || !game.maps.get(String(out.mapRef).split('|').pop())) {
    const map = game.maps.get(game.config.defaultMap);
    const sp = map.spawnPoint();
    out.mapRef = map.id; out.x = sp.x; out.y = sp.y;
  }
  out.revision = (Number(out.revision) || 1) + 1;
  return { rec: out, notes };
}

// Replaces an existing character with the file's; it keeps its id, account, world and name.
function importIntoCharacter(game, ch, file) {
  const { rec, notes } = readCharacterFile(game, file);
  kick(game, ch.id, '管理员正在导入角色数据，请重新登录。');
  for (const k of Object.keys(ch)) if (!KEEP_ON_IMPORT.includes(k)) delete ch[k];
  for (const [k, v] of Object.entries(rec)) if (!KEEP_ON_IMPORT.includes(k)) ch[k] = v;
  ch.revision = Math.max(ch.revision || 1, 1) + 1;
  game.store.markDirty();
  return ['已把 ' + (file.name || rec.name || '文件里的角色') + ' 的数据导入到角色 ' + ch.name].concat(notes);
}

// Adds the file's character to an account, in a world where it has none yet.
function importNewCharacter(game, acc, file, body) {
  const { rec, notes } = readCharacterFile(game, file);
  const world = String(body.world || game.config.defaultWorld);
  if (!game.config.worlds.includes(world)) throw new Error('没有这个区服：' + world);
  acc.characters = acc.characters || {};
  if (acc.characters[world]) throw new Error('这个账号在区服 ' + world + ' 已经有角色了，请选择别的区服，或者在角色页面里用「导入覆盖」');
  const name = String(body.name || rec.name || '').trim();
  if (!name || name.length > 12) throw new Error('角色名不能为空，最多 12 个字');
  const data = game.store.data;
  if (Object.values(data.characters).some((c) => c.world === world && c.name.toLowerCase() === name.toLowerCase())) throw new Error('区服 ' + world + ' 里已经有叫「' + name + '」的角色，请换个名字');
  const id = 'p' + game.store.nextId('character');
  const ch = Object.assign(rec, { id, accountId: acc.id, world, name, createdAt: Date.now() });
  data.characters[id] = ch;
  acc.characters[world] = id;
  game.store.markDirty();
  return { id, done: ['已为 ' + acc.email + ' 在区服 ' + world + ' 导入角色 ' + name].concat(notes) };
}

// ---------- account export / import ----------
// One file with the account record (password hash included), every character of
// it and their bank coffers. Gardens and stalls belong to the world and stay out.
const ACC_FORMAT = 'qiyu-account';

function exportAccount(game, acc) {
  const data = game.store.data;
  const rec = JSON.parse(JSON.stringify(acc));
  const chars = [];
  for (const [world, id] of Object.entries(acc.characters || {})) {
    const ch = data.characters[id];
    if (ch) chars.push(Object.assign(exportCharacter(game, ch).character, { world }));
  }
  const ids = new Set(chars.map((c) => c.id));
  const coffers = Object.values(game.store.bucket('bankCoffers')).filter((c) => c && ids.has(c.ownerId)).map((c) => JSON.parse(JSON.stringify(c)));
  delete rec.characters;
  return { format: ACC_FORMAT, version: 1, exportedAt: new Date().toISOString(), email: acc.email, account: rec, characters: chars, coffers };
}

function readAccountFile(file) {
  if (!file || file.format !== ACC_FORMAT || !file.account || !Array.isArray(file.characters)) throw new Error('文件格式不对：请选择从这里导出的账号文件');
  return file;
}

// mode: 'check' (only tells whether the e-mail is taken), 'overwrite' (the existing
// account with that e-mail is deleted first), 'skip', or 'rename' (body.email = new e-mail).
function importAccount(game, body) {
  const file = readAccountFile(body.file);
  const accounts = game.accounts;
  const mode = String(body.mode || 'check');
  let email = accounts.normalizeEmail(mode === 'rename' ? body.email : file.email);
  const existing = accounts.find(email);
  if (mode === 'check') return { exists: !!existing, email, characters: file.characters.map((c) => c.name) };
  if (mode === 'skip') return { done: ['已跳过：账号 ' + email + ' 已存在，什么都没改'] };
  if (!EMAIL_RE.test(email)) throw new Error('邮箱地址格式不正确');
  if (existing && mode !== 'overwrite') throw new Error('邮箱 ' + email + ' 已经被别的账号使用了');
  // Read every character first, so a bad file changes nothing.
  const read = file.characters.map((c) => Object.assign(readCharacterFile(game, { format: CHAR_FORMAT, character: c }), { world: String(c.world || game.config.defaultWorld), oldId: c.id }));
  for (const r of read) if (!game.config.worlds.includes(r.world)) throw new Error('文件里的角色 ' + r.rec.name + ' 在未知的区服 ' + r.world);
  const done = [];
  if (existing) done.push.apply(done, deleteAccount(game, existing));
  const data = game.store.data;
  const acc = Object.assign(JSON.parse(JSON.stringify(file.account)), { id: 'a' + game.store.nextId('account'), email, characters: {} });
  data.accounts[email] = acc;
  const idMap = {};
  const notes = [];
  for (const r of read) {
    if (acc.characters[r.world]) { notes.push('区服 ' + r.world + ' 有两个角色，跳过了 ' + r.rec.name); continue; }
    let name = String(r.rec.name || '角色').slice(0, 12);
    const taken = (n) => Object.values(data.characters).some((c) => c.world === r.world && c.name.toLowerCase() === n.toLowerCase());
    for (let i = 2; taken(name); i++) name = String(r.rec.name).slice(0, 12 - String(i).length) + i;
    if (name !== r.rec.name) notes.push('区服 ' + r.world + ' 已有叫「' + r.rec.name + '」的角色，导入后改名为「' + name + '」');
    const id = 'p' + game.store.nextId('character');
    data.characters[id] = Object.assign(r.rec, { id, accountId: acc.id, world: r.world, name });
    acc.characters[r.world] = id;
    idMap[r.oldId] = id;
    notes.push.apply(notes, r.notes);
  }
  const coffers = game.store.bucket('bankCoffers');
  let nc = 0;
  for (const c of Array.isArray(file.coffers) ? file.coffers : []) {
    if (!c || !idMap[c.ownerId]) continue;
    const copy = JSON.parse(JSON.stringify(c));
    copy.ownerId = idMap[c.ownerId];
    if (coffers[copy.number]) copy.number = game.features.bank.newNumber();
    copy.slots = (Array.isArray(copy.slots) ? copy.slots : []).map((it) => (it && cat.getTemplate(Number(it.itemId)) ? (A.migrateItem(it), it) : null));
    coffers[copy.number] = copy;
    nc++;
  }
  game.store.markDirty();
  done.push('已导入账号 ' + email + '：角色 ' + Object.keys(acc.characters).length + ' 个，银行保险箱 ' + nc + ' 个');
  return { done: done.concat(notes), accounts: accountsList(game) };
}

function blindBoxList(game) {
  const items = game.features.items;
  return Array.from(cat.blindBoxes.values()).map((b) => {
    const { custom, pool } = items.blindBoxPool(b.itemId);
    return {
      itemId: b.itemId, name: b.name, buyPrice: b.buyPrice, custom,
      pool: pool.map((e) => { const t = cat.getTemplate(e.itemId); return { itemId: e.itemId, weight: e.weight, name: t.name, equipPos: t.equipPos }; }),
    };
  });
}

// An imported settings file replaces every custom blind box list (boxes it
// does not list go back to their default contents). Validates before changing anything.
function importBlindBoxPools(game, pools) {
  const items = game.features.items;
  for (const [id, pool] of Object.entries(pools)) {
    if (!cat.blindBoxes.has(Number(id))) throw new Error('导入文件里有未知的盲盒 ' + id);
    if (!Array.isArray(pool) || !pool.length) throw new Error('导入文件里盲盒 ' + id + ' 的内容是空的');
    for (const e of pool) if (!cat.getTemplate(Number(e && e.itemId)) || !(Number(e.weight) > 0)) throw new Error('导入文件里盲盒 ' + id + ' 有无效的物品');
  }
  for (const id of Object.keys(game.store.bucket('blindBoxPools'))) items.setBlindBoxPool(id, null);
  for (const [id, pool] of Object.entries(pools)) items.setBlindBoxPool(id, pool);
}

function createAdminHandler(game, auth) {
  return async function handleAdmin(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1); // the admin port serves it from /
    try {
      if (parts[0] === 'api' && parts[1] === 'login' && req.method === 'POST') {
        const r = auth.login(clientIp(req), String((await readJson(req)).password || ''));
        if (!r.ok) return send(res, 401, { error: r.error });
        res.setHeader('Set-Cookie', r.cookie);
        return send(res, 200, { done: ['已登录'] });
      }
      if (!auth.ok(req)) {
        if (parts[0] === 'api') return send(res, 401, { error: '请先登录管理后台', login: true });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(LOGIN_PAGE);
      }
      if (parts[0] === 'api' && parts[1] === 'logout' && req.method === 'POST') {
        res.setHeader('Set-Cookie', auth.logout(req));
        return send(res, 200, { done: ['已退出'] });
      }
      if (!parts.length) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(PAGE, 'utf8').replace('<h1>奇域管理后台</h1>', '<h1>奇域管理后台 <small style="font-size:12px;font-weight:normal;opacity:.75">' + PATCH + '</small></h1>')
          .replace('</body>', '<script src="/admin-v12.js"></script>\n<script src="/admin-v15.js"></script>\n<script src="/admin-v152.js"></script>\n</body>'));
      }
      // Twelfth batch pages (items, maps and zones, formulas, wedding and teams, uploads).
      if (parts[0] === 'admin-v152.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(__dirname, 'admin-v152-page.js'), 'utf8'));
      }
      if (parts[0] === 'admin-v15.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(__dirname, 'admin-v15-page.js'), 'utf8'));
      }
      if (parts[0] === 'admin-v12.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(__dirname, 'admin-v12-page.js'), 'utf8'));
      }
      if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });
      const [, kind, rawId, action] = parts;
      const id = rawId === undefined ? undefined : decodeURIComponent(rawId);
      if (kind === 'meta' && req.method === 'GET') {
        return send(res, 200, { professions: Object.keys(protocol.PROFESSION_MODEL_OPTIONS).map((k) => ({ id: k, name: C.PROFESSION_LABELS[k] || k })), levelCap: C.LEVEL_CAP, online: game.playersById.size, worlds: game.config.worlds, defaultWorld: game.config.defaultWorld });
      }
      if (kind === 'items' && req.method === 'GET') return send(res, 200, { items: itemsCatalog(), categories: ITEM_CATEGORIES });
      if (kind === 'affixes' && req.method === 'GET') return send(res, 200, affixCatalog());
      if (kind === 'accounts' && req.method === 'GET') return send(res, 200, { accounts: accountsList(game) });
      if (kind === 'settings') {
        const st = game.features.settings;
        if (req.method === 'GET' && id === 'export') {
          const file = { format: 'qiyu-server-settings', version: 1, exportedAt: new Date().toISOString(), values: st.exportValues(), blindBoxPools: JSON.parse(JSON.stringify(game.store.bucket('blindBoxPools'))), shops: game.features.shops.exportConfig(), attrSpreads: JSON.parse(JSON.stringify(game.store.bucket('attrSpreads'))), monsterConfig: JSON.parse(JSON.stringify(game.store.bucket('monsterConfig'))), batch15: game.features.batch15 ? game.features.batch15.exportConfig() : undefined, batch152: game.features.batch152 ? game.features.batch152.exportConfig() : undefined };
          const name = 'qiyu-settings-' + new Date().toISOString().slice(0, 10) + '.json';
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="' + name + '"' });
          return res.end(JSON.stringify(file, null, 2));
        }
        if (req.method === 'GET') return send(res, 200, st.view());
        if (req.method === 'POST' && id === 'reset') {
          const done = st.reset();
          const pools = game.store.bucket('blindBoxPools');
          if (Object.keys(pools).length) { for (const b of Object.keys(pools)) game.features.items.setBlindBoxPool(b, null); done.push('盲盒内容'); }
          if (game.features.shops.hasCustom()) { game.features.shops.reset(); done.push('商人商品和价格'); }
          if (game.features.batch15 && game.features.batch15.hasCustom()) { game.features.batch15.reset(); done.push('屠龙与卡片'); }
          if (game.features.batch152 && game.features.batch152.hasCustom()) { game.features.batch152.reset(); done.push('限时活动'); }
          return send(res, 200, { done, settings: st.view() });
        }
        if (req.method === 'POST' && id === 'import') {
          const body = await readJson(req);
          const values = body && typeof body.values === 'object' && body.values ? body.values : null;
          if (!values) throw new Error('文件格式不对：找不到 values（请选择从这里导出的设置文件）');
          const known = {}, skipped = [];
          for (const [k, v] of Object.entries(values)) if (st.has(k)) known[k] = v; else skipped.push(k);
          if (body.blindBoxPools && typeof body.blindBoxPools === 'object') importBlindBoxPools(game, body.blindBoxPools);
          if (body.shops && typeof body.shops === 'object') game.features.shops.importConfig(body.shops);
          const bal = game.features.balance;
          const extra = [];
          if (body.attrSpreads && typeof body.attrSpreads === 'object') {
            bal.resetSpreads();
            for (const [prof, v] of Object.entries(body.attrSpreads)) bal.setSpread(prof, v);
            extra.push('职业默认属性');
          }
          if (body.monsterConfig && typeof body.monsterConfig === 'object') {
            bal.resetMonsters();
            for (const [mid, o] of Object.entries(body.monsterConfig.monsters || {})) bal.setMonster(mid, o);
            for (const [mid, o] of Object.entries(body.monsterConfig.maps || {})) bal.setMap(mid, o);
            // Fifteenth batch: the per-monster drops came along in the export but were not read back.
            if (body.monsterConfig.drops && typeof body.monsterConfig.drops === 'object') { bal.cfg.drops = JSON.parse(JSON.stringify(body.monsterConfig.drops)); game.store.markDirty(); }
            extra.push('怪物和地图怪物');
          }
          if (body.batch15 && typeof body.batch15 === 'object' && game.features.batch15) { game.features.batch15.importConfig(body.batch15); extra.push('屠龙与卡片'); }
          if (body.batch152 && typeof body.batch152 === 'object' && game.features.batch152) { game.features.batch152.importConfig(body.batch152); extra.push('限时活动'); }
          const done = st.set(known).concat(extra);
          if (body.blindBoxPools && typeof body.blindBoxPools === 'object') done.push('盲盒内容');
          if (body.shops && typeof body.shops === 'object') done.push('商人商品和价格');
          return send(res, 200, { done, skipped, settings: st.view() });
        }
        if (req.method === 'POST') { const body = await readJson(req); return send(res, 200, { done: st.set(body.values), settings: st.view() }); }
      }
      const bal = game.features.balance;
      if (kind === 'spreads' && req.method === 'GET') return send(res, 200, { spreads: bal.spreadView() });
      if (kind === 'spreads' && req.method === 'POST') {
        const body = await readJson(req);
        const done = body.resetAll ? bal.resetSpreads() : bal.setSpread(String(body.profession || ''), body.reset ? null : body.values);
        return send(res, 200, { done, spreads: bal.spreadView() });
      }
      if (kind === 'monsters' && req.method === 'GET') return send(res, 200, { monsters: bal.monstersView(), fields: bal.fieldsView() });
      if (kind === 'monsters' && req.method === 'POST' && id === 'reset') return send(res, 200, { done: bal.resetMonsters() });
      if (kind === 'monster' && req.method === 'POST') { const body = await readJson(req); return send(res, 200, { done: bal.setMonster(id, body.reset ? null : body.stats) }); }
      if (kind === 'maps' && req.method === 'GET') return send(res, 200, { maps: bal.mapsView() });
      if (kind === 'map' && req.method === 'POST') { const body = await readJson(req); return send(res, 200, { done: bal.setMap(id, body.reset ? null : body) }); }
      if (kind === 'accounts' && req.method === 'POST' && id === 'import') return send(res, 200, importAccount(game, await readJson(req, IMPORT_LIMIT * 4)));
      if (kind === 'account' && req.method === 'GET' && action === 'export') {
        const acc = Object.values(game.store.data.accounts).find((a) => a.id === id);
        if (!acc) return send(res, 404, { error: '没有这个账号' });
        const name = 'qiyu-account-' + acc.email + '-' + new Date().toISOString().slice(0, 10) + '.json';
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': "attachment; filename=\"account.json\"; filename*=UTF-8''" + encodeURIComponent(name) });
        return res.end(JSON.stringify(exportAccount(game, acc), null, 2));
      }
      if (kind === 'accounts' && req.method === 'POST' && id === 'create') {
        const body = await readJson(req);
        const r = game.accounts.create(body.email, body.password);
        if (!r.success) throw new Error(r.message);
        return send(res, 200, { done: [r.message], accounts: accountsList(game) });
      }
      if (kind === 'blindboxes' && req.method === 'GET') return send(res, 200, { boxes: blindBoxList(game) });
      if (kind === 'blindbox' && req.method === 'POST') {
        const body = await readJson(req);
        game.features.items.setBlindBoxPool(id, body.reset ? null : body.pool);
        return send(res, 200, { done: [body.reset ? '已恢复默认内容' : '已保存'], boxes: blindBoxList(game) });
      }
      if (kind === 'shops' && req.method === 'GET') return send(res, 200, Object.assign(game.features.shops.view(), { sellable: sellableItems() }));
      if (kind === 'shop' && req.method === 'GET') return send(res, 200, game.features.shops.detail(id));
      if (kind === 'shop' && req.method === 'POST') {
        const body = await readJson(req);
        const shops = game.features.shops;
        if (body.prices) shops.setPrices(body.prices);
        if (body.reset) shops.setItems(id, null); else if (body.items) shops.setItems(id, body.items);
        if (!body.reset && Array.isArray(body.special)) shops.setSpecial(id, body.special);
        return send(res, 200, { done: [body.reset ? '已恢复这个商人的默认商品' : '已保存'], detail: shops.detail(id), shops: shops.view() });
      }
      if (kind === 'restart' && req.method === 'GET') return send(res, 200, { left: game.restartLeft(), seconds: game.config.restartCountdownSec });
      if (kind === 'restart' && req.method === 'POST') {
        const body = await readJson(req);
        if (body.cancel) return send(res, 200, { done: [game.cancelRestart() ? '已取消重启' : '现在没有在倒计时'], left: null });
        const sec = game.scheduleRestart(body.seconds != null ? body.seconds : game.config.restartCountdownSec);
        return send(res, 200, { done: [sec ? '已通知全服，' + sec + ' 秒后重启' : '马上重启'], left: sec });
      }
      if (kind === 'announce' && req.method === 'POST') { const n = game.features.settings.announce((await readJson(req)).text); return send(res, 200, { done: ['公告已发送给 ' + n + ' 名在线玩家'] }); }
      if (kind === 'character') {
        const ch = game.store.data.characters[id];
        if (!ch) return send(res, 404, { error: '没有这个角色' });
        if (req.method === 'GET' && action === 'export') {
          const name = 'qiyu-character-' + ch.name + '-' + new Date().toISOString().slice(0, 10) + '.json';
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': "attachment; filename=\"character.json\"; filename*=UTF-8''" + encodeURIComponent(name) });
          return res.end(JSON.stringify(exportCharacter(game, ch), null, 2));
        }
        if (req.method === 'GET') return send(res, 200, detail(game, ch));
        if (req.method === 'POST' && action === 'import') { const done = importIntoCharacter(game, ch, await readJson(req, IMPORT_LIMIT)); return send(res, 200, { done, character: detail(game, ch) }); }
        if (req.method === 'POST' && action === 'items') { const done = editItems(game, ch, await readJson(req)); return send(res, 200, { done, character: detail(game, ch) }); }
        if (req.method === 'POST' && action === 'kick') return send(res, 200, { done: kick(game, ch.id, '你被管理员请下线。') ? ['已踢下线'] : ['角色不在线'], character: detail(game, ch) });
        if (req.method === 'POST') { const done = editCharacter(game, ch, await readJson(req)); return send(res, 200, { done, character: detail(game, ch) }); }
      }
      if (await require('./admin-v12').handle(game, { kind, id, action, req, url, readJson, send: (code, body) => send(res, code, body), res })) return undefined;
      if (kind === 'account' && req.method === 'POST') {
        const acc = Object.values(game.store.data.accounts).find((a) => a.id === id);
        if (!acc) return send(res, 404, { error: '没有这个账号' });
        if (action === 'delete') return send(res, 200, { done: deleteAccount(game, acc) });
        if (action === 'import') { const body = await readJson(req, IMPORT_LIMIT); return send(res, 200, importNewCharacter(game, acc, body.file, body)); }
        return send(res, 200, { done: editAccount(game, acc, await readJson(req)) });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  };
}

function resetItemLists() { itemList = null; sellableList = null; }

module.exports = { createAdminHandler, editCharacter, resetItemLists, itemCategory, ITEM_CATEGORIES };
