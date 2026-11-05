/* Fifteenth batch admin pages: 卡片掉落, 掉落总览, 屠龙与活动. Loaded after admin-v12.js. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function api(path, body) {
    return fetch('/api/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
      .then(function (r) { return r.json().then(function (j) { if (r.status === 401 && j.login) location.reload(); if (!r.ok) throw new Error(j.error || r.status); return j; }); });
  }
  function say(id, text, ok) { var el = $(id); if (!el) return; el.textContent = text; el.style.color = ok === false ? 'var(--bad)' : 'var(--ok)'; }
  function val(id) { var e = $(id); return e ? (e.type === 'checkbox' ? e.checked : e.value) : undefined; }

  var VIEWS = [
    { id: 'v15cards', label: '卡片掉落', load: loadCards },
    { id: 'v15drops', label: '掉落总览', load: loadDrops },
    { id: 'v15dragon', label: '屠龙与活动', load: loadDragon },
  ];
  var tabs = document.querySelector('.tabs');
  var modal = $('modal');
  VIEWS.forEach(function (v) {
    var b = document.createElement('button'); b.setAttribute('data-view', v.id); b.textContent = v.label; tabs.appendChild(b);
    var d = document.createElement('div'); d.id = v.id; d.className = 'v12'; d.hidden = true;
    document.body.insertBefore(d, modal);
  });
  tabs.addEventListener('click', function (e) {
    var v = e.target.dataset && e.target.dataset.view; if (!v) return;
    var mine = VIEWS.filter(function (x) { return x.id === v; })[0];
    VIEWS.forEach(function (x) { $(x.id).hidden = x.id !== v; });
    if (!mine) return;
    Array.prototype.forEach.call(document.querySelectorAll('body > main, body > div.wide, #settingsView, body > div.v12'), function (el) { if (!VIEWS.some(function (x) { return x.id === el.id; })) el.hidden = true; });
    Array.prototype.forEach.call(tabs.querySelectorAll('button'), function (b) { b.classList.toggle('on', b === e.target); b.classList.toggle('active', b === e.target); });
    mine.load();
  });

  var view = null;
  function getView() { return api('b15').then(function (v) { view = v; return v; }); }

  // ================= 卡片掉落 =================
  function loadCards() {
    return getView().then(function (v) {
      var c = v.config.cards;
      var root = $('v15cards');
      var cats = v.mapCats.map(function (k) { return '<label>' + esc(k) + '<input id="cc_' + esc(k) + '" type="number" step="0.1" min="0" value="' + esc(c.cats[k]) + '"></label>'; }).join('');
      var altars = Object.keys(v.altars).map(function (k) { return '<label>' + esc(v.altars[k]) + '<input id="ca_' + k + '" type="number" step="0.1" min="0" value="' + esc(c.altars[k]) + '"></label>'; }).join('');
      var cards = Object.keys(v.altars).map(function (k) {
        return '<h4 style="margin:10px 0 4px">' + esc(v.altars[k]) + '</h4><div class="grid">' + v.cardList.filter(function (x) { return x.altar === k; }).map(function (x) {
          return '<label>' + esc(x.name) + '（' + x.itemId + '）<input data-cw="' + x.itemId + '" type="number" step="0.1" min="0" value="' + esc(x.weight) + '"></label>';
        }).join('') + '</div>';
      }).join('');
      root.innerHTML =
        '<section class="panel"><h3 style="margin:0 0 8px">卡片掉落（心型 / 神龙 / 天使卡）</h3>' +
        '<div class="items" style="margin-bottom:8px">原版 56 张卡不在任何怪物的掉落表里，官方公告说从猎场、果园、矿山得到，官方概率未知。默认和 V15 以前一样：5 级以上的怪物每只 0.4% × 物品掉落倍率，三座祭坛机会一样。打怪掉的卡归击杀者，果园收获、挖到矿石时掉的卡直接放进背包。</div>' +
        '<div class="grid">' +
        '<label class="c"><input id="c_on" type="checkbox"' + (c.on ? ' checked' : '') + ' style="width:auto"> 开启卡片掉落</label>' +
        '<label>每只怪掉卡概率（%）<input id="c_chance" type="number" step="0.01" min="0" max="100" value="' + esc(c.chance) + '"></label>' +
        '<label>怪物最低等级<input id="c_min" type="number" min="0" value="' + esc(c.minLevel) + '"></label>' +
        '<label class="c"><input id="c_rate" type="checkbox"' + (c.useDropRate ? ' checked' : '') + ' style="width:auto"> 乘上「服务器设置」的物品掉落倍率（现在 ' + esc(v.dropRate) + '）</label>' +
        '<label>果园收获时掉卡概率（%）<input id="c_garden" type="number" step="0.01" min="0" max="100" value="' + esc(c.gardenChance) + '"></label>' +
        '<label>挖到矿石时掉卡概率（%）<input id="c_mine" type="number" step="0.01" min="0" max="100" value="' + esc(c.mineChance) + '"></label>' +
        '</div>' +
        '<h4 style="margin:12px 0 4px">按地图类别的倍率（0 = 这类地图不掉卡）</h4><div class="grid">' + cats + '</div>' +
        '<h4 style="margin:12px 0 4px">三座祭坛的权重</h4><div class="grid">' + altars + '</div>' +
        '<h4 style="margin:12px 0 4px">每张卡的权重（同一座祭坛里比较；默认 1，设 0.2 就是别的卡的五分之一，0 = 不掉）</h4>' + cards +
        '<div class="row"><button id="c_save">保存</button><button class="ghost" id="c_reset">恢复默认</button><span id="c_msg"></span></div></section>';
      $('c_save').onclick = function () {
        var body = { on: val('c_on'), chance: val('c_chance'), minLevel: val('c_min'), useDropRate: val('c_rate'), gardenChance: val('c_garden'), mineChance: val('c_mine'), cats: {}, altars: {}, weights: {} };
        v.mapCats.forEach(function (k) { body.cats[k] = val('cc_' + k); });
        Object.keys(v.altars).forEach(function (k) { body.altars[k] = val('ca_' + k); });
        Array.prototype.forEach.call(document.querySelectorAll('[data-cw]'), function (e) { body.weights[e.getAttribute('data-cw')] = e.value; });
        api('b15/cards', body).then(function (r) { say('c_msg', r.done.join('')); }).catch(function (e) { say('c_msg', e.message, false); });
      };
      $('c_reset').onclick = function () { if (!confirm('卡片掉落恢复默认？')) return; api('b15/cards', { reset: true }).then(function () { loadCards().then(function () { say('c_msg', '已恢复默认'); }); }); };
    });
  }

  // ================= 掉落总览 =================
  var dq = '';
  function loadDrops() {
    var root = $('v15drops');
    if (!root.firstChild) {
      root.innerHTML = '<section class="panel"><h3 style="margin:0 0 8px">掉落总览</h3><div class="items" style="margin-bottom:8px">输入物品名字或编号，列出掉它的所有怪物（掉率是每只怪的百分比，还要乘「服务器设置」里的物品掉落倍率）。勾选怪物后可以一起改概率；改过的怪物在「怪物」页的掉落里显示为自定义，可以在那里恢复默认。黄色水晶碎片没改过时用「屠龙与活动」页的碎片掉率。</div>' +
        '<div class="row" style="margin:0 0 8px"><input id="dq" placeholder="例如 黄色水晶碎片 或 2622" style="flex:1;width:auto"><button id="dgo">查找</button></div><div id="dlist"></div><div id="dmsg"></div></section>';
      $('dgo').onclick = function () { dq = $('dq').value.trim(); fetchDrops(); };
      $('dq').onkeydown = function (e) { if (e.key === 'Enter') $('dgo').click(); };
    }
    return fetchDrops();
  }
  function fetchDrops() {
    return api('drop-overview?q=' + encodeURIComponent(dq)).then(function (r) { drawDrops(r.rows); }).catch(function (e) { say('dmsg', e.message, false); });
  }
  function drawDrops(rows) {
    var el = $('dlist');
    if (!rows.length) { el.innerHTML = '<div class="empty">没有找到</div>'; return; }
    el.innerHTML = rows.map(function (r) {
      return '<div class="panel" style="margin:8px 0;padding:8px"><b>' + esc(r.name) + '</b>（' + r.itemId + '）· ' + r.monsters.length + ' 种怪物' +
        '<table class="f"><tr><th><input type="checkbox" data-all="' + r.itemId + '" style="width:auto"></th><th>怪物</th><th>等级</th><th>地图</th><th>掉率 %</th></tr>' +
        r.monsters.map(function (m) {
          return '<tr><td><input type="checkbox" data-mon="' + r.itemId + '" value="' + esc(m.monsterId) + '" style="width:auto"></td><td>' + esc(m.name) + (m.special ? ' <span class="pill">' + esc(m.label) + '</span>' : '') + (m.edited ? ' <span class="pill">自定义</span>' : '') +
            '</td><td>' + esc(m.level) + '</td><td>' + esc(m.maps.join('、')) + '</td><td>' + esc(m.chance) + '</td></tr>';
        }).join('') + '</table><div class="row">把勾选的改成 <input data-pct="' + r.itemId + '" type="number" step="0.001" min="0" max="100" style="width:110px"> % <button data-set="' + r.itemId + '">改</button></div></div>';
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('[data-all]'), function (b) {
      b.onchange = function () { var id = b.getAttribute('data-all'); Array.prototype.forEach.call(el.querySelectorAll('[data-mon="' + id + '"]'), function (x) { x.checked = b.checked; }); };
    });
    Array.prototype.forEach.call(el.querySelectorAll('[data-set]'), function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-set');
        var mons = Array.prototype.filter.call(el.querySelectorAll('[data-mon="' + id + '"]'), function (x) { return x.checked; }).map(function (x) { return x.value; });
        if (!mons.length) return say('dmsg', '先勾选怪物', false);
        api('drop-overview', { itemId: Number(id), chance: el.querySelector('[data-pct="' + id + '"]').value, monsters: mons, q: dq })
          .then(function (r) { drawDrops(r.rows); say('dmsg', r.done.join('')); }).catch(function (e) { say('dmsg', e.message, false); });
      };
    });
  }

  // ================= 屠龙与活动 =================
  var STAT_LABELS = { level: '等级', hp: '生命', defense: '防御', breakPower: '破坏', damage: '攻击', attackRange: '攻击距离', detectionRange: '发现距离', baseExp: '经验', fireAttack: '火攻击' };
  function loadDragon() {
    return getView().then(function (v) {
      var d = v.config.dragon, t = v.config.transform;
      var root = $('v15dragon');
      var bullets = [603, 604, 605, 606].map(function (id, i) {
        var names = ['单发', '三发', '六发', '极品六发'];
        return '<tr><td>' + names[i] + '封印的魔法子弹（' + id + '）</td><td><input id="dp_' + id + '" type="number" min="0" value="' + esc(d.prices[id]) + '"></td><td><input id="dm_' + id + '" type="number" step="0.1" min="0" value="' + esc(d.mult[id]) + '"></td></tr>';
      }).join('');
      var stats = Object.keys(STAT_LABELS).map(function (k) { return '<label>' + STAT_LABELS[k] + '<input id="ds_' + k + '" type="number" min="0" value="' + esc(d.stats[k]) + '"></label>'; }).join('');
      var alive = v.dragonAlive.length ? v.dragonAlive.map(function (a) { return a.world + ' / ' + a.map + '：' + a.hp + '/' + a.maxHp; }).join('；') : '现在没有活着的大地龙';
      var greens = v.greens.map(function (g) { return g.name + ' → ' + g.becomes; }).join('，');
      var ev = (t.eventDrops || []).map(function (e) { return [e.monster, e.itemId, e.chance, e.minCount, e.maxCount].join(','); }).join('\n');
      root.innerHTML =
        '<section class="panel"><h3 style="margin:0 0 8px">屠龙任务</h3><div class="items" style="margin-bottom:8px">流程（照两份官方老客户端）：打怪攒 100 片黄色水晶碎片 → 拼卡圣坛找光明大祭祀米索莉融合成大地之心（黄色水晶，不能交易）→ 凭它领一把封印的火枪（只有她发的枪才解封，枪手可用，不限等级）→ 向她买封印的魔法子弹。「火枪 + 子弹」的普通攻击每枪用掉一发（单发 1 颗、三发 3 颗、六发和极品六发 6 颗，先用好的），伤害 = 攻击 × 0.9～1.1 × 子弹倍率，不看大地龙的防御。V15.2 起：火枪没子弹时按空手伤害算（攻击减去武器攻击，再按防御减免），可以在下面改回“只有子弹能伤龙”。大地龙在焚骨沙漠 1～6 中随机一张出现，出现和被打倒时全服中央公告。</div>' +
        '<div class="grid"><label>黄色水晶碎片掉率（%）<input id="d_shard" type="number" step="0.01" min="0" max="100" value="' + esc(d.shardPercent) + '"></label></div>' +
        '<table class="f" style="margin-top:8px"><tr><th>子弹</th><th>价格（金币）</th><th>伤害倍率</th></tr>' + bullets + '</table></section>' +
        '<section class="panel"><h3 style="margin:0 0 8px">大地龙</h3><div class="items" style="margin-bottom:8px">数值来自原版 ani.tab（801）。造型是网页端自带的 bossdragon 动画（18 帧，一个朝向），不会走动。每个世界最多一只；掉落按原表：真龙鳞 8.1%，2% 掉 5000 金币。</div>' +
        '<div class="items" style="margin-bottom:8px">现在：' + esc(alive) + '</div>' +
        '<div class="grid">' +
        '<label>出现地图（按住 Ctrl 多选，每次随机一张）<select id="d_maps" multiple size="6">' + v.maps.map(function (m) { return '<option' + ((d.maps || [d.map]).indexOf(m) >= 0 ? ' selected' : '') + '>' + esc(m) + '</option>'; }).join('') + '</select></label>' +
        '<label>位置 X（0 = 地图中间）<input id="d_x" type="number" value="' + esc(d.x) + '"></label>' +
        '<label>位置 Y<input id="d_y" type="number" value="' + esc(d.y) + '"></label>' +
        '<label>每天定时出现（如 20:00，北京时间；留空 = 不定时；还要「限时活动」里屠龙开着）<input id="d_time" value="' + esc(d.dailyTime) + '"></label>' +
        '<label>被打倒后几小时自动再出现（0 = 不自动）<input id="d_resp" type="number" min="0" step="0.5" value="' + esc(d.respawnHours) + '"></label>' +
        '<label>屠龙时限（分钟，0 = 不限；到时大地龙离开，公告“时间到，屠龙失败！！！”）<input id="d_limit" type="number" min="0" value="' + esc(d.timeLimitMin) + '"></label>' +
        '<label>龙牙给谁<select id="d_fang"><option value="all"' + (d.fangMode !== 'killer' ? ' selected' : '') + '>在场打过它的所有人</option><option value="killer"' + (d.fangMode === 'killer' ? ' selected' : '') + '>只给最后一击的人</option></select></label>' +
        '<label class="c"><input id="d_town" type="checkbox"' + (d.reviveInTown ? ' checked' : '') + ' style="width:auto"> 在大地龙地图死亡后回城复活</label>' +
        '<label class="c"><input id="d_bullet" type="checkbox"' + (d.bulletOnly ? ' checked' : '') + ' style="width:auto"> 只有子弹能伤龙（不勾 = 没子弹时按空手伤害）</label>' +
        '<label>被大地龙打中时装备掉落概率（%，0 = 关闭）<input id="d_gear" type="number" min="0" max="100" step="0.1" value="' + esc(d.gearDropPercent) + '"></label>' +
        stats +
        '<label>真龙鳞掉率（%）<input id="d_scale" type="number" step="0.1" min="0" max="100" value="' + esc(d.scalePercent) + '"></label>' +
        '<label>金币掉率（%）<input id="d_goldp" type="number" step="0.1" min="0" max="100" value="' + esc(d.goldPercent) + '"></label>' +
        '<label>金币数量<input id="d_gold" type="number" min="0" value="' + esc(d.gold) + '"></label>' +
        '</div><div class="row"><button id="d_save">保存屠龙设置</button><button class="ghost" id="d_reset">恢复默认</button><button id="d_summon">立即召唤大地龙</button><button class="ghost" id="d_dismiss">收回所有大地龙</button><span id="d_msg"></span></div></section>' +
        '<section class="panel"><h3 style="margin:0 0 8px">绿色龙骨变身（愚人节礼物）</h3><div class="items" style="margin-bottom:8px">照原版 2005 年愚人节赠礼规则：同一种绿色材料 10 个，在背包里右键使用，选同一张地图上的玩家送出；对方接收后变成对应怪物的样子（只变外观），下线、换图都不解除，时间到自动恢复；对方拒绝或 1 分钟不回应就退回。' + esc(greens) + '。</div>' +
        '<div class="grid"><label>变身持续（分钟）<input id="t_min" type="number" min="1" value="' + esc(t.minutes) + '"></label>' +
        '<label>使用方式<select id="t_mode"><option value="gift"' + (t.mode === 'gift' ? ' selected' : '') + '>只能送给别人</option><option value="self"' + (t.mode === 'self' ? ' selected' : '') + '>只能自己用</option><option value="both"' + (t.mode === 'both' ? ' selected' : '') + '>两种都可以</option></select></label>' +
        '<label>每次要几个<input id="t_count" type="number" min="1" value="' + esc(t.count) + '"></label>' +
        '<label class="c"><input id="t_on" type="checkbox"' + (t.eventOn ? ' checked' : '') + ' style="width:auto"> 开启活动掉落</label></div>' +
        '<div class="items">愚人节变身活动的开关和时间在「限时活动」页里设，关着时材料不掉落、也不能使用。</div>' +
        '<label style="display:block;margin-top:8px">活动掉落，每行一条：怪物（* = 所有怪物，或怪物名字 / 编号）,物品编号(2635-2638),概率%,最少,最多<textarea id="t_drops" rows="5" style="width:100%;font-family:Consolas,monospace">' + esc(ev) + '</textarea></label>' +
        '<div class="row"><button id="t_save">保存变身设置</button><button class="ghost" id="t_reset">恢复默认</button><span id="t_msg"></span></div></section>';
      $('d_save').onclick = function () {
        var body = { shardPercent: val('d_shard'), prices: {}, mult: {}, maps: Array.prototype.filter.call($('d_maps').options, function (o) { return o.selected; }).map(function (o) { return o.value; }), timeLimitMin: val('d_limit'), fangMode: val('d_fang'), reviveInTown: val('d_town'), bulletOnly: val('d_bullet'), gearDropPercent: val('d_gear'), x: val('d_x'), y: val('d_y'), dailyTime: val('d_time'), respawnHours: val('d_resp'), stats: {}, scalePercent: val('d_scale'), goldPercent: val('d_goldp'), gold: val('d_gold') };
        [603, 604, 605, 606].forEach(function (id) { body.prices[id] = val('dp_' + id); body.mult[id] = val('dm_' + id); });
        Object.keys(STAT_LABELS).forEach(function (k) { body.stats[k] = val('ds_' + k); });
        api('b15/dragon', body).then(function (r) { say('d_msg', r.done.join('') + '（已经在场的大地龙不变，下次出现时用新数值）'); }).catch(function (e) { say('d_msg', e.message, false); });
      };
      $('d_reset').onclick = function () { if (!confirm('屠龙设置恢复默认？')) return; api('b15/dragon', { reset: true }).then(function () { loadDragon().then(function () { say('d_msg', '已恢复默认'); }); }); };
      $('d_summon').onclick = function () { api('b15/summon', {}).then(function (r) { loadDragon().then(function () { say('d_msg', r.done.join('')); }); }).catch(function (e) { say('d_msg', e.message, false); }); };
      $('d_dismiss').onclick = function () { if (!confirm('收回所有大地龙？')) return; api('b15/dismiss', {}).then(function (r) { loadDragon().then(function () { say('d_msg', r.done.join('')); }); }); };
      $('t_save').onclick = function () {
        var drops = val('t_drops').split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
          var p = l.split(/[,，]/).map(function (x) { return x.trim(); });
          return { monster: p[0] || '*', itemId: Number(p[1]), chance: p[2], minCount: p[3] || 1, maxCount: p[4] || p[3] || 1 };
        });
        api('b15/transform', { minutes: val('t_min'), mode: val('t_mode'), count: val('t_count'), eventOn: val('t_on'), eventDrops: drops }).then(function (r) { say('t_msg', r.done.join('')); }).catch(function (e) { say('t_msg', e.message, false); });
      };
      $('t_reset').onclick = function () { if (!confirm('变身设置恢复默认？')) return; api('b15/transform', { reset: true }).then(function () { loadDragon().then(function () { say('t_msg', '已恢复默认'); }); }); };
    });
  }
})();
