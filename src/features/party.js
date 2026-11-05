'use strict';
// Parties (组队). The party HUD patch (61_party_hud_avatar) drives everything
// through chat commands (/team invite|accept|decline|leave NAME) and listens
// for CHAT_MESSAGE packets carrying `partyState` / `partyInvite`.
const C = require('../game/character');

const MAX_MEMBERS = 5;
const INVITE_TTL_MS = 60 * 1000;
const OFFLINE_KEEP_MS = 10 * 60 * 1000;   // offline members drop out after this
const STATE_REFRESH_MS = 1000;            // hp/mp digest check
const SHARE_RADIUS_PX = 1600;             // exp sharing range

class Party {
  register(server) {
    this.server = server;
    this.parties = new Map();     // partyId -> {id, leaderId, memberIds[], offlineSince{}}
    this.memberParty = new Map(); // characterId -> partyId
    this.invites = new Map();     // targetId -> Map(inviterId -> expiresAt)
    this.nextId = 1;
    this.refreshAcc = 0;
    const chat = server.features.chat;
    chat.commands.set('team', (p, args) => this.command(p, args));
    chat.commands.set('party', (p, args) => this.command(p, args));
    server.events.on('playerEntered', (p) => this.onEntered(p));
    server.events.on('playerLeaving', (p) => this.onLeaving(p));
    server.events.on('tick', (now, dt) => this.tick(now, dt));
  }

  // --- queries used by chat / combat / items ---
  partyOf(id) { const pid = this.memberParty.get(id); return pid ? this.parties.get(pid) : null; }

  sameParty(a, b) { const pa = this.memberParty.get(a); return !!pa && pa === this.memberParty.get(b); }

  membersOf(p) {
    const party = this.partyOf(p.id);
    if (!party) return [];
    return party.memberIds.map((id) => this.server.playersById.get(id)).filter(Boolean);
  }

  nearbyMembers(p, scene) {
    const out = this.membersOf(p).filter((q) => q === p || (q.scene === scene && q.alive && Math.hypot(q.x - p.x, q.y - p.y) <= SHARE_RADIUS_PX));
    return out.length ? out : [p];
  }

  // --- commands ---
  command(p, args) {
    const sub = String(args[0] || '').toLowerCase();
    const name = args.slice(1).join(' ').trim();
    switch (sub) {
      case 'invite': return this.invite(p, name);
      case 'accept': return this.accept(p, name);
      case 'decline': case 'reject': return this.decline(p, name);
      case 'leave': case 'quit': return this.leave(p);
      case 'kick': return this.kick(p, name);
      case 'lead': case 'leader': return this.promote(p, name);
      case '': case 'info': case 'state': this.sendState(p); return this.describe(p);
      default: return '组队指令：/team invite 名字、/team accept 名字、/team decline 名字、/team leave、/team kick 名字、/team lead 名字';
    }
  }

  describe(p) {
    const party = this.partyOf(p.id);
    if (!party) return '你还没有加入队伍。';
    return '队伍成员：' + party.memberIds.map((id) => this.nameOf(id) + (id === party.leaderId ? '(队长)' : '')).join('、');
  }

  invite(p, name) {
    if (!name) return '请输入要邀请的玩家名字。';
    const target = this.server.findPlayerByName(name, p.ch.world);
    if (!target) return '玩家 ' + name + ' 不在线。';
    if (target === p) return '不能邀请自己。';
    const party = this.partyOf(p.id);
    if (party && party.leaderId !== p.id) return '只有队长可以邀请队员。';
    if (party && party.memberIds.length >= MAX_MEMBERS) return '队伍已满（最多 ' + MAX_MEMBERS + ' 人）。';
    if (this.partyOf(target.id)) return target.name + ' 已经在队伍中了。';
    let map = this.invites.get(target.id);
    if (!map) { map = new Map(); this.invites.set(target.id, map); }
    map.set(p.id, Date.now() + INVITE_TTL_MS);
    this.push(target, { partyInvite: { inviterName: p.name, inviterPlayerId: p.id, expiresAt: Date.now() + INVITE_TTL_MS } }, 'party_invite');
    this.server.features.chat.tell(target, p.name + ' 邀请你加入队伍。');
    return '已向 ' + target.name + ' 发出组队邀请。';
  }

