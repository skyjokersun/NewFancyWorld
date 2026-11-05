/* Twelfth batch admin pages: 物品, 地图与大区, 公式, 婚礼与团队, 新职业与上传, and the
   drops section of the 怪物 page. Loaded after the main page script. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function api(path, body) {
    return fetch('/api/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
      .then(function (r) { return r.json().then(function (j) { if (r.status === 401 && j.login) location.reload(); if (!r.ok) throw new Error(j.error || r.status); return j; }); });
  }
  function say(id, text, ok) { var el = $(id); if (!el) return; el.textContent = text; el.className = ok === false ? 'bad' : 'ok'; el.style.color = ok === false ? 'var(--bad)' : 'var(--ok)'; }

  var style = document.createElement('style');
  style.textContent =
    '.v12 { padding:16px 20px; display:grid; gap:16px; max-width:1200px; }' +
    '.v12 .split { display:grid; grid-template-columns:minmax(300px,380px) 1fr; gap:16px; }' +
    '@media (max-width:760px){ .v12 .split { grid-template-columns:1fr; } }' +
    '.v12 .list { max-height:calc(100vh - 260px); overflow:auto; }' +
    '.v12 .it { display:flex; gap:8px; align-items:center; padding:4px 8px; border-radius:5px; cursor:pointer; }' +
    '.v12 .it:hover { background:#f6efe0; } .v12 .it.sel { background:#efe0c2; }' +
    '.v12 .it .n { flex:1; } .v12 .it img { width:24px; height:24px; image-rendering:pixelated; }' +
    '.v12 table.f { width:100%; border-collapse:collapse; font-size:13px; } .v12 table.f td, .v12 table.f th { padding:4px 6px; border-top:1px solid var(--line); text-align:left; vertical-align:middle; }' +
    '.v12 table.f input { width:100%; font-family:Consolas,monospace; font-size:12px; }' +
    '.v12 .vars { font-size:12px; color:var(--muted); columns:2; } .v12 .vars b { color:var(--ink); font-family:Consolas,monospace; }' +
    '.v12 button, #monDetail table button { white-space:nowrap; } .v12 .icon { width:64px; height:64px; image-rendering:pixelated; border:1px solid var(--line); background:#fafafa; }' +
    '.v12 .pill { display:inline-block; padding:0 8px; border-radius:10px; font-size:12px; background:#efe7d6; color:var(--muted); margin-left:4px; }' +
    '.v12 .pill.on { background:#dff0df; color:var(--ok); } .v12 .pill.off { background:#f8dcd9; color:var(--bad); }';
  document.head.appendChild(style);

  var VIEWS = [
    { id: 'v12items', label: '物品', load: loadItems },
    { id: 'v12world', label: '地图与大区', load: loadWorld },
    { id: 'v12formula', label: '公式', load: loadFormulas },
    { id: 'v12social', label: '婚礼与团队', load: function () { if (window.__qiyuV12.loadSocial) window.__qiyuV12.loadSocial($('v12social')); } },
    { id: 'v12new', label: '新职业与上传', load: function () { if (window.__qiyuV12.loadNew) window.__qiyuV12.loadNew($('v12new')); } },
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
    // Hide the main page's own views.
    Array.prototype.forEach.call(document.querySelectorAll('body > main, body > div.wide, #settingsView'), function (el) { el.hidden = true; });
    mine.load();
  });

  // ================= 物品 =================
  var items = [], meta = null, itemSel = null, itemCat = '';
  var KIND_ORDER = ['medicine', 'equipment', 'gem', 'engraving', 'material', 'misc'];
  function loadItems() {
    var root = $('v12items');
    if (!root.firstChild) {
      root.innerHTML =
        '<section class="panel"><h3 style="margin:0 0 8px">职业可用的装备标签</h3><div class="items" style="margin-bottom:8px">装备可以有多个标签；职业列出它能穿的标签，装备上任一标签对上就能穿（还要满足等级）。默认每个职业的标签就是它自己，和以前完全一样。用顿号或逗号分隔。</div><div id="ptags" class="grid"></div><div id="ptmsg"></div></section>' +
        '<div class="split"><section class="panel"><div class="row" style="margin:0 0 8px"><input id="iq" placeholder="搜索名字或编号" style="flex:1;width:auto"><button id="inew">新建物品</button></div>' +
        '<div class="chips" id="icat"></div><div class="list" id="ilist"><div class="empty">加载中…</div></div></section>' +
        '<section class="panel" id="idetail"><div class="empty">在左边选择一件物品，或新建</div></section></div>';
      $('iq').oninput = renderItemList;
      $('inew').onclick = newItemForm;
    }
    return api('item-admin').then(function (r) { items = r.items; meta = r.meta; renderTags(); renderCats(); renderItemList(); if (itemSel) openItem(itemSel); });
  }
  function splitTags(s) { return String(s || '').split(/[,，、\s]+/).map(function (x) { return x.trim(); }).filter(Boolean); }
  function renderTags() {
    $('ptags').innerHTML = Object.keys(meta.professionTags).map(function (p) {
      return '<label>' + esc(meta.professionNames[p] || p) + '<input data-pt="' + esc(p) + '" value="' + esc(meta.professionTags[p].join('、')) + '"></label>';
    }).join('') + '<div style="align-self:end"><button id="ptsave">保存职业标签</button></div>';
    $('ptsave').onclick = function () {
      var jobs = Array.prototype.map.call(document.querySelectorAll('[data-pt]'), function (el) { return [el.getAttribute('data-pt'), splitTags(el.value)]; });
      var chain = Promise.resolve(), done = [];
      jobs.forEach(function (j) { chain = chain.then(function () { return api('profession-tags/' + encodeURIComponent(j[0]), { tags: j[1] }).then(function (r) { done.push(r.done[0]); meta = r.meta; }); }); });
      chain.then(function () { say('ptmsg', '已保存'); }).catch(function (e) { say('ptmsg', e.message, false); });
    };
  }
  function renderCats() {
    var cats = ['全部'].concat(KIND_ORDER.map(function (k) { return meta.kinds[k]; })).concat(['新增的', '改过的', '停用的']);
    $('icat').innerHTML = cats.map(function (c) { return '<button class="' + ((itemCat || '全部') === c ? 'on' : '') + '">' + esc(c) + '</button>'; }).join('');
    $('icat').onclick = function (e) { if (e.target.tagName !== 'BUTTON') return; itemCat = e.target.textContent; renderCats(); renderItemList(); };
  }
  function renderItemList() {
    var q = ($('iq').value || '').trim().toLowerCase();
    var list = items.filter(function (it) {
      if (q && it.name.toLowerCase().indexOf(q) < 0 && String(it.itemId).indexOf(q) < 0) return false;
      if (!itemCat || itemCat === '全部') return true;
      if (itemCat === '新增的') return it.added; if (itemCat === '改过的') return it.edited; if (itemCat === '停用的') return it.disabled;
      return meta.kinds[it.kind] === itemCat;
    });
    $('ilist').innerHTML = list.slice(0, 600).map(function (it) {
      return '<div class="it' + (it.itemId === itemSel ? ' sel' : '') + '" data-id="' + it.itemId + '"><span class="n">' + esc(it.name) + ' <small class="items">' + it.itemId + ' · ' + esc(meta.kinds[it.kind] || '') + (it.slot ? ' · ' + esc(it.slot) : '') + '</small></span>' +
        (it.added ? '<span class="pill on">新增</span>' : '') + (it.edited ? '<span class="pill">已改</span>' : '') + (it.disabled ? '<span class="pill off">停用</span>' : '') + '</div>';
    }).join('') + (list.length > 600 ? '<div class="items">还有 ' + (list.length - 600) + ' 件，请搜索</div>' : '') || '<div class="empty">没有</div>';
    $('ilist').onclick = function (e) { var d = e.target.closest('[data-id]'); if (d) openItem(Number(d.getAttribute('data-id'))); };
  }
  function attrRows(list) {
    return list.map(function (a, i) {
      return '<tr><td><select data-ak="' + i + '">' + Object.keys(meta.attrs).map(function (k) { return '<option value="' + k + '"' + (k === a.key ? ' selected' : '') + '>' + esc(meta.attrs[k]) + '</option>'; }).join('') + '</select></td>' +
        '<td><input data-av="' + i + '" value="' + esc(a.value) + '" inputmode="decimal"></td><td><button class="ghost" data-adel="' + i + '">删除</button></td></tr>';
    }).join('');
  }
  function itemForm(d, isNew) {
    var kindSel = isNew ? '<label>种类<select id="fkind">' + KIND_ORDER.map(function (k) { return '<option value="' + k + '">' + esc(meta.kinds[k]) + '</option>'; }).join('') + '</select></label>' +
      '<label>装备部位（只限装备）<select id="fslot"><option value="">—</option>' + meta.slots.map(function (s) { return '<option>' + s + '</option>'; }).join('') + '</select></label>' : '';
    var affix = isNew || d.added && (d.kind === 'gem' || d.kind === 'engraving');
    return '<div class="grid">' + kindSel +
      '<label>名字<input id="fname" value="' + esc(d.name) + '" maxlength="24"></label>' +
      '<label>买价<input id="fbuy" value="' + (d.buyPrice || 0) + '" inputmode="numeric"></label>' +
      '<label>卖价<input id="fsell" value="' + (d.sellPrice || 0) + '" inputmode="numeric"></label>' +
      '<label>重量<input id="fweight" value="' + (d.weight || 0) + '" inputmode="numeric"></label>' +
      '<label>耐久<input id="fdur" value="' + (d.durability || 1) + '" inputmode="numeric"></label>' +
      '<label>等级要求（职业等级）<input id="flevel" value="' + (d.level || 0) + '" inputmode="numeric"></label>' +
      '<label>标签（顿号分隔；职业名如 warrior、archer）<input id="ftags" value="' + esc((d.tags || []).join('、')) + '"></label>' +
      (affix ? '<label>宝石后缀 / 印刻前缀名（只限宝石、印刻）<input id="faffix" value="' + esc(d.affixName || '') + '" maxlength="8"></label>' +
        '<label>宝石 / 印刻等级（0–3，决定融合需要的技能等级）<input id="fgrade" value="' + (d.affixGrade || 0) + '" inputmode="numeric"></label>' : '') +
      '</div><label style="margin-top:8px">说明<input id="fdesc" value="' + esc(d.desc || '') + '" maxlength="200"></label>' +
      '<div class="section"><h3>属性 <small class="items">药品可以同时有「恢复体力」和「恢复精力」；宝石、印刻的属性就是融合后加到装备上的词缀属性</small></h3><table class="f"><tbody id="fattrs">' + attrRows(d.bonusAttrs || []) + '</tbody></table>' +
      '<div class="row"><button class="ghost" id="faddattr">加一条属性</button></div></div>';
  }
  function readForm(attrs) {
    return {
      kind: $('fkind') ? $('fkind').value : undefined, slot: $('fslot') ? $('fslot').value : undefined,
      name: $('fname').value, desc: $('fdesc').value, buyPrice: Number($('fbuy').value), sellPrice: Number($('fsell').value),
      weight: Number($('fweight').value), durability: Number($('fdur').value), level: Number($('flevel').value), tags: splitTags($('ftags').value),
      affixName: $('faffix') ? $('faffix').value : undefined, affixGrade: $('fgrade') ? Number($('fgrade').value) : undefined,
      bonusAttrs: attrs,
    };
  }
  function wireAttrs(attrs) {
    function sync() {
      Array.prototype.forEach.call(document.querySelectorAll('[data-ak]'), function (el) { attrs[+el.getAttribute('data-ak')].key = el.value; });
      Array.prototype.forEach.call(document.querySelectorAll('[data-av]'), function (el) { attrs[+el.getAttribute('data-av')].value = Number(el.value); });
    }
    function redraw() { $('fattrs').innerHTML = attrRows(attrs); }
    $('faddattr').onclick = function () { sync(); attrs.push({ key: 'attack', value: 1 }); redraw(); };
    $('fattrs').onclick = function (e) { var b = e.target.closest('[data-adel]'); if (!b) return; sync(); attrs.splice(+b.getAttribute('data-adel'), 1); redraw(); };
    return sync;
  }
  function newItemForm() {
    itemSel = null; renderItemList();
    var attrs = [];
    $('idetail').innerHTML = '<h2>新建物品</h2><div class="sub">编号从 ' + meta.firstNewId + ' 起自动分配。建好后可以上传图标。</div>' + itemForm({ name: '' }, true) +
      '<div class="row"><button id="fcreate">新建</button></div><div id="imsg"></div>';
    var sync = wireAttrs(attrs);
    $('fcreate').onclick = function () { sync(); api('item-admin/new', readForm(attrs)).then(function (r) { items = r.items; itemSel = r.id; renderItemList(); openItem(r.id); }).catch(function (e) { say('imsg', e.message, false); }); };
  }
  function openItem(id) {
    itemSel = id; renderItemList();
    api('item-admin/' + id).then(function (d) {
      var attrs = d.bonusAttrs.slice();
      $('idetail').innerHTML = '<h2>' + esc(d.name) + ' <span class="tag">' + d.itemId + '</span>' + (d.added ? '<span class="pill on">新增</span>' : '') + (d.edited ? '<span class="pill">已改</span>' : '') + (d.disabled ? '<span class="pill off">停用</span>' : '') + '</h2>' +
        '<div class="sub">' + esc(meta.kinds[d.kind] || '') + (d.slot ? ' · ' + esc(d.slot) : '') + (d.original ? ' · 原版：' + esc(d.original.name) + '，买价 ' + d.original.buyPrice + '，卖价 ' + d.original.sellPrice : '') + '</div>' +
        '<div class="row" style="margin:0 0 10px"><img class="icon" id="ficon" src="' + esc(d.icon) + '?t=' + Date.now() + '" onerror="this.style.visibility=\'hidden\'"><div><input type="file" id="ffile" accept="image/*"><div class="items">上传任意图片，会自动缩成 32×32；' + (d.atlas ? '玩家刷新页面后看到' : '这件物品在图标表里没有格子，不能换图标') + '</div></div></div>' +
        itemForm(d, false) +
        '<div class="row"><button id="fsave">保存</button><button class="ghost" id="fdis">' + (d.disabled ? '重新启用' : '停用') + '</button>' +
        (d.added ? '<button class="danger" id="fdel">删除这件新物品</button>' : d.edited ? '<button class="danger" id="fdel">恢复原版数值</button>' : '') + '</div><div id="imsg"></div>' +
        '<div class="items" style="margin-top:8px">改动保存后马上生效；在线玩家背包里的同种物品也会更新。商店、掉落用新数值。停用：商店不再卖、怪物不再掉，已有的不受影响。</div>';
      var sync = wireAttrs(attrs);
      $('fsave').onclick = function () { sync(); api('item-admin/' + id, readForm(attrs)).then(function (r) { items = r.items; renderItemList(); openItem(id); setTimeout(function () { say('imsg', r.done.join('')); }, 300); }).catch(function (e) { say('imsg', e.message, false); }); };
      $('fdis').onclick = function () { api('item-admin/' + id + '/disable', { off: !d.disabled }).then(function (r) { items = r.items; openItem(id); setTimeout(function () { say('imsg', r.done.join('')); }, 300); }).catch(function (e) { say('imsg', e.message, false); }); };
      if ($('fdel')) $('fdel').onclick = function () {
        if (!confirm(d.added ? '删除 ' + d.name + '？玩家手里已有的会变成无效物品。' : '把 ' + d.name + ' 恢复成原版数值？')) return;
        api('item-admin/' + id + '/delete', {}).then(function (r) { items = r.items; if (d.added) { itemSel = null; $('idetail').innerHTML = '<div class="empty">' + esc(r.done.join('')) + '</div>'; renderItemList(); } else openItem(id); }).catch(function (e) { say('imsg', e.message, false); });
      };
      $('ffile').onchange = function () {
        var f = this.files && this.files[0]; if (!f) return;
        var img = new Image();
        img.onload = function () {
          var cv = document.createElement('canvas'); cv.width = 32; cv.height = 32;
          var g = cv.getContext('2d'); g.imageSmoothingEnabled = true;
          var s = Math.min(32 / img.width, 32 / img.height), w = Math.round(img.width * s), h = Math.round(img.height * s);
          g.drawImage(img, Math.floor((32 - w) / 2), Math.floor((32 - h) / 2), w, h);
          api('item-admin/' + id + '/icon', { png: cv.toDataURL('image/png') }).then(function (r) { $('ficon').style.visibility = ''; $('ficon').src = d.icon + '?t=' + Date.now(); say('imsg', r.done.join('')); }).catch(function (e) { say('imsg', e.message, false); });
        };
        img.src = URL.createObjectURL(f);
      };
    }).catch(function (e) { $('idetail').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  // ================= 地图与大区 =================
  function loadWorld() {
    var root = $('v12world');
    if (!root.firstChild) {
      root.innerHTML = '<section class="panel"><h3 style="margin:0 0 8px">大区</h3><div class="items" style="margin-bottom:8px">登录界面只能点开放的区；每个区的角色分开，同一账号可以在各区各建一个角色。关闭一个区不会踢掉在线的人，只是不能再登录。原来的角色都在「西部圣域」。</div><table class="f" id="ztable"></table><div id="zmsg"></div></section>' +
        '<section class="panel"><h3 style="margin:0 0 8px">地图开放</h3><div class="items" style="margin-bottom:8px">关闭的地图不赶人，只是不能进去，进门时屏幕中间提示「该地图暂未开放」。</div>' +
        '<div class="row" style="margin:0 0 8px"><input id="mq" placeholder="搜索地图编号或名字" style="flex:1;width:auto"><label style="width:auto"><input type="checkbox" id="mclosed" style="width:auto"> 只看关闭的</label></div><div class="list"><table class="f" id="mtable"></table></div><div id="momsg"></div></section>';
      $('mq').oninput = renderMaps; $('mclosed').onchange = renderMaps;
    }
    return Promise.all([api('zones'), api('maps-open')]).then(function (r) { zones = r[0].zones; mapsOpen = r[1].maps; renderZones(); renderMaps(); });
  }
  var zones = [], mapsOpen = [];
  function renderZones() {
    $('ztable').innerHTML = '<tr><th>区</th><th>角色数</th><th>在线</th><th>状态</th><th></th></tr>' + zones.map(function (z) {
      return '<tr><td>' + esc(z.name) + ' <small class="items">' + esc(z.id) + '</small></td><td>' + z.characters + '</td><td>' + z.online + '</td><td>' + (z.open ? '<span class="pill on">开放</span>' : '<span class="pill off">关闭</span>') + '</td>' +
        '<td><button class="ghost" data-z="' + esc(z.id) + '" data-open="' + (z.open ? 0 : 1) + '">' + (z.open ? '关闭' : '开放') + '</button></td></tr>';
    }).join('');
    $('ztable').onclick = function (e) { var b = e.target.closest('[data-z]'); if (!b) return; api('zone/' + b.getAttribute('data-z'), { open: b.getAttribute('data-open') === '1' }).then(function (r) { zones = r.zones; renderZones(); say('zmsg', r.done.join('')); }).catch(function (e2) { say('zmsg', e2.message, false); }); };
  }
  function renderMaps() {
    var q = ($('mq').value || '').trim().toLowerCase(), only = $('mclosed').checked;
    var list = mapsOpen.filter(function (m) { return (!only || !m.open) && (!q || m.mapId.indexOf(q) >= 0 || (m.name || '').toLowerCase().indexOf(q) >= 0); });
    $('mtable').innerHTML = list.map(function (m) {
      return '<tr><td>' + esc(m.name || '') + ' <small class="items">' + esc(m.mapId) + '</small></td><td>' + (m.open ? '<span class="pill on">开放</span>' : '<span class="pill off">关闭</span>') + '</td><td><button class="ghost" data-m="' + esc(m.mapId) + '" data-open="' + (m.open ? 0 : 1) + '">' + (m.open ? '关闭' : '开放') + '</button></td></tr>';
    }).join('');
    $('mtable').onclick = function (e) { var b = e.target.closest('[data-m]'); if (!b) return; var id = b.getAttribute('data-m'); api('map-open/' + encodeURIComponent(id), { open: b.getAttribute('data-open') === '1' }).then(function (r) { mapsOpen.forEach(function (m) { if (m.mapId === id) m.open = b.getAttribute('data-open') === '1'; }); renderMaps(); say('momsg', r.done.join('')); }).catch(function (e2) { say('momsg', e2.message, false); }); };
  }

  // ================= 公式 =================
  var fview = null, fedit = null;
  function loadFormulas() {
    return api('formulas').then(function (v) { fview = v; renderFormulas(); });
  }
  function renderFormulas() {
    var v = fview;
    var root = $('v12formula');
    root.innerHTML = '<section class="panel"><h3 style="margin:0 0 8px">正在使用的公式</h3><div class="items" style="margin-bottom:8px">切换后所有在线角色立刻重新计算，离线角色下次上线时按新公式计算。「原版」照老客户端：攻击、破坏按职业分支并乘职业倍率和武器熟练倍率，负重 2×力量×(战斗等级+10)、超过 90% 算超重；生命、精力、防御、攻速的基础部分原版资料里没有，沿用网页版（去掉隐藏成长）。<br><b>元素伤害（推测，原版未知）</b>：元素值 ×（1 − 对方该元素抗性%），抗性上限见「服务器设置」。老客户端只把装备上的火/毒/雷/冰攻击值按整数相加，原版最终怎么扣血查不到，不能当成原版。</div>' +
      v.sets.map(function (s) { return '<label style="display:flex;gap:8px;align-items:center;font-size:14px;color:var(--ink)"><input type="radio" name="fact" value="' + esc(s.id) + '" style="width:auto"' + (s.id === v.active ? ' checked' : '') + '> ' + esc(s.name) + (s.builtin ? '' : ' <span class="pill">自定义</span>') + '</label>'; }).join('') +
      '<div class="row"><button id="fuse">使用选中的公式</button><span id="famsg"></span></div></section>' +
      '<section class="panel"><h3 style="margin:0 0 8px">编辑自定义公式</h3><div class="row" style="margin:0 0 8px"><select id="fpick" style="width:auto"><option value="">— 选一套自定义公式 —</option>' +
      v.sets.filter(function (s) { return !s.builtin; }).map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>'; }).join('') + '</select><button class="ghost" id="fcopy">复制原版为新的一套</button></div>' +
      '<div id="fedit"></div></section>' +
      '<section class="panel"><h3 style="margin:0 0 8px">可以用的变量</h3><div class="vars">' + Object.keys(v.vars).map(function (k) { return '<div><b>' + k + '</b> ' + esc(v.vars[k]) + '</div>'; }).join('') + '</div><div class="items" style="margin-top:8px">只能用数字、变量、+ − × ÷、括号和 min(…)、max(…)、floor(…)。保存前会按一个样例角色试算，算不出就不让保存。</div></section>';
    $('fuse').onclick = function () { var r = document.querySelector('[name=fact]:checked'); if (!r) return; api('formula-active', { id: r.value }).then(function (x) { fview = x.view; renderFormulas(); say('famsg', x.done.join('')); }).catch(function (e) { say('famsg', e.message, false); }); };
    $('fcopy').onclick = function () { var o = JSON.parse(JSON.stringify(v.sets.filter(function (s) { return s.id === 'original'; })[0].set)); o.name = '原版副本'; delete o.sources; fedit = { id: null, set: o }; drawEdit(); };
    $('fpick').onchange = function () { var s = v.sets.filter(function (x) { return x.id === $('fpick').value; })[0]; fedit = s ? { id: s.id, set: JSON.parse(JSON.stringify(s.set)) } : null; drawEdit(); };
    if (fedit) { if (fedit.id) $('fpick').value = fedit.id; drawEdit(); }
  }
  function drawEdit() {
    var v = fview, el = $('fedit');
    if (!fedit) { el.innerHTML = ''; return; }
    var s = fedit.set;
    el.innerHTML = '<div class="grid"><label>名字<input id="fsname" value="' + esc(s.name) + '" maxlength="20"></label><label>超重线（负重上限的 %）<input id="fsow" value="' + s.overweightPercent + '" inputmode="numeric"></label></div>' +
      '<table class="f" style="margin-top:10px"><tr><th>职业</th>' + v.keys.map(function (k) { return '<th>' + esc(v.keyNames[k]) + '</th>'; }).join('') + '</tr>' +
      v.groups.map(function (g) { return '<tr><td style="white-space:nowrap">' + esc(v.groupNames[g]) + '</td>' + v.keys.map(function (k) { return '<td><textarea rows="3" style="width:100%;min-width:110px;font:12px monospace;resize:vertical" data-g="' + g + '" data-k="' + k + '">' + esc(s.groups[g][k]) + '</textarea></td>'; }).join('') + '</tr>'; }).join('') + '</table>' +
      '<div class="row"><button class="ghost" id="ftest">试算</button><button id="fsave2">保存</button>' + (fedit.id ? '<button class="danger" id="fdel2">删除这套</button>' : '') + '<span id="femsg"></span></div><div id="fsample" class="items"></div>';
    function read() {
      var o = { name: $('fsname').value, overweightPercent: Number($('fsow').value), groups: {} };
      v.groups.forEach(function (g) { o.groups[g] = {}; });
      Array.prototype.forEach.call(el.querySelectorAll('[data-g]'), function (i) { o.groups[i.getAttribute('data-g')][i.getAttribute('data-k')] = i.value; });
      return o;
    }
    function showSample(sample) {
      $('fsample').innerHTML = '样例角色（力量8 敏捷9 感知7 聪明6，战斗30级，职业25级，装备攻击40）：<br>' + v.groups.map(function (g) { return esc(v.groupNames[g]) + '：' + v.keys.map(function (k) { return esc(v.keyNames[k]) + ' ' + sample[g][k]; }).join('，'); }).join('<br>');
    }
    $('ftest').onclick = function () { api('formula-test', { set: read() }).then(function (r) { showSample(r.sample); say('femsg', '试算通过'); }).catch(function (e) { say('femsg', e.message, false); }); };
    $('fsave2').onclick = function () { var o = read(); api('formula-save', { id: fedit.id, set: o }).then(function (r) { fview = r.view; fedit = { id: r.id, set: o }; renderFormulas(); showSample(r.sample); say('femsg', '已保存'); }).catch(function (e) { say('femsg', e.message, false); }); };
    if ($('fdel2')) $('fdel2').onclick = function () { if (!confirm('删除这套公式？')) return; api('formula-delete/' + encodeURIComponent(fedit.id), {}).then(function (r) { fview = r.view; fedit = null; renderFormulas(); say('famsg', r.done.join('')); }).catch(function (e) { say('femsg', e.message, false); }); };
  }

  // ================= 怪物掉落（怪物页里） =================
  function monsterDetail(id, host) {
    var sec = document.createElement('div'); sec.className = 'section'; sec.innerHTML = '<h3>掉落 <small class="items">按怪物设，所有地图生效；概率填百分比，「服务器设置」里的掉落倍率还会再乘上去</small></h3><div class="items">加载中…</div>';
    host.appendChild(sec);
    var allItems = null;
    api('monster-drops/' + encodeURIComponent(id)).then(function (v) {
      var list = (v.custom || v.defaults).map(function (d) { return Object.assign({}, d); });
      function draw(msg) {
        sec.innerHTML = '<h3>掉落 <small class="items">按怪物设，所有地图生效；概率填百分比（物品再乘掉落倍率 ' + v.rates.item + '，金币再乘 ' + v.rates.gold + '）</small> ' + (v.custom ? '<span class="pill">已自定义</span>' : '<span class="pill">默认</span>') + '</h3>' +
          '<table class="f"><tr><th>物品</th><th>概率 %</th><th>最少</th><th>最多</th><th></th></tr>' + list.map(function (d, i) {
            return '<tr><td>' + (d.type === 'gold' ? '金币' : esc(d.name) + ' <small class="items">' + d.itemId + (d.special ? ' · 原版带词缀的特殊掉落，保存后变成普通物品' : '') + '</small>') + '</td>' +
              '<td><input data-dc="' + i + '" value="' + d.chance + '" inputmode="decimal"></td><td><input data-dmin="' + i + '" value="' + d.minCount + '" inputmode="numeric"></td><td><input data-dmax="' + i + '" value="' + d.maxCount + '" inputmode="numeric"></td>' +
              '<td><button class="ghost" data-ddel="' + i + '">删除</button></td></tr>';
          }).join('') + '</table>' +
          '<div class="row"><input id="dq" placeholder="物品名字或编号" style="flex:1;width:auto"><button class="ghost" id="dadd">加物品</button><button class="ghost" id="dgold">加金币档</button></div>' +
          '<div class="row"><button id="dsave">保存掉落</button><button class="danger" id="dreset"' + (v.custom ? '' : ' disabled') + '>恢复默认掉落</button><span id="dmsg"></span></div>';
        if (msg) say('dmsg', msg);
        function sync() {
          Array.prototype.forEach.call(sec.querySelectorAll('[data-dc]'), function (el) { list[+el.getAttribute('data-dc')].chance = Number(el.value); });
          Array.prototype.forEach.call(sec.querySelectorAll('[data-dmin]'), function (el) { list[+el.getAttribute('data-dmin')].minCount = Number(el.value); });
          Array.prototype.forEach.call(sec.querySelectorAll('[data-dmax]'), function (el) { list[+el.getAttribute('data-dmax')].maxCount = Number(el.value); });
        }
        sec.onclick = function (e) { var b = e.target.closest('[data-ddel]'); if (!b) return; sync(); list.splice(+b.getAttribute('data-ddel'), 1); draw(); };
        $('dgold').onclick = function () { sync(); list.push({ type: 'gold', itemId: 0, name: '金币', chance: 5, minCount: 10, maxCount: 20 }); draw(); };
        $('dadd').onclick = function () {
          sync();
          var q = $('dq').value.trim(); if (!q) return;
          (allItems ? Promise.resolve() : api('items').then(function (r) { allItems = r.items; })).then(function () {
            var hit = allItems.filter(function (t) { return String(t.itemId) === q || t.name === q; })[0] || allItems.filter(function (t) { return t.name.indexOf(q) >= 0; })[0];
            if (!hit) return say('dmsg', '没有找到 ' + q, false);
            list.push({ type: 'item', itemId: hit.itemId, name: hit.name, chance: 1, minCount: 1, maxCount: 1 }); draw();
          });
        };
        $('dsave').onclick = function () { sync(); api('monster-drops/' + encodeURIComponent(id), { drops: list }).then(function (r) { v = r.view; list = (v.custom || v.defaults).map(function (d) { return Object.assign({}, d); }); draw(r.done.join('')); }).catch(function (e) { say('dmsg', e.message, false); }); };
        $('dreset').onclick = function () { api('monster-drops/' + encodeURIComponent(id), { reset: true }).then(function (r) { v = r.view; list = v.defaults.map(function (d) { return Object.assign({}, d); }); draw(r.done.join('')); }).catch(function (e) { say('dmsg', e.message, false); }); };
      }
      draw();
    }).catch(function (e) { sec.innerHTML = '<div class="items">' + esc(e.message) + '</div>'; });
  }


  // ================= 婚礼与团队 =================
  var social = null;
  function loadSocial(root) {
    return api('social').then(function (v) { social = v; renderSocial(root); }).catch(function (e) { root.innerHTML = '<section class="panel">' + esc(e.message) + '</section>'; });
  }
  var ST = { engaged: '待举行', married: '已婚', pending: '待审批', active: '正常', arrears: '欠费宽限中', suspended: '停权' };
  function renderSocial(root) {
    var v = social, tv = v.teams;
    var bOpts = function (sel) { return tv.buildings.map(function (b) { return '<option value="' + b.id + '"' + (b.id === sel ? ' selected' : '') + '>' + esc(b.name) + '</option>'; }).join(''); };
    var dOpts = function (sel) { return tv.doors.map(function (d) { return '<option' + (d === sel ? ' selected' : '') + '>' + esc(d) + '</option>'; }).join(''); };
    root.innerHTML =
      '<section class="panel"><h3 style="margin:0 0 8px">婚礼</h3><div class="items" style="margin-bottom:8px">价格、离婚后等待天数、婚礼时段在「服务器设置 → 婚礼」。解除不收服务点、也不算再婚等待。</div>' +
      '<div class="list"><table class="f"><tr><th>新郎</th><th>新娘</th><th>状态</th><th>婚期 / 结婚时间</th><th>爱的宣言</th><th></th></tr>' +
      (v.couples.map(function (c) {
        return '<tr><td>' + esc(c.man) + '</td><td>' + esc(c.woman) + '</td><td>' + (ST[c.status] || c.status) + '</td><td>' + esc(c.status === 'married' ? c.marriedText : c.weddingText) + '</td><td>' + esc(c.vow) + '</td><td>' +
          (c.status === 'engaged' ? '<button class="ghost" data-cnow="' + c.id + '">婚期改为现在</button> ' : '') + '<button class="ghost" data-cdel="' + c.id + '">解除</button></td></tr>';
      }).join('') || '<tr><td colspan="6">还没有人登记。</td></tr>') + '</table></div><div id="cmsg"></div></section>' +
      '<section class="panel"><h3 style="margin:0 0 8px">长期团队</h3><div class="items" style="margin-bottom:8px">申请条件、月租、欠费宽限和「自动批准」在「服务器设置 → 长期团队」。批准时选团队楼和门；拒绝会把申请费退给申请人。</div>' +
      '<div class="list"><table class="f"><tr><th>团队</th><th>队长</th><th>状态</th><th>人数</th><th>团队点数 / 金库</th><th>位置</th><th>操作</th></tr>' +
      (tv.teams.map(function (t) {
        var place = '<select data-tb="' + t.id + '" style="width:auto">' + bOpts(t.building) + '</select><select data-td="' + t.id + '" style="width:auto">' + dOpts(t.door) + '</select>';
        var acts = t.status === 'pending'
          ? '<button data-tok="' + t.id + '">批准</button> <button class="ghost" data-tno="' + t.id + '">拒绝并退款</button>'
          : '<button class="ghost" data-tmv="' + t.id + '">搬到所选位置</button> <button class="ghost" data-tpts="' + t.id + '">改团队点数</button> ' +
            '<select data-tlead="' + t.id + '" style="width:auto"><option value="">换队长…</option>' + t.roster.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + '（' + esc(m.roleName) + '）</option>'; }).join('') + '</select> <button class="danger" data-tdel="' + t.id + '">解散</button>';
        return '<tr><td>' + (t.logo ? '<img src="' + esc(t.logo) + '" style="width:16px;height:16px;image-rendering:pixelated"> ' : '') + esc(t.name) + '<div class="items">' + esc(t.purpose || '') + '</div><div class="items">申请于 ' + esc(t.createdText) + '</div></td><td>' + esc(t.leaderName) + '</td><td>' + (ST[t.status] || t.status) +
          (t.paidText ? '<div class="items">月租到 ' + esc(t.paidText) + '</div>' : '') + '</td><td>' + t.members + '/' + t.cap + '<div class="items">' + t.level + ' 级 · 贡献 ' + t.contribution + '</div></td><td>' + t.points + ' / ' + t.coffer + '</td><td>' + place + '</td><td>' + acts + '</td></tr>';
      }).join('') || '<tr><td colspan="7">还没有团队申请。</td></tr>') + '</table></div><div id="tmsg"></div></section>';
    var done = function (id) { return function (r) { if (r.couples) social.couples = r.couples; if (r.teams) social.teams = r.teams; renderSocial(root); say(id, r.done.join('')); }; };
    var fail = function (id) { return function (e) { say(id, e.message, false); }; };
    root.onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var a = function (k) { return b.getAttribute(k); };
      var place = function (id) { return { building: root.querySelector('[data-tb="' + id + '"]').value, door: root.querySelector('[data-td="' + id + '"]').value }; };
      if (a('data-cdel')) { if (confirm('确定解除吗？')) api('couple/' + a('data-cdel'), { op: 'remove' }).then(done('cmsg')).catch(fail('cmsg')); }
      else if (a('data-cnow')) api('couple/' + a('data-cnow'), { op: 'now' }).then(done('cmsg')).catch(fail('cmsg'));
      else if (a('data-tok')) api('team/' + a('data-tok'), Object.assign({ op: 'approve' }, place(a('data-tok')))).then(done('tmsg')).catch(fail('tmsg'));
      else if (a('data-tno')) { var why = prompt('拒绝理由（会告诉申请人，可不填）', ''); if (why !== null) api('team/' + a('data-tno'), { op: 'reject', reason: why }).then(done('tmsg')).catch(fail('tmsg')); }
      else if (a('data-tmv')) api('team/' + a('data-tmv'), Object.assign({ op: 'move' }, place(a('data-tmv')))).then(done('tmsg')).catch(fail('tmsg'));
      else if (a('data-tpts')) { var n = prompt('团队点数改为', ''); if (n !== null) api('team/' + a('data-tpts'), { op: 'points', points: Number(n) }).then(done('tmsg')).catch(fail('tmsg')); }
      else if (a('data-tdel')) { if (confirm('确定解散这个团队吗？金库和点数一起清掉。')) api('team/' + a('data-tdel'), { op: 'disband' }).then(done('tmsg')).catch(fail('tmsg')); }
    };
    root.onchange = function (e) {
      var s = e.target.closest('[data-tlead]'); if (!s || !s.value) return;
      api('team/' + s.getAttribute('data-tlead'), { op: 'leader', memberId: s.value }).then(done('tmsg')).catch(fail('tmsg'));
    };
  }


  // ================= 新职业与上传（第十三批：上传造型、新职业、新技能、新怪物） =================
  var pview = null, pedit = null, sview = null, sedit = null;
  var UKINDS = { monster: '怪物造型', player: '职业造型', projectile: '弹道', map: '地图包' };
  var ACT_NAMES = { stand: '站立', walk: '行走', run: '跑', fight: '攻击', dead: '死亡', down: '倒地', lie: '躺', kiss: '亲吻', fight2: '攻击2', fight_bow: '拉弓', fight_near: '近身', fight_ball: '扔球', fight_bop: '敲打' };
  function loadNew(root) {
    if (!root.firstChild) {
      root.innerHTML =
        '<section class="panel"><h3 style="margin:0 0 8px">上传造型</h3><div class="items" style="margin-bottom:8px">' +
        '<b>怪物造型</b>：把原版 ALE 打成 zip，文件名就是动作名：stand、walk、fight、dead（可再加 fight2、run、down）。<br>' +
        '<b>职业造型</b>：zip 里分 man/ 和 women/ 两个文件夹（没有文件夹就男女共用一套），动作 stand、walk、run、fight、dead、down、lie、kiss（可再加 fight_bow、fight_near 等）。<br>' +
        '<b>弹道</b>：一个 .ale 文件。<br>缺的动作用 stand（再没有用 walk）顶上，列表里标黄。造型名只用英文字母、数字、下划线，服务器会在前面加 u_。地图包仍然只保存和检查，不转换。<br>预览图用的是文件自带的调色板；游戏里怪物按自己的「配色」、角色按选的颜色染色，颜色可能和预览不同。</div>' +
        '<div class="row"><select id="ukind" style="width:auto"><option value="monster">怪物造型</option><option value="player">职业造型</option><option value="projectile">弹道</option><option value="map">地图包</option></select>' +
        '<input id="umodel" placeholder="造型名（英文，如 bigcat）" style="width:190px"><input id="ulabel" placeholder="显示名（可不填）" style="width:130px"><input type="file" id="ufile"><button id="ugo">上传</button></div><div id="umsg"></div><div id="ulist"></div></section>' +
        '<section class="panel"><h3 style="margin:0 0 8px">新职业</h3><div class="items" style="margin-bottom:8px">新职业借一个原有职业做基础（攻击方式跟它一样），可以用上传的职业造型、自己的名字、能穿的装备标签和自己的一套公式；它自己的技能在下面「新技能」里做（技能属于这个新职业）。玩家在<b>战斗行会的转职神父</b>那里转职，跟原版职业一样要战斗等级够（默认 10 级）。也可以在「设给角色」直接设。</div>' +
        '<div class="split"><div><div class="row" style="margin:0 0 8px"><button id="pnew">新建职业</button></div><div id="plist" class="list"></div></div><div id="pedit"><div class="empty">在左边选一个职业，或新建</div></div></div><div id="pmsg"></div></section>' +
        '<section class="panel"><h3 style="margin:0 0 8px">设给角色</h3><div class="row"><input id="pchar" placeholder="角色名" style="width:200px"><select id="ppick" style="width:auto"></select><button id="passign">设为该职业</button><button class="ghost" id="pclear">恢复原职业</button></div><div id="pamsg"></div></section>' +
        '<section class="panel"><h3 style="margin:0 0 8px">新技能</h3><div class="items" style="margin-bottom:8px">伤血、伤甲照原版 Skill.tab 的写法：可用 attack（攻击）、breakPower（破坏）、slevel（技能等级）、LV（战斗等级），百分号照写，例如原版劲射技 <code>attack+attack*(10+slevel)%</code>。伤血是打掉的血，伤甲用来破对方防御；有元素的技能全部算该元素，被对应抗性减，不再看防御。技能书会在杂货店卖，也可以选「到级自动学会」。只给怪物用的技能，到「怪物」页给怪物选上。</div>' +
        '<div class="split"><div><div class="row" style="margin:0 0 8px"><button id="snew">新建技能</button></div><div id="slist" class="list"></div></div><div id="sedit"><div class="empty">在左边选一个技能，或新建</div></div></div><div id="smsg"></div></section>' +
        '<section class="panel"><h3 style="margin:0 0 8px">新怪物</h3><div class="items" style="margin-bottom:8px">复制一个现有怪物（数值、攻击方式、掉落都照它），起新名字、选造型（可选上传的怪物造型）。建好后到「怪物」页改数值、四抗、元素攻击、攻击距离、弹道、技能和掉落，到「地图怪物」页放到地图上。</div>' +
        '<div class="row"><select id="mfrom" style="width:auto"></select><input id="mname" placeholder="新怪物名" style="width:160px"><select id="mmodel" style="width:auto"></select><button id="mnew">新建怪物</button></div><table class="f" id="mcustom"></table><div id="mmsg"></div></section>';
      $('pnew').onclick = function () { pedit = { id: null, name: '', base: 'warrior', desc: '', tags: '', formulas: null, model: '', jobLevel: 10, open: true }; drawProf(); };
      $('passign').onclick = function () { api('profession/' + $('ppick').value + '/assign', { name: $('pchar').value }).then(function (r) { pview = r.view; renderProfs(); say('pamsg', r.done.join('')); }).catch(function (e) { say('pamsg', e.message, false); }); };
      $('pclear').onclick = function () { api('profession/x/assign', { name: $('pchar').value, clear: true }).then(function (r) { pview = r.view; renderProfs(); say('pamsg', r.done.join('')); }).catch(function (e) { say('pamsg', e.message, false); }); };
      $('mnew').onclick = function () { api('custom-monster/new', { from: $('mfrom').value, name: $('mname').value, model: $('mmodel').value }).then(function (r) { mview.custom = r.custom; renderMons(); say('mmsg', r.done.join('')); }).catch(function (e) { say('mmsg', e.message, false); }); };
      $('mfrom').onchange = function () { var m = mview.monsters.filter(function (x) { return x.monsterId === $('mfrom').value; })[0]; if (m) $('mmodel').value = m.model; };
      $('snew').onclick = function () { sedit = { id: null, name: '', owner: 'warrior', kind: 'point', element: '', projectileKey: 'none', projectileSpeed: 900, range: 400, radius: 60, count: 3, spreadDeg: 60, cooldownMs: 1000, hpFormula: 'attack+attack*(10+slevel)%', armorFormula: 'breakPower', mpFormula: '10+slevel', learn: 'book', level: 10, price: 5000, iconPath: sview.icons[0], description: '' }; drawSkill(); };
      $('ukind').onchange = function () { $('umodel').disabled = $('ulabel').disabled = $('ukind').value === 'map'; };
      $('ugo').onclick = function () {
        var f = $('ufile').files[0]; if (!f) return say('umsg', '请先选文件', false);
        var kind = $('ukind').value;
        if (kind !== 'map' && !$('umodel').value.trim()) return say('umsg', '请填造型名（英文）', false);
        say('umsg', '上传中…');
        fetch('/api/upload/' + kind + '?name=' + encodeURIComponent(f.name) + '&model=' + encodeURIComponent($('umodel').value) + '&label=' + encodeURIComponent($('ulabel').value), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); })
          .then(function (r) { uview = r.uploads; renderUploads(); say('umsg', r.done.join('')); return refreshChoices(); }).catch(function (e) { say('umsg', e.message, false); });
      };
    }
    return Promise.all([api('professions'), api('custom-monsters'), api('uploads'), api('custom-skills')]).then(function (r) { pview = r[0]; mview = r[1]; uview = r[2].uploads; sview = r[3]; renderProfs(); renderMons(); renderUploads(); renderSkills(); });
  }
  // After an upload or delete the model / projectile lists change.
  function refreshChoices() {
    return Promise.all([api('professions'), api('custom-monsters'), api('custom-skills')]).then(function (r) { pview = r[0]; mview = r[1]; sview = r[2]; renderProfs(); renderMons(); renderSkills(); });
  }
  var mview = null, uview = [];
  function renderProfs() {
    $('plist').innerHTML = pview.list.map(function (c) { return '<div class="it" data-p="' + c.id + '"><span class="n">' + esc(c.name) + ' <small class="items">基础：' + esc(c.baseName) + (c.model ? ' · 造型 ' + esc(c.model) : '') + ' · ' + c.characters.length + ' 个角色</small></span></div>'; }).join('') || '<div class="items">还没有新职业。</div>';
    $('plist').onclick = function (e) { var d = e.target.closest('[data-p]'); if (!d) return; var c = pview.list.filter(function (x) { return x.id === d.getAttribute('data-p'); })[0]; pedit = JSON.parse(JSON.stringify(c)); pedit.tags = (c.tags || []).join('、'); drawProf(); };
    $('ppick').innerHTML = pview.list.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '（基础：' + esc(c.baseName) + '）</option>'; }).join('');
  }
  function drawProf() {
    var c = pedit, v = pview;
    var base = c.base || 'warrior';
    var group = v.original[{ warrior: 'warrior', archer: 'archer', gunner: 'gunner', mage: 'mage' }[base] || 'other'];
    var f = c.formulas;
    $('pedit').innerHTML = '<div class="row" style="margin:0 0 8px"><label style="flex:1">职业名（1–8 字）<input id="pn" value="' + esc(c.name) + '"></label><label style="flex:1">基础职业（攻击方式）<select id="pb">' + v.bases.map(function (b) { return '<option value="' + b.id + '"' + (b.id === base ? ' selected' : '') + '>' + esc(b.name) + '</option>'; }).join('') + '</select></label></div>' +
      '<div class="row" style="margin:0 0 8px"><label style="flex:1">造型<select id="pm"><option value="">用基础职业的造型</option>' + (v.models || []).map(function (m) { return '<option' + (m === c.model ? ' selected' : '') + '>' + esc(m) + '</option>'; }).join('') + '</select></label>' +
      '<label style="flex:1">转职要求战斗等级<input id="pj" type="number" min="1" max="1200" value="' + (c.jobLevel || 10) + '"></label>' +
      '<label style="flex:1;display:flex;gap:6px;align-items:center"><input type="checkbox" id="po" style="width:auto"' + (c.open !== false ? ' checked' : '') + '> 转职神父那里可以转</label></div>' +
      '<label>说明（转职时给玩家看）<input id="pd" value="' + esc(c.desc || '') + '"></label>' +
      '<label>能穿的装备标签（顿号或逗号分隔；空 = 和基础职业一样）<input id="pt" value="' + esc(c.tags || '') + '"></label>' +
      '<label style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="pf" style="width:auto"' + (f ? ' checked' : '') + '> 用自己的公式（不勾 = 用「公式」页里基础职业的那一行）</label>' +
      '<table class="f" id="pft"' + (f ? '' : ' hidden') + '>' + v.keys.map(function (k) { return '<tr><td style="white-space:nowrap">' + esc(v.keyNames[k]) + '</td><td><textarea rows="2" data-pk="' + k + '" style="width:100%;font:12px monospace">' + esc(f ? f[k] : group[k]) + '</textarea></td></tr>'; }).join('') + '</table>' +
      (c.characters && c.characters.length ? '<div class="items" style="margin-top:6px">使用中的角色：' + c.characters.map(function (x) { return esc(x.name); }).join('、') + '</div>' : '') +
      '<div class="row"><button id="psave">保存</button>' + (c.id ? '<button class="danger" id="pdel">删除</button>' : '') + '</div>';
    $('pf').onchange = function () { $('pft').hidden = !$('pf').checked; };
    $('psave').onclick = function () {
      var body = { name: $('pn').value, base: $('pb').value, desc: $('pd').value, tags: $('pt').value.split(/[、,，\s]+/).filter(Boolean), model: $('pm').value, jobLevel: Number($('pj').value), open: $('po').checked };
      if ($('pf').checked) { body.formulas = {}; Array.prototype.forEach.call(document.querySelectorAll('[data-pk]'), function (t) { body.formulas[t.getAttribute('data-pk')] = t.value; }); }
      api('profession/' + (c.id || 'new'), body).then(function (r) { pview = r.view; renderProfs(); var n = pview.list.filter(function (x) { return x.name === body.name; })[0]; if (n) { pedit = JSON.parse(JSON.stringify(n)); pedit.tags = n.tags.join('、'); drawProf(); } say('pmsg', r.done.join('')); return api('custom-skills').then(function (s) { sview = s; renderSkills(); }); }).catch(function (e) { say('pmsg', e.message, false); });
    };
    if (c.id) $('pdel').onclick = function () { if (!confirm('删除这个职业？用它的角色恢复成基础职业。')) return; api('profession/' + c.id + '/delete', {}).then(function (r) { pview = r.view; renderProfs(); $('pedit').innerHTML = '<div class="empty">已删除</div>'; say('pmsg', r.done.join('')); }).catch(function (e) { say('pmsg', e.message, false); }); };
  }
  function opt(list, cur) { return list.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join(''); }
  function renderSkills() {
    $('slist').innerHTML = sview.list.map(function (s) { return '<div class="it" data-s="' + s.id + '"><span class="n">' + esc(s.name) + ' <small class="items">' + esc(s.ownerName) + ' · ' + esc(s.id) + (s.bookId && s.learn === 'book' ? ' · 书 ' + s.bookId : '') + '</small></span></div>'; }).join('') || '<div class="items">还没有新技能。</div>';
    $('slist').onclick = function (e) { var d = e.target.closest('[data-s]'); if (!d) return; sedit = JSON.parse(JSON.stringify(sview.list.filter(function (x) { return x.id === d.getAttribute('data-s'); })[0])); drawSkill(); };
  }
  function drawSkill() {
    var s = sedit, v = sview;
    var iconOpts = v.icons.map(function (i) { return [i, i.replace(/^skills\//, '').replace(/\/spriteFrame$/, '')]; });
    if (s.iconPath && !v.icons.includes(s.iconPath)) iconOpts.unshift([s.iconPath, '上传的图标']);
    function num(id, label, val, extra) { return '<label style="flex:1">' + label + '<input id="' + id + '" type="number" value="' + esc(val) + '"' + (extra || '') + '></label>'; }
    $('sedit').innerHTML =
      '<div class="row" style="margin:0 0 8px"><label style="flex:1">技能名（1–8 字）<input id="sn" value="' + esc(s.name) + '"></label><label style="flex:1">属于<select id="so">' + opt(v.owners, s.owner) + '</select></label><label style="flex:1">出招方式<select id="sk">' + opt(v.kinds, s.kind) + '</select></label></div>' +
      '<div class="row" style="margin:0 0 8px"><label style="flex:1">元素<select id="se">' + opt(v.elements, s.element || '') + '</select></label><label style="flex:1">弹道<select id="sp">' + opt(v.projectiles, s.projectileKey) + '</select></label>' + num('sps', '弹道速度', s.projectileSpeed) + '</div>' +
      '<div class="row" style="margin:0 0 8px">' + num('sr', '射程（像素）', s.range) + num('sa', '作用范围/宽度', s.radius) + num('sc', '发数（扇形/连发）', s.count) + num('sd', '扇形角度', s.spreadDeg) + num('scd', '冷却（毫秒）', s.cooldownMs) + '</div>' +
      '<label>伤血公式<input id="shp" value="' + esc(s.hpFormula) + '" style="font:12px monospace"></label>' +
      '<label>伤甲公式<input id="sar" value="' + esc(s.armorFormula) + '" style="font:12px monospace"></label>' +
      '<label>耗精力公式<input id="smp" value="' + esc(s.mpFormula) + '" style="font:12px monospace"></label>' +
      '<div class="row" style="margin:8px 0"><label style="flex:1">怎么学会<select id="sl">' + opt([['book', '技能书'], ['level', '到级自动学会']], s.learn) + '</select></label>' + num('slv', '要求等级', s.level) + num('spr', '技能书价格（0 = 不卖）', s.price) + '</div>' +
      '<div class="row" style="margin:0 0 8px"><label style="flex:1">图标<select id="si">' + opt(iconOpts, s.iconPath) + '</select></label><label style="flex:1">或上传图标（自动缩成 32×32）<input type="file" id="sif" accept="image/*"></label></div>' +
      '<label>说明<input id="sdesc" value="' + esc(s.description || '') + '"></label>' +
      '<div class="row"><button class="ghost" id="stest">试算</button><button id="ssave">保存</button>' + (s.id ? '<button class="danger" id="sdel">删除</button>' : '') + '<span id="semsg"></span></div>';
    function read() {
      return { name: $('sn').value, owner: $('so').value, kind: $('sk').value, element: $('se').value, projectileKey: $('sp').value, projectileSpeed: Number($('sps').value),
        range: Number($('sr').value), radius: Number($('sa').value), count: Number($('sc').value), spreadDeg: Number($('sd').value), cooldownMs: Number($('scd').value),
        hpFormula: $('shp').value, armorFormula: $('sar').value, mpFormula: $('smp').value, learn: $('sl').value, level: Number($('slv').value), price: Number($('spr').value),
        iconPath: $('si').value, description: $('sdesc').value };
    }
    function icon() {
      var f = $('sif').files[0]; if (!f) return Promise.resolve(null);
      return new Promise(function (res, rej) {
        var img = new Image(); img.onload = function () { var c = document.createElement('canvas'); c.width = 32; c.height = 32; c.getContext('2d').drawImage(img, 0, 0, 32, 32); res(c.toDataURL('image/png')); }; img.onerror = function () { rej(new Error('图片读不出来')); };
        img.src = URL.createObjectURL(f);
      });
    }
    $('stest').onclick = function () { api('custom-skill/test', read()).then(function (r) { say('semsg', r.done.join('')); }).catch(function (e) { say('semsg', e.message, false); }); };
    $('ssave').onclick = function () {
      var body = read();
      icon().then(function (png) { if (png) body.icon = png; return api('custom-skill/' + (s.id || 'new'), body); })
        .then(function (r) { sview = r.view; renderSkills(); var n = sview.list.filter(function (x) { return x.name === body.name; })[0]; if (n) { sedit = JSON.parse(JSON.stringify(n)); drawSkill(); } say('smsg', r.done.join('')); }).catch(function (e) { say('semsg', e.message, false); });
    };
    if (s.id) $('sdel').onclick = function () { if (!confirm('删除这个技能？学会的角色会失去它，技能书也会下架。')) return; api('custom-skill/' + s.id + '/delete', {}).then(function (r) { sview = r.view; renderSkills(); $('sedit').innerHTML = '<div class="empty">已删除</div>'; say('smsg', r.done.join('')); }).catch(function (e) { say('semsg', e.message, false); }); };
  }
  function renderMons() {
    $('mfrom').innerHTML = mview.monsters.map(function (m) { return '<option value="' + esc(m.monsterId) + '">' + esc(m.name) + '（' + m.level + ' 级 · ' + esc(m.model) + '）</option>'; }).join('');
    $('mmodel').innerHTML = mview.models.map(function (m) { return '<option>' + esc(m) + '</option>'; }).join('');
    $('mfrom').onchange();
    $('mcustom').innerHTML = mview.custom.length ? '<tr><th>编号</th><th>名字</th><th>造型</th><th>底子</th><th></th></tr>' + mview.custom.map(function (m) { return '<tr><td>' + esc(m.monsterId) + '</td><td>' + esc(m.name) + '</td><td>' + esc(m.model) + '</td><td>' + esc(m.fromName) + '</td><td><button class="danger" data-md="' + esc(m.monsterId) + '">删除</button></td></tr>'; }).join('') : '';
    $('mcustom').onclick = function (e) { var b = e.target.closest('[data-md]'); if (!b || !confirm('删除这个怪物？地图上的也会去掉。')) return; api('custom-monster/' + b.getAttribute('data-md') + '/delete', {}).then(function (r) { mview.custom = r.custom; renderMons(); say('mmsg', r.done.join('')); }).catch(function (e2) { say('mmsg', e2.message, false); }); };
  }
  function actionCells(kind, model, gender, rep) {
    var acts = Object.keys(rep.actions || {});
    return acts.map(function (a) {
      var info = rep.actions[a];
      var img = info.type === 'AEX' ? '<div class="items">AEX</div>' : '<img style="max-width:90px;max-height:90px;background:#2a3140" src="/api/upload-preview/' + encodeURIComponent(model) + '?kind=' + kind + '&action=' + a + (gender ? '&gender=' + gender : '') + '">';
      return '<div style="display:inline-block;text-align:center;margin:0 6px 6px 0;vertical-align:top">' + img + '<div class="items">' + esc(ACT_NAMES[a] || a) + (info.frames ? ' · ' + info.frames + ' 帧' : '') + '</div></div>';
    }).join('') + (rep.missing && rep.missing.length ? '<div style="color:#c90">缺（用站立/行走顶上）：' + esc(rep.missing.map(function (a) { return ACT_NAMES[a] || a; }).join('、')) + '</div>' : '');
  }
  function renderUploads() {
    $('ulist').innerHTML = uview.length ? uview.map(function (u) {
      var head = '<b>' + esc(u.kindName) + '</b> ' + esc(u.model || u.name) + (u.model && u.name !== u.model ? '（' + esc(u.name) + '）' : '') + ' <small class="items">' + new Date(u.at).toLocaleString('zh-CN', { hour12: false }) + ' · ' + Math.ceil((u.bytes || 0) / 1024) + ' KB</small> ' +
        '<button class="danger" data-ud="' + esc(u.model || u.id) + '" data-uk="' + u.kind + '">删除</button>';
      var body = '';
      if (u.kind === 'monster' && u.actions) body = actionCells('monster', u.model, null, u);
      else if (u.kind === 'player' && u.genders) body = ['man', 'women'].map(function (g) { return '<div><b>' + (g === 'man' ? '男' : '女') + '</b><br>' + actionCells('player', u.model, g, u.genders[g]) + '</div>'; }).join('');
      else if (u.kind === 'projectile') body = u.file && u.file.type !== 'AEX' ? '<img style="max-width:90px;background:#2a3140" src="/api/upload-preview/' + encodeURIComponent(u.model) + '?kind=projectile"> <span class="items">' + (u.file.frames || 0) + ' 帧</span>' : '<span class="items">AEX</span>';
      else if (u.report) body = u.report.files + ' 个文件' + (u.report.found.length ? '<div style="color:var(--ok)">有：' + esc(u.report.found.join('、')) + '</div>' : '') + (u.report.missing.length ? '<div style="color:var(--bad)">缺：' + esc(u.report.missing.join('、')) + '</div>' : '') + (u.kind === 'monster' ? '<div class="items">（V12 上传的，没有转换；请用新的「怪物造型」重新上传）</div>' : '');
      return '<div class="section" style="margin-top:8px">' + head + '<div style="margin-top:6px">' + body + '</div></div>';
    }).join('') : '<div class="items">还没有上传。</div>';
    $('ulist').onclick = function (e) { var b = e.target.closest('[data-ud]'); if (!b || !confirm('删除这个上传？')) return; api('upload/' + b.getAttribute('data-uk') + '/delete?item=' + encodeURIComponent(b.getAttribute('data-ud')), {}).then(function (r) { uview = r.uploads; renderUploads(); say('umsg', r.done.join('')); return refreshChoices(); }).catch(function (e2) { say('umsg', e2.message, false); }); };
  }

  window.__qiyuV12 = { api: api, esc: esc, say: say, monsterDetail: monsterDetail, loadSocial: loadSocial, loadNew: loadNew };
})();
