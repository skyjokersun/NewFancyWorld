'use strict';
// Server settings editable live from the /admin page. Saved values live in the
// 'serverSettings' bucket of var/state.json and are laid over server.config at
// startup, so they win over config.js and the QIYU_* environment variables.
const log = require('../util/log');

// type: 'num' (float) | 'int' | 'str' | 'bool'. scale converts the shown value to the config value.
const GROUPS = [
  { title: '经验与掉落', items: [
    { key: 'expRate', label: '经验倍率', type: 'num', min: 0, max: 1000, hint: '1 = 原版经验' },
    { key: 'dropRate', label: '物品掉落倍率', type: 'num', min: 0, max: 10000, hint: '乘在原版掉落表上（装备原版约 0.01%–3%）' },
    { key: 'goldDropRate', label: '金币掉落概率倍率', type: 'num', min: 0, max: 1000, hint: '原版约 5% 掉金币' },
    { key: 'goldAmountRate', label: '每次掉落金币数量倍率', type: 'num', min: 0, max: 1000 },
  ] },
  { title: '怪物', items: [
    { key: 'respawnRate', label: '刷新时间倍率', type: 'num', min: 0.01, max: 100, hint: '0.5 = 刷新快一倍，最短 2 秒' },
    { key: 'monsterCountRate', label: '怪物数量倍率', type: 'num', min: 0, max: 20, hint: '每张地图每种怪最多 200 只，修改后立即生效' },
    { key: 'monsterHpRate', label: '怪物血量倍率', type: 'num', min: 0.01, max: 100, hint: '新刷出的怪生效' },
    { key: 'monsterDamageRate', label: '怪物攻击倍率', type: 'num', min: 0, max: 100, hint: '新刷出的怪生效' },
  ] },
  { title: '新角色与账号', items: [
    { key: 'startGold', label: '新角色初始金币', type: 'int', min: 0, max: 2000000000 },
    { key: 'startServicePoints', label: '账号初始点数（银行服务点）', type: 'int', min: 0, max: 100000000, hint: '账号第一次用银行时发放' },
    { key: 'allowRegister', label: '允许注册账号', type: 'bool', hint: '关：登录页点「用户注册」只显示下面的提示，后台「新建账号」不受影响' },
    { key: 'registerClosedText', label: '关闭注册时的提示', type: 'str', maxLen: 100, hint: '留空 = 暂未开放注册，请联系管理员', allowEmpty: true },
  ] },
  { title: '摆摊', items: [
    { key: 'licensePrice', label: '营业执照价格（金币）', type: 'int', min: 0, max: 2000000000 },
    { key: 'licenseDays', label: '营业执照天数', type: 'int', min: 1, max: 3650 },
  ] },
  { title: '拼卡圣坛', items: [
    { key: 'cardPuzzleNearSlot', label: '放卡要走到对应格子', type: 'bool', hint: '开：和原版一样，要站到祭坛上这张卡对应的格子旁边才能放' },
    { key: 'cardPuzzleCooldownMin', label: '拼完后的冷却时间（分钟）', type: 'int', min: 0, max: 10080, hint: '一座祭坛拼完后，多久才能开始下一次；0 = 不冷却' },
  ] },
  { title: '背包', items: [
    { key: 'weightLimit', label: '负重限制', type: 'bool', hint: '开：背包太重时不能购买、拾取、交易和挖矿；关：可以超重。不论开关，超重时都不能跑步、只能慢走（速度见下一项）' },
    { key: 'overweightSpeedPercent', label: '超重时的走路速度（%）', type: 'int', min: 1, max: 100, hint: '正常走路速度的百分之几；50 = 一半' },
  ] },
  { title: '战斗', items: [
    { key: 'foxDetectRange', label: '狐仙探测范围（像素）', type: 'int', min: 100, max: 3000, hint: '范围内有人就追；被打中也会追打它的人。目标跑出范围、而且 5 秒没打中狐仙，它就停在原地' },
    { key: 'attackSpeedCap', label: '敏捷攻速上限（倍）', type: 'num', min: 1, max: 5, hint: '敏捷最多把攻速提高到几倍；1 = 敏捷不加攻速。装备上的攻速 +% 另外照算' },
    { key: 'warriorRange', label: '战士近战攻击距离', type: 'int', min: 0, max: 600, hint: '拿刀剑或空手时的近战距离，单位是像素，0 = 默认 120；拿弓时是射箭，距离 400' },
    { key: 'hpGrowthMode', label: '生命成长方式', type: 'int', min: 0, max: 2, hint: '0 = 网页版（原来的算法）；1 = 原版逐级：每升一级战斗等级，按当时职业的 力量×3 + 敏捷×1.5 加血，运气越高越容易拿满，低的一档是 80%，加过的血保留在角色身上；2 = 按当前等级和当前职业直接算出基础生命（取平均值），换职业马上按新职业算。装备生命、生命上限 % 和筋斗云照常再加' },
    { key: 'hpLevel1', label: '1 级基础生命', type: 'int', min: 1, max: 100000, hint: '生命成长方式为 1 或 2 时，战斗等级 1 级的基础生命' },
    { key: 'safeTowns', label: '城镇禁止攻击', type: 'bool', hint: '开：城市、驿站、商店、行会等没有野怪的地图里不能攻击和放技能' },
  ] },
  { title: '自动打怪', items: [
    { key: 'autoPotionIntervalSec', label: '自动吃药间隔（秒）', type: 'num', min: 1, max: 600, hint: '两次自动吃药之间至少隔多久，最低 1 秒；只在自动打怪开着时吃' },
    { key: 'autoPotionHpPercent', label: '默认回血线（%）', type: 'int', min: 1, max: 100, hint: '角色第一次打开自动打怪设置时的默认值，玩家自己可以改' },
    { key: 'autoPotionMpPercent', label: '默认回精力线（%）', type: 'int', min: 1, max: 100 },
    { key: 'autoHuntStuckSec', label: '自动打怪卡住换怪（秒）', type: 'int', min: 3, max: 300, hint: '这么久没有走近怪物、没有打掉血，就换一只怪或随机走开' },
    { key: 'autoHuntTeleportSec', label: '自动打怪卡住传送（秒）', type: 'int', min: 5, max: 600, hint: '这么久还是卡住，服务器把玩家移到本地图一只怪物附近，自动打怪不停' },
  ] },
  { title: '商店', items: [
    { key: 'shopLevelFilter', label: '按等级显示装备和技能书', type: 'bool', hint: '开：只显示要求等级不超过「职业等级 + 下面的数」的装备和技能书；后台各商人的「特殊清单」不受限制' },
    { key: 'shopLevelAhead', label: '比职业等级高几级以内可以看到', type: 'int', min: 0, max: 1000 },
  ] },
  { title: '坐骑', items: [
    { key: 'cloudStatPercent', label: '筋斗云属性加成（%）', type: 'num', min: 0, max: 1000, hint: '攻击、破坏、防御、生命上限、体力上限、生命和体力恢复，在所有计算之后再乘' },
    { key: 'cloudSpeed', label: '筋斗云移动速度加成', type: 'int', min: 0, max: 500, hint: '直接加在移动速度上（走路 120，跑步 190）' },
    { key: 'carpetSpeedPercent', label: '飞毯移动速度加成（%）', type: 'num', min: 0, max: 1000 },
    { key: 'cloudRentPoints', label: '仙女租筋斗云价格（服务点）', type: 'int', min: 0, max: 100000000 },
    { key: 'cloudRentDays', label: '仙女租筋斗云天数', type: 'int', min: 1, max: 3650, hint: '下线也计时；续租会在剩余时间上累加' },
  ] },
  { title: '战神的祝福', items: [
    { key: 'blessPointsPerHour', label: '每小时价格（服务点）', type: 'int', min: 0, max: 100000, hint: '只算在线时间；开启时先付第一小时' },
    { key: 'blessExpFactor', label: '经验倍数', type: 'num', min: 1, max: 100, hint: '祝福期间打怪经验不按等级衰减，固定乘这个数（2 = 原来的最高值，也就是双倍）' },
  ] },
  { title: '工匠', items: [
    { key: 'craftExpPerSuccess', label: '融合 / 修理成功一次加几点熟练度', type: 'int', min: 0, max: 100000, hint: '失败不加；升级方式不变（L 级升 L+1 级要 20×L 点）' },
    { key: 'craftBlessFactor', label: '战神的祝福时熟练度倍数', type: 'num', min: 1, max: 100, hint: '筋斗云不翻倍' },
    { key: 'fusionBestChance', label: '火候最好时的成功率（%）', type: 'num', min: 0, max: 100, hint: '离 750℃ 不超过下一项的度数时' },
    { key: 'fusionBestBand', label: '火候最好的范围（±℃）', type: 'int', min: 0, max: 150 },
    { key: 'fusionEdgeChance', label: '600℃ / 900℃ 时的成功率（%）', type: 'num', min: 0, max: 100, hint: '中间按温度直线变化' },
    { key: 'autoRepairIntervalSec', label: '自动修理每次间隔（秒）', type: 'num', min: 1, max: 3600 },
    { key: 'autoRepairChance', label: '自动修理成功率（%）', type: 'num', min: 0, max: 100, hint: '失败照样掉 10% 耐久，最低剩 1' },
  ] },
  { title: '元素伤害', items: [
    { key: 'elementResistCap', label: '元素抗性上限（%）', type: 'int', min: 0, max: 100, hint: '【推测（原版未知）】元素伤害 = 元素值 × (1 − 对方该元素抗性%)。老客户端只把装备上的火/毒/雷/冰攻击值按整数相加，原版最终怎么扣血查不到（第十五批两份报告），这条是我们定的' },
  ] },
  { title: '婚礼', items: [
    { key: 'marryPoints', label: '结婚登记（服务点/人）', type: 'int', min: 0, max: 100000, hint: '原版 50；伴侣同意后两人各扣' },
    { key: 'marryInvitePoints', label: '额外请柬（服务点/张）', type: 'int', min: 0, max: 1000, hint: '原版 1；登记时的 1–40 张不另收' },
    { key: 'marryDivorcePoints', label: '协议离婚（服务点）', type: 'int', min: 0, max: 100000, hint: '原版 100，提出的一方付' },
    { key: 'marryForceDivorcePoints', label: '强制离婚（服务点）', type: 'int', min: 0, max: 100000, hint: '原版 200' },
    { key: 'marryCooldownDays', label: '离婚后再婚等待（天）', type: 'int', min: 0, max: 365, hint: '原版不详，默认 7' },
    { key: 'marryWindowMin', label: '婚礼时段（分钟）', type: 'int', min: 10, max: 600, hint: '婚期开始后这么久内两位新人进教堂就自动举行；原版一场 40 分钟' },
  ] },
  { title: '长期团队', items: [
    { key: 'teamApplyMinPoints', label: '申请资格：服务点至少', type: 'int', min: 0, max: 100000, hint: '原版 500' },
    { key: 'teamApplyPoints', label: '申请扣服务点', type: 'int', min: 0, max: 100000, hint: '原版 100，未批准退还' },
    { key: 'teamApplyGold', label: '申请扣金币', type: 'int', min: 0, max: 100000000, hint: '原版 3000，未批准退还' },
    { key: 'teamApplyLevel', label: '申请资格：社区（战斗）等级', type: 'int', min: 1, max: 1200, hint: '原版 10' },
    { key: 'teamRentPoints', label: '团队月租（服务点/30天）', type: 'int', min: 0, max: 100000, hint: '原版 100，成员捐点续费' },
    { key: 'teamGraceDays', label: '欠费宽限（天）', type: 'int', min: 0, max: 365, hint: '过期这么多天后停权；原版不详' },
    { key: 'teamAutoApprove', label: '自动批准团队申请', type: 'bool', hint: '关 = 管理后台「婚礼与团队」里人工批准' },
    { key: 'teamLogoPoints', label: '更换队徽（服务点）', type: 'int', min: 0, max: 100000, hint: '原版 500' },
    { key: 'teamBaseMembers', label: '一级团队人数上限', type: 'int', min: 2, max: 1000, hint: '每升一级 +10 人（非原版）' },
  ] },
  { title: '夜市', items: [
    { key: 'lampPrice', label: '小洁卖的波波灯价格（金币）', type: 'int', min: 0, max: 2000000000 },
    { key: 'fireflyGold', label: '几只金色蛐蛐换 1 只萤火虫', type: 'int', min: 1, max: 9999, hint: '在刘嫂那里换' },
    { key: 'fireflyGreen', label: '几只绿色蛐蛐换 1 只萤火虫', type: 'int', min: 1, max: 9999 },
    { key: 'fireflyBrown', label: '几只褐色蛐蛐换 1 只萤火虫', type: 'int', min: 1, max: 9999 },
    { key: 'cricketMax', label: '地图上同时有几只蛐蛐', type: 'int', min: 0, max: 200 },
    { key: 'cricketRespawnSec', label: '蛐蛐被捉走后几秒补刷', type: 'int', min: 1, max: 86400 },
    { key: 'cricketWeightGold', label: '金色蛐蛐出现比例', type: 'num', min: 0, max: 10000, hint: '三种颜色按比例出现，例如 5 / 30 / 65' },
    { key: 'cricketWeightGreen', label: '绿色蛐蛐出现比例', type: 'num', min: 0, max: 10000 },
    { key: 'cricketWeightBrown', label: '褐色蛐蛐出现比例', type: 'num', min: 0, max: 10000 },
    { key: 'cricketCatchGold', label: '金色蛐蛐捕捉成功率（%）', type: 'num', min: 0, max: 100, hint: '每点一次判定一次；捉到一只消耗一个波波灯，没捉到不消耗' },
    { key: 'cricketCatchGreen', label: '绿色蛐蛐捕捉成功率（%）', type: 'num', min: 0, max: 100 },
    { key: 'cricketCatchBrown', label: '褐色蛐蛐捕捉成功率（%）', type: 'num', min: 0, max: 100 },
    { key: 'cricketSeeRange', label: '波波灯照见蛐蛐的范围（像素）', type: 'int', min: 50, max: 3000 },
    { key: 'cricketCatchRange', label: '能点击捕捉的距离（像素）', type: 'int', min: 20, max: 3000 },
  ] },
  { title: '竞技场', items: [
    { key: 'targetRentGold', label: '租借靶子价格（金币）', type: 'int', min: 0, max: 2000000000, hint: '强壮靶子和脆弱靶子同价，每租一次收一次' },
  ] },
  { title: '其他', items: [
    { key: 'gardenTimeScale', label: '果园生长时间倍率', type: 'num', min: 0.01, max: 100, hint: '0.5 = 成熟快一倍' },
    { key: 'heartbeatTimeoutMs', label: '掉线判定时间（秒）', type: 'int', min: 10, max: 3600, scale: 1000, hint: '多久收不到客户端心跳就算掉线' },
    { key: 'restartCountdownSec', label: '重启倒计时（秒）', type: 'int', min: 0, max: 3600, hint: '后台「重启服务器」按钮的默认倒计时，会先发全服公告；0 = 立刻重启' },
    { key: 'serverName', label: '服务器名称', type: 'str', maxLen: 32 },
    { key: 'loginNotice', label: '进入游戏时的公告', type: 'str', maxLen: 200, allowEmpty: true, hint: '玩家进入游戏时在聊天框显示的系统消息；留空 = 不显示' },
  ] },
];
const DEFS = new Map();
for (const g of GROUPS) for (const d of g.items) DEFS.set(d.key, d);

