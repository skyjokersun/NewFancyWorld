'use strict';
// Long-term team (长期团队, twelfth batch), after the old client's team2003 scripts.
// Original rules:
// - Apply at the 团队事务厅 (office_team, tm_request): account with at least
//   teamApplyMinPoints (500) service points, teamApplyGold (3000) gold and community
//   (combat) level teamApplyLevel (10). Applying charges teamApplyPoints (100) points and
//   teamApplyGold gold; a rejected application gets both back.
// - Staff approve it and give the team a building (team_r_*: 风云会 / 乐翻天 / 论剑堂 /
//   尚文轩 / 听雨阁 / 聚义堂, 壹号楼 / 贰号楼) and a door (亚龙组 / 白虎团 / 飞麒社 / 雾峰帮).
//   teamAutoApprove approves at once and picks the emptiest building and door.
// - Rent teamRentPoints (100) points per 30 days from the team's points, which members
//   donate (at most 1000 a time; 新人 cannot donate). The first month is the application.
// - Coffer: gold up to 1e8, a 6-digit password; the leader sets it, leader and vice
//   leaders take gold out with it.
// - The meeting table holds posts of at most 100 characters.
// - Logo 16x16; changing it costs teamLogoPoints (500); up to 10 kept.
// - Leaving: no other team for 7 days.
// Ours (not in the old client): arrears grace teamGraceDays then suspended, contribution
// (1 per donated point, 1 per 1000 gold deposited), team level from contribution,
// member cap teamBaseMembers + 10 per level.
// Patch 104 is the client side.
const C = require('../game/character');

const BUILDINGS = {
  team_r_f1: '风云会壹号楼', team_r_f2: '风云会贰号楼', team_r_lf1: '乐翻天壹号楼', team_r_lf2: '乐翻天贰号楼',
  team_r_lj1: '论剑堂壹号楼', team_r_lj2: '论剑堂贰号楼', team_r_s1: '尚文轩壹号楼', team_r_s2: '尚文轩贰号楼',
  team_r_t1: '听雨阁壹号楼', team_r_t2: '听雨阁贰号楼', team_r_j1: '聚义堂壹号楼', team_r_j2: '聚义堂贰号楼',
};
const DOORS = ['亚龙组', '白虎团', '飞麒社', '雾峰帮'];
const DOOR_AT = { 亚龙组: { x: 111, y: 293 }, 白虎团: { x: 302, y: 197 }, 飞麒社: { x: 744, y: 156 }, 雾峰帮: { x: 1032, y: 300 } };
const OFFICE = 'teamoffice';
const OFFICE_SPAWN = { x: 200, y: 400 };
const ROLES = { leader: '队长', vice: '副队长', member: '队员', newbie: '新人' };
const DAY = 864e5, MONTH = 30 * DAY, REJOIN_MS = 7 * DAY;
const COFFER_CAP = 1e8, DONATE_MAX = 1000;
const LEVELS = [0, 1000, 3000, 6000, 10000, 15000, 21000, 28000, 36000, 45000];

function fmtTime(t) { return new Date(t).toLocaleString('zh-CN', { hour12: false, timeZone: process.env.TZ || 'Asia/Shanghai' }); }
function levelOf(contrib) { let l = 1; for (let i = 1; i < LEVELS.length; i++) if (contrib >= LEVELS[i]) l = i + 1; return l; }

class Teams {
  register(server) {
    this.server = server;
    const on = (k, fn) => server.ext.on(k, (p, d) => fn.call(this, p, d || {}));
    on('team_query', (p) => this.sendState(p));
    on('team_apply', this.apply);
    on('team_join', this.join);
    on('team_leave', this.leave);
    on('team_door', this.door);
    on('team_enter', this.enter);
    on('team_exit', this.exit);
    on('team_member', this.member);
    on('team_donate', this.donate);
    on('team_coffer', this.coffer);
    on('team_post', this.post);
    on('team_logo', this.logo);
    on('team_notice', this.notice);
    server.events.on('playerEntered', (p) => this.onEntered(p));
    this.lastTick = 0;
    server.events.on('tick', (now) => { if (now - this.lastTick >= 60e3) { this.lastTick = now; this.rent(now); } });
  }

