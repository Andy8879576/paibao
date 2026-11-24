/* ===== 派報系統 核心邏輯（無畫面相依，可單獨測試） ===== */
const Core = (() => {
  const R = 6371000, D2R = Math.PI / 180;

  /* ---------- 幾何 ---------- */
  function dist(a, b) {
    const dLat = (b[0] - a[0]) * D2R, dLon = (b[1] - a[1]) * D2R;
    const x = dLon * Math.cos(((a[0] + b[0]) / 2) * D2R);
    return Math.sqrt(x * x + dLat * dLat) * R;
  }
  function bearing(a, b) {
    const x = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * D2R);
    const y = b[0] - a[0];
    return (Math.atan2(x, y) / D2R + 360) % 360;
  }
  function angDiff(a, b) { let d = (b - a) % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; }
  // 點 p 投影到線段 ab
  function projSeg(p, a, b) {
    const k = Math.cos(p[0] * D2R);
    const ax = a[1] * k, ay = a[0], bx = b[1] * k, by = b[0], px = p[1] * k, py = p[0];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    return { t, q, d: dist(p, q) };
  }
  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
      if ((yi > p[0]) !== (yj > p[0]) && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function polyLength(coords) { let s = 0; for (let i = 1; i < coords.length; i++) s += dist(coords[i - 1], coords[i]); return s; }
  function pointAlong(coords, d) {
    let s = 0;
    for (let i = 1; i < coords.length; i++) {
      const l = dist(coords[i - 1], coords[i]);
      if (s + l >= d) { const t = l ? (d - s) / l : 0; return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t]; }
      s += l;
    }
    return coords[coords.length - 1];
  }
  function bbox(poly, padM = 0) {
    let s = 90, w = 180, n = -90, e = -180;
    for (const p of poly) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); }
    const dLat = padM / 111320, dLon = padM / (111320 * Math.cos(((s + n) / 2) * D2R));
    return [s - dLat, w - dLon, n + dLat, e + dLon];
  }

  /* ---------- 文字 ---------- */
  const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const CNU = { 十: 10, 百: 100, 千: 1000 };
  function cnToNum(str) {
    if (/^[零〇一二兩三四五六七八九]+$/.test(str) && str.length > 1 && !/[十百千]/.test(str))
      return Number([...str].map(c => CN[c]).join(''));
    let total = 0, cur = 0;
    for (const c of str) {
      if (c in CN) cur = CN[c];
      else if (c in CNU) { total += (cur || 1) * CNU[c]; cur = 0; }
    }
    return total + cur;
  }
  function norm(s) {
    if (!s) return '';
    s = String(s).replace(/[\uFF10-\uFF19]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 48));
    s = s.replace(/[零〇一二兩三四五六七八九十百千]+(?=[巷弄號之樓衖])/g, m => String(cnToNum(m)));
    s = s.replace(/臺/g, '台').replace(/[\s,，。、．.!！?？]/g, '');
    return s;
  }
  // 段數保留國字（OSM 慣用「一段」），把「1段」轉回國字
  function normRoad(s) {
    s = norm(s);
    return s.replace(/(\d)段/g, (m, d) => '零一二三四五六七八九'[d] + '段');
  }

  /* ---------- 圖資 → 路網 ---------- */
  const SKIP_HW = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'construction', 'proposed', 'platform', 'bus_stop', 'raceway', 'corridor', 'elevator', 'escape', 'rest_area', 'services', 'abandoned', 'razed', 'via_ferrata', 'bus_guideway']);
  function isRequiredType(w, opts) {
    if (w.fw === 'sidewalk' || w.fw === 'crossing' || w.fw === 'traffic_island') return false;
    if (w.svc === 'parking_aisle' || w.svc === 'drive-through' || w.svc === 'emergency_access') return false;
    if (w.hw === 'cycleway' || w.hw === 'bridleway') return false;
    if (!opts.includePaths && (w.hw === 'footway' || w.hw === 'path' || w.hw === 'steps' || w.hw === 'track')) return false;
    return true;
  }

  // 大馬路：兩邊分開派（紅＝順向、黑＝逆向）
  const MAIN_HW = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link']);
  const SMALL_HW = new Set(['service', 'footway', 'path', 'steps', 'pedestrian', 'living_street', 'track', 'cycleway']);
  function isTwoSided(w, mode) {
    if (mode === 'none') return false;
    if (MAIN_HW.has(w.hw)) return true;
    if (mode === 'named' && !SMALL_HW.has(w.hw) && /(路|街|大道)([一二三四五六七八九十]+段)?$/.test(w.name || '')) return true;
    return false;
  }
  // 機車可以停、可以騎到的路
  const DRIVE_HW = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service']);

  function buildNetwork(raw, poly, opts = {}) {
    opts = Object.assign({ includePaths: true, sampleStep: 8, twoMode: 'grade' }, opts);
    const nodes = raw.nodes; // id -> [lat,lon]
    const ways = raw.ways.filter(w => !SKIP_HW.has(w.hw) && w.n && w.n.length > 1);
    const segs = []; // {a,b,w}
    const inc = new Map(); // node -> [segIdx]
    const addInc = (n, i) => { let l = inc.get(n); if (!l) inc.set(n, l = []); l.push(i); };
    ways.forEach((w, wi) => {
      for (let i = 1; i < w.n.length; i++) {
        const a = w.n[i - 1], b = w.n[i];
        if (a === b || !nodes[a] || !nodes[b]) continue;
        segs.push({ a, b, w: wi }); addInc(a, segs.length - 1); addInc(b, segs.length - 1);
      }
    });
    const isJ = new Set();
    for (const [n, l] of inc) {
      if (l.length !== 2) { isJ.add(n); continue; }
      const w1 = ways[segs[l[0]].w], w2 = ways[segs[l[1]].w];
      if (w1 !== w2 && (w1.name || '') !== (w2.name || '')) isJ.add(n);
    }
    const used = new Uint8Array(segs.length);
    const chains = [];
    const walk = (start, si) => {
      const ns = [start], ws = new Map();
      let cur = start, s = si;
      for (;;) {
        used[s] = 1;
        const sg = segs[s], nx = sg.a === cur ? sg.b : sg.a;
        const w = ways[sg.w];
        const l = dist(nodes[cur], nodes[nx]);
        ws.set(sg.w, (ws.get(sg.w) || 0) + l);
        ns.push(nx); cur = nx;
        if (isJ.has(cur)) break;
        const nxt = inc.get(cur).find(k => !used[k]);
        if (nxt === undefined) { isJ.add(cur); break; }
        s = nxt;
      }
      let best = -1, bl = -1;
      for (const [wi, l] of ws) if (l > bl) { bl = l; best = wi; }
      const w = ways[best];
      const coords = ns.map(id => nodes[id]);
      const len = polyLength(coords);
      const mid = pointAlong(coords, len / 2);
      const inside = poly ? pointInPoly(mid, poly) : true;
      const c = {
        i: chains.length, a: ns[0], b: ns[ns.length - 1], nodes: ns, coords, len,
        name: w.name || '', wayId: w.id, hw: w.hw,
        req: inside && isRequiredType(w, opts),
        two: isTwoSided(w, opts.twoMode), drive: DRIVE_HW.has(w.hw),
        key: ns[0] < ns[ns.length - 1] || (ns[0] === ns[ns.length - 1] && ns[1] < ns[ns.length - 2])
          ? ns[0] + '-' + ns[1] + '-' + ns[ns.length - 1] : ns[ns.length - 1] + '-' + ns[ns.length - 2] + '-' + ns[0],
      };
      // 順向：往北或往東的方向（a→b 若大致往北／東，f 側就是順向）
      const br = bearing(coords[0], coords[coords.length - 1]);
      c.fShun = br >= 315 || br < 135;
      // 取樣點：判斷是否走過
      const k = Math.max(1, Math.round(len / opts.sampleStep));
      c.samples = [];
      for (let j = 0; j < k; j++) c.samples.push(pointAlong(coords, ((j + 0.5) / k) * len));
      chains.push(c);
    };
    for (const n of isJ) for (const si of inc.get(n)) if (!used[si]) walk(n, si);
    // 純環狀道路（沒有路口）
    for (let si = 0; si < segs.length; si++) if (!used[si]) { isJ.add(segs[si].a); walk(segs[si].a, si); }

    // 壓縮後的路口圖
    const jIds = [...new Set(chains.flatMap(c => [c.a, c.b]))];
    const jIndex = new Map(jIds.map((id, i) => [id, i]));
    const adj = jIds.map(() => []);
    for (const c of chains) {
      c.ia = jIndex.get(c.a); c.ib = jIndex.get(c.b);
      adj[c.ia].push(c.i);
      adj[c.ib].push(c.i);
    }
    const jPos = jIds.map(id => nodes[id]);
    const net = { chains, jIds, jPos, adj, poly, addrs: raw.addrs || [], grid: null };
    buildGrid(net);
    return net;
  }

  /* ---------- 空間索引 ---------- */
  const CELL = 0.0005; // 約 50 公尺
  const cellKey = (lat, lon) => Math.floor(lat / CELL) + ':' + Math.floor(lon / CELL);
  function buildGrid(net) {
    const g = new Map();
    for (const c of net.chains) {
      const keys = new Set();
      const pts = c.coords.concat(c.samples);
      for (const p of pts) keys.add(cellKey(p[0], p[1]));
      for (const k of keys) { let l = g.get(k); if (!l) g.set(k, l = []); l.push(c.i); }
    }
    net.grid = g;
  }
  function chainsNear(net, p, rM) {
    const r = Math.ceil(rM / 50) + 1, ci = Math.floor(p[0] / CELL), cj = Math.floor(p[1] / CELL);
    const out = new Set();
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      const l = net.grid.get((ci + i) + ':' + (cj + j)); if (l) for (const x of l) out.add(x);
    }
    return [...out];
  }
  // 找最近的街道（回傳 chain、投影點、沿線距離）
  function nearestChain(net, p, maxM = 400, filter) {
    let best = null;
    let cand = chainsNear(net, p, Math.min(maxM, 150));
    if (!cand.length) cand = net.chains.map(c => c.i);
    for (const ci of cand) {
      const c = net.chains[ci];
      if (filter && !filter(c)) continue;
      let along = 0;
      for (let k = 1; k < c.coords.length; k++) {
        const pr = projSeg(p, c.coords[k - 1], c.coords[k]);
        const segL = dist(c.coords[k - 1], c.coords[k]);
        if (!best || pr.d < best.d) best = { c: ci, d: pr.d, q: pr.q, along: along + pr.t * segL };
        along += segL;
      }
    }
    return best && best.d <= maxM ? best : null;
  }

  /* ---------- 走過的街道 ---------- */
  function markVisits(net, p, rM, hits, covered, thresh = 0.7, allow) {
    const newly = [];
    for (const ci of chainsNear(net, p, rM)) {
      const c = net.chains[ci];
      if (!c.req || c.two || covered.has(c.key)) continue;
      if (allow && !allow.has(c.key)) continue;
      let h = hits.get(c.key); if (!h) hits.set(c.key, h = new Uint8Array(c.samples.length));
      let changed = false;
      for (let k = 0; k < c.samples.length; k++) if (!h[k] && dist(p, c.samples[k]) <= rM) { h[k] = 1; changed = true; }
      if (changed) {
        let n = 0; for (const x of h) n += x;
        if (n / h.length >= thresh) { covered.add(c.key); newly.push(ci); }
      }
    }
    return newly;
  }

  /* ---------- 最短路徑 ---------- */
  class Heap {
    constructor() { this.k = []; this.v = []; }
    push(key, val) {
      const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
      while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
      if (n) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1; if (c >= n) break;
          if (c + 1 < n && k[c + 1] < k[c]) c++;
          if (k[c] >= lk) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lk; v[i] = lv;
      }
      return top;
    }
    get size() { return this.k.length; }
  }
  // 多起點 Dijkstra；stopFn(node) 回傳 true 即停止
  function dijkstra(net, sources, stopFn) {
    const n = net.jIds.length;
    const d = new Float64Array(n).fill(Infinity), prevC = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    const h = new Heap();
    for (const s of sources) { d[s] = 0; h.push(0, s); }
    let hit = -1;
    while (h.size) {
      const u = h.pop(); if (done[u]) continue; done[u] = 1;
      if (stopFn && stopFn(u)) { hit = u; break; }
      for (const ci of net.adj[u]) {
        const c = net.chains[ci], v = c.ia === u ? c.ib : c.ia, nd = d[u] + c.len;
        if (nd < d[v]) { d[v] = nd; prevC[v] = ci; h.push(nd, v); }
      }
    }
    return { d, prevC, hit };
  }
  function tracePath(net, prevC, target) {
    const path = []; let v = target;
    while (prevC[v] !== -1) { const c = net.chains[prevC[v]]; path.push(prevC[v]); v = c.ia === v ? c.ib : c.ia; }
    return path.reverse();
  }

  // 圖資缺漏時的「直線連接」虛擬路段
  function addVirtual(net, a, b) {
    const ex = net.chains.find(c => c.virtual && ((c.ia === a && c.ib === b) || (c.ia === b && c.ib === a)));
    if (ex) return ex.i;
    const coords = [net.jPos[a], net.jPos[b]];
    const c = { i: net.chains.length, a: net.jIds[a], b: net.jIds[b], ia: a, ib: b, nodes: [net.jIds[a], net.jIds[b]], coords, len: dist(coords[0], coords[1]) * 1.3, name: '', wayId: 0, hw: 'virtual', req: false, virtual: true, key: 'v' + a + '-' + b, samples: [] };
    net.chains.push(c); net.adj[a].push(c.i); net.adj[b].push(c.i);
    return c.i;
  }

  /* ---------- 路線規劃（走遍所有待派街道） ---------- */
  // 位置 → 最近的路口
  function nearestJunction(net, p, filter) {
    const nc = nearestChain(net, p, 3000, filter);
    if (!nc) return -1;
    const c = net.chains[nc.c];
    return nc.along <= c.len / 2 ? c.ia : c.ib;
  }
  // items：[{c, side}]，side 為 null（兩邊一次派）或 'f'／'b'（大馬路其中一邊）；也接受舊格式的 chain 編號
  function planRoute(net, items, start, opts = {}) {
    items = (items || []).map(x => typeof x === 'number' ? { c: x, side: null } : x);
    if (!items.length) return null;
    const reqChains = items.map(x => x.c);
    const n = net.jIds.length;
    // 起點：離目前位置最近的路口
    let s = nearestJunction(net, start);
    if (s < 0) s = net.chains[reqChains[0]].ia;
    // 終點：回到起點、指定地點，或不指定
    let t = -1;
    if (opts.returnToStart) t = s;
    else if (opts.end) { t = nearestJunction(net, opts.end); if (t < 0) t = s; }

    const inst = []; // {c, dead, side}
    const deg = new Int32Array(n);
    const addInst = (ci, dead, side) => { const c = net.chains[ci]; inst.push({ c: ci, dead, side: side || null }); deg[c.ia]++; deg[c.ib]++; };
    for (const it of items) addInst(it.c, false, it.side);

    // 1) 把分散的區域連起來（Prim）
    const parent = new Int32Array(n).map((_, i) => i);
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
    const touched = new Set([s]); if (t >= 0) touched.add(t);
    for (const ci of reqChains) { const c = net.chains[ci]; unite(c.ia, c.ib); touched.add(c.ia); touched.add(c.ib); }
    const treeRoot = () => find(s);
    for (let guard = 0; guard < 5000; guard++) {
      const tr = treeRoot();
      const tree = [], others = new Set();
      for (const v of touched) { if (find(v) === tr) tree.push(v); else others.add(v); }
      if (!others.size) break;
      const r = dijkstra(net, tree, u => others.has(u));
      if (r.hit < 0) { // 圖資上沒有路相連：用直線（步行穿越）接起來
        let best = null;
        for (const a of tree) for (const b of others) {
          const d = dist(net.jPos[a], net.jPos[b]);
          if (!best || d < best.d) best = { a, b, d };
        }
        const ci = addVirtual(net, best.a, best.b);
        addInst(ci, true); unite(best.a, best.b);
        continue;
      }
      for (const ci of tracePath(net, r.prevC, r.hit)) { addInst(ci, true); const c = net.chains[ci]; unite(c.ia, c.ib); touched.add(c.ia); touched.add(c.ib); }
      unite(r.hit, s);
    }
    if (!inst.length) return null;

    // 2) 奇數度路口配對（中國郵差問題）
    const oddSet = new Set();
    for (let v = 0; v < n; v++) if (deg[v] % 2) oddSet.add(v);
    const flip = v => { if (oddSet.has(v)) oddSet.delete(v); else oddSet.add(v); };
    if (t < 0) flip(s);            // 終點不指定：剩一個奇數點當終點
    else if (t !== s) { flip(s); flip(t); } // 從 s 走到 t
    const odd = [...oddSet];
    const k = odd.length;
    if (k) {
      const idx = new Map(odd.map((v, i) => [v, i]));
      const D = new Float64Array(k * k), prevs = [];
      for (let i = 0; i < k; i++) {
        let remain = k - 1;
        const r = dijkstra(net, [odd[i]], u => idx.has(u) && u !== odd[i] && --remain <= 0);
        for (let j = 0; j < k; j++) D[i * k + j] = r.d[odd[j]];
        prevs.push(r.prevC);
      }
      // 貪婪配對
      const pairs = [];
      for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) pairs.push([D[i * k + j], i, j]);
      pairs.sort((a, b) => a[0] - b[0]);
      const mate = new Int32Array(k).fill(-1);
      for (const [d, i, j] of pairs) if (mate[i] < 0 && mate[j] < 0 && isFinite(d)) { mate[i] = j; mate[j] = i; }
      // 若是一筆畫終點不固定，剩一個不配對
      // 2-opt 改善
      const cost = (i, j) => (i < 0 || j < 0) ? 0 : D[i * k + j];
      for (let pass = 0; pass < 6; pass++) {
        let improved = false;
        for (let a = 0; a < k; a++) for (let c = a + 1; c < k; c++) {
          const b = mate[a], d = mate[c];
          if (b === c || (b < 0 && d < 0)) continue;
          if (b >= 0 && b < a && d >= 0) continue; // 每組只檢查一次
          const cur = cost(a, b) + cost(c, d);
          if (b >= 0 && d >= 0) {
            if (cost(a, c) + cost(b, d) < cur - 0.5) { mate[a] = c; mate[c] = a; mate[b] = d; mate[d] = b; improved = true; }
            else if (cost(a, d) + cost(b, c) < cur - 0.5) { mate[a] = d; mate[d] = a; mate[b] = c; mate[c] = b; improved = true; }
          } else if (b >= 0 && d < 0) { // c 未配對
            if (cost(c, b) < cur - 0.5) { mate[c] = b; mate[b] = c; mate[a] = -1; improved = true; }
            else if (cost(c, a) < cur - 0.5) { mate[c] = a; mate[a] = c; mate[b] = -1; improved = true; }
          } else if (b < 0 && d >= 0) {
            if (cost(a, d) < cur - 0.5) { mate[a] = d; mate[d] = a; mate[c] = -1; improved = true; }
            else if (cost(a, c) < cur - 0.5) { mate[a] = c; mate[c] = a; mate[d] = -1; improved = true; }
          }
        }
        if (!improved) break;
      }
      for (let i = 0; i < k; i++) {
        const j = mate[i]; if (j < 0 || j < i) continue;
        if (!isFinite(D[i * k + j])) continue;
        for (const ci of tracePath(net, prevs[i], odd[j])) addInst(ci, true);
      }
    }

    // 3) 一筆畫（Hierholzer）
    const nadj = new Map();
    inst.forEach((it, i) => {
      const c = net.chains[it.c];
      for (const v of [c.ia, c.ib]) { let l = nadj.get(v); if (!l) nadj.set(v, l = []); l.push(i); }
    });
    // 優先走需要派的街道；大馬路優先照「派右手邊」的方向走
    const pref = (e, v) => {
      const it = inst[e]; if (it.dead) return 2;
      if (!it.side) return 0;
      const c = net.chains[it.c];
      return (it.side === 'f') === (c.ia === v) ? 0 : 1;
    };
    for (const [v, l] of nadj) l.sort((x, y) => pref(x, v) - pref(y, v));
    const usedI = new Uint8Array(inst.length), ptr = new Map();
    const stN = [s], stE = [-1], stF = [-1], out = [];
    while (stN.length) {
      const v = stN[stN.length - 1], l = nadj.get(v) || [];
      let p = ptr.get(v) || 0;
      while (p < l.length && usedI[l[p]]) p++;
      ptr.set(v, p);
      if (p < l.length) {
        const e = l[p]; usedI[e] = 1;
        const c = net.chains[inst[e].c];
        const w = c.ia === v ? c.ib : c.ia;
        stN.push(w); stE.push(e); stF.push(v);
      } else {
        stN.pop(); const e = stE.pop(), f = stF.pop();
        if (e >= 0) out.push({ e, from: f });
      }
    }
    out.reverse();
    const steps = out.map(({ e, from }) => {
      const c = net.chains[inst[e].c];
      const fwd = c.ia === from, side = inst[e].side;
      // 走路時要派哪一邊：小巷兩邊；大馬路依方向決定右手邊或左手邊
      const walk = inst[e].dead ? null : !side ? '兩邊' : ((side === 'f') === fwd ? '右手邊' : '左手邊');
      return { c: c.i, fwd, dead: inst[e].dead, side, walk };
    });
    for (let i = 0; i < steps.length; i++) {
      const a = steps[i]; if (a.dead || a.side || a.inout) continue;
      const aTo = a.fwd ? net.chains[a.c].ib : net.chains[a.c].ia;
      for (let j = i + 1; j < steps.length; j++) {
        const b = steps[j];
        if (b.c === a.c && b.fwd !== a.fwd && b.dead && (b.fwd ? net.chains[b.c].ia : net.chains[b.c].ib) === aTo) {
          a.inout = true; a.walk = '右手邊'; a.markLater = true;
          b.dead = false; b.walk = '另一邊'; b.outOf = true;
          break;
        }
        if (b.c === a.c) break;
      }
    }
    return expandRoute(net, steps, s, opts.loop);
  }

  // 從目前位置走回停車點（不用派的路）
  function routeBetween(net, from, to) {
    const s = nearestJunction(net, from), t = nearestJunction(net, to);
    if (s < 0 || t < 0 || s === t) return null;
    const r = dijkstra(net, [s], u => u === t);
    if (r.hit < 0) return null;
    let cur = s;
    const steps = tracePath(net, r.prevC, t).map(ci => { const c = net.chains[ci]; const fwd = c.ia === cur; cur = fwd ? c.ib : c.ia; return { c: ci, fwd, dead: true, side: null, walk: null }; });
    return expandRoute(net, steps, s, true, true);
  }
  function expandRoute(net, steps, s, loop, back) {
    const coords = [net.jPos[s]], cum = [0];
    for (const st of steps) {
      const c = net.chains[st.c];
      const cc = st.fwd ? c.coords : c.coords.slice().reverse();
      st.i0 = coords.length - 1;
      for (let k = 1; k < cc.length; k++) { cum.push(cum[cum.length - 1] + dist(coords[coords.length - 1], cc[k])); coords.push(cc[k]); }
      st.i1 = coords.length - 1;
      st.d0 = cum[st.i0]; st.d1 = cum[st.i1];
      st.from = st.fwd ? c.ia : c.ib; st.to = st.fwd ? c.ib : c.ia;
    }
    const route = { steps, coords, cum, total: cum[cum.length - 1], start: s, loop: !!loop, back: !!back };
    route.maneuvers = buildManeuvers(net, route);
    return route;
  }

  /* ---------- 小循環（依張數分圈） ---------- */
  // 每個派報項目大約幾張：小巷兩邊、大馬路一邊；density＝每 100 公尺單邊幾張
  function itemFlyers(net, it, density) {
    const c = net.chains[it.c];
    return c.len / 100 * density * (it.side ? 1 : 2);
  }
  // 從停車點開始，由近到遠挑街道，直到張數用完
  function selectLoop(net, items, start, cap, density) {
    items = items.map(x => typeof x === 'number' ? { c: x, side: null } : x);
    const s = nearestJunction(net, start);
    if (s < 0 || !items.length) return { pick: [], rest: items, flyers: 0 };
    const r = dijkstra(net, [s]);
    const scored = items.map(it => {
      const c = net.chains[it.c];
      let d = Math.min(r.d[c.ia], r.d[c.ib]);
      if (!isFinite(d)) d = dist(start, pointAlong(c.coords, c.len / 2)) * 1.5;
      return { it, d: d + c.len / 2, f: itemFlyers(net, it, density) };
    }).sort((a, b) => a.d - b.d);
    const pick = [], rest = [];
    let sum = 0;
    for (const x of scored) {
      if (!cap || sum + x.f <= cap * 1.05 || !pick.length) { pick.push(x.it); sum += x.f; }
      else rest.push(x.it);
    }
    // 同一條大馬路的另一邊如果也在這一圈附近，一起排（減少再回來）
    return { pick, rest, flyers: sum };
  }
  // 路口名稱：「A路與B巷口」
  function junctionLabel(net, j) {
    const names = [];
    for (const ci of net.adj[j]) { const nm = net.chains[ci].name; if (nm && !names.includes(nm)) names.push(nm); }
    if (names.length >= 2) return names[0] + '與' + names[1] + '口';
    if (names.length === 1) return names[0] + '上';
    return '路口';
  }
  // 建議下一個停車點：先找離現在最近的未派街道，以它為中心估一圈，再找圈中心附近機車到得了的路口
  function suggestPark(net, items, from, cap, density) {
    items = items.map(x => typeof x === 'number' ? { c: x, side: null } : x);
    if (!items.length) return null;
    let seed = null;
    for (const it of items) {
      const c = net.chains[it.c], m = pointAlong(c.coords, c.len / 2), d = dist(from, m);
      if (!seed || d < seed.d) seed = { d, p: m };
    }
    const tent = selectLoop(net, items, seed.p, cap, density);
    let lat = 0, lon = 0, w = 0;
    for (const it of tent.pick) {
      const c = net.chains[it.c], m = pointAlong(c.coords, c.len / 2);
      lat += m[0] * c.len; lon += m[1] * c.len; w += c.len;
    }
    const ctr = w ? [lat / w, lon / w] : seed.p;
    const j = nearestJunction(net, ctr, c => c.drive && !c.virtual);
    const jj = j >= 0 ? j : nearestJunction(net, ctr);
    if (jj < 0) return null;
    return { p: net.jPos[jj], j: jj, label: junctionLabel(net, jj), dist: dist(from, net.jPos[jj]), flyers: tent.flyers };
  }
  // 把整個區塊切成好幾圈（預覽用）
  function planLoops(net, items, start, cap, density, maxLoops = 30) {
    let rest = items.map(x => typeof x === 'number' ? { c: x, side: null } : x);
    const loops = [];
    let P = start;
    while (rest.length && loops.length < maxLoops) {
      const sel = selectLoop(net, rest, P, cap, density);
      if (!sel.pick.length) break;
      const j = nearestJunction(net, P);
      loops.push({ park: P, label: j >= 0 ? junctionLabel(net, j) : '', items: sel.pick, flyers: sel.flyers, len: sel.pick.reduce((a, it) => a + net.chains[it.c].len, 0) });
      rest = sel.rest;
      if (!rest.length) break;
      const nx = suggestPark(net, rest, P, cap, density);
      if (!nx) break;
      P = nx.p;
    }
    return { loops, rest };
  }
  // 最近的門牌（播報「大約在幾號前面」用）
  function nearestAddr(net, p, maxM = 25, street) {
    let best = null;
    const st = street ? normRoad(street) : '';
    for (const a of net.addrs) {
      if (Math.abs(a.lat - p[0]) > 0.0004 || Math.abs(a.lon - p[1]) > 0.0005) continue;
      if (st && a.s && normRoad(a.s) !== st) continue;
      const d = dist(p, [a.lat, a.lon]);
      if (d <= maxM && (!best || d < best.d)) best = { d, a };
    }
    return best ? best.a : null;
  }

  /* ---------- 轉彎提示 ---------- */
  function pointAtRoute(route, d) {
    const { cum, coords } = route;
    d = Math.max(0, Math.min(route.total, d));
    let lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
    const l = cum[hi] - cum[lo], t = l ? (d - cum[lo]) / l : 0;
    return [coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t, coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t];
  }
  function dirWord(a) {
    const x = Math.abs(a);
    if (x < 25) return null;
    if (x >= 150) return '回頭';
    if (x < 60) return a > 0 ? '靠右' : '靠左';
    return a > 0 ? '右轉' : '左轉';
  }
  function buildManeuvers(net, route) {
    const st = route.steps, M = [];
    const degree = v => net.adj[v].length;
    if (!st.length) return M;
    const first = net.chains[st[0].c];
    const sideTxt = x => x.dead ? (route.back ? '往停車點' : '這段不用派') : x.walk === '兩邊' ? '兩邊都派' : x.walk === '另一邊' ? '派另一邊出來' : '派' + x.walk;
    M.push({ d: 0, type: 'start', dir: '出發', name: first.name, walk: st[0].walk, text: route.back ? '往停車的地方走' + (first.name ? '，沿著' + first.name + '走' : '') : '開始派報' + (first.name ? '，沿著' + first.name + '走' : '') + '，' + sideTxt(st[0]) });
    for (let k = 1; k < st.length; k++) {
      const node = st[k].from, d = st[k].d0;
      const prev = st[k - 1], cur = st[k];
      const pc = net.chains[prev.c], cc = net.chains[cur.c];
      const isU = prev.c === cur.c && prev.fwd !== cur.fwd && pc.ia !== pc.ib;
      const pin = pointAtRoute(route, d - Math.min(12, (prev.d1 - prev.d0) * 0.9));
      const pout = pointAtRoute(route, d + Math.min(12, (cur.d1 - cur.d0) * 0.9));
      const here = route.coords[cur.i0];
      const ang = isU ? 180 : angDiff(bearing(pin, here), bearing(here, pout));
      const dg = degree(node);
      let dir = dirWord(ang);
      const sideChanged = prev.walk !== cur.walk || prev.dead !== cur.dead;
      if (!dir) {
        // 沒有轉彎，但派法改變（例如從要派變成不用派、或要換到對面）
        if (sideChanged && !(prev.dead && cur.dead)) {
          const cross = prev.side && cur.side && prev.walk !== cur.walk && !cur.dead;
          M.push({ d, type: 'side', dir: cross ? '過馬路' : '直走', ang: 0, name: cc.name, k, walk: cur.walk, dead: cur.dead,
            text: cross ? '過馬路到對面，改' + sideTxt(cur) : '繼續直走' + (cc.name && cc.name !== pc.name ? '，進入' + cc.name : '') + '，' + sideTxt(cur) });
        }
        continue;
      }
      if (dg <= 2 && !isU && Math.abs(ang) < 60 && !sideChanged) continue; // 彎路不提示
      const deadEnd = isU && dg === 1;
      const m = { d, type: dir === '回頭' ? 'uturn' : 'turn', dir, ang, name: cc.name, k, walk: cur.walk, dead: cur.dead };
      if (dir === '回頭') {
        if (cur.side && prev.side && cur.c === prev.c) m.text = '過馬路到對面，回頭' + sideTxt(cur);
        else if (cur.c === prev.c && cur.outOf) m.text = (deadEnd ? '到底了，' : '') + '回頭，派另一邊出來';
        else m.text = (deadEnd ? '到底了，回頭' : '回頭') + (cur.dead ? '，這段不用派' : '');
      }
      else m.text = dir + (cc.name && cc.name !== pc.name ? '，轉進' + cc.name : '') + '，' + sideTxt(cur);
      // 右進左出：進去派右手邊，之後原路出來派另一邊
      if (dir !== '回頭' && cur.inout) {
        let j = k + 1; while (j < st.length && !(st[j].c === cur.c && st[j].outOf)) j++;
        const isDead = j < st.length && degree(st[j].from) === 1 && j === k + 1;
        m.inout = true;
        m.text = dir + (cc.name && cc.name !== pc.name ? '，轉進' + cc.name : '') + (isDead ? '，這條是死巷' : '') + '，右進左出：進去先派右手邊';
      }
      M.push(m);
    }
    M.push({ d: route.total, type: 'end', dir: '完成', name: '', text: route.back ? '到停車的地方了' : route.loop ? '這一圈派完了，回到停車的地方' : '這個區塊派完了，辛苦了' });
    return M;
  }

  /* ---------- 導航追蹤 ---------- */
  function createTracker(route) {
    return { route, s: 0, offCount: 0, offSince: 0 };
  }
  // 回傳 {s, off, d}
  function trackUpdate(tr, p, moveBear, speed, maxOff, maxJump = 40) {
    const { route } = tr, { coords, cum } = route;
    const from = tr.s - 25, to = tr.s + maxJump;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] <= Math.max(0, from)) lo = m; else hi = m; }
    let best = null;
    for (let i = lo; i < coords.length - 1 && cum[i] <= to; i++) {
      const pr = projSeg(p, coords[i], coords[i + 1]);
      const sd = cum[i] + pr.t * (cum[i + 1] - cum[i]);
      let score = pr.d + Math.max(0, sd - tr.s - 8) * 0.15;
      if (moveBear != null && speed > 0.6 && cum[i + 1] - cum[i] > 0.5) {
        const sb = bearing(coords[i], coords[i + 1]);
        if (Math.abs(angDiff(moveBear, sb)) > 100) score += 18;
      }
      if (!best || score < best.score) best = { score, d: pr.d, s: sd };
    }
    if (best && best.d <= maxOff) {
      tr.s = Math.max(tr.s, best.s);
      tr.offCount = 0;
      return { s: tr.s, off: false, d: best.d };
    }
    tr.offCount++;
    return { s: tr.s, off: true, d: best ? best.d : Infinity };
  }
  // 把位置重新對到路線（定位修正後）
  function trackRelocate(tr, p) {
    const { coords, cum } = tr.route;
    let best = null;
    for (let i = 0; i < coords.length - 1; i++) {
      const pr = projSeg(p, coords[i], coords[i + 1]);
      const sd = cum[i] + pr.t * (cum[i + 1] - cum[i]);
      const score = pr.d + Math.abs(sd - tr.s) * 0.01;
      if (!best || score < best.score) best = { score, d: pr.d, s: sd };
    }
    if (best) tr.s = best.s;
    return best;
  }

  /* ---------- 語音指令 ---------- */
  function parseCommand(text) {
    const t = norm(text);
    if (!t) return { cmd: 'none' };
    if (/廁所|洗手間|化妝室|尿尿|上大號/.test(t)) return { cmd: 'toilet' };
    if (/下一(個|站|圈)|停車點|停哪|騎到哪/.test(t) && !/號/.test(t)) return { cmd: 'nextpark' };
    // 修正位置：「你報錯了，我現在在萬大路449巷10號這邊」
    if (/[路街巷弄號口段]/.test(t) && /在|位置|報錯|錯了|不對/.test(t)) {
      const m = t.match(/(?:在|位置是|位置)([^在]*[路街巷弄號口段][^在]*)$/);
      if (m && m[1]) {
        const arg = m[1].replace(/(這邊|這裡|這兒|附近|旁邊|前面|門口|對面|了|啦|喔|耶)+$/, '');
        if (arg.length >= 2) return { cmd: 'locate', arg };
      }
    }
    if (/^(這條|這段|這邊|這區|這巷|這裡)?.{0,3}(派完|派好|發完|送完)/.test(t) && !/全部|整個|區塊/.test(t)) return { cmd: 'streetdone' };
    if (/標記|記下|註記/.test(t)) {
      let type = 'other';
      if (/拒收|不要|不收|不投/.test(t)) type = 'refuse';
      else if (/信箱/.test(t)) type = 'nobox';
      else if (/狗/.test(t)) type = 'dog';
      return { cmd: 'mark', arg: type, note: t.replace(/.*?(標記|記下|註記)/, '') };
    }
    if (/跳過|略過|不用派|這條不派/.test(t)) return { cmd: 'skip' };
    if (/重新(規劃|計算|安排)|重算|重新導航/.test(t)) return { cmd: 'reroute' };
    if (/重複|再說|再講|剛剛說什麼|再一次/.test(t)) return { cmd: 'repeat' };
    if (/進度|剩多少|還剩|剩下|多遠/.test(t)) return { cmd: 'progress' };
    if (/暫停|停一下|安靜|先停/.test(t)) return { cmd: 'pause' };
    if (/繼續|開始|恢復/.test(t)) return { cmd: 'resume' };
    if (/結束|收工/.test(t)) return { cmd: 'stop' };
    return { cmd: 'unknown', text: t };
  }

  // 依說出的地點找座標：門牌 → 巷弄/路名
  function resolvePlace(net, text, near) {
    const t = norm(text).replace(/^(在|於)/, '');
    const m = t.match(/^(.*?)(\d+(?:之\d+)?)號/);
    if (m && net.addrs.length) {
      const street = normRoad(m[1]), num = m[2];
      let best = null;
      for (const a of net.addrs) {
        const hn = norm(a.h).replace(/號$/, '');
        const st = normRoad(a.s || '');
        const full = st + hn;
        const want = street + num;
        let ok = false;
        if (street) ok = full === want || full.endsWith(want) || (hn === num && st && (st.endsWith(street) || street.endsWith(st)));
        else ok = hn === num;
        if (!ok) continue;
        const d = near ? dist(near, [a.lat, a.lon]) : 0;
        if (!street && d > 400) continue;
        if (!best || d < best.d) best = { d, p: [a.lat, a.lon], label: (a.s || '') + a.h + (a.h.endsWith('號') ? '' : '號') };
      }
      if (best) return { p: best.p, label: best.label, kind: 'addr' };
      // 找不到這個號碼：用同一條街、同單雙號的門牌內插位置
      const want = parseInt(num, 10);
      if (street && !isNaN(want)) {
        const same = [];
        for (const a of net.addrs) {
          const st = normRoad(a.s || ''); if (!st || !(st.endsWith(street) || street.endsWith(st))) continue;
          const h = parseInt(norm(a.h), 10); if (isNaN(h) || h % 2 !== want % 2) continue;
          same.push({ h, p: [a.lat, a.lon] });
        }
        if (same.length) {
          let lo = null, hi = null;
          for (const x of same) { if (x.h <= want && (!lo || x.h > lo.h)) lo = x; if (x.h >= want && (!hi || x.h < hi.h)) hi = x; }
          let pt = null;
          if (lo && hi && hi.h !== lo.h && dist(lo.p, hi.p) < 600) { const f = (want - lo.h) / (hi.h - lo.h); pt = [lo.p[0] + (hi.p[0] - lo.p[0]) * f, lo.p[1] + (hi.p[1] - lo.p[1]) * f]; }
          else { const x = lo && hi ? (want - lo.h <= hi.h - want ? lo : hi) : (lo || hi); if (Math.abs(x.h - want) <= 30) pt = x.p; }
          if (pt) return { p: pt, label: m[1] + num + '號附近', kind: 'addr-est' };
        }
      }
    }
    // 路名 / 巷弄
    const tt = normRoad(t.replace(/(\d+(?:之\d+)?)號.*$/, ''));
    let bestName = '';
    for (const c of net.chains) {
      if (!c.name) continue;
      const nm = normRoad(c.name);
      if (nm.length > bestName.length && tt.includes(nm)) bestName = nm;
    }
    if (bestName) {
      const corner = /口/.test(t);
      let best = null;
      for (const c of net.chains) {
        if (normRoad(c.name) !== bestName) continue;
        if (corner) {
          for (const [v, pt] of [[c.ia, c.coords[0]], [c.ib, c.coords[c.coords.length - 1]]]) {
            if (net.adj[v].length < 3) continue;
            const d = near ? dist(near, pt) : 0;
            if (!best || d < best.d) best = { d, p: pt };
          }
        } else {
          for (let k = 1; k < c.coords.length; k++) {
            const pr = near ? projSeg(near, c.coords[k - 1], c.coords[k]) : { d: 0, q: c.coords[0] };
            if (!best || pr.d < best.d) best = { d: pr.d, p: pr.q };
          }
        }
      }
      if (best) return { p: best.p, label: bestName + (corner ? '口' : ''), kind: 'street' };
    }
    return null;
  }

  return {
    dist, bearing, angDiff, projSeg, pointInPoly, polyLength, pointAlong, bbox, norm, normRoad, cnToNum,
    buildNetwork, nearestChain, chainsNear, markVisits, dijkstra, planRoute, expandRoute, buildManeuvers,
    nearestJunction, itemFlyers, selectLoop, suggestPark, planLoops, junctionLabel, nearestAddr, routeBetween,
    pointAtRoute, createTracker, trackUpdate, trackRelocate, parseCommand, resolvePlace,
  };
})();
if (typeof module !== 'undefined') module.exports = Core;
