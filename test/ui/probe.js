'use strict';
const { prepareAccount, openGame } = require('./session');
(async () => {
  const acct = await prepareAccount();
  const g = await openGame(acct);
  for (let i = 0; i < 8; i += 1) {
    const r = await g.eval(() => {
      const ge = globalThis.gameEntry; const s = ge.__qiyuSceneTransition;
      return s ? { holds: s.holds, failed: s.failed, fin: s.finishRequested, started: s.mapStarted, label: s.label && s.label.textContent, prog: s.progress && s.progress.style && s.progress.style.width } : 'none';
    });
    console.log(i, JSON.stringify(r));
    if (r === 'none') break;
    await g.wait(8000);
  }
  await g.shot('03-probe');
  g.dumpLogs('probe');
  await g.close();
})().catch((e) => { console.error(e); process.exit(1); });