  cfg(key, def) { const v = this.server.config[key]; return typeof def === 'boolean' ? (v == null ? def : !!v) : (Number.isFinite(Number(v)) ? Number(v) : def); }
  data() {
    const b = this.server.store.bucket('teams');
    if (!b.teams) b.teams = {};
    if (!b.left) b.left = {};
    if (!b.notes) b.notes = {};
    if (!b.refunds) b.refunds = {};
    if (!b.nextId) b.nextId = 1;
    return b;
  }
  teamOf(chId) {
    for (const t of Object.values(this.data().teams)) if (t.members[chId] || (t.status === 'pending' && t.leaderId === chId)) return t;
    return null;
  }
  roleOf(t, chId) { const m = t && t.members[chId]; return m ? m.role : null; }
  can(t, chId, what) {
    const r = this.roleOf(t, chId);
    if (what === 'manage') return r === 'leader' || r === 'vice';
    if (what === 'donate') return !!r && r !== 'newbie';
    return r === 'leader';
  }
  points(p) { return this.server.features.bank.points(p); }
  pay(p, n) { p.session.account.servicePoints = this.points(p) - n; this.server.store.markDirty(); }
  online(id) { return this.server.playersById.get(id) || null; }
  tell(p, text) { this.server.ext.tell(p, text); }
  dirty() { this.server.store.markDirty(); }
  cap(t) { return this.cfg('teamBaseMembers', 30) + 10 * (levelOf(t.contribution || 0) - 1); }
  isActive(t) { return t.status === 'active' || t.status === 'arrears'; }

  publicTeam(t) {
    const lvl = levelOf(t.contribution || 0);
    return {
      id: t.id, name: t.name, purpose: t.purpose, status: t.status, leader: (t.members[t.leaderId] || {}).name || t.leaderName,
      building: t.building, buildingName: BUILDINGS[t.building] || '', door: t.door, members: Object.keys(t.members).length, cap: this.cap(t),
      level: lvl, nextLevel: LEVELS[lvl] || null, contribution: t.contribution || 0, logo: t.logo || '', world: t.world,
    };
  }
  view(p, t) {
    const own = this.teamOf(p.id);
    const out = {
      points: this.points(p), gold: p.ch.gold,
      prices: { minPoints: this.cfg('teamApplyMinPoints', 500), points: this.cfg('teamApplyPoints', 100), gold: this.cfg('teamApplyGold', 3000), level: this.cfg('teamApplyLevel', 10), rent: this.cfg('teamRentPoints', 100), logo: this.cfg('teamLogoPoints', 500) },
      leftUntil: Math.max(0, (this.data().left[p.id] || 0) - Date.now()) ? this.data().left[p.id] : 0,
      teams: Object.values(this.data().teams).filter((x) => x.world === p.ch.world && this.isActive(x)).map((x) => this.publicTeam(x)),
      mine: null,
    };
    if (own) {
      const role = this.roleOf(own, p.id);
      out.mine = Object.assign(this.publicTeam(own), {
        role: role || 'applicant', roleName: ROLES[role] || '申请中',
        teamPoints: own.points || 0, paidUntil: own.paidUntil || 0, paidText: own.paidUntil ? fmtTime(own.paidUntil) : '',
        daysLeft: own.paidUntil ? Math.ceil((own.paidUntil - Date.now()) / DAY) : 0,
        coffer: own.coffer || 0, hasPassword: !!own.password, notice: own.notice || '',
        roster: Object.entries(own.members).map(([id, m]) => ({ id, name: m.name, role: m.role, roleName: ROLES[m.role], contribution: m.contribution || 0, joinedAt: m.joinedAt, online: !!this.online(id) })),
        applicants: this.can(own, p.id, 'manage') ? Object.entries(own.applicants || {}).map(([id, a]) => ({ id, name: a.name, at: a.at })) : [],
        posts: (own.posts || []).slice(-50),
        logos: own.logos || [],
      });
    }
    if (t) out.doorTeams = t;
    return out;
  }
  sendState(p, message, extra) { this.server.ext.send(p, 'team', Object.assign(this.view(p), { message: message || '' }, extra || {})); }

