'use strict';
// Admin-made professions (twelfth batch, Q25-Q26). A new profession borrows an existing
// one as its base: the model, the attack mode, the skills and the job-change rules come
// from the base, since the client only knows its own professions. On top of it the
// admin gives it a name, equipment tags (what it may wear) and, if wanted, its own
// formulas (used while a formula set other than 网页版 is active).
// A character gets it on the admin page (it must already be of the base profession);
// a job change to another profession drops it. The client shows the new name in place
// of the base profession's name for that player (patch 103).
const C = require('../game/character');
const F = require('../game/formulas');

// Thirteenth batch (Q10): a new profession can wear an uploaded model (新职业与上传 →
// 上传「职业造型」) and is taken at the 转职神父 in 战斗行会 like the original ones
// (combat level 10 by default). Its own skills are made under 新技能 with it as owner.
class Professions {
  register(server) {
    this.server = server;
    server.events.on('playerEntered', (p) => this.push(p));
    server.ext.on('custom_job_query', (p) => this.jobQuery(p));
    server.ext.on('custom_job', (p, d) => this.jobChange(p, String((d || {}).id || '')));
  }
  onStart() { this.apply(); }

  data() {
    const b = this.server.store.bucket('customProfessions');
    if (!b.list) b.list = {};
    if (!b.nextId) b.nextId = 1;
    return b;
  }
  customMap() { return this.data().list; }
  nameOf(id) { const c = this.data().list[id]; return c ? c.name : null; }
  apply() { C.setCustomProfessions(this.data().list); }

  push(p) {
    const c = C.customProfessionOf(p.ch);
    this.server.ext.send(p, 'custom_profession', c ? { base: c.base, label: c.name, model: c.model || null } : { base: null });
  }

  view() {
    const chars = Object.values(this.server.store.data.characters || {});
    return {
      bases: Object.keys(C.PROFESSION_LABELS).filter((k) => k !== 'none' && k !== 'child').map((k) => ({ id: k, name: C.PROFESSION_LABELS[k] })),
      models: this.server.features.uploads ? this.server.features.uploads.playerModels() : [],
      keys: F.KEYS, keyNames: F.KEY_NAMES, vars: F.VARS, original: F.ORIGINAL.groups,
      list: Object.values(this.data().list).map((c) => Object.assign({}, c, {
        baseName: C.PROFESSION_LABELS[c.base] || c.base,
        tags: C.professionTagsOf(c.id),
        characters: chars.filter((ch) => ch.customProfession === c.id).map((ch) => ({ id: ch.id, name: ch.name, profession: ch.profession })),
      })),
    };
  }

  clean(b, old) {
    const name = String(b.name == null ? (old && old.name) || '' : b.name).trim();
    if (!name || [...name].length > 8) throw new Error('职业名须为 1–8 个字');
    const base = String(b.base || (old && old.base) || '');
    if (!C.PROFESSION_LABELS[base] || base === 'none') throw new Error('请选一个基础职业');
    let formulas = null;
    if (b.formulas) {
      formulas = {};
      for (const k of F.KEYS) {
        const src = String(b.formulas[k] || '').trim();
        if (!src) throw new Error('公式「' + F.KEY_NAMES[k] + '」不能为空');
        try { const v = F.compile(src)(F.SAMPLE); if (!Number.isFinite(v)) throw new Error('样例角色算不出数'); } catch (e) { throw new Error(F.KEY_NAMES[k] + '：' + e.message); }
        formulas[k] = src;
      }
    }
    const model = String(b.model == null ? (old && old.model) || '' : b.model).trim();
    const up = this.server.features.uploads;
    if (model && !(up && up.playerModels().includes(model))) throw new Error('造型要选「上传」里的职业造型（或留空用基础职业的造型）');
    const jobLevel = b.jobLevel == null || b.jobLevel === '' ? (old && old.jobLevel) || 10 : Number(b.jobLevel);
    if (!Number.isInteger(jobLevel) || jobLevel < 1 || jobLevel > 1200) throw new Error('转职等级要在 1–1200 之间');
    const open = b.open == null ? (old ? old.open !== false : true) : !!b.open;
    return { name, base, desc: String(b.desc || '').trim().slice(0, 200), formulas, model, jobLevel, open };
  }

  save(id, b) {
    const d = this.data();
    let c = id ? d.list[id] : null;
    if (id && !c) throw new Error('没有这个职业');
    const v = this.clean(b, c);
    if (Object.values(d.list).some((x) => x.name === v.name && x.id !== id) || Object.values(C.PROFESSION_LABELS).includes(v.name)) throw new Error('已经有叫「' + v.name + '」的职业了');
    if (!c) { c = { id: 'cp' + d.nextId++ }; d.list[c.id] = c; }
    Object.assign(c, v);
    // Equipment tags live with the other professions' tags on the 物品 page.
    const ia = this.server.features.itemAdmin;
    const tags = Array.isArray(b.tags) ? b.tags.map((x) => String(x).trim()).filter(Boolean) : null;
    if (ia) {
      const pt = ia.data().professionTags;
      if (tags && tags.length) pt[c.id] = [...new Set(tags)].slice(0, 30);
      else if (!pt[c.id]) pt[c.id] = [c.base];
      ia.apply();
    }
    this.server.store.markDirty();
    this.apply();
    this.refresh(c.id);
    return (id ? '已保存 ' : '已新建职业 ') + c.name + '（基础：' + C.PROFESSION_LABELS[c.base] + '）';
  }

