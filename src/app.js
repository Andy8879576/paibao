(() => {
  'use strict';
  const C = Core;
  const APP_VERSION = '1.7.1', APP_DATE = '2026-11-26';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  /* ---------- 儲存 ---------- */
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('pb_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('pb_' + k, JSON.stringify(v)); return true; } catch (e) { toast('手機儲存空間不夠，這筆資料沒有存起來'); return false; } },
    del(k) { try { localStorage.removeItem('pb_' + k); } catch (e) { /* 無 */ } },
  };
  const DEF = { preDist: 30, nearDist: 10, periodic: 0, rate: 1.0, maxAcc: 40, offRoute: 25, returnToStart: false, includePaths: true, showAddr: true, earBtn: false, layer: 'osm', orient: 'heading', cap: 400, density: 10, loopMode: true, twoMode: 'grade', showWC: true, pdr: true, stepLen: 0.65, handsFree: true };
  const S = Object.assign({}, DEF, LS.get('settings', {}));
  const saveSettings = () => LS.set('settings', S);
  // 升級到 1.6：先在手機裡備份一份目前的區塊與進度（不含圖資），再做任何事
  (function backupBeforeUpgrade() {
    // 每次升級前先備份區塊、進度、派報紀錄（不含圖資）；只保留最新的升級前備份，避免占滿空間
    try {
      const tag = 'pb_bak_' + APP_VERSION.replace(/\./g, '');
      if (!localStorage.getItem(tag)) {
        const data = {};
        for (const k of Object.keys(localStorage)) if (k.startsWith('pb_') && !k.startsWith('pb_net_') && !k.startsWith('pb_bak_')) data[k] = localStorage.getItem(k);
        if (Object.keys(data).length) {
          for (const k of Object.keys(localStorage)) if (k.startsWith('pb_bak_') && k !== 'pb_bak_160') localStorage.removeItem(k);
          localStorage.setItem(tag, JSON.stringify({ t: Date.now(), from: 'before v' + APP_VERSION, data }));
        }
      }
    } catch (e) { /* 空間不足就略過 */ }
    // 請瀏覽器不要自動清掉資料
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* 無 */ }
    // 直走時定時提醒：舊設定是 0 的改成每 30 秒說「繼續前進」
    if (!S._v || S._v < 160) { if (!S.periodic) S.periodic = 30; S._v = 160; saveSettings(); }
  })();

  const MARK = {
    refuse: { icon: '🚫', label: '拒收廣告', say: '這戶拒收廣告，不要投' },
    nobox: { icon: '📭', label: '沒有信箱', say: '這戶沒有信箱' },
    dog: { icon: '🐕', label: '有狗', say: '注意，這戶有狗' },
    other: { icon: '📌', label: '其他', say: '這裡有註記' },
  };

  const st = {
    blocks: LS.get('blocks', []),
    marks: LS.get('marks', []),
    block: null, net: null,
    covered: new Set(), skipped: new Set(), hits: new Map(),
    mode: 'idle', follow: true,
  };
  const gps = { raw: null, fix: null, kf: null, corr: null, hist: [], bear: null, speed: 0, watch: null, lastGood: 0 };
  let nav = null;

  /* ---------- 小工具 ---------- */
  let toastT;
  function toast(msg, ms = 2800) {
    const t = $('#toast'); t.textContent = msg; t.style.display = 'block';
    clearTimeout(toastT); toastT = setTimeout(() => (t.style.display = 'none'), ms);
  }
  function busy(on, text) { $('#busy').style.display = on ? 'flex' : 'none'; if (text) $('#busyText').textContent = text; }
  const nextFrame = () => new Promise(r => setTimeout(r, 30));
  const r5 = d => Math.max(5, Math.round(d / 5) * 5);
  const r10 = d => Math.max(10, Math.round(d / 10) * 10);
  const fmtDist = m => m >= 1000 ? (m / 1000).toFixed(1) + ' 公里' : Math.round(m) + ' 公尺';
  const sayDist = m => m >= 1000 ? (m / 1000).toFixed(1) + '公里' : r10(m) + '公尺';
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function setMode(m) {
    st.mode = m;
    document.body.className = 'mode-' + m;
    map.getContainer().style.cursor = (m === 'draw' || m === 'pick' || m === 'edit') ? 'crosshair' : '';
    if (typeof updateHeading === 'function') updateHeading(true);
  }

  /* ---------- 地圖 ---------- */
  const map = L.map('map', { zoomControl: false, preferCanvas: true, maxZoom: 21, attributionControl: true, rotate: true, bearing: 0, rotateControl: false, touchRotate: false, shiftKeyRotate: false, compassBearing: false }).setView([25.0137, 121.4627], 16);
  const canRotate = typeof map.setBearing === 'function' && !!map._rotate;
  const tiles = {
    osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap 貢獻者' }),
    emap: L.tileLayer('https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 19, attribution: '© 內政部國土測繪中心' }),
    photo: L.tileLayer('https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 19, attribution: '© 內政部國土測繪中心' }),
  };
  let curTile = null;
  function setLayer(k) {
    if (!tiles[k]) k = 'osm';
    if (curTile) map.removeLayer(curTile);
    curTile = tiles[k].addTo(map); curTile.bringToBack();
    S.layer = k; saveSettings();
    $$('#layerBtns .btn').forEach(b => b.classList.toggle('primary', b.dataset.layer === k));
  }
  const cv = L.canvas({ padding: 0.4 });
  // 上次路徑、分圈預覽畫在街道上面（放在會跟著旋轉的圖層裡）
  map.createPane('topLines', map._rotatePane || undefined); map.getPane('topLines').style.zIndex = 450; map.getPane('topLines').style.pointerEvents = 'none';
  const cvTop = L.canvas({ pane: 'topLines', padding: 0.4 });
  const L_blocks = L.layerGroup().addTo(map);
  const L_net = L.layerGroup().addTo(map);
  const L_route = L.layerGroup().addTo(map);
  const L_addr = L.layerGroup().addTo(map);
  const L_marks = L.layerGroup().addTo(map);
  const L_draw = L.layerGroup().addTo(map);
  const L_me = L.layerGroup().addTo(map);
  let chainLines = [];

  map.on('dragstart', () => { if (st.follow) { st.follow = false; $('#fabFollow').classList.remove('on'); } });

  /* ---------- 區塊 ---------- */
  function saveBlocks() { LS.set('blocks', st.blocks); }
  function renderBlocks() {
    L_blocks.clearLayers();
    for (const b of st.blocks) {
      if (!b.show) continue;
      if (st.mode === 'bedit' && st.block && b.id === st.block.id) continue; // 修改中：只顯示編輯中的框
      const cur = st.block && st.block.id === b.id;
      L.polygon(b.poly, { renderer: cv, color: cur ? '#1F4E9E' : '#56657A', weight: cur ? 3 : 2, dashArray: '8 6', fillColor: '#1F4E9E', fillOpacity: cur ? 0.05 : 0.02, interactive: false }).addTo(L_blocks);
    }
    $('#blockName').textContent = st.block ? st.block.name + (st.net ? '　' + pct() + '%' : '') : '還沒有區塊';
  }
  function reqChains() { return st.net ? st.net.chains.filter(c => c.req) : []; }
  // 舊版整條標「已派」（key）視為兩邊都派完，保留原本的進度
  function sideDone(c, sd) { return st.covered.has(c.key) || st.skipped.has(c.key) || st.covered.has(c.key + ':' + sd); }
  function isDone(c) {
    if (st.covered.has(c.key) || st.skipped.has(c.key)) return true;
    return c.two ? sideDone(c, 'f') && sideDone(c, 'b') : false;
  }
  function itemKey(it) { const c = st.net.chains[it.c]; return c.key + (it.side ? ':' + it.side : ''); }
  function itemDone(it) { const c = st.net.chains[it.c]; return it.side ? sideDone(c, it.side) : isDone(c); }
  function markItem(it) {
    const c = st.net.chains[it.c];
    if (itemDone(it)) return false;
    st.covered.add(it.side ? c.key + ':' + it.side : c.key);
    return true;
  }
  // 還沒派的項目：小巷一整條（兩邊一次）；大馬路每一邊各一項
  function remainingItems() {
    const out = [];
    for (const c of reqChains()) {
      if (st.skipped.has(c.key) || st.covered.has(c.key)) continue;
      if (c.two) { for (const sd of ['f', 'b']) if (!sideDone(c, sd)) out.push({ c: c.i, side: sd }); }
      else out.push({ c: c.i, side: null });
    }
    return out;
  }
  // 平均分圈：例如剩 312 張、每趟最多 150 張 → 分 3 圈、每圈約 104 張
  function evenCap(items, cap) {
    const left = flyersOf(items);
    if (!cap || left <= cap * 1.1) return cap ? Math.max(cap, left * 1.02) : 0;
    return Math.min(cap, left / Math.ceil(left / cap) * 1.08);
  }
  function flyersOf(items) { return items.reduce((a, it) => a + C.itemFlyers(st.net, it, S.density), 0); }
  function progressNums() {
    let all = 0, done = 0;
    for (const c of reqChains()) {
      if (c.two) { all += c.len * 2; done += (sideDone(c, 'f') ? c.len : 0) + (sideDone(c, 'b') ? c.len : 0); }
      else { all += c.len * 2; if (isDone(c)) done += c.len * 2; }
    }
    return { all, done, left: all - done };
  }
  function pct() { const p = progressNums(); return p.all ? Math.floor((p.done / p.all) * 100) : 0; }
  let progT;
  function saveProgress(now) {
    if (!st.block) return;
    const go = () => LS.set('prog_' + st.block.id, { c: [...st.covered], s: [...st.skipped] });
    clearTimeout(progT);
    if (now) go(); else progT = setTimeout(go, 3000);
  }
  function loadProgress() {
    const p = LS.get('prog_' + st.block.id, { c: [], s: [] });
    st.covered = new Set(p.c); st.skipped = new Set(p.s); st.hits = new Map();
  }

  function selectBlock(id, fit = true) {
    const b = st.blocks.find(x => x.id === id);
    if (!b) return;
    st.block = b; b.show = true; saveBlocks();
    LS.set('curBlock', id);
    loadProgress();
    const raw = LS.get('net_' + id, null);
    st.net = raw ? buildNet(raw, b) : null;
    renderBlocks(); renderNet(); renderAddrs(); renderWC(); renderPhotos();
    L_rec.clearLayers(); $('#fabRec').style.display = 'none'; sess = null;
    if (fit) map.fitBounds(L.latLngBounds(b.poly), { padding: [30, 30] });
    if (!raw) downloadNet();
    else if (S.showWC && !wcList()) fetchWC(b, true);
  }
  // 建立路網，並套用使用者對個別街道的「加入／排除」
  function buildNet(raw, b, poly) {
    const net = C.buildNetwork(raw, poly || b.poly, { includePaths: S.includePaths, twoMode: S.twoMode });
    const inc = new Set(b.inc || []), exc = new Set(b.exc || []), two = new Set(b.two || []), one = new Set(b.one || []);
    for (const c of net.chains) {
      if (c.virtual) continue;
      if (exc.has(c.key)) c.req = false;
      else if (inc.has(c.key)) c.req = true;
      if (two.has(c.key)) c.two = true;
      else if (one.has(c.key)) c.two = false;
    }
    return net;
  }
  function createBlock(poly, name) {
    const b = { id: uid(), name: name || '區塊 ' + (st.blocks.length + 1), poly, show: true, t: Date.now() };
    st.blocks.push(b); saveBlocks();
    selectBlock(b.id);
  }
  function deleteBlock(id) {
    const gone = st.blocks.find(b => b.id === id);
    if (gone) { const arch = LS.get('archived', []); arch.push(Object.assign({}, gone, { deletedAt: Date.now() })); LS.set('archived', arch); }
    st.blocks = st.blocks.filter(b => b.id !== id); saveBlocks();
    for (const k of ['net_', 'prog_', 'wc_', 'sess_']) LS.del(k + id); // 派報紀錄、照片保留，不刪
    if (st.block && st.block.id === id) { st.block = null; st.net = null; LS.del('curBlock'); renderNet(); renderAddrs(); }
    renderBlocks();
  }

  /* ---------- 下載圖資（OpenStreetMap / Overpass） ---------- */
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
  async function downloadNet() {
    const b = st.block; if (!b) return;
    const [s, w, n, e] = C.bbox(b.poly, 200);
    const pl = b.poly.map(p => p[0].toFixed(6) + ' ' + p[1].toFixed(6)).join(' ');
    const q = `[out:json][timeout:90];way["highway"](${s},${w},${n},${e})->.r;.r out body;node(w.r);out skel qt;nwr["addr:housenumber"](poly:"${pl}");out center tags;`;
    busy(true, '下載街道和門牌資料中…');
    let data = null, lastErr = '';
    for (const url of OVERPASS) {
      try {
        const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 60000);
        const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
        clearTimeout(tm);
        if (!res.ok) { lastErr = '伺服器回應 ' + res.status; continue; }
        data = await res.json(); break;
      } catch (err) { lastErr = err.name === 'AbortError' ? '連線逾時' : '網路連不上'; }
    }
    busy(false);
    if (!data) { toast('下載圖資失敗（' + lastErr + '）。確認網路後，到「我的區塊」按「重新下載圖資」。', 5000); return; }
    const raw = { nodes: {}, ways: [], addrs: [] };
    for (const el of data.elements) {
      if (el.type === 'node' && el.lat != null) raw.nodes[el.id] = [+el.lat.toFixed(7), +el.lon.toFixed(7)];
      const t = el.tags;
      if (!t) continue;
      if (el.type === 'way' && t.highway && el.nodes) raw.ways.push({ id: el.id, n: el.nodes, name: t.name || t['name:zh'] || '', hw: t.highway, svc: t.service, fw: t.footway });
      if (t['addr:housenumber']) {
        const lat = el.lat != null ? el.lat : el.center && el.center.lat, lon = el.lon != null ? el.lon : el.center && el.center.lon;
        if (lat != null) raw.addrs.push({ lat: +lat.toFixed(7), lon: +lon.toFixed(7), s: t['addr:street'] || t['addr:place'] || '', h: t['addr:housenumber'] });
      }
    }
    if (st.block !== b) return;
    LS.set('net_' + b.id, raw);
    b.dl = C.bbox(b.poly, 200); saveBlocks();
    st.net = buildNet(raw, b);
    renderNet(); renderAddrs(); renderBlocks();
    const nReq = reqChains().length;
    if (!nReq) toast('這個區塊裡找不到街道。試著把框框畫大一點。', 4500);
    else toast(`載入完成：${nReq} 段街道、${raw.addrs.length} 個門牌`);
    if (S.showWC) fetchWC(b, true);
  }

  /* ---------- 路網顯示 ---------- */
  function chainStyle(c) {
    if (!c.req) return { color: '#7D8796', weight: 2, opacity: 0.45, dashArray: null };
    if (st.covered.has(c.key)) return { color: '#2E9E5B', weight: 5, opacity: 0.9, dashArray: null };
    if (st.skipped.has(c.key)) return { color: '#AEB6C1', weight: 4, opacity: 0.9, dashArray: '4 7' };
    return { color: '#F28C28', weight: 5, opacity: 0.92, dashArray: null };
  }
  const RED = '#D7263D', BLACK = '#1E242C', TODO = '#F28C28';
  function sideStyle(c, sd) {
    if (!c.req) return { color: '#7D8796', weight: 2, opacity: 0.45, dashArray: null };
    if (st.skipped.has(c.key)) return { color: '#AEB6C1', weight: 3, opacity: 0.9, dashArray: '4 7' };
    if (sideDone(c, sd)) return { color: (sd === 'f') === c.fShun ? RED : BLACK, weight: 4, opacity: 0.95, dashArray: null };
    return { color: TODO, weight: 4, opacity: 0.92, dashArray: null };
  }
  function chainLayer(c) {
    if (c.two && c.req) {
      const px = map.getZoom() >= 18 ? 5 : map.getZoom() >= 16 ? 3.5 : 2.5;
      const g = L.layerGroup();
      L.polyline(c.coords, { renderer: cv, interactive: false, color: '#fff', weight: 2, opacity: 0.8 }).addTo(g);
      L.polyline(offsetLine(c.coords, px), Object.assign({ renderer: cv, interactive: false, lineCap: 'butt' }, sideStyle(c, 'f'))).addTo(g);
      L.polyline(offsetLine(c.coords, -px), Object.assign({ renderer: cv, interactive: false, lineCap: 'butt' }, sideStyle(c, 'b'))).addTo(g);
      return g;
    }
    return L.polyline(c.coords, Object.assign({ renderer: cv, interactive: false, lineCap: 'round' }, chainStyle(c)));
  }
  function renderNet() {
    L_net.clearLayers(); chainLines = [];
    if (!st.net) return;
    for (const c of st.net.chains) if (!c.virtual) chainLines[c.i] = chainLayer(c).addTo(L_net);
  }
  function restyle(ci) {
    const c = st.net.chains[ci]; if (!c || !chainLines[ci]) return;
    if (c.two && c.req || chainLines[ci] instanceof L.LayerGroup) { L_net.removeLayer(chainLines[ci]); chainLines[ci] = chainLayer(c).addTo(L_net); }
    else chainLines[ci].setStyle(chainStyle(c));
  }
  map.on('zoomend', () => { if (st.net && st.net.chains.some(c => c.two && c.req)) renderNet(); });

  // 門牌號碼（放大時顯示）
  function renderAddrs() {
    L_addr.clearLayers();
    if (!S.showAddr || !st.net || map.getZoom() < 18) return;
    const bd = map.getBounds().pad(0.1); let n = 0;
    for (const a of st.net.addrs) {
      if (!bd.contains([a.lat, a.lon])) continue;
      if (++n > 300) break;
      const h = String(a.h).replace(/號$/, '');
      L.marker([a.lat, a.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', html: `<span class="hn">${esc(h)}</span>`, iconSize: [0, 0] }) }).addTo(L_addr);
    }
  }
  map.on('moveend zoomend', renderAddrs);

  /* ---------- 標記 ---------- */
  function renderMarks() {
    L_marks.clearLayers();
    for (const m of st.marks) {
      const k = MARK[m.type] || MARK.other;
      const mk = L.marker([m.lat, m.lon], { icon: L.divIcon({ className: '', html: `<div class="mk">${k.icon}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(L_marks);
      mk.bindPopup(`<b>${k.label}</b>${m.note ? '<br>' + esc(m.note) : ''}<br><button class="btn sm danger" data-delmark="${m.id}" style="margin-top:8px">刪除這個標記</button>`);
    }
  }
  document.addEventListener('click', e => {
    const id = e.target && e.target.dataset && e.target.dataset.delmark;
    if (!id) return;
    st.marks = st.marks.filter(m => m.id !== id); LS.set('marks', st.marks); renderMarks(); map.closePopup(); toast('標記已刪除');
  });
  function addMark(type, note) {
    const p = gps.fix ? [gps.fix.lat, gps.fix.lon] : [map.getCenter().lat, map.getCenter().lng];
    st.marks.push({ id: uid(), lat: p[0], lon: p[1], type, note: note || '', t: Date.now() });
    LS.set('marks', st.marks); renderMarks();
    const msg = '已標記：' + (MARK[type] || MARK.other).label;
    toast(msg); if (nav) say(msg);
    if (nav) nav.markSaid.add(st.marks[st.marks.length - 1].id);
  }

  /* ---------- 我的位置 ---------- */
  /* ---------- 地圖方向：固定小藍點（前進方向朝上）／固定地圖（北方朝上） ---------- */
  let mapBear = 0, wantBear = 0, rafOn = false, compass = null, compassAsked = false, lastCompassUpd = 0;
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function headingActive() {
    return canRotate && S.orient === 'heading' && st.follow && (st.mode === 'idle' || st.mode === 'nav' || st.mode === 'pick');
  }
  // 目前前進方向（地理方位，0 = 北）
  function currentHeading() {
    if (nav && nav.route && !nav.far && nav.tr) {
      const r = nav.route, s = Math.min(nav.tr.s, r.total - 1);
      const a = C.pointAtRoute(r, s), b = C.pointAtRoute(r, Math.min(r.total, s + 6));
      if (C.dist(a, b) > 1.5 && !(nav.tr.offCount > 0)) return C.bearing(a, b);
    }
    if (gps.bear != null && gps.speed > 0.6) return gps.bear;
    if (compass && Date.now() - compass.t < 3000) return compass.h;
    return gps.bear;
  }
  function updateHeading(force) {
    if (!canRotate) return;
    let target;
    if (headingActive()) {
      const h = currentHeading(); if (h == null) return;
      target = -h;
    } else if (S.orient !== 'heading' || st.mode === 'draw' || st.mode === 'edit' || st.mode === 'bedit') target = 0;
    else return; // 手動拖過地圖：維持目前角度
    const diff = Math.abs(((target - wantBear) % 360 + 540) % 360 - 180);
    if (!force && diff < 3) return;
    wantBear = target;
    if (reduceMotion) { mapBear = wantBear; map.setBearing(mapBear); updateNeedle(); return; }
    if (!rafOn) { rafOn = true; requestAnimationFrame(stepBear); }
  }
  function stepBear() {
    const d = ((wantBear - mapBear) % 360 + 540) % 360 - 180;
    if (Math.abs(d) < 0.4) { mapBear = wantBear; rafOn = false; }
    else mapBear += d * 0.2;
    map.setBearing(mapBear); updateNeedle();
    if (rafOn) requestAnimationFrame(stepBear);
  }
  function updateNeedle() {
    const n = $('#needle'); if (n) n.style.transform = `rotate(${canRotate ? mapBear : 0}deg)`;
    updateRose();
  }
  // 八方羅盤：外圈跟著地圖轉（北永遠指向真正的北方），箭頭是前進方向
  function updateRose() {
    const b = canRotate ? mapBear : 0, h = currentHeading();
    const g0 = $('#roseG'); if (!g0) return;
    g0.setAttribute('transform', `rotate(${b})`);
    $$('#roseG text').forEach(t => t.setAttribute('transform', `rotate(${-b} ${t.getAttribute('x')} ${t.getAttribute('y')})`));
    const ar = $('#roseArrow');
    if (h == null) { ar.style.display = 'none'; $('#roseTxt').textContent = '方向未知'; return; }
    ar.style.display = ''; ar.setAttribute('transform', `rotate(${h + b})`);
    $('#roseTxt').textContent = '朝' + C.cardinal(h) + ' ' + Math.round((h + 360) % 360) + '°';
  }
  function applyOrient(say) {
    const h = S.orient === 'heading' && canRotate;
    $('#orientTxt').textContent = h ? '前朝上' : '北朝上';
    $('#fabOrient').classList.toggle('on', h);
    if (h) { st.follow = true; $('#fabFollow').classList.add('on'); if (gps.fix) map.panTo([gps.fix.lat, gps.fix.lon]); }
    updateHeading(true);
    if (say) toast(h ? '固定小藍點：前進方向朝上' : '固定地圖：北方朝上');
  }
  // 指南針（站著不動時用來判斷方向；iPhone 要在按按鈕時取得授權）
  function enableCompass() {
    if (compassAsked || !window.DeviceOrientationEvent) return;
    compassAsked = true;
    const add = () => window.addEventListener('deviceorientation', onOrient, true);
    if (typeof DeviceOrientationEvent.requestPermission === 'function') DeviceOrientationEvent.requestPermission().then(r => { if (r === 'granted') add(); }).catch(() => {});
    else add();
  }
  function onOrient(e) {
    let h = null;
    if (e.webkitCompassHeading != null && !isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) h = (360 - e.alpha) % 360;
    if (h == null) return;
    const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    compass = { h: (h + so + 360) % 360, t: Date.now() };
    if (Date.now() - lastCompassUpd > 250) { lastCompassUpd = Date.now(); updateHeading(); if (meMarker) drawMeCone(); }
  }
  function drawMeCone() {
    updateRose();
    const el = meMarker && meMarker.getElement(); if (!el) return;
    const cone = el.querySelector('.cone'), hb = currentHeading();
    cone.style.display = hb == null ? 'none' : 'block';
    if (hb != null) cone.style.transform = `rotate(${hb}deg)`;
  }

  let meMarker = null, accCircle = null;
  function drawMe() {
    const f = gps.fix; if (!f) return;
    const ll = [f.lat, f.lon];
    if (!meMarker) {
      accCircle = L.circle(ll, { renderer: cv, radius: f.acc, color: '#2B7BE4', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(L_me);
      meMarker = L.marker(ll, { interactive: false, keyboard: false, rotateWithView: true, zIndexOffset: 2000, icon: L.divIcon({ className: '', html: '<div class="me"><div class="cone"></div></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(L_me);
    }
    meMarker.setLatLng(ll); accCircle.setLatLng(ll); accCircle.setRadius(f.acc);
    const el = meMarker.getElement();
    if (el) {
      const dot = el.querySelector('.me'), cone = el.querySelector('.cone');
      dot.classList.toggle('fixed', !!gps.corr);
      const hb = currentHeading();
      cone.style.display = hb == null ? 'none' : 'block';
      if (hb != null) cone.style.transform = `rotate(${hb}deg)`;
    }
    if (st.follow) map.panTo(ll, { animate: true, duration: 0.4 });
    updateHeading();
  }
  function setPill(cls, text) {
    const p = $('#gpsPill'); p.className = 'pill ' + cls + (gps.corr ? ' fixed' : '');
    p.querySelector('span').textContent = text + (gps.corr ? '・已修正' : '');
  }

  /* ---------- GPS ---------- */
  function startGPS() {
    if (!navigator.geolocation) { setPill('bad', '這支手機無法定位'); return; }
    if (gps.watch != null) navigator.geolocation.clearWatch(gps.watch);
    gps.watch = navigator.geolocation.watchPosition(onFix, onGpsErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }
  function onGpsErr(err) {
    if (err.code === 1) setPill('bad', '沒有定位權限');
    else setPill('bad', 'GPS 訊號弱');
    if (err.code === 1) toast('請到「設定 › 隱私權 › 定位服務 › Safari 網站」允許使用位置。', 6000);
  }
  function onFix(p) {
    const c = p.coords, t = Date.now();
    let lat = c.latitude, lon = c.longitude;
    const acc = Math.max(3, c.accuracy || 50);
    gps.raw = { lat, lon, acc, t };
    if (gps.corr) {
      if (t - gps.corr.t > 6 * 60e3 || C.dist([lat, lon], [gps.corr.rlat, gps.corr.rlon]) > 300) { gps.corr = null; toast('位置修正已用完，改回 GPS'); }
      else { lat += gps.corr.dLat; lon += gps.corr.dLon; }
    }
    if (acc > S.maxAcc && gps.fix && t - gps.lastGood < 20000) { setPill('bad', `GPS 誤差 ${Math.round(acc)} 公尺`); return; }
    gps.lastGood = t;
    // 簡易卡爾曼濾波：減少飄移
    const k = gps.kf;
    if (!k || t - k.t > 30000 || gps.corr && gps.corr.fresh) {
      gps.kf = { lat, lon, v: acc * acc, t };
      if (gps.corr) gps.corr.fresh = false;
    } else {
      const dt = Math.max(0.2, (t - k.t) / 1000);
      const spd = c.speed != null && c.speed >= 0 ? c.speed : gps.speed;
      k.v += dt * (8 + 6 * spd * spd);
      const K = k.v / (k.v + acc * acc);
      k.lat += K * (lat - k.lat); k.lon += K * (lon - k.lon); k.v *= (1 - K); k.t = t;
    }
    const f = { lat: gps.kf.lat, lon: gps.kf.lon, acc: Math.sqrt(gps.kf.v), t };
    // 行進方向與速度
    gps.hist.push(f); while (gps.hist.length > 30) gps.hist.shift();
    let ref = null;
    for (let i = gps.hist.length - 2; i >= 0; i--) {
      const h = gps.hist[i]; if (t - h.t > 15000) break;
      if (C.dist([h.lat, h.lon], [f.lat, f.lon]) >= 6) { ref = h; break; }
    }
    if (ref) { gps.bear = C.bearing([ref.lat, ref.lon], [f.lat, f.lon]); gps.speed = C.dist([ref.lat, ref.lon], [f.lat, f.lon]) / Math.max(1, (t - ref.t) / 1000); }
    else if (c.heading != null && !isNaN(c.heading) && c.speed > 0.5) { gps.bear = c.heading; gps.speed = c.speed; }
    else gps.speed = c.speed != null && c.speed >= 0 ? c.speed : 0;
    gps.fix = f;
    setPill(acc <= 10 ? 'good' : acc <= 25 ? 'mid' : 'bad', `GPS ±${Math.round(acc)} 公尺`);
    drawMe();
    if (nav) navTick();
  }
  function waitFix(ms) {
    return new Promise(res => {
      if (gps.fix && Date.now() - gps.fix.t < 15000) return res(gps.fix);
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (gps.fix && Date.now() - gps.fix.t < 15000) { clearInterval(iv); res(gps.fix); }
        else if (Date.now() - t0 > ms) { clearInterval(iv); res(null); }
      }, 300);
    });
  }
  // 手動修正位置
  function applyCorrection(p, label) {
    const r = gps.raw;
    if (r) gps.corr = { dLat: p[0] - r.lat, dLon: p[1] - r.lon, t: Date.now(), rlat: r.lat, rlon: r.lon, fresh: true };
    gps.kf = { lat: p[0], lon: p[1], v: 25, t: Date.now() };
    gps.fix = { lat: p[0], lon: p[1], acc: 5, t: Date.now() };
    gps.hist = [gps.fix];
    st.follow = true; $('#fabFollow').classList.add('on');
    drawMe(); setPill('good', 'GPS');
    const msg = '位置已修正' + (label ? '到' + label : '');
    toast(msg);
    if (nav) {
      say(msg);
      const b = C.trackRelocate(nav.tr, p);
      if (!b || b.d > 30) reroute('重新規劃路線');
      else navTick(true);
    }
  }
  async function correctByText(text) {
    if (!text) return;
    const near = gps.fix ? [gps.fix.lat, gps.fix.lon] : [map.getCenter().lat, map.getCenter().lng];
    let r = st.net ? C.resolvePlace(st.net, text, near) : null;
    if (!r) {
      try {
        const [s, w, n, e] = st.block ? C.bbox(st.block.poly, 800) : [near[0] - 0.02, near[1] - 0.02, near[0] + 0.02, near[1] + 0.02];
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=tw&accept-language=zh-TW&bounded=1&viewbox=${w},${n},${e},${s}&q=${encodeURIComponent(text)}`;
        const res = await fetch(url); const js = await res.json();
        if (js && js[0]) r = { p: [+js[0].lat, +js[0].lon], label: text };
      } catch (err) { /* 沒網路 */ }
    }
    if (!r) { const m = '找不到「' + text + '」，請換個說法，或在地圖上點選'; toast(m, 4000); if (nav) say(m); return false; }
    applyCorrection(r.p, r.label);
    return true;
  }

  /* ---------- 語音播報 ---------- */
  const tts = { voice: null, ok: 'speechSynthesis' in window };
  function pickVoice() {
    if (!tts.ok) return;
    const vs = speechSynthesis.getVoices();
    tts.voice = vs.find(v => /zh[-_]TW/i.test(v.lang)) || vs.find(v => /zh[-_](Hant|HK)/i.test(v.lang)) || vs.find(v => /^zh/i.test(v.lang)) || null;
  }
  if (tts.ok) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  let capT;
  const spoke = { text: '', until: 0 };
  function say(text, opt = {}) {
    if (!text) return;
    const cap = $('#caption'); cap.querySelector('span').textContent = text; cap.style.display = 'flex';
    clearTimeout(capT); capT = setTimeout(() => (cap.style.display = 'none'), Math.max(3500, text.length * 260));
    if (nav && !opt.noLast) nav.lastSaid = text;
    if (nav) nav.lastSpeak = Date.now();
    if (!tts.ok) return;
    if (opt.queue !== true) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-TW'; if (tts.voice) u.voice = tts.voice; u.rate = S.rate; u.volume = 1;
    spoke.text = text; spoke.until = Date.now() + 1500 + text.length * 250;
    u.onend = () => { spoke.until = Date.now() + 700; };
    speechSynthesis.speak(u);
  }
  function beep(freq = 880, ms = 120) {
    try {
      const ac = beep.ac || (beep.ac = new (window.AudioContext || window.webkitAudioContext)());
      if (ac.state === 'suspended') ac.resume();
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = freq; g.gain.value = 0.15; o.connect(g); g.connect(ac.destination);
      o.start(); o.stop(ac.currentTime + ms / 1000);
    } catch (e) { /* 無 */ }
  }

  /* ---------- 螢幕常亮 ---------- */
  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); } }
    catch (e) { toast('無法自動保持螢幕常亮，請到「設定 › 螢幕顯示與亮度 › 自動鎖定」改成「永不」', 6000); }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && nav) { keepAwake(); if (gps.watch == null) startGPS(); }
  });

  /* ---------- 耳機按鍵（試驗） ---------- */
  let silent = null;
  function silentWavUrl() {
    const sr = 8000, n = sr, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  function setupEarButtons(on) {
    if (!on || !('mediaSession' in navigator)) { if (silent) { silent.pause(); } return; }
    if (!silent) { silent = new Audio(silentWavUrl()); silent.loop = true; }
    silent.play().catch(() => {});
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({ title: '派報系統導航中', artist: '派報系統' });
    const keep = () => { silent.play().catch(() => {}); ms.playbackState = 'playing'; };
    ms.setActionHandler('play', () => { keep(); doCmd({ cmd: 'repeat' }); });
    ms.setActionHandler('pause', () => { keep(); doCmd({ cmd: 'repeat' }); });
    try { ms.setActionHandler('previoustrack', () => { keep(); doCmd({ cmd: 'repeat' }); }); } catch (e) { /* 無 */ }
    try { ms.setActionHandler('nexttrack', () => { keep(); if (cam.on) shoot(); else listen(); }); } catch (e) { /* 無 */ }
  }

  /* ---------- 導航 ---------- */
  // 「開始派報」：先問這趟帶幾張
  function startNav() {
    if (!st.block) { toast('先圈選或選擇一個區塊'); openSheet('shBlocks'); return; }
    if (!st.net) { toast('這個區塊還沒有圖資，正在重新下載'); downloadNet(); return; }
    const items = remainingItems();
    if (!items.length) { askCompleteBlock(true); return; }
    $('#stCap').value = S.cap || 400;
    $('#stLoop').checked = S.loopMode !== false;
    updateStartInfo();
    openSheet('shStart');
  }
  function updateStartInfo() {
    if (!st.net) return;
    const left = flyersOf(remainingItems()), cap = Math.max(0, parseInt($('#stCap').value, 10) || 0);
    const loop = $('#stLoop').checked;
    $('#stInfo').textContent = `這個區塊還剩約 ${Math.round(left)} 張` + (loop && cap ? `，每趟 ${cap} 張大約要 ${Math.max(1, Math.ceil(left / cap))} 圈。` : '。') + `（以每 100 公尺單邊約 ${S.density} 張估計，派完一圈可以校正。）`;
    $('#stCapRow').style.opacity = loop ? 1 : 0.45;
  }
  async function beginNav(cap, loop) {
    enableCompass(); enableMotion();
    // 在點擊當下啟動語音（iPhone 規定）
    say('準備開始', { noLast: true });
    beep(660, 60);
    setupEarButtons(S.earBtn);
    clearPreview(); clearNext();
    busy(true, '等待 GPS 定位…');
    const f = await waitFix(10000);
    let start;
    if (f) start = [f.lat, f.lon];
    else { const c = map.getCenter(); start = [c.lat, c.lng]; toast('還沒定到位，先用地圖中心當起點', 4000); }
    busy(true, '規劃路線中…'); await nextFrame();
    const items = remainingItems();
    let route, loopInfo = null;
    if (loop) {
      const sel = C.selectLoop(st.net, items, start, evenCap(items, cap), S.density);
      route = C.planRoute(st.net, sel.pick, start, { returnToStart: true, loop: true });
      loopInfo = { park: start, items: sel.pick, flyers: sel.flyers, cap, t0: Date.now(), phase: 'deliver', no: (sessGet().loops.length + 1) };
    } else route = C.planRoute(st.net, items, start, { returnToStart: S.returnToStart });
    busy(false);
    if (!route) { toast('規劃不出路線，請重新下載圖資再試'); return; }
    nav = { route, tr: C.createTracker(route), mi: 0, stepPtr: 0, flags: new Map(), paused: false, lastSpeak: 0, lastReroute: Date.now(), offSince: 0, markSaid: new Set(), lastSaid: '', lastFixT: Date.now(), far: false, lastFarSay: 0, loop: loopInfo };
    setMode('nav'); keepAwake();
    hfStart();
    st.follow = true; $('#fabFollow').classList.add('on');
    if (f) map.setView(start, Math.max(map.getZoom(), 18));
    drawPark();
    drawRoute();
    sessStart();
    const m0 = route.maneuvers[0];
    let intro = loop
      ? `第${loopInfo.no}圈，大約${Math.round(loopInfo.flyers)}張，要走${sayDist(route.total)}，派完會回到停車的地方。`
      : `開始導航，這一趟大約${sayDist(route.total)}。`;
    if (f) { const d0 = C.dist(start, route.coords[0]); if (d0 > 30) intro += `先走到藍線的起點，約${sayDist(d0)}。`; }
    intro += m0.text.replace(/^開始派報，?/, '');
    say(intro);
    if (gps.fix) navTick(true);
    else updateCard(0);
  }
  function stopNav(done) {
    if (!nav) return;
    saveProgress(true); sessSave(true);
    hfStop();
    nav = null; L_route.clearLayers(); L_arrows.clearLayers(); map.removeLayer(L_arrows); sideL = sideR = routeAhead = null;
    L_park.clearLayers();
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    if (silent) silent.pause();
    setMode('idle'); renderBlocks();
    if (!done) toast('已結束導航，進度已存好');
  }
  function loopRemaining() { return nav && nav.loop ? nav.loop.items.filter(it => !itemDone(it)) : []; }
  function useRoute(route) {
    Object.assign(nav, { route, tr: C.createTracker(route), mi: 0, stepPtr: 0, flags: new Map(), lastReroute: Date.now(), offSince: 0 });
    drawRoute();
  }
  function reroute(msg) {
    if (!nav) return;
    const p = gps.fix ? [gps.fix.lat, gps.fix.lon] : nav.route.coords[0];
    let route;
    if (nav.loop) {
      if (nav.loop.phase === 'return') return goBackToPark(msg);
      const items = loopRemaining();
      if (!items.length) return goBackToPark();
      route = C.planRoute(st.net, items, p, { end: nav.loop.park, loop: true });
    } else {
      const items = remainingItems();
      if (!items.length) return finishNav();
      route = C.planRoute(st.net, items, p, { returnToStart: S.returnToStart });
    }
    if (!route) { toast('重新規劃失敗'); return; }
    useRoute(route);
    const m0 = route.maneuvers[0];
    say((msg ? msg + '。' : '') + m0.text.replace(/^開始派報，?/, ''));
    navTick(true);
  }
  // 這一圈派完：走回停車點
  function goBackToPark(msg) {
    const L0 = nav.loop; L0.phase = 'return';
    const p = gps.fix ? [gps.fix.lat, gps.fix.lon] : nav.route.coords[nav.route.coords.length - 1];
    const d = C.dist(p, L0.park);
    if (d < 25) return loopFinished();
    const route = C.routeBetween(st.net, p, L0.park);
    if (!route) { say('這一圈派完了，停車的地方就在附近'); return loopFinished(); }
    useRoute(route);
    say((msg ? msg + '。' : '這一圈派完了，辛苦了。') + `走回停車的地方，大約${sayDist(route.total)}。` + route.maneuvers[0].text.replace(/^往停車的地方走，?/, ''));
    navTick(true);
  }
  function finishNav() {
    if (!nav) return;
    say('恭喜，這個區塊全部派完了，辛苦了！');
    stopNav(true);
    askCompleteBlock(false);
  }
  // 一圈結束：記錄、校正張數、建議下一個停車點
  function loopFinished() {
    const L0 = nav.loop;
    const doneItems = L0.items.filter(it => itemDone(it));
    const sides100 = doneItems.reduce((a, it) => a + st.net.chains[it.c].len * (it.side ? 1 : 2), 0) / 100;
    const est = Math.round(sides100 * S.density);
    const sess = sessGet();
    sess.loops.push({ no: L0.no, park: L0.park, t0: L0.t0, t1: Date.now(), est, cap: L0.cap, sides100 });
    sessSave(true);
    lastLoop = sess.loops[sess.loops.length - 1];
    stopNav(true);
    const rest = remainingItems();
    $('#ldTitle').textContent = `第${L0.no}圈完成`;
    $('#ldInfo').textContent = `這一圈約 ${est} 張，花了 ${Math.round((Date.now() - L0.t0) / 60000)} 分鐘。`;
    $('#ldActual').value = '';
    $('#ldActual').placeholder = '估計 ' + est + ' 張';
    let speech = `第${L0.no}圈完成了，辛苦了。`;
    if (!rest.length) {
      $('#ldNext').textContent = '整個區塊都派完了！';
      $('#ldNextBtns').style.display = 'none'; $('#ldComplete').style.display = '';
      speech += '整個區塊都派完了。';
    } else {
      const sug = C.suggestPark(st.net, rest, L0.park, L0.cap, S.density);
      nextPark = sug;
      if (sug) {
        $('#ldNext').textContent = `下一個建議停車點：${sug.label}，距離約 ${fmtDist(sug.dist)}，那一圈約 ${Math.round(Math.min(sug.flyers, L0.cap))} 張。還剩約 ${Math.round(flyersOf(rest))} 張。`;
        speech += `下一個建議停車點在${sug.label}，大約${sayDist(sug.dist)}。`;
        drawNext(sug);
      } else $('#ldNext').textContent = `還剩約 ${Math.round(flyersOf(rest))} 張。`;
      $('#ldNextBtns').style.display = ''; $('#ldComplete').style.display = 'none';
    }
    say(speech);
    openSheet('shLoopDone');
  }
  // 停車點、下一個停車點
  const L_park = L.layerGroup().addTo(map), L_next = L.layerGroup().addTo(map);
  let nextPark = null, lastLoop = null;
  const parkIcon = (txt, cls) => L.divIcon({ className: '', html: `<div class="park ${cls || ''}">${txt}</div>`, iconSize: [36, 36], iconAnchor: [18, 18] });
  function drawPark() { L_park.clearLayers(); if (nav && nav.loop) L.marker(nav.loop.park, { interactive: false, keyboard: false, zIndexOffset: 1500, icon: parkIcon('🛵') }).addTo(L_park); }
  function drawNext(sug) {
    L_next.clearLayers(); if (!sug) return;
    L.marker(sug.p, { keyboard: false, zIndexOffset: 1400, icon: parkIcon('P', 'next') }).addTo(L_next).bindPopup(`<b>下一個停車點</b><br>${esc(sug.label)}<br><a href="${appleMaps(sug.p, 'd')}" target="_blank" rel="noopener">用 Apple 地圖騎過去</a>`);
  }
  function clearNext() { L_next.clearLayers(); }
  const appleMaps = (p, mode) => `https://maps.apple.com/?daddr=${p[0].toFixed(6)},${p[1].toFixed(6)}&dirflg=${mode || 'w'}`;
  function sayNextPark() {
    const p = gps.fix ? [gps.fix.lat, gps.fix.lon] : [map.getCenter().lat, map.getCenter().lng];
    const rest = nav && nav.loop ? remainingItems().filter(it => !nav.loop.items.some(x => x.c === it.c && x.side === it.side)) : remainingItems();
    if (!rest.length) { say('沒有其他還沒派的地方了', { noLast: true }); return; }
    const sug = C.suggestPark(st.net, rest, nav && nav.loop ? nav.loop.park : p, S.cap, S.density);
    if (!sug) { say('找不到建議的停車點', { noLast: true }); return; }
    nextPark = sug; drawNext(sug);
    say(`下一個建議停車點在${sug.label}，離${nav && nav.loop ? '這次停車的地方' : '這裡'}大約${sayDist(sug.dist)}`, { noLast: true });
  }
  // 預覽：整個區塊會分成幾圈
  const L_prev = L.layerGroup().addTo(map);
  const LOOP_COL = ['#1F4E9E', '#2E9E5B', '#8E44AD', '#0097A7', '#D81B60', '#6D4C41', '#7CB342', '#3949AB']; // 不用紅、黑、橘（進度用色）
  function clearPreview() { L_prev.clearLayers(); }
  async function previewLoops() {
    const cap = Math.max(20, parseInt($('#stCap').value, 10) || S.cap);
    closeSheets();
    busy(true, '計算每一圈…'); await nextFrame();
    const start = gps.fix ? [gps.fix.lat, gps.fix.lon] : [map.getCenter().lat, map.getCenter().lng];
    const pl = C.planLoops(st.net, remainingItems(), start, evenCap(remainingItems(), cap), S.density);
    busy(false);
    clearPreview();
    pl.loops.forEach((lp, i) => {
      const col = LOOP_COL[i % LOOP_COL.length];
      for (const it of lp.items) { const c = st.net.chains[it.c]; L.polyline(it.side ? offsetLine(c.coords, it.side === 'f' ? 4 : -4) : c.coords, { renderer: cvTop, pane: 'topLines', color: col, weight: 6, opacity: 0.8, interactive: false }).addTo(L_prev); }
      L.marker(lp.park, { keyboard: false, zIndexOffset: 1400, icon: L.divIcon({ className: '', html: `<div class="park" style="background:${col}">${i + 1}</div>`, iconSize: [36, 36], iconAnchor: [18, 18] }) })
        .addTo(L_prev).bindPopup(`<b>第${i + 1}圈</b><br>停車：${esc(lp.label)}<br>約 ${Math.round(lp.flyers)} 張<br><a href="${appleMaps(lp.park, 'd')}" target="_blank" rel="noopener">用 Apple 地圖騎過去</a>`);
    });
    if (pl.loops.length) map.fitBounds(L.latLngBounds(pl.loops.flatMap(l => l.items.map(it => st.net.chains[it.c].coords[0]))), { padding: [40, 40] });
    toast(`以每趟 ${cap} 張，這個區塊分成 ${pl.loops.length} 圈。點數字可以看停車點，再按「開始派報」開始第一圈。`, 7000);
  }

  /* ---------- 這次派報的軌跡與紀錄 ---------- */
  let sess = null, sessT = 0;
  function sessGet() {
    if (!st.block) return { t0: Date.now(), track: [], loops: [] };
    if (!sess || sess.bid !== st.block.id) sess = Object.assign({ bid: st.block.id, t0: 0, track: [], loops: [] }, LS.get('sess_' + st.block.id, {}), { bid: st.block.id });
    return sess;
  }
  function sessStart() { const s0 = sessGet(); if (!s0.t0) s0.t0 = Date.now(); sessSave(true); }
  function sessSave(now) {
    if (!sess || !st.block) return;
    const go = () => LS.set('sess_' + sess.bid, { t0: sess.t0, track: sess.track, loops: sess.loops });
    if (now || Date.now() - sessT > 20000) { sessT = Date.now(); go(); }
  }
  function sessTrack(p) {
    const s0 = sessGet(), t = s0.track, last = t[t.length - 1];
    if (!last || C.dist([last[0], last[1]], p) >= 8) { t.push([+p[0].toFixed(6), +p[1].toFixed(6), Math.round(Date.now() / 1000)]); sessSave(false); }
  }
  function askCompleteBlock(fromStart) {
    if (!st.block) return;
    askConfirm(fromStart ? '這個區塊已經派完了，要記錄完成嗎？' : '記錄這個區塊派報完成？',
      '會存下這次走過的路徑、每一圈的停車點和張數，並把進度清空，下次可以重新派，也能拿這次的路徑當參考。', '記錄完成').then(ok => { if (ok) completeBlock(); });
  }
  function completeBlock() {
    const b = st.block; if (!b) return;
    const s0 = sessGet();
    let len = 0; for (let i = 1; i < s0.track.length; i++) len += C.dist(s0.track[i - 1], s0.track[i]);
    const p = progressNums();
    const rec = { id: uid(), name: b.name, t0: s0.t0 || Date.now(), t1: Date.now(), track: s0.track, loops: s0.loops, len: Math.round(len),
      flyers: s0.loops.reduce((a, l) => a + (l.actual || l.est || 0), 0), pct: p.all ? Math.floor(p.done / p.all * 100) : 0 };
    const recs = LS.get('rec_' + b.id, []); recs.push(rec); // 派報紀錄永遠保留，不刪舊的
    if (!LS.set('rec_' + b.id, recs)) return;
    st.covered.clear(); st.skipped.clear(); st.hits.clear(); saveProgress(true);
    sess = { bid: b.id, t0: 0, track: [], loops: [] }; LS.del('sess_' + b.id);
    clearNext(); renderNet(); renderBlocks();
    toast('已記錄完成，進度已清空。到「我的區塊」的「派報紀錄」可以看這次的路徑。', 6000);
  }
  // 派報紀錄
  const L_rec = L.layerGroup().addTo(map);
  function renderRecList() {
    const recs = st.block ? LS.get('rec_' + st.block.id, []) : [];
    const box = $('#recList');
    if (!recs.length) { box.innerHTML = '<div class="empty">還沒有派報紀錄。整個區塊派完後按「記錄完成」就會存在這裡。</div>'; return; }
    box.innerHTML = recs.slice().reverse().map(r => {
      const d = new Date(r.t1), mins = Math.round((r.t1 - r.t0) / 60000);
      return `<div class="blk" data-rid="${r.id}"><div class="hd"><b>${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</b><span class="meta">${r.loops.length} 圈</span></div>
        <div class="meta">走了 ${fmtDist(r.len)}，約 ${r.flyers} 張，${mins >= 60 ? Math.floor(mins / 60) + ' 小時 ' : ''}${mins % 60} 分鐘</div>
        <div class="btnrow"><button class="btn sm primary" data-ract="show">在地圖上看路徑</button><button class="btn sm" data-ract="gpx">匯出 GPX</button></div></div>`;
    }).join('');
  }
  function showRecord(r) {
    L_rec.clearLayers();
    if (r.track.length > 1) L.polyline(r.track.map(x => [x[0], x[1]]), { renderer: cvTop, pane: 'topLines', color: '#8E44AD', weight: 5, opacity: 0.85, dashArray: '8 7', interactive: false }).addTo(L_rec);
    r.loops.forEach(l => L.marker(l.park, { keyboard: false, icon: L.divIcon({ className: '', html: `<div class="park old">${l.no}</div>`, iconSize: [32, 32], iconAnchor: [16, 16] }) }).addTo(L_rec)
      .bindPopup(`<b>上次第${l.no}圈的停車點</b><br>約 ${l.actual || l.est} 張<br><a href="${appleMaps(l.park, 'd')}" target="_blank" rel="noopener">用 Apple 地圖騎過去</a>`));
    const pts = r.track.map(x => [x[0], x[1]]).concat(r.loops.map(l => l.park));
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
    $('#fabRec').style.display = '';
    toast('紫色虛線是上次走過的路，數字是上次每一圈停車的地方。按右側「紀錄」可以關掉。', 6000);
  }
  function gpx(r) {
    const t = x => new Date(x * 1000).toISOString();
    const pts = r.track.map(x => `<trkpt lat="${x[0]}" lon="${x[1]}"><time>${t(x[2])}</time></trkpt>`).join('');
    const wpts = r.loops.map(l => `<wpt lat="${l.park[0]}" lon="${l.park[1]}"><name>第${l.no}圈停車點</name></wpt>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="派報系統" xmlns="http://www.topografix.com/GPX/1/1">${wpts}<trk><name>${esc(r.name)}</name><trkseg>${pts}</trkseg></trk></gpx>`;
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------- 步伐推算（騎樓下 GPS 不準時，用計步＋路線推算位置） ---------- */
  let motionAsked = false, pdrPos = null;
  const pdr = { lp: 9.8, armed: true, lastStep: 0, steps: 0 };
  function enableMotion() {
    if (motionAsked || !window.DeviceMotionEvent) return;
    motionAsked = true;
    // 先掛上監聽；有沒有資料由 iPhone 的「動作與方向」權限決定
    window.addEventListener('devicemotion', onMotion);
    if (typeof DeviceMotionEvent.requestPermission === 'function') DeviceMotionEvent.requestPermission().catch(() => {});
  }
  function onMotion(e) {
    const a = e.accelerationIncludingGravity; if (!a || a.x == null) return;
    const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    pdr.lp = pdr.lp * 0.75 + mag * 0.25;
    const now = Date.now();
    if (pdr.armed && pdr.lp > 10.9 && now - pdr.lastStep > 330) { pdr.armed = false; pdr.lastStep = now; pdr.steps++; onStep(now); }
    else if (!pdr.armed && pdr.lp < 9.6) pdr.armed = true;
  }
  function gpsPoor(now) { return !gps.fix || gps.fix.acc > 15 || now - gps.lastGood > 2500; }
  function pdrOn() { return nav && nav.pdrUsed && pdrPos && Date.now() - pdr.lastStep < 4000; }
  function onStep(now) {
    if (!nav || !S.pdr || nav.far || nav.paused === 'x' || !gpsPoor(now)) return;
    const R = nav.route;
    nav.tr.s = Math.min(R.total, nav.tr.s + S.stepLen);
    nav.pdrUsed = true;
    pdrPos = C.pointAtRoute(R, nav.tr.s);
    // 小藍點移到推算的位置
    if (meMarker) { meMarker.setLatLng(pdrPos); if (accCircle) accCircle.setLatLng(pdrPos); if (st.follow) map.panTo(pdrPos, { animate: false }); }
    setPill('mid', '步伐推算中');
    progressAt(nav.tr.s, now, pdrPos);
  }
  // 依路線上的位置 s 做：標已派、判斷一圈結束、播報、更新畫面（GPS 與步伐推算共用）
  function progressAt(s, now, p) {
    const R = nav.route;
    let changed = false;
    while (nav.stepPtr < R.steps.length && R.steps[nav.stepPtr].d1 <= s + 3) {
      const stp = R.steps[nav.stepPtr], c = st.net.chains[stp.c];
      if (!stp.dead && !stp.markLater && c.req && markItem({ c: stp.c, side: stp.side })) { restyle(c.i); changed = true; }
      nav.stepPtr++;
    }
    if (changed) { saveProgress(); renderBlocks(); }
    if (nav.loop) {
      if (nav.loop.phase === 'deliver' && !loopRemaining().length) return goBackToPark();
      if (nav.loop.phase === 'return' && (C.dist(p, nav.loop.park) < 20 || s >= R.total - 8)) return loopFinished();
    } else if (!remainingItems().length) return finishNav();
    announce(s, now);
    updateCard(s); updateRouteLine(s);
  }

  /* ---------- 拍照（照片存在 IndexedDB，記錄位置與時間） ---------- */
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('paibao', 1);
      r.onupgradeneeded = () => { const s0 = r.result.createObjectStore('photos', { keyPath: 'id' }); s0.createIndex('bid', 'bid'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function dbDo(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => { const tx = d.transaction('photos', mode), st0 = tx.objectStore('photos'); const out = fn(st0); tx.oncomplete = () => res(out && out.result !== undefined ? out.result : out); tx.onerror = () => rej(tx.error); });
  }
  const photoAll = bid => dbDo('readonly', s0 => s0.index('bid').getAll(bid));
  const photoPut = ph => dbDo('readwrite', s0 => s0.put(ph));
  const photoDel = id => dbDo('readwrite', s0 => s0.delete(id));
  async function photoDelBlock(bid) { try { for (const ph of await photoAll(bid)) await photoDel(ph.id); } catch (e) { /* 無 */ } }
  function shrink(file, max = 1280) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const cvs = document.createElement('canvas'); cvs.width = Math.round(img.naturalWidth * k); cvs.height = Math.round(img.naturalHeight * k);
        cvs.getContext('2d').drawImage(img, 0, 0, cvs.width, cvs.height);
        URL.revokeObjectURL(url);
        cvs.toBlob(b => b ? res(b) : rej(new Error('壓縮失敗')), 'image/jpeg', 0.78);
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('讀不到照片')); };
      img.src = url;
    });
  }
  function placeLabel(p) {
    if (!st.net) return '';
    const nc = C.nearestChain(st.net, p, 40, c => !c.virtual), nm = nc ? st.net.chains[nc.c].name : '';
    const a = C.nearestAddr(st.net, p, 25, nm || undefined);
    return (nm || '') + (a ? String(a.h).replace(/號$/, '') + '號附近' : nm ? '附近' : '');
  }
  const L_photo = L.layerGroup().addTo(map);
  let photoUrls = [], curPhoto = null;
  const photoUrl = ph => { const u = URL.createObjectURL(ph.blob); photoUrls.push(u); return u; };
  async function renderPhotos() {
    L_photo.clearLayers(); photoUrls.forEach(u => URL.revokeObjectURL(u)); photoUrls = [];
    if (!st.block) return;
    let list = []; try { list = await photoAll(st.block.id); } catch (e) { return; }
    for (const ph of list) {
      const u = photoUrl(ph);
      L.marker([ph.lat, ph.lon], { keyboard: false, zIndexOffset: 600, icon: L.divIcon({ className: '', html: `<div class="pmk" style="background-image:url('${u}')"></div>`, iconSize: [30, 30], iconAnchor: [15, 15] }) })
        .addTo(L_photo).on('click', () => openPhoto(ph));
    }
  }
  function fmtTime(t) { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
  function openPhoto(ph) {
    curPhoto = ph;
    $('#phImg').src = photoUrl(ph);
    $('#phInfo').textContent = `${fmtTime(ph.t)}　${ph.place || '位置 ' + ph.lat.toFixed(5) + ', ' + ph.lon.toFixed(5)}${ph.acc ? '（GPS ±' + Math.round(ph.acc) + ' 公尺）' : ''}`;
    $('#phNote').value = ph.note || '';
    openSheet('shPhoto');
  }
  // App 內相機：可以用語音「準備拍照」→「照相」
  const cam = { on: false, stream: null };
  async function openCam(byVoice, shootSoon) {
    if (!st.block) { const m = '先選一個區塊，照片會存在那個區塊裡'; toast(m); if (byVoice) say(m, { noLast: true }); return; }
    if (cam.on) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('#camInput').value = ''; $('#camInput').click(); return; }
    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (e) {
      const m = '打不開相機，請到「設定 › Safari › 相機」允許，或按「iPhone 相機」';
      toast(m, 5000); if (byVoice) say('打不開相機，請按右邊的相機按鈕', { noLast: true });
      $('#camView').classList.add('fail'); $('#camView').style.display = 'flex'; cam.on = true;
      return;
    }
    const v = $('#camVid'); v.srcObject = cam.stream; v.play().catch(() => {});
    $('#camView').classList.remove('fail'); $('#camView').style.display = 'flex'; cam.on = true;
    $('#camHint').textContent = byVoice ? '請說「照相」，或按白色按鈕' : '按白色按鈕拍照；也可以按「說」再說「照相」';
    if (byVoice) say(shootSoon ? '相機打開了，兩秒後拍照' : '相機打開了，說照相就拍', { noLast: true });
    if (shootSoon) setTimeout(() => { if (cam.on) shoot(); }, 2200);
  }
  function closeCam() {
    if (cam.stream) cam.stream.getTracks().forEach(t => t.stop());
    cam.stream = null; cam.on = false; $('#camView').style.display = 'none'; $('#camVid').srcObject = null;
    try { if (rec) rec.stop(); } catch (e) { /* 無 */ }
  }
  async function shoot() {
    const v = $('#camVid');
    if (!cam.on || !v.videoWidth) { toast('相機還沒準備好'); return; }
    const k = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
    const cvs = document.createElement('canvas'); cvs.width = Math.round(v.videoWidth * k); cvs.height = Math.round(v.videoHeight * k);
    cvs.getContext('2d').drawImage(v, 0, 0, cvs.width, cvs.height);
    $('#camFlash').classList.remove('go'); void $('#camFlash').offsetWidth; $('#camFlash').classList.add('go');
    beep(1200, 60);
    const blob = await new Promise(r => cvs.toBlob(r, 'image/jpeg', 0.82));
    closeCam();
    if (blob) await savePhotoBlob(blob, true);
  }
  async function savePhotoBlob(blob, quiet) {
    const p = pdrPos || (gps.fix ? [gps.fix.lat, gps.fix.lon] : [map.getCenter().lat, map.getCenter().lng]);
    try {
      const ph = { id: uid(), bid: st.block.id, lat: p[0], lon: p[1], acc: gps.fix ? gps.fix.acc : null, t: Date.now(), note: '', place: placeLabel(p), blob };
      await photoPut(ph);
      await renderPhotos();
      say('照好了' + (ph.place ? '，' + ph.place : ''), { noLast: true });
      toast('照片存好了' + (ph.place ? '：' + ph.place : ''));
      if (!quiet && !nav) openPhoto(ph);
    } catch (e) { toast('照片沒有存成功：' + (e.message || '手機空間不足')); }
  }
  $('#fabCam').onclick = () => openCam(false);
  $('#camShot').onclick = () => shoot();
  $('#camClose').onclick = () => closeCam();
  $('#camSys').onclick = () => { closeCam(); $('#camInput').value = ''; $('#camInput').click(); };
  $('#camMic').onclick = () => listen();
  $('#camInput').onchange = async () => {
    const f = $('#camInput').files[0]; if (!f || !st.block) return;
    busy(true, '存照片中…');
    try { const blob = await shrink(f); busy(false); await savePhotoBlob(blob, false); }
    catch (e) { busy(false); toast('照片沒有存成功：' + (e.message || '手機空間不足')); }
  };
  // 一鍵把今天拍的照片存到相簿（iPhone 分享選單 →「儲存影像」）
  let todayFiles = [];
  async function loadToday() {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    let all = []; try { all = await dbDo('readonly', s0 => s0.getAll()); } catch (e) { all = []; }
    const list = all.filter(ph => ph.t >= d0.getTime()).sort((a, b) => a.t - b.t);
    todayFiles = list.map(ph => new File([ph.blob], `派報_${fmtTime(ph.t).replace(/[\/: ]/g, '')}_${ph.id.slice(-4)}.jpg`, { type: 'image/jpeg', lastModified: ph.t }));
    $$('.todayBtn').forEach(b => { b.textContent = todayFiles.length ? `把今天的 ${todayFiles.length} 張照片存到相簿` : '今天還沒有拍照'; b.disabled = !todayFiles.length; });
    return todayFiles;
  }
  function saveToday() {
    if (!todayFiles.length) { toast('今天還沒有拍照'); return; }
    if (navigator.canShare && navigator.canShare({ files: todayFiles })) {
      navigator.share({ files: todayFiles }).then(() => toast('完成')).catch(err => { if (err && err.name !== 'AbortError') toast('沒有存成功，請再按一次'); });
      toast('在選單裡按「儲存 ' + todayFiles.length + ' 張影像」', 5000);
    } else {
      todayFiles.forEach((f, i) => setTimeout(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); }, i * 400));
      toast('正在下載 ' + todayFiles.length + ' 張照片');
    }
  }
  $$('.todayBtn').forEach(b => b.onclick = saveToday);
  function renderHeard() {
    const box = $('#heardList'); if (!box) return;
    box.innerHTML = heard.length ? heard.map(h => `<div class="hrow"><span>${esc(fmtTime(h.t))}</span><b>${esc(h.s)}</b><i>${esc(h.r)}</i></div>`).join('') : '<div class="empty">還沒有聽到的話</div>';
  }
  $('#phSave').onclick = async () => { if (!curPhoto) return; curPhoto.note = $('#phNote').value.trim(); await photoPut(curPhoto); closeSheets(); toast('備註已儲存'); };
  $('#phMap').onclick = () => { if (!curPhoto) return; closeSheets(); st.follow = false; $('#fabFollow').classList.remove('on'); map.setView([curPhoto.lat, curPhoto.lon], 19); };
  $('#phDl').onclick = () => {
    if (!curPhoto) return;
    const a = document.createElement('a'); a.href = photoUrl(curPhoto); a.download = `派報_${fmtTime(curPhoto.t).replace(/[\/: ]/g, '')}.jpg`;
    document.body.appendChild(a); a.click(); a.remove();
  };
  $('#phDel').onclick = () => {
    if (!curPhoto) return;
    const ph = curPhoto;
    askConfirm('刪除這張照片？', '刪掉就找不回來。', '刪除照片', true).then(async ok => { if (!ok) return; closeSheets(); await photoDel(ph.id); curPhoto = null; await renderPhotos(); toast('照片已刪除'); });
  };
  async function openPhotoList() {
    loadToday();
    if (!st.block) return;
    let list = []; try { list = await photoAll(st.block.id); } catch (e) { /* 無 */ }
    list.sort((a, b) => b.t - a.t);
    $('#phGrid').innerHTML = list.length ? '' : '<div class="empty" style="grid-column:1/-1">還沒有照片。按地圖右側的相機按鈕拍照。</div>';
    for (const ph of list) {
      const b0 = document.createElement('button');
      b0.style.backgroundImage = `url('${photoUrl(ph)}')`;
      b0.innerHTML = `<span>${esc(fmtTime(ph.t) + ' ' + (ph.note || ph.place || ''))}</span>`;
      b0.onclick = () => openPhoto(ph);
      $('#phGrid').appendChild(b0);
    }
    openSheet('shPhotos');
  }

  /* ---------- 公共廁所 ---------- */
  const L_wc = L.layerGroup().addTo(map);
  async function fetchWC(b, quiet) {
    const [s, w, n, e] = C.bbox(b.poly, 1500);
    const q = `[out:json][timeout:60];nwr["amenity"="toilets"](${s},${w},${n},${e});out center tags;`;
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!res.ok) continue;
        const data = await res.json();
        const list = data.elements.map(el => {
          const t = el.tags || {}, lat = el.lat != null ? el.lat : el.center && el.center.lat, lon = el.lon != null ? el.lon : el.center && el.center.lon;
          return lat == null || t.amenity !== 'toilets' ? null : { lat: +lat.toFixed(6), lon: +lon.toFixed(6), name: t.name || t['name:zh'] || '', fee: t.fee, wc: t.wheelchair, hours: t.opening_hours || '', access: t.access || '' };
        }).filter(x => x && x.access !== 'private' && x.access !== 'customers' && x.access !== 'no');
        LS.set('wc_' + b.id, { t: Date.now(), list });
        if (st.block === b) renderWC();
        return list;
      } catch (err) { /* 換下一個伺服器 */ }
    }
    if (!quiet) toast('抓不到公廁資料，請確認網路');
    return null;
  }
  function wcList() { return st.block ? (LS.get('wc_' + st.block.id, null) || {}).list || null : null; }
  function wcDesc(x) { return [x.fee === 'no' ? '免費' : x.fee === 'yes' ? '收費' : '', x.wc === 'yes' ? '無障礙' : '', x.hours ? '開放：' + x.hours : ''].filter(Boolean).join('，'); }
  function renderWC() {
    L_wc.clearLayers();
    const list = wcList(); if (!S.showWC || !list) return;
    for (const x of list) L.marker([x.lat, x.lon], { keyboard: false, icon: L.divIcon({ className: '', html: '<div class="wc">🚻</div>', iconSize: [26, 26], iconAnchor: [13, 13] }) })
      .addTo(L_wc).bindPopup(`<b>${esc(x.name || '公共廁所')}</b>${wcDesc(x) ? '<br>' + esc(wcDesc(x)) : ''}<br><a href="${appleMaps([x.lat, x.lon], 'w')}" target="_blank" rel="noopener">用 Apple 地圖走過去</a>`);
  }
  function relDir(from, to) {
    const b = C.bearing(from, to), h = currentHeading();
    if (h == null) return '往' + ['北', '東北', '東', '東南', '南', '西南', '西', '西北'][Math.round(b / 45) % 8] + '邊';
    const d = C.angDiff(h, b), x = Math.abs(d), lr = d > 0 ? '右' : '左';
    if (x < 30) return '前方'; if (x < 75) return lr + '前方'; if (x < 120) return lr + '手邊'; if (x < 160) return lr + '後方'; return '後方';
  }
  async function findToilet() {
    if (!st.block) { toast('先選一個區塊'); return; }
    let list = wcList();
    if (!list) { toast('正在找附近的公廁…'); list = await fetchWC(st.block); if (!list) return; }
    const p = gps.fix ? [gps.fix.lat, gps.fix.lon] : [map.getCenter().lat, map.getCenter().lng];
    const near = list.map(x => Object.assign({ d: C.dist(p, [x.lat, x.lon]) }, x)).sort((a, b) => a.d - b.d).slice(0, 5);
    if (!near.length) { const m = '這附近的地圖資料裡沒有公共廁所'; toast(m); if (nav) say(m, { noLast: true }); return; }
    const n0 = near[0];
    say(`最近的廁所在你的${relDir(p, [n0.lat, n0.lon])}，大約${sayDist(n0.d)}` + (n0.name ? `，在${n0.name}` : ''), { noLast: true });
    $('#wcList').innerHTML = near.map((x, i) => `<div class="blk"><div class="hd"><b>${esc(x.name || '公共廁所')}</b><span class="meta">${fmtDist(x.d)}</span></div>
      <div class="meta">${esc(relDir(p, [x.lat, x.lon]))}${wcDesc(x) ? '，' + esc(wcDesc(x)) : ''}</div>
      <div class="btnrow"><a class="btn sm primary" href="${appleMaps([x.lat, x.lon], 'w')}" target="_blank" rel="noopener">用 Apple 地圖走過去</a><button class="btn sm" data-wc="${i}">在地圖上看</button></div></div>`).join('');
    $$('#wcList [data-wc]').forEach(btn => btn.onclick = () => { const x = near[+btn.dataset.wc]; closeSheets(); st.follow = false; $('#fabFollow').classList.remove('on'); map.setView([x.lat, x.lon], 18); });
    if (!S.showWC) { S.showWC = true; saveSettings(); }
    renderWC();
    openSheet('shWC');
  }

  // 路線：整條剩餘路線（淡）、前方一段（粗）、左右側色帶、方向箭頭、起點/終點/轉折點
  const SIDE_L = '#0097A7', SIDE_R = '#8E44AD';
  const L_arrows = L.layerGroup();
  let routeAhead = null, routeCase = null, routeRest = null, sideL = null, sideR = null;
  let arrowMk = [], turnMk = [], lastRestS = -99, lastAheadPts = [];
  const TURN_CH = { '左轉': '左', '右轉': '右', '靠左': '左', '靠右': '右', '回頭': '回' };
  const pin = (cls, txt, sz) => L.divIcon({ className: '', html: `<div class="rpin ${cls}">${txt}</div>`, iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] });
  function drawRoute() {
    L_route.clearLayers(); L_arrows.clearLayers(); arrowMk = []; turnMk = []; lastRestS = -99;
    const r = nav.route;
    routeRest = L.polyline([], { renderer: cv, color: '#1F4E9E', weight: 5, opacity: 0.35, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(L_route);
    routeCase = L.polyline([], { renderer: cv, color: '#fff', weight: 11, opacity: 0.9, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(L_route);
    sideL = L.polyline([], { renderer: cv, color: SIDE_L, weight: 5, opacity: 0.95, interactive: false, lineCap: 'butt', lineJoin: 'round' }).addTo(L_route);
    sideR = L.polyline([], { renderer: cv, color: SIDE_R, weight: 5, opacity: 0.95, interactive: false, lineCap: 'butt', lineJoin: 'round' }).addTo(L_route);
    routeAhead = L.polyline([], { renderer: cv, color: '#1F4E9E', weight: 7, opacity: 0.95, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(L_route);
    // 行進方向箭頭（每 35 公尺一個）
    for (let d = 15; d < r.total - 5; d += 35) {
      const a = C.pointAtRoute(r, d), b = C.pointAtRoute(r, Math.min(r.total, d + 3));
      const mk = L.marker(a, { interactive: false, keyboard: false, rotateWithView: true, icon: L.divIcon({ className: '', html: `<div class="rarr" style="transform:rotate(${C.bearing(a, b)}deg)"></div>`, iconSize: [0, 0] }) }).addTo(L_arrows);
      mk._d = d; arrowMk.push(mk);
    }
    // 起點、終點
    L.marker(r.coords[0], { interactive: false, keyboard: false, zIndexOffset: 900, icon: pin('start', '起', 34) }).addTo(L_route);
    L.marker(r.coords[r.coords.length - 1], { interactive: false, keyboard: false, zIndexOffset: 800, icon: pin('end', '終', 34) }).addTo(L_route);
    // 轉折點
    r.maneuvers.forEach((m, i) => {
      if (m.type !== 'turn' && m.type !== 'uturn') return;
      const mk = L.marker(C.pointAtRoute(r, m.d), { interactive: false, keyboard: false, zIndexOffset: 500, icon: pin('turn', TURN_CH[m.dir] || '轉', 28) }).addTo(L_route);
      mk._d = m.d; mk._i = i; mk._ch = TURN_CH[m.dir] || '轉'; mk._next = false; turnMk.push(mk);
    });
    toggleArrows();
    updateRouteLine(0);
  }
  function toggleArrows() {
    if (!nav) { map.removeLayer(L_arrows); return; }
    if (map.getZoom() >= 16) L_arrows.addTo(map); else map.removeLayer(L_arrows);
  }
  // 把線往左右偏移固定的螢幕像素（換算成公尺，縮放時重算）；px > 0 是行進方向的右側
  function offsetLine(pts, px) {
    if (pts.length < 2) return [];
    const lat0 = pts[0][0] * Math.PI / 180;
    const mpp = 40075016.686 * Math.cos(lat0) / Math.pow(2, map.getZoom() + 8); // 每像素幾公尺
    const off = px * mpp;
    const kx = 111320 * Math.cos(lat0), ky = 110574;
    const P = pts.map(p => [p[1] * kx, p[0] * ky]); // x=東, y=北（公尺）
    const out = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[i - 1], b = P[i], c = P[i + 1];
      // 右手邊的法向量：方向 (dx,dy) → (dy,-dx)
      const nrm = (u, v) => { const dx = v[0] - u[0], dy = v[1] - u[1], l = Math.hypot(dx, dy); return l > 0.05 ? [dy / l, -dx / l] : null; };
      const n1 = a ? nrm(a, b) : null, n2 = c ? nrm(b, c) : null;
      let ox, oy;
      if (n1 && n2) {
        const sx = n1[0] + n2[0], sy = n1[1] + n2[1], s2 = sx * sx + sy * sy;
        if (s2 < 0.1) continue; // 回頭：略過
        const k = Math.min(2 / s2, 4); // miter = 1/cos²(θ/2)，限制尖角
        ox = sx * k * off; oy = sy * k * off;
      } else {
        const n = n1 || n2; if (!n) continue;
        ox = n[0] * off; oy = n[1] * off;
      }
      out.push([(b[1] + oy) / ky, (b[0] + ox) / kx]);
    }
    return out;
  }
  function drawSides() {
    if (!sideL) return;
    const w = map.getZoom() >= 18 ? 9 : map.getZoom() >= 16 ? 7 : 5;
    sideR.setLatLngs(offsetLine(lastAheadPts, w));
    sideL.setLatLngs(offsetLine(lastAheadPts, -w));
  }
  map.on('zoomend', () => { toggleArrows(); drawSides(); if (nav && routeAhead) updateRouteLine(nav.tr.s); });
  function updateRouteLine(s) {
    const r = nav.route; if (!routeAhead) return;
    const end = Math.min(r.total, s + 450);
    const pts = [C.pointAtRoute(r, s)];
    for (let i = 0; i < r.coords.length; i++) { if (r.cum[i] <= s + 0.5) continue; if (r.cum[i] >= end - 0.5) break; pts.push(r.coords[i]); }
    pts.push(C.pointAtRoute(r, end));
    routeAhead.setLatLngs(pts); routeCase.setLatLngs(pts);
    // 左右色帶只畫目前這條路（到下一個轉折點為止），避免死巷來回時重疊
    const m = r.maneuvers[nav.mi];
    const sEnd = Math.min(end, s + 200, m && m.type !== 'start' ? Math.max(s + 1, m.d) : end);
    const sp = [C.pointAtRoute(r, s)];
    for (let i = 0; i < r.coords.length; i++) { if (r.cum[i] <= s + 0.5) continue; if (r.cum[i] >= sEnd - 0.5) break; sp.push(r.coords[i]); }
    sp.push(C.pointAtRoute(r, sEnd));
    lastAheadPts = sp; drawSides();
    // 剩餘全路線、箭頭（走超過 5 公尺才更新）
    if (Math.abs(s - lastRestS) > 5) {
      lastRestS = s;
      const rest = [C.pointAtRoute(r, s)];
      for (let i = 0; i < r.coords.length; i++) if (r.cum[i] > s) rest.push(r.coords[i]);
      routeRest.setLatLngs(rest);
      for (const mk of arrowMk) { const show = mk._d > s + 2; if (mk._shown !== show) { mk.setOpacity(show ? 1 : 0); mk._shown = show; } }
    }
    // 轉折點：走過的隱藏，下一個放大
    for (const mk of turnMk) {
      const ahead = mk._i - nav.mi;
      const show = mk._d > s - 3 && (map.getZoom() >= 17 || ahead < 5), next = mk._i === nav.mi;
      if (mk._shown !== show) { mk.setOpacity(show ? 1 : 0); mk._shown = show; }
      if (mk._next !== next) { mk._next = next; mk.setIcon(pin(next ? 'turn next' : 'turn', mk._ch, next ? 34 : 28)); mk.setZIndexOffset(next ? 1000 : 500); }
    }
  }

  function arrowSvg(m) {
    const w = '#fff';
    if (!m) return '';
    if (m.type === 'end') return `<svg viewBox="0 0 48 48"><path d="M14 42V6" stroke="${w}" stroke-width="4" stroke-linecap="round"/><path d="M14 8h22l-5 7 5 7H14z" fill="${w}"/></svg>`;
    if (m.type === 'uturn') return `<svg viewBox="0 0 48 48" fill="none" stroke="${w}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M32 42V18a10 10 0 0 0-20 0v6"/><path d="M5 18l7 8 7-8"/></svg>`;
    const a = m.type === 'start' ? 0 : Math.max(-120, Math.min(120, m.ang || 0));
    return `<svg viewBox="0 0 48 48" fill="none" stroke="${w}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><g transform="rotate(${a} 24 24)"><path d="M24 42V8"/><path d="M12 19 24 7l12 12"/></g></svg>`;
  }
  function updateCard(s) {
    const r = nav.route, m = r.maneuvers[nav.mi];
    const p = progressNums();
    $('#navProg').textContent = nav.loop
      ? (nav.loop.phase === 'return' ? `第${nav.loop.no}圈派完｜回停車點 ${fmtDist(Math.max(0, r.total - s))}` : `第${nav.loop.no}圈｜這圈剩約 ${Math.round(flyersOf(loopRemaining()))} 張｜${fmtDist(Math.max(0, r.total - s))}`)
      : `已派 ${p.all ? Math.floor(p.done / p.all * 100) : 0}%｜剩 ${fmtDist(Math.max(0, r.total - s))}`;
    if (nav.far) {
      $('#navIco').innerHTML = arrowSvg({ type: 'start' });
      $('#navDist').innerHTML = `${Math.round(nav.farD)}<small>公尺</small>`;
      $('#navText').textContent = '離路線太遠，先走回藍線';
      $('#navRoad').textContent = '';
      return;
    }
    if (!m) return;
    const d = Math.max(0, m.d - s);
    $('#navIco').innerHTML = arrowSvg(m);
    $('#navDist').innerHTML = m.type === 'start' ? '出發' : `${d >= 1000 ? (d / 1000).toFixed(1) : Math.round(d)}<small>${d >= 1000 ? '公里' : '公尺'}</small>`;
    $('#navText').textContent = m.type === 'start' ? m.text.replace(/^開始派報，?/, '') : m.text.replace(/，右進左出：.*$/, '（右進左出）');
    const step = r.steps.find(x => x.d1 > s) || r.steps[r.steps.length - 1];
    const cn = step ? st.net.chains[step.c].name : '';
    const g = gpsStreet(), h = currentHeading();
    $('#navRoad').textContent = '定位：' + (g && g.name ? g.name + (g.no ? ' ' + g.no + '號' : '') : '不在道路上') + (g && g.name && cn && g.name !== cn ? '（規劃：' + cn + '）' : '') + (h != null ? '｜朝' + C.cardinal(h) + ' ' + Math.round((h + 360) % 360) + '°' : '') + (pdrOn() ? '｜步伐推算' : '') + (nav.paused ? '｜語音暫停' : '');
  }

  function navTick(force) {
    if (!nav || !gps.fix) return;
    const f = gps.fix, p = [f.lat, f.lon], now = Date.now();
    const dt = Math.min(20, Math.max(1, (now - nav.lastFixT) / 1000)); nav.lastFixT = now;
    const off = Math.max(S.offRoute, Math.min(f.acc, 40) * 0.8);
    if (nav.pdrUsed && f.acc <= 12) { nav.tr.s = Math.max(0, nav.tr.s - 30); nav.pdrUsed = false; } // 好訊號回來：允許往回校正
    pdrPos = null;
    const r = C.trackUpdate(nav.tr, p, gps.bear, gps.speed, off, 40 + Math.max(1.5, gps.speed) * dt * 2);
    const R = nav.route;
    sessTrack(p);
    // 1) 走過、要派的路段標成已派（不用派的路段不算；大馬路只標走的那一邊）
    let changed = false;
    if (!r.off) {
      while (nav.stepPtr < R.steps.length && R.steps[nav.stepPtr].d1 <= r.s + 3) {
        const stp = R.steps[nav.stepPtr], c = st.net.chains[stp.c];
        if (!stp.dead && !stp.markLater && c.req && markItem({ c: stp.c, side: stp.side })) { restyle(c.i); changed = true; }
        nav.stepPtr++;
      }
    }
    // 離開路線時走過的小巷也算（只算這一圈要派的）
    const allow = nav.loop ? new Set(nav.loop.items.filter(it => !it.side).map(it => st.net.chains[it.c].key)) : undefined;
    const newly = C.markVisits(st.net, p, Math.min(15, Math.max(8, f.acc * 0.8)), st.hits, st.covered, 0.7, allow);
    for (const ci of newly) { restyle(ci); changed = true; }
    if (changed) { saveProgress(); renderBlocks(); }
    if (nav.loop) {
      if (nav.loop.phase === 'deliver' && !loopRemaining().length) return goBackToPark();
      if (nav.loop.phase === 'return' && (C.dist(p, nav.loop.park) < 20 || r.s >= R.total - 8)) return loopFinished();
    } else if (!remainingItems().length) return finishNav();

    // 2) 偏離路線
    nav.far = false;
    if (r.off) {
      if (r.d > 300) {
        nav.far = true; nav.farD = C.dist(p, C.pointAtRoute(R, r.s));
        if (now - nav.lastFarSay > 90000) { nav.lastFarSay = now; say(`離路線還有${sayDist(nav.farD)}，先走回藍線`); }
      } else {
        if (!nav.offSince) { nav.offSince = now; nav.offWarned = false; }
        const g = gpsStreet(), stp = curStep(), planned = stp ? st.net.chains[stp.c].name : '';
        if (!nav.offWarned && now - nav.offSince > 2500 && nav.tr.offCount >= 2) {
          nav.offWarned = true;
          const here = g && (g.name || g.addrStreet) ? (g.name || g.addrStreet) + (g.no ? g.no + '號附近' : '') : '不在道路上的地方';
          say(`注意，定位顯示你在${here}${planned && g && g.name !== planned ? '，不在規劃的' + planned : '，離開了路線'}。如果定位錯了，請按說指令，說出你在哪裡。`);
        }
        if (now - nav.offSince > 9000 && nav.tr.offCount >= 3 && now - nav.lastReroute > 12000) { reroute(g && g.name ? `從${g.name}重新規劃` : '偏離路線，重新規劃'); return; }
      }
    } else nav.offSince = 0;

    // 3) 語音提示
    if (!nav.far) announce(r.s, now);
    checkMarks(p, now);
    updateCard(r.s); updateRouteLine(r.s);
    updateHeading(); drawMeCone();
  }

  function announce(s, now) {
    const M = nav.route.maneuvers;
    while (nav.mi < M.length - 1 && M[nav.mi].d < s - 4) nav.mi++;
    if (nav.mi === 0 && M.length > 1 && s > 3) nav.mi = 1;
    const m = M[nav.mi]; if (!m || m.type === 'start') return;
    if (nav.paused) return;
    const d = m.d - s;
    const lead = Math.max(1.2, gps.speed || 1.2) * 1.5;
    const f = nav.flags.get(nav.mi) || {};
    if (m.type === 'end') {
      if (d <= 10 && !f.near) { f.near = true; say(nav.route.back || nav.route.loop ? '快到停車的地方了' : '快到終點了'); }
      nav.flags.set(nav.mi, f); return;
    }
    const nx = M[nav.mi + 1];
    const tail = nx && nx.type !== 'end' && nx.type !== 'side' && nx.d - m.d < 25 ? `，接著${nx.dir}` : '';
    if (m.type === 'side') {
      // 沒有轉彎、只是派法改變：到了再說
      if (!f.near && d <= Math.max(6, S.nearDist * 0.6) + lead) { f.near = f.pre = true; say(m.text); }
    } else if (S.preDist > 0 && !f.pre && d <= S.preDist + lead && d > S.nearDist + 8) {
      f.pre = true; say(`${whereNow()}前方${r5(d)}公尺，${m.text}${tail}`);
    } else if (!f.near && d <= S.nearDist + lead) {
      f.near = f.pre = true;
      if (m.type === 'uturn') say(m.text + tail);
      else say(`${S.preDist > 0 ? '' : whereNow()}${d > 3 ? r5(d) + '公尺後' : ''}${m.text}${tail}`);
    } else if (S.periodic > 0 && now - nav.lastSpeak > S.periodic * 1000 && d > S.nearDist + 15) {
      const stp = curStep();
      say(whereNow() + (stp ? C.straightText(st.net, stp) : '請沿藍線直走'), { noLast: true });
    }
    nav.flags.set(nav.mi, f);
  }
  // 「現在在萬大路，大約在 410 號前面，」
  // GPS 實際定位到哪條路（不是規劃的那條）
  function gpsStreet() {
    if (!st.net || !gps.fix) return null;
    const p = pdrPos || [gps.fix.lat, gps.fix.lon];
    const nc = C.nearestChain(st.net, p, 30, c => !c.virtual && !!c.name);
    const nm = nc ? st.net.chains[nc.c].name : '';
    const a = C.nearestAddr(st.net, p, 25, nm || undefined) || C.nearestAddr(st.net, p, 15);
    return { name: nm, no: a ? String(a.h).replace(/號$/, '') : '', addrStreet: a ? a.s : '', d: nc ? nc.d : null };
  }
  function curStep() { if (!nav) return null; const R = nav.route, s = nav.tr.s; return R.steps.find(x => x.d1 > s) || R.steps[R.steps.length - 1]; }
  // 「現在定位在中山路二段255巷，大約在12號前面，」
  function whereNow() {
    const g = gpsStreet(); if (!g) return '';
    if (!g.name && !g.no) return '現在定位不在道路上，';
    return '現在定位在' + (g.name || g.addrStreet || '') + (g.no ? '，大約在' + g.no + '號前面' : '') + '，';
  }
  function checkMarks(p, now) {
    for (const mk of st.marks) {
      if (nav.markSaid.has(mk.id)) continue;
      if (C.dist(p, [mk.lat, mk.lon]) <= 20) {
        nav.markSaid.add(mk.id);
        const k = MARK[mk.type] || MARK.other;
        setTimeout(() => say(k.say + (mk.note && mk.type === 'other' ? '：' + mk.note : ''), { noLast: true, queue: true }), 300);
      }
    }
  }
  function currentInstruction() {
    if (!nav) return '';
    const m = nav.route.maneuvers[nav.mi], s = nav.tr.s;
    if (!m) return '';
    if (m.type === 'start') { const nx = nav.route.maneuvers[1]; return m.text.replace(/^開始派報，?/, '') + (nx && nx.type !== 'end' ? `，${sayDist(nx.d - s)}後${nx.dir}` : ''); }
    if (m.type === 'end') return nav.route.back ? `再${sayDist(m.d - s)}就到停車的地方` : `再${sayDist(m.d - s)}，${m.text}`;
    return `${whereNow()}${r5(m.d - s)}公尺後${m.text}`;
  }
  function skipStreet() {
    if (!nav) return;
    const R = nav.route, s = nav.tr.s;
    let step = R.steps.find(x => x.d1 > s + 2 && !x.dead && st.net.chains[x.c].req && !isDone(st.net.chains[x.c]));
    if (!step) { say('前面沒有要跳過的街道'); return; }
    const c0 = st.net.chains[step.c];
    let n = 0;
    for (const c of reqChains()) {
      if (isDone(c)) continue;
      if (c === c0 || (c.wayId === c0.wayId && c0.name && c.name === c0.name)) { st.skipped.add(c.key); restyle(c.i); n++; }
    }
    saveProgress(true);
    reroute(`已跳過${c0.name || '這條'}`);
  }

  // 「這條派完了」：目前這段（或旁邊最近的街道）標成已派
  function streetDone() {
    if (!st.net) return;
    let it = null;
    if (nav) {
      const s = nav.tr.s, stp = nav.route.steps.find(x => x.d1 > s) || null;
      if (stp && !stp.dead) it = { c: stp.c, side: stp.side };
    }
    if (!it && gps.fix) {
      const p = [gps.fix.lat, gps.fix.lon], nc = C.nearestChain(st.net, p, 30, c => c.req);
      if (nc) { const c = st.net.chains[nc.c]; it = { c: c.i, side: c.two ? sideOfPoint(c, p) : null }; }
    }
    if (!it) { say('找不到現在這條街，請在地圖上點「已派」修改', { noLast: true }); return; }
    const c = st.net.chains[it.c];
    markItem(it); restyle(c.i); saveProgress(true); renderBlocks();
    const msg = '好，' + (c.name || '這段') + (it.side ? '的這一邊' : '') + '標成派完了';
    if (nav) reroute(msg); else { say(msg, { noLast: true }); toast(msg); }
  }
  // 點在大馬路的哪一邊：a→b 方向的右手邊是 f
  function sideOfPoint(c, p) {
    let best = null;
    for (let k = 1; k < c.coords.length; k++) { const pr = C.projSeg(p, c.coords[k - 1], c.coords[k]); if (!best || pr.d < best.d) best = { d: pr.d, a: c.coords[k - 1], b: c.coords[k] }; }
    const kx = Math.cos(p[0] * Math.PI / 180);
    const ax = best.a[1] * kx, ay = best.a[0], bx = best.b[1] * kx, by = best.b[0], px = p[1] * kx, py = p[0];
    return ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) < 0 ? 'f' : 'b';
  }

  /* ---------- 語音指令 ---------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  // 聽到一句話：回傳 'done'（處理完）、'more'（還要繼續聽，例如相機開著或等地址）、'unknown'（聽不懂）、'echo'（是自己念的）
  let awaitAddr = 0;
  const heard = LS.get('heard', []);
  function logHeard(t, what) { heard.unshift({ t: Date.now(), s: t, r: what }); heard.length = Math.min(heard.length, 15); LS.set('heard', heard); }
  function isEcho(t) {
    if (Date.now() > spoke.until || !spoke.text) return false;
    const a = C.norm(t), b = C.norm(spoke.text); if (!a) return true;
    let hit = 0; for (const ch of a) if (b.includes(ch)) hit++;
    return hit / a.length > 0.6;
  }
  function handleHeard(alts) {
    const t0 = alts[0] || '';
    if (isEcho(t0)) return 'echo';
    if (awaitAddr && Date.now() - awaitAddr < 25000) {
      awaitAddr = 0;
      if (/取消|算了|不用了/.test(t0)) { say('好，取消重新定位', { noLast: true }); logHeard(t0, '取消重新定位'); return 'done'; }
      const addr = C.norm(t0).replace(/^(我)?(現在)?(是)?(在|到)?/, '').replace(/(這邊|這裡|附近|旁邊|前面|門口)+$/, '');
      logHeard(t0, '重新定位到：' + addr);
      correctByText(addr);
      return 'done';
    }
    let c = null, raw = t0;
    for (const a of alts) { const x = C.parseCommand(a); if (x.cmd !== 'unknown' && x.cmd !== 'none') { c = x; raw = a; break; } }
    if (!c) { logHeard(t0, '聽不懂'); return 'unknown'; }
    logHeard(raw, CMD_NAME[c.cmd] || c.cmd);
    doCmd(c, raw);
    return cam.on || awaitAddr ? 'more' : 'done';
  }
  const CMD_NAME = { pause: '暫停', resume: '繼續', repeat: '重複', skip: '跳過', reroute: '重新規劃', progress: '進度', mark: '標記', locate: '重新定位', relocate: '重新定位（等地址）', stop: '結束', toilet: '找廁所', nextpark: '下一個停車點', streetdone: '這條派完了', campre: '準備拍照', photo: '拍照', camclose: '關相機' };

  // 導航中語音待命：不用按按鈕，直接說
  const hf = { on: false, rec: null, want: false, fails: 0 };
  function hfStart() {
    if (!SR || !S.handsFree) return;
    hf.want = true;
    if (hf.on) return;
    try { if (rec) rec.abort(); } catch (e) { /* 無 */ }
    const r = new SR(); r.lang = 'zh-TW'; r.interimResults = false; r.maxAlternatives = 4; r.continuous = true;
    hf.rec = r;
    r.onstart = () => { hf.on = true; hf.fails = 0; hfShow(); };
    r.onresult = e => {
      const res = e.results[e.results.length - 1]; if (!res.isFinal) return;
      const alts = [...res].map(a => a.transcript);
      const out = handleHeard(alts);
      if (out === 'unknown') $('#hfPill').textContent = '🎙 聽到：' + alts[0].slice(0, 12);
      else hfShow();
    };
    r.onerror = e => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { hf.want = false; toast('語音待命需要麥克風權限：請到「設定 › Safari › 麥克風」允許', 6000); } };
    r.onend = () => {
      hf.on = false; hf.rec = null; hfShow();
      if (hf.want && nav) setTimeout(() => { if (hf.want && nav && !hf.on) { hf.fails++; if (hf.fails > 5) { hf.want = false; hfShow(); return; } hfStart(); } }, 350);
    };
    try { r.start(); } catch (e) { hf.on = false; hfShow(); }
  }
  function hfStop() { hf.want = false; try { if (hf.rec) hf.rec.abort(); } catch (e) { /* 無 */ } hf.on = false; hfShow(); }
  function hfShow() {
    const p = $('#hfPill'); if (!p) return;
    p.style.display = nav && S.handsFree && SR ? '' : 'none';
    p.classList.toggle('off', !hf.on);
    p.textContent = hf.on ? '🎙 語音待命中' : '🎙 語音停了，按這裡開啟';
  }
  $('#hfPill').onclick = () => { hf.fails = 0; hfStart(); };

  function listen(onText) {
    // 導航中語音已經在待命：直接說就可以
    if (!onText && hf.on) { beep(880, 80); toast('語音待命中，直接說就可以'); return; }
    if (!onText && nav && S.handsFree) { hf.fails = 0; hfStart(); beep(880, 80); return; }
    if (!SR) {
      const t = window.prompt('這支手機的 Safari 不能語音輸入，請打字輸入指令：');
      if (t) onText ? onText(t) : runText(t);
      return;
    }
    if (rec) { try { rec.abort(); } catch (e) { /* 無 */ } }
    if (tts.ok) speechSynthesis.cancel();
    // 連續聽：一次按鈕可以接著說好幾句（例如「準備拍照」→「照相」）
    rec = new SR(); rec.lang = 'zh-TW'; rec.interimResults = false; rec.maxAlternatives = 4; rec.continuous = !onText;
    const box = $('#listen'); $('#listenText').textContent = onText ? '請說門牌或巷名' : '請說指令';
    if (!cam.on) box.style.display = 'flex';
    beep(880, 100);
    let got = false, tmo = 0;
    const arm = ms => { clearTimeout(tmo); tmo = setTimeout(() => { try { rec.stop(); } catch (e) { /* 無 */ } }, ms); };
    arm(8000);
    const r0 = rec;
    rec.onresult = e => {
      got = true; box.style.display = 'none';
      const res = e.results[e.results.length - 1];
      const alts = [...res].map(a => a.transcript);
      if (onText) { clearTimeout(tmo); return onText(alts[0]); }
      const out = handleHeard(alts);
      if (out === 'unknown') {
        if (cam.on || awaitAddr) { arm(20000); return; }
        const m = '聽不懂「' + alts[0] + '」，可以說：重新定位、準備拍照、重複、進度、暫停'; toast(m, 5000); say('聽不懂，請再說一次', { noLast: true });
        arm(10000); return; // 再給一次機會
      }
      if (out === 'more' || out === 'echo') arm(20000);
      else { clearTimeout(tmo); try { r0.stop(); } catch (err) { /* 無 */ } }
    };
    rec.onerror = e => {
      clearTimeout(tmo); box.style.display = 'none';
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('請到「設定 › 一般 › 鍵盤」打開「聽寫」，並允許 Safari 使用麥克風', 6000);
      else if (e.error !== 'aborted' && e.error !== 'no-speech') toast('沒聽清楚，請再按一次');
    };
    rec.onend = () => { clearTimeout(tmo); box.style.display = 'none'; if (!got) beep(440, 90); if (cam.on) $('#camHint').textContent = '按白色按鈕拍照（要用語音，再按一下「說」）'; };
    try { rec.start(); } catch (e) { box.style.display = 'none'; toast('語音辨識無法啟動'); }
  }
  $('#listen').addEventListener('click', () => { try { rec && rec.abort(); } catch (e) { /* 無 */ } $('#listen').style.display = 'none'; });
  function runText(t) { doCmd(C.parseCommand(t), t); }
  function doCmd(c, raw) {
    switch (c.cmd) {
      case 'pause': if (nav) { nav.paused = true; $('#btnPause').classList.add('on'); $('#btnPause').textContent = '繼續'; if (tts.ok) speechSynthesis.cancel(); toast('語音暫停，路線和進度照常記錄'); updateCard(nav.tr.s); } break;
      case 'resume': if (nav) { nav.paused = false; $('#btnPause').classList.remove('on'); $('#btnPause').textContent = '暫停'; say('繼續導航。' + currentInstruction()); } else toast('按「開始派報」開始'); break;
      case 'repeat': if (nav) say(currentInstruction(), { noLast: true }); break;
      case 'skip': skipStreet(); break;
      case 'reroute': if (nav) reroute('重新規劃'); break;
      case 'progress': {
        const p = progressNums(), lf = Math.round(flyersOf(remainingItems()));
        let m = `整個區塊已派${p.all ? Math.floor(p.done / p.all * 100) : 0}%，還剩大約${lf}張`;
        if (nav && nav.loop) { const lr = loopRemaining(); m = (nav.loop.phase === 'return' ? '這一圈派完了，正在走回停車的地方。' : `這一圈還剩大約${Math.round(flyersOf(lr))}張。`) + m; }
        say(m, { noLast: true }); toast(m); break;
      }
      case 'toilet': findToilet(); break;
      case 'relocate': awaitAddr = Date.now(); say('好，請說你現在的位置，例如萬大路410號，或萬大路449巷口', { noLast: true }); toast('請說你現在的位置'); break;
      case 'campre': openCam(true); break;
      case 'photo': if (cam.on) shoot(); else openCam(true, true); break;
      case 'camclose': closeCam(); say('相機關了', { noLast: true }); break;
      case 'nextpark': sayNextPark(); break;
      case 'streetdone': streetDone(); break;
      case 'mark': addMark(c.arg, c.arg === 'other' ? c.note : ''); break;
      case 'locate': correctByText(c.arg); break;
      case 'stop': if (nav) askConfirm('要結束這次導航嗎？', '派報進度會保留，下次可以接著派。', '結束導航').then(ok => { if (ok) stopNav(); }); break;
      default: { const m = '聽不懂「' + (raw || '') + '」，請再說一次'; toast(m); if (nav) say(m, { noLast: true }); }
    }
  }

  /* ---------- 圈選區塊 ---------- */
  let draw = null;
  function startDraw() {
    closeSheets(); if (nav) return;
    draw = { pts: [] }; setMode('draw'); updateDraw();
  }
  function updateDraw() {
    L_draw.clearLayers();
    const pts = draw.pts;
    if (pts.length) {
      const line = L.polyline(pts.length >= 3 ? pts.concat([pts[0]]) : pts, { color: '#1F4E9E', weight: 3, dashArray: '8 6', interactive: false }).addTo(L_draw);
      const fill = pts.length >= 3 ? L.polygon(pts, { stroke: false, fillColor: '#1F4E9E', fillOpacity: 0.08, interactive: false }).addTo(L_draw) : null;
      pts.forEach((p, i) => {
        const mk = L.marker(p, { draggable: true, autoPan: true, autoPanPadding: [70, 70], keyboard: false, icon: L.divIcon({ className: '', html: `<div class="vtx">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(L_draw);
        mk.on('drag', e => {
          const ll = e.target.getLatLng(); pts[i] = [ll.lat, ll.lng];
          line.setLatLngs(pts.length >= 3 ? pts.concat([pts[0]]) : pts);
          if (fill) fill.setLatLngs(pts);
        });
        mk.on('dragend', updateDraw);
      });
    }
    $('#drawTip').textContent = pts.length < 3 ? `點地圖加角落，已加 ${pts.length} 點，至少要 3 點。` : `已加 ${pts.length} 點，可以繼續加，或按「完成」。`;
    $('#drawDone').disabled = pts.length < 3; $('#drawDone').style.opacity = pts.length < 3 ? 0.5 : 1;
  }
  function addDrawPoint(p) {
    draw.pts.push(p); updateDraw();
    // 點在畫面邊緣時自動移動地圖，方便繼續往外點
    map.panInside(p, { paddingTopLeft: [80, 120], paddingBottomRight: [80, 230] });
  }
  function endDraw() { draw = null; L_draw.clearLayers(); setMode('idle'); }

  // 名稱輸入面板
  let nameCb = null;
  function askName(title, def, cb) {
    $('#nameTitle').textContent = title; $('#nameInput').value = def || ''; nameCb = cb;
    openSheet('shName'); setTimeout(() => $('#nameInput').focus(), 250);
  }
  $('#nameOk').onclick = () => { const v = $('#nameInput').value.trim(); closeSheets(); if (nameCb) nameCb(v); nameCb = null; };

  /* ---------- 經緯度輸入 ---------- */
  function parseCoords(text) {
    const pts = [];
    for (const line of text.split(/\n|;/)) {
      const nums = (line.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      if (nums.length < 2) continue;
      let [a, b] = nums;
      if (a > 90 && b <= 90) [a, b] = [b, a]; // 經度寫在前面就自動對調
      if (Math.abs(a) > 90 || Math.abs(b) > 180) continue;
      pts.push([a, b]);
    }
    if (pts.length === 2) {
      const [p, q] = pts;
      return [[p[0], p[1]], [p[0], q[1]], [q[0], q[1]], [q[0], p[1]]];
    }
    return pts;
  }

  /* ---------- 面板 ---------- */
  function openSheet(id) {
    closeSheets(true);
    if (id === 'shBlocks') renderBlockList();
    if (id === 'shSettings' || id === 'shLayer') syncSettingsUI();
    if (id === 'shSettings') { loadToday(); renderHeard(); }
    $('#backdrop').style.display = 'block'; $('#' + id).classList.add('open');
  }
  function closeSheets(keepBackdrop) {
    $$('.sheet.open').forEach(s => s.classList.remove('open'));
    if (!keepBackdrop) $('#backdrop').style.display = 'none';
  }
  $('#backdrop').onclick = () => { closeSheets(); if (cfResolve) { const r = cfResolve; cfResolve = null; r(false); } };
  // App 內的確認畫面（不用瀏覽器的 confirm，iPhone 主畫面 App 有時不會跳出）
  let cfResolve = null, cfPrev = null;
  function askConfirm(msg, note, okText, danger) {
    return new Promise(res => {
      if (cfResolve) cfResolve(false);
      $('#cfMsg').textContent = msg; $('#cfNote').textContent = note || ''; $('#cfNote').style.display = note ? '' : 'none';
      const ok = $('#cfOk'); ok.textContent = okText || '確定'; ok.classList.toggle('dangerfill', !!danger);
      const prev = document.querySelector('.sheet.open'); cfPrev = prev && prev.id !== 'shConfirm' ? prev.id : null;
      cfResolve = res; openSheet('shConfirm');
    });
  }
  const cfDone = v => { const r = cfResolve, prev = cfPrev; cfResolve = null; cfPrev = null; closeSheets(); if (r) r(v); if (prev) openSheet(prev); };
  $('#cfOk').onclick = () => cfDone(true);
  $('#cfCancel').onclick = () => cfDone(false);
  $$('.sheet').forEach(sh => { const x = document.createElement('button'); x.className = 'x'; x.setAttribute('aria-label', '關閉'); x.textContent = '✕'; x.onclick = () => closeSheets(); sh.prepend(x); });
  $$('[data-close]').forEach(b => (b.onclick = () => closeSheets()));

  function renderBlockList() {
    const box = $('#blkList');
    if (!st.blocks.length) { box.innerHTML = '<div class="empty">還沒有區塊。<br>按「在地圖上圈選」，在地圖上點出要派報的範圍。</div>'; return; }
    box.innerHTML = st.blocks.map(b => {
      const cur = st.block && st.block.id === b.id;
      const p = LS.get('prog_' + b.id, { c: [], s: [] });
      let pc = '';
      if (cur && st.net) pc = pct() + '%';
      const has = !!localStorage.getItem('pb_net_' + b.id);
      return `<div class="blk${cur ? ' cur' : ''}" data-id="${b.id}">
        <div class="hd"><b>${esc(b.name)}</b><span class="meta">${cur ? '使用中' : ''}</span></div>
        <div class="meta">${has ? (cur ? `已派 ${pc}` : `已派 ${p.c.length + p.s.length} 段街道`) : '還沒下載圖資'}${LS.get('rec_' + b.id, []).length ? `，有 ${LS.get('rec_' + b.id, []).length} 筆派報紀錄` : ''}</div>
        ${cur && st.net ? `<div class="bar"><i style="width:${pct()}%"></i></div>` : ''}
        <div class="btnrow">
          ${cur ? '' : '<button class="btn sm primary" data-act="use">使用這個區塊</button>'}
          <button class="btn sm" data-act="show">${b.show ? '隱藏框線' : '顯示框線'}</button>
          <button class="btn sm" data-act="shape">修改範圍</button>
          <button class="btn sm" data-act="rename">改名</button>
          ${cur ? '<button class="btn sm primary" data-act="done">記錄完成</button><button class="btn sm" data-act="recs">派報紀錄</button><button class="btn sm" data-act="photos">照片</button><button class="btn sm" data-act="reset">重設進度</button><button class="btn sm" data-act="dl">重新下載圖資</button>' : ''}
          <button class="btn sm danger" data-act="del">刪除</button>
        </div></div>`;
    }).join('');
  }
  $('#blkList').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const id = btn.closest('.blk').dataset.id, b = st.blocks.find(x => x.id === id), act = btn.dataset.act;
    if (act === 'use') { closeSheets(); selectBlock(id); }
    else if (act === 'show') { b.show = !b.show; saveBlocks(); renderBlocks(); renderBlockList(); }
    else if (act === 'shape') { closeSheets(); if (!st.block || st.block.id !== id) selectBlock(id); startBlockEdit(); }
    else if (act === 'rename') askName('區塊改名', b.name, v => { if (v) { b.name = v; saveBlocks(); renderBlocks(); } });
    else if (act === 'reset') { askConfirm('重設「' + b.name + '」的進度？', '已派、跳過的紀錄會全部清掉，從頭開始。', '重設進度', true).then(ok => { if (!ok) return; st.covered.clear(); st.skipped.clear(); st.hits.clear(); saveProgress(true); renderNet(); renderBlocks(); toast('進度已重設'); }); }
    else if (act === 'dl') { closeSheets(); downloadNet(); }
    else if (act === 'done') { closeSheets(); askCompleteBlock(false); }
    else if (act === 'recs') { renderRecList(); openSheet('shRecs'); }
    else if (act === 'photos') openPhotoList();
    else if (act === 'del') { askConfirm('刪除「' + b.name + '」？', '區塊、圖資和目前進度會刪除；這個區塊的派報紀錄和照片會保留。', '刪除區塊', true).then(ok => { if (!ok) return; deleteBlock(id); toast('已刪除「' + b.name + '」'); }); }
  });

  /* ---------- 設定 ---------- */
  function syncSettingsUI() {
    $$('[data-set]').forEach(el => {
      const k = el.dataset.set;
      if (el.type === 'checkbox') el.checked = !!S[k]; else el.value = S[k];
    });
    $$('[data-show]').forEach(el => {
      const k = el.dataset.show, v = S[k];
      el.textContent = k === 'rate' ? Number(v).toFixed(2) + ' 倍' : k === 'density' ? v + ' 張' : k === 'stepLen' ? Number(v).toFixed(2) + ' 公尺' : (k === 'preDist' && +v === 0 ? '不預告' : v + ' 公尺');
    });
    $$('#layerBtns .btn').forEach(b => b.classList.toggle('primary', b.dataset.layer === S.layer));
  }
  $$('[data-set]').forEach(el => {
    el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
      const k = el.dataset.set;
      const old = S[k];
      const v = el.value;
      S[k] = el.type === 'checkbox' ? el.checked : (v !== '' && !isNaN(v) ? Number(v) : v);
      saveSettings(); syncSettingsUI();
      if (k === 'showAddr') renderAddrs();
      if (k === 'showWC') { renderWC(); if (S.showWC && st.block && !wcList()) fetchWC(st.block, true); }
      if (k === 'twoMode' && st.block) selectBlock(st.block.id, false);
      if (k === 'orient') applyOrient(true);
      if (k === 'includePaths' && old !== S[k] && st.block) { st.net = null; downloadNet(); }
      if (k === 'earBtn' && nav) setupEarButtons(S.earBtn);
    });
  });
  $('#ttsTest').onclick = () => say(`前方${S.preDist || 30}公尺右轉，進入中山路一段120巷。${S.nearDist}公尺後右轉。`, { noLast: true });
  $('#wipeAll').onclick = () => {
    askConfirm('刪除區塊與進度？', '區塊、進度、標記和設定會刪除。派報紀錄、照片和升級前備份會保留，不會刪。', '刪除', true).then(ok => { if (!ok) return;
    Object.keys(localStorage).filter(k => k.startsWith('pb_') && !/^pb_(rec_|bak_|archived)/.test(k)).forEach(k => localStorage.removeItem(k));
    location.reload(); });
  };
  $$('#layerBtns .btn').forEach(b => (b.onclick = () => { setLayer(b.dataset.layer); }));

  /* ---------- 修改區塊範圍 ---------- */
  let be = null; // { poly, inc, exc, sel, undo[], orig }
  const L_be = L.layerGroup().addTo(map);
  function startBlockEdit() {
    if (nav || !st.block) return;
    const b = st.block;
    be = { poly: b.poly.map(p => p.slice()), inc: (b.inc || []).slice(), exc: (b.exc || []).slice(), two: (b.two || []).slice(), one: (b.one || []).slice(), sel: -1, undo: [] };
    if (!b.dl) b.dl = C.bbox(b.poly, 200);
    setMode('bedit');
    map.fitBounds(L.latLngBounds(b.poly), { padding: [40, 40] });
    $('#beditTip').textContent = '修改「' + b.name + '」的範圍';
    renderBlocks(); bePreview();
  }
  function beSnap() { be.undo.push({ poly: be.poly.map(p => p.slice()), inc: be.inc.slice(), exc: be.exc.slice(), two: be.two.slice(), one: be.one.slice() }); if (be.undo.length > 40) be.undo.shift(); }
  function beDraw() {
    L_be.clearLayers();
    const pts = be.poly;
    L.polygon(pts, { color: '#1F4E9E', weight: 3, dashArray: '8 6', fillColor: '#1F4E9E', fillOpacity: 0.06, interactive: false }).addTo(L_be);
    const line = L_be.getLayers()[0];
    pts.forEach((p, i) => {
      const mk = L.marker(p, { draggable: true, autoPan: true, autoPanPadding: [70, 70], keyboard: false, zIndexOffset: 1000, icon: L.divIcon({ className: '', html: `<div class="vtx${be.sel === i ? ' sel' : ''}">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(L_be);
      mk.on('dragstart', () => beSnap());
      mk.on('drag', e => { const ll = e.target.getLatLng(); pts[i] = [ll.lat, ll.lng]; line.setLatLngs(pts); });
      mk.on('dragend', () => { be.sel = -1; bePreview(); });
      mk.on('click', () => { be.sel = be.sel === i ? -1 : i; beDraw(); });
    });
    // 兩點中間的＋：點一下或拖動就加一個點
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const mk = L.marker(m, { draggable: true, keyboard: false, zIndexOffset: 900, icon: L.divIcon({ className: '', html: '<div class="mid">+</div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(L_be);
      const insert = ll => { beSnap(); pts.splice(i + 1, 0, ll); be.sel = i + 1; bePreview(); };
      mk.on('click', () => insert(m));
      mk.on('dragend', e => { const ll = e.target.getLatLng(); insert([ll.lat, ll.lng]); });
    });
    $('#beDel').disabled = be.sel < 0 || pts.length <= 3; $('#beDel').style.opacity = $('#beDel').disabled ? 0.5 : 1;
    $('#beUndo').disabled = !be.undo.length; $('#beUndo').style.opacity = be.undo.length ? 1 : 0.5;
  }
  // 即時預覽：哪些街道會被派（橘色）
  function bePreview() {
    const raw = LS.get('net_' + st.block.id, null);
    if (raw) {
      st.net = buildNet(raw, { inc: be.inc, exc: be.exc, two: be.two, one: be.one }, be.poly);
      renderNet();
    }
    beDraw();
    const [s, w, n, e] = C.bbox(be.poly, 0), d = st.block.dl;
    be.outside = !d || s < d[0] || w < d[1] || n > d[2] || e > d[3];
    const nReq = st.net ? st.net.chains.filter(c => c.req).length : 0;
    $('#beditTip').textContent = `修改「${st.block.name}」：${be.poly.length} 個角，${nReq} 段街道要派` + (be.outside ? '（超出原本圖資，儲存後會重新下載）' : '');
  }
  function endBlockEdit(save) {
    const b = st.block;
    if (save) {
      b.poly = be.poly; b.inc = be.inc; b.exc = be.exc; b.two = be.two; b.one = be.one; saveBlocks();
    }
    const outside = save && be.outside;
    be = null; L_be.clearLayers(); setMode('idle');
    if (outside) { selectBlock(b.id, false); downloadNet(); toast('範圍已儲存，重新下載圖資中'); }
    else { selectBlock(b.id, false); if (save) toast('範圍已儲存'); }
  }
  $('#beUndo').onclick = () => { if (!be || !be.undo.length) return; const u = be.undo.pop(); Object.assign(be, u); be.sel = -1; bePreview(); };
  $('#beDel').onclick = () => { if (!be || be.sel < 0 || be.poly.length <= 3) return; beSnap(); be.poly.splice(be.sel, 1); be.sel = -1; bePreview(); };
  $('#beCancel').onclick = () => { if (be) endBlockEdit(false); };
  $('#beSave').onclick = () => { if (be) endBlockEdit(true); };

  /* ---------- 版本與更新檢查 ---------- */
  let newVer = null;
  async function checkUpdate(manual) {
    if (manual) $('#verStatus').textContent = '檢查中…';
    try {
      const res = await fetch(location.pathname + '?check=' + Date.now(), { cache: 'no-store' });
      const t = await res.text();
      const m = t.match(/APP_VERSION = '([\d.]+)'/);
      if (!m) throw new Error('no version');
      const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
      if (cmp(m[1], APP_VERSION) > 0) {
        newVer = m[1];
        $('#verStatus').textContent = '有新版本 v' + newVer + '，按畫面上方的藍色按鈕更新';
        $('#updBar').textContent = '有新版本 v' + newVer + '，按這裡更新';
        $('#updBar').style.display = 'block';
      } else {
        $('#verStatus').textContent = '已是最新版本（' + new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) + ' 檢查）';
        if (manual) toast('已是最新版本 v' + APP_VERSION);
      }
    } catch (e) {
      $('#verStatus').textContent = '無法檢查更新（可能沒有網路）';
      if (manual) toast('無法檢查更新，請確認網路');
    }
  }
  $('#updBar').onclick = () => {
    if (nav) { toast('導航中先不更新，結束導航後再按'); return; }
    location.replace(location.pathname + '?v=' + (newVer || Date.now()));
  };
  $('#verCheck').onclick = () => checkUpdate(true);
  // 開始一圈
  $('#stCap').addEventListener('input', updateStartInfo);
  $('#stLoop').addEventListener('change', updateStartInfo);
  $('#stGo').onclick = () => {
    const cap = Math.max(20, parseInt($('#stCap').value, 10) || 400), loop = $('#stLoop').checked;
    S.cap = cap; S.loopMode = loop; saveSettings();
    closeSheets(); beginNav(cap, loop);
  };
  $('#stPreview').onclick = previewLoops;
  // 一圈結束
  $('#ldSave').onclick = () => {
    const n = parseInt($('#ldActual').value, 10);
    if (!lastLoop || !(n > 0)) { toast('請輸入這一圈實際發了幾張'); return; }
    lastLoop.actual = n; sessSave(true);
    if (lastLoop.sides100 > 0.5) {
      const measured = n / lastLoop.sides100;
      S.density = Math.max(1, Math.min(80, Math.round((S.density * 0.5 + measured * 0.5) * 10) / 10)); saveSettings();
      toast(`已更新估計：每 100 公尺單邊約 ${S.density} 張`);
    } else toast('已記下張數');
  };
  $('#ldNav').onclick = () => { if (nextPark) window.open(appleMaps(nextPark.p, 'd'), '_blank'); };
  $('#ldShow').onclick = () => { if (nextPark) { closeSheets(); st.follow = false; $('#fabFollow').classList.remove('on'); map.setView(nextPark.p, 17); } };
  $('#ldNextLoop').onclick = () => { closeSheets(); beginNav(S.cap, true); };
  $('#ldComplete').onclick = () => { closeSheets(); askCompleteBlock(false); };
  // 派報紀錄
  $('#recList').addEventListener('click', e => {
    const btn = e.target.closest('[data-ract]'); if (!btn || !st.block) return;
    const recs = LS.get('rec_' + st.block.id, []), r = recs.find(x => x.id === btn.closest('[data-rid]').dataset.rid); if (!r) return;
    const act = btn.dataset.ract;
    if (act === 'show') { closeSheets(); st.follow = false; $('#fabFollow').classList.remove('on'); showRecord(r); }
    else if (act === 'gpx') download(`派報_${st.block.name}_${new Date(r.t1).toISOString().slice(0, 10)}.gpx`, gpx(r), 'application/gpx+xml');
  });
  $('#fabRec').onclick = () => { L_rec.clearLayers(); $('#fabRec').style.display = 'none'; };
  // 公廁
  $('#fabWC').onclick = findToilet;
  $('#wcFind').onclick = () => { closeSheets(); findToilet(); };
  // 備份
  $('#bkExport').onclick = () => {
    const data = {}; for (const k of Object.keys(localStorage)) if (k.startsWith('pb_')) data[k] = localStorage.getItem(k);
    download('派報系統備份_' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify({ app: 'paibao', v: APP_VERSION, t: Date.now(), data }), 'application/json');
  };
  $('#bkImport').onclick = () => $('#bkFile').click();
  // 還原備份時，派報紀錄用「合併」：手機裡已有的紀錄不會被蓋掉
  function mergeRecs(keep) {
    for (const [k, v] of Object.entries(keep)) {
      let cur = [], old = [];
      try { cur = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { cur = []; }
      try { old = JSON.parse(v || '[]'); } catch (e) { old = []; }
      const ids = new Set(cur.map(r => r.id || JSON.stringify(r)));
      for (const r of old) if (!ids.has(r.id || JSON.stringify(r))) cur.push(r);
      localStorage.setItem(k, JSON.stringify(cur));
    }
  }
  $('#bkFile').onchange = () => {
    const f = $('#bkFile').files[0]; if (!f) return;
    f.text().then(t => {
      let j; try { j = JSON.parse(t); } catch (e) { toast('這不是派報系統的備份檔'); return; }
      if (!j || j.app !== 'paibao' || !j.data) { toast('這不是派報系統的備份檔'); return; }
      askConfirm('用備份還原？', '手機裡現在的區塊和進度會被備份檔的內容取代。', '還原', true).then(ok => {
        if (!ok) return;
        const keep = {}; for (const k of Object.keys(localStorage)) if (/^pb_(rec_|archived)/.test(k)) keep[k] = localStorage.getItem(k);
        for (const k of Object.keys(localStorage)) if (k.startsWith('pb_') && !/^pb_(rec_|bak_|archived)/.test(k)) localStorage.removeItem(k);
        for (const [k, v] of Object.entries(j.data)) localStorage.setItem(k, v);
        mergeRecs(keep);
        location.reload();
      });
    });
  };
  $('#bkRestore160').onclick = () => {
    let j; try { j = JSON.parse(localStorage.getItem('pb_bak_160')); } catch (e) { j = null; }
    if (!j || !j.data) { toast('沒有升級前的備份'); return; }
    askConfirm('還原到升級前的進度？', '會把區塊、進度和標記改回 ' + new Date(j.t).toLocaleString('zh-TW') + ' 升級前的狀態（圖資保留）。', '還原', true).then(ok => {
      if (!ok) return;
      const keep = {}; for (const k of Object.keys(localStorage)) if (/^pb_(rec_|archived)/.test(k)) keep[k] = localStorage.getItem(k);
      for (const k of Object.keys(localStorage)) if (k.startsWith('pb_') && !k.startsWith('pb_net_') && !/^pb_(rec_|bak_|archived)/.test(k)) localStorage.removeItem(k);
      for (const [k, v] of Object.entries(j.data)) localStorage.setItem(k, v);
      mergeRecs(keep);
      location.reload();
    });
  };

  /* ---------- 地圖點擊 ---------- */
  map.on('click', e => {
    const p = [e.latlng.lat, e.latlng.lng];
    if (st.mode === 'draw') { addDrawPoint(p); }
    else if (st.mode === 'pick') { setMode(nav ? 'nav' : 'idle'); applyCorrection(p, ''); }
    else if (st.mode === 'bedit') {
      if (!be || !st.net) return;
      const nc = C.nearestChain(st.net, p, 20, c => !c.virtual);
      if (!nc) { toast('請點在街道上'); return; }
      const c = st.net.chains[nc.c];
      beSnap();
      const inc = new Set(be.inc), exc = new Set(be.exc), two = new Set(be.two), one = new Set(be.one);
      const nm = c.name || '這段街道';
      if (!c.req) { exc.delete(c.key); inc.add(c.key); two.delete(c.key); one.add(c.key); toast('加入：' + nm + '（兩邊一次派）'); }
      else if (!c.two) { two.add(c.key); one.delete(c.key); toast(nm + '：改成大馬路，兩邊分開派'); }
      else { inc.delete(c.key); exc.add(c.key); toast('排除：' + nm + '（不派）'); }
      be.inc = [...inc]; be.exc = [...exc]; be.two = [...two]; be.one = [...one];
      bePreview();
    }
    else if (st.mode === 'edit') {
      if (!st.net) return;
      const nc = C.nearestChain(st.net, p, 25, c => c.req);
      if (!nc) { toast('請點在橘色或綠色的街道上'); return; }
      const c = st.net.chains[nc.c];
      if (c.two) {
        const sd = sideOfPoint(c, p), other = sd === 'f' ? 'b' : 'f';
        if (st.covered.has(c.key) || st.skipped.has(c.key)) { st.covered.delete(c.key); st.skipped.delete(c.key); st.covered.add(c.key + ':' + other); }
        else if (st.covered.has(c.key + ':' + sd)) st.covered.delete(c.key + ':' + sd);
        else st.covered.add(c.key + ':' + sd);
        toast((c.name || '這段') + '：' + ((sd === 'f') === c.fShun ? '紅色（順向）' : '黑色（逆向）') + (c.oddSide ? (sd === c.oddSide ? '單號' : '雙號') : '') + '這一邊' + (sideDone(c, sd) ? '已派' : '改為未派'));
      } else if (isDone(c)) { st.covered.delete(c.key); st.skipped.delete(c.key); st.hits.delete(c.key); }
      else st.covered.add(c.key);
      restyle(c.i); saveProgress(true); renderBlocks();
    }
  });

  /* ---------- 按鈕 ---------- */
  $('#btnDraw').onclick = startDraw;
  $('#blkDraw').onclick = startDraw;
  $('#btnBlocks').onclick = $('#btnBlock').onclick = () => { if (!nav) openSheet('shBlocks'); };
  $('#btnSettings').onclick = () => openSheet('shSettings');
  $('#btnStart').onclick = startNav;
  $('#blkCoords').onclick = () => { $('#coordText').value = ''; $('#coordName').value = ''; openSheet('shCoords'); };
  $('#blkHideAll').onclick = () => { st.blocks.forEach(b => (b.show = false)); saveBlocks(); renderBlocks(); renderBlockList(); toast('框線都隱藏了，區塊資料還在'); };
  $('#coordSave').onclick = () => {
    const pts = parseCoords($('#coordText').value);
    if (pts.length < 3) { toast('至少要 2 個點（長方形對角）或 3 個點'); return; }
    closeSheets(); createBlock(pts, $('#coordName').value.trim());
  };
  $('#drawUndo').onclick = () => { if (draw && draw.pts.length) { draw.pts.pop(); updateDraw(); } };
  $('#drawCancel').onclick = endDraw;
  $('#drawCenter').onclick = () => { if (!draw) return; const c = map.getCenter(); addDrawPoint([c.lat, c.lng]); };
  $('#drawDone').onclick = () => {
    if (!draw || draw.pts.length < 3) return;
    const pts = draw.pts.slice(); endDraw();
    askName('幫這個區塊取名字', '區塊 ' + (st.blocks.length + 1), v => createBlock(pts, v));
  };
  $('#pickCancel').onclick = () => setMode(nav ? 'nav' : 'idle');
  $('#fabEdit').onclick = () => { if (!st.net) { toast('先選一個有圖資的區塊'); return; } setMode('edit'); };
  $('#editDone').onclick = () => setMode('idle');
  $('#fabLayer').onclick = () => openSheet('shLayer');
  $('#fabOrient').onclick = () => { enableCompass(); S.orient = S.orient === 'heading' ? 'north' : 'heading'; saveSettings(); syncSettingsUI(); applyOrient(true); };
  $('#fabFollow').onclick = () => {
    enableCompass();
    st.follow = true; $('#fabFollow').classList.add('on'); setTimeout(() => updateHeading(true), 450);
    if (gps.fix) map.setView([gps.fix.lat, gps.fix.lon], Math.max(map.getZoom(), 17));
    else toast('還在等 GPS 定位');
  };
  $('#btnMic').onclick = () => listen();
  $('#btnMicIdle').onclick = () => listen();
  $('#btnRepeat').onclick = () => doCmd({ cmd: 'repeat' });
  $('#btnPause').onclick = () => doCmd({ cmd: nav && nav.paused ? 'resume' : 'pause' });
  $('#btnReroute').onclick = () => doCmd({ cmd: 'reroute' });
  $('#btnSkip').onclick = () => doCmd({ cmd: 'skip' });
  $('#btnProg').onclick = () => doCmd({ cmd: 'progress' });
  $('#btnStop').onclick = () => doCmd({ cmd: 'stop' });
  $('#btnMark').onclick = () => { $('#markNote').value = ''; openSheet('shMark'); };
  $$('[data-mark]').forEach(b => (b.onclick = () => { const note = $('#markNote').value.trim(); closeSheets(); addMark(b.dataset.mark, note); }));
  $('#btnFix').onclick = () => { $('#fixText').value = ''; openSheet('shFix'); };
  $('#fixTap').onclick = () => { closeSheets(); setMode('pick'); };
  $('#fixGo').onclick = async () => { const t = $('#fixText').value.trim(); if (!t) return; closeSheets(); await correctByText(t); };
  $('#fixVoice').onclick = () => { closeSheets(); listen(t => correctByText(t)); };
  $('#fixClear').onclick = () => { gps.corr = null; gps.kf = null; closeSheets(); toast('已改回使用 GPS'); };

  /* ---------- 啟動 ---------- */
  setLayer(S.layer);
  renderMarks();
  const last = LS.get('curBlock', null);
  if (last && st.blocks.some(b => b.id === last)) selectBlock(last);
  else renderBlocks();
  $('#fabFollow').classList.add('on');
  applyOrient(false);
  startGPS();
  setTimeout(() => checkUpdate(false), 2500);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !nav) checkUpdate(false); });
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    toast('要用 https 網址開啟，iPhone 才會給定位', 6000);
  }
  window.__pb = { map, st, gps, C, get pdr() { return pdr; }, get S() { return S; }, get nav() { return nav; }, onFix, runText, startNav };
})();
