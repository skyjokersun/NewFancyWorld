'use strict';
const fs = require('fs');
const path = require('path');

function envInt(name, fallback) {
  const v = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : fallback;
}

const root = path.resolve(__dirname, '..');

// The frontend is the extracted site.rar: a folder with index.html, preload/,
// packs/ and resource-catalog.*.json.gz at its top. Accept the usual spots
// and step into a single wrapper folder (e.g. fe\\site\\index.html after
// "extract to site\\").
function isSiteDir(dir) {
  try { return fs.statSync(path.join(dir, 'index.html')).isFile(); } catch (_) { return false; }
}
function findSiteDir(dir, depth = 2) {
  if (isSiteDir(dir)) return dir;
  if (depth <= 0) return null;
  let subs = [];
  try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (_) { return null; }
  for (const d of subs) {
    const hit = findSiteDir(path.join(dir, d.name), depth - 1);
    if (hit) return hit;
  }
  return null;
}
function resolveWebRoot() {
  const candidates = process.env.QIYU_WEB_ROOT ? [process.env.QIYU_WEB_ROOT]
    : [path.join(root, 'site'), path.join(root, 'fe'), path.join(root, '..', 'fe'), path.join(root, '..', 'site')];
  for (const c of candidates) {
    const hit = findSiteDir(path.resolve(c));
    if (hit) return { dir: hit, found: true, candidates };
  }
  return { dir: path.resolve(candidates[0]), found: false, candidates };
}
const web = resolveWebRoot();
// Twelfth batch: site.pak next to start.bat holds the whole frontend in one file.
const sitePak = path.resolve(process.env.QIYU_SITE_PAK || path.join(root, 'site.pak'));
if (!web.found && fs.existsSync(sitePak)) { web.dir = path.resolve(web.candidates[0]); web.found = true; }