  remove(id) {
    const c = this.data().list[id];
    if (!c) throw new Error('没有这个职业');
    delete this.data().list[id];
    for (const ch of Object.values(this.server.store.data.characters || {})) if (ch.customProfession === id) { delete ch.customProfession; if (ch.appearance) ch.appearance.model = C.modelFor(ch.profession, ch.appearance.gender, ch.appearance.model); }
    for (const p of this.server.playersById.values()) if (p.ch.customProfession === id) { delete p.ch.customProfession; p.ch.appearance = Object.assign({}, p.ch.appearance, { model: C.modelFor(p.ch.profession, p.ch.appearance.gender, p.ch.appearance.model) }); p.recompute(true); p.paramsDirty = true; p.markDirty(); }
    const ia = this.server.features.itemAdmin;
    if (ia) { delete ia.data().professionTags[id]; ia.apply(); }
    this.server.store.markDirty();
    this.apply();
    for (const p of this.server.playersById.values()) this.push(p);
    return '已删除职业 ' + c.name + '，用这个职业的角色恢复成' + (C.PROFESSION_LABELS[c.base] || c.base);
  }

  // name: the character's nickname; id null clears it.
  assign(name, id) {
    const ch = Object.values(this.server.store.data.characters || {}).find((x) => x.name === String(name || '').trim());
    if (!ch) throw new Error('找不到角色 ' + name);
    const p = this.server.playersById.get(ch.id);
    const live = p ? p.ch : ch;
    if (!id) { delete live.customProfession; } else {
      const c = this.data().list[id];
      if (!c) throw new Error('没有这个职业');
      if (live.profession !== c.base) throw new Error(live.name + ' 现在是' + (C.PROFESSION_LABELS[live.profession] || live.profession) + '，要先转成' + C.PROFESSION_LABELS[c.base] + '才能设为' + c.name);
      live.customProfession = id;
    }
    if (live.appearance) live.appearance = Object.assign({}, live.appearance, { model: C.modelForCharacter(live) });
    this.server.store.markDirty();
    if (p) { p.recompute(true); p.paramsDirty = true; p.markDirty(); p.flushParams(); this.push(p); }
    return id ? live.name + ' 现在是' + this.data().list[id].name : live.name + ' 恢复成' + (C.PROFESSION_LABELS[live.profession] || live.profession);
  }

  // 转职神父 (job_fight): the new professions a player can take there.
  jobQuery(p) {
    const list = Object.values(this.data().list).filter((c) => c.open !== false).map((c) => ({
      id: c.id, name: c.name, desc: c.desc || '', baseName: C.PROFESSION_LABELS[c.base] || c.base, jobLevel: c.jobLevel || 10, current: p.ch.customProfession === c.id && p.ch.profession === c.base,
    }));
    this.server.ext.send(p, 'custom_jobs', { list, level: p.stats.combatLevel });
  }
  jobChange(p, id) {
    const c = this.data().list[id];
    const say = (text, ok) => this.server.ext.send(p, 'custom_jobs', { message: text, ok: !!ok });
    if (!c || c.open === false) return say('没有这个职业');
    if (!p.scene || p.scene.mapRef !== 'job_fight') return say('要在战斗行会的转职神父那里转职');
    if (p.ch.customProfession === id && p.ch.profession === c.base) return say('你已经是' + c.name + '了');
    const need = c.jobLevel || 10;
    if (p.stats.combatLevel < need) return say('战斗等级达到' + need + '级才能转为' + c.name);
    // Gear the new profession cannot wear goes to the bag: refuse when it would not fit.
    const cat = require('../game/catalog');
    const after = Object.assign({}, p.ch, { profession: c.base, customProfession: id });
    const unfit = cat.EQUIP_SLOTS.filter((s) => p.ch.equipment[s] && C.meetsRequirement(p.ch, p.ch.equipment[s]) && !C.meetsRequirement(after, p.ch.equipment[s])).length;
    if (unfit > p.inventory.filter((x) => !x).length) return say('转职后有 ' + unfit + ' 件装备不能再穿，背包放不下。请先空出背包格子再转职。');
    p.ch.profession = c.base;
    p.ch.customProfession = id;
    p.ch.professionExp = p.ch.professionExp || {};
    p.ch.professionExp[c.base] = p.ch.professionExp[c.base] || 0;
    p.ch.appearance = Object.assign({}, p.ch.appearance, { model: C.modelForCharacter(p.ch) });
    p.recompute(true); p.paramsDirty = true; p.markDirty();
    const items = this.server.features.items;
    if (items) items.returnUnfitGear(p);
    p.commitItems({});
    this.server.features.skills.grantBirthSkills(p);
    p.flushParams();
    this.push(p);
    this.server.store.markDirty();
    say('你转职成为' + c.name + '了！', true);
  }

  refresh(id) {
    for (const p of this.server.playersById.values()) {
      if (p.ch.customProfession !== id) continue;
      p.ch.appearance = Object.assign({}, p.ch.appearance, { model: C.modelForCharacter(p.ch) });
      p.recompute(true); p.paramsDirty = true; p.markDirty(); p.flushParams(); this.push(p);
    }
  }
}

module.exports = { Professions };
