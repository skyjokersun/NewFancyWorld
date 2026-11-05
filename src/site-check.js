'use strict';
// Startup check of the frontend folder against data/site-files.json.gz (the
// file list of the complete bundle). Missing files are the usual reason the
// page hangs on the boot screen, so they are reported up front in Chinese.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function checkSite(root, dataDir, log) {
  let expected;
  try { expected = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, 'site-files.json.gz')))); } catch (_) { return null; }
  const pak = require('./sitepak').current();
  const missing = []; const wrongSize = [];
  for (const [rel, size] of expected) {
    // index.html and patches/ are allowed to differ (frontend-patch updates them).
    let st = null;
    try { st = fs.statSync(path.join(root, rel)); } catch (_) { st = pak && pak.stat(rel); }
    if (!st) missing.push(rel);
    else if (st.size !== size && rel !== 'index.html' && !rel.startsWith('patches/')) wrongSize.push(rel);
  }
  if (!missing.length && !wrongSize.length) { log.info('前端文件完整：' + expected.length + ' 个' + (pak ? '（含 site.pak）' : '')); return { missing, wrongSize }; }
  const sample = (list) => list.slice(0, 8).join('，') + (list.length > 8 ? ' 等' : '');
  if (missing.length) log.warn('前端文件缺少 ' + missing.length + ' 个（共 ' + expected.length + ' 个），例如：' + sample(missing));
  if (wrongSize.length) log.warn('前端文件大小不对 ' + wrongSize.length + ' 个（可能没解压完整或被改过），例如：' + sample(wrongSize));
  log.warn('请删掉 ' + root + ' 后重新完整解压 qiyu-server-full.zip；如果重新解压后仍然缺少，请检查杀毒软件是否隔离了这些文件。');
  return { missing, wrongSize };
}

module.exports = { checkSite };
