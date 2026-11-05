/* V15.2 admin page: 限时活动 (Beijing clock, event schedules, double map, wear, element
 * states, client notices, 美杜沙, festival gifts). Loaded after admin-v15.js. */
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
  function chk(id, on, label) { return '<label class="c"><input id="' + id + '" type="checkbox"' + (on ? ' checked' : '') + ' style="width:auto"> ' + label + '</label>'; }
  function numIn(id, v, label, step) { return '<label>' + label + '<input id="' + id + '" type="number" min="0" step="' + (step || 'any') + '" value="' + esc(v) + '"></label>'; }

  var ID = 'v152events';
  var tabs = document.querySelector('.tabs');
  var modal = $('modal');
  var btn = document.createElement('button'); btn.setAttribute('data-view', ID); btn.textContent = '限时活动'; tabs.appendChild(btn);
  var root = document.createElement('div'); root.id = ID; root.className = 'v12'; root.hidden = true;
  document.body.insertBefore(root, modal);
  tabs.addEventListener('click', function (e) {
    var v = e.target.dataset && e.target.dataset.view; if (!v) return;
    root.hidden = v !== ID;
    if (v !== ID) return;
    Array.prototype.forEach.call(document.querySelectorAll('body > main, body > div.wide, #settingsView, body > div.v12'), function (el) { if (el.id !== ID) el.hidden = true; });
    Array.prototype.forEach.call(tabs.querySelectorAll('button'), function (b) { b.classList.toggle('on', b === e.target); b.classList.toggle('active', b === e.target); });
    load();
  });

  var MODES = { off: '关闭', always: '一直开', ranges: '指定时段', weekly: '每周固定' };
  var view = null;
  function post(action, body, msg) {
    return api('b152/' + action, body).then(function (r) { view = r.view; draw(); say(msg || 'v_msg', r.done.join('')); })
      .catch(function (e) { say(msg || 'v_msg', e.message, false); });
  }
  function load() { return api('b152').then(function (v) { view = v; draw(); }).catch(function (e) { root.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }); }

  function eventRow(e) {
    var c = e.config, k = e.key;
    var days = view.days.map(function (d, i) { return '<label class="c" style="display:inline-flex;margin-right:6px"><input type="checkbox" data-day="' + k + '" value="' + i + '"' + ((c.weekly.days || []).indexOf(i) >= 0 ? ' checked' : '') + ' style="width:auto">' + esc(d) + '</label>'; }).join('');
    var ranges = (c.ranges || []).map(function (r) { return r.from + ' ~ ' + r.to; }).join('\n');
    var state = e.on ? '<b style="color:var(--ok)">进行中</b>' : '<b style="opacity:.7">未开启</b>';
    if (e.manual) state += '（手动）';
    return '<div class="panel" style="margin:8px 0;padding:8px">' +
      '<div class="row" style="margin:0"><b style="min-width:120px">' + esc(e.name) + '</b> ' + state + (e.next ? ' · 下次变化：' + esc(e.next) : '') +
      ' <button data-man="' + k + '" data-on="1">立即开启</button><button class="ghost" data-man="' + k + '" data-on="0">立即关闭</button>' + (e.manual ? '<button class="ghost" data-man="' + k + '" data-on="">按排期</button>' : '') + '</div>' +
      '<div class="grid" style="margin-top:6px">' +
      '<label>开放方式<select id="em_' + k + '">' + Object.keys(MODES).map(function (m) { return '<option value="' + m + '"' + (m === c.mode ? ' selected' : '') + '>' + MODES[m] + '</option>'; }).join('') + '</select></label>' +
      '<label>每周固定：开始<input id="ews_' + k + '" value="' + esc(c.weekly.start) + '"></label>' +
      '<label>每周固定：结束（早于开始 = 跨到第二天）<input id="ewe_' + k + '" value="' + esc(c.weekly.end) + '"></label>' +
      '<label>开启公告（空 = 不公告）<input id="est_' + k + '" value="' + esc(c.startText) + '"></label>' +
      '<label>结束公告<input id="eet_' + k + '" value="' + esc(c.endText) + '"></label>' +
      '</div><div style="margin:4px 0">每周固定的日子：' + days + '</div>' +
      '<label style="display:block">指定时段，每行一段，北京时间：2026-12-24 20:00 ~ 2026-12-26 00:00<textarea id="er_' + k + '" rows="2" style="width:100%;font-family:Consolas,monospace">' + esc(ranges) + '</textarea></label>' +
      '<div class="row"><button data-save="' + k + '">保存排期</button><button class="ghost" data-reset="' + k + '">恢复默认</button><span id="emsg_' + k + '"></span></div></div>';
  }

  function draw() {
    var v = view, c = v.clock;
    var clock = '<section class="panel"><h3 style="margin:0 0 8px">北京时间</h3>' +
      '<div class="items">现在：<b>' + esc(c.now) + '</b>（UTC+8）' +
      (c.synced ? ' · 已和 ' + esc(c.source) + ' 对时（' + esc(c.lastSync) + '），本机时钟偏差 ' + c.offsetSec + ' 秒' :
        ' · <b style="color:var(--bad)">对时失败，正在用服务器电脑的时钟</b>' + (c.error ? '：' + esc(c.error) : '')) +
      '<br>启动时和之后每 6 小时自动对时一次，所有活动排期都按北京时间。对时服务器：' + esc(c.servers.join('、')) + '</div>' +
      '<div class="row"><button id="v_resync">立即对时</button><span id="v_msg"></span></div></section>';

    var events = '<section class="panel"><h3 style="margin:0 0 8px">活动排期</h3><div class="items">每个活动可以选：关闭、一直开、指定时段（可以写多段）、每周固定（选星期几和时间）。“立即开启 / 关闭”只管到下一个排期点，之后回到排期。屠龙关掉时场上的大地龙会被收回；节日活动开启时，在线玩家和之后上线的玩家各收到一份礼物。</div>' +
      v.events.map(eventRow).join('') + '</section>';

    var d = v.double, now = v.doubleNow;
    var maps = v.huntingMaps.map(function (m) { return '<label class="c" style="display:inline-flex;margin-right:8px"><input type="checkbox" data-dpool value="' + esc(m.id) + '"' + (d.pool.indexOf(m.id) >= 0 ? ' checked' : '') + ' style="width:auto">' + esc(m.name) + '</label>'; }).join('');
    var dbl = '<section class="panel"><h3 style="margin:0 0 8px">每小时双倍地图</h3><div class="items">“双倍地图”活动开着时，每个整点从猎场里随机选（不会连着两小时选同一张）。卡片、黄色水晶碎片、原版特殊掉落不翻倍。' +
      (now ? '<br>这一小时（' + esc(now.hour) + ' 点）：<b>' + esc(now.maps.map(function (m) { return m.name + (m.band ? '（' + m.band + ' 级）' : ''); }).join('、') || '没有可选的地图') + '</b>' : '') + '</div>' +
      '<div class="grid">' + numIn('db_exp', d.expMult, '经验倍数') + numIn('db_drop', d.dropMult, '物品掉落倍数') + numIn('db_gold', d.goldMult, '金币倍数') +
      chk('db_band', d.byBand, '按等级段各选一张（不勾 = 全服只选一张）') + '<label>等级段（怪物等级）<input id="db_bands" value="' + esc(d.bands) + '"></label></div>' +
      '<div style="margin:6px 0">参与抽选的地图（都不勾 = 所有猎场）：<div style="max-height:160px;overflow:auto">' + maps + '</div></div>' +
      '<div class="row"><button id="db_save">保存</button><button class="ghost" id="db_reset">恢复默认</button><span id="db_msg"></span></div></section>';

    var w = v.wear;
    var wear = '<section class="panel"><h3 style="margin:0 0 8px">装备耐久磨损</h3><div class="items">攻击（打空也算）累计到次数，武器耐久 -1；被打中累计到次数，其它每件装备 -1。被大地龙打中按倍数算。耐久到 0 的装备格子变红、显示红色“已损坏”，自动卸下，修好之前穿不上。</div>' +
      '<div class="grid">' + chk('w_on', w.on, '开启磨损') + numIn('w_n', w.hitsPerPoint, '每多少次扣 1 点', 1) + numIn('w_dm', w.dragonMult, '大地龙打一下算几次', 1) + '</div>' +
      '<div class="row"><button id="w_save">保存</button><button class="ghost" id="w_reset">恢复默认</button><span id="w_msg"></span></div></section>';

    var s = v.status;
    var st = '<section class="panel"><h3 style="margin:0 0 8px">冰冻与中毒</h3><div class="items">照老客户端：带冰的攻击让对方减速并变蓝，带毒的让对方中毒并变绿。怪物带的毒每秒掉“毒点数 × (1 − 毒抗)”。冰箭术减速 3 + 技能等级÷2 秒（怪物放的 3.5 秒），寒冰冲击波冻住；再中一次重新计时，不叠加。</div>' +
      '<div class="grid">' + chk('s_on', s.on, '开启冰冻 / 中毒') +
      numIn('s_sec', s.seconds, '怪物带冰 / 毒时的持续秒数') + numIn('s_slow', s.iceSlowPct, '减速（%）') + numIn('s_iodd', s.iceOdds, '带冰时触发几率（%）') + numIn('s_podd', s.poisonOdds, '带毒时触发几率（%）') +
      numIn('s_frz', s.freezeSec, '寒冰冲击波冻住秒数') + chk('s_boss', s.bossFreezeHalf, '大地龙等首领冻住时间减半') +
      numIn('s_pp', s.poisonSkillPct, '施毒术每秒掉这一下伤害的（%）') + numIn('s_ps', s.poisonSkillSec, '施毒术持续秒数') +
      numIn('s_mp', s.mistPct, '毒雾每秒掉这一下伤害的（%）') + numIn('s_ms', s.mistSec, '毒雾持续秒数') +
      chk('s_kill', s.poisonKillsPlayers, '中毒能把玩家毒死（不勾 = 最多毒到剩 1 点）') +
      chk('s_elem', s.elementOnlySkills, '装备的元素点数只加同元素技能（不勾 = 每一下攻击都加，V15.1 以前的做法）') + '</div>' +
      '<div class="row"><button id="s_save">保存</button><button class="ghost" id="s_reset">恢复默认</button><span id="s_msg"></span></div></section>';

    var n = v.notices;
    var nt = '<section class="panel"><h3 style="margin:0 0 8px">左下角系统提示</h3><div class="items">勾上的提示会显示，不勾的隐藏（默认都隐藏）。</div><div class="grid">' +
      Object.keys(v.noticeLabels).map(function (k) { return chk('n_' + k, n[k], esc(v.noticeLabels[k])); }).join('') + '</div>' +
      '<div class="row"><button id="n_save">保存</button><span id="n_msg"></span></div></section>';

    var m = v.medusa;
    var md = '<section class="panel"><h3 style="margin:0 0 8px">美杜沙（临时版）</h3><div class="items">在猎场用召唤菜单召唤，数值来自原版 ani.tab 1511（等级 210、生命 34000、防御 4000），魔法“石化”附带中毒。造型暂时借蜥蜴人；数值和掉落在「怪物」页的“美杜沙”里改。</div>' +
      '<div class="grid">' + chk('m_on', m.on, '可以召唤') + numIn('m_skin', m.skin, '要几个蜥蜴皮', 1) + numIn('m_tail', m.tail, '要几个蜥蜴尾刺', 1) + numIn('m_pet', m.petrifySec, '石化定身秒数（0 = 不定身）') + '</div>' +
      '<div class="row"><button id="m_save">保存</button><button class="ghost" id="m_reset">恢复默认</button><span id="m_msg"></span></div></section>';

    var fest = '<section class="panel"><h3 style="margin:0 0 8px">节日礼物</h3><div class="items">节日活动的排期在上面“活动排期”里设。奖品每行一件：物品编号,数量。</div>' +
      Object.keys(v.festivals).map(function (k) {
        var f = v.festivals[k], name = (v.events.filter(function (e) { return e.key === k; })[0] || {}).name || k;
        return '<div class="panel" style="margin:8px 0;padding:8px"><b>' + esc(name) + '</b>' +
          '<label style="display:block">赠礼说明<input id="ft_' + k + '" value="' + esc(f.text) + '" style="width:100%"></label>' +
          '<label style="display:block">奖品（' + esc(f.items.map(function (x) { return x.name + '×' + x.count; }).join('，')) + '）<textarea id="fi_' + k + '" rows="2" style="width:100%;font-family:Consolas,monospace">' + esc(f.items.map(function (x) { return x.itemId + ',' + x.count; }).join('\n')) + '</textarea></label>' +
          '<div class="row"><button data-fsave="' + k + '">保存</button><button class="ghost" data-freset="' + k + '">恢复默认</button><span id="fmsg_' + k + '"></span></div></div>';
      }).join('') + '</section>';

    root.innerHTML = clock + events + dbl + wear + st + nt + md + fest;
    bind();
  }

  function bind() {
    $('v_resync').onclick = function () { say('v_msg', '对时中……'); post('resync', {}); };
    Array.prototype.forEach.call(root.querySelectorAll('[data-man]'), function (b) {
      b.onclick = function () { var on = b.getAttribute('data-on'); post('manual', { key: b.getAttribute('data-man'), on: on === '' ? null : on === '1' }, 'emsg_' + b.getAttribute('data-man')); };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-save]'), function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-save');
        var ranges = val('er_' + k).split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) { var p = l.split(/\s*[~～]\s*/); return { from: p[0], to: p[1] || '' }; });
        var days = Array.prototype.filter.call(root.querySelectorAll('[data-day="' + k + '"]'), function (x) { return x.checked; }).map(function (x) { return Number(x.value); });
        post('event', { key: k, mode: val('em_' + k), ranges: ranges, weekly: { days: days, start: val('ews_' + k), end: val('ewe_' + k) }, startText: val('est_' + k), endText: val('eet_' + k) }, 'emsg_' + k);
      };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-reset]'), function (b) {
      b.onclick = function () { var k = b.getAttribute('data-reset'); if (confirm('排期恢复默认？')) post('event', { key: k, reset: true }, 'emsg_' + k); };
    });
    $('db_save').onclick = function () {
      var pool = Array.prototype.filter.call(root.querySelectorAll('[data-dpool]'), function (x) { return x.checked; }).map(function (x) { return x.value; });
      post('part', { key: 'double', expMult: val('db_exp'), dropMult: val('db_drop'), goldMult: val('db_gold'), byBand: val('db_band'), bands: val('db_bands'), pool: pool }, 'db_msg');
    };
    $('db_reset').onclick = function () { post('part', { key: 'double', reset: true }, 'db_msg'); };
    $('w_save').onclick = function () { post('part', { key: 'wear', on: val('w_on'), hitsPerPoint: val('w_n'), dragonMult: val('w_dm') }, 'w_msg'); };
    $('w_reset').onclick = function () { post('part', { key: 'wear', reset: true }, 'w_msg'); };
    $('s_save').onclick = function () {
      post('part', { key: 'status', on: val('s_on'), seconds: val('s_sec'), iceSlowPct: val('s_slow'), iceOdds: val('s_iodd'), poisonOdds: val('s_podd'), freezeSec: val('s_frz'), bossFreezeHalf: val('s_boss'),
        poisonSkillPct: val('s_pp'), poisonSkillSec: val('s_ps'), mistPct: val('s_mp'), mistSec: val('s_ms'), poisonKillsPlayers: val('s_kill'), elementOnlySkills: val('s_elem') }, 's_msg');
    };
    $('s_reset').onclick = function () { post('part', { key: 'status', reset: true }, 's_msg'); };
    $('n_save').onclick = function () {
      var body = { key: 'notices' }; Object.keys(view.noticeLabels).forEach(function (k) { body[k] = val('n_' + k); });
      post('part', body, 'n_msg');
    };
    $('m_save').onclick = function () { post('part', { key: 'medusa', on: val('m_on'), skin: val('m_skin'), tail: val('m_tail'), petrifySec: val('m_pet') }, 'm_msg'); };
    $('m_reset').onclick = function () { post('part', { key: 'medusa', reset: true }, 'm_msg'); };
    Array.prototype.forEach.call(root.querySelectorAll('[data-fsave]'), function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-fsave');
        var items = val('fi_' + k).split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) { var p = l.split(/[,，\s]+/); return { itemId: Number(p[0]), count: Number(p[1] || 1) }; });
        post('part', { key: 'festival:' + k, text: val('ft_' + k), items: items }, 'fmsg_' + k);
      };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-freset]'), function (b) {
      b.onclick = function () { var k = b.getAttribute('data-freset'); post('part', { key: 'festival:' + k, reset: true }, 'fmsg_' + k); };
    });
  }
})();