  // ---------- applying ----------
  apply(p, d) {
    if (!p.scene || p.scene.mapRef !== 'office_team') return this.sendState(p, '请到团队事务厅申请。');
    const name = String(d.name || '').trim();
    const purpose = String(d.purpose || '').trim().slice(0, 100);
    if (this.teamOf(p.id)) return this.sendState(p, '你已经在一个团队里（或有团队申请在审批中）。');
    const left = this.data().left[p.id] || 0;
    if (left > Date.now()) return this.sendState(p, '退出团队 7 天内不能加入或建立其他团队（' + fmtTime(left) + ' 以后）。');
    if (!name || [...name].length > 12) return this.sendState(p, '团队名称须为 1–12 个字。');
    if (Object.values(this.data().teams).some((t) => t.world === p.ch.world && t.name === name && t.status !== 'rejected')) return this.sendState(p, '已经有同名的团队了。');
    const minPts = this.cfg('teamApplyMinPoints', 500), pts = this.cfg('teamApplyPoints', 100), gold = this.cfg('teamApplyGold', 3000), lvl = this.cfg('teamApplyLevel', 10);
    if (C.combatLevel(p.ch) < lvl) return this.sendState(p, '社区等级要 ' + lvl + ' 级以上才能申请团队。');
    if (this.points(p) < minPts) return this.sendState(p, '账户里至少要有 ' + minPts + ' 服务点才能申请团队。');
    if (p.ch.gold < gold) return this.sendState(p, '申请团队要 ' + gold + ' 金币。');
    this.pay(p, pts);
    p.ch.gold -= gold; p.paramsDirty = true; p.flushParams();
    const b = this.data();
    const t = { id: 't' + (b.nextId++), world: p.ch.world, name, purpose, status: 'pending', leaderId: p.id, leaderName: p.name, accountId: p.ch.accountId, paid: { points: pts, gold }, createdAt: Date.now(), members: {}, applicants: {}, posts: [], logos: [], points: 0, coffer: 0, contribution: 0 };
    b.teams[t.id] = t;
    this.dirty();
    if (this.cfg('teamAutoApprove', false)) { this.approve(t.id); return this.sendState(p, '团队「' + name + '」已自动批准！'); }
    return this.sendState(p, '已提交团队「' + name + '」的申请，扣了 ' + pts + ' 服务点和 ' + gold + ' 金币；等待管理员审批，未批准会全部退还。');
  }

  // Building and door with the fewest teams.
  pickPlace() {
    const used = {};
    for (const t of Object.values(this.data().teams)) if (t.building) used[t.building + '|' + t.door] = (used[t.building + '|' + t.door] || 0) + 1;
    let best = null;
    for (const b of Object.keys(BUILDINGS)) for (const d of DOORS) { const n = used[b + '|' + d] || 0; if (!best || n < best.n) best = { b, d, n }; }
    return best;
  }

  approve(id, building, door) {
    const t = this.data().teams[id];
    if (!t || t.status !== 'pending') throw new Error('这个申请不在审批中');
    const place = building && BUILDINGS[building] && DOORS.includes(door) ? { b: building, d: door } : this.pickPlace();
    t.status = 'active'; t.building = place.b; t.door = place.d; t.approvedAt = Date.now(); t.paidUntil = Date.now() + MONTH;
    t.members[t.leaderId] = { name: t.leaderName, role: 'leader', joinedAt: Date.now(), contribution: 0 };
    this.dirty();
    this.notify(t.leaderId, '你的团队「' + t.name + '」已经批准，位置：团队区 ' + BUILDINGS[t.building] + ' ' + t.door + '。');
    return '已批准「' + t.name + '」：' + BUILDINGS[t.building] + ' ' + t.door;
  }

  reject(id, why) {
    const t = this.data().teams[id];
    if (!t || t.status !== 'pending') throw new Error('这个申请不在审批中');
    delete this.data().teams[id];
    this.refund(t.leaderId, t.accountId, t.paid.points, t.paid.gold, '团队「' + t.name + '」的申请没有批准' + (why ? '（' + why + '）' : '') + '，退还 ' + t.paid.points + ' 服务点和 ' + t.paid.gold + ' 金币。');
    this.dirty();
    return '已拒绝「' + t.name + '」并退款';
  }

