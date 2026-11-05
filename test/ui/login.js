'use strict';
const { prepareAccount, openGame } = require('./session');
(async () => {
  const acct = await prepareAccount();
  const g = await openGame(acct);
  await g.page.mouse.click(640, 650);
  await g.wait(6000);
  await g.shot('02-world');
  g.dumpLogs('login');
  await g.close();
})().catch((e) => { console.error(e); process.exit(1); });