class Settings {
  register(server) {
    this.server = server;
    this.defaults = {};
    for (const key of DEFS.keys()) this.defaults[key] = server.config[key];
    // The login notice, a moment after entering so the chat box is ready for it.
    server.events.on('playerEntered', (p) => setTimeout(() => {
      const text = String(server.config.loginNotice || '').trim();
      if (text && server.playersById.get(p.id) === p) p.send(server.op.CHAT_MESSAGE, server.systemChat(text));
    }, 1500));
  }

  // Runs once var/state.json is loaded.
  onStart() {
    const server = this.server;
    this.saved = server.store.bucket('serverSettings');
    for (const [key, v] of Object.entries(this.saved)) {
      if (!DEFS.has(key)) { delete this.saved[key]; continue; }
      server.config[key] = v;
    }
    this.applyTuning();
    const n = Object.keys(this.saved).length;
    if (n) log.info('server settings: ' + n + ' saved value(s) applied from the admin page');
  }

  has(key) { return DEFS.has(key); }

  shown(d, v) { return d.scale ? v / d.scale : v; }

  view() {
    const cfg = this.server.config;
    return {
      groups: GROUPS.map((g) => ({
        title: g.title,
        items: g.items.map((d) => ({
          key: d.key, label: d.label, type: d.type, hint: d.hint || '',
          min: d.min, max: d.max, maxLen: d.maxLen,
          value: this.shown(d, cfg[d.key]), default: this.shown(d, this.defaults[d.key]),
          changed: Object.prototype.hasOwnProperty.call(this.saved, d.key),
        })),
      })),
    };
  }

