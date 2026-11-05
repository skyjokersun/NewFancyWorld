'use strict';
// Boots the real frontend in headless Chromium against a running server.
const { chromium } = require('playwright');
const base = process.env.QIYU_URL || 'http://127.0.0.1:8090/';
const out = process.env.SHOT_DIR || '/tmp/claude-0/shots';
require('fs').mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const logs = [];
  page.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text()));
  page.on('response', (r) => { if (r.status() >= 400) logs.push('[404] ' + r.url()); });
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
  await page.goto(base, { waitUntil: 'load' });
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(1000);
    const ready = await page.evaluate(() => !!(globalThis.gameEntry && globalThis.gameEntry.loginPanel));
    if (ready) break;
  }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: out + '/01-login.png' });
  require('fs').writeFileSync(out + '/boot.log', logs.join('\n'));
  await browser.close();
})();