  takeInvite(p, name) {
    const map = this.invites.get(p.id);
    if (!map) return null;
    const now = Date.now();
    for (const [id, exp] of map) {
      if (exp < now) { map.delete(id); continue; }
      if (!name || this.nameOf(id).toLowerCase() === name.toLowerCase()) { map.delete(id); return id; }
    }
    return null;
  }

  accept(p, name) {
    const inviterId = this.takeInvite(p, name);
    this.push(p, { partyInvite: null }, 'party_invite');
    if (!inviterId) return '邀请已过期。';
    if (this.partyOf(p.id)) return '你已经在队伍中了。';
    const inviter = this.server.playersById.get(inviterId);
    if (!inviter) return '对方已经下线。';
    let party = this.partyOf(inviterId);
    if (party && party.leaderId !== inviterId) return '对方已经不是队长了。';
    if (party && party.memberIds.length >= MAX_MEMBERS) return '队伍已满。';
    if (!party) {
      party = { id: 'party_' + (this.nextId++), leaderId: inviterId, memberIds: [inviterId], offlineSince: {}, createdAt: Date.now() };
      this.parties.set(party.id, party);
      this.memberParty.set(inviterId, party.id);
    }
    party.memberIds.push(p.id);
    this.memberParty.set(p.id, party.id);
    this.invites.delete(p.id);
    this.announce(party, p.name + ' 加入了队伍。');
    this.changed(party);
    return null;
  }

  decline(p, name) {
    const inviterId = this.takeInvite(p, name);
    this.push(p, { partyInvite: null }, 'party_invite');
    if (!inviterId) return null;
    const inviter = this.server.playersById.get(inviterId);
    if (inviter) this.server.features.chat.tell(inviter, p.name + ' 拒绝了你的组队邀请。');
    return '已拒绝 ' + this.nameOf(inviterId) + ' 的组队邀请。';
  }

  leave(p) {
    const party = this.partyOf(p.id);
    if (!party) return '你还没有加入队伍。';
    this.removeMember(party, p.id, p.name + ' 离开了队伍。');
    return '你已离开队伍。';
  }

  kick(p, name) {
    const party = this.partyOf(p.id);
    if (!party || party.leaderId !== p.id) return '只有队长可以请离队员。';
    const id = party.memberIds.find((m) => this.nameOf(m).toLowerCase() === String(name).toLowerCase());
    if (!id || id === p.id) return '队伍中没有这个队员。';
    const q = this.server.playersById.get(id);
    if (q) this.server.features.chat.tell(q, '你被请离了队伍。');
    this.removeMember(party, id, this.nameOf(id) + ' 被请离了队伍。');
    return null;
  }

  promote(p, name) {
    const party = this.partyOf(p.id);
    if (!party || party.leaderId !== p.id) return '只有队长可以移交队长。';
    const id = party.memberIds.find((m) => this.nameOf(m).toLowerCase() === String(name).toLowerCase());
    if (!id || id === p.id) return '队伍中没有这个队员。';
    party.leaderId = id;
    this.announce(party, this.nameOf(id) + ' 成为了队长。');
    this.changed(party);
    return null;
  }

  removeMember(party, id, message) {
    party.memberIds = party.memberIds.filter((m) => m !== id);
    delete party.offlineSince[id];
    this.memberParty.delete(id);
    const gone = this.server.playersById.get(id);
    if (gone) { gone.party = null; gone.paramsDirty = true; this.push(gone, { partyState: null }); }
    if (party.leaderId === id) {
      party.leaderId = party.memberIds.find((m) => this.server.playersById.has(m)) || party.memberIds[0] || null;
      if (party.leaderId && party.memberIds.length > 1) message += ' ' + this.nameOf(party.leaderId) + ' 成为了队长。';
    }
    if (party.memberIds.length <= 1) return this.disband(party, message + ' 队伍已解散。');
    this.announce(party, message);
    this.changed(party);
    return undefined;
  }

  disband(party, message) {
    for (const id of party.memberIds) {
      this.memberParty.delete(id);
      const q = this.server.playersById.get(id);
      if (!q) continue;
      q.party = null; q.paramsDirty = true;
      this.push(q, { partyState: null });
      if (message) this.server.features.chat.tell(q, message);
    }
    this.parties.delete(party.id);
  }

  // --- state packets ---
  nameOf(id) {
    const p = this.server.playersById.get(id);
    if (p) return p.name;
    const ch = this.server.store.data.characters[id];
    return ch ? ch.name : id;
  }

