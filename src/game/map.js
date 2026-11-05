'use strict';
const OM = require('./original-monsters');
const fs = require('fs');
const path = require('path');

const TILE_W = 48;
const TILE_W_HALF = 24;
const TILE_H_HALF = 12;
const EPS = 1e-9;

// Grid <-> world conversion mirrors the client's MapPathfinding (staggered diamond).
function gridToPixel(gx, gy) {
  return { x: gx * TILE_W + (gy % 2) * TILE_W_HALF, y: -gy * TILE_H_HALF };
}
function pixelToGrid(x, y) {
  const gy = Math.round(-y / TILE_H_HALF);
  return { x: Math.round((x - (((gy % 2) + 2) % 2) * TILE_W_HALF) / TILE_W), y: gy };
}

class BinaryHeap {
  constructor(score) { this.items = []; this.score = score; }
  push(v) { const a = this.items; a.push(v); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (this.score(a[p]) <= this.score(a[i])) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.items; const top = a[0]; const last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && this.score(a[l]) < this.score(a[m])) m = l; if (r < a.length && this.score(a[r]) < this.score(a[m])) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
  get size() { return this.items.length; }
}

class GameMap {
  constructor(doc) {
    this.id = doc.id;
    this.width = doc.width;
    this.height = doc.height;
    this.walk = Buffer.from(doc.walk, 'base64');
    this.markers = doc.markers || {};
    this.connections = doc.connections || [];
    this.behaviors = doc.behaviors || {};
    this.decor = doc.decor || [];
    this.decorImgs = doc.decorImgs || [];
    this.baseMonsterSpawns = doc.monsterSpawns || null;
    this.monsterSpawns = this.baseMonsterSpawns;
    this.worldWidthPx = doc.worldWidthPx;
    this.worldHeightPx = doc.worldHeightPx;
    this.buildComponents();
  }

  isWalkableGrid(gx, gy) {
    return gx >= 0 && gy >= 0 && gx < this.width && gy < this.height && this.walk[gy * this.width + gx] === 1;
  }
  isWalkablePixel(x, y) { const g = pixelToGrid(x, y); return this.isWalkableGrid(g.x, g.y); }

