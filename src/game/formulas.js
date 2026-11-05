'use strict';
// Twelfth batch: character formulas as text, so the admin page can switch between sets
// and edit them. A set has one formula per value and profession group.
// - "网页版" (web) is the code in character.js computeStats (hidden attribute growth);
//   it is not text and cannot be edited.
// - "原版" (original) follows the official old client (com/wardata.fcc, research rounds
//   6-16): attack / break by profession branch with the profession multiplier, the
//   weapon-category skill multiplier, weight 2*S*(LV+10) with the 90% overweight line,
//   HP/MP percent stage. Values the old client does not reveal (base HP/MP growth,
//   defence, attack speed) keep the web rules without the hidden growth, marked 网页.
// - Custom sets start as a copy of 原版 and can be edited on the admin page.
// Grammar: numbers, variables, + - * / ( ), min(a, b, ...), max(...), floor(x).
// Nothing else is accepted, so a formula cannot run code.

const VARS = {
  S: '力量（含装备）', A: '敏捷（含装备）', P: '感知（含装备）', I: '聪明（含装备）', U: '运气（含装备）',
  LV: '战斗等级', J: '职业等级（原版公式里的 J；按现有资料理解为职业等级）',
  EA: '装备攻击', EB: '装备破坏', ED: '装备防御', EHP: '装备生命', EMP: '装备精力',
  HPP: '装备生命上限 %', MPP: '装备精力上限 %', ASP: '装备攻击速度 %',
  K: '当前武器对应的战斗技能点（含装备加的技能点）', WT: '武器类别：0 弓 1 刀剑 2 长枪 3 火枪 4 法器，-1 空手',
  WM: '武器熟练倍率：类别0–3为 (50+K)/50，类别4为 (50+K)/25，空手为 1',
  CAP: '后台「敏捷攻速上限」',
};
const KEYS = ['maxHp', 'maxStamina', 'attack', 'breakPower', 'defense', 'maxWeight', 'attackSpeed'];
const KEY_NAMES = { maxHp: '生命上限', maxStamina: '精力上限', attack: '攻击', breakPower: '破坏', defense: '防御', maxWeight: '负重上限', attackSpeed: '攻击速度（倍）' };
const GROUPS = ['warrior', 'archer', 'gunner', 'mage', 'other'];
const GROUP_NAMES = { warrior: '战士', archer: '猎人', gunner: '枪手', mage: '法师', other: '宝宝 / 工匠 / 园丁' };

const COMMON = {
  maxHp: '(100 + (LV - 1) * 18 + S * 3 + EHP) * (100 + HPP) / 100',
  maxStamina: '(60 + (LV - 1) * 6 + I * 2 + EMP) * (100 + MPP) / 100',
  defense: 'LV * 1.2 + A * 0.5 + ED',
  maxWeight: '2 * S * (LV + 10)',
  attackSpeed: 'min(CAP, 1 + A * 0.002) * (100 + ASP) / 100',
};
const ORIGINAL = {
  name: '原版', overweightPercent: 90,
  groups: {
    warrior: Object.assign({}, COMMON, { attack: '(20 + (S + 2 * A) * J / 10 + EA) * S * A / 100 * WM', breakPower: '(20 + (2 * S + A) * J / 10 + EB) * S * A / 100 * WM' }),
    archer: Object.assign({}, COMMON, { attack: '(20 + (A + 2 * P) * J / 10 + EA) * A * P / 100 * WM', breakPower: '(20 + (2 * A + P) * J / 10 + EB) * A * P / 100 * WM' }),
    gunner: Object.assign({}, COMMON, { attack: '(20 + (A + 2 * I) * J / 10 + EA) * A * I / 100 * WM', breakPower: '(20 + (2 * A + I) * J / 10 + EB) * A * I / 100 * WM' }),
    mage: Object.assign({}, COMMON, { attack: '(40 + (I + 2 * P) * J / 5 + EA) * I * P / 100 * WM', breakPower: '0' }),
    other: Object.assign({}, COMMON, { attack: '(20 + (A + 2 * P) * J / 10 + EA) * WM', breakPower: '(20 + (2 * A + P) * J / 10 + EB) * WM' }),
  },
  // Which formulas come from the old client and which are kept from the web version.
  sources: { attack: '原版', breakPower: '原版', maxWeight: '原版', maxHp: '网页基础 + 原版百分比阶段', maxStamina: '网页基础 + 原版百分比阶段', defense: '网页（原版未知）', attackSpeed: '网页（原版未知）' },
};