  refund(chId, accountId, pts, gold, text) {
    const p = this.online(chId);
    if (p) {
      p.session.account.servicePoints = this.points(p) + pts;
      p.ch.gold += gold; p.paramsDirty = true; p.flushParams();
      this.tell(p, text); this.dirty(); return;
    }
    const acc = Object.values(this.server.store.data.accounts).find((a) => a.id === accountId);
    if (acc) acc.servicePoints = (acc.servicePoints == null ? this.server.config.startServicePoints : acc.servicePoints) + pts;
    const ch = this.server.store.data.characters[chId];
    if (ch) ch.gold = (ch.gold || 0) + gold;
    this.notify(chId, text);
  }

  notify(chId, text) {
    const q = this.online(chId);
    if (q) { this.tell(q, text); return; }
    const n = this.data().notes; (n[chId] = n[chId] || []).push(text);
    this.dirty();
  }
  onEntered(p) {
    const n = this.data().notes[p.id];
    if (n && n.length) { for (const t of n) this.tell(p, t); delete this.data().notes[p.id]; this.dirty(); }
  }

  // ---------- members ----------
  join(p, d) {
    const t = this.data().teams[String(d.id || '')];
    if (!t || !this.isActive(t) || t.world !== p.ch.world) return this.sendState(p, '没有这个团队。');
    if (this.teamOf(p.id)) return this.sendState(p, '你已经在一个团队里了。');
    const left = this.data().left[p.id] || 0;
    if (left > Date.now()) return this.sendState(p, '退出团队 7 天内不能加入其他团队（' + fmtTime(left) + ' 以后）。');
    if (Object.keys(t.members).length >= this.cap(t)) return this.sendState(p, '这个团队人满了。');
    for (const x of Object.values(this.data().teams)) if (x.applicants) delete x.applicants[p.id];
    t.applicants[p.id] = { name: p.name, at: Date.now() };
    this.dirty();
    for (const [id, m] of Object.entries(t.members)) if (m.role === 'leader' || m.role === 'vice') { const q = this.online(id); if (q) this.tell(q, p.name + ' 申请加入团队，请到团队办公室处理。'); }
    return this.sendState(p, '已向「' + t.name + '」提出入队申请，等队长或副队长批准。');
  }

  leave(p) {
    const t = this.teamOf(p.id);
    if (!t || !t.members[p.id]) return this.sendState(p, '你不在团队里。');
    if (t.leaderId === p.id && Object.keys(t.members).length > 1) return this.sendState(p, '队长要先把队长交给别人才能退出（或让管理员解散团队）。');
    delete t.members[p.id];
    this.data().left[p.id] = Date.now() + REJOIN_MS;
    if (!Object.keys(t.members).length) { t.status = 'disbanded'; delete this.data().teams[t.id]; }
    this.dirty();
    if (p.scene && p.scene.mapRef === OFFICE) this.exit(p);
    return this.sendState(p, '你退出了团队「' + t.name + '」，7 天内不能加入其他团队。');
  }