  memberView(party, id) {
    const q = this.server.playersById.get(id);
    const ch = q ? q.ch : this.server.store.data.characters[id];
    if (!ch) return null;
    const stats = q ? q.stats : null;
    return {
      playerId: id,
      playerName: ch.name,
      leader: id === party.leaderId,
      online: !!q,
      hp: Math.max(0, Math.round(ch.hp || 0)),
      maxHp: stats ? stats.maxHp : Math.round(ch.hp || 1),
      mp: Math.max(0, Math.round(ch.stamina || 0)),
      maxMp: stats ? stats.maxStamina : Math.round(ch.stamina || 1),
      professionLevel: q ? q.stats.professionLevel : C.professionLevel(ch),
      combatLevel: q ? q.stats.combatLevel : C.combatLevel(ch),
      professionName: C.PROFESSION_LABELS[ch.profession] || '',
      title: ch.title || C.autoTitle(ch, C.professionLevel(ch)),
      mapRef: q && q.scene ? q.scene.mapRef : '',
      appearance: C.appearanceWithAvatar(ch),
    };
  }

  stateFor(party) {
    return {
      partyId: party.id,
      name: this.nameOf(party.leaderId) + '的队伍',
      maxMembers: MAX_MEMBERS,
      leaderId: party.leaderId,
      members: party.memberIds.map((id) => this.memberView(party, id)).filter(Boolean),
    };
  }

  push(p, payload, channel = 'party_state') {
    p.send(this.server.op.CHAT_MESSAGE, this.server.systemChat('', Object.assign({ channel }, payload)));
  }

  sendState(p) {
    const party = this.partyOf(p.id);
    this.push(p, { partyState: party ? this.stateFor(party) : null });
  }

  changed(party) {
    const state = this.stateFor(party);
    party.digest = this.digest(state);
    const name = state.name;
    for (const id of party.memberIds) {
      const q = this.server.playersById.get(id);
      if (!q) continue;
      q.party = { id: party.id, name, leaderId: party.leaderId };
      q.paramsDirty = true;
      this.push(q, { partyState: state });
    }
  }

  // HP/MP numbers only: skip appearance (avatars can be large).
  digest(state) {
    return state.leaderId + '|' + state.members.map((m) => [m.playerId, m.online ? 1 : 0, m.hp, m.maxHp, m.mp, m.maxMp, m.professionLevel, m.mapRef].join(',')).join(';');
  }

  announce(party, text) {
    for (const q of party.memberIds.map((id) => this.server.playersById.get(id)).filter(Boolean)) {
      q.send(this.server.op.CHAT_MESSAGE, this.server.systemChat(text, { channel: 'team', from: '队伍' }));
    }
  }

  onEntered(p) {
    const party = this.partyOf(p.id);
    if (!party) return;
    delete party.offlineSince[p.id];
    this.announce(party, p.name + ' 上线了。');
    this.changed(party);
  }

  onLeaving(p) {
    this.invites.delete(p.id);
    const party = this.partyOf(p.id);
    if (!party) return;
    party.offlineSince[p.id] = Date.now();
    // Leaving runs before the player is removed from playersById.
    setImmediate(() => {
      if (!this.parties.has(party.id)) return;
      if (!party.memberIds.some((id) => this.server.playersById.has(id))) { this.disband(party); return; }
      if (party.leaderId === p.id && !this.server.playersById.has(p.id)) {
        party.leaderId = party.memberIds.find((id) => this.server.playersById.has(id));
        this.announce(party, p.name + ' 下线了，' + this.nameOf(party.leaderId) + ' 成为了队长。');
      } else this.announce(party, p.name + ' 下线了。');
      this.changed(party);
    });
  }

  tick(now, dt) {
    this.refreshAcc += dt;
    if (this.refreshAcc < STATE_REFRESH_MS) return;
    this.refreshAcc = 0;
    for (const party of Array.from(this.parties.values())) {
      for (const [id, since] of Object.entries(party.offlineSince)) {
        if (now - since > OFFLINE_KEEP_MS && !this.server.playersById.has(id)) this.removeMember(party, id, this.nameOf(id) + ' 长时间离线，已离开队伍。');
      }
      if (!this.parties.has(party.id)) continue;
      const state = this.stateFor(party);
      const d = this.digest(state);
      if (d !== party.digest) this.changed(party);
    }
  }
}

module.exports = { Party };