  buildComponents() {
    const n = this.width * this.height;
    this.component = new Int32Array(n).fill(-1);
    this.componentCells = [];
    const queue = new Int32Array(n);
    for (let i = 0; i < n; i += 1) {
      if (!this.walk[i] || this.component[i] !== -1) continue;
      const id = this.componentCells.length; const cells = [];
      let head = 0, tail = 0; queue[tail++] = i; this.component[i] = id;
      while (head < tail) {
        const c = queue[head++]; cells.push(c);
        const cx = c % this.width, cy = (c / this.width) | 0;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
          const j = y * this.width + x;
          if (this.walk[j] && this.component[j] === -1) { this.component[j] = id; queue[tail++] = j; }
        }
      }
      this.componentCells.push(cells);
    }
    let best = -1, bestLen = 0;
    this.componentCells.forEach((c, id) => { if (c.length > bestLen) { bestLen = c.length; best = id; } });
    this.largestComponent = best;
  }

  componentAt(x, y) {
    const g = pixelToGrid(x, y);
    if (!this.isWalkableGrid(g.x, g.y)) return -1;
    return this.component[g.y * this.width + g.x];
  }

  // Analytic world-space supercover; identical to the client's monster
  // navigation guard (patch 82) so server routes never trigger a hard snap.
  segmentWalkable(sx, sy, ex, ey) {
    const cell = (gx, gy) => this.isWalkableGrid(gx, gy);
    const ay = -sy / 12, by = -ey / 12, dx = ex - sx, dy = by - ay;
    const first = Math.ceil(Math.min(ay, by) - 0.5 - EPS), last = Math.floor(Math.max(ay, by) + 0.5 + EPS);
    for (let gy = first; gy <= last; gy += 1) {
      let lo = 0, hi = 1;
      if (dy !== 0) {
        const t0 = (gy - 0.5 - ay) / dy, t1 = (gy + 0.5 - ay) / dy;
        lo = Math.max(0, Math.min(t0, t1)); hi = Math.min(1, Math.max(t0, t1));
        if (lo > hi + EPS) continue;
      }
      const odd = ((gy % 2) + 2) % 2;
      const x0 = (sx + dx * lo - odd * 24) / 48, x1 = (sx + dx * hi - odd * 24) / 48;
      for (let gx = Math.ceil(Math.min(x0, x1) - 0.5 - EPS), endX = Math.floor(Math.max(x0, x1) + 0.5 + EPS); gx <= endX; gx += 1) {
        if (!cell(gx, gy)) return false;
      }
      if (dy !== 0 && gy < last) {
        const t = (gy + 0.5 - ay) / dy;
        if (t >= -EPS && t <= 1 + EPS) {
          const x = sx + dx * Math.max(0, Math.min(1, t));
          const oddA = odd, oddB = (((gy + 1) % 2) + 2) % 2;
          const above = Math.round((x - oddA * 24) / 48), below = Math.round((x - oddB * 24) / 48);
          if (above !== below && (!cell(above, gy + 1) || !cell(below, gy))) return false;
        }
      }
    }
    return true;
  }

  nearestWalkableGrid(gx, gy, radius = 12) {
    if (this.isWalkableGrid(gx, gy)) return { x: gx, y: gy };
    for (let r = 1; r <= radius; r += 1) {
      let best = null, bestD = Infinity;
      for (let y = gy - r; y <= gy + r; y += 1) for (let x = gx - r; x <= gx + r; x += 1) {
        if (Math.abs(x - gx) !== r && Math.abs(y - gy) !== r) continue;
        if (!this.isWalkableGrid(x, y)) continue;
        const d = (x - gx) ** 2 + (y - gy) ** 2;
        if (d < bestD) { bestD = d; best = { x, y }; }
      }
      if (best) return best;
    }
    return null;
  }

  nearestWalkablePixel(x, y, radius = 12) {
    const g = pixelToGrid(x, y);
    const w = this.nearestWalkableGrid(g.x, g.y, radius);
    return w ? gridToPixel(w.x, w.y) : null;
  }

  // Like nearestWalkablePixel, but skips specks of walkable ground cut off from the rest.
  nearestOpenPixel(x, y, radius = 12, minCells = 50) {
    const g = pixelToGrid(x, y);
    let best = null; let bd = Infinity;
    for (let gy = g.y - radius * 2; gy <= g.y + radius * 2; gy += 1) {
      for (let gx = g.x - radius; gx <= g.x + radius; gx += 1) {
        if (!this.isWalkableGrid(gx, gy)) continue;
        const c = this.component[gy * this.width + gx];
        if (c < 0 || this.componentCells[c].length < minCells) continue;
        const p = gridToPixel(gx, gy); const d = Math.hypot(p.x - x, p.y - y);
        if (d < bd) { bd = d; best = p; }
      }
    }
    return best;
  }

  randomWalkablePixel(component = this.largestComponent, rng = Math.random) {
    const cells = this.componentCells[component] || this.componentCells[this.largestComponent];
    if (!cells || !cells.length) return gridToPixel(0, 0);
    const c = cells[(rng() * cells.length) | 0];
    return gridToPixel(c % this.width, (c / this.width) | 0);
  }

  // Default arrival point: teleport marker, then centre of largest component.
  spawnPoint() {
    const t = this.markers && this.markers.teleport;
    if (t && Number.isFinite(t.gx) && Number.isFinite(t.gy)) {
      const w = this.nearestWalkableGrid(t.gx, t.gy, 20);
      if (w) return gridToPixel(w.x, w.y);
    }
    const cells = this.componentCells[this.largestComponent];
    if (cells && cells.length) {
      const c = cells[(cells.length / 2) | 0];
      return gridToPixel(c % this.width, (c / this.width) | 0);
    }
    return gridToPixel(0, 0);
  }

  // 8-neighbour A* without corner cutting, followed by line-of-sight smoothing
  // with the supercover test. Returns world points excluding the start.
  findPath(sx, sy, ex, ey, maxNodes = 6000) {
    const s = pixelToGrid(sx, sy);
    let e = pixelToGrid(ex, ey);
    if (!this.isWalkableGrid(s.x, s.y)) {
      const n = this.nearestWalkableGrid(s.x, s.y, 4); if (!n) return null; s.x = n.x; s.y = n.y;
    }
    if (!this.isWalkableGrid(e.x, e.y)) { const n = this.nearestWalkableGrid(e.x, e.y, 6); if (!n) return null; e = n; }
    if (this.segmentWalkable(sx, sy, ex, ey) && this.isWalkablePixel(ex, ey)) return [{ x: ex, y: ey }];
    const W = this.width;
    const startIdx = s.y * W + s.x, goalIdx = e.y * W + e.x;
    if (startIdx === goalIdx) return [gridToPixel(e.x, e.y)];
    const g = new Map(); const came = new Map();
    const h = (i) => { const p = gridToPixel(i % W, (i / W) | 0); const q = gridToPixel(e.x, e.y); return Math.hypot(p.x - q.x, p.y - q.y); };
    const open = new BinaryHeap((n) => n.f);
    g.set(startIdx, 0); open.push({ i: startIdx, f: h(startIdx) });
    const closed = new Set(); let expanded = 0;
    while (open.size) {
      const cur = open.pop();
      if (closed.has(cur.i)) continue;
      if (cur.i === goalIdx) break;
      closed.add(cur.i);
      if (++expanded > maxNodes) return null;
      const cx = cur.i % W, cy = (cur.i / W) | 0;
      const cp = gridToPixel(cx, cy);
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (!this.isWalkableGrid(nx, ny)) continue;
        const np = gridToPixel(nx, ny);
        const dist = Math.hypot(np.x - cp.x, np.y - cp.y);
        if (dist > 40) continue;
        if (!this.segmentWalkable(cp.x, cp.y, np.x, np.y)) continue;
        const ni = ny * W + nx; const ng = g.get(cur.i) + dist;
        if (ng < (g.has(ni) ? g.get(ni) : Infinity)) { g.set(ni, ng); came.set(ni, cur.i); open.push({ i: ni, f: ng + h(ni) }); }
      }
    }
    if (!came.has(goalIdx)) return null;
    const cells = []; let c = goalIdx;
    while (c !== startIdx) { cells.push(c); c = came.get(c); }
    cells.reverse();
    const pts = cells.map((i) => gridToPixel(i % W, (i / W) | 0));
    // smooth
    const out = []; let ax = sx, ay = sy; let k = 0;
    while (k < pts.length) {
      let far = k;
      for (let j = pts.length - 1; j > k; j -= 1) if (this.segmentWalkable(ax, ay, pts[j].x, pts[j].y)) { far = j; break; }
      out.push(pts[far]); ax = pts[far].x; ay = pts[far].y; k = far + 1;
    }
    return out;
  }
}