module.exports = {
  root,
  // Frontend static root (the extracted site.rar).
  webRoot: web.dir,
  webRootFound: web.found,
  sitePak,
  webRootCandidates: web.candidates.map((c) => path.resolve(c)),
  dataDir: path.join(root, 'data'),
  clientLogFile: path.resolve(process.env.QIYU_CLIENT_LOG || path.join(root, 'var', 'client.log')),
  stateFile: path.resolve(process.env.QIYU_STATE_FILE || path.join(root, 'var', 'state.json')),
  host: process.env.QIYU_HOST || '0.0.0.0',
  // Game port: the page, /ws and /client-log. Optional legacy split: page on 8081, ws on 8002.
  port: envInt('QIYU_PORT', 14514),
  // The /admin page has its own port and asks for the password in adminPasswordFile
  // (first line that does not start with #; created with a random password if missing).
  adminPort: envInt('QIYU_ADMIN_PORT', 19810),
  adminHost: process.env.QIYU_ADMIN_HOST || '127.0.0.1',
  adminPasswordFile: path.resolve(process.env.QIYU_ADMIN_PASSWORD_FILE || path.join(root, 'admin-password.txt')),
  legacyPagePort: envInt('QIYU_LEGACY_PAGE_PORT', 0),
  legacyWsPort: envInt('QIYU_LEGACY_WS_PORT', 0),
  // Dev mode: email codes are returned in the response message and logged.
  devMode: process.env.QIYU_DEV === '1',
  // Fixed email code accepted in dev mode (empty disables).
  devEmailCode: process.env.QIYU_DEV_EMAIL_CODE || '',
  tickMs: 50,
  syncIntervalMs: 100,
  heartbeatTimeoutMs: envInt('QIYU_HEARTBEAT_TIMEOUT_MS', 30000),
  saveIntervalMs: 15000,
  expRate: Number(process.env.QIYU_EXP_RATE) || 1,
  // Multipliers on the original drop tables (gold ~5%, equipment 0.01%-3% a kill),
  // which felt empty when hunting alone.
  dropRate: Number(process.env.QIYU_DROP_RATE) || 3,
  goldDropRate: Number(process.env.QIYU_GOLD_DROP_RATE) || 6,
  // The settings below can also be changed live on the /admin page (saved in var/state.json).
  goldAmountRate: 1,       // multiplier on the gold in each drop
  respawnRate: 1,          // multiplier on monster respawn time (0.5 = twice as fast)
  monsterCountRate: 1,     // multiplier on how many monsters each map holds
  monsterHpRate: 1,
  monsterDamageRate: 1,
  startGold: 500,          // gold of a newly created character
  allowRegister: true,     // false: the login page's register buttons only show registerClosedText
  registerClosedText: '暂未开放注册，请联系管理员',
  licensePrice: 1000000,   // stall license, gold
  licenseDays: 15,
  cardPuzzleNearSlot: true, // card puzzle: stand on the card's tile of the altar to place it
  cardPuzzleCooldownMin: 10, // card puzzle: minutes an altar rests after it is completed (0 = none)
  weightLimit: false,      // true: a full load blocks buying, pickup, trades and mining
  warriorRange: 0,          // warrior melee reach in px; 0 = the default 120 (a bow shoots from 400)
  safeTowns: true,         // no attacking in towns, post stations and other maps without monster spawns
  // Mounts (筋斗云 / 飞毯), editable on the /admin page.
  cloudStatPercent: 5,     // cloud: attack, break, defense, max HP/stamina and regen bonus
  cloudSpeed: 20,          // cloud: flat move speed bonus
  carpetSpeedPercent: 50,  // carpet: move speed bonus
  cloudRentPoints: 50,     // the fairy in 波赛敦广场: service points per 筋斗云 rental
  cloudRentDays: 15,       // the fairy in 波赛敦广场: days per rental (offline time counts)
  blessPointsPerHour: 2,   // 战神的祝福: service points per hour online
  blessExpFactor: 2,       // 战神的祝福: fixed level factor on monster exp (2 = the top, no decay)
  // 夜市 (fair): 小洁 sells 波波灯, 刘嫂 swaps crickets for a firefly.
  lampPrice: 50,
  fireflyGold: 1,          // gold crickets per firefly
  fireflyGreen: 3,
  fireflyBrown: 5,
  // Catching crickets in the fair (tenth batch): seen within cricketSeeRange of a player
  // who carries a 波波灯, caught by a click within cricketCatchRange; a catch uses one lamp.
  cricketMax: 20,          // crickets on the map at once
  cricketRespawnSec: 30,   // a caught cricket comes back after this many seconds
  cricketWeightGold: 5,    // how often each kind appears (relative weights)
  cricketWeightGreen: 30,
  cricketWeightBrown: 65,
  cricketCatchGold: 5,     // catch chance per click, in percent
  cricketCatchGreen: 15,
  cricketCatchBrown: 25,
  cricketSeeRange: 450,
  cricketCatchRange: 200,
  // 狐仙: chases players within this range and whoever hits it (tenth batch).
  foxDetectRange: 500,
  attackSpeedCap: 1,
  // Base life rules (fourteenth batch): 0 web, 1 original per level, 2 current level and profession.
  hpGrowthMode: 0,
  hpLevel1: 100,
  // Overweight walking speed as a share of the normal walk (eleventh batch: admin setting).
  overweightSpeedPercent: 50,
  // Auto-hunt potions (eleventh batch): at least this long between two auto uses, and the
  // thresholds a character starts with.
  autoPotionIntervalSec: 1,
  autoPotionHpPercent: 50,
  autoPotionMpPercent: 30,
  // Auto hunt (twelfth batch): no progress this long -> pick another monster and walk on;
  // this long -> the server moves the player next to a monster of the same map.
  autoHuntStuckSec: 10,
  autoHuntTeleportSec: 30,
  restartCountdownSec: 30,
  // Element damage (thirteenth batch, Q7; the original formula is unknown): each flat
  // element value is cut by the defender's resist of that element, resist capped here.
  elementResistCap: 75,
  // Wedding (twelfth batch; original values: 50 points each, invitations 1 point,
  // divorce 100 / forced 200). The remarry wait and the ceremony window are ours.
  marryPoints: 50,
  marryInvitePoints: 1,
  marryDivorcePoints: 100,
  marryForceDivorcePoints: 200,
  marryCooldownDays: 7,
  marryWindowMin: 40,
  // Long-term team (twelfth batch; original: 500 points + 3000 gold + community level 10
  // to apply, 100 points + 3000 gold charged, 100 points rent a month). Grace, auto
  // approval, contribution, levels and member caps are ours.
  teamApplyMinPoints: 500,
  teamApplyPoints: 100,
  teamApplyGold: 3000,
  teamApplyLevel: 10,
  teamRentPoints: 100,
  teamGraceDays: 7,
  teamAutoApprove: false,
  teamLogoPoints: 500,
  teamBaseMembers: 30,
  // Craftsman (twelfth batch): proficiency per fusion / repair success (战神的祝福 multiplies
  // it), the fusion odds by temperature and the smithy auto repair.
  craftExpPerSuccess: 1,
  craftBlessFactor: 2,
  fusionBestChance: 95,    // percent within fusionBestBand ℃ of 750℃
  fusionBestBand: 25,
  fusionEdgeChance: 40,    // percent at 600℃ / 900℃
  autoRepairIntervalSec: 8,
  autoRepairChance: 70,
  // Shops (tenth batch): equipment and books show up to the player's profession level + this.
  shopLevelFilter: true,
  shopLevelAhead: 15,
  targetRentGold: 0,       // arena target dummies: gold per rental
  serverName: process.env.QIYU_SERVER_NAME || '西部圣域',
  // System chat line shown when a player enters the game; empty = none.
  loginNotice: '现在是删档测试期间，感谢大家的测试和意见！',
  defaultMap: 'square_in',
  // Logical world ids the login screen offers. All are served by this process;
  // a character is bound to the world it was created in.
  // Bank service points granted to each account the first time it uses the bank.
  startServicePoints: Number(process.env.QIYU_START_SERVICE_POINTS) || 200,
  defaultWorld: process.env.QIYU_DEFAULT_WORLD || 'green',
  // Gardens grow during service hours (09:00-24:00 at this UTC offset, minutes).
  gardenUtcOffsetMin: envInt('QIYU_GARDEN_UTC_OFFSET_MIN', 480),
  gardenTimeScale: Number(process.env.QIYU_GARDEN_TIME_SCALE) || 1,
  worlds: ['adventure', 'west', 'green', 'east', 'south', 'angel'],
  // Cross-world scenes: players of every world meet in one shared instance
  // (PK arenas and team battles by default). Regex over map ids; '' disables.
  crossWorldMaps: process.env.QIYU_CROSS_MAPS != null ? process.env.QIYU_CROSS_MAPS
    : '^(pk_sj_r\\d+|team_pk_\\d+|snow_ctf01|snow_tdm01)$',
};