  // Shown values (as on the page) for the export file.
  exportValues() {
    const out = {};
    for (const [key, d] of DEFS) out[key] = this.shown(d, this.server.config[key]);
    return out;
  }

  parse(d, raw) {
    if (d.type === 'bool') {
      if (raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === '开') return true;
      if (raw === false || raw === 'false' || raw === 0 || raw === '0' || raw === '关') return false;
      throw new Error(d.label + '：请选择开或关');
    }
    if (d.type === 'str') {
      const s = String(raw == null ? '' : raw).trim();
      if ((!s && !d.allowEmpty) || s.length > d.maxLen) throw new Error(d.label + '：须为 ' + (d.allowEmpty ? 0 : 1) + '–' + d.maxLen + ' 个字');
      return s;
    }
    const n = Number(raw);
    if (raw === '' || raw == null || !Number.isFinite(n)) throw new Error(d.label + '：请输入数字');
    if (d.type === 'int' && !Number.isInteger(n)) throw new Error(d.label + '：须为整数');
    if (n < d.min || n > d.max) throw new Error(d.label + '：须在 ' + d.min + ' 到 ' + d.max + ' 之间');
    return d.scale ? n * d.scale : n;
  }

  // values: { key: shownValue }. Validates everything first, then applies. Unknown keys are an error.
  set(values) {
    const parsed = {};
    for (const [key, raw] of Object.entries(values || {})) {
      const d = DEFS.get(key);
      if (!d) throw new Error('未知的设置项：' + key);
      parsed[key] = this.parse(d, raw);
    }
    const changed = [];
    for (const [key, v] of Object.entries(parsed)) {
      if (this.server.config[key] === v) continue;
      this.server.config[key] = v;
      changed.push(DEFS.get(key).label);
      if (v === this.defaults[key]) delete this.saved[key]; else this.saved[key] = v;
    }
    if (changed.length) { this.server.store.markDirty(); this.afterChange(Object.keys(parsed)); log.info('server settings changed:', changed.join(', ')); }
    return changed;
  }