class MapRegistry {
  constructor(dir) { this.dir = dir; this.maps = new Map(); this.index = JSON.parse(fs.readFileSync(path.join(dir, 'map-index.json'), 'utf8')); }
  normalize(ref) { return String(ref || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.json$/i, '').split('/').pop().toLowerCase(); }
  has(ref) { return Object.prototype.hasOwnProperty.call(this.index, this.normalize(ref)); }
  get(ref) {
    const id = this.normalize(ref);
    if (!this.has(id)) return null;
    if (!this.maps.has(id)) {
      const map = new GameMap(OM.fillDoc(JSON.parse(fs.readFileSync(path.join(this.dir, 'maps', id + '.json'), 'utf8'))));
      // Admin monster edits (features/balance.js).
      if (this.spawnOverlay) map.monsterSpawns = this.spawnOverlay(id, map.baseMonsterSpawns);
      this.maps.set(id, map);
    }
    return this.maps.get(id);
  }
  rawDoc(ref) {
    const id = this.normalize(ref);
    if (!this.has(id)) return null;
    return OM.fillDoc(JSON.parse(fs.readFileSync(path.join(this.dir, 'maps', id + '.json'), 'utf8')));
  }
  ids() { return Object.keys(this.index); }
  // A map's Chinese name, from the labels of the links that lead to it (admin page).
  nameOf(ref) {
    if (!this.names) {
      const votes = {};
      for (const id of this.ids()) {
        let doc; try { doc = this.rawDoc(id); } catch (_) { continue; }
        for (const c of doc.connections || []) for (const o of c.options || []) {
          const label = String(o.label || '').trim();
          if (!label || /^(出口|入口|返回|离开|进入|出去)/.test(label)) continue;
          const v = votes[this.normalize(o.mapId)] = votes[this.normalize(o.mapId)] || {};
          v[label] = (v[label] || 0) + 1;
        }
      }
      this.names = {};
      for (const [id, v] of Object.entries(votes)) this.names[id] = Object.entries(v).sort((a, b) => b[1] - a[1])[0][0];
    }
    return this.names[this.normalize(ref)] || '';
  }
  // Maps with monster spawns: the hunting grounds. Everywhere else (towns, post
  // stations, shops, guilds) is a safe zone. Read once and cached.
  huntingMaps() {
    if (!this.hunting) {
      this.hunting = new Set();
      for (const id of this.ids()) {
        try {
          let ms = this.rawDoc(id).monsterSpawns;
          if (this.spawnOverlay) ms = this.spawnOverlay(id, ms);
          if (ms && Array.isArray(ms.entries) && ms.entries.length) this.hunting.add(id);
        } catch (_) { /* unreadable map: treat as safe */ }
      }
    }
    return this.hunting;
  }
}

module.exports = { GameMap, MapRegistry, gridToPixel, pixelToGrid };