  // op: accept / refuse / kick / role (role: vice | member | newbie) / leader (hand over)
  member(p, d) {
    const t = this.teamOf(p.id);
    if (!t || !t.members[p.id]) return this.sendState(p, '你不在团队里。');
    if (t.status === 'suspended') return this.sendState(p, '团队欠费停权中，只能捐点续费。');
    const id = String(d.id || '');
    const op = String(d.op || '');
    if (!this.can(t, p.id, 'manage')) return this.sendState(p, '只有队长和副队长能管理成员。');
    if (op === 'accept' || op === 'refuse') {
      const a = t.applicants[id];
      if (!a) return this.sendState(p, '没有这个申请。');
      delete t.applicants[id];
      if (op === 'refuse') { this.notify(id, '「' + t.name + '」没有通过你的入队申请。'); this.dirty(); return this.sendState(p, '已拒绝 ' + a.name + '。'); }
      if (this.teamOf(id)) { this.dirty(); return this.sendState(p, a.name + ' 已经加入了别的团队。'); }
      if (Object.keys(t.members).length >= this.cap(t)) return this.sendState(p, '团队人满了（' + this.cap(t) + ' 人）。');
      t.members[id] = { name: a.name, role: 'newbie', joinedAt: Date.now(), contribution: 0 };
      this.dirty();
      this.notify(id, '你加入了团队「' + t.name + '」。');
      return this.sendState(p, a.name + ' 加入了团队（新人）。');
    }
    const m = t.members[id];
    if (!m) return this.sendState(p, '没有这个成员。');
    const mine = this.roleOf(t, p.id);
    if (id === p.id) return this.sendState(p, '不能对自己操作。');
    if (m.role === 'leader' || (m.role === 'vice' && mine !== 'leader')) return this.sendState(p, '没有权限。');
    if (op === 'kick') {
      delete t.members[id];
      this.data().left[id] = Date.now() + REJOIN_MS;
      this.dirty();
      this.notify(id, '你被移出了团队「' + t.name + '」，7 天内不能加入其他团队。');
      const q = this.online(id); if (q && q.scene && q.scene.mapRef === OFFICE) this.exit(q);
      return this.sendState(p, '已把 ' + m.name + ' 移出团队。');
    }
    if (op === 'role') {
      const role = String(d.role || '');
      if (!['vice', 'member', 'newbie'].includes(role)) return undefined;
      if (role === 'vice' && mine !== 'leader') return this.sendState(p, '只有队长能任命副队长。');
      m.role = role; this.dirty();
      this.notify(id, '你在「' + t.name + '」的职位变成了' + ROLES[role] + '。');
      return this.sendState(p, m.name + ' 现在是' + ROLES[role] + '。');
    }
    if (op === 'leader') {
      if (mine !== 'leader') return this.sendState(p, '只有队长能交出队长。');
      t.members[p.id].role = 'vice'; m.role = 'leader'; t.leaderId = id; this.dirty();
      this.notify(id, '你成了「' + t.name + '」的队长。');
      return this.sendState(p, '队长交给了 ' + m.name + '，你现在是副队长。');
    }
    return undefined;
  }

  // ---------- the buildings ----------
  door(p, d) {
    if (!p.scene || !BUILDINGS[p.scene.mapRef]) return undefined;
    const door = DOORS.find((x) => String(d.door || '').includes(x));
    if (!door) return undefined;
    const list = Object.values(this.data().teams).filter((t) => t.world === p.ch.world && t.building === p.scene.mapRef && t.door === door && t.status !== 'pending')
      .map((t) => ({ id: t.id, name: t.name, status: t.status, members: Object.keys(t.members).length, logo: t.logo || '', mine: !!t.members[p.id] }));
    return this.sendState(p, '', { doorView: { building: p.scene.mapRef, buildingName: BUILDINGS[p.scene.mapRef], door, list } });
  }

  enter(p, d) {
    const t = this.data().teams[String(d.id || '')];
    if (!t || t.world !== p.ch.world) return this.sendState(p, '没有这个团队。');
    if (!t.members[p.id]) return this.sendState(p, '只有「' + t.name + '」的成员能进团队办公室。');
    this.server.transferPlayer(p, OFFICE, { x: OFFICE_SPAWN.x, y: OFFICE_SPAWN.y, instance: 't' + t.id, world: p.ch.world });
    return undefined;
  }

  exit(p) {
    const t = this.teamOf(p.id);
    const back = t && t.building ? t.building : 'team_in';
    const at = t && t.building ? DOOR_AT[t.door] : { x: 1600, y: 1600 };
    this.server.transferPlayer(p, back, { x: at.x + 40, y: at.y + 80, world: p.ch.world });
  }

  officeTeam(p) {
    if (!p.scene || p.scene.mapRef !== OFFICE) return null;
    const t = this.teamOf(p.id);
    return t && p.scene.world.endsWith('~t' + t.id) ? t : null;
  }

  // ---------- money ----------
  donate(p, d) {
    const t = this.teamOf(p.id);
    if (!t || !t.members[p.id]) return this.sendState(p, '你不在团队里。');
    if (!this.can(t, p.id, 'donate')) return this.sendState(p, '新人不能捐点。');
    const n = Math.trunc(Number(d.points));
    if (!(n >= 1 && n <= DONATE_MAX)) return this.sendState(p, '每次捐 1 至 ' + DONATE_MAX + ' 点。');
    if (this.points(p) < n) return this.sendState(p, '你的服务点不够。');
    this.pay(p, n);
    t.points = (t.points || 0) + n;
    this.addContribution(t, p.id, n);
    this.rentOne(t, Date.now());
    this.dirty();
    return this.sendState(p, '你给团队捐了 ' + n + ' 服务点。');
  }