  reset() {
    const values = {};
    for (const [key, d] of DEFS) values[key] = this.shown(d, this.defaults[key]);
    const changed = this.set(values);
    for (const key of Object.keys(this.saved)) delete this.saved[key];
    this.server.store.markDirty();
    return changed;
  }

  applyTuning() {
    const c = this.server.config;
    require('../game/character').setTuning({
      warriorRange: c.warriorRange || 0, attackSpeedCap: c.attackSpeedCap, cloudStatPercent: c.cloudStatPercent, cloudSpeed: c.cloudSpeed, carpetSpeedPercent: c.carpetSpeedPercent, overweightSpeedPercent: c.overweightSpeedPercent,
      hpGrowthMode: c.hpGrowthMode || 0, hpLevel1: c.hpLevel1 || 100,
    });
  }

  afterChange(keys) {
    if (['warriorRange', 'attackSpeedCap', 'cloudStatPercent', 'cloudSpeed', 'carpetSpeedPercent', 'overweightSpeedPercent', 'hpGrowthMode', 'hpLevel1'].some((k) => keys.includes(k))) {
      this.applyTuning();
      for (const p of this.server.playersById.values()) if (p.ch) { p.recompute(); p.paramsDirty = true; }
    }
    if (keys.includes('monsterCountRate') || keys.includes('respawnRate')) {
      for (const sc of this.server.scenes.values()) if (sc.rebalanceMonsters) sc.rebalanceMonsters();
    }
  }

  announce(text) {
    const s = String(text || '').trim();
    if (!s || s.length > 200) throw new Error('公告须为 1–200 个字');
    const msg = this.server.systemChat('【公告】' + s);
    let n = 0;
    for (const p of this.server.playersById.values()) { p.send(this.server.op.CHAT_MESSAGE, msg); n++; }
    log.info('announcement to', n, 'player(s):', s);
    return n;
  }
}

module.exports = { Settings, GROUPS };
