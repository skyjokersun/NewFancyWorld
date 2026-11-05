'use strict';
// UI test: craftsman panels in the real client. Panels are opened through the
// same calls the decor click handlers make, and driven through the panels'
// own ops (the code paths their buttons use). Usage: node crafting.js [part...]
const { prepareAccount, openGame } = require('./session');
const parts = process.argv.slice(2);
const want = (n) => !parts.length || parts.includes(n);

(async () => {
  const acct = await prepareAccount({ profession: 'craftsman', level: 30 });
  const g = await openGame(acct);
  const ge = (fn, arg) => g.eval(fn, arg);
  await g.chat('/gold 200000');
  const notes = () => ge(() => (globalThis.gameEntry.chatController.messages || globalThis.gameEntry.chatController.lines || []).slice(-6).map((m) => m.text || m.message || JSON.stringify(m)).join(' | '));
  try {
    if (want('mine')) {
      await g.chat('/go mine_01'); await g.waitScene(); await g.wait(2500);
      const lode = await ge(() => { const s = globalThis.gameEntry.legacyMiningSystem.snapshot; const l = s && s.lodes.find((x) => x.active); return l && { id: l.id, x: l.x, y: l.y, n: s.lodes.filter((x) => x.active).length }; });
      console.log('lode', JSON.stringify(lode));
      await g.chat('/go mine_01 ' + lode.x + ' ' + (lode.y - 40)); await g.waitScene(); await g.wait(2500);
      await g.shot('40-mine-lode');
      for (let i = 0; i < 6; i += 1) {
        await ge((id) => globalThis.gameEntry.legacyMiningSystem.queueOrSend('prospect', id), lode.id);
        await g.wait(4500);
        const disc = await ge((id) => globalThis.gameEntry.legacyMiningSystem.findLode(id).discovered, lode.id);
        if (disc) break;
      }
      await ge((id) => globalThis.gameEntry.legacyMiningSystem.queueOrSend('build', id), lode.id);
      await g.wait(1500); await g.shot('41-mine-well');
      await ge((id) => globalThis.gameEntry.legacyMiningSystem.openDialog(id), lode.id); await g.wait(800);
      await g.shot('42-mine-dialog');
      for (let i = 0; i < 8; i += 1) {
        const st = await ge((id) => { const l = globalThis.gameEntry.legacyMiningSystem.findLode(id); return { pendingOre: l.pendingOre, jammed: l.jammed, digging: l.digging }; }, lode.id);
        const action = st.pendingOre ? 'save' : st.jammed ? 'reset' : 'dig';
        await ge(([id, a]) => globalThis.gameEntry.legacyMiningSystem.sendAction(a, id), [lode.id, action]);
        await g.wait(action === 'dig' ? 2000 : 1500);
        if (i === 0) await g.shot('43-mine-dig');
      }
      const status = await ge(() => { const m = globalThis.gameEntry.legacyMiningSystem; return m.statusLabel && m.statusLabel.string; });
      console.log('mine status:', status, '| notes:', await notes());
      await ge((id) => globalThis.gameEntry.legacyMiningSystem.sendAction('teardown', id), lode.id); await g.wait(1200);
      await ge(() => globalThis.gameEntry.ensureMiningInfoReady().then(() => globalThis.gameEntry.miningInfoStagePanel.open())); await g.wait(1500);
      await g.shot('44-mine-info');
      await ge(() => globalThis.gameEntry.miningInfoStagePanel.close());
    }
    if (want('smelt')) {
      await g.chat('/item 2689 5'); await g.chat('/go smelt'); await g.waitScene(); await g.wait(1500);
      const furnace = await ge(() => globalThis.gameEntry.gameMapController && null);
      void furnace;
      const fid = await g.eval(async () => {
        const r = await fetch('/data/maps/smelt.json').catch(() => null); void r; return null;
      });
      void fid;
      const id = require('../../src/game/map');
      const cfg = require('../../src/config');
      const doc = new id.MapRegistry(cfg.dataDir).rawDoc('smelt');
      const f = doc.decor.find((d) => d.tag === 'furnace');
      const furnaceId = Math.round(f.x) + ':' + Math.round(f.y);
      await ge((fid2) => globalThis.gameEntry.ensureOreSmeltingPanelReady().then(() => globalThis.gameEntry.oreSmeltingPanel.openAgreement(fid2)), furnaceId);
      await g.wait(1200); await g.shot('50-smelt-agreement');
      await ge(() => { const p = globalThis.gameEntry.oreSmeltingPanel; const fid3 = p.pendingFurnaceId; p.setDialogMode(null); p.ops.requestItemQuery(); p.ops.requestOpen(fid3); });
      await g.wait(1200);
      await ge(() => { const p = globalThis.gameEntry.oreSmeltingPanel; const i = p.itemState.inventory.slots.findIndex((it) => it && it.itemId === 2689); p.ops.requestSelect(p.state.sessionId, i); });
      await g.wait(800); await g.shot('51-smelt-selected');
      await ge(() => { const p = globalThis.gameEntry.oreSmeltingPanel; p.ops.requestHeat(p.state.sessionId); });
      for (let i = 0; i < 40; i += 1) {
        await g.wait(250);
        const t = await ge(() => { const p = globalThis.gameEntry.oreSmeltingPanel; return p.lastTemperature; });
        if (t >= 3700) break;
      }
      await ge(() => { const p = globalThis.gameEntry.oreSmeltingPanel; p.ops.requestFinish(p.state.sessionId); });
      await g.shot('52-smelt-liquid');
      await g.wait(1200); await g.shot('53-smelt-done');
      console.log('smelt notes:', await notes());
    }
    if (want('forge') || want('fusion') || want('repair')) {
      await g.chat('/item 2698 12'); await g.chat('/item 2707 2'); await g.chat('/item 2305 1'); await g.chat('/item 1665 1');
      await g.chat('/go smith'); await g.waitScene(); await g.wait(1500);
      await ge(() => globalThis.gameEntry.ensureSmithFusionPanelReady().then(() => globalThis.gameEntry.smithFusionPanel.openWorkshopChoice()));
      await g.wait(1200); await g.shot('60-smith-choice');
    }
    if (want('forge')) {
      await ge(() => { const f = globalThis.gameEntry.smithFusionPanel; f.setChoiceVisible(false); f.ops.openForge(); });
      await g.wait(2000); await g.shot('61-forge-open');
      await ge(() => { const p = globalThis.gameEntry.smithForgePanel; if (p.recipePopup) { p.recipePopup.active = true; p.prepareRecipePopup(); p.renderRecipePopup(); } });
      await g.wait(600); await g.shot('62-forge-recipes');
      const pick = await ge(() => {
        const p = globalThis.gameEntry.smithForgePanel; const r = p.state.recipes.find((x) => x.unlocked && x.materials.every((m) => [2698, 2707].includes(m.itemId)));
        p.selectRecipe(r); return r.name;
      });
      await g.wait(1000); await g.shot('63-forge-selected'); console.log('forge pick', pick);
      // Play: press/release the primary action following the band like a player would.
      await ge(() => {
        const p = globalThis.gameEntry.smithForgePanel;
        p.handleActionNodeDown();
        globalThis.__forgeBot = setInterval(() => {
          const s = p.state; if (!s || s.gameStartedAt == null || ['complete', 'failed'].includes(s.phase)) return;
          const e = p.getGameElapsedMs(); const stage = Math.min(3, Math.floor(Math.min(e, s.gameDurationMs - 1) / 5000)); const f = (e + 80 - stage * 5000) / 5000;
          const r = (t, x) => s.temperatureTargets[t] + s.temperatureDrifts[t] * Math.sin(x * [0.5, 0.75, 1.5, 0.5][t] * Math.PI * 2 + s.temperaturePhases[t]);
          let target = r(stage, f); if (stage === 0) { const x = Math.min(1, f / 0.7); target = 450 + (target - 450) * x * x * (3 - 2 * x); } else if (f < 0.5) { const x = f / 0.5; const pr = r(stage - 1, 1); target = pr + (target - pr) * x * x * (3 - 2 * x); }
          const hot = p.displayedTemperature < target;
          if (hot && !p.actionPressed) p.handleActionNodeDown(); else if (!hot && p.actionPressed) p.handleActionNodeUp();
        }, 40);
      });
      await g.wait(9000); await g.shot('64-forge-playing');
      await g.wait(12500);
      await ge(() => clearInterval(globalThis.__forgeBot));
      await g.wait(1000); await g.shot('65-forge-done');
      console.log('forge state', await ge(() => globalThis.gameEntry.smithForgePanel.state.phase), 'notes:', await notes());
      await ge(() => globalThis.gameEntry.smithForgePanel.closeFromUser());
    }
    if (want('fusion')) {
      await ge(() => globalThis.gameEntry.ensureSmithFusionPanelReady().then(() => { const f = globalThis.gameEntry.smithFusionPanel; f.openWorkshopChoice(); f.setChoiceVisible(false); f.ops.requestOpen(); }));
      await g.wait(1500);
      const sel = await ge(() => {
        const f = globalThis.gameEntry.smithFusionPanel; const slots = f.itemState.inventory.slots;
        const eq = slots.findIndex((it) => it && it.durability && it.durability.max > 1 && it.bonusAttrs && it.bonusAttrs.length && !(it.itemId >= 1665 && it.itemId <= 1698) && !(it.itemId >= 2305 && it.itemId <= 2336));
        const pre = slots.findIndex((it) => it && it.itemId === 2305); const at = slots.findIndex((it) => it && it.itemId === 1665);
        f.ops.requestSelect(f.smithState.sessionId, 'equipment', eq);
        setTimeout(() => f.ops.requestSelect(f.smithState.sessionId, 'prefix', pre), 300);
        setTimeout(() => f.ops.requestSelect(f.smithState.sessionId, 'attribute', at), 600);
        return [eq, pre, at, slots[eq] && slots[eq].name];
      });
      console.log('fusion select', JSON.stringify(sel));
      await g.wait(1500); await g.shot('70-fusion-slots');
      await ge(() => { const f = globalThis.gameEntry.smithFusionPanel; f.ops.requestHeat(f.smithState.sessionId); });
      for (let i = 0; i < 60; i += 1) {
        await g.wait(200);
        const t = await ge(() => { const s = globalThis.gameEntry.smithFusionPanel.smithState; return s.temperature + (Date.now() - s.serverTime) / 1000 * s.temperatureRate; });
        if (t >= 720) break;
      }
      await g.shot('71-fusion-redhot');
      await ge(() => { const f = globalThis.gameEntry.smithFusionPanel; f.ops.requestFinish(f.smithState.sessionId); });
      await g.wait(1000); await g.shot('72-fusion-result');
      console.log('fusion notes:', await notes());
      await ge(() => globalThis.gameEntry.smithFusionPanel.closeFromUser());
      await ge(() => globalThis.gameEntry.ensureSmithFusionInfoReady().then(() => globalThis.gameEntry.smithFusionInfoStagePanel.open())); await g.wait(1500);
      await g.shot('73-fusion-info');
      await ge(() => { const p = globalThis.gameEntry.smithFusionInfoStagePanel; p.activeTab = 'forging'; p.renderSnapshot(); }); await g.wait(500);
      await g.shot('74-forge-info');
      await ge(() => globalThis.gameEntry.smithFusionInfoStagePanel.close());
    }
    if (want('repair')) {
      await g.chat('/wear 4'); await g.wait(800);
      await ge(() => globalThis.gameEntry.openMysticSmith({ id: 'craftsman_workbench', name: '工匠工作台' })); await g.wait(1500);
      await ge(() => { const m = globalThis.gameEntry.mysticSmithPanel; const i = m.itemState.inventory.slots.findIndex((it) => it && it.durability && it.durability.cur < it.durability.max); m.ops.requestSelect(m.smithState.sessionId, i); });
      await g.wait(1000); await g.shot('80-workbench-select');
      await ge(() => { const m = globalThis.gameEntry.mysticSmithPanel; m.ops.requestRepair(m.smithState.sessionId, m.offerKb); });
      await g.wait(1000); await g.shot('81-workbench-repaired');
      await ge(() => globalThis.gameEntry.mysticSmithPanel.close(true));
      await ge(() => globalThis.gameEntry.openCraftsmanMaterialShop()); await g.wait(1500);
      await g.shot('82-material-shop');
      await ge(() => globalThis.gameEntry.shopPanel.close && globalThis.gameEntry.shopPanel.close());
      await g.chat('/wear 4'); await g.chat('/go smith2'); await g.waitScene(); await g.wait(1500);
      await ge(() => globalThis.gameEntry.openMysticSmith({ id: '莫邪-4', name: '莫邪', level: 4 })); await g.wait(1500);
      await ge(() => { const m = globalThis.gameEntry.mysticSmithPanel; const s = m.itemState.inventory.slots; let i = s.findIndex((it) => it && it.ext && it.ext.affix); if (i < 0) i = s.findIndex((it) => it && it.durability && it.durability.cur < it.durability.max); m.ops.requestSelect(m.smithState.sessionId, i); });
      await g.wait(1000); await g.shot('83-mystic-select');
      await ge(() => { const m = globalThis.gameEntry.mysticSmithPanel; m.ops.requestRepair(m.smithState.sessionId, m.offerKb); });
      await g.wait(1000); await g.shot('84-mystic-repair');
      const strip = await ge(() => { const m = globalThis.gameEntry.mysticSmithPanel; const a = m.smithState.selection && m.smithState.selection.affixes; if (!a || !a.prefix.present) return 'no prefix'; globalThis.gameEntry.requestMysticSmithAffixRemoval(m.smithState.sessionId, 'remove_prefix'); return 'sent'; });
      await g.wait(1000); await g.shot('85-mystic-strip'); console.log('strip', strip, 'notes:', await notes());
      console.log('after strip', await ge(() => { const m = globalThis.gameEntry.mysticSmithPanel; return JSON.stringify({ aff: m.smithState.selection && m.smithState.selection.affixes, name: m.smithState.selection && m.smithState.selection.item.name, chance: m.chanceLabel && m.chanceLabel.string }); }));
    }
  } finally {
    g.dumpLogs('crafting'); await g.close();
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
