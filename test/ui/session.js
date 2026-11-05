'use strict';
// Shared helpers for UI tests: prepare an account through the protocol, then
// boot the real frontend in headless Chromium and log in through gameEntry.
const fs = require('fs');
const { chromium } = require('playwright');
const { TestClient, OP } = require('../client');

const base = process.env.QIYU_URL || 'http://127.0.0.1:8090/';
const wsUrl = base.replace(/^http/, 'ws').replace(/\/?$/, '/ws');
const shotDir = process.env.SHOT_DIR || '/tmp/claude-0/shots';
fs.mkdirSync(shotDir, { recursive: true });

async function prepareAccount({ world = 'green', profession = null, level = 0 } = {}) {
  const c = new TestClient(wsUrl); await c.open();
  await c.wait(OP.CONNECT);
  const email = 'ui' + Date.now() + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register', requestId: 'r1' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register', requestId: 'r2' });
  await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123', serverId: world });
  await c.wait(OP.LOGIN_SUCCESS);
  const nickname = 'U' + String(Date.now()).slice(-6);
  c.send(OP.CHARACTER_CREATE, { nickname, appearance: { gender: 'man' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT);
  const login = await c.wait(OP.LOGIN_SUCCESS);
  if (level) c.send(OP.CHAT, { channel: 'world', message: '/level ' + level });
  if (profession) c.send(OP.CHAT, { channel: 'world', message: '/prof ' + profession });
  await new Promise((r) => setTimeout(r, 300));
  c.close();
  return { email, password: 'password123', nickname, playerId: login.data.playerId, world };
}

async function openGame(acct, { width = 1280, height = 800 } = {}) {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: Number(process.env.QIYU_DPR || 1) });
  const logs = [];
  page.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text()));
  page.on('response', (r) => { if (r.status() >= 400) logs.push('[' + r.status() + '] ' + r.url().split('?')[0]); });
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' ')));
  await page.goto(base, { waitUntil: 'load' });
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(1000);
    if (await page.evaluate(() => !!(globalThis.gameEntry && globalThis.gameEntry.loginPanel))) break;
  }
  await page.waitForTimeout(1500);
  const ctx = {
    browser, page, logs,
    shot: (name) => page.screenshot({ path: shotDir + '/' + name + '.png' }),
    eval: (fn, arg) => page.evaluate(fn, arg),
    wait: (ms) => page.waitForTimeout(ms),
    // Sends a chat line (dev commands start with '/').
    chat: (message) => page.evaluate((m) => globalThis.gameEntry.gameSession.sendPacket({ opCode: 3002, data: { channel: 'world', message: m } }), message),
    // Waits until no scene transition is showing (map fully loaded).
    waitScene: async (maxMs = 60000) => {
      const t0 = Date.now();
      await page.waitForTimeout(800);
      while (Date.now() - t0 < maxMs) {
        if (await page.evaluate(() => !globalThis.gameEntry.__qiyuSceneTransition)) return true;
        await page.waitForTimeout(500);
      }
      return false;
    },
    // Screen (page) coordinates of an actor, via the main camera.
    actorScreen: (id) => page.evaluate((actorId) => {
      const ge = globalThis.gameEntry; const a = ge.actorStates.get(actorId);
      if (!a || !a.node) return null;
      const cam = ge.mainCamera; const wp = a.node.worldPosition; const out = new cc.Vec3();
      cam.worldToScreen(wp, out);
      const canvas = document.querySelector('canvas'); const r = canvas.getBoundingClientRect();
      const sx = r.width / canvas.width, sy = r.height / canvas.height;
      return { x: r.left + out.x * sx, y: r.top + (canvas.height - out.y) * sy };
    }, id),
    dumpLogs: (name) => fs.writeFileSync(shotDir + '/' + name + '.log', logs.join('\n')),
    close: () => browser.close(),
  };
  if (acct) {
    await page.evaluate((a) => globalThis.gameEntry.handleLoginSubmit({ username: a.email, password: a.password, serverId: a.world }), acct);
    for (let i = 0; i < 40; i += 1) {
      await page.waitForTimeout(1000);
      const inWorld = await page.evaluate(() => { const g = globalThis.gameEntry; return !!(g && g.localPlayerId && g.loginPanel && !g.loginPanel.node?.active); }).catch(() => false);
      if (inWorld) break;
    }
    await page.waitForTimeout(3000);
  }
  return ctx;
}

module.exports = { prepareAccount, openGame, shotDir, wsUrl, OP };