  addContribution(t, id, n) {
    const m = t.members[id];
    if (m) m.contribution = (m.contribution || 0) + n;
    t.contribution = (t.contribution || 0) + n;
  }

  // op: deposit / withdraw / password
  coffer(p, d) {
    const t = this.officeTeam(p);
    if (!t) return this.sendState(p, '请在本团队的办公室里使用金库。');
    if (t.status === 'suspended') return this.sendState(p, '团队欠费停权中，金库暂停使用。');
    const op = String(d.op || '');
    const amount = Math.trunc(Number(d.gold));
    if (op === 'password') {
      if (!this.can(t, p.id, 'leader')) return this.sendState(p, '只有队长能设金库密码。');
      if (t.password && String(d.old || '') !== t.password) return this.sendState(p, '原密码不对。');
      if (!/^\d{6}$/.test(String(d.password || ''))) return this.sendState(p, '密码须为 6 位数字。');
      t.password = String(d.password); this.dirty();
      return this.sendState(p, '金库密码已设置。');
    }
    if (!(amount >= 1)) return this.sendState(p, '请输入金币数。');
    if (op === 'deposit') {
      if (p.ch.gold < amount) return this.sendState(p, '你身上没有那么多金币。');
      const room = COFFER_CAP - (t.coffer || 0);
      if (room <= 0) return this.sendState(p, '团队金库已满（上限 1 亿）。');
      const put = Math.min(room, amount);
      p.ch.gold -= put; t.coffer = (t.coffer || 0) + put;
      this.addContribution(t, p.id, Math.floor(put / 1000));
      p.paramsDirty = true; p.flushParams(); this.dirty();
      return this.sendState(p, '存入 ' + put + ' 金币' + (put < amount ? '（金库满了，其余退还）' : '') + '。');
    }
    if (op === 'withdraw') {
      if (!this.can(t, p.id, 'manage')) return this.sendState(p, '只有队长和副队长能取金库的钱。');
      if (!t.password) return this.sendState(p, '队长还没有设置金库密码。');
      if (String(d.password || '') !== t.password) return this.sendState(p, '金库密码不对。');
      if ((t.coffer || 0) < amount) return this.sendState(p, '金库里没有那么多金币。');
      t.coffer -= amount; p.ch.gold += amount;
      p.paramsDirty = true; p.flushParams(); this.dirty();
      return this.sendState(p, '取出 ' + amount + ' 金币。');
    }
    return undefined;
  }