// ---------- parser ----------
function tokenize(src) {
  const out = []; let i = 0;
  const s = String(src || '');
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (/[0-9.]/.test(c)) { let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j += 1; const v = Number(s.slice(i, j)); if (!Number.isFinite(v)) throw new Error('数字写错了：' + s.slice(i, j)); out.push({ t: 'n', v }); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < s.length && /[A-Za-z_0-9]/.test(s[j])) j += 1; out.push({ t: 'id', v: s.slice(i, j) }); i = j; continue; }
    const map = { '×': '*', '÷': '/', '（': '(', '）': ')', '，': ',', '－': '-', '＋': '+' };
    const ch = map[c] || c;
    if ('+-*/(),'.includes(ch)) { out.push({ t: ch }); i += 1; continue; }
    throw new Error('不能用的符号：' + c);
  }
  return out;
}
const FUNCS = { min: (a) => Math.min(...a), max: (a) => Math.max(...a), floor: (a) => Math.floor(a[0]) };
function compile(src, vars = VARS) {
  const toks = tokenize(src); let k = 0;
  const peek = () => toks[k]; const take = (t) => { const x = toks[k]; if (!x || (t && x.t !== t)) throw new Error('公式不完整或括号不配对'); k += 1; return x; };
  function expr() { let n = term(); while (peek() && (peek().t === '+' || peek().t === '-')) { const op = take().t; const a = n, b = term(); n = op === '+' ? (v) => a(v) + b(v) : (v) => a(v) - b(v); } return n; }
  function term() { let n = unary(); while (peek() && (peek().t === '*' || peek().t === '/')) { const op = take().t; const a = n, b = unary(); n = op === '*' ? (v) => a(v) * b(v) : (v) => { const d = b(v); return d === 0 ? 0 : a(v) / d; }; } return n; }
  function unary() { if (peek() && peek().t === '-') { take(); const a = unary(); return (v) => -a(v); } if (peek() && peek().t === '+') { take(); return unary(); } return atom(); }
  function atom() {
    const x = take();
    if (x.t === 'n') return () => x.v;
    if (x.t === '(') { const e = expr(); take(')'); return e; }
    if (x.t === 'id') {
      const name = x.v;
      if (peek() && peek().t === '(') {
        const f = FUNCS[name.toLowerCase()];
        if (!f) throw new Error('只能用 min、max、floor，不能用 ' + name);
        take('('); const args = [expr()]; while (peek() && peek().t === ',') { take(); args.push(expr()); } take(')');
        return (v) => f(args.map((a) => a(v)));
      }
      if (!vars[name]) throw new Error('没有这个变量：' + name);
      return (v) => Number(v[name]) || 0;
    }
    throw new Error('公式写错了');
  }
  const fn = expr();
  if (k !== toks.length) throw new Error('公式后面多了内容');
  return fn;
}

// A set is checked by computing it for a sample character of each group.
const SAMPLE = { S: 8, A: 9, P: 7, I: 6, U: 4, LV: 30, J: 25, EA: 40, EB: 30, ED: 25, EHP: 50, EMP: 20, HPP: 10, MPP: 5, ASP: 10, K: 50, WT: 1, WM: 2, CAP: 1 };
function validateSet(set) {
  if (!set || typeof set !== 'object' || !set.groups) throw new Error('公式套格式不对');
  const name = String(set.name || '').trim();
  if (!name || name.length > 20) throw new Error('名字须为 1–20 个字');
  const ow = Number(set.overweightPercent);
  if (!(ow >= 10 && ow <= 200)) throw new Error('超重线须在 10–200% 之间');
  const sample = {};
  for (const g of GROUPS) {
    const row = set.groups[g];
    if (!row) throw new Error('缺少 ' + GROUP_NAMES[g] + ' 的公式');
    sample[g] = {};
    for (const key of KEYS) {
      let fn;
      try { fn = compile(row[key]); } catch (e) { throw new Error(GROUP_NAMES[g] + ' · ' + KEY_NAMES[key] + '：' + e.message); }
      const v = fn(SAMPLE);
      if (!Number.isFinite(v)) throw new Error(GROUP_NAMES[g] + ' · ' + KEY_NAMES[key] + '：样例角色算不出数');
      sample[g][key] = Math.round(v * 100) / 100;
    }
  }
  return sample;
}

const cache = new Map();
function compiled(src) {
  let f = cache.get(src);
  if (!f) { f = compile(src); cache.set(src, f); }
  return f;
}
function groupOf(profession) { return GROUPS.includes(profession) ? profession : 'other'; }
function weaponType(itemId) { const id = Number(itemId) || 0; return id < 768 ? 0 : id < 896 ? 1 : id < 1024 ? 2 : id < 3328 ? 3 : 4; }
const WEAPON_SKILL = ['ranged_weapon', 'melee_weapon', 'melee_weapon', 'mechanics', 'magic'];

// Values of one group for the variables v.
function evaluate(set, profession, v) {
  const row = set.groups[groupOf(profession)];
  const out = {};
  for (const key of KEYS) { const x = compiled(row[key])(v); out[key] = Number.isFinite(x) ? x : 0; }
  return out;
}

module.exports = { VARS, KEYS, KEY_NAMES, GROUPS, GROUP_NAMES, ORIGINAL, SAMPLE, compile, validateSet, evaluate, weaponType, WEAPON_SKILL, groupOf };