  // ---------- meeting table, notice and logo ----------
  post(p, d) {
    const t = this.officeTeam(p);
    if (!t) return this.sendState(p, '请在本团队办公室的会议桌留言。');
    if (t.status === 'suspended') return this.sendState(p, '团队欠费停权中。');
    if (d.remove != null) {
      const i = (t.posts || []).findIndex((x) => x.id === d.remove);
      if (i < 0) return undefined;
      if (t.posts[i].authorId !== p.id && !this.can(t, p.id, 'manage')) return this.sendState(p, '只能删除自己的留言。');
      t.posts.splice(i, 1); this.dirty();
      return this.sendState(p, '留言已删除。');
    }
    const text = String(d.text || '').trim();
    if (!text) return undefined;
    if ([...text].length > 100) return this.sendState(p, '留言不能超过 100 个字。');
    t.posts.push({ id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), authorId: p.id, author: p.name, text, at: Date.now() });
    if (t.posts.length > 200) t.posts.splice(0, t.posts.length - 200);
    this.dirty();
    return this.sendState(p, '留言已贴上。');
  }

  notice(p, d) {
    const t = this.teamOf(p.id);
    if (!t || !this.can(t, p.id, 'manage')) return this.sendState(p, '只有队长和副队长能改公告。');
    t.notice = String(d.text || '').trim().slice(0, 200); this.dirty();
    return this.sendState(p, '团队公告已更新。');
  }

  logo(p, d) {
    const t = this.teamOf(p.id);
    if (!t || !this.can(t, p.id, 'leader')) return this.sendState(p, '只有队长能换队徽。');
    if (t.status === 'suspended') return this.sendState(p, '团队欠费停权中。');
    const png = String(d.png || '');
    const reuse = d.index != null ? (t.logos || [])[Math.trunc(Number(d.index))] : null;
    if (!reuse && !/^data:image\/png;base64,[A-Za-z0-9+/=]{20,4000}$/.test(png)) return this.sendState(p, '队徽须为 16×16 的图片。');
    const cost = t.logo ? this.cfg('teamLogoPoints', 500) : 0;
    if (this.points(p) < cost) return this.sendState(p, '更换队徽要 ' + cost + ' 服务点。');
    if (cost) this.pay(p, cost);
    const img = reuse || png;
    t.logo = img;
    if (!reuse) { t.logos = (t.logos || []).filter((x) => x !== img); t.logos.push(img); if (t.logos.length > 10) t.logos.splice(0, t.logos.length - 10); }
    this.dirty();
    return this.sendState(p, '队徽已更换' + (cost ? '，花了 ' + cost + ' 服务点' : '（第一次免费）') + '。');
  }

  // ---------- rent ----------
  rentOne(t, now) {
    if (!t.paidUntil || !(t.status === 'active' || t.status === 'arrears' || t.status === 'suspended')) return;
    const rent = this.cfg('teamRentPoints', 100);
    while (t.paidUntil <= now && (t.points || 0) >= rent) { t.points -= rent; t.paidUntil += MONTH; }
    if (rent <= 0 && t.paidUntil <= now) t.paidUntil = now + MONTH;
    const was = t.status;
    if (t.paidUntil > now) t.status = 'active';
    else t.status = now > t.paidUntil + this.cfg('teamGraceDays', 7) * DAY ? 'suspended' : 'arrears';
    if (was !== t.status) {
      this.dirty();
      const text = t.status === 'active' ? '团队「' + t.name + '」的月租已续上。'
        : t.status === 'arrears' ? '团队「' + t.name + '」月租到期，团队点数不够 ' + rent + ' 点，请尽快捐点；' + this.cfg('teamGraceDays', 7) + ' 天后停权。'
          : '团队「' + t.name + '」欠费停权了，捐够月租后恢复。';
      for (const id of Object.keys(t.members)) this.notify(id, text);
    }
  }
  rent(now) { for (const t of Object.values(this.data().teams)) this.rentOne(t, now); }

  // ---------- admin ----------
  adminView() {
    return {
      buildings: Object.entries(BUILDINGS).map(([id, name]) => ({ id, name })), doors: DOORS,
      teams: Object.values(this.data().teams).map((t) => Object.assign(this.publicTeam(t), {
        leaderName: (t.members[t.leaderId] || {}).name || t.leaderName, points: t.points || 0, coffer: t.coffer || 0,
        paidText: t.paidUntil ? fmtTime(t.paidUntil) : '', createdText: fmtTime(t.createdAt),
        roster: Object.entries(t.members).map(([id, m]) => ({ id, name: m.name, roleName: ROLES[m.role] })),
      })).sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0)),
    };
  }
  adminAction(id, b) {
    const t = this.data().teams[id];
    if (!t) throw new Error('没有这个团队');
    switch (b.op) {
      case 'approve': return this.approve(id, b.building, b.door);
      case 'reject': return this.reject(id, b.reason);
      case 'move':
        if (!BUILDINGS[b.building] || !DOORS.includes(b.door)) throw new Error('楼或门不对');
        t.building = b.building; t.door = b.door; this.dirty();
        return '「' + t.name + '」搬到 ' + BUILDINGS[t.building] + ' ' + t.door;
      case 'leader': {
        const m = t.members[b.memberId];
        if (!m) throw new Error('没有这个成员');
        if (t.members[t.leaderId]) t.members[t.leaderId].role = 'vice';
        m.role = 'leader'; t.leaderId = b.memberId; this.dirty();
        this.notify(b.memberId, '管理员任命你为「' + t.name + '」的队长。');
        return '「' + t.name + '」的队长换成 ' + m.name;
      }
      case 'points':
        t.points = Math.max(0, Math.trunc(Number(b.points) || 0)); this.rentOne(t, Date.now()); this.dirty();
        return '「' + t.name + '」团队点数改为 ' + t.points;
      case 'disband':
        delete this.data().teams[id]; this.dirty();
        for (const mid of Object.keys(t.members)) this.notify(mid, '团队「' + t.name + '」已被管理员解散。');
        return '已解散「' + t.name + '」';
      default: throw new Error('未知操作');
    }
  }
}

module.exports = { Teams, BUILDINGS, DOORS };
