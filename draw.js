/* Peso e baricentro – motore di disegno
 * Geometria IFC (web-ifc) -> viste ortogonali con linee nascoste rimosse -> tavola A3 (primitive in mm)
 * -> PDF (jsPDF) e DXF R12.  Nessuna dipendenza dal visualizzatore: funziona anche in Node per i test.
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ IFC
  const IFC = {api: null, models: new Map()};

  async function initIfc(WebIFC, wasmPath) {
    if (IFC.api) return IFC.api;
    const api = new WebIFC.IfcAPI();
    if (wasmPath) api.SetWasmPath(wasmPath, true);
    await api.Init(undefined, true);
    IFC.api = api; IFC.W = WebIFC;
    return api;
  }

  /** Apre un IFC e costruisce la mappa GlobalId -> expressID e la scomposizione degli assiemi */
  function openIfc(key, bytes) {
    const api = IFC.api, W = IFC.W;
    if (IFC.models.has(key)) return IFC.models.get(key);
    const id = api.OpenModel(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {COORDINATE_TO_ORIGIN: false});
    const g2e = new Map(), ids = api.GetLineIDsWithType(id, W.IFCPRODUCT, true);
    for (let i = 0; i < ids.size(); i++) { const e = ids.get(i); const l = api.GetLine(id, e, false); if (l && l.GlobalId) g2e.set(l.GlobalId.value, e); }
    const kids = new Map(), rels = api.GetLineIDsWithType(id, W.IFCRELAGGREGATES);
    for (let i = 0; i < rels.size(); i++) { const l = api.GetLine(id, rels.get(i), false); const p = l.RelatingObject.value; kids.set(p, (kids.get(p) || []).concat(l.RelatedObjects.map(o => o.value))); }
    const bolts = new Set(); try { const b = api.GetLineIDsWithType(id, W.IFCMECHANICALFASTENER, true); for (let i = 0; i < b.size(); i++) bolts.add(b.get(i)); } catch (e) {}
    const m = {id, g2e, kids, bolts, cache: new Map()};
    IFC.models.set(key, m);
    return m;
  }

  /** Mesh di un elemento in coordinate IFC Z-up (metri), con origine di riferimento ref per la precisione */
  function meshOf(m, eid, ref) {
    ref = m.ref || (m.ref = ref); // un solo punto di riferimento per modello: la cache resta coerente
    if (m.cache.has(eid)) return m.cache.get(eid);
    const api = IFC.api, fm = api.GetFlatMesh(m.id, eid), P = [], I = [];
    for (let k = 0; k < fm.geometries.size(); k++) {
      const pg = fm.geometries.get(k), geo = api.GetGeometry(m.id, pg.geometryExpressID);
      const v = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
      const ix = api.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
      const T = pg.flatTransformation, base = P.length / 3;
      for (let j = 0; j < v.length; j += 6) {
        const x = v[j], y = v[j + 1], z = v[j + 2];
        const X = T[0] * x + T[4] * y + T[8] * z + T[12], Y = T[1] * x + T[5] * y + T[9] * z + T[13], Z = T[2] * x + T[6] * y + T[10] * z + T[14];
        P.push(X - ref[0], -Z - ref[1], Y - ref[2]); // web-ifc è Y-up: riportiamo a Z-up (X, -Z, Y)
      }
      for (let j = 0; j < ix.length; j++) I.push(ix[j] + base);
    }
    const r = {pos: new Float64Array(P), idx: new Uint32Array(I), bolt: m.bolts.has(eid)};
    m.cache.set(eid, r);
    return r;
  }

  /** Espande un elemento negli elementi con geometria (assiemi -> pezzi) */
  function leaves(m, eid, out) {
    const k = m.kids.get(eid);
    if (k && k.length) k.forEach(c => leaves(m, c, out)); else out.add(eid);
    return out;
  }

  function volCentroid(mesh) {
    const p = mesh.pos, ix = mesh.idx; let V = 0, cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < ix.length; j += 3) {
      const a = ix[j] * 3, b = ix[j + 1] * 3, c = ix[j + 2] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2], bx = p[b], by = p[b + 1], bz = p[b + 2], qx = p[c], qy = p[c + 1], qz = p[c + 2];
      const v = (ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx)) / 6;
      V += v; cx += v * (ax + bx + qx) / 4; cy += v * (ay + by + qy) / 4; cz += v * (az + bz + qz) / 4;
    }
    if (Math.abs(V) < 1e-12) { // superficie aperta: media dei vertici
      let n = p.length / 3; cx = cy = cz = 0; for (let i = 0; i < p.length; i += 3) { cx += p[i]; cy += p[i + 1]; cz += p[i + 2]; }
      return {V: 0, c: [cx / n, cy / n, cz / n]};
    }
    return {V: Math.abs(V), c: [cx / V, cy / V, cz / V]};
  }
  function bboxOf(meshes) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    meshes.forEach(m => { const p = m.pos; for (let i = 0; i < p.length; i += 3) for (let d = 0; d < 3; d++) { const v = p[i + d]; if (v < mn[d]) mn[d] = v; if (v > mx[d]) mx[d] = v; } });
    return {mn, mx};
  }

  // ------------------------------------------------------------------ vettori
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  // ------------------------------------------------------------------ spigoli significativi
  function featureEdges(mesh, angleDeg) {
    const p = mesh.pos, ix = mesh.idx, key = new Map(), weld = new Int32Array(p.length / 3);
    for (let i = 0; i < p.length / 3; i++) {
      const k = Math.round(p[i * 3] * 2e3) + ',' + Math.round(p[i * 3 + 1] * 2e3) + ',' + Math.round(p[i * 3 + 2] * 2e3);
      let w = key.get(k); if (w === undefined) { w = i; key.set(k, i); } weld[i] = w;
    }
    const edges = new Map(), cosT = Math.cos(angleDeg * Math.PI / 180);
    const nrm = [];
    for (let t = 0; t < ix.length; t += 3) {
      const a = weld[ix[t]], b = weld[ix[t + 1]], c = weld[ix[t + 2]];
      if (a === b || b === c || a === c) { nrm.push(null); continue; }
      const A = [p[a * 3], p[a * 3 + 1], p[a * 3 + 2]], B = [p[b * 3], p[b * 3 + 1], p[b * 3 + 2]], C = [p[c * 3], p[c * 3 + 1], p[c * 3 + 2]];
      const n = norm(cross([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [C[0] - A[0], C[1] - A[1], C[2] - A[2]])); nrm.push(n);
      for (const [u, v] of [[a, b], [b, c], [c, a]]) { const k = u < v ? u * 4194304 + v : v * 4194304 + u; const e = edges.get(k); if (e) e.push(n); else edges.set(k, [n]); }
    }
    const out = [];
    edges.forEach((ns, k) => {
      const u = Math.floor(k / 4194304), v = k % 4194304;
      let keep = ns.length !== 2; if (!keep) keep = dot(ns[0], ns[1]) < cosT;
      if (keep) out.push([p[u * 3], p[u * 3 + 1], p[u * 3 + 2], p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]);
    });
    return out;
  }

  // ------------------------------------------------------------------ proiezione con linee nascoste
  /** view: {f: direzione di vista, up}; restituisce segmenti visibili in (u,v) metri */
  function hiddenLine(meshes, edgeSets, view, res) {
    const f = norm(view.f), r = norm(cross(f, view.up)), up = cross(r, f);
    // centro dei pezzi: le proiezioni lavorano su coordinate piccole (precisione anche con origini UTM)
    let n0 = 0; const c0 = [0, 0, 0]; meshes.forEach(m => { for (let i = 0; i < m.pos.length; i += 3) { c0[0] += m.pos[i]; c0[1] += m.pos[i + 1]; c0[2] += m.pos[i + 2]; n0++; } });
    if (n0) { c0[0] /= n0; c0[1] /= n0; c0[2] /= n0; }
    const P0 = [c0[0] * r[0] + c0[1] * r[1] + c0[2] * r[2], c0[0] * up[0] + c0[1] * up[1] + c0[2] * up[2], c0[0] * f[0] + c0[1] * f[1] + c0[2] * f[2]];
    const prjL = (x, y, z) => { x -= c0[0]; y -= c0[1]; z -= c0[2]; return [x * r[0] + y * r[1] + z * r[2], x * up[0] + y * up[1] + z * up[2], x * f[0] + y * f[1] + z * f[2]]; };
    const prj = (x, y, z) => { const q = prjL(x, y, z); return [q[0] + P0[0], q[1] + P0[1], q[2] + P0[2]]; };
    // estensione
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    const PP = meshes.map(m => { const q = new Float64Array(m.pos.length); for (let i = 0; i < m.pos.length; i += 3) { const s = prjL(m.pos[i], m.pos[i + 1], m.pos[i + 2]); q[i] = s[0]; q[i + 1] = s[1]; q[i + 2] = s[2]; if (s[0] < umin) umin = s[0]; if (s[0] > umax) umax = s[0]; if (s[1] < vmin) vmin = s[1]; if (s[1] > vmax) vmax = s[1]; } return q; });
    const span = Math.max(umax - umin, vmax - vmin, 1e-6), px = span / res;
    const W = Math.max(2, Math.ceil((umax - umin) / px) + 3), H = Math.max(2, Math.ceil((vmax - vmin) / px) + 3);
    const zb = new Float64Array(W * H).fill(Infinity);
    const gx = u => (u - umin) / px + 1, gy = v => (v - vmin) / px + 1;
    meshes.forEach((m, mi) => {
      const q = PP[mi], ix = m.idx;
      for (let t = 0; t < ix.length; t += 3) {
        const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
        const x0 = gx(q[a]), y0 = gy(q[a + 1]), z0 = q[a + 2], x1 = gx(q[b]), y1 = gy(q[b + 1]), z1 = q[b + 2], x2 = gx(q[c]), y2 = gy(q[c + 1]), z2 = q[c + 2];
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0); if (Math.abs(area) < 1e-9) continue;
        const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
        const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
          const w0 = ((x1 - x) * (y2 - y) - (x2 - x) * (y1 - y)) / area, w1 = ((x2 - x) * (y0 - y) - (x0 - x) * (y2 - y)) / area, w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const z = w0 * z0 + w1 * z1 + w2 * z2, k = y * W + x; if (z < zb[k]) zb[k] = z;
        }
      }
    });
    const depthAt = (x, y) => { // minimo nell'intorno 3x3: tollera i bordi dei triangoli
      let z = Infinity; const xi = Math.round(x), yi = Math.round(y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = xi + dx, Y = yi + dy; if (X >= 0 && Y >= 0 && X < W && Y < H) { const v = zb[Y * W + X]; if (v < z) z = v; } }
      return z;
    };
    const eps = px * 2.5, segs = [];
    edgeSets.forEach(es => es.forEach(e => {
      const A = prjL(e[0], e[1], e[2]), B = prjL(e[3], e[4], e[5]);
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]) / px; const n = Math.max(2, Math.ceil(L * 1.5));
      let start = -1;
      for (let i = 0; i <= n; i++) {
        const t = i / n, u = A[0] + (B[0] - A[0]) * t, v = A[1] + (B[1] - A[1]) * t, d = A[2] + (B[2] - A[2]) * t;
        const vis = d <= depthAt(gx(u), gy(v)) + eps;
        if (vis && start < 0) start = t;
        if ((!vis || i === n) && start >= 0) { const t1 = vis ? t : (i - 1) / n; if (t1 > start) segs.push([A[0] + (B[0] - A[0]) * start, A[1] + (B[1] - A[1]) * start, A[0] + (B[0] - A[0]) * t1, A[1] + (B[1] - A[1]) * t1]); start = -1; }
      }
    }));
    const out = mergeSegs(segs, px * 0.3).map(q => [q[0] + P0[0], q[1] + P0[1], q[2] + P0[0], q[3] + P0[1]]);
    return {segs: out, umin: umin + P0[0], umax: umax + P0[0], vmin: vmin + P0[1], vmax: vmax + P0[1], prj};
  }
  function mergeSegs(segs, tol) { // elimina i doppioni di segmenti coincidenti
    const seen = new Set(), out = [];
    for (const s of segs) { const k = [s[0], s[1], s[2], s[3]].map(v => Math.round(v / tol)).join(','), k2 = [s[2], s[3], s[0], s[1]].map(v => Math.round(v / tol)).join(','); if (seen.has(k) || seen.has(k2)) continue; seen.add(k); out.push(s); }
    return out;
  }

  // ------------------------------------------------------------------ tavola
  const SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 750, 1000, 1500, 2000, 2500, 5000];
  const nf = (v, d) => v.toLocaleString('it-IT', {minimumFractionDigits: d, maximumFractionDigits: d});
  const LOGO = {data: 'data:image/png;base64,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', w: 242, h: 78};
  const LOGO_METALSAN = {data: 'data:image/png;base64,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', w: 354, h: 132};
  /** loghi dei clienti, accanto a WSC: si sceglie nel pannello (Dati di progetto) */
  const CLIENT_LOGOS = {METALSAN: LOGO_METALSAN, SCL: {"w": 846, "h": 270, "data": "data:image/png;base64,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"}, BATEG: {"w": 606, "h": 201, "data": "data:image/png;base64,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"}};
  /** impostazioni condivise dei cartigli: cliente e dati di progetto */
  const SHEET = {client: 'METALSAN', custom: null, info: {}};
  function setSheet(o) { if (!o) return; if (o.client !== undefined) SHEET.client = o.client; if (o.custom !== undefined) SHEET.custom = o.custom; if (o.info) SHEET.info = {...o.info}; }
  /** loghi nell'angolo in basso a destra del cartiglio: WSC e, a sinistra, il logo del cliente */
  function logos(P, ty) {
    const w = 26, h = w * LOGO.h / LOGO.w, x = 406 - w;
    P.push({t: 'image', p: [x, ty + 2], w, h, data: LOGO.data});
    const lg = SHEET.client === 'ALTRO' ? SHEET.custom : CLIENT_LOGOS[SHEET.client];
    if (SHEET.client === 'NESSUNO' || !SHEET.client) return;
    if (lg && lg.data && lg.w && lg.h) { const k = Math.min(38 / lg.w, 11.5 / lg.h), w2 = lg.w * k, h2 = lg.h * k; P.push({t: 'image', p: [x - 3 - w2, ty + 1.5 + (11.5 - h2) / 2], w: w2, h: h2, data: lg.data}); }
    else { const nm = SHEET.client === 'ALTRO' ? ((SHEET.custom && SHEET.custom.name) || '') : SHEET.client; if (nm) P.push({t: 'text', p: [x - 3 - 19, ty + 5], txt: nm, s: 4.2, layer: 'TESTI', align: 'center', bold: true}); }
  }
  /**
   * colonna destra del cartiglio con i dati di progetto: opera, committente, commessa, elaborato, revisione, firme, data.
   * x0: inizio della colonna; extra: righe proprie della tavola (gruppo, macroconcio, scala); footer: riga piccola in basso.
   */
  function cartRight(P, x0, ty, th, project, extra, footer) {
    const I = SHEET.info || {}, today = new Date().toLocaleDateString('it-IT'), j = (...a) => a.filter(Boolean).join(' · ');
    const Wd = 406 - x0, fit = (t, sz) => { const n = Math.floor(Wd / (sz * 1.3 * 0.52)); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
    const rows = [
      {txt: I.opera || project || '', s: 2.6, b: true, k: 1},
      {txt: j(I.committente ? 'Committente: ' + I.committente : '', I.localita), s: 2.2, k: 3},
      {txt: j(I.commessa ? 'Commessa ' + I.commessa : '', I.elaborato ? 'Elab. ' + I.elaborato : '', I.rev ? 'Rev. ' + I.rev : ''), s: 2.2, k: 2},
      ...(extra || []).filter(Boolean).map(t => ({txt: t, s: 2.2, k: 2})),
      {txt: 'Data ' + (I.data || today), s: 2.1, k: 1}].filter(r => r.txt);
    const nMax = Math.max(2, Math.floor((th - 17) / 4.5) + 1);
    let use = rows; for (const lvl of [4, 3, 2]) if (use.length > nMax) use = use.filter(r => r.k < lvl);
    use = use.slice(0, nMax);
    use.forEach((r, i) => P.push({t: 'text', p: [x0, ty + th - 5.5 - i * 4.6], txt: fit(r.txt, r.s), s: r.s * 1.3, layer: 'TESTI', align: 'left', bold: !!r.b}));
    const sign = j(I.redatto ? 'Redatto ' + I.redatto : '', I.controllato ? 'Contr. ' + I.controllato : '', I.approvato ? 'Appr. ' + I.approvato : '');
    if (sign) P.push({t: 'text', p: [x0, ty + 3], txt: sign, s: 2.0 * 1.3, layer: 'TESTI', align: 'left'}); // le firme al posto della riga del programma
    else if (footer) P.push({t: 'text', p: [x0, ty + 3], txt: footer, s: 1.8 * 1.3, layer: 'TESTI', align: 'left'});
  }

  /** quota relativa in m con segno: ±0,00 / +1,23 / −0,45 */
  const lvl = v => Math.abs(v) < 0.005 ? '±0,00' : (v > 0 ? '+' : '−') + nf(Math.abs(v), 2);
  /** ±0,00 delle tavole di sollevamento: intradosso della piattabanda inferiore in corrispondenza del baricentro (coord. locali, z dal COG) */
  function zeroLevel(local) {
    let z0 = Infinity, zAll = Infinity;
    for (const m of local) for (let i = 0; i < m.pos.length; i += 3) { const z = m.pos[i + 2]; if (z < zAll) zAll = z; if (Math.abs(m.pos[i]) < 1.0 && z < z0) z0 = z; }
    return isFinite(z0) ? z0 : zAll;
  }

  /**
   * d = {meshes:[{pos,idx,bolt}] (coord. viewer, metri, relative a ref), ref:[x,y,z], cog:[x,y,z] assoluto,
   *      origin:{x,y,z}, rot (gradi), name, weight, boltWeight, nPieces, marks:[...], group, project, model, drawBolts}
   */
  function buildSheet(d) {
    const rot = (d.rot || 0) * Math.PI / 180, cr = Math.cos(rot), sr = Math.sin(rot);
    const o = [d.origin.x - d.ref[0], d.origin.y - d.ref[1], d.origin.z - d.ref[2]];
    const toL = (x, y, z) => { const dx = x - o[0], dy = y - o[1]; return [dx * cr + dy * sr, -dx * sr + dy * cr, z - o[2]]; };
    const draw = d.meshes.filter(m => d.drawBolts || !m.bolt);
    const local = draw.map(m => { const q = new Float64Array(m.pos.length); for (let i = 0; i < q.length; i += 3) { const s = toL(m.pos[i], m.pos[i + 1], m.pos[i + 2]); q[i] = s[0]; q[i + 1] = s[1]; q[i + 2] = s[2]; } return {pos: q, idx: m.idx}; });
    const edges = local.map(m => featureEdges(m, 25));
    const cogL = toL(d.cog[0] - d.ref[0], d.cog[1] - d.ref[1], d.cog[2] - d.ref[2]);
    const VIEWS = {
      front: {f: [0, 1, 0], up: [0, 0, 1], title: 'PROSPETTO', ax: ['X', 'Z']},
      plan: {f: [0, 0, -1], up: [0, 1, 0], title: 'PIANTA', ax: ['X', 'Y']},
      side: {f: [1, 0, 0], up: [0, 0, 1], title: 'SEZIONE (vista dall\'inizio dell\'asse X)', ax: ['Y', 'Z']},
      iso: {f: [1, 0.85, -0.75], up: [0, 0, 1], title: 'VISTA 3D (non in scala)'}
    };
    const res = 1400, H = {};
    for (const k in VIEWS) H[k] = hiddenLine(local, edges, VIEWS[k], k === 'iso' ? 1600 : res);

    // riquadri (mm, origine in basso a sinistra del foglio A3 orizzontale 420x297)
    const R = {front: [12, 128, 246, 112], plan: [12, 50, 246, 76], side: [260, 128, 148, 112], iso: [260, 50, 148, 76]};
    // la pianta prende metà della colonna: ridistribuisco in base alle proporzioni reali
    const wd = H.front.umax - H.front.umin || 1, hFront = H.front.vmax - H.front.vmin || 1, hPlan = H.plan.vmax - H.plan.vmin || 1;
    const top = 287, bot = 50, colH = top - bot, ratio = hFront / (hFront + hPlan);
    const fh = Math.min(colH - 60, Math.max(60, colH * ratio)), ph = colH - fh;
    R.front = [12, top - fh, 246, fh]; R.plan = [12, bot, 246, ph];
    R.side = [262, top - 122, 146, 122]; R.iso = [262, bot, 146, colH - 122];
    const need = k => { const h = H[k], r = R[k]; return Math.max((h.umax - h.umin) / (r[2] - 34), (h.vmax - h.vmin) / (r[3] - 26)) * 1000; };
    const needMax = Math.max(need('front'), need('plan'), need('side'));
    const S = SCALES.find(s => s >= needMax) || Math.ceil(needMax);
    const P = []; // primitive
    const L = (a, b, layer, w) => P.push({t: 'line', a, b, layer: layer || 'CONTORNI', w: w || 0.25});
    const T = (p, txt, size, layer, align) => P.push({t: 'text', p, txt: String(txt), s: (size || 2.5) * 1.25, layer: layer || 'TESTI', align: align || 'left'});
    const C = (c, r, layer) => P.push({t: 'circle', c, r, layer: layer || 'BARICENTRO'});
    const SEC = (c, r, a0, a1, layer) => P.push({t: 'sector', c, r, a0, a1, layer: layer || 'BARICENTRO'});
    const rect = (x, y, w, h, layer, wt) => { L([x, y], [x + w, y], layer, wt); L([x + w, y], [x + w, y + h], layer, wt); L([x + w, y + h], [x, y + h], layer, wt); L([x, y + h], [x, y], layer, wt); };
    const cogSym = (c, r) => { C(c, r); SEC(c, r, 0, 90); SEC(c, r, 180, 270); L([c[0] - r * 1.6, c[1]], [c[0] + r * 1.6, c[1]], 'BARICENTRO', 0.18); L([c[0], c[1] - r * 1.6], [c[0], c[1] + r * 1.6], 'BARICENTRO', 0.18); };

    // cornice
    rect(5, 5, 410, 287, 'CORNICE', 0.5);

    function placeView(k, scaleDen) {
      const h = H[k], r = R[k];
      const k2 = scaleDen ? 1000 / scaleDen : Math.min((r[2] - 16) / (h.umax - h.umin || 1), (r[3] - 16) / (h.vmax - h.vmin || 1));
      const cu = (h.umin + h.umax) / 2, cv = (h.vmin + h.vmax) / 2;
      const ox = r[0] + r[2] / 2 + (scaleDen ? -6 : 0), oy = r[1] + r[3] / 2 + (scaleDen ? 6 : -2);
      const map = (u, v) => [ox + (u - cu) * k2, oy + (v - cv) * k2];
      h.segs.forEach(s => L(map(s[0], s[1]), map(s[2], s[3]), k === 'iso' ? 'VISTA_3D' : 'CONTORNI', 0.3));
      T([r[0] + 2, r[1] + r[3] - 4], VIEWS[k].title + (scaleDen ? '   1:' + S : ''), 2.8, 'TESTI');
      const c3 = h.prj(cogL[0], cogL[1], cogL[2]), cp = map(c3[0], c3[1]);
      cogSym(cp, 2.2);
      if (!scaleDen) { T([cp[0] + 3.5, cp[1] + 2.5], 'COG', 2.5, 'BARICENTRO'); return; }
      // quote: orizzontale sotto, verticale a destra
      const p0 = map(h.umin, h.vmin), p1 = map(h.umax, h.vmax);
      const yq = p0[1] - 7, xq = p1[0] + 7;
      const hdim = (xa, xb, y, txt) => { L([xa, y], [xb, y], 'QUOTE', 0.18); L([xa, y - 1.5], [xa, y + 1.5], 'QUOTE', 0.18); L([xb, y - 1.5], [xb, y + 1.5], 'QUOTE', 0.18); T([(xa + xb) / 2, y + 1], txt, 2.2, 'QUOTE', 'center'); };
      const vdim = (ya, yb, x, txt) => { L([x, ya], [x, yb], 'QUOTE', 0.18); L([x - 1.5, ya], [x + 1.5, ya], 'QUOTE', 0.18); L([x - 1.5, yb], [x + 1.5, yb], 'QUOTE', 0.18); T([x + 1.5, (ya + yb) / 2], txt, 2.2, 'QUOTE', 'left'); };
      const mm = v => nf(v * 1000, 0);
      // richiami
      L([p0[0], p0[1] - 1], [p0[0], yq - 2], 'QUOTE', 0.13); L([p1[0], p0[1] - 1], [p1[0], yq - 2], 'QUOTE', 0.13); L([cp[0], cp[1] - 2.5], [cp[0], yq - 2], 'QUOTE', 0.13);
      L([p1[0] + 1, p0[1]], [xq + 2, p0[1]], 'QUOTE', 0.13); L([p1[0] + 1, p1[1]], [xq + 2, p1[1]], 'QUOTE', 0.13); L([cp[0] + 2.5, cp[1]], [xq + 2, cp[1]], 'QUOTE', 0.13);
      hdim(p0[0], cp[0], yq, mm(c3[0] - h.umin)); hdim(cp[0], p1[0], yq, mm(h.umax - c3[0])); hdim(p0[0], p1[0], yq - 6, mm(h.umax - h.umin));
      vdim(p0[1], cp[1], xq, mm(c3[1] - h.vmin)); vdim(cp[1], p1[1], xq, mm(h.vmax - c3[1])); vdim(p0[1], p1[1], xq + 12, mm(h.vmax - h.vmin));
      const ax = VIEWS[k].ax, cl = {X: cogL[0], Y: cogL[1], Z: cogL[2]};
      T([cp[0] - 3, cp[1] + 4], `COG  ${ax[0]} ${nf(cl[ax[0]], 3)}  ${ax[1]} ${nf(cl[ax[1]], 3)}`, 2.4, 'BARICENTRO', 'right');
      // origine del gruppo, se cade nel riquadro
      const o3 = h.prj(0, 0, 0), op = map(o3[0], o3[1]);
      if (op[0] > r[0] + 2 && op[0] < r[0] + r[2] - 2 && op[1] > r[1] + 2 && op[1] < r[1] + r[3] - 6) {
        L([op[0] - 3, op[1] - 3], [op[0] + 3, op[1] + 3], 'ORIGINE', 0.25); L([op[0] - 3, op[1] + 3], [op[0] + 3, op[1] - 3], 'ORIGINE', 0.25); T([op[0] + 3, op[1] - 4], '0,0,0', 2.2, 'ORIGINE');
      }
      // freccia degli assi
      const ax0 = [r[0] + 6, r[1] + 6]; L(ax0, [ax0[0] + 8, ax0[1]], 'TESTI', 0.18); L(ax0, [ax0[0], ax0[1] + 8], 'TESTI', 0.18);
      const sgn = (k === 'side') ? '-' : ''; T([ax0[0] + 9, ax0[1] - 1], sgn + ax[0], 2.2); T([ax0[0] - 1, ax0[1] + 9.5], ax[1], 2.2);
    }
    placeView('front', S); placeView('plan', S); placeView('side', S); placeView('iso', 0);
    for (const k of ['front', 'plan', 'side', 'iso']) rect(...R[k], 'CORNICE', 0.18);

    // tabella e cartiglio
    const ty = 8, th = 38;
    rect(12, ty, 396, th, 'CORNICE', 0.35); L([212, ty], [212, ty + th], 'CORNICE', 0.25); L([300, ty], [300, ty + th], 'CORNICE', 0.25);
    const cg = cogL, ca = d.cog;
    const lines = [
      ['Baricentro', d.name], ['Peso totale', `${nf(d.weight, 1)} kg  (${nf(d.weight / 1000, 3)} t)`],
      ['di cui bulloneria', d.boltWeight > 0 ? `${nf(d.boltWeight, 1)} kg (da volume)` : 'non conteggiata'], ['Pezzi', String(d.nPieces)],
      ['COG nel gruppo', `X ${nf(cg[0], 3)}   Y ${nf(cg[1], 3)}   Z ${nf(cg[2], 3)} m`],
      ['COG nel modello', `X ${nf(ca[0], 3)}   Y ${nf(ca[1], 3)}   Z ${nf(ca[2], 3)} m`],
      ['Origine gruppo', `X ${nf(d.origin.x, 3)}  Y ${nf(d.origin.y, 3)}  Z ${nf(d.origin.z, 3)}  rot. ${nf(d.rot || 0, 2)}°`]];
    lines.forEach((l, i) => { T([14, ty + th - 4 - i * 4.9], l[0], 2.2, 'TESTI'); T([50, ty + th - 4 - i * 4.9], l[1], 2.3, 'TESTI'); });
    T([214, ty + th - 5], 'ELEMENTI', 2.2, 'TESTI');
    const marks = (d.marks || []).join(', '); const mlines = wrap(marks, 46).slice(0, 6);
    mlines.forEach((l, i) => T([214, ty + th - 10 - i * 4.2], l, 2.2, 'TESTI'));
    cartRight(P, 302, ty, th, d.project, [`Gruppo: ${d.group || ''} · scala 1:${S}`], 'Peso e baricentro · Trimble Connect');
    logos(P, ty);
    T([214, ty + 2], 'Quote in mm. COG sui volumi reali dei pezzi.', 1.8, 'TESTI');
    return {prims: P, scale: S, cogLocal: cogL};
  }
  function wrap(s, n) { const out = []; let cur = ''; s.split(', ').forEach(w => { if ((cur + ', ' + w).length > n && cur) { out.push(cur + ','); cur = w; } else cur = cur ? cur + ', ' + w : w; }); if (cur) out.push(cur); return out; }

  // ------------------------------------------------------------------ PDF
  const LW = {FUNI: [214, 0, 147], GOLFARI: [180, 120, 0], ASSI: [120, 120, 120], CONTORNI: [0, 0, 0], VISTA_3D: [40, 40, 40], QUOTE: [0, 90, 160], BARICENTRO: [200, 30, 30], ORIGINE: [0, 130, 60], TESTI: [20, 20, 20], CORNICE: [0, 0, 0], SEZIONI: [0, 140, 60], TAGLIO: [0, 0, 0], APPOGGI: [60, 60, 60], CONCI: [120, 120, 120]};
  function toPdf(doc, prims, addPage) {
    if (addPage) doc.addPage('a3', 'landscape');
    const Hh = 297, Y = y => Hh - y;
    for (const p of prims) {
      const c = LW[p.layer] || [0, 0, 0];
      if (p.t === 'line') { doc.setDrawColor(...c); doc.setLineWidth(p.w); doc.line(p.a[0], Y(p.a[1]), p.b[0], Y(p.b[1])); }
      else if (p.t === 'circle') { doc.setDrawColor(...c); doc.setLineWidth(p.w || 0.25); doc.circle(p.c[0], Y(p.c[1]), p.r, 'S'); }
      else if (p.t === 'sector') {
        doc.setFillColor(...c); const pts = [[p.c[0], Y(p.c[1])]];
        for (let a = p.a0; a <= p.a1 + 0.01; a += 10) pts.push([p.c[0] + p.r * Math.cos(a * Math.PI / 180), Y(p.c[1] + p.r * Math.sin(a * Math.PI / 180))]);
        const lines = []; for (let i = 1; i < pts.length; i++) lines.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
        doc.lines(lines, pts[0][0], pts[0][1], [1, 1], 'F', true);
      } else if (p.t === 'arc') { doc.setDrawColor(...c); doc.setLineWidth(p.w || 0.25); const n = Math.max(8, Math.ceil(Math.abs(p.a1 - p.a0) / 4)); let q = null;
        for (let i = 0; i <= n; i++) { const a = (p.a0 + (p.a1 - p.a0) * i / n) * Math.PI / 180, r = [p.c[0] + p.r * Math.cos(a), Y(p.c[1] + p.r * Math.sin(a))]; if (q) doc.line(q[0], q[1], r[0], r[1]); q = r; }
      } else if (p.t === 'poly') { if (p.pts.length < 3) continue; doc.setFillColor(...(p.fill || c)); const q = p.pts.map(a => [a[0], Y(a[1])]), lines = [];
        for (let i = 1; i < q.length; i++) lines.push([q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]]);
        doc.lines(lines, q[0][0], q[0][1], [1, 1], 'F', true);
      } else if (p.t === 'image') { try { doc.addImage(p.data, 'PNG', p.p[0], Y(p.p[1] + p.h), p.w, p.h); } catch (e) {}
      } else if (p.t === 'tbox') { // sfondo bianco sotto un testo
        doc.setFont('helvetica', p.bold === false ? 'normal' : 'bold'); doc.setFontSize(p.s / 0.3528); const w = doc.getTextWidth(p.txt), pd = p.s * 0.35;
        const x0 = p.align === 'right' ? p.p[0] - w : p.align === 'center' ? p.p[0] - w / 2 : p.p[0]; doc.setFillColor(255, 255, 255); doc.setDrawColor(...c); doc.setLineWidth(0.2); doc.rect(x0 - pd, Y(p.p[1]) - p.s * 0.6 - pd * 0.5, w + 2 * pd, p.s * 1.2 + pd, 'FD');
      } else if (p.t === 'text') { doc.setTextColor(...c); doc.setFont('helvetica', p.bold ? 'bold' : 'normal'); doc.setFontSize(p.s / 0.3528); doc.text(p.txt, p.a ? p.a[0] : p.p[0], Y(p.p[1]), {align: p.align, baseline: 'middle'}); }
    }
  }

  // ------------------------------------------------------------------ DXF (R12, unità = mm reali per le viste in scala)
  const DXFCOL = {FUNI: 6, GOLFARI: 2, ASSI: 8, CONTORNI: 7, VISTA_3D: 8, QUOTE: 4, BARICENTRO: 1, ORIGINE: 3, TESTI: 7, CORNICE: 7, SEZIONI: 3, TAGLIO: 7, APPOGGI: 8, CONCI: 9};
  function toDxf(prims, S) { return toDxfMulti([{prims, S}]); }
  function toDxfMulti(sheets) {
    const o = [];
    const g = (c, v) => o.push(String(c), String(v));
    g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1009'); g(9, '$INSUNITS'); g(70, 4); g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'TABLES'); g(0, 'TABLE'); g(2, 'LAYER'); g(70, Object.keys(DXFCOL).length);
    for (const [n, c] of Object.entries(DXFCOL)) { g(0, 'LAYER'); g(2, n); g(70, 0); g(62, c); g(6, 'CONTINUOUS'); }
    g(0, 'ENDTAB'); g(0, 'ENDSEC'); g(0, 'SECTION'); g(2, 'ENTITIES');
    let ox = 0;
    for (const sh of sheets) {
    const k = sh.S, prims = sh.prims;
    const fx = v => (v * k + ox).toFixed(3), f = v => (v * k).toFixed(3);
    for (const p of prims) {
      if (p.t === 'line') { g(0, 'LINE'); g(8, p.layer); g(10, fx(p.a[0])); g(20, f(p.a[1])); g(30, 0); g(11, fx(p.b[0])); g(21, f(p.b[1])); g(31, 0); }
      else if (p.t === 'arc') { g(0, 'ARC'); g(8, p.layer); g(10, fx(p.c[0])); g(20, f(p.c[1])); g(30, 0); g(40, f(p.r)); g(50, (p.a0 % 360).toFixed(4)); g(51, (p.a1 % 360).toFixed(4)); }
      else if (p.t === 'circle') { g(0, 'CIRCLE'); g(8, p.layer); g(10, fx(p.c[0])); g(20, f(p.c[1])); g(30, 0); g(40, f(p.r)); }
      else if (p.t === 'sector') {
        for (let a = p.a0; a < p.a1; a += 15) { const b = Math.min(a + 15, p.a1), q = [p.c, [p.c[0] + p.r * Math.cos(a * Math.PI / 180), p.c[1] + p.r * Math.sin(a * Math.PI / 180)], [p.c[0] + p.r * Math.cos(b * Math.PI / 180), p.c[1] + p.r * Math.sin(b * Math.PI / 180)]];
          g(0, 'SOLID'); g(8, p.layer); g(10, fx(q[0][0])); g(20, f(q[0][1])); g(30, 0); g(11, fx(q[1][0])); g(21, f(q[1][1])); g(31, 0); g(12, fx(q[2][0])); g(22, f(q[2][1])); g(32, 0); g(13, fx(q[2][0])); g(23, f(q[2][1])); g(33, 0); }
      } else if (p.t === 'poly' && p.layer !== 'CONCI') { // campitura: contorno chiuso (POLYLINE)
        g(0, 'POLYLINE'); g(8, p.layer); g(66, 1); g(70, 1); g(10, 0); g(20, 0); g(30, 0);
        p.pts.forEach(q => { g(0, 'VERTEX'); g(8, p.layer); g(10, fx(q[0])); g(20, f(q[1])); g(30, 0); }); g(0, 'SEQEND'); g(8, p.layer);
      } else if (p.t === 'text') {
        const al = p.align === 'center' ? 1 : p.align === 'right' ? 2 : 0;
        g(0, 'TEXT'); g(8, p.layer); g(10, fx(p.p[0])); g(20, f(p.p[1] - p.s * 0.35)); g(30, 0); g(40, f(p.s * 0.75)); g(1, ascii(p.txt));
        if (al) { g(72, al); g(11, fx(p.p[0])); g(21, f(p.p[1] - p.s * 0.35)); g(31, 0); }
      }
    }
    ox += (420 + 30) * k;
    }
    g(0, 'ENDSEC'); g(0, 'EOF');
    return o.join('\r\n') + '\r\n';
  }
  function ascii(s) { return s.replace(/°/g, '%%d').replace(/[^\x20-\x7e%]/g, ch => ({'à': 'a', 'è': 'e', 'é': 'e', 'ì': 'i', 'ò': 'o', 'ù': 'u', '·': '-', '×': 'x', '₀': '0', 'Ø': '%%c', '–': '-', '−': '-', '’': "'"}[ch] || '?')); }


  // ------------------------------------------------------------------ GOLFARI
  /**
   * Analizza un macroconcio per il posizionamento dei golfari.
   * meshes: [{pos (relative a ref), idx, bolt}], cogR: baricentro relativo a ref.
   * Restituisce un oggetto con travi rilevate, assi trasversali (diaframmi/irrigidimenti) e funzioni di calcolo.
   */
  function liftModel(meshes, cogR, opt = {}) {
    const cell = opt.cell || 0.05;
    // asse longitudinale (PCA in pianta)
    let sxx = 0, syy = 0, sxy = 0, n = 0;
    meshes.forEach(m => { const p = m.pos; for (let i = 0; i < p.length; i += 9) { const x = p[i] - cogR[0], y = p[i + 1] - cogR[1]; sxx += x * x; syy += y * y; sxy += x * y; n++; } });
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ax = [Math.cos(ang), Math.sin(ang)], pv = [-ax[1], ax[0]];
    const toUV = (x, y) => { const dx = x - cogR[0], dy = y - cogR[1]; return [dx * ax[0] + dy * ax[1], dx * pv[0] + dy * pv[1]]; };
    const fromUV = (u, v) => [cogR[0] + u * ax[0] + v * pv[0], cogR[1] + u * ax[1] + v * pv[1]];
    // elementi: ingombro locale e classe
    const els = meshes.map((m, i) => {
      const p = m.pos; let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < p.length; k += 3) { const [u, v] = toUV(p[k], p[k + 1]); if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; if (p[k + 2] < z0) z0 = p[k + 2]; if (p[k + 2] > z1) z1 = p[k + 2]; }
      const small = m.bolt || (u1 - u0 < 0.25 && v1 - v0 < 0.25);
      return {i, m, u0, u1, v0, v1, z0, z1, small, label: m.label || ''};
    });
    let U0 = Infinity, U1 = -Infinity, V0 = Infinity, V1 = -Infinity;
    els.forEach(e => { if (e.small) return; U0 = Math.min(U0, e.u0); U1 = Math.max(U1, e.u1); V0 = Math.min(V0, e.v0); V1 = Math.max(V1, e.v1); });
    const NU = Math.ceil((U1 - U0) / cell) + 2, NV = Math.ceil((V1 - V0) / cell) + 2;
    const zt = new Float32Array(NU * NV).fill(-Infinity), owner = new Int32Array(NU * NV).fill(-1);
    const gu = u => (u - U0) / cell, gv = v => (v - V0) / cell;
    // mappa delle superfici superiori (facce rivolte verso l'alto), esclusi pioli e bulloni
    els.forEach(e => {
      if (e.small) return; const p = e.m.pos, ix = e.m.idx;
      for (let t = 0; t < ix.length; t += 3) {
        const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
        const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
        const nz = e1[0] * e2[1] - e1[1] * e2[0], nl = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], nz);
        if (!nl || Math.abs(nz) / nl < 0.7) continue;
        const A = toUV(p[a], p[a + 1]), B = toUV(p[b], p[b + 1]), C = toUV(p[c], p[c + 1]);
        const x0 = gu(A[0]), y0 = gv(A[1]), x1 = gu(B[0]), y1 = gv(B[1]), x2 = gu(C[0]), y2 = gv(C[1]);
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0); if (Math.abs(area) < 1e-9) continue;
        const za = p[a + 2], zb = p[b + 2], zc = p[c + 2];
        for (let y = Math.max(0, Math.floor(Math.min(y0, y1, y2))); y <= Math.min(NV - 1, Math.ceil(Math.max(y0, y1, y2))); y++)
          for (let x = Math.max(0, Math.floor(Math.min(x0, x1, x2))); x <= Math.min(NU - 1, Math.ceil(Math.max(x0, x1, x2))); x++) {
            const w0 = ((x1 - x) * (y2 - y) - (x2 - x) * (y1 - y)) / area, w1 = ((x2 - x) * (y0 - y) - (x0 - x) * (y2 - y)) / area, w2 = 1 - w0 - w1;
            if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
            const z = w0 * za + w1 * zb + w2 * zc, k = x * NV + y; if (z > zt[k]) { zt[k] = z; owner[k] = e.i; }
          }
      }
    });
    // profilo trasversale a una progressiva u: tratti di piattabanda (superficie al livello superiore)
    function strips(u) {
      const xc = Math.round(gu(u)); if (xc < 0 || xc >= NU) return [];
      // mediana su 5 colonne: elimina oggetti isolati (golfari esistenti, pioli)
      const zrow = new Float32Array(NV), col = [];
      for (let y = 0; y < NV; y++) { col.length = 0; for (let x = Math.max(0, xc - 2); x <= Math.min(NU - 1, xc + 2); x++) col.push(zt[x * NV + y]); col.sort((a, b) => a - b); zrow[y] = col[Math.floor(col.length / 2)]; }
      // tratti piani (quota quasi costante)
      const runs = []; let s = 0;
      for (let y = 1; y <= NV; y++) {
        const brk = y === NV || !isFinite(zrow[y]) !== !isFinite(zrow[s]) || (isFinite(zrow[y]) && Math.abs(zrow[y] - zrow[y - 1]) > 0.02);
        if (brk) { const e = y - 1; let zm = -Infinity; for (let k = s; k <= e; k++) zm = Math.max(zm, zrow[k]); runs.push({s, e, z: zm}); s = y; }
      }
      // unisce tratti alla stessa quota separati da piccole interruzioni (piatti verticali sottili)
      const fin = runs.filter(r => isFinite(r.z));
      const merged = [];
      fin.forEach(r => { const l = merged[merged.length - 1]; if (l && r.s - l.e <= 3 && Math.abs(r.z - l.z) < 0.03) { l.e = r.e; l.z = Math.max(l.z, r.z); } else merged.push({...r}); });
      // piattabanda: tratto piano più alto di quanto c'è ai lati, largo 0.15-1.6 m
      const out = [];
      merged.forEach((r, i) => {
        const w = (r.e - r.s + 1) * cell; if (w < 0.15 || w > 1.6) return;
        let left = -Infinity, right = -Infinity;
        for (let k = Math.max(0, r.s - 6); k < r.s; k++) if (isFinite(zrow[k])) left = Math.max(left, zrow[k]);
        for (let k = r.e + 1; k <= Math.min(NV - 1, r.e + 6); k++) if (isFinite(zrow[k])) right = Math.max(right, zrow[k]);
        if (left > r.z - 0.08 || right > r.z - 0.08) return;
        out.push({v: V0 + ((r.s + r.e) / 2) * cell, w, z: r.z});
      });
      return out;
    }
    const g0 = strips(0);
    // traccia la linea di ogni trave lungo u (travi curve: si segue la piattabanda passo passo)
    const track = g0.map(st => { const m = new Map(); m.set(0, st); return m; });
    function girderAt(gi, u) {
      const step = 0.5, key = Math.round(u / step); const m = track[gi];
      if (m.has(key)) return m.get(key);
      const dir = key > 0 ? 1 : -1; let k = 0, prev = m.get(0);
      while (k !== key) { k += dir; if (m.has(k)) { prev = m.get(k); continue; }
        const ss = strips(k * step); let best = null; ss.forEach(s => { if (!best || Math.abs(s.v - prev.v) < Math.abs(best.v - prev.v)) best = s; });
        const cur = best && Math.abs(best.v - prev.v) < 0.6 ? best : {v: prev.v, w: prev.w, z: prev.z, missing: true};
        m.set(k, cur); prev = cur; }
      return m.get(key);
    }
    // verifica: una trave vera prosegue per buona parte del concio (scarta incroci di controventi, piatti isolati)
    { const keep = [];
      g0.forEach((_, gi) => { let tot = 0, ok = 0, jumps = 0, prev = null; const ws = [];
        for (let u = U0 + 1; u < U1 - 1; u += 0.5) { tot++; const q = girderAt(gi, u); if (!q.missing) { ok++; ws.push(q.w); } if (prev != null && Math.abs(q.v - prev) > 0.1) jumps++; prev = q.v; }
        ws.sort((x, y) => x - y); const wmed = ws.length ? ws[ws.length >> 1] : 0;
        // trave: presente per il 60% della lunghezza, linea regolare (non salta da un elemento all'altro), piattabanda larga almeno 22 cm
        if (!tot || (ok / tot >= 0.6 && jumps / tot < 0.35 && wmed >= 0.22)) keep.push(gi); });
      // due tracce che finiscono sulla stessa piattabanda: se ne tiene una
      const uniq = []; keep.forEach(gi => { if (!uniq.some(gj => Math.abs(g0[gj].v - g0[gi].v) < 0.3)) uniq.push(gi); });
      if (uniq.length && uniq.length < g0.length) { const g2 = uniq.map(i => g0[i]), t2 = uniq.map(i => track[i]); g0.length = 0; g2.forEach(x => g0.push(x)); track.length = 0; t2.forEach(x => track.push(x)); } }
    // assi trasversali: elementi sottili in senso longitudinale e alti (diaframmi, irrigidimenti, fazzoletti dei traversi)
    const stations = g0.map(() => []);
    els.forEach(e => {
      if (e.small || e.u1 - e.u0 > 0.15 || e.z1 - e.z0 < 0.3) return;
      const uc = (e.u0 + e.u1) / 2;
      g0.forEach((_, gi) => { const g = girderAt(gi, uc); if (e.v1 > g.v - g.w / 2 - 0.3 && e.v0 < g.v + g.w / 2 + 0.3) stations[gi].push({u: uc, el: e.i}); });
    });
    stations.forEach((arr, gi) => { arr.sort((a, b) => a.u - b.u); const merged = [];
      arr.forEach(s => { const l = merged[merged.length - 1]; if (l && s.u - l.u < 0.08) { l.u = (l.u * l.n + s.u) / (l.n + 1); l.n++; } else merged.push({u: s.u, n: 1, el: s.el}); });
      stations[gi] = merged; });
    // punto sulla piattabanda della trave gi alla progressiva u, con verifica dell'appoggio
    // sezione di un solo elemento con il piano u: bordi della sua faccia superiore (vicino alla sua quota più alta)
    const sectEl = (o, uu) => { const m = els[o].m, P = m.pos, I = m.idx, pts = [];
      for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) { const a = I[t + e], b = I[t + (e + 1) % 3], A = toUV(P[a * 3], P[a * 3 + 1]), B = toUV(P[b * 3], P[b * 3 + 1]), ua = A[0] - uu, ub = B[0] - uu;
        if ((ua < 0) === (ub < 0) || ua === ub) continue; const f = ua / (ua - ub); pts.push([A[1] + f * (B[1] - A[1]), P[a * 3 + 2] + f * (P[b * 3 + 2] - P[a * 3 + 2])]); }
      if (!pts.length) return {lo: NaN, hi: NaN, w: NaN, z: NaN};
      const zmax = Math.max(...pts.map(q => q[1])); let lo = Infinity, hi = -Infinity; pts.forEach(q => { if (q[1] > zmax - 0.1) { lo = Math.min(lo, q[0]); hi = Math.max(hi, q[0]); } });
      return {lo, hi, w: hi - lo, z: zmax}; };
    // larghezza propria di un piatto: la più frequente lungo tutto il piatto (le alette per i controventi sono tratti brevi)
    const elW = new Map();
    function plateW(o) {
      if (elW.has(o)) return elW.get(o); const e = els[o], hist = new Map();
      for (let u = e.u0 + 0.1; u < e.u1 - 0.1; u += 0.25) { const r = sectEl(o, u); if (!(r.w >= 0.15 && r.w <= 1.6)) continue; const k = Math.round(r.w * 200); hist.set(k, (hist.get(k) || 0) + 1); }
      let best = null, bc = 0; hist.forEach((c, k) => { if (c > bc) { bc = c; best = k; } });
      const w = best ? best / 200 : NaN; elW.set(o, w); return w; }
    /**
     * asse vero della piattabanda superiore alla progressiva u: si prende il solo piatto che sta sotto l'asse della trave
     * e se ne misurano i bordi con il piano u. Piatti accostati (fazzoletti dei controventi) non contano; se il piatto
     * stesso ha un'aletta in quel punto, il bordo dell'aletta si sostituisce con quello del piatto alla sua larghezza propria.
     */
    const flCache = new Map();
    function flangeAt(gi, u) {
      const key = gi + ':' + Math.round(u * 20); if (flCache.has(key)) return flCache.get(key);
      const g = girderAt(gi, u); let out = {...g, exact: false};
      const cnt = new Map(), x0 = Math.round(gu(u)), y0 = Math.round(gv(g.v));
      for (let x = x0 - 2; x <= x0 + 2; x++) for (let y = y0 - 4; y <= y0 + 4; y++) { if (x < 0 || y < 0 || x >= NU || y >= NV) continue; const o = owner[x * NV + y]; if (o >= 0 && !els[o].small && Math.abs(zt[x * NV + y] - g.z) < 0.08) cnt.set(o, (cnt.get(o) || 0) + 1 / (1 + Math.abs(y - y0))); }
      const cands = [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
      let pl = null;
      search: for (const o of cands) for (const uu of [u, u - 0.1, u + 0.1, u - 0.25, u + 0.25]) { const r = sectEl(o, uu);
        if (r.w >= 0.15 && r.w <= 1.8 && g.v > r.lo - 0.05 && g.v < r.hi + 0.05) { if (!(plateW(o) >= 0.3)) continue search; pl = {o, r, uu}; break search; } } // piatti stretti (coprigiunti, piattini): non sono la piattabanda
      if (pl) {
        const W = plateW(pl.o); let {lo, hi} = pl.r;
        if (isFinite(W) && Math.abs((hi - lo) - W) > 0.01) { // aletta o rientro in questo punto: bordi attesi dalle sezioni vicine senza aletta
          const e = els[pl.o], near = d => { const uu = u + d; if (uu < e.u0 + 0.05 || uu > e.u1 - 0.05) return null; const r = sectEl(pl.o, uu); return Math.abs(r.w - W) <= 0.01 ? {d, ...r} : null; };
          let A = null, B = null; for (const d of [0.2, 0.4, 0.6, 0.9, 1.2, 1.6, 2.0, 2.5]) { if (!A) A = near(-d); if (!B) B = near(d); if (A && B) break; }
          const ex = (k) => A && B ? A[k] + (B[k] - A[k]) * (-A.d) / (B.d - A.d) : (A || B) ? (A || B)[k] : null;
          const loE = ex('lo'), hiE = ex('hi');
          if (loE != null && hiE != null) { if (Math.abs(lo - loE) > Math.abs(hi - hiE)) lo = hi - W; else hi = lo + W; }
          else if ((hi - lo) > W) { if (Math.abs(lo - g.v) > Math.abs(hi - g.v)) lo = hi - W; else hi = lo + W; }
        }
        out = {...g, v: (lo + hi) / 2, w: hi - lo, el: pl.o, exact: true};
      }
      flCache.set(key, out); return out;
    }
    function pointAt(gi, u, lugL = 0.55, lugW = 0.15) {
      const g = flangeAt(gi, u); const v = g.v;
      let tot = 0, ok = 0, zsum = 0, own = new Map();
      for (let du = -lugL / 2; du <= lugL / 2 + 1e-9; du += cell) for (let dv = -lugW / 2; dv <= lugW / 2 + 1e-9; dv += cell) {
        const x = Math.round(gu(u + du)), y = Math.round(gv(v + dv)); tot++;
        if (x < 0 || y < 0 || x >= NU || y >= NV) continue; const z = zt[x * NV + y];
        if (z > g.z - 0.06) { ok++; zsum += z; const o = owner[x * NV + y]; own.set(o, (own.get(o) || 0) + 1); }
      }
      let main = -1, mc = 0; own.forEach((c, o) => { if (c > mc) { mc = c; main = o; } });
      const z = ok ? zsum / ok : g.z;
      // pioli/bulloni nell'impronta del golfare
      let studs = 0;
      els.forEach(e => { if (!e.small) return; const uc = (e.u0 + e.u1) / 2, vc = (e.v0 + e.v1) / 2;
        if (Math.abs(uc - u) < lugL / 2 + 0.03 && Math.abs(vc - v) < lugW / 2 + 0.06 && e.z1 > z - 0.02 && e.z0 < z + 0.4) studs++; });
      const xy = fromUV(u, v);
      return {gi, u, v, fexact: !!g.exact, fw: g.w, x: xy[0], y: xy[1], z, d: Math.hypot(u, v), support: tot ? ok / tot : 0, el: main >= 0 ? els[main].m : null, studs, missing: !!g.missing};
    }
    const L = U1 - U0;
    return {ax, pv, girders: g0, stations, pointAt, girderAt, flangeAt, strips, length: L, umin: U0, umax: U1, cell, toUV, fromUV, cogR, _dbg: {zt, NU, NV, U0, V0, els}};
  }

  /** propone i golfari: n = 2 o 4; girders = indici delle travi; R = distanza imposta (null = automatico sugli assi) */
  function placeLugs(lm, cfg) {
    const n = cfg.n, gs = cfg.girders, target = cfg.target || lm.length / 6, axial = cfg.metric !== 'radial';
    const metric = (u, v) => axial ? Math.abs(u) : Math.hypot(u, v);
    const sides = [-1, 1], slots = []; gs.forEach(g => sides.forEach(s => slots.push({g, s})));
    if (cfg.R) { // distanza imposta: si risolve la progressiva che dà quella distanza dal baricentro
      const pts = slots.map(({g, s}) => { if (axial) return lm.pointAt(g, s * cfg.R, cfg.lugL, cfg.lugW);
        let lo = 0, hi = s > 0 ? lm.umax : -lm.umin;
        for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2, p = lm.pointAt(g, s * mid); if (p.d < cfg.R) lo = mid; else hi = mid; }
        return lm.pointAt(g, s * (lo + hi) / 2, cfg.lugL, cfg.lugW); });
      return {mode: 'manuale', R: cfg.R, points: pts, alternatives: []};
    }
    // automatico: per ogni raggio candidato si sceglie l'asse più vicino per ogni trave e lato
    const cand = new Set(); const dists = slots.map(({g, s}) => lm.stations[g].filter(st => st.u * s > 0.5).map(st => ({u: st.u, d: metric(st.u, lm.girderAt(g, st.u).v)})));
    dists.forEach(arr => arr.forEach(x => cand.add(Math.round(x.d * 1000) / 1000)));
    const combos = [];
    cand.forEach(R => {
      if (dists.some(a => !a.length)) return;
      const pick = dists.map(a => a.reduce((b, x) => Math.abs(x.d - R) < Math.abs(b.d - R) ? x : b));
      const ds = pick.map(p => p.d), dev = Math.max(...ds) - Math.min(...ds), mean = ds.reduce((a, b) => a + b, 0) / ds.length;
      const key = pick.map(p => p.u.toFixed(2)).join('|'); if (combos.some(c => c.key === key)) return;
      combos.push({key, pick, dev, mean});
    });
    // costo: vicinanza alla distanza obiettivo, scarto fra i golfari oltre 5 cm, appoggio incompleto, pioli/bulloni nell'impronta
    combos.forEach(c => {
      const pts = c.pick.map((p, i) => lm.pointAt(slots[i].g, p.u, cfg.lugL, cfg.lugW));
      const bad = pts.some(p => p.support < 0.9), studs = pts.reduce((a, p) => a + p.studs, 0);
      c.cost = 2 * Math.abs(c.mean - target) / Math.max(target, 1) + 8 * Math.max(0, c.dev - 0.05) + (bad ? 5 : 0) + (studs ? 1 : 0);
    });
    combos.sort((a, b) => a.cost - b.cost);
    const top = combos.slice(0, 8).map(c => ({dev: c.dev, mean: c.mean, us: c.pick.map(p => p.u)}));
    const best = top[cfg.alt || 0];
    if (!best) return {mode: 'auto', points: [], alternatives: [], error: 'nessun asse di diaframma o irrigidimento trovato sui due lati del baricentro'};
    return {mode: 'auto', R: best.mean, dev: best.dev, points: slots.map((sl, i) => lm.pointAt(sl.g, best.us[i])), alternatives: top};
  }

  /** carichi e funi: P per golfare (ripartizione statica), lunghezza, angolo, tiro */
  /**
   * Carichi sui golfari e tiri delle funi. Le funi convergono nel gancio, sulla verticale del baricentro: i momenti si annullano da soli,
   * restano ΣFz = W e ΣFx = ΣFy = 0. Con 4 golfari (iperstatico) si prende la ripartizione bilineare e la si corregge col minimo scarto
   * finché soddisfa esattamente le tre equazioni. Con 2 golfari il risultato vale solo se il baricentro è sulla linea dei golfari (misalign).
   */
  function slingForces(points, W, hookZ) {
    const n = points.length, h = points.map(p => Math.max(0.05, hookZ - p.z)); let P, misalign = 0;
    if (n === 2) { const [a, b] = points, da = Math.abs(a.u) / h[0], db = Math.abs(b.u) / h[1]; P = [W * db / (da + db), W * da / (da + db)];
      const ex = b.u - a.u, ey = b.v - a.v, el = Math.hypot(ex, ey) || 1; misalign = Math.abs(a.u * ey - a.v * ex) / el; }
    else { // ripartizione bilineare di partenza (trasversale poi longitudinale)
      const byG = {}; points.forEach((p, i) => (byG[p.gi] ||= []).push(i)); const G = Object.keys(byG);
      const vA = Math.abs(points[byG[G[0]][0]].v), vB = Math.abs(points[byG[G[1]][0]].v);
      const WA = W * vB / (vA + vB), WB = W * vA / (vA + vB); P = new Array(n);
      [[G[0], WA], [G[1], WB]].forEach(([g, Wg]) => { const [i, j] = byG[g]; const di = Math.abs(points[i].u), dj = Math.abs(points[j].u); P[i] = Wg * dj / (di + dj); P[j] = Wg * di / (di + dj); });
      // correzione col minimo scarto: P = P0 + Aᵀλ con A·P = [W, 0, 0]
      const A = [points.map(() => 1), points.map((p, i) => p.u / h[i]), points.map((p, i) => p.v / h[i])], bb = [W, 0, 0];
      const r = bb.map((v, k) => v - A[k].reduce((s2, a2, i) => s2 + a2 * P[i], 0));
      const M = A.map(ra => A.map(rb => ra.reduce((s2, x, i) => s2 + x * rb[i], 0)));
      const lam = solve3(M, r); if (lam) P = P.map((v, i) => v + A[0][i] * lam[0] + A[1][i] * lam[1] + A[2][i] * lam[2]);
    }
    const out = points.map((p, i) => { const Ls = Math.hypot(p.d, h[i]), alpha = Math.atan2(h[i], p.d) * 180 / Math.PI; return {P: P[i], Ls, alpha, T: P[i] / Math.sin(alpha * Math.PI / 180)}; });
    let fx = 0, fy = 0, fz = 0; points.forEach((p, i) => { fx -= P[i] * p.u / h[i]; fy -= P[i] * p.v / h[i]; fz += P[i]; });
    out.misalign = misalign; out.residual = Math.hypot(fx, fy, fz - W); out.negative = P.some(v => v < 0);
    return out;
  }
  function solve3(M, r) { const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D0 = det(M); if (Math.abs(D0) < 1e-12) return null; return [0, 1, 2].map(c => det(M.map((row, i) => row.map((v, j) => j === c ? r[i] : v))) / D0); }

  // ------------------------------------------------------------------ APPOGGI PROVVISORI A TERRA (premontaggio dei conci)
  /**
   * Intradosso del macroconcio sulla stessa griglia di liftModel: quota minima delle facce orizzontali.
   * Dà la piattabanda inferiore sotto l'anima di ogni trave e il punto di appoggio (sella) con la verifica del contatto.
   */
  function supportModel(lm) {
    const {U0, V0, NU, NV, els} = lm._dbg, cell = lm.cell, toUV = lm.toUV;
    const gu = u => (u - U0) / cell, gv = v => (v - V0) / cell;
    const zb = new Float32Array(NU * NV).fill(Infinity);
    els.forEach(e => {
      if (e.small) return; const p = e.m.pos, ix = e.m.idx;
      for (let t = 0; t < ix.length; t += 3) {
        const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
        const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
        const nz = e1[0] * e2[1] - e1[1] * e2[0], nl = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], nz);
        if (!nl || Math.abs(nz) / nl < 0.7) continue;
        const A = toUV(p[a], p[a + 1]), B = toUV(p[b], p[b + 1]), C = toUV(p[c], p[c + 1]);
        const x0 = gu(A[0]), y0 = gv(A[1]), x1 = gu(B[0]), y1 = gv(B[1]), x2 = gu(C[0]), y2 = gv(C[1]);
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0); if (Math.abs(area) < 1e-9) continue;
        const za = p[a + 2], zb2 = p[b + 2], zc = p[c + 2];
        for (let y = Math.max(0, Math.floor(Math.min(y0, y1, y2))); y <= Math.min(NV - 1, Math.ceil(Math.max(y0, y1, y2))); y++)
          for (let x = Math.max(0, Math.floor(Math.min(x0, x1, x2))); x <= Math.min(NU - 1, Math.ceil(Math.max(x0, x1, x2))); x++) {
            const w0 = ((x1 - x) * (y2 - y) - (x2 - x) * (y1 - y)) / area, w1 = ((x2 - x) * (y0 - y) - (x0 - x) * (y2 - y)) / area, w2 = 1 - w0 - w1;
            if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
            const z = w0 * za + w1 * zb2 + w2 * zc, k = x * NV + y; if (z < zb[k]) zb[k] = z;
          }
      }
    });
    // profilo trasversale dell'intradosso alla progressiva u (mediana su 5 colonne: toglie bulloni e piccoli pezzi)
    function row(u) {
      const xc = Math.round(gu(u)); if (xc < 0 || xc >= NU) return null;
      const zr = new Float32Array(NV), col = [];
      for (let y = 0; y < NV; y++) { col.length = 0; for (let x = Math.max(0, xc - 2); x <= Math.min(NU - 1, xc + 2); x++) col.push(zb[x * NV + y]); col.sort((a, b) => a - b); zr[y] = col[Math.floor(col.length / 2)]; }
      return zr;
    }
    // piattabande inferiori: tratti piani più bassi di quanto c'è ai lati, larghi 0,15–1,6 m
    function flanges(u) {
      const zr = row(u); if (!zr) return [];
      const runs = []; let s = 0;
      for (let y = 1; y <= NV; y++) {
        const brk = y === NV || isFinite(zr[y]) !== isFinite(zr[s]) || (isFinite(zr[y]) && Math.abs(zr[y] - zr[y - 1]) > 0.015);
        if (brk) { let zm = Infinity; for (let k = s; k < y; k++) zm = Math.min(zm, zr[k]); runs.push({s, e: y - 1, z: zm}); s = y; }
      }
      const merged = [];
      runs.filter(r => isFinite(r.z)).forEach(r => { const l = merged[merged.length - 1]; if (l && r.s - l.e <= 3 && Math.abs(r.z - l.z) < 0.03) { l.e = r.e; l.z = Math.min(l.z, r.z); } else merged.push({...r}); });
      const out = [];
      merged.forEach(r => {
        const w = (r.e - r.s + 1) * cell; if (w < 0.15 || w > 1.6) return;
        let left = Infinity, right = Infinity;
        for (let k = Math.max(0, r.s - 6); k < r.s; k++) left = Math.min(left, zr[k]);
        for (let k = r.e + 1; k <= Math.min(NV - 1, r.e + 6); k++) right = Math.min(right, zr[k]);
        if (left < r.z + 0.05 || right < r.z + 0.05) return;
        out.push({v: V0 + ((r.s + r.e) / 2) * cell, w, z: r.z});
      });
      return out;
    }
    const cache = new Map();
    /** piattabanda inferiore della trave gi alla progressiva u (la più vicina all'asse dell'anima) */
    function bottomAt(gi, u) {
      const key = gi + ':' + Math.round(u / cell); if (cache.has(key)) return cache.get(key);
      const g = lm.girderAt(gi, u); let best = null;
      flanges(u).forEach(f => { const d = Math.abs(f.v - g.v); if (d < f.w / 2 + 0.3 && (!best || d < Math.abs(best.v - g.v))) best = f; });
      const r = best ? {v: best.v, w: best.w, z: best.z, web: g.v, top: g.z, missing: false} : {v: g.v, w: g.w, z: NaN, web: g.v, top: g.z, missing: true};
      cache.set(key, r); return r;
    }
    /** appoggio sotto l'anima della trave gi alla progressiva u: sella Ls (lungo l'asse) × Bs (trasversale) */
    function pointBelow(gi, u, Ls = 0.4, Bs = 0.4) {
      let b = bottomAt(gi, u);
      if (b.missing) for (const du of [0.1, -0.1, 0.2, -0.2]) { const q = bottomAt(gi, u + du); if (!q.missing) { b = q; break; } }
      const v = b.web;
      let tot = 0, ok = 0;
      for (let du = -Ls / 2; du <= Ls / 2 + 1e-9; du += cell) for (let dv = -Bs / 2; dv <= Bs / 2 + 1e-9; dv += cell) {
        const x = Math.round(gu(u + du)), y = Math.round(gv(v + dv)); tot++;
        if (x < 0 || y < 0 || x >= NU || y >= NV) continue;
        if (Math.abs(zb[x * NV + y] - b.z) < 0.02) ok++;
      }
      // bulloni (teste, dadi) sotto la piattabanda nell'impronta della sella
      let bolts = 0;
      els.forEach(e => { if (!e.small) return; const uc = (e.u0 + e.u1) / 2, vc = (e.v0 + e.v1) / 2;
        if (Math.abs(uc - u) < Ls / 2 + 0.03 && Math.abs(vc - v) < Bs / 2 + 0.03 && e.z0 < b.z + 0.03 && e.z1 > b.z - 0.2) bolts++; });
      const xy = lm.fromUV(u, v);
      return {gi, u, v, x: xy[0], y: xy[1], z: b.z, bf: {v: b.v, w: b.w}, top: b.top, support: tot ? ok / tot : 0, bolts, missing: b.missing};
    }
    return {bottomAt, pointBelow, flanges};
  }

  /**
   * Appoggi dei conci affiancati: due file per concio, sotto le anime delle travi scelte, in asse ai diaframmi/irrigidimenti.
   * conci: [{u0, u1, ucog}] in ordine lungo l'asse. Lato giunto: a dJ dal giunto. Lato libero: a 'free' m dall'estremità,
   * oppure (free vuoto) simmetrico rispetto al baricentro del concio; concio isolato: a 0,21 L dalle estremità.
   * custom['k:lato'] = progressiva imposta per quella fila (spostamenti a mano).
   */
  function placeSupports(lm, sm, conci, cfg) {
    const gs = cfg.girders, dJ = cfg.dJ != null ? cfg.dJ : 1.5, Ls = cfg.Ls || 0.4, Bs = cfg.Bs || 0.4, out = [];
    const stIn = (gi, c) => lm.stations[gi].map(s => s.u).filter(u => u > c.u0 + 0.2 && u < c.u1 - 0.2);
    const nearest = (arr, u) => arr.reduce((b, x) => b == null || Math.abs(x - u) < Math.abs(b - u) ? x : b, null);
    // fila sugli assi comuni alle travi: costo = distanza dal punto voluto + disallineamento fra le travi
    const snap = (t, c, lo = -Infinity, hi = Infinity) => {
      const cand = []; gs.forEach(gi => stIn(gi, c).forEach(u => { if (u >= lo && u <= hi) cand.push(u); }));
      if (!cand.length) return {u: Math.max(lo, Math.min(hi, t)), snapped: false};
      let best = null, bc = Infinity;
      cand.forEach(u => { let cost = Math.abs(u - t); gs.forEach(gi => { const n = nearest(stIn(gi, c), u); cost += 2 * Math.min(n == null ? 0.5 : Math.abs(n - u), 0.5); }); if (cost < bc) { bc = cost; best = u; } });
      return {u: best, snapped: true};
    };
    conci.forEach((c, k) => {
      const L = c.u1 - c.u0, jl = k > 0, jr = k < conci.length - 1, lines = [null, null], tg = [null, null];
      const fixed = side => cfg.custom && cfg.custom[k + ':' + side] != null ? cfg.custom[k + ':' + side] : null;
      // lato giunto: a dJ dal giunto, mai più vicino (spazio per il giunto di montaggio)
      if (jl) { tg[0] = c.u0 + dJ; lines[0] = fixed(0) != null ? {u: fixed(0)} : snap(tg[0], c, c.u0 + dJ - 0.02, c.ucog - 0.3); }
      if (jr) { tg[1] = c.u1 - dJ; lines[1] = fixed(1) != null ? {u: fixed(1)} : snap(tg[1], c, c.ucog + 0.3, c.u1 - dJ + 0.02); }
      // lato libero: distanza imposta dall'estremità, oppure simmetrico rispetto al baricentro (concio isolato: 0,21 L)
      [0, 1].forEach(side => { if (lines[side]) return;
        const other = lines[1 - side];
        let t = cfg.free > 0 ? (side ? c.u1 - cfg.free : c.u0 + cfg.free) : other ? 2 * c.ucog - other.u : (side ? c.u1 - 0.21 * L : c.u0 + 0.21 * L);
        t = side ? Math.min(c.u1 - 0.3, Math.max(t, c.ucog + 0.3)) : Math.max(c.u0 + 0.3, Math.min(t, c.ucog - 0.3)); tg[side] = t;
        lines[side] = fixed(side) != null ? {u: fixed(side)} : side ? snap(t, c, c.ucog + 0.3) : snap(t, c, -Infinity, c.ucog - 0.3); });
      [0, 1].forEach(side => {
        const t = tg[side], forced = fixed(side), line = lines[side];
        gs.forEach(gi => {
          const st = stIn(gi, c); let u = line.u;
          if (forced == null) { const okJ = x => !(side === 0 && jl && x < c.u0 + dJ - 0.02) && !(side === 1 && jr && x > c.u1 - dJ + 0.02);
            const n = nearest(st.filter(okJ), line.u); if (n != null && Math.abs(n - line.u) < 0.3) u = n; }
          const p = sm.pointBelow(gi, u, Ls, Bs);
          p.near = st.length ? Math.min(...st.map(s => Math.abs(s - u))) : null;
          out.push({...p, k, side, target: t, moved: forced != null});
        });
      });
    });
    return out;
  }

  /**
   * Reazioni degli appoggi di un concio rigido su appoggi di uguale rigidezza: R = a + b·du + c·dv,
   * con ΣR = W e momenti nulli attorno al baricentro (du, dv dal baricentro). Appoggi allineati: si risolve lungo la linea.
   */
  function supportReactions(pts, W, uc, vc) {
    const du = pts.map(p => p.u - uc), dv = pts.map(p => p.v - vc), n = pts.length, S = a => a.reduce((s, x) => s + x, 0);
    const M = [[n, S(du), S(dv)], [S(du), S(du.map(x => x * x)), S(du.map((x, i) => x * dv[i]))], [S(dv), S(du.map((x, i) => x * dv[i])), S(dv.map(x => x * x))]];
    let R = null, misalign = 0;
    const sol = n >= 3 ? solve3(M, [W, 0, 0]) : null;
    if (sol) R = du.map((x, i) => sol[0] + sol[1] * x + sol[2] * dv[i]);
    else { // appoggi su una linea: equilibrio lungo la linea, il baricentro deve stare sulla linea
      const a = pts[0], b = pts[n - 1], ex = b.u - a.u, ey = b.v - a.v, el = Math.hypot(ex, ey) || 1, t = [ex / el, ey / el];
      const ds = pts.map((p, i) => du[i] * t[0] + dv[i] * t[1]), s1 = S(ds), s2 = S(ds.map(x => x * x)), det = n * s2 - s1 * s1;
      R = Math.abs(det) > 1e-9 ? ds.map(x => (W * s2 - W * s1 * x) / det) : pts.map(() => W / n);
      misalign = Math.abs((uc - a.u) * ey - (vc - a.v) * ex) / el;
    }
    return {R, misalign, negative: R.some(r => r < 0)};
  }

  // ------------------------------------------------------------------ SAGOMA ESTERNA (solo contorno)
  /** Proiezione con la sola sagoma esterna: impronta dei pezzi riempita, contorno esterno semplificato. Stesso formato di hiddenLine. */
  function silhouette(meshes, view, res) {
    const f = norm(view.f), r = norm(cross(f, view.up)), up = cross(r, f);
    let n0 = 0; const c0 = [0, 0, 0]; meshes.forEach(m => { for (let i = 0; i < m.pos.length; i += 3) { c0[0] += m.pos[i]; c0[1] += m.pos[i + 1]; c0[2] += m.pos[i + 2]; n0++; } });
    if (n0) { c0[0] /= n0; c0[1] /= n0; c0[2] /= n0; }
    const P0 = [dot(c0, r), dot(c0, up), dot(c0, f)];
    const prjL = (x, y, z) => { x -= c0[0]; y -= c0[1]; z -= c0[2]; return [x * r[0] + y * r[1] + z * r[2], x * up[0] + y * up[1] + z * up[2], x * f[0] + y * f[1] + z * f[2]]; };
    const prj = (x, y, z) => { const q = prjL(x, y, z); return [q[0] + P0[0], q[1] + P0[1], q[2] + P0[2]]; };
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    const PP = meshes.map(m => { const q = new Float64Array(m.pos.length); for (let i = 0; i < m.pos.length; i += 3) { const s = prjL(m.pos[i], m.pos[i + 1], m.pos[i + 2]); q[i] = s[0]; q[i + 1] = s[1]; if (s[0] < umin) umin = s[0]; if (s[0] > umax) umax = s[0]; if (s[1] < vmin) vmin = s[1]; if (s[1] > vmax) vmax = s[1]; } return q; });
    const span = Math.max(umax - umin, vmax - vmin, 1e-6), px = span / res;
    const W = Math.ceil((umax - umin) / px) + 5, H = Math.ceil((vmax - vmin) / px) + 5;
    const gx = u => (u - umin) / px + 2, gy = v => (v - vmin) / px + 2;
    let mask = new Uint8Array(W * H);
    const plot = (x, y) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < W && y < H) mask[y * W + x] = 1; };
    const line = (x0, y0, x1, y1) => { const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)))); for (let i = 0; i <= n; i++) plot(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); };
    meshes.forEach((m, mi) => { const q = PP[mi], ix = m.idx;
      for (let t = 0; t < ix.length; t += 3) {
        const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
        const x0 = gx(q[a]), y0 = gy(q[a + 1]), x1 = gx(q[b]), y1 = gy(q[b + 1]), x2 = gx(q[c]), y2 = gy(q[c + 1]);
        line(x0, y0, x1, y1); line(x1, y1, x2, y2); line(x2, y2, x0, y0); // anche le lamiere viste di taglio
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0); if (Math.abs(area) < 1e-9) continue;
        for (let y = Math.max(0, Math.floor(Math.min(y0, y1, y2))); y <= Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2))); y++)
          for (let x = Math.max(0, Math.floor(Math.min(x0, x1, x2))); x <= Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2))); x++) {
            const w0 = ((x1 - x) * (y2 - y) - (x2 - x) * (y1 - y)) / area, w1 = ((x2 - x) * (y0 - y) - (x0 - x) * (y2 - y)) / area, w2 = 1 - w0 - w1;
            if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) mask[y * W + x] = 1;
          }
      } });
    // chiusura morfologica (dilata + erode) per unire fessure di 1-2 pixel
    const morph = (src, val) => { const out = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = val ? 0 : 1;
      for (let dy = -1; dy <= 1 && (val ? !v : v); dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; const s = X >= 0 && Y >= 0 && X < W && Y < H ? src[Y * W + X] : 0; if (val ? s : !s) { v = val ? 1 : 0; break; } }
      out[y * W + x] = v; } return out; };
    mask = morph(morph(mask, true), false);
    // esterno: riempimento dal bordo; tutto ciò che non è esterno è "pieno" (i fori interni scompaiono)
    const outside = new Uint8Array(W * H), stack = [];
    for (let x = 0; x < W; x++) { stack.push(x, (H - 1) * W + x); } for (let y = 0; y < H; y++) { stack.push(y * W, y * W + W - 1); }
    while (stack.length) { const k = stack.pop(); if (outside[k] || mask[k]) continue; outside[k] = 1; const x = k % W, y = (k - x) / W;
      if (x > 0) stack.push(k - 1); if (x < W - 1) stack.push(k + 1); if (y > 0) stack.push(k - W); if (y < H - 1) stack.push(k + W); }
    const fill = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !outside[y * W + x] ? 1 : 0;
    // marching squares sul contorno del pieno
    const segs = [];
    for (let y = -1; y < H; y++) for (let x = -1; x < W; x++) {
      const a = fill(x, y), b = fill(x + 1, y), c = fill(x + 1, y + 1), d = fill(x, y + 1), code = a | b << 1 | c << 2 | d << 3;
      if (code === 0 || code === 15) continue;
      const T = [x + 0.5, y], Rr = [x + 1, y + 0.5], Bm = [x + 0.5, y + 1], Lf = [x, y + 0.5];
      const S = {1: [[Lf, T]], 2: [[T, Rr]], 3: [[Lf, Rr]], 4: [[Rr, Bm]], 5: [[Lf, T], [Rr, Bm]], 6: [[T, Bm]], 7: [[Lf, Bm]], 8: [[Bm, Lf]], 9: [[Bm, T]], 10: [[T, Rr], [Bm, Lf]], 11: [[Bm, Rr]], 12: [[Rr, Lf]], 13: [[Rr, T]], 14: [[T, Lf]]}[code];
      S.forEach(sg => segs.push(sg));
    }
    // concatena i segmenti in polilinee e le semplifica (Douglas-Peucker, tolleranza 0,8 pixel)
    const key = p => p[0] * 2 + ',' + p[1] * 2, adj = new Map();
    segs.forEach((sg, i) => { [0, 1].forEach(e => { const k = key(sg[e]); if (!adj.has(k)) adj.set(k, []); adj.get(k).push(i); }); });
    const used = new Uint8Array(segs.length), polys = [];
    for (let i = 0; i < segs.length; i++) { if (used[i]) continue; used[i] = 1; const pl = [segs[i][0], segs[i][1]];
      for (const end of [1, 0]) { let guard = 0; while (guard++ < 1e6) { const tip = end ? pl[pl.length - 1] : pl[0]; const nb = (adj.get(key(tip)) || []).find(j => !used[j]); if (nb == null) break; used[nb] = 1;
        const sg = segs[nb], nxt = key(sg[0]) === key(tip) ? sg[1] : sg[0]; if (end) pl.push(nxt); else pl.unshift(nxt); } }
      polys.push(pl); }
    const dp = (pts, tol) => { if (pts.length < 3) return pts; let dm = 0, im = 0; const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1], L = Math.hypot(bx - ax, by - ay) || 1e-9;
      for (let i = 1; i < pts.length - 1; i++) { const dd = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L; if (dd > dm) { dm = dd; im = i; } }
      return dm > tol ? dp(pts.slice(0, im + 1), tol).slice(0, -1).concat(dp(pts.slice(im), tol)) : [pts[0], pts[pts.length - 1]]; };
    const toUV = p => [(p[0] - 2) * px + umin + P0[0], (p[1] - 2) * px + vmin + P0[1]];
    const out = [];
    polys.forEach(pl => { if (pl.length < 4) return; const h = Math.floor(pl.length / 2), sp = dp(pl.slice(0, h + 1), 0.8).slice(0, -1).concat(dp(pl.slice(h), 0.8)); for (let i = 1; i < sp.length; i++) { const a = toUV(sp[i - 1]), b = toUV(sp[i]); out.push([a[0], a[1], b[0], b[1]]); } });
    return {segs: out, umin: umin + P0[0], umax: umax + P0[0], vmin: vmin + P0[1], vmax: vmax + P0[1], prj};
  }

  // ------------------------------------------------------------------ CONTORNI PER ELEMENTO (sagoma con elementi dietro)
  /** Prepara gli spigoli saldati di un pezzo con le normali delle facce adiacenti. */
  function edgeNormals(mesh) {
    const p = mesh.pos, ix = mesh.idx, key = new Map(), weld = new Int32Array(p.length / 3);
    for (let i = 0; i < p.length / 3; i++) { const k = Math.round(p[i * 3] * 2e3) + ',' + Math.round(p[i * 3 + 1] * 2e3) + ',' + Math.round(p[i * 3 + 2] * 2e3); let w = key.get(k); if (w === undefined) { w = i; key.set(k, i); } weld[i] = w; }
    const edges = new Map();
    for (let t = 0; t < ix.length; t += 3) {
      const a = weld[ix[t]], b = weld[ix[t + 1]], c = weld[ix[t + 2]]; if (a === b || b === c || a === c) continue;
      const A = [p[a * 3], p[a * 3 + 1], p[a * 3 + 2]], B = [p[b * 3], p[b * 3 + 1], p[b * 3 + 2]], C = [p[c * 3], p[c * 3 + 1], p[c * 3 + 2]];
      const n = norm(cross([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [C[0] - A[0], C[1] - A[1], C[2] - A[2]]));
      for (const [u, v] of [[a, b], [b, c], [c, a]]) { const k = u < v ? u * 4194304 + v : v * 4194304 + u; const e = edges.get(k); if (e) e.push(n); else edges.set(k, [n]); }
    }
    const out = []; edges.forEach((ns, k) => { const u = Math.floor(k / 4194304), v = k % 4194304; out.push({s: [p[u * 3], p[u * 3 + 1], p[u * 3 + 2], p[v * 3], p[v * 3 + 1], p[v * 3 + 2]], ns}); });
    return out;
  }
  /** Spigoli di contorno di un pezzo per una direzione di vista: bordo tra facce rivolte all'osservatore e facce non rivolte. */
  function contourEdges(en, f) {
    const out = [];
    en.forEach(e => { if (e.ns.length !== 2) { if (e.ns.some(n => dot(n, f) < -1e-3)) out.push(e.s); return; }
      const a = dot(e.ns[0], f) < -1e-3, b = dot(e.ns[1], f) < -1e-3; if (a !== b) out.push(e.s); });
    return out;
  }
  /** Toglie i frammenti di contorno: concatena i segmenti che si toccano e scarta le catene più corte di minLen (m). */
  function dropShort(segs, minLen, tol) {
    const key = (u, v) => Math.round(u / tol) + ',' + Math.round(v / tol), par = segs.map((_, i) => i), at = new Map();
    const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    segs.forEach((sg, i) => [key(sg[0], sg[1]), key(sg[2], sg[3])].forEach(k => { const j = at.get(k); if (j === undefined) at.set(k, i); else par[find(i)] = find(j); }));
    const len = new Map(); segs.forEach((sg, i) => { const r = find(i); len.set(r, (len.get(r) || 0) + Math.hypot(sg[2] - sg[0], sg[3] - sg[1])); });
    return segs.filter((_, i) => len.get(find(i)) >= minLen);
  }

  /** Pezzi minuti da escludere dalla sagoma: bulloni, pioli, rondelle (due lati sotto 6 cm e lunghezza sotto 40 cm). */
  function isMinute(m) {
    if (m.bolt) return true;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.pos.length; i += 3) for (let d = 0; d < 3; d++) { const v = m.pos[i + d]; if (v < lo[d]) lo[d] = v; if (v > hi[d]) hi[d] = v; }
    const s = [0, 1, 2].map(d => hi[d] - lo[d]).sort((a, b) => a - b);
    return s[1] < 0.06 && s[2] < 0.4;
  }

  // ------------------------------------------------------------------ VERIFICA GOLFARE EN 1993-1-8 (stesse formule del foglio MET-044_Calcolo_golfari)
  // acciaio: fy, fu per t<=40 mm, fy, fu per t>40 mm, beta_w (prospetto 4.1)
  const STEELS = {S235: [235, 360, 215, 360, 0.8], S275: [275, 430, 255, 410, 0.85], S355: [355, 510, 335, 470, 0.9], S420: [420, 520, 390, 520, 1.0], S460: [460, 540, 430, 540, 1.0]};
  const LUG_GEO_DEFAULT = {rot: false, vside: false, hv: 30, holeAuto: false, gap: 5, L: 250, t: 20, d: 40, d0: 50, R: 75, ev: 76, as: 7, n: 2, mat: 'S355', gM0: 1.05, gM2: 1.25, gM6: 1.0, gtot: 2, pOut: 0.1, bw: 0, prep: 'fillet', bev: 45, root: 0};
  /** g: geometria in mm e materiale; F: {FEk kN (tiro caratteristico), aV gradi (fune sull'orizzontale), aH gradi (fune rispetto al piano del golfare)} */
  function lugCheck(g, F) {
    const st = STEELS[g.mat] || STEELS.S355, t = g.t, L = g.L, d = g.d, d0 = g.d0, ev = g.ev, as = g.as, n = g.n;
    const fy = t <= 40 ? st[0] : st[2], fu = t <= 40 ? st[1] : st[3], bw = g.bw > 0 ? g.bw : st[4], E = 210000;
    const a = Math.max(1e-6, g.R - 0.5 * d0), c = a, rad = x => x * Math.PI / 180; // foro più grande della piastra: verifica non soddisfatta
    const FEk = F.FEk, FEd = g.gtot * FEk, Hs = FEd * g.pOut;
    const VEd = FEd * Math.sin(rad(F.aV)), HEd = FEd * Math.cos(rad(F.aV)), Hx = HEd * Math.cos(rad(F.aH)), Hy = HEd * Math.sin(rad(F.aH)) + Hs;
    const it = [];
    const push = (key, label, ed, rd, unit) => it.push({key, label, ed, rd, unit, r: ed / rd});
    // §3.13.1 geometria (tipo A)
    push('a', 'Distanza bordo foro a (§3.13.1)', FEd * 1000 * g.gM0 / (2 * t * fy) + 2 * d0 / 3, a, 'mm');
    push('c', 'Distanza bordo foro c (§3.13.1)', FEd * 1000 * g.gM0 / (2 * t * fy) + d0 / 3, c, 'mm');
    // §3.13.2 rifollamento
    push('fb', 'Rifollamento SLU (§3.13.2)', FEd, 1.5 * t * d * fy / g.gM0 / 1000, 'kN');
    push('fbs', 'Rifollamento SLE (§3.13.2)', FEk, 0.6 * t * d * fy / g.gM6 / 1000, 'kN');
    // pressione di contatto (§3.13.2): non richiesta, tolta
    // sezione 1-1: taglio
    push('v11', 'Taglio sezione 1-1', FEd, 2 * t * a * (fy / Math.sqrt(3)) / g.gM0 / 1000, 'kN');
    // sezione 2-2: Von Mises
    const A = L * t, Wy = t * L * L / 6, Wx = L * t * t / 6, My = Hx * ev / 1000, Mx = Hy * ev / 1000;
    const sig = VEd * 1000 / A + My * 1e6 / Wy + Mx * 1e6 / Wx, tau = Hx * 1000 / A + Hy * 1000 / A;
    push('s22', 'Von Mises sezione 2-2', Math.sqrt(sig * sig + 3 * tau * tau), fy / g.gM0, 'MPa');
    // giunto a doppio cianfrino a V (K) a piena penetrazione: resistenza pari a quella della parte più debole (§4.7.1)
    if (g.prep === 'K') { const s22 = it[it.length - 1]; push('w', 'Saldatura piena penetrazione K (§4.7.1)', s22.ed, s22.rd, 'MPa');
      return {fy, fu, bw, a, FEk, FEd, VEd, Hx, Hy, items: it, max: Math.max(...it.map(x => x.r))}; }
    // saldature §4.5.3.3
    const As = L * as * n, Wys = as * L * L * n / 6, Wxs = L * as * t / 2 * n, k = n * as;
    const fn = (VEd * 1000 / As + My * 1e6 / Wys + Mx * 1e6 / Wxs) * k, ftx = Hx * 1000 / As * k, fty = Hy * 1000 / As * k;
    push('w', 'Saldature (§4.5.3.3)', Math.hypot(fn, ftx, fty), fu / Math.sqrt(3) / (bw * g.gM2) * k, 'N/mm');
    return {fy, fu, bw, a, FEk, FEd, VEd, Hx, Hy, items: it, max: Math.max(...it.map(x => x.r))};
  }

  // ------------------------------------------------------------------ DISEGNO D'OFFICINA DEL GOLFARE (piastra con foro, saldata a cordoni d'angolo)
  /** g: geometria in mm {L, t, R, ev, d, d0, as, n, mat}; info: {name, project, count, ecMax, shackle} */
  function buildLugShop(g, info = {}) {
    const L = g.L, t = g.t, R = g.R, ev = g.ev, d0 = g.d0, H = ev + R, K = g.prep === 'K', root = Math.min(t, Math.max(0, g.root || 0)), bev = Math.min(80, Math.max(15, g.bev || 45));
    const hK = K ? (t - root) / 2 * Math.tan(bev * Math.PI / 180) : 0, z = K ? 0 : g.as * Math.SQRT2;
    const sh = g.sh && g.sh.C ? g.sh : null, thS = (g.theta || 0) * Math.PI / 180, hv = g.vside ? Math.max(0, Math.min(+g.hv || 0, ev)) : 0;
    const Htot = sh ? Math.max(H, ev + (sh.C + sh.D) * Math.cos(thS)) : H, Wtot = sh ? Math.max(L, 2 * ((sh.C + sh.D) * Math.sin(thS) + sh.D)) : L;
    const S = [1, 2, 2.5, 5, 10].find(s => (Wtot + 90) / s <= 270 && (Htot + 60) / s <= 150 && (Math.max(t + 2 * z, sh ? sh.E + 2 * sh.D : 0) + 20) / s <= 100) || 10, k = 1 / S;
    const P = [];
    const Ln = (a, b, layer, w) => P.push({t: 'line', a, b, layer: layer || 'CONTORNI', w: w || 0.35});
    const T = (p, txt, size, layer, align) => P.push({t: 'text', p, txt: String(txt), s: (size || 2.5) * 1.3, layer: layer || 'TESTI', align: align || 'left'});
    const Ci = (c, r, layer, w) => P.push({t: 'circle', c, r, layer: layer || 'CONTORNI', w: w || 0.35});
    const Arc = (c, r, a0, a1, layer, w) => P.push({t: 'arc', c, r, a0, a1, layer: layer || 'CONTORNI', w: w || 0.35});
    const rect = (x, y, w, h, layer, wt) => { Ln([x, y], [x + w, y], layer, wt); Ln([x + w, y], [x + w, y + h], layer, wt); Ln([x + w, y + h], [x, y + h], layer, wt); Ln([x, y + h], [x, y], layer, wt); };
    const dash = (a, b, layer, w, on = 3, off = 1.5) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]); for (let s0 = 0; s0 < l; s0 += on + off) { const s1 = Math.min(l, s0 + on); Ln([a[0] + (b[0] - a[0]) * s0 / l, a[1] + (b[1] - a[1]) * s0 / l], [a[0] + (b[0] - a[0]) * s1 / l, a[1] + (b[1] - a[1]) * s1 / l], layer, w || 0.15); } };
    const axis = (a, b) => dash(a, b, 'ASSI', 0.15, 6, 1.5);
    const tick = (p, ang) => { const c = Math.cos(ang), s = Math.sin(ang), q = 1.2; Ln([p[0] - q * (c + s), p[1] - q * (s - c)], [p[0] + q * (c + s), p[1] + q * (s - c)], 'QUOTE', 0.25); };
    const hd = (xa, xb, y, yref, txt) => { Ln([xa, yref], [xa, y - 1.5 * Math.sign(y - yref)], 'QUOTE', 0.15); Ln([xb, yref], [xb, y - 1.5 * Math.sign(y - yref)], 'QUOTE', 0.15); Ln([xa - 2, y], [xb + 2, y], 'QUOTE', 0.2); tick([xa, y], Math.PI / 4); tick([xb, y], Math.PI / 4); T([(xa + xb) / 2, y + 2], txt, 2.6, 'QUOTE', 'center'); };
    const vd = (ya, yb, x, xref, txt) => { Ln([xref, ya], [x - 1.5 * Math.sign(x - xref), ya], 'QUOTE', 0.15); Ln([xref, yb], [x - 1.5 * Math.sign(x - xref), yb], 'QUOTE', 0.15); Ln([x, ya - 2], [x, yb + 2], 'QUOTE', 0.2); tick([x, ya], Math.PI / 4); tick([x, yb], Math.PI / 4); T([x - 1.5, (ya + yb) / 2], txt, 2.6, 'QUOTE', 'right'); };
    rect(5, 5, 410, 287, 'CORNICE', 0.5);
    // ---- prospetto
    const RF = [12, 112, 290, 175]; rect(...RF, 'CORNICE', 0.18);
    T([RF[0] + 3, RF[1] + RF[3] - 5], `PROSPETTO   1:${S}`, 2.8);
    const ox = RF[0] + RF[2] / 2 + 10, oy = RF[1] + 30, m = (x, y) => [ox + x * k, oy + y * k];
    const C = [0, ev];
    // tangenti dagli spigoli di base alla circonferenza
    const tang = s => { const Px = s * L / 2, dx = Px - C[0], dy = hv - C[1], D = Math.hypot(dx, dy);
      if (D <= R) { const yy = ev - Math.sqrt(Math.max(0, R * R - (L / 2) ** 2)); return {p: [Px, yy], a: Math.atan2(yy - ev, Px) * 180 / Math.PI}; }
      const phi = Math.atan2(dy, dx), be = Math.acos(R / D), c1 = phi + be, c2 = phi - be;
      const p1 = [C[0] + R * Math.cos(c1), C[1] + R * Math.sin(c1)], p2 = [C[0] + R * Math.cos(c2), C[1] + R * Math.sin(c2)];
      const pick = s * p1[0] > s * p2[0] ? [p1, c1] : [p2, c2]; return {p: pick[0], a: pick[1] * 180 / Math.PI}; };
    const tr = tang(1), tl = tang(-1);
    Ln(m(-L / 2, 0), m(L / 2, 0), 'CONTORNI', 0.5);
    if (hv > 0) { Ln(m(L / 2, 0), m(L / 2, hv), 'CONTORNI', 0.5); Ln(m(-L / 2, 0), m(-L / 2, hv), 'CONTORNI', 0.5); }
    Ln(m(L / 2, hv), m(...tr.p), 'CONTORNI', 0.5); Ln(m(-L / 2, hv), m(...tl.p), 'CONTORNI', 0.5);
    if (hv > 0) { const xq = m(L / 2, 0)[0] + 10; Ln([xq, oy - 2], [xq, m(0, hv)[1] + 2], 'QUOTE', 0.2); tick([xq, oy], Math.PI / 4); tick([xq, m(0, hv)[1]], Math.PI / 4); T([xq + 1.5, (oy + m(0, hv)[1]) / 2], nf(hv, 0), 2.4, 'QUOTE'); }
    let a0 = tr.a, a1 = tl.a; while (a1 < a0) a1 += 360; Arc(m(...C), R * k, a0, a1, 'CONTORNI', 0.5);
    Ci(m(...C), d0 / 2 * k, 'CONTORNI', 0.5);
    axis(m(-R - 12, ev), m(R + 12, ev)); axis(m(0, -10), m(0, H + 12));
    if (sh) { // grillo visto di taglio, inclinato come la fune (linee sottili tratteggiate)
      const ux = Math.sin(thS), uy = Math.cos(thS), pp = (r, w) => m(r * ux + w * uy, ev + r * uy - w * ux), hw = sh.D / 2, rb = sh.C + sh.D / 2;
      dash(pp(0, -hw), pp(rb, -hw), 'FUNI', 0.25, 2, 1); dash(pp(0, hw), pp(rb, hw), 'FUNI', 0.25, 2, 1);
      P.push({t: 'circle', c: pp(rb, 0), r: sh.D / 2 * k, layer: 'FUNI', w: 0.25}); P.push({t: 'circle', c: pp(0, 0), r: (sh.B / 2 + sh.D * 0.45) * k, layer: 'FUNI', w: 0.25});
      const gp = sh.C - R; Ln(pp(R, 0), pp(sh.C, 0), gp > 0 ? 'QUOTE' : 'BARICENTRO', 0.6);
      const lp = pp((R + sh.C) / 2, 0), dl = thS >= 0 ? -1 : 1, e2 = [lp[0] + dl * 22, lp[1] + 4]; Ln(lp, e2, 'QUOTE', 0.15); Ln(e2, [e2[0] + dl * 26, e2[1]], 'QUOTE', 0.15);
      T([e2[0] + dl * 1, e2[1] + 2], `spazio fune ${nf(gp, 0)}`, 2.3, gp > 0 ? 'QUOTE' : 'BARICENTRO', dl < 0 ? 'right' : 'left'); T([e2[0] + dl * 1, e2[1] - 3.5], sh.name || 'grillo', 1.9, 'FUNI', dl < 0 ? 'right' : 'left');
    }
    // saldature in prospetto (cordoni alla base)
    if (K) { Ln(m(-L / 2, hK), m(L / 2, hK), 'CONTORNI', 0.3); T(m(L / 2 + 4, 3), 'K', 2.4, 'QUOTE'); }
    else { Ln(m(-L / 2 - z, 0), m(L / 2 + z, 0), 'CONTORNI', 0.25); T(m(L / 2 + z + 4, -3 * S), `a${nf(g.as, 0)}`, 2.4, 'QUOTE'); }
    // quote
    hd(m(-L / 2, 0)[0], m(L / 2, 0)[0], oy - 14, oy - 1, `L = ${nf(L, 0)}`);
    vd(oy, m(0, ev)[1], m(-L / 2, 0)[0] - 10, m(-R, ev)[0] - 2, `ev = ${nf(ev, 0)}`);
    vd(oy, m(0, H)[1], m(-L / 2, 0)[0] - 24, m(0, H)[0] - 2, `H = ${nf(H, 0)}`);
    { const an = Math.PI / 4, pa = m(C[0] + R * Math.cos(an), C[1] + R * Math.sin(an)), pc = m(...C), pe = [pa[0] + 10, pa[1] + 10];
      Ln(pc, pa, 'QUOTE', 0.2); Ln(pa, pe, 'QUOTE', 0.2); Ln(pe, [pe[0] + 14, pe[1]], 'QUOTE', 0.2); T([pe[0] + 1, pe[1] + 2], `R ${nf(R, 0)}`, 2.6, 'QUOTE'); }
    { const an = -Math.PI * 0.8, pa = m(C[0] + d0 / 2 * Math.cos(an), C[1] + d0 / 2 * Math.sin(an)), pe = [pa[0] - 22, pa[1] - 8];
      Ln(pa, pe, 'QUOTE', 0.2); Ln(pe, [pe[0] - 22, pe[1]], 'QUOTE', 0.2); T([pe[0] - 21, pe[1] + 2], `Ø ${nf(d0, 1)} foro`, 2.6, 'QUOTE'); }
    // ---- dettaglio del cianfrino (in alto a sinistra nel riquadro del prospetto)
    if (K) {
      const box = [RF[0] + 4, RF[1] + RF[3] - 70, 84, 58], hh = hK + Math.max(12, t * 0.6);
      const SD = [5, 4, 3, 2, 1, 0.5, 0.4, 0.25, 0.2].find(f => (t + 24) * f <= box[2] - 8 && (hh + 10) * f + 16 <= box[3] - 6) || 0.2;
      const dx0 = box[0] + box[2] / 2, dy0 = box[1] + 12, dm = (x, y) => [dx0 + x * SD, dy0 + y * SD];
      T([box[0] + 1, box[1] + box[3] - 2], `DETTAGLIO CIANFRINO   ${SD >= 1 ? SD + ':1' : '1:' + Math.round(1 / SD)}`, 2.4);
      // piastra tagliata in alto (linea di interruzione a zig-zag)
      Ln(dm(-t / 2, hh), dm(-t / 6, hh + 1.2), 'CONTORNI', 0.2); Ln(dm(-t / 6, hh + 1.2), dm(t / 6, hh - 1.2), 'CONTORNI', 0.2); Ln(dm(t / 6, hh - 1.2), dm(t / 2, hh), 'CONTORNI', 0.2);
      [[-t / 2, hh], [-t / 2, hK], [-root / 2, 0]].reduce((a, q) => { Ln(dm(...a), dm(...q), 'CONTORNI', 0.5); return q; });
      [[t / 2, hh], [t / 2, hK], [root / 2, 0]].reduce((a, q) => { Ln(dm(...a), dm(...q), 'CONTORNI', 0.5); return q; });
      if (root > 0) Ln(dm(-root / 2, 0), dm(root / 2, 0), 'CONTORNI', 0.5);
      Ln(dm(-t / 2 - 10, 0), dm(t / 2 + 10, 0), 'CONTORNI', 0.5); T(dm(t / 2 + 3, -4), 'piattabanda', 2.0);
      dash(dm(-t / 2, hK), dm(-t / 2, 0), 'CONTORNI', 0.12, 1.5, 1); dash(dm(t / 2, hK), dm(t / 2, 0), 'CONTORNI', 0.12, 1.5, 1);
      // quote: t, altezza del cianfrino, angolo, spalla
      hd(dm(-t / 2, hh)[0], dm(t / 2, hh)[0], dm(0, hh)[1] + 7, dm(0, hh)[1] + 2, `t = ${nf(t, 0)}`);
      vd(dm(0, 0)[1], dm(0, hK)[1], dm(-t / 2, 0)[0] - 7, dm(-t / 2, 0)[0] - 1, nf(hK, 1));
      T([dm(t / 2, hK)[0] + 2, dm(t / 2, hK)[1] - 4], `${nf(bev, 0)}°`, 2.4, 'QUOTE');
      { const a1 = dm(t / 2, hK), r1 = 6; Arc(dm(t / 2, hK), r1, 180 + bev, 270, 'QUOTE', 0.2); }
      T([dx0, box[1] + 3], `c = ${nf(root, 0)} mm · piena penetrazione`, 2.0, 'QUOTE', 'center');
    }
    // ---- vista laterale
    const RS = [304, 112, 104, 175]; rect(...RS, 'CORNICE', 0.18);
    T([RS[0] + 3, RS[1] + RS[3] - 5], `VISTA LATERALE   1:${S}`, 2.8);
    const sx = RS[0] + RS[2] / 2, sm = (x, y) => [sx + x * k, oy + y * k];
    if (K) { const pts = [[-t / 2, H], [t / 2, H], [t / 2, hK], [root / 2, 0], [-root / 2, 0], [-t / 2, hK]]; pts.forEach((q, i) => { const r2 = pts[(i + 1) % pts.length]; if (!(i === 3 && root === 0)) Ln(sm(...q), sm(...r2), 'CONTORNI', 0.5); }); }
    else rect(sm(-t / 2, 0)[0], oy, t * k, H * k, 'CONTORNI', 0.5);
    dash(sm(-t / 2, ev - d0 / 2), sm(t / 2, ev - d0 / 2), 'CONTORNI', 0.2); dash(sm(-t / 2, ev + d0 / 2), sm(t / 2, ev + d0 / 2), 'CONTORNI', 0.2);
    axis(sm(-t / 2 - 8, ev), sm(t / 2 + 8, ev)); axis(sm(0, -8), sm(0, H + 10));
    Ln(sm(-t / 2 - z - 25, 0), sm(t / 2 + z + 25, 0), 'CONTORNI', 0.35); T(sm(t / 2 + z + 2, -10), 'piattabanda', 2.0, 'TESTI');
    if (K) [-1, 1].forEach(s => { // cianfrino riempito, con raccordo di sovrametallo
      const a = sm(s * t / 2, hK), b = sm(s * root / 2, 0), c = sm(s * (t / 2 + hK * 0.35), 0); Ln(a, c, 'CONTORNI', 0.35);
      for (let f = 0.15; f < 1; f += 0.15) { const y = hK * f, x0 = root / 2 + (t - root) / 2 * f, x1 = t / 2 + hK * 0.35 * (1 - f); Ln(sm(s * x0, y), sm(s * x1, y), 'CONTORNI', 0.1); } });
    else [-1, 1].forEach(s => { if (g.n < 2 && s < 0) return; const a = sm(s * t / 2, z), b = sm(s * (t / 2 + z), 0), c = sm(s * t / 2, 0); Ln(a, b, 'CONTORNI', 0.35); Ln(b, c, 'CONTORNI', 0.35); Ln(c, a, 'CONTORNI', 0.35); });
    if (sh) { const xa = sh.A / 2 + sh.D / 2, xe = sh.E / 2 + sh.D / 2, yb = ev + sh.C - sh.E / 2;
      [-1, 1].forEach(q => dash(sm(q * xa, ev), sm(q * xe, yb), 'FUNI', 0.25, 2, 1));
      for (let a = 0; a < 180; a += 12) { const a0 = a * Math.PI / 180, a1 = Math.min(180, a + 12) * Math.PI / 180; Ln(sm(xe * Math.cos(a0), yb + xe * Math.sin(a0)), sm(xe * Math.cos(a1), yb + xe * Math.sin(a1)), 'FUNI', 0.25); }
      Ln(sm(-xa - sh.D, ev), sm(xa + sh.D, ev), 'FUNI', 0.25); }
    hd(sm(-t / 2, 0)[0], sm(t / 2, 0)[0], m(0, H)[1] + 8, m(0, H)[1] + 1, `t = ${nf(t, 0)}`);
    if (K) { const p = sm(t / 2, hK * 0.5), e = [p[0] + 12, p[1] + 16]; Ln(p, e, 'QUOTE', 0.2); Ln(e, [e[0] + 30, e[1]], 'QUOTE', 0.2); T([e[0] + 1, e[1] + 2], `K  ${nf(bev, 0)}°  c ${nf(root, 0)}`, 2.4, 'QUOTE'); T([e[0] + 1, e[1] - 3.5], 'piena penetrazione', 2.0, 'QUOTE');
      vd(oy, sm(0, hK)[1], sm(-t / 2, 0)[0] - 8, sm(-t / 2, 0)[0] - 1, nf(hK, 0)); }
    else { const p = sm(t / 2 + z * 0.4, z * 0.4), e = [p[0] + 12, p[1] + 14]; Ln(p, e, 'QUOTE', 0.2); Ln(e, [e[0] + 18, e[1]], 'QUOTE', 0.2); T([e[0] + 1, e[1] + 2], `a = ${nf(g.as, 0)}${g.n >= 2 ? '  2 lati' : ''}`, 2.4, 'QUOTE'); }
    // ---- pianta
    const RP = [12, 50, 290, 60]; rect(...RP, 'CORNICE', 0.18);
    T([RP[0] + 3, RP[1] + RP[3] - 5], `PIANTA   1:${S}`, 2.8);
    const py = RP[1] + RP[3] / 2 - 4, pm = (x, y) => [ox + x * k, py + y * k];
    rect(pm(-L / 2, -t / 2)[0], pm(0, -t / 2)[1], L * k, t * k, 'CONTORNI', 0.5);
    if (false) [-1, 1].forEach(s => { if (g.n < 2 && s < 0) return; Ln(pm(-L / 2, s * (t / 2 + z)), pm(L / 2, s * (t / 2 + z)), 'CONTORNI', 0.25); for (let x = -L / 2; x <= L / 2 + 0.1; x += Math.max(4 * S, L / 40)) Ln(pm(x, s * t / 2), pm(x, s * (t / 2 + z)), 'CONTORNI', 0.12); });
    axis(pm(-L / 2 - 10, 0), pm(L / 2 + 10, 0)); axis(pm(0, -t / 2 - 10), pm(0, t / 2 + 10));
    dash(pm(-d0 / 2, -t / 2), pm(-d0 / 2, t / 2), 'CONTORNI', 0.2); dash(pm(d0 / 2, -t / 2), pm(d0 / 2, t / 2), 'CONTORNI', 0.2);
    // ---- note
    const RN = [304, 50, 104, 60]; rect(...RN, 'CORNICE', 0.18);
    let ny = RN[1] + RN[3] - 6; const note = (txt, sz) => { T([RN[0] + 3, ny], txt, sz || 2.1); ny -= (sz || 2.1) * 1.3 + 2; };
    note('NOTE', 2.6);
    note(`Materiale: acciaio ${g.mat}, lamiera sp. ${nf(t, 0)} mm`);
    note(`Foro Ø ${nf(d0, 1)} mm per perno Ø ${nf(g.d, 1)} mm${info.shackle ? ' (' + info.shackle + ')' : ''}`); if (g.holeAuto) note('Foro dimensionato sul grillo maggiore');
    if (K) note(`Doppio cianfrino a V (K) ${nf(bev, 0)}°, spalla c = ${nf(root, 0)} mm, piena penetrazione`);
    else note(`Saldatura a cordone d'angolo a = ${nf(g.as, 0)} mm`);
    if (info.count) note(`Quantità: ${info.count} pezzi`);
    note('Quote in mm');
    // ---- cartiglio
    const ty = 8, th = 38; rect(12, ty, 396, th, 'CORNICE', 0.35); Ln([250, ty], [250, ty + th], 'CORNICE', 0.25);
    T([14, ty + th - 6], 'GOLFARE DI SOLLEVAMENTO – DISEGNO D\'OFFICINA', 3.4); P[P.length - 1].bold = true;
    T([14, ty + th - 13], `${info.name || ''}`, 2.6);
    T([14, ty + th - 20], `Piastra ${nf(L, 0)} × ${nf(H, 0)} × ${nf(t, 0)} mm · ${g.mat} · foro Ø ${nf(d0, 0)} · scala 1:${S} su A3`, 2.3);
    cartRight(P, 252, ty, th, info.project, [], 'Peso e baricentro · Golfari · Trimble Connect');
    logos(P, ty);
    return {prims: P, scale: S};
  }

  // ------------------------------------------------------------------ DISEGNO DI POSIZIONAMENTO DEI GOLFARI (pianta + sezioni)
  /**
   * d = {meshes (rel. ref, solo il corpo di riferimento), ref, ax, cog (ass.), lugs:[{n, x, y, z, gv, gw}] (gv/gw: asse e larghezza piattabanda, m, nel riferimento di ax),
   *      refLabel, name, project, geo:{L, t, ev, R} (mm)}
   */
  function buildLugLayout(d) {
    const ax = d.ax, pv = [-ax[1], ax[0]], c0 = d.cog;
    const toL = (x, y, z) => { const dx = x - c0[0], dy = y - c0[1]; return [dx * ax[0] + dy * ax[1], dx * pv[0] + dy * pv[1], z - c0[2]]; };
    const local = d.meshes.filter(m => !isMinute(m)).map(m => { const q = new Float64Array(m.pos.length); for (let i = 0; i < q.length; i += 3) { const s = toL(m.pos[i] + d.ref[0], m.pos[i + 1] + d.ref[1], m.pos[i + 2] + d.ref[2]); q[i] = s[0]; q[i + 1] = s[1]; q[i + 2] = s[2]; } return {pos: q, idx: m.idx}; });
    const ctx = d.ctxMeshes ? d.ctxMeshes.filter(m => !isMinute(m)).map(m => { const q = new Float64Array(m.pos.length); for (let i = 0; i < q.length; i += 3) { const s2 = toL(m.pos[i] + d.ref[0], m.pos[i + 1] + d.ref[1], m.pos[i + 2] + d.ref[2]); q[i] = s2[0]; q[i + 1] = s2[1]; q[i + 2] = s2[2]; } return {pos: q, idx: m.idx}; }) : null;
    const all = ctx || local;
    let U0 = Infinity, U1 = -Infinity; local.forEach(m => { for (let i = 0; i < m.pos.length; i += 3) { if (m.pos[i] < U0) U0 = m.pos[i]; if (m.pos[i] > U1) U1 = m.pos[i]; } });
    const g = d.geo, Lp = g.L / 1000, tp = g.t / 1000, Hp = (g.ev + g.R) / 1000;
    const lugs = d.lugs.map(l => ({...l, L: toL(l.x, l.y, l.z)})).sort((a, b) => a.L[0] - b.L[0]);
    // bordi reali della piattabanda sotto ogni golfare: dal taglio della geometria alla progressiva del golfare
    lugs.forEach(l => { if (l.exact != null) return; let lo = Infinity, hi = -Infinity;
      all.forEach(m => cutLines(m, 0, l.L[0] - 0.12).forEach(sg => sg.forEach(q => { if (Math.abs(q[2] - l.L[2]) < 0.08 && Math.abs(q[1] - l.gv) < l.gw / 2 + 0.25) { lo = Math.min(lo, q[1]); hi = Math.max(hi, q[1]); } })));
      if (isFinite(lo) && hi - lo > 0.1 && l.L[1] > lo && l.L[1] < hi) { l.gw = hi - lo; l.gv = (hi + lo) / 2; l.web = l.web ?? null; } });
    const P = [];
    const Ln = (a, b, layer, w) => P.push({t: 'line', a, b, layer: layer || 'CONTORNI', w: w || 0.25});
    const T = (p, txt, size, layer, align) => P.push({t: 'text', p, txt: String(txt), s: (size || 2.5) * 1.4, layer: layer || 'TESTI', align: align || 'left'});
    const rect = (x, y, w, h, layer, wt) => { Ln([x, y], [x + w, y], layer, wt); Ln([x + w, y], [x + w, y + h], layer, wt); Ln([x + w, y + h], [x, y + h], layer, wt); Ln([x, y + h], [x, y], layer, wt); };
    const dashed = (a, b, layer) => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.floor(L / 4)); for (let i = 0; i < n; i++) { const t0 = i / n, t1 = (i + 0.6) / n; Ln([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1], layer || 'ASSI', 0.13); } };
    const tick = p => Ln([p[0] - 1, p[1] - 1], [p[0] + 1, p[1] + 1], 'QUOTE', 0.3);
    const hd = (xa, xb, y, txt, ya, yb) => { if (ya != null) Ln([xa, ya], [xa, y - 1], 'QUOTE', 0.12); if (yb != null) Ln([xb, yb], [xb, y - 1], 'QUOTE', 0.12); Ln([xa - 1.5, y], [xb + 1.5, y], 'QUOTE', 0.18); tick([xa, y]); tick([xb, y]); T([(xa + xb) / 2, y + 1.4], txt, 2.0, 'QUOTE', 'center'); };
    const vd = (ya, yb, x, txt, left) => { Ln([x, ya - 1.5], [x, yb + 1.5], 'QUOTE', 0.18); tick([x, ya]); tick([x, yb]); T([x + (left ? -1.2 : 1.2), (ya + yb) / 2], txt, 2.0, 'QUOTE', left ? 'right' : 'left'); };
    const mm = v => String(Math.round(Math.abs(v) * 1000)); // mm interi, senza separatore delle migliaia
    const pick = x => SCALES.find(s => s >= x) || 5000;
    rect(5, 5, 410, 287, 'CORNICE', 0.5);
    // ---- pianta
    const RP = [12, 150, 396, 137]; rect(...RP, 'CORNICE', 0.18);
    const PLAN = {f: [0, 0, -1], up: [0, 1, 0]};
    const h0 = hiddenLine(all, all.map(m => contourEdges(edgeNormals(m), norm(PLAN.f))), PLAN, 1600), HP = {...h0, segs: dropShort(h0.segs, 0.3, 0.01)};
    // con riferimento alla marca: contorno della marca evidenziato sopra il resto della struttura
    const HM = ctx ? (h => ({...h, segs: dropShort(h.segs, 0.2, 0.01)}))(hiddenLine(all, local.map(m => contourEdges(edgeNormals(m), norm(PLAN.f))), PLAN, 1600)) : null;
    // quote longitudinali: golfari quasi alla stessa progressiva su una sola riga
    const vMid = lugs.length ? (Math.max(...lugs.map(l => l.L[1])) + Math.min(...lugs.map(l => l.L[1]))) / 2 : 0;
    const upL = lugs.filter(l => l.L[1] > vMid + 0.3), dnL = lugs.filter(l => !(l.L[1] > vMid + 0.3));
    const nr = Math.max(upL.length, 1) + dnL.length + 1;
    const SP = pick(Math.max((HP.umax - HP.umin) / (RP[2] - 24), (HP.vmax - HP.vmin) / (RP[3] - 22 - nr * 6.5)) * 1000), k2 = 1000 / SP;
    const cu = (HP.umin + HP.umax) / 2, cv = (HP.vmin + HP.vmax) / 2, ox = RP[0] + RP[2] / 2, oy = RP[1] + RP[3] / 2 - (dnL.length + 1 - upL.length) * 3.5;
    const map = (u, v) => [ox + (u - cu) * k2, oy + (v - cv) * k2], pm = p => { const q = HP.prj(p[0], p[1], p[2]); return map(q[0], q[1]); };
    HP.segs.forEach(sg => Ln(map(sg[0], sg[1]), map(sg[2], sg[3]), ctx ? 'VISTA_3D' : 'CONTORNI', ctx ? 0.18 : 0.3));
    if (HM) HM.segs.forEach(sg => Ln(map(sg[0], sg[1]), map(sg[2], sg[3]), 'CONTORNI', 0.55));
    const isMark = /^marca /.test(d.refLabel || '');
    T([RP[0] + 3, RP[1] + RP[3] - 5], `PIANTA – posizione dei golfari   1:${SP}`, 2.6);
    if (isMark) { const q = [RP[0] + 3, RP[1] + RP[3] - 13], tx = `MARCA ${d.refLabel.replace(/^marca /, '')}`; P.push({t: 'tbox', p: q, txt: tx, s: 4.6 * 1.4, layer: 'SEZIONI'}); T(q, tx, 4.6, 'SEZIONI'); P[P.length - 1].bold = true; }
    else T([RP[0] + 3, RP[1] + RP[3] - 11], `Riferimento: ${d.refLabel}`, 2.0);
    // riferimento: estremità iniziale
    const r0 = pm([U0, 0, 0]), yTop = map(0, HP.vmax)[1], yBot = map(0, HP.vmin)[1];
    Ln([r0[0], yTop + 6 + upL.length * 7], [r0[0], yBot - 6 - dnL.length * 7], 'SEZIONI', 0.35); T([r0[0] - 1.5, yTop + 8 + upL.length * 7], 'RIF. 0', 2.2, 'SEZIONI', 'right');
    // golfari: impronta della piastra lungo l'asse e quote progressive dal riferimento
    lugs.forEach((l, i) => {
      const ph = l.phi || 0, cu2 = Math.cos(ph), sv2 = Math.sin(ph), cn = [[-Lp / 2, -tp / 2], [Lp / 2, -tp / 2], [Lp / 2, tp / 2], [-Lp / 2, tp / 2]].map(([a, b2]) => pm([l.L[0] + a * cu2 - b2 * sv2, l.L[1] + a * sv2 + b2 * cu2, 0]));
      cn.forEach((q, j) => Ln(q, cn[(j + 1) % 4], 'GOLFARI', 0.5)); const c = pm(l.L), hh = 1;
      { const up = l.L[1] > vMid, q = [c[0] + 2, c[1] + (up ? 2.5 : -5.5)]; P.push({t: 'tbox', p: q, txt: 'G' + l.n, s: 3.2 * 1.4, layer: 'SEZIONI'}); T(q, 'G' + l.n, 3.2, 'SEZIONI'); P[P.length - 1].bold = true; }
    });
    // ogni golfare quotato dal RIF. 0: sopra quelli della trave superiore, sotto quelli dell'inferiore
    [...upL].sort((a, b) => a.L[0] - b.L[0]).forEach((l, i) => { const c = pm(l.L), yq = yTop + 6 + i * 7; Ln(c, [c[0], yq + 1], 'QUOTE', 0.12); hd(r0[0], c[0], yq, `${mm(l.L[0] - U0)}  G${l.n}`, null, null); });
    [...dnL].sort((a, b) => a.L[0] - b.L[0]).forEach((l, i) => { const c = pm(l.L), yq = yBot - 6 - i * 7; Ln(c, [c[0], yq - 1], 'QUOTE', 0.12); hd(r0[0], c[0], yq, `${mm(l.L[0] - U0)}  G${l.n}`, null, null); });
    hd(r0[0], pm([U1, 0, 0])[0], yBot - 6 - dnL.length * 7, `L = ${mm(U1 - U0)}`, null, null);
    // ---- sezioni trasversali sui golfari
    const nS = lugs.length, W = 396 / Math.max(1, nS);
    [...lugs].sort((a, b) => a.n - b.n).forEach((l, i) => {
      const r = [12 + W * i, 38, W - 2, 110]; rect(...r, 'CORNICE', 0.18);
      const rs = [r[0], r[1] + 46, r[2], r[3] - 46]; // sezione in alto, dettaglio in pianta in basso
      Ln([r[0], r[1] + 46], [r[0] + r[2], r[1] + 46], 'CORNICE', 0.12);
      const at = l.L[0] - 0.12, view = {f: [1, 0, 0], up: [0, 0, 1]}, half = l.gw / 2 + 0.2;
      const lat = [[1, 1, l.gv - half], [1, -1, l.gv + half], [2, 1, l.L[2] - 0.45]]; // solo la parte alta della trave
      const latM = all.map(m => clipMesh(m, lat)), cuts = []; latM.forEach(m => cutLines(m, 0, at).forEach(c => cuts.push(c)));
      const pl = [...lat, [0, 1, at + 1e-4], [0, -1, at + 0.5]], beyond = all.map(m => clipMesh(m, pl)).filter(m => m.idx.length);
      const onClip = q => pl.some(([a, , v]) => Math.abs(q[a] - v) < 1e-5);
      const edges = beyond.map(m => contourEdges(edgeNormals(m), norm(view.f)).filter(e => !(onClip([e[0], e[1], e[2]]) && onClip([e[3], e[4], e[5]]))));
      const cm = {pos: new Float64Array(cuts.flat(2)), idx: new Uint32Array(0)};
      const hs = hiddenLine((beyond.length ? beyond : []).concat([cm]), edges, view, 1200), segs = dropShort(hs.segs, 0.03, 0.003);
      const cutS = cuts.map(c => { const a = hs.prj(...c[0]), b = hs.prj(...c[1]); return [a[0], a[1], b[0], b[1]]; });
      let u0 = hs.umin, u1 = hs.umax, v0 = hs.vmin, v1 = Math.max(hs.vmax, hs.prj(l.L[0], l.L[1], l.L[2] + Hp)[1]);
      const S = pick(Math.max((u1 - u0) / (rs[2] - 30), (v1 - v0) / (rs[3] - 26)) * 1000), k = 1000 / S;
      const ccu = (u0 + u1) / 2, ccv = (v0 + v1) / 2, sx = rs[0] + rs[2] / 2, sy = rs[1] + rs[3] / 2 - 6;
      const mp = (u, v) => [sx + (u - ccu) * k, sy + (v - ccv) * k], sp = p => { const q = hs.prj(p[0], p[1], p[2]); return mp(q[0], q[1]); };
      segs.forEach(sg => Ln(mp(sg[0], sg[1]), mp(sg[2], sg[3]), 'CONTORNI', 0.25));
      cutS.forEach(sg => Ln(mp(sg[0], sg[1]), mp(sg[2], sg[3]), 'TAGLIO', 0.6));
      T([r[0] + 2, r[1] + r[3] - 5], `SEZIONE G${l.n}   1:${S}`, 2.4);
      // golfare visto di taglio (spessore t, altezza H) sulla piattabanda
      const wv = Math.abs(Lp * Math.sin(l.phi || 0)) + Math.abs(tp * Math.cos(l.phi || 0)), gb = sp([l.L[0], l.L[1] - wv / 2, l.L[2]]), gt = sp([l.L[0], l.L[1] + wv / 2, l.L[2] + Hp]);
      { const fx = Math.abs(Math.sin(l.phi || 0)) > 0.3 ? Math.abs(Math.sin(l.phi || 0)) : 1, cx = sp([l.L[0], l.L[1], l.L[2]])[0], by = gb[1], kk = k / 1000;
        const pr = (x, y) => [cx + x * fx * kk * (sp([l.L[0], l.L[1] + 1, l.L[2]])[0] > cx ? 1 : -1), by + y * kk], Lm = g.L, Rm = g.R, evm = g.ev, hvm = g.vside ? Math.min(+g.hv || 0, evm) : 0;
        const tg = sgn => { const Px = sgn * Lm / 2, dy = hvm - evm, D = Math.hypot(Px, dy); if (D <= Rm) return [Px, evm - Math.sqrt(Math.max(0, Rm * Rm - Lm * Lm / 4))]; const phi = Math.atan2(dy, Px), be = Math.acos(Rm / D), c1 = [Rm * Math.cos(phi + be), evm + Rm * Math.sin(phi + be)], c2 = [Rm * Math.cos(phi - be), evm + Rm * Math.sin(phi - be)]; return sgn * c1[0] > sgn * c2[0] ? c1 : c2; };
        const tr = tg(1), tl = tg(-1), poly = [[-Lm / 2, 0], [Lm / 2, 0], [Lm / 2, hvm], tr];
        let a0 = Math.atan2(tr[1] - evm, tr[0]), a1 = Math.atan2(tl[1] - evm, tl[0]); while (a1 < a0) a1 += 2 * Math.PI;
        for (let j = 1; j < 24; j++) { const a = a0 + (a1 - a0) * j / 24; poly.push([Rm * Math.cos(a), evm + Rm * Math.sin(a)]); }
        poly.push(tl, [-Lm / 2, hvm]);
        poly.forEach((q, j) => Ln(pr(...q), pr(...poly[(j + 1) % poly.length]), 'GOLFARI', 0.45));
        const hole = []; for (let j = 0; j <= 24; j++) { const a = j / 24 * 2 * Math.PI; hole.push(pr(g.d0 / 2 * Math.cos(a), evm + g.d0 / 2 * Math.sin(a))); }
        hole.forEach((q, j) => { if (j) Ln(hole[j - 1], q, 'GOLFARI', 0.4); }); }
      const ca = sp([l.L[0], l.L[1], l.L[2]]); dashed([ca[0], ca[1] + (gt[1] - gb[1]) + 4], [ca[0], ca[1] - 14], 'ASSI');
      // quote: dai bordi della piattabanda all'asse del golfare; asse anima; altezza del golfare
      const eL = sp([l.L[0], l.gv - l.gw / 2, l.L[2]]), eR = sp([l.L[0], l.gv + l.gw / 2, l.L[2]]), yq = gt[1] + 6;
      const xs = [eL[0], ca[0], eR[0]].sort((a, b) => a - b);
      hd(xs[0], xs[1], yq, mm(Math.abs(l.L[1] - (xs[0] === eL[0] ? l.gv - l.gw / 2 : l.gv + l.gw / 2))), eL[1] + 1, ca[1] + 1);
      hd(xs[1], xs[2], yq, mm(Math.abs((xs[2] === eR[0] ? l.gv + l.gw / 2 : l.gv - l.gw / 2) - l.L[1])), ca[1] + 1, eR[1] + 1);
      hd(xs[0], xs[2], yq + 6, `piattabanda ${mm(l.gw)}`, null, null);
      const wa = sp([l.L[0], l.gv, l.L[2]]), off = l.L[1] - l.gv;
      vd(gb[1], gt[1], Math.max(gb[0], gt[0]) + 4, `H ${nf(g.ev + g.R, 0)}`);
      // ---- dettaglio in pianta del golfare, allineato alla sezione (stessa scala in orizzontale)
      { const ph = l.phi || 0, cph = Math.cos(ph), sph = Math.sin(ph);
        const Sd = pick(Math.max((l.gw + 0.1) / (r[2] - 26), (Lp * Math.abs(cph) + 0.12) / 26) * 1000), kd = 1000 / Sd, dx0 = r[0] + r[2] / 2 - 4, dy0 = r[1] + 24;
        const sgn = sp([l.L[0], l.L[1] + 1, l.L[2]])[0] > sp([l.L[0], l.L[1], l.L[2]])[0] ? 1 : -1, X = v => dx0 + sgn * (v - l.L[1]) * kd, Yd = du => dy0 + du * kd;
        T([r[0] + 2, r[1] + 42], `DETTAGLIO IN PIANTA G${l.n}   1:${Sd}`, 2.0);
        const span = Math.min(Lp * 0.6 + 0.04, 15 / kd), vL = l.gv - l.gw / 2, vR = l.gv + l.gw / 2;
        [vL, vR].forEach(v => Ln([X(v), Yd(-span)], [X(v), Yd(span)], 'CONTORNI', 0.4));
        dashed([X(l.gv), Yd(-span)], [X(l.gv), Yd(span)], 'ASSI');
        const cn = [[-Lp / 2, -tp / 2], [Lp / 2, -tp / 2], [Lp / 2, tp / 2], [-Lp / 2, tp / 2]].map(([a, b2]) => [X(l.L[1] + a * sph + b2 * cph), Yd(a * cph - b2 * sph)]);
        cn.forEach((q, j) => Ln(q, cn[(j + 1) % 4], 'GOLFARI', 0.5));
        const vE1 = l.L[1] - Lp / 2 * sph, vE2 = l.L[1] + Lp / 2 * sph, E1 = [X(vE1), Yd(-Lp / 2 * cph)], E2 = [X(vE2), Yd(Lp / 2 * cph)];
        Ln(E1, E2, 'ASSI', 0.15);
        // quote a catena dal bordo sinistro al bordo destro della piattabanda (in vista): estremità, centro, estremità
        const pts = [[X(vL), vL], [X(vE1), vE1], [X(vE2), vE2], [X(vR), vR]].sort((a, b) => a[0] - b[0]).filter((q, j, arr) => j === 0 || Math.abs(q[0] - arr[j - 1][0]) > 0.3);
        const yq2 = Yd(-span) - 5;
        for (let j = 1; j < pts.length; j++) hd(pts[j - 1][0], pts[j][0], yq2, mm(Math.abs(pts[j][1] - pts[j - 1][1])), null, null);
        [E1, E2].forEach(E => Ln(E, [E[0], yq2 + 1], 'QUOTE', 0.1));
        if (Math.abs(ph) > 0.01) { // angolo tra asse della trave (verticale nel dettaglio) e asse della piastra, quotato con un arco
          const C0 = [X(l.L[1]), Yd(0)], rr = Math.min(14, Lp / 2 * kd + 5), dirP = [E2[0] - C0[0], E2[1] - C0[1]], aP = Math.atan2(dirP[1], dirP[0]), aA = Math.PI / 2;
          Ln(C0, [C0[0], C0[1] + rr + 2], 'QUOTE', 0.15); Ln(C0, [C0[0] + Math.cos(aP) * (rr + 2), C0[1] + Math.sin(aP) * (rr + 2)], 'QUOTE', 0.15);
          let b0 = Math.min(aP, aA), b1 = Math.max(aP, aA); P.push({t: 'arc', c: C0, r: rr, a0: b0 * 180 / Math.PI, a1: b1 * 180 / Math.PI, layer: 'QUOTE', w: 0.25});
          const am = (b0 + b1) / 2, q = [C0[0] + Math.cos(am) * (rr + 2.5), C0[1] + Math.sin(am) * (rr + 2.5)];
          T(q, `${nf(Math.abs(ph) * 180 / Math.PI, 1)}°`, 2.4, 'QUOTE', Math.cos(am) >= 0 ? 'left' : 'right'); P[P.length - 1].bold = true; }
        else T([Math.max(X(vL), X(vR)) + 2, dy0], 'lungo l\'asse', 1.8, 'GOLFARI');
      }
    });
    // cartiglio
    const ty = 8, th = 28; rect(12, ty, 396, th, 'CORNICE', 0.35); Ln([250, ty], [250, ty + th], 'CORNICE', 0.25);
    T([14, ty + th - 5.5], `POSIZIONAMENTO GOLFARI – ${/^marca /.test(d.refLabel || '') ? 'MARCA ' + d.refLabel.replace(/^marca /, '') + ' (' + d.name + ')' : d.name}`, 3.0); P[P.length - 1].bold = true;
    T([14, ty + th - 11.5], `Riferimento: ${d.refLabel} · piastra ${nf(g.L, 0)} × ${nf(g.ev + g.R, 0)} × ${nf(g.t, 0)} mm${g.rot ? ', ruotata in pianta verso il punto di presa' : ', lungo l\'asse della trave'}`, 1.9);
    T([14, ty + th - 17], 'Quote in mm. Distanze longitudinali dal RIF. 0, lungo l\'asse del concio.', 1.8);
    cartRight(P, 252, ty, th, d.project, [], 'Peso e baricentro · Golfari · Trimble Connect');
    logos(P, ty);
    return {prims: P, scale: SP};
  }

  /**
   * Unisce i conci del gruppo (ognuno letto col suo riferimento) in un unico riferimento R0 e prepara travi, assi e intradosso.
   * parts: [{name, meshes (rel. ref), ref, cog (assoluto), W (t)}]. I conci tornano ordinati lungo l'asse.
   */
  function supportSetup(parts) {
    const R0 = parts[0].ref, meshes = [], owner = [];
    parts.forEach((p, k) => { const o = [0, 1, 2].map(i => p.ref[i] - R0[i]);
      p.meshes.forEach(m => { const q = new Float64Array(m.pos.length); for (let i = 0; i < q.length; i += 3) { q[i] = m.pos[i] + o[0]; q[i + 1] = m.pos[i + 1] + o[1]; q[i + 2] = m.pos[i + 2] + o[2]; } meshes.push({...m, pos: q}); owner.push(k); }); });
    // origine delle progressive sul baricentro del concio più pesante: mai su un giunto, dove la piattabanda è interrotta o coperta dai coprigiunti
    const big = parts.reduce((b, p) => p.W > b.W ? p : b, parts[0]), cogR = [0, 1, 2].map(i => big.cog[i] - R0[i]);
    const lm = liftModel(meshes, cogR, {});
    if (!lm.girders.length) throw new Error('nessuna trave riconosciuta nei conci del gruppo');
    const sm = supportModel(lm);
    const conci = parts.map((p, k) => { let u0 = Infinity, u1 = -Infinity;
      lm._dbg.els.forEach(e => { if (owner[e.i] !== k || e.small) return; u0 = Math.min(u0, e.u0); u1 = Math.max(u1, e.u1); });
      const cu = lm.toUV(p.cog[0] - R0[0], p.cog[1] - R0[1]);
      return {src: k, name: p.name, W: p.W, u0, u1, ucog: cu[0], vcog: cu[1], zcog: p.cog[2] - R0[2]}; }).sort((a, b) => (a.u0 + a.u1) - (b.u0 + b.u1));
    return {R0, meshes, owner, lm, sm, conci};
  }

  /**
   * Appoggi di UN macroconcio: i conci sono i tratti di trave fra un giunto e l'altro, ricavati dalle marche (assiemi) delle travi.
   * items: [{ms (rel. ref), pid (identificativo dell'assieme)}], ref, cog (ass.), W (t)
   */
  function supportSetupMacro(items, ref, cog, W) {
    const R0 = ref, meshes = items.map(i => i.ms), cogR = [0, 1, 2].map(i => cog[i] - R0[i]);
    const lm = liftModel(meshes, cogR, {});
    if (!lm.girders.length) throw new Error('nessuna trave riconosciuta nel macroconcio');
    const sm = supportModel(lm), els = lm._dbg.els;
    // ingombro di ogni assieme lungo l'asse e sulla trasversale
    const byP = new Map(); els.forEach(e => { if (e.small) return; const pid = items[e.i].pid; let b = byP.get(pid); if (!b) { b = {pid, u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity, idx: []}; byP.set(pid, b); }
      b.u0 = Math.min(b.u0, e.u0); b.u1 = Math.max(b.u1, e.u1); b.v0 = Math.min(b.v0, e.v0); b.v1 = Math.max(b.v1, e.v1); b.idx.push(e.i); });
    // tratti di trave: assiemi lunghi (> 2 m) che stanno su una trave riconosciuta
    const segs = []; byP.forEach(b => { if (b.u1 - b.u0 < 2) return; const um = (b.u0 + b.u1) / 2;
      lm.girders.forEach((g, gi) => { const gv = lm.girderAt(gi, um).v; if (gv > b.v0 - 0.1 && gv < b.v1 + 0.1 && b.v1 - b.v0 < 2.5) segs.push({...b, gi}); }); });
    // giunti: estremità interne dei tratti, raggruppate fra le travi (entro 0,8 m)
    const U0 = lm.umin, U1 = lm.umax, ends = [];
    segs.forEach(s => [s.u0, s.u1].forEach(u => { if (u > U0 + 1 && u < U1 - 1) ends.push(u); }));
    ends.sort((a, b) => a - b); const J = [];
    ends.forEach(u => { const l = J[J.length - 1]; if (l && u - l.max < 0.8) { l.max = u; l.us.push(u); } else J.push({max: u, us: [u]}); });
    const joints = J.map(j => j.us.reduce((a, b) => a + b, 0) / j.us.length);
    const cuts = [U0, ...joints, U1], conci = [];
    for (let k = 0; k < cuts.length - 1; k++) {
      const u0 = cuts[k], u1 = cuts[k + 1]; let V = 0; const C = [0, 0, 0];
      meshes.forEach((m, i) => { if (els[i].small) return; const vc = volCentroid(m); const uv = lm.toUV(vc.c[0], vc.c[1]); if (uv[0] < u0 || uv[0] >= u1) return; V += vc.V; for (let d = 0; d < 3; d++) C[d] += vc.V * vc.c[d]; });
      const c = V > 0 ? C.map(x => x / V) : [...lm.fromUV((u0 + u1) / 2, 0), cogR[2]], uv = lm.toUV(c[0], c[1]);
      const pids = [...new Set(segs.filter(s => (s.u0 + s.u1) / 2 > u0 && (s.u0 + s.u1) / 2 < u1).map(s => s.pid))];
      conci.push({k, name: 'Concio ' + (k + 1), u0, u1, ucog: uv[0], vcog: uv[1], zcog: c[2], V, pids});
    }
    const Vt = conci.reduce((a, c) => a + c.V, 0) || 1; conci.forEach(c => { c.W = W * c.V / Vt; });
    const cu = lm.toUV(cogR[0], cogR[1]);
    return {macro: true, R0, meshes, lm, sm, conci, W, ucog: cu[0], vcog: cu[1], joints};
  }
  /**
   * File di appoggi del macroconcio (rev: si parte dall'altra estremità):
   * concio 1: a dJ prima del giunto e una fila simmetrica rispetto al suo baricentro; conci intermedi: a dJ prima del giunto successivo;
   * ultimo concio: a dEnd dall'estremità. Ogni fila sull'asse di diaframma/irrigidimento più adatto.
   */
  function placeSupportsMacro(lm, sm, conci, cfg) {
    const gs = cfg.girders, dJ = cfg.dJ != null ? cfg.dJ : 1.5, dEnd = cfg.free > 0 ? cfg.free : (cfg.dJ != null ? cfg.dJ : 1.5), dStart = cfg.free > 0 ? cfg.free : dEnd, Ls = cfg.Ls || 0.4, Bs = cfg.Bs || 0.4, rev = !!cfg.rev, out = [];
    const S = rev ? -1 : 1, n = conci.length;
    const ord = rev ? [...conci].reverse() : conci;              // ordine di lavoro: dal concio 1
    const lo = c => rev ? c.u1 : c.u0, hi = c => rev ? c.u0 : c.u1;   // inizio/fine nel verso di lavoro
    const stAll = gi => lm.stations[gi].map(s => s.u);
    const nearest = (arr, u) => arr.reduce((b, x) => b == null || Math.abs(x - u) < Math.abs(b - u) ? x : b, null);
    const inC = (c, u) => u > Math.min(c.u0, c.u1) + 0.2 && u < Math.max(c.u0, c.u1) - 0.2;
    // fila alla distanza esatta; si porta sull'irrigidimento solo se ce n'è uno entro 0,30 m
    const snap = (t, c) => { let best = null; gs.forEach(gi => stAll(gi).forEach(u => { if (inC(c, u) && Math.abs(u - t) <= 0.3 && (best == null || Math.abs(u - t) < Math.abs(best - t))) best = u; })); return best == null ? t : best; };
    const rows = []; // {k (indice reale del concio), side, t, u}
    ord.forEach((c, j) => {
      const last = j === n - 1, first = j === 0;
      if (!last) { const t = hi(c) - S * dJ; rows.push({k: c.k, side: 0, t, u: snap(t, c), role: 'giunto'}); }
      else { const t = hi(c) - S * dEnd; rows.push({k: c.k, side: 0, t, u: snap(t, c), role: 'estremità finale'}); }
      if (first) { const t = lo(c) + S * dStart; rows.push({k: c.k, side: 1, t, u: snap(t, c), role: 'estremità iniziale'}); }
    });
    rows.sort((a, b) => S * (a.u - b.u));
    rows.forEach(r => { const key = r.k + ':' + r.side; if (cfg.custom && cfg.custom[key] != null) { r.u = cfg.custom[key]; r.moved = true; } });
    rows.forEach(r => gs.forEach(gi => {
      let u = r.u; const st = stAll(gi).filter(x => inC(conci[r.k], x)); if (!r.moved) { const nn = nearest(st, u); if (nn != null && Math.abs(nn - u) < 0.05) u = nn; }
      const p = sm.pointBelow(gi, u, Ls, Bs); p.near = st.length ? Math.min(...st.map(s => Math.abs(s - u))) : null;
      out.push({...p, k: r.k, side: r.side, target: r.t, moved: !!r.moved, role: r.role}); }));
    return out;
  }

  /** sagoma della trave gi fra u0 e u1: [u, quota estradosso, quota intradosso] */
  function girderProfile(lm, sm, gi, u0, u1) {
    const out = [], n = Math.max(2, Math.ceil((u1 - u0) / 0.25));
    for (let i = 0; i <= n; i++) { const u = u0 + 0.02 + (u1 - u0 - 0.04) * i / n, b = sm.bottomAt(gi, u); if (!b.missing && isFinite(b.top)) out.push([u, b.top, b.z]); }
    return out;
  }
  /**
   * Appoggi completi: posizione, reazioni per concio, quote relative, coordinate assolute.
   * cfg: {girders, dJ, free, Ls, Bs, custom, names: {gi: 'T1'}}
   */
  function computeSupports(st, cfg) {
    const {lm, sm, conci, R0} = st, pts = st.macro ? placeSupportsMacro(lm, sm, conci, cfg) : placeSupports(lm, sm, conci, cfg);
    const warn = [];
    if (st.macro) { // il macroconcio è un corpo rigido su tutti gli appoggi
      const r = supportReactions(pts, st.W, st.ucog, st.vcog); pts.forEach((p, i) => { p.R = r.R[i]; });
      conci.forEach(c => { c.misalign = 0; c.negative = false; }); st.misalign = r.misalign; st.negative = r.negative;
      if (r.negative) conci.forEach((c, k) => { if (pts.some(p => p.k === k && p.R < 0)) c.negative = true; });
    } else
    conci.forEach((c, k) => { const ps = pts.filter(p => p.k === k), ok = ps.filter(p => isFinite(p.z));
      const r = supportReactions(ps, c.W, c.ucog, c.vcog); ps.forEach((p, i) => { p.R = r.R[i]; });
      c.misalign = r.misalign; c.negative = r.negative; });
    const zmin = Math.min(...pts.filter(p => isFinite(p.z)).map(p => p.z));
    pts.forEach(p => { p.g = (cfg.names || {})[p.gi] || 'T' + (p.gi + 1); });
    if (st.macro) { const S = cfg.rev ? -1 : 1, ru = {}; pts.forEach(p => { const key = p.k + ':' + p.side; if (ru[key] == null) ru[key] = p.u; });
      pts.sort((a, b) => S * (ru[a.k + ':' + a.side] - ru[b.k + ':' + b.side]) || a.g.localeCompare(b.g, 'it', {numeric: true})); }
    else pts.sort((a, b) => a.k - b.k || a.side - b.side || a.g.localeCompare(b.g, 'it', {numeric: true}));
    pts.forEach((p, i) => { p.n = i + 1;
      p.dz = isFinite(p.z) ? (Math.abs(p.z - zmin) < 0.0005 ? '±0,000' : '+' + nf(p.z - zmin, 3)) : '–'; p.dzm = isFinite(p.z) ? p.z - zmin : NaN;
      p.X = p.x + R0[0]; p.Y = p.y + R0[1]; p.Z = p.z + R0[2];
      const nt = []; if (p.missing) nt.push('intradosso non trovato'); else if (p.support < 0.9) nt.push(`contatto ${Math.round(p.support * 100)}%`);
      if (p.bolts) nt.push('bulloni'); if (p.near != null && p.near > 0.1) nt.push('fuori asse irrig.'); if (p.R < 0) nt.push('reazione < 0');
      p.note = nt.join(', '); });
    return pts;
  }


  // ------------------------------------------------------------------ PRESA GENERICA: una o più gru, punti di presa scelti a mano
  function gaussSolve(A, b) { const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; if (Math.abs(M[p][c]) < 1e-12) return null; [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; } }
    return M.map((r, i) => r[n] / r[i]); }
  /**
   * pts: [{c (gru), x, y, z}] (m, assoluti), W (t), cog [x,y,z]; cfg {mode: 'L' | 'A', val (m o gradi sull'orizzontale), eq (funi tutte lunghe L)}.
   * Ganci: sulla verticale del centro dei punti di ogni gru (o, con eq, nel punto da cui tutte le funi sono lunghe L);
   * quota: con l'angolo nessuna fune scende sotto l'angolo dato, con la lunghezza nessuna fune supera L.
   * Tiri: equilibrio del corpo rigido (forze e momenti rispetto al baricentro) e risultante verticale su ogni gancio,
   * risolti ai minimi quadrati partendo dalla ripartizione rigida dei carichi verticali sui punti.
   */
  function genLift(pts, W, cog, cfg) {
    const warn = [], cr = [...new Set(pts.map(p => p.c))].sort((a, b) => a - b), val = +cfg.val;
    if (!pts.length) return {hooks: [], rows: [], warn: ['nessun punto di presa']};
    const hooks = cr.map(c => { const P = pts.filter(p => p.c === c), n = P.length, cx = P.reduce((a, p) => a + p.x, 0) / n, cy = P.reduce((a, p) => a + p.y, 0) / n;
      let H = [cx, cy, 0];
      if (cfg.mode === 'H') H[2] = P.reduce((a, p) => a + p.z, 0) / n + val; // gancio in asse ai punti, all'altezza data sopra la loro quota media
      else if (cfg.mode === 'A') { const t = Math.tan(Math.max(5, Math.min(89, val)) * Math.PI / 180); H[2] = Math.max(...P.map(p => p.z + Math.hypot(p.x - cx, p.y - cy) * t)); }
      else { const L = val, rmax = Math.max(...P.map(p => Math.hypot(p.x - cx, p.y - cy)));
        if (!(L > rmax + 0.05)) { warn.push(`Gru ${c + 1}: funi troppo corte, servono più di ${nf(rmax, 2)} m`); H[2] = Math.max(...P.map(p => p.z)) + 0.5; }
        else H[2] = Math.min(...P.map(p => p.z + Math.sqrt(L * L - (p.x - cx) ** 2 - (p.y - cy) ** 2)));
        if (cfg.eq && n >= 2 && L > rmax) { // punto da cui tutte le funi sono lunghe L (Gauss-Newton)
          for (let it = 0; it < 40; it++) { const J = [], r = []; P.forEach(p => { const d = [H[0] - p.x, H[1] - p.y, H[2] - p.z], l = Math.hypot(...d) || 1e-9; J.push(d.map(x => x / l)); r.push(l - L); });
            const JtJ = [0, 1, 2].map(i => [0, 1, 2].map(j => J.reduce((a, q) => a + q[i] * q[j], 0) + (i === j ? 1e-6 : 0))), Jtr = [0, 1, 2].map(i => J.reduce((a, q, k) => a + q[i] * r[k], 0));
            const dx = gaussSolve(JtJ, Jtr); if (!dx) break; H = H.map((v, i) => v - dx[i]); if (Math.hypot(...dx) < 1e-7) break; } } }
      return {c, x: H[0], y: H[1], z: H[2], n}; });
    const hk = c => hooks.find(h => h.c === c);
    const rows = pts.map((p, i) => { const h = hk(p.c), d = [h.x - p.x, h.y - p.y, h.z - p.z], L = Math.hypot(...d);
      return {i, c: p.c, x: p.x, y: p.y, z: p.z, L, u: d.map(x => x / L), alpha: Math.asin(Math.min(1, d[2] / L)) * 180 / Math.PI, r: Math.hypot(d[0], d[1])}; });
    // ripartizione di partenza: carichi verticali dei punti come appoggi di un corpo rigido
    const sr = supportReactions(rows.map(q => ({u: q.x, v: q.y})), W, cog[0], cog[1]);
    const T0 = rows.map((q, i) => Math.max(0, sr.R[i]) / Math.max(0.05, Math.sin(q.alpha * Math.PI / 180)));
    // equazioni: ΣF = (0,0,W), ΣM rispetto al baricentro = 0, risultante orizzontale nulla su ogni gancio
    const A = [], b = [], n = rows.length;
    for (let k = 0; k < 3; k++) { A.push(rows.map(q => q.u[k])); b.push(k === 2 ? W : 0); }
    for (let k = 0; k < 3; k++) { A.push(rows.map(q => { const r = [q.x - cog[0], q.y - cog[1], q.z - cog[2]], f = q.u, m = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]; return m[k]; })); b.push(0); }
    hooks.forEach(h => { for (let k = 0; k < 2; k++) { A.push(rows.map(q => q.c === h.c ? q.u[k] : 0)); b.push(0); } });
    const big = 1e6, N = [...Array(n)].map((_, i) => [...Array(n)].map((_, j) => big * A.reduce((a, r) => a + r[i] * r[j], 0) + (i === j ? 1 : 0)));
    const rhs = [...Array(n)].map((_, i) => big * A.reduce((a, r, k) => a + r[i] * b[k], 0) + T0[i]);
    const T = gaussSolve(N, rhs) || T0; rows.forEach((q, i) => { q.T = T[i]; q.V = T[i] * q.u[2]; });
    hooks.forEach(h => { const qs = rows.filter(q => q.c === h.c); h.V = qs.reduce((a, q) => a + q.V, 0); h.Hx = qs.reduce((a, q) => a + q.T * q.u[0], 0); h.Hy = qs.reduce((a, q) => a + q.T * q.u[1], 0); h.share = h.V / W; });
    const res = A.map((r, k) => r.reduce((a, x, i) => a + x * T[i], 0) - b[k]);
    const fRes = Math.hypot(res[0], res[1], res[2]), mRes = Math.hypot(res[3], res[4], res[5]);
    if (rows.some(q => q.T < -0.05)) warn.push('una fune risulta compressa: il baricentro è fuori dai punti di presa o i ganci sono mal posizionati');
    if (mRes > 0.02 * W) warn.push(`equilibrio non raggiunto (momento residuo ${nf(mRes, 1)} t·m): il carico ruoterebbe fino a portare il baricentro sotto la linea dei ganci`);
    if (hooks.length === 2) { const [a, c2] = hooks, ex = c2.x - a.x, ey = c2.y - a.y, el = Math.hypot(ex, ey) || 1; hooks.off = Math.abs((cog[0] - a.x) * ey - (cog[1] - a.y) * ex) / el;
      if (hooks.off > 0.1) warn.push(`il baricentro è a ${nf(hooks.off, 2)} m dalla linea fra i due ganci: in sollevamento il carico ruota`); }
    if (hooks.length === 1) { const h = hooks[0], off = Math.hypot(h.x - cog[0], h.y - cog[1]); if (off > 0.1) warn.push(`il gancio è a ${nf(off, 2)} m dalla verticale del baricentro: il carico si inclina`); }
    return {hooks, rows, warn, fRes, mRes};
  }

  // ------------------------------------------------------------------ TAVOLA DEGLI APPOGGI A TERRA
  /**
   * Prospetto della trave esterna con i conci e i loro baricentri, sezione A-A su una fila di appoggi,
   * pianta 1-1 (dall'alto) e 2-2 (intradosso), tabella con coordinate e reazioni.
   * d = {meshes (rel. ref), toUV (x,y rel. ref → u,v), conci:[{name, u0, u1, ucog, zcog, zb, W}],
   *      sups:[{n, k, gi, g, u, v, z, R, dz, X, Y, Z}], girders:[{gi, name, v}], pros:{gi, name}, prof:[[[u, ztop, zbot]...] per concio],
   *      Ls, Bs, Hs, sec:{u, label}, name, project}
   */
  function buildSupportSheet(d) {
    const local = d.meshes.filter(m => !isMinute(m)).map(m => { const q = new Float64Array(m.pos.length); for (let i = 0; i < q.length; i += 3) { const s = d.toUV(m.pos[i], m.pos[i + 1]); q[i] = s[0]; q[i + 1] = s[1]; q[i + 2] = m.pos[i + 2]; } return {pos: q, idx: m.idx}; });
    let U0 = Infinity, U1 = -Infinity, V0 = Infinity, V1 = -Infinity, Z1 = -Infinity;
    local.forEach(m => { for (let i = 0; i < m.pos.length; i += 3) { const u = m.pos[i], v = m.pos[i + 1], z = m.pos[i + 2]; if (u < U0) U0 = u; if (u > U1) U1 = u; if (v < V0) V0 = v; if (v > V1) V1 = v; if (z > Z1) Z1 = z; } });
    const sups = d.sups.filter(s => isFinite(s.z)), Ls = d.Ls, Bs = d.Bs;
    const zLow = Math.min(...sups.map(s => s.z)), zG = zLow - d.Hs;
    const P = [];
    const Ln = (a, b, layer, w) => P.push({t: 'line', a, b, layer: layer || 'CONTORNI', w: w || 0.25});
    const T = (p, txt, size, layer, align) => P.push({t: 'text', p, txt: String(txt), s: (size || 2.5) * 1.3, layer: layer || 'TESTI', align: align || 'left'});
    const LB = (p, txt, size) => { P.push({t: 'tbox', p, txt: String(txt), s: size * 1.3, layer: 'APPOGGI', align: 'center'}); P.push({t: 'text', p, txt: String(txt), s: size * 1.3, layer: 'APPOGGI', align: 'center', bold: true}); }; // nome appoggio su fondo bianco in rettangolo
    const QB = (p, txt, size) => { P.push({t: 'tbox', p, txt: String(txt), s: size * 1.3, layer: 'QUOTE', align: 'left', top: true}); P.push({t: 'text', p, txt: String(txt), s: size * 1.3, layer: 'QUOTE', align: 'left', bold: true, top: true}); }; // quota relativa accanto al nome
    const TB = (p, txt, size, layer, align) => { P.push({t: 'tbox', p, txt: String(txt), s: size * 1.3, layer: layer || 'SEZIONI', align: align || 'left'}); T(p, txt, size, layer || 'SEZIONI', align); P[P.length - 1].bold = true; };
    const rect = (x, y, w, h, layer, wt) => { Ln([x, y], [x + w, y], layer, wt); Ln([x + w, y], [x + w, y + h], layer, wt); Ln([x + w, y + h], [x, y + h], layer, wt); Ln([x, y + h], [x, y], layer, wt); };
    const poly = (pts, fill, layer) => P.push({t: 'poly', pts, fill, layer: layer || 'APPOGGI'});
    const box = (xa, ya, xb, yb, fill, layer, wt) => { const q = [[xa, ya], [xb, ya], [xb, yb], [xa, yb]]; if (fill) poly(q, fill, layer); q.forEach((p, i) => Ln(p, q[(i + 1) % 4], layer || 'APPOGGI', wt || 0.35)); };
    const dashed = (a, b, layer, w) => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.floor(L / 4)); for (let i = 0; i < n; i++) { const t0 = i / n, t1 = (i + 0.6) / n; Ln([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1], layer || 'ASSI', w || 0.13); } };
    const tick = p => Ln([p[0] - 0.8, p[1] - 0.8], [p[0] + 0.8, p[1] + 0.8], 'QUOTE', 0.3);
    const hd = (xa, xb, y, txt) => { Ln([xa - 1.2, y], [xb + 1.2, y], 'QUOTE', 0.18); tick([xa, y]); tick([xb, y]); if (txt) T([(xa + xb) / 2, y + 1.1], txt, xb - xa > 9 ? 2.1 : 1.7, 'QUOTE', 'center'); };
    const chain = (xs, y, ext) => { xs = [...xs].sort((a, b) => a.x - b.x).filter((q, i, a) => i === 0 || q.x - a[i - 1].x > 0.05); for (let i = 1; i < xs.length; i++) hd(xs[i - 1].x, xs[i].x, y, mm(xs[i].u - xs[i - 1].u)); if (ext != null) xs.forEach(q => Ln([q.x, ext], [q.x, y + (ext > y ? 1 : -1)], 'QUOTE', 0.1)); };
    const vd = (ya, yb, x, txt, left) => { Ln([x, ya - 1.2], [x, yb + 1.2], 'QUOTE', 0.18); tick([x, ya]); tick([x, yb]); T([x + (left ? -1 : 1), (ya + yb) / 2], txt, 2.1, 'QUOTE', left ? 'right' : 'left'); };
    const mm = v => String(Math.round(Math.abs(v) * 1000));
    const pick = x => [...SCALES, 300, 400].sort((a, b) => a - b).find(s => s >= x) || 5000;
    const title = (x, y, txt, S) => { TB([x, y], txt, 3.0, 'TESTI', 'center'); if (S) T([x, y - 5.2], `SCALA 1:${S}`, 1.9, 'ASSI', 'center'); };
    const FILL = [[160, 222, 245], [246, 196, 232], [160, 236, 196], [250, 224, 160], [205, 196, 246], [246, 206, 176]], GREY = [195, 195, 195];
    rect(5, 5, 410, 287, 'CORNICE', 0.5);

    // ---- impaginazione come le tavole dei golfari: riquadri con titolo in alto a sinistra, tabella in basso, sezione e riepilogo a destra
    const nS = d.sups.length, rowH = nS > 24 ? 2.8 : nS > 15 ? 3.2 : 4.0, tabH = 12 + (nS + 1) * rowH;
    const yB1 = 50 + tabH + 2, Hv = 287 - yB1;           // altezza disponibile per le viste
    const zr = Z1 - zG, vr = V1 - V0, WL = 276;           // colonna sinistra: viste longitudinali
    const kL = (WL - 48) / (U1 - U0), kH = (Hv - 86) / (zr + vr), SP = pick(1000 / Math.min(kL, kH)), k = 1000 / SP;
    const spare = Math.max(0, Hv - 86 - (zr + vr) * k) / 2;
    const hF = zr * k + 44 + spare, hP2 = Hv - hF;
    const RF = [12, 287 - hF, WL, hF], RP2 = [12, yB1, WL, hP2];
    const RS = [12 + WL + 2, yB1 + Hv * 0.42, 408 - (14 + WL), Hv * 0.58], RR = [RS[0], yB1, RS[2], Hv * 0.42 - 0], RT = [12, 50, 396, tabH];
    [RF, RP2, RS, RR, RT].forEach(r => rect(...r, 'CORNICE', 0.18));
    const ptitle = (r, txt, S) => { T([r[0] + 2, r[1] + r[3] - 4], txt + (S ? '   1:' + S : ''), 2.8); };
    const xo = 12 + 30 + (WL - 40 - (U1 - U0) * k) / 2, X = u => xo + (u - U0) * k;
    const xL = X(U0), xR = X(U1);

    // ---- PROSPETTO della trave esterna (vista dal lato della trave, progressive crescenti verso destra)
    let yc = RF[1] + RF[3] - spare / 2;
    ptitle(RF, `PROSPETTO ${d.pros.name}`, SP);
    const yLab = yc - 10, yTopCh = yc - 17, yGeoTop = yc - 23, Y = z => yGeoTop - (Z1 - z) * k;
    const FRONT = {f: [0, 1, 0], up: [0, 0, 1]};
    const HE = hiddenLine(local, local.map(m => featureEdges(m, 25)), FRONT, 2200);
    // sagome colorate dei conci (sotto le linee)
    d.prof.forEach((pr, kk) => { if (pr.length < 2) return; const pts = pr.map(q => [X(q[0]), Y(q[1])]).concat([...pr].reverse().map(q => [X(q[0]), Y(q[2])])); poly(pts, FILL[kk % FILL.length], 'CONCI'); });
    // appoggi della trave del prospetto (sotto le linee)
    const sp = sups.filter(s => s.gi === d.pros.gi);
    sp.forEach(s => box(X(s.u - Ls / 2), Y(s.z), X(s.u + Ls / 2), Y(zG), GREY));
    dropShort(HE.segs, 0.15, 0.01).forEach(sg => Ln([X(sg[0]), Y(sg[1])], [X(sg[2]), Y(sg[3])], 'CONTORNI', 0.22));
    Ln([xL - 8, Y(zG)], [xR + 8, Y(zG)], 'CONTORNI', 0.4); T([xL - 9, Y(zG) + 1], 'piano di appoggio', 1.8, 'ASSI', 'right');
    // conci: nome e peso, giunti, baricentri
    const joints = []; for (let i = 1; i < d.conci.length; i++) joints.push((d.conci[i - 1].u1 + d.conci[i].u0) / 2);
    d.conci.forEach((c, kk) => {
      const xm = X((c.u0 + c.u1) / 2), hw = Math.min(16, (X(c.u1) - X(c.u0)) / 2 - 0.5); P.push({t: 'poly', pts: [[xm - hw, yLab - 2.2], [xm + hw, yLab - 2.2], [xm + hw, yLab + 2.8], [xm - hw, yLab + 2.8]], fill: FILL[kk % FILL.length], layer: 'CONCI'});
      T([xm, yLab], hw > 13 ? `${c.name} · ${nf(c.W, 1)} t` : c.name.replace('Concio ', 'C'), 2.1, 'TESTI', 'center'); P[P.length - 1].bold = true;
      const xc = X(c.ucog), ycg = Y(c.zcog);
      P.push({t: 'circle', c: [xc, ycg], r: 1.1, layer: 'BARICENTRO', w: 0.3}); P.push({t: 'sector', c: [xc, ycg], r: 1.1, a0: 0, a1: 90, layer: 'BARICENTRO'}); P.push({t: 'sector', c: [xc, ycg], r: 1.1, a0: 180, a1: 270, layer: 'BARICENTRO'});
      T([xc + 1.8, ycg + 1.2], 'CdG', 1.9, 'BARICENTRO');
      
      dashed([xc, yTopCh + 1], [xc, Y(zG) + 1], 'ASSI', 0.12);
    });
    joints.forEach(u => dashed([X(u), yTopCh + 1], [X(u), Y(zG) - 2], 'ASSI', 0.2));
    // quote: in alto estremità, baricentri e giunti; in basso estremità e appoggi
    chain([U0, U1, ...joints, ...d.conci.map(c => c.ucog)].map(u => ({u, x: X(u)})), yTopCh, null);
    const yBotCh = Y(zG) - 10.5;
    sp.forEach(s => { const x = X(s.u), y = Y(s.z); poly([[x, y], [x - 1.3, y + 2], [x + 1.3, y + 2]], [0, 0, 0], 'APPOGGI'); T([x + 1.8, y - 2.8], s.dz, 2.0, 'QUOTE'); LB([x, Y(zG) - 4.6], 'A' + s.n, 2.6); });
    chain([U0, U1, ...sp.map(s => s.u)].map(u => ({u, x: X(u)})), yBotCh, Y(zG));
    // segni delle sezioni
    const xs = X(d.sec.u); [[yTopCh + 3, 'A'], [yBotCh - 4, 'A']].forEach(([y, t]) => { Ln([xs, y - 1.5], [xs, y + 1.5], 'SEZIONI', 0.6); T([xs - 1.2, y], t, 2.4, 'SEZIONI', 'right'); P[P.length - 1].bold = true; });

    // ---- PIANTE 1-1 (dall'alto) e 2-2 (intradosso, vista dal basso ribaltata): stessa scala e stesse progressive del prospetto
    const plan = (R, view, flip, label, withChain) => {
      ptitle(R, label, SP);
      const yG = R[1] + R[3] - 20 - spare / 2, Yp = v => yG - (V1 - v) * k;
      sups.forEach(s => box(X(s.u - Ls / 2), Yp(s.v - Bs / 2), X(s.u + Ls / 2), Yp(s.v + Bs / 2), GREY, 'APPOGGI', 0.25));
      const h0 = hiddenLine(local, local.map(m => contourEdges(edgeNormals(m), norm(view.f))), view, 2200);
      dropShort(h0.segs, 0.25, 0.01).forEach(sg => Ln([X(sg[0]), Yp(flip ? -sg[1] : sg[1])], [X(sg[2]), Yp(flip ? -sg[3] : sg[3])], 'CONTORNI', 0.22));
      // travi: cerchio col nome, asse, interasse
      const gv = [...d.girders].sort((a, b) => a.v - b.v);
      gv.forEach(g => { const y = Yp(g.v); P.push({t: 'circle', c: [xL - 19, y], r: 2.8, layer: 'SEZIONI', w: 0.3}); T([xL - 19, y], g.name, 2.1, 'SEZIONI', 'center'); P[P.length - 1].bold = true; dashed([xL - 16, y], [xR + 4, y], 'ASSI', 0.12); });
      for (let i = 1; i < gv.length; i++) vd(Yp(gv[i - 1].v), Yp(gv[i].v), xL - 8, mm(gv[i].v - gv[i - 1].v), true);
      if (withChain) sups.filter(s => s.gi === gv[0].gi).length && chain([U0, U1, ...sups.filter(s => s.gi === gv[0].gi).map(s => s.u)].map(u => ({u, x: X(u)})), Yp(V0) - 7, null);
      if (!flip) { const gTop = gv[gv.length - 1].gi, yOut = Yp(V1) + 5; // trave in alto: nome sopra l'ingombro della struttura, con richiamo
        sups.forEach(s => { const q = s.gi === gTop ? [X(s.u), yOut] : [X(s.u), Yp(s.v + Bs / 2) + 2.6]; if (s.gi === gTop) Ln([X(s.u), Yp(s.v + Bs / 2)], [X(s.u), yOut - 1.2], 'APPOGGI', 0.15); LB(q, 'A' + s.n, 2.8); QB([q[0] + 2.6 + String(s.n).length * 1.9, q[1]], s.dz, 2.4); }); }
      else sups.forEach(s => { if (s.gi !== gv[gv.length - 1].gi || gv.length === 1) { T([X(s.u), Yp(s.v - Bs / 2) - 2.2], 'A' + s.n, 2.0, 'APPOGGI', 'center'); P[P.length - 1].bold = true; } });
      return Yp(V0) - (withChain ? 10 : 4);
    };
    plan(RP2, {f: [0, 0, -1], up: [0, 1, 0]}, false, 'PIANTA dall\'alto, appoggi sotto la piattabanda inferiore', true);

    // ---- SEZIONE A-A sulla fila di appoggi scelta
    { const R = RS;
      const at = d.sec.u - 0.12, view = {f: [1, 0, 0], up: [0, 0, 1]};
      const cuts = []; local.forEach(m => cutLines(m, 0, at).forEach(c => cuts.push(c)));
      const pl = [[0, 1, at + 1e-4], [0, -1, at + 0.6]], beyond = local.map(m => clipMesh(m, pl)).filter(m => m.idx.length);
      const onClip = q => pl.some(([a, , v]) => Math.abs(q[a] - v) < 1e-5);
      const edges = beyond.map(m => contourEdges(edgeNormals(m), norm(view.f)).filter(e => !(onClip([e[0], e[1], e[2]]) && onClip([e[3], e[4], e[5]]))));
      const cm = {pos: new Float64Array(cuts.flat(2)), idx: new Uint32Array(0)};
      const hs = hiddenLine(beyond.concat([cm]), edges, view, 1400), segs = dropShort(hs.segs, 0.05, 0.004);
      const line = sups.filter(s => Math.abs(s.u - d.sec.u) < 0.35);
      const u0 = Math.min(hs.umin, ...line.map(s => -s.v - Bs)), u1 = Math.max(hs.umax, ...line.map(s => -s.v + Bs)), v0 = zG, v1 = hs.vmax;
      const S2 = pick(Math.max((u1 - u0) / (R[2] - 20), (v1 - v0) / (R[3] - 26)) * 1000), k2 = 1000 / S2;
      const cx = R[0] + R[2] / 2, cy = R[1] + 12 + (R[3] - 24) / 2, mp = (U, V) => [cx + (U - (u0 + u1) / 2) * k2, cy + (V - (v0 + v1) / 2) * k2];
      ptitle(R, 'SEZIONE A-A', S2);
      line.forEach(s => { const a = mp(-s.v - Bs / 2, s.z), b = mp(-s.v + Bs / 2, zG); box(a[0], a[1], b[0], b[1], GREY); });
      segs.forEach(sg => Ln(mp(sg[0], sg[1]), mp(sg[2], sg[3]), 'CONTORNI', 0.22));
      cuts.forEach(c => { const a = hs.prj(...c[0]), b = hs.prj(...c[1]); Ln(mp(a[0], a[1]), mp(b[0], b[1]), 'TAGLIO', 0.5); });
      const g0 = mp(u0, zG), g1 = mp(u1, zG); Ln([g0[0] - 3, g0[1]], [g1[0] + 3, g1[1]], 'CONTORNI', 0.4);
      line.forEach(s => { const q = mp(-s.v, s.z); poly([q, [q[0] - 1.2, q[1] + 1.8], [q[0] + 1.2, q[1] + 1.8]], [0, 0, 0], 'APPOGGI'); T([q[0] + 1.5, q[1] + 2], s.dz, 2.0, 'QUOTE'); LB([q[0], g0[1] - 4.4], 'A' + s.n, 2.6); });
      const ys = g0[1] - 9, xsA = line.map(s => ({u: -s.v, x: mp(-s.v, 0)[0]}));
      if (xsA.length > 1) chain(xsA, ys, null);
      T([R[0] + 2, R[1] + R[3] - 9], 'fila: ' + d.sec.label, 2.0, 'ASSI'); }

    // ---- tabella degli appoggi
    { const x0 = RT[0] + 2, top = RT[1] + RT[3], cols = [['App.', 16], ['Concio', 30], ['Trave', 16], ['Prog. mm', 26], ['Reaz. t', 22], ['Quota rel. m', 28], ['X m', 46], ['Y m', 46], ['Z m', 34], ['Note', 128]];
      const W = cols.reduce((a, c) => a + c[1], 0);
      T([x0, top - 4.5], 'APPOGGI', 2.8); T([x0 + 22, top - 4.5], '– coordinate nel sistema del modello, quote all\'intradosso della piattabanda inferiore', 2.1);
      const y0 = top - 8.5, ts = rowH > 4 ? 2.3 : rowH > 3.5 ? 2.0 : 1.75;
      let x = x0; cols.forEach((c, j) => { const r = j >= 3 && j <= 8; T([r ? x + c[1] - 3 : x + (j === 9 ? 3 : 1.2), y0 - rowH / 2 - 0.3], c[0], ts, 'TESTI', r ? 'right' : 'left'); P[P.length - 1].bold = true; x += c[1]; });
      Ln([x0, y0 - rowH - 0.4], [x0 + W, y0 - rowH - 0.4], 'CORNICE', 0.2);
      const f3 = v => nf(v, 3);
      d.sups.forEach((s, i) => { const y = y0 - rowH * (i + 1.5) - 0.6, cells = ['A' + s.n, d.conci[s.k].name, s.g, mm(s.u - U0), isFinite(s.R) ? nf(s.R, 1) : '–', s.dz, isFinite(s.X) ? f3(s.X) : '–', isFinite(s.Y) ? f3(s.Y) : '–', isFinite(s.Z) ? f3(s.Z) : '–', s.note || ''];
        let xx = x0; cells.forEach((t, j) => { const c = cols[j], r = j >= 3 && j <= 8; T([r ? xx + c[1] - 3 : xx + (j === 9 ? 3 : 1.2), y], t, ts, s.note && j === 9 ? 'BARICENTRO' : 'TESTI', r ? 'right' : 'left'); if (j === 0 || j === 4) P[P.length - 1].bold = true; xx += c[1]; });
        if (i < d.sups.length - 1 && d.sups[i + 1].k !== s.k) Ln([x0, y - rowH / 2], [x0 + W, y - rowH / 2], 'CORNICE', 0.1); }); }

    // ---- riepilogo
    { const r = RR, x0 = r[0] + 2; let y = r[1] + r[3] - 4.5;
      T([x0, y], 'CONCI E APPOGGI', 2.8); y -= 7;
      d.conci.forEach((c, kk) => { P.push({t: 'poly', pts: [[x0, y - 1.2], [x0 + 4, y - 1.2], [x0 + 4, y + 2.2], [x0, y + 2.2]], fill: FILL[kk % FILL.length], layer: 'CONCI'});
        T([x0 + 6, y], c.name, 2.4); T([x0 + 40, y], `L ${nf(c.u1 - c.u0, 2)} m`, 2.4); T([x0 + 70, y], `ca. ${nf(c.W, 1)} t`, 2.4); y -= 5.2; });
      y -= 1.5; const Rs = sups.filter(s => isFinite(s.R)).map(s => s.R), zs = sups.map(s => s.z);
      const Wt = d.W || d.conci.reduce((a, c) => a + c.W, 0);
      T([x0, y], `Peso ${nf(Wt, 2)} t · ${sups.length} appoggi`, 2.6); P[P.length - 1].bold = true; y -= 5.5;
      T([x0, y], `Reazione max ${nf(Math.max(...Rs), 1)} t · min ${nf(Math.min(...Rs), 1)} t`, 2.4); y -= 5;
      T([x0, y], `Dislivello max fra le selle ${nf(Math.max(...zs) - Math.min(...zs), 3)} m`, 2.4); y -= 5;
      T([x0, y], `Selle ${mm(Ls)} × ${mm(Bs)} mm · travi ${d.girders.map(g => g.name).sort().join(', ')}`, 2.4); }

    // ---- cartiglio
    const ty = 8, th = 38; rect(12, ty, 396, th, 'CORNICE', 0.35); Ln([250, ty], [250, ty + th], 'CORNICE', 0.25);
    T([14, ty + th - 6], `APPOGGI PROVVISORI A TERRA – ${d.name}`, 3.4); P[P.length - 1].bold = true;
    T([14, ty + th - 13], `Peso ${nf(d.W || d.conci.reduce((a, c) => a + c.W, 0), 2)} t · ${sups.length} appoggi su ${d.girders.length} travi · scala 1:${SP} su A3`, 2.5);
    const notes = ['Quote all\'intradosso della piattabanda inferiore, in asse all\'anima: la più bassa è ±0,000, le altre a salire (m).',
      `Prospetto della trave ${d.pros.name}; lo schema vale anche per le altre travi.`,
      d.macro ? 'Reazioni con il macroconcio rigido su appoggi di uguale rigidezza. Valori indicativi da verificare.' : 'Reazioni con concio rigido su appoggi di uguale rigidezza. Valori indicativi da verificare.'];
    notes.forEach((t, i) => T([14, ty + th - 19.5 - i * 5], t, 2.1));
    cartRight(P, 252, ty, th, d.project, [`Macroconcio: ${d.name}`], 'Peso e baricentro · Appoggi a terra · Trimble Connect');
    logos(P, ty);
    // le campiture vanno sotto le linee
    const fills = P.filter(p => p.t === 'poly' && p.layer === 'CONCI'), grey = P.filter(p => p.t === 'poly' && p.layer === 'APPOGGI' && p.fill !== undefined && p.fill[0] > 100), rest = P.filter(p => !fills.includes(p) && !grey.includes(p));
    const labs = rest.filter((p, i) => p.top || (p.layer === 'APPOGGI' && (p.t === 'tbox' || (p.t === 'text' && p.bold && rest[i - 1] && rest[i - 1].t === 'tbox')))), rest2 = rest.filter(p => !labs.includes(p));
    return {prims: [...fills, ...grey, ...rest2, ...labs], scale: SP}; // i nomi degli appoggi sopra a tutto
  }

  // ------------------------------------------------------------------ TAVOLA "SAGOMA": pianta + 4 sezioni sotto i golfari
  /** Ritaglia un pezzo con piani assiali: planes = [[asse, segno, valore]] tiene i punti con segno*(p[asse]-valore) >= 0. */
  function clipMesh(m, planes) {
    const P = [], I = [];
    for (let t = 0; t < m.idx.length; t += 3) {
      let poly = [0, 1, 2].map(j => { const i = m.idx[t + j] * 3; return [m.pos[i], m.pos[i + 1], m.pos[i + 2]]; });
      for (const [a, sg, v] of planes) {
        const out = []; for (let i = 0; i < poly.length; i++) {
          const A = poly[i], B = poly[(i + 1) % poly.length], da = sg * (A[a] - v), db = sg * (B[a] - v);
          if (da >= 0) out.push(A);
          if ((da >= 0) !== (db >= 0)) { const k = da / (da - db); out.push([A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k]); }
        }
        poly = out; if (poly.length < 3) break;
      }
      if (poly.length < 3) continue;
      const b = P.length / 3; poly.forEach(q => P.push(q[0], q[1], q[2]));
      for (let i = 1; i < poly.length - 1; i++) I.push(b, b + i, b + i + 1);
    }
    return {pos: new Float64Array(P), idx: new Uint32Array(I)};
  }
  /** Linee di taglio: intersezione dei triangoli con il piano p[asse] = valore. */
  function cutLines(m, a, v) {
    const out = [];
    for (let t = 0; t < m.idx.length; t += 3) {
      const V = [0, 1, 2].map(j => { const i = m.idx[t + j] * 3; return [m.pos[i], m.pos[i + 1], m.pos[i + 2]]; }), pts = [];
      for (let i = 0; i < 3; i++) { const A = V[i], B = V[(i + 1) % 3], da = A[a] - v, db = B[a] - v;
        if ((da > 0) !== (db > 0)) { const k = da / (da - db); pts.push([A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k]); } }
      if (pts.length === 2) out.push(pts);
    }
    return out;
  }
  function buildOutlineSheet(d) {
    const ax = d.ax, pv = [-ax[1], ax[0]], c0 = d.cog;
    const toL = (x, y, z) => { const dx = x - c0[0], dy = y - c0[1]; return [dx * ax[0] + dy * ax[1], dx * pv[0] + dy * pv[1], z - c0[2]]; };
    const local = d.meshes.filter(m => !isMinute(m)).map(m => { const q = new Float64Array(m.pos.length); for (let i = 0; i < q.length; i += 3) { const s = toL(m.pos[i] + d.ref[0], m.pos[i + 1] + d.ref[1], m.pos[i + 2] + d.ref[2]); q[i] = s[0]; q[i + 1] = s[1]; q[i + 2] = s[2]; } return {pos: q, idx: m.idx}; });
    const lugs = d.lugs.map((l, i) => ({...l, n: i + 1, L: toL(l.x, l.y, l.z)})), hook = toL(d.hook[0], d.hook[1], d.hook[2]);
    const z0 = zeroLevel(local), zr = z => z - z0; // quote relative al ±0,00
    const groupBy = (vals, tol) => { const o = []; [...vals].sort((a, b) => a.v - b.v).forEach(x => { const l = o[o.length - 1]; if (l && x.v - l[l.length - 1].v < tol) l.push(x); else o.push([x]); }); return o; };
    // pianta (come prima)
    const PLAN = {f: [0, 0, -1], up: [0, 1, 0]};
    const hp0 = hiddenLine(local, local.map(m => contourEdges(edgeNormals(m), norm(PLAN.f))), PLAN, 1600);
    const HP = {...hp0, segs: dropShort(hp0.segs, 0.4, 0.01)};
    // sezioni: trasversali sulle progressive dei golfari (guardando +u), longitudinali lungo le travi dei golfari (guardando +v)
    const uG = groupBy(lugs.map(l => ({v: l.L[0], l})), 2.5), vG = groupBy(lugs.map(l => ({v: l.L[1], l})), 2.0);
    const uLo = Math.min(...lugs.map(l => l.L[0])) - 2.5, uHi = Math.max(...lugs.map(l => l.L[0])) + 2.5;
    const secs = [];
    uG.forEach(g => { const us = g.map(x => x.v), c = Math.min(...us) - 0.15;
      secs.push({kind: 'T', axis: 0, at: c, far: Math.max(...us) + 0.6, lat: [], view: {f: [1, 0, 0], up: [0, 0, 1]}, lugs: g.map(x => x.l)}); });
    vG.slice().reverse().forEach(g => { const vs = g.map(x => x.v), c = Math.min(...vs) - 0.8;
      secs.push({kind: 'L', axis: 1, at: c, far: c + 2.2, lat: [[0, 1, uLo], [0, -1, uHi]], view: {f: [0, 1, 0], up: [0, 0, 1]}, lugs: g.map(x => x.l)}); });
    secs.forEach((sc, i) => {
      sc.n = i + 1;
      const latM = sc.lat.length ? local.map(m => clipMesh(m, sc.lat)) : local;
      const cuts = []; latM.forEach(m => cutLines(m, sc.axis, sc.at).forEach(c => cuts.push(c)));
      const pl = [...sc.lat, [sc.axis, 1, sc.at + 1e-4], [sc.axis, -1, sc.far]];
      const beyond = local.map(m => clipMesh(m, pl)).filter(m => m.idx.length);
      const onClip = q => pl.some(([a, , v]) => Math.abs(q[a] - v) < 1e-5);
      const edges = beyond.map(m => contourEdges(edgeNormals(m), norm(sc.view.f)).filter(e => !(onClip([e[0], e[1], e[2]]) && onClip([e[3], e[4], e[5]]))));
      // anche le linee di taglio entrano nella mesh di riferimento per le estensioni
      const ref = beyond.length ? beyond : [{pos: new Float64Array(cuts.flat(2)), idx: new Uint32Array(0)}];
      const h = hiddenLine(ref.concat([{pos: new Float64Array(cuts.flat(2)), idx: new Uint32Array(0)}]), edges, sc.view, 1400);
      sc.h = {...h, segs: dropShort(h.segs, 0.08, 0.005)};
      sc.cut = cuts.map(c => { const a = h.prj(...c[0]), b = h.prj(...c[1]); return [a[0], a[1], b[0], b[1]]; });
    });
    // estensioni (con golfari) e scale
    const extOf = (h, pts) => { let u0 = h.umin, u1 = h.umax, v0 = h.vmin, v1 = h.vmax; pts.forEach(p => { const q = h.prj(p[0], p[1], p[2]); u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); v0 = Math.min(v0, q[1]); v1 = Math.max(v1, q[1] + 1.2); }); return {u0, u1, v0, v1}; };
    const top = 287, bot = 50;
    const R = {plan: [12, 197, 270, 90], tab: [284, 197, 124, 90]};
    const nT = secs.filter(x => x.kind === 'T').length, nL = secs.length - nT;
    let iT = 0, iL = 0;
    secs.forEach(sc => { if (sc.kind === 'T') { const w = 396 / Math.max(1, nT); sc.r = [12 + w * iT++, 124, w - 2, 71]; } else { const w = 396 / Math.max(1, nL); sc.r = [12 + w * iL++, bot, w - 2, 72]; } });
    const EP = extOf(HP, [hook, ...lugs.map(l => l.L)]); EP.v1 -= 1.2;
    const need = (e, r) => Math.max((e.u1 - e.u0) / (r[2] - 24), (e.v1 - e.v0) / (r[3] - 22)) * 1000;
    const pick = x => SCALES.find(s => s >= x) || 5000;
    const SP = pick(Math.max((EP.u1 - EP.u0) / (R.plan[2] - 50), (EP.v1 - EP.v0) / (R.plan[3] - 46)) * 1000);
    secs.forEach(sc => { sc.e = extOf(sc.h, sc.lugs.map(l => l.L)); });
    const ST = pick(Math.max(0, ...secs.filter(x => x.kind === 'T').map(sc => need(sc.e, sc.r))));
    const SL = pick(Math.max(0, ...secs.filter(x => x.kind === 'L').map(sc => need(sc.e, sc.r))));
    const P = [];
    const Ln = (a, b, layer, w) => P.push({t: 'line', a, b, layer: layer || 'CONTORNI', w: Math.max(0.18, (w || 0.25) * 1.5)});
    const T = (p, txt, size, layer, align) => P.push({t: 'text', p, txt: String(txt), s: (size || 2.5) * 1.5, layer: layer || 'TESTI', align: align || 'left'});
    const C = (c, r, layer, w) => P.push({t: 'circle', c, r, layer: layer || 'BARICENTRO', w: w || 0.35});
    const SEC = (c, r, a0, a1, layer) => P.push({t: 'sector', c, r, a0, a1, layer: layer || 'BARICENTRO'});
    const rect = (x, y, w, h, layer, wt) => { Ln([x, y], [x + w, y], layer, wt); Ln([x + w, y], [x + w, y + h], layer, wt); Ln([x + w, y + h], [x, y + h], layer, wt); Ln([x, y + h], [x, y], layer, wt); };
    const cogSym = (c, r) => { C(c, r); SEC(c, r, 0, 90); SEC(c, r, 180, 270); };
    const dashed = (a, b, layer) => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.floor(L / 4)); for (let i = 0; i < n; i++) { const t0 = i / n, t1 = (i + 0.6) / n; Ln([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1], layer || 'ASSI', 0.13); } };
    const mm = v => nf(Math.abs(v) * 1000, 0);
    const hd = (xa, xb, y, txt) => { Ln([xa, y], [xb, y], 'QUOTE', 0.18); Ln([xa, y - 1.3], [xa, y + 1.3], 'QUOTE', 0.18); Ln([xb, y - 1.3], [xb, y + 1.3], 'QUOTE', 0.18); T([(xa + xb) / 2, y + 1], txt, 2.1, 'QUOTE', 'center'); };
    const vd = (ya, yb, x, txt, left) => { Ln([x, ya], [x, yb], 'QUOTE', 0.18); Ln([x - 1.3, ya], [x + 1.3, ya], 'QUOTE', 0.18); Ln([x - 1.3, yb], [x + 1.3, yb], 'QUOTE', 0.18); T([x + (left ? -1.5 : 1.5), (ya + yb) / 2], txt, 2.1, 'QUOTE', left ? 'right' : 'left'); };
    const mapper = (h, e, r, S) => { const k2 = 1000 / S, cu = (e.u0 + e.u1) / 2, cv = (e.v0 + e.v1) / 2, ox = r[0] + r[2] / 2, oy = r[1] + r[3] / 2 - 1;
      const map = (u, v) => [ox + (u - cu) * k2, oy + (v - cv) * k2]; return {k2, map, pm: p => { const q = h.prj(p[0], p[1], p[2]); return map(q[0], q[1]); }}; };
    rect(5, 5, 410, 287, 'CORNICE', 0.5);
    rect(...R.plan, 'CORNICE', 0.18); rect(...R.tab, 'CORNICE', 0.18); secs.forEach(sc => rect(...sc.r, 'CORNICE', 0.18));
    // ---- pianta
    { const r = R.plan, {k2, map, pm} = mapper(HP, EP, r, SP), hpp = pm(hook), cp = pm([0, 0, 0]);
      HP.segs.forEach(sg => Ln(map(sg[0], sg[1]), map(sg[2], sg[3]), 'CONTORNI', 0.3));
      T([r[0] + 2, r[1] + r[3] - 4], 'PIANTA   1:' + SP, 2.8);
      dashed([r[0] + 4, cp[1]], [r[0] + r[2] - 4, cp[1]]); dashed([cp[0], r[1] + 4], [cp[0], r[1] + r[3] - 8]);
      const ext = {top: map(0, HP.vmax)[1], bot: map(0, HP.vmin)[1], left: map(HP.umin, 0)[0], right: map(HP.umax, 0)[0]};
      lugs.forEach(l => { const lp = pm(l.L); Ln(lp, hpp, 'FUNI', 0.7); C(lp, Math.max(1.3, 0.15 * k2), 'GOLFARI', 0.6); const ox = lp[0] < cp[0] ? -1 : 1, up = l.L[1] >= 0, q = [lp[0] + ox * 9, up ? ext.top + 15.5 : ext.bot - 17.5];
        Ln(lp, [q[0], q[1] + (up ? -1.5 : 3.5)], 'FUNI', 0.15); P.push({t: 'tbox', p: q, txt: 'F' + l.n, s: 3.2 * 1.5, layer: 'FUNI', align: 'center'}); P.push({t: 'text', p: q, txt: 'F' + l.n, s: 3.2 * 1.5, layer: 'FUNI', align: 'center', bold: true});
        const yq = up ? ext.top + 8.5 : ext.bot - 8.5; Ln(lp, [lp[0], yq + (up ? 1.5 : -1.5)], 'QUOTE', 0.12); hd(Math.min(lp[0], cp[0]), Math.max(lp[0], cp[0]), yq, `X ${mm(l.L[0])}`);
        const xq = ox < 0 ? ext.left - 7 : ext.right + 7; Ln(lp, [xq + (ox < 0 ? -1.5 : 1.5), lp[1]], 'QUOTE', 0.12); vd(Math.min(lp[1], cp[1]), Math.max(lp[1], cp[1]), xq, `Y ${mm(l.L[1])}`, ox < 0);
        if (false) T([0, 0], 'F' + l.n, 2.4, 'FUNI', ox < 0 ? 'right' : 'left'); });
      cogSym(cp, 2.6); { const tx = `COG = ${nf(d.weight, 1)} t`, tp = [cp[0] + 11, cp[1] + 4.2], ts = 3.3; P.push({t: 'tbox', p: tp, txt: tx, s: ts, layer: 'BARICENTRO'}); P.push({t: 'text', p: tp, txt: tx, s: ts, layer: 'BARICENTRO', align: 'left'}); }
      // tracce delle sezioni
      const vMin = HP.vmin - 0.6, vMax = HP.vmax + 0.6;
      const arrow = (p, dir) => { const a = 4, b = 1.4, q = [p[0] + dir[0] * a, p[1] + dir[1] * a]; Ln(p, q, 'SEZIONI', 0.3); Ln(q, [q[0] - dir[0] * b * 1.4 + dir[1] * b, q[1] - dir[1] * b * 1.4 - dir[0] * b], 'SEZIONI', 0.3); Ln(q, [q[0] - dir[0] * b * 1.4 - dir[1] * b, q[1] - dir[1] * b * 1.4 + dir[0] * b], 'SEZIONI', 0.3); };
      secs.forEach(sc => {
        let A, B, dir;
        if (sc.kind === 'T') { A = pm([sc.at, vMin, 0]); B = pm([sc.at, vMax, 0]); dir = [1, 0]; A[1] = Math.max(A[1], r[1] + 3); B[1] = Math.min(B[1], r[1] + r[3] - 7); }
        else { A = pm([uLo, sc.at, 0]); B = pm([uHi, sc.at, 0]); dir = [0, 1]; }
        const L = Math.hypot(B[0] - A[0], B[1] - A[1]), n = Math.max(1, Math.floor(L / 6));
        for (let i = 0; i < n; i++) { const t0 = i / n, t1 = (i + 0.7) / n; Ln([A[0] + (B[0] - A[0]) * t0, A[1] + (B[1] - A[1]) * t0], [A[0] + (B[0] - A[0]) * t1, A[1] + (B[1] - A[1]) * t1], 'SEZIONI', 0.25); }
        [sc.kind === 'T' ? B : A].forEach(p => { arrow(p, dir); T(sc.kind === 'T' ? [p[0] + 4, p[1] + (p === A ? -2.5 : 1)] : [p[0] + (p === A ? -2 : 2), p[1] + 3.5], String(sc.n), 3.2, 'SEZIONI', sc.kind === 'T' ? 'left' : (p === A ? 'right' : 'left')); });
      });
    }
    // ---- sezioni
    secs.forEach(sc => {
      const r = sc.r, S = sc.kind === 'T' ? ST : SL, {k2, map, pm} = mapper(sc.h, sc.e, r, S);
      sc.h.segs.forEach(sg => Ln(map(sg[0], sg[1]), map(sg[2], sg[3]), 'CONTORNI', 0.25));
      sc.cut.forEach(sg => Ln(map(sg[0], sg[1]), map(sg[2], sg[3]), 'TAGLIO', 0.6));
      T([r[0] + 2, r[1] + r[3] - 4], `SEZIONE ${sc.n}-${sc.n}   1:${S}`, 2.8);
      const cp = pm([sc.kind === 'T' ? sc.at : 0, sc.kind === 'T' ? 0 : sc.at, 0]);
      dashed([cp[0], r[1] + 3], [cp[0], r[1] + r[3] - 7]); T([cp[0] + 1, r[1] + 4], 'asse baricentro', 1.7, 'ASSI');
      { const y0 = pm([0, 0, z0])[1], xl = map(sc.h.umin, 0)[0] - 3, xr = Math.min(map(sc.h.umax, 0)[0] + 3, r[0] + r[2] - 24);
        Ln([xl, y0], [xr + 12, y0], 'QUOTE', 0.25); Ln([xr + 5, y0], [xr + 3.3, y0 + 3], 'QUOTE', 0.25); Ln([xr + 5, y0], [xr + 6.7, y0 + 3], 'QUOTE', 0.25); Ln([xr + 3.3, y0 + 3], [xr + 6.7, y0 + 3], 'QUOTE', 0.25);
        T([xr + 8, y0 + 3.4], '±0,00', 2.3, 'QUOTE');
        const yc = pm([0, 0, 0])[1]; cogSym([cp[0], yc], 1.6); { const tp = [cp[0] + 2.8, yc - 3.4], tx = `COG ${lvl(zr(0))}`; P.push({t: 'tbox', p: tp, txt: tx, s: 2.0 * 1.5, layer: 'BARICENTRO'}); T(tp, tx, 2.0, 'BARICENTRO'); } }
      let yTop = -Infinity;
      sc.lugs.forEach(l => {
        const lp = pm(l.L), a = (sc.kind === 'T' ? 0.08 : 0.275) * k2, hh = 0.3 * k2;
        Ln([lp[0] - a, lp[1]], [lp[0] + a, lp[1]], 'GOLFARI', 0.35); Ln([lp[0] - a, lp[1]], [lp[0] - a * 0.5, lp[1] + hh], 'GOLFARI', 0.35);
        Ln([lp[0] + a, lp[1]], [lp[0] + a * 0.5, lp[1] + hh], 'GOLFARI', 0.35); Ln([lp[0] - a * 0.5, lp[1] + hh], [lp[0] + a * 0.5, lp[1] + hh], 'GOLFARI', 0.35);
        const tp = [lp[0], lp[1] + hh], hq = pm(hook), dx = hq[0] - tp[0], dy = hq[1] - tp[1], dl = Math.hypot(dx, dy) || 1, len = 12;
        const ep = [tp[0] + dx / dl * len, tp[1] + dy / dl * len]; Ln(tp, ep, 'FUNI', 0.45);
        { const q = [ep[0] + (dx < 0 ? -1.5 : 1.5), ep[1] + 1.5], al = dx < 0 ? 'right' : 'left'; P.push({t: 'tbox', p: q, txt: 'F' + l.n, s: 2.8 * 1.5, layer: 'FUNI', align: al}); T(q, 'F' + l.n, 2.8, 'FUNI', al); P[P.length - 1].bold = true; }
        T([lp[0] + (dx < 0 ? a + 1.5 : -a - 1.5), lp[1] + hh + 2.2], lvl(zr(l.L[2])), 1.9, 'QUOTE', dx < 0 ? 'left' : 'right');
        yTop = Math.max(yTop, ep[1]);
      });
      // quote dei golfari dall'asse del baricentro
      const yq = Math.min(yTop + 7, r[1] + r[3] - 9);
      sc.lugs.forEach(l => { const x = pm(l.L)[0]; hd(Math.min(x, cp[0]), Math.max(x, cp[0]), yq, mm(sc.kind === 'T' ? l.L[1] : l.L[0])); });
    });
    // tabella
    const t = R.tab, x0 = t[0] + 2; let y = t[1] + t[3] - 5;
    T([x0, y], 'GOLFARI E FUNI', 2.43); y -= 6;
    const cols = [0, 9, 19, 33, 46, 61, 76];
    ['', 'Trave', 'Carico t', 'Tiro t', 'Angolo', 'Fune m', 'Grillo'].forEach((h, i) => { T([x0 + cols[i], y], h, 2.0); P[P.length - 1].bold = true; }); y -= 2.5; Ln([x0, y], [t[0] + t[2] - 2, y], 'CORNICE', 0.13); y -= 5;
    lugs.forEach(l => { const row = ['F' + l.n, l.g || '', nf(l.P, 1), nf(l.T, 1), nf(l.alpha, 1) + '°', nf(l.Ls, 2)];
      row.forEach((v, j) => { T([x0 + cols[j], y], v, 2.34); if (j === 0 || j === 3) P[P.length - 1].bold = true; });
      T([x0 + cols[6], y], String(l.type || l.shackle || '–').replace(/^Grillo\s+/i, ''), 1.9); y -= 8.5; });
    y -= 1; T([x0, y], `Tiro max ${nf(Math.max(...lugs.map(l => l.T)), 1)} t${d.skl && d.skl !== 1 ? ' · SKL ' + nf(d.skl, 2) + ' nelle verifiche' : ''}`, 2.43); P[P.length - 1].bold = true; y -= 6.5;
    T([x0, y], `Gancio sopra il baricentro, quota ${lvl(zr(hook[2]))} m`, 2.17); y -= 5.5;
    T([x0, y], `COG a quota ${lvl(zr(0))} m`, 2.17); y -= 5.5;
    T([x0, y], `Golfari a ${[...new Set(lugs.map(l => lvl(zr(l.L[2]))))].join(' / ')} m`, 2.17); y -= 5.5;
    // cartiglio
    const ty = 8, th = 38; rect(12, ty, 396, th, 'CORNICE', 0.35); Ln([250, ty], [250, ty + th], 'CORNICE', 0.25);
    T([14, ty + th - 6], `SCHEMA DI SOLLEVAMENTO CON GRU SINGOLA – ${d.name}`, 3.4); P[P.length - 1].bold = true;
    T([14, ty + th - 13], `Peso ${nf(d.weight, 2)} t · ${lugs.length} golfari · pianta 1:${SP}, sezioni 1:${ST}${nL ? ' / 1:' + SL : ''} su A3`, 2.5);
    T([14, ty + th - 19], `COG nel modello  X ${nf(c0[0], 3)}  Y ${nf(c0[1], 3)}  Z ${nf(c0[2], 3)} m`, 2.3);
    logos(P, ty);
    cartRight(P, 252, ty, th, d.project, [`Gruppo: ${d.group || ''}`], 'Peso e baricentro · Golfari · Trimble Connect');
    return {prims: P, scale: SP};
  }

  // ------------------------------------------------------------------ TAVOLA DI SOLLEVAMENTO (golfari e funi)
  /**
   * d = {meshes (rel. ref), ref, cog (ass.), ax:[ax,ay], lugs:[{x,y,z,label,T,P,alpha,Ls,g,type,shackle}], hook:[x,y,z],
   *      name, weight, project, model, group, drawBolts, fd}
   */
  function buildLugSheet(d) {
    if (d.outline) return buildOutlineSheet(d);
    const ax = d.ax, pv = [-ax[1], ax[0]], c0 = d.cog;
    const toL = (x, y, z) => { const dx = x - c0[0], dy = y - c0[1]; return [dx * ax[0] + dy * ax[1], dx * pv[0] + dy * pv[1], z - c0[2]]; };
    const draw = d.meshes.filter(m => d.outline ? !isMinute(m) : (d.drawBolts || !m.bolt));
    const local = draw.map(m => { const q = new Float64Array(m.pos.length); for (let i = 0; i < q.length; i += 3) { const s = toL(m.pos[i] + d.ref[0], m.pos[i + 1] + d.ref[1], m.pos[i + 2] + d.ref[2]); q[i] = s[0]; q[i + 1] = s[1]; q[i + 2] = s[2]; } return {pos: q, idx: m.idx}; });
    const edges = d.outline ? null : local.map(m => featureEdges(m, 25)), EN = d.outline ? local.map(edgeNormals) : null;
    const HK = (d.hooks || [d.hook]).map(h => toL(h[0], h[1], h[2])), hook = HK[0], multi = HK.length > 1; // più gru: un gancio per gru
    const lugs = d.lugs.map(l => ({...l, L: toL(l.x, l.y, l.z), H: HK[l.hk || 0]}));
    const z0 = zeroLevel(local), zr = z => z - z0; // quote relative al ±0,00
    const VIEWS = {front: {f: [0, 1, 0], up: [0, 0, 1], title: 'PROSPETTO'}, plan: {f: [0, 0, -1], up: [0, 1, 0], title: 'PIANTA'}, side: {f: [1, 0, 0], up: [0, 0, 1], title: 'SEZIONE TRASVERSALE'}};
    const H = {}; for (const k in VIEWS) H[k] = d.outline ? (h => ({...h, segs: dropShort(h.segs, 0.4, 0.01)}))(hiddenLine(local, EN.map(en => contourEdges(en, norm(VIEWS[k].f))), VIEWS[k], 1600)) : hiddenLine(local, edges, VIEWS[k], 1400);
    // ingombri comprensivi di funi e gancio
    const ext = k => { const h = H[k]; let u0 = h.umin, u1 = h.umax, v0 = h.vmin, v1 = h.vmax; [...HK, ...lugs.map(l => l.L)].forEach(p => { const q = h.prj(p[0], p[1], p[2]); u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); v0 = Math.min(v0, q[1]); v1 = Math.max(v1, q[1]); }); return {u0, u1, v0, v1}; };
    const E = {front: ext('front'), plan: ext('plan'), side: ext('side')};
    const top = 287, bot = 50;
    const R = {front: [12, top - 125, 270, 125], plan: [12, bot, 270, top - 125 - bot], side: [284, top - 125, 124, 125], tab: [284, bot, 124, top - 125 - bot]};
    const need = k => { const e = E[k], r = R[k]; return Math.max((e.u1 - e.u0) / (r[2] - 30), (e.v1 - e.v0) / (r[3] - 26)) * 1000; };
    const S = SCALES.find(s => s >= Math.max(need('front'), need('plan'), need('side'))) || 5000;
    const P = [];
    const Ln = (a, b, layer, w) => P.push({t: 'line', a, b, layer: layer || 'CONTORNI', w: w || 0.25});
    const T = (p, txt, size, layer, align) => P.push({t: 'text', p, txt: String(txt), s: (size || 2.5) * 1.3, layer: layer || 'TESTI', align: align || 'left'});
    const C = (c, r, layer) => P.push({t: 'circle', c, r, layer: layer || 'BARICENTRO'});
    const SEC = (c, r, a0, a1, layer) => P.push({t: 'sector', c, r, a0, a1, layer: layer || 'BARICENTRO'});
    const rect = (x, y, w, h, layer, wt) => { Ln([x, y], [x + w, y], layer, wt); Ln([x + w, y], [x + w, y + h], layer, wt); Ln([x + w, y + h], [x, y + h], layer, wt); Ln([x, y + h], [x, y], layer, wt); };
    const cogSym = (c, r) => { C(c, r); SEC(c, r, 0, 90); SEC(c, r, 180, 270); };
    const dashed = (a, b, layer) => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.floor(L / 4)); for (let i = 0; i < n; i++) { const t0 = i / n, t1 = (i + 0.6) / n; Ln([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1], layer || 'ASSI', 0.13); } };
    const mm = v => nf(Math.abs(v) * 1000, 0);
    // raggruppa valori vicini (golfari di due travi quasi alla stessa progressiva): una quota con i due valori
    const clusters = vals => { const sorted = [...vals].sort((a, b) => a - b), out = [];
      sorted.forEach(v => { const l = out[out.length - 1]; if (l && Math.abs(v - l.vals[l.vals.length - 1]) < 0.25) l.vals.push(v); else out.push({vals: [v]}); });
      return out.map(c => ({v: c.vals.reduce((a, b) => a + b, 0) / c.vals.length, txt: [...new Set(c.vals.map(x => mm(x)))].join(' / ')})); };
    rect(5, 5, 410, 287, 'CORNICE', 0.5);
    for (const k of ['front', 'plan', 'side', 'tab']) rect(...R[k], 'CORNICE', 0.18);
    function place(k) {
      const h = H[k], e = E[k], r = R[k], k2 = 1000 / S;
      const cu = (e.u0 + e.u1) / 2, cv = (e.v0 + e.v1) / 2, ox = r[0] + r[2] / 2 - 4, oy = r[1] + r[3] / 2 + 2;
      const map = (u, v) => [ox + (u - cu) * k2, oy + (v - cv) * k2];
      const pm = p => { const q = h.prj(p[0], p[1], p[2]); return map(q[0], q[1]); };
      h.segs.forEach(sg => Ln(map(sg[0], sg[1]), map(sg[2], sg[3]), 'CONTORNI', d.outline ? 0.4 : 0.25));
      T([r[0] + 2, r[1] + r[3] - 4], VIEWS[k].title + (d.outline ? ' (sagoma)' : '') + '   1:' + S, 2.8);
      const cp = pm([0, 0, 0]), hp = pm(hook);
      // asse baricentro
      if (k !== 'plan') dashed([cp[0], r[1] + 4], [cp[0], r[1] + r[3] - 8], 'ASSI'), T([cp[0] + 1, r[1] + 8], 'asse baricentro', 1.8, 'ASSI');
      else { dashed([r[0] + 4, cp[1]], [r[0] + r[2] - 4, cp[1]], 'ASSI'); dashed([cp[0], r[1] + 4], [cp[0], r[1] + r[3] - 8], 'ASSI'); }
      // funi
      const grp = new Map(); // golfari che in questa vista cadono nello stesso punto: etichetta unica
      lugs.forEach((l, i) => { const lp = pm([l.L[0], l.L[1], l.L[2] + 0.16]), hq = pm(l.H); Ln(lp, hq, 'FUNI', k === 'plan' ? 1.0 : 0.6);
        let gk = [...grp.keys()].find(kk => Math.hypot(grp.get(kk).lp[0] - lp[0], grp.get(kk).lp[1] - lp[1]) < 4.5); if (gk == null) { gk = grp.size; grp.set(gk, {lp, hp: hq, ids: [], al: []}); } grp.get(gk).ids.push(i + 1); grp.get(gk).al.push(l.alpha); });
      const nRowT = 1, nRowB = 1; // righe di quote sopra/sotto la pianta
      const placed = [];
      grp.forEach(gq => { const lp = gq.lp, hq = gq.hp, mid = [(lp[0] + hq[0]) / 2, (lp[1] + hq[1]) / 2], left = lp[0] < hq[0] - 0.5, lab = gq.ids.map(x => 'F' + x).join('/');
        if (k === 'plan') { // fuori dalla struttura: sopra i golfari in alto, sotto quelli in basso, su fondo bianco
          const ext = {top: map(0, h.vmax)[1], bot: map(0, h.vmin)[1]};
          const up = lp[1] >= cp[1], q = [lp[0], up ? ext.top + 15 + (multi ? 7 : 0) : ext.bot - 17 - (multi ? 7 : 0)], sz = 3.2;
          Ln(lp, [q[0], q[1] + (up ? -1.5 : 3.5)], 'FUNI', 0.15);
          P.push({t: 'tbox', p: q, txt: lab, s: sz * 1.3, layer: 'FUNI', align: 'center'}); T(q, lab, sz, 'FUNI', 'center'); P[P.length - 1].bold = true;
        } else { const q = [mid[0] + (left ? -2.5 : 2.5), mid[1] + 1.5]; while (placed.some(o => Math.abs(o[0] - q[0]) < 12 && Math.abs(o[1] - q[1]) < 5.5)) q[1] -= 6; placed.push(q.slice()); P.push({t: 'tbox', p: q, txt: lab, s: 3.0 * 1.3, layer: 'FUNI', align: left ? 'right' : 'left'}); T(q, lab, 3.0, 'FUNI', left ? 'right' : 'left'); P[P.length - 1].bold = true; }
        if (k === 'front') T([lp[0] + (left ? -2 : 2), lp[1] - 6], gq.al.map(a => nf(a, 1) + '°').join(' / '), 2.1, 'QUOTE', left ? 'right' : 'left'); });
      // golfari
      lugs.forEach(l => { const lp = pm(l.L); if (k === 'front') { const a = 0.275 * k2, hh = 0.3 * k2; Ln([lp[0] - a, lp[1]], [lp[0] + a, lp[1]], 'GOLFARI', 0.35); Ln([lp[0] - a, lp[1]], [lp[0] - a * 0.4, lp[1] + hh], 'GOLFARI', 0.35); Ln([lp[0] + a, lp[1]], [lp[0] + a * 0.4, lp[1] + hh], 'GOLFARI', 0.35); Ln([lp[0] - a * 0.4, lp[1] + hh], [lp[0] + a * 0.4, lp[1] + hh], 'GOLFARI', 0.35); }
        else { C(lp, Math.max(0.8, 0.12 * k2), 'GOLFARI'); } });
      // gancio
      const hSeen = []; HK.forEach((H, j) => { const q = pm(H); C(q, 1.6, 'FUNI'); Ln([q[0], q[1] + 1.6], [q[0], q[1] + 6], 'FUNI', 0.35);
        const dup = hSeen.some(o => Math.hypot(o[0] - q[0], o[1] - q[1]) < 3); hSeen.push(q); if (dup) return;
        if (k !== 'plan') T([q[0] + 2.5, q[1] + 4], `Gancio ${multi ? (HK.slice(j + 1).some(H2 => Math.hypot(...pm(H2).map((v, i) => v - q[i])) < 3) ? 'gru ' + HK.map((_, i) => i + 1).slice(j).join('-') : 'gru ' + (j + 1)) : 'gru'}  ${lvl(zr(H[2]))}`, 2.2, 'FUNI');
        else if (multi) { T([q[0] + 2.5, q[1] + 2.5], 'Gru ' + (j + 1), 2.4, 'FUNI'); P[P.length - 1].bold = true; } });
      if (k !== 'plan') { // livello ±0,00 e quote dei golfari
        const y0 = pm([0, 0, z0])[1], xr = Math.min(map(h.umax, 0)[0] + 3, r[0] + r[2] - 22), xl = map(h.umin, 0)[0] - 3;
        Ln([xl, y0], [xr + 10, y0], 'QUOTE', 0.25); Ln([xr + 4, y0], [xr + 2.5, y0 + 2.6], 'QUOTE', 0.25); Ln([xr + 4, y0], [xr + 5.5, y0 + 2.6], 'QUOTE', 0.25); Ln([xr + 2.5, y0 + 2.6], [xr + 5.5, y0 + 2.6], 'QUOTE', 0.25);
        T([xr + 6.5, y0 + 3], '±0,00', 2.4, 'QUOTE');
        const seen = new Set(); lugs.forEach(l => { const lp = pm(l.L), key = Math.round(lp[0] / 6); if (seen.has(key)) return; seen.add(key); const out = lp[0] < pm(l.H)[0] ? -1 : 1; T([lp[0] + out * 3.5, lp[1] + 3.5], lvl(zr(l.L[2])), 2.0, 'QUOTE', out < 0 ? 'right' : 'left'); });
      }
      cogSym(cp, 2.0); { const tx = `COG = ${nf(d.weight, 1)} t` + (k !== 'plan' ? `  ${lvl(zr(0))}` : ''), al = k === 'side' ? 'right' : 'left', tp = [cp[0] + (al === 'right' ? -3.5 : 3.5), cp[1] - 5.5];
        P.push({t: 'tbox', p: tp, txt: tx, s: 2.3 * 1.3, layer: 'BARICENTRO', align: al}); T(tp, tx, 2.3, 'BARICENTRO', al); }
      // quote
      const hd = (xa, xb, y, txt) => { Ln([xa, y], [xb, y], 'QUOTE', 0.18); Ln([xa, y - 1.3], [xa, y + 1.3], 'QUOTE', 0.18); Ln([xb, y - 1.3], [xb, y + 1.3], 'QUOTE', 0.18); T([(xa + xb) / 2, y + 1], txt, 2.1, 'QUOTE', 'center'); };
      const vd = (ya, yb, x, txt) => { Ln([x, ya], [x, yb], 'QUOTE', 0.18); Ln([x - 1.3, ya], [x + 1.3, ya], 'QUOTE', 0.18); Ln([x - 1.3, yb], [x + 1.3, yb], 'QUOTE', 0.18); T([x + 1.5, (ya + yb) / 2], txt, 2.1, 'QUOTE'); };
      // quote di ogni golfare dal baricentro: una quota per golfare, mai valori accoppiati
      const vdS = (ya, yb, x, txt, left) => { Ln([x, ya], [x, yb], 'QUOTE', 0.18); Ln([x - 1.3, ya], [x + 1.3, ya], 'QUOTE', 0.18); Ln([x - 1.3, yb], [x + 1.3, yb], 'QUOTE', 0.18); T([x + (left ? -1.5 : 1.5), (ya + yb) / 2], txt, 2.3, 'QUOTE', left ? 'right' : 'left'); };
      const hdS = (xa, xb, y, txt) => { Ln([xa, y], [xb, y], 'QUOTE', 0.18); Ln([xa, y - 1.3], [xa, y + 1.3], 'QUOTE', 0.18); Ln([xb, y - 1.3], [xb, y + 1.3], 'QUOTE', 0.18); T([(xa + xb) / 2, y + 1.2], txt, 2.3, 'QUOTE', 'center'); };
      const nm = l => 'F' + (lugs.indexOf(l) + 1);
      if (k === 'plan') {
        const ext = {top: map(0, h.vmax)[1], bot: map(0, h.vmin)[1], left: map(h.umin, 0)[0], right: map(h.umax, 0)[0]};
        const top = lugs.filter(l => l.L[1] >= 0), bot = lugs.filter(l => l.L[1] < 0);
        // X lungo l'asse: sopra per la trave superiore, sotto per l'inferiore
        [[top, ext.top + 6, 1], [bot, ext.bot - 6, -1]].forEach(([ls, y0, sg]) => { const srt = multi ? [...ls].sort((a, c) => Math.abs(a.L[0]) - Math.abs(c.L[0])) : ls; srt.forEach((l, ii) => { const y = multi ? y0 + sg * ii * 5 : y0, lp = pm(l.L); Ln(lp, [lp[0], y + sg * 1.5], 'QUOTE', 0.12); hdS(Math.min(lp[0], cp[0]), Math.max(lp[0], cp[0]), y, `X ${mm(l.L[0])}`); }); });
        Ln([cp[0], ext.top + 7.5], [cp[0], ext.bot - 7.5], 'QUOTE', 0.12);
        // Y trasversale: a sinistra per i golfari di sinistra, a destra per quelli di destra
        const lf = lugs.filter(l => l.L[0] < 0), rt = lugs.filter(l => l.L[0] >= 0);
        [[lf, ext.left - 7, true], [rt, ext.right + 7, false]].forEach(([ls, x, left]) => ls.forEach(l => { const lp = pm(l.L); Ln(lp, [x + (left ? -1.5 : 1.5), lp[1]], 'QUOTE', 0.12); vdS(Math.min(lp[1], cp[1]), Math.max(lp[1], cp[1]), x, `Y ${mm(l.L[1])}`, left); }));
        Ln([ext.left - 8.5, cp[1]], [ext.right + 8.5, cp[1]], 'QUOTE', 0.12);
      }
      if (k === 'front') { // una riga per trave
        const byG = [...new Set(lugs.map(l => l.g || ''))];
        const y0q = Math.max(...lugs.map(l => pm(l.L)[1])) + 9;
        let row = 0; byG.forEach((gn, i) => { const ls = lugs.filter(l => (l.g || '') === gn), y = y0q + (multi ? row : i) * 6;
          if (multi) { const xs = [...new Set(ls.map(l => Math.round(l.L[0] * 100)))].sort((a, c) => Math.abs(a) - Math.abs(c)); xs.forEach((xv, ii) => { const l = ls.find(q => Math.round(q.L[0] * 100) === xv), x = pm(l.L)[0], yy = y + ii * 5; hdS(Math.min(x, cp[0]), Math.max(x, cp[0]), yy, mm(l.L[0])); }); row += xs.length * 5 / 6 + 0.3; }
          else ls.forEach(l => { const x = pm(l.L)[0]; hdS(Math.min(x, cp[0]), Math.max(x, cp[0]), y, mm(l.L[0])); });
          T([Math.min(...ls.map(l => pm(l.L)[0]), cp[0]) - 2, y], ls.map(nm).join('-'), 2.1, 'QUOTE', 'right'); });
        HK.forEach((H, j) => { const l0 = lugs.find(l => (l.hk || 0) === j); if (!l0) return; const lz = pm(l0.L), hq = pm(H); vd(lz[1], hq[1], hq[0] - 10, mm(H[2] - l0.L[2])); });
      }
      if (k === 'side') { // una riga per lato del baricentro (golfari a sinistra / a destra in pianta)
        const sides = [lugs.filter(l => l.L[0] < 0), lugs.filter(l => l.L[0] >= 0)].filter(a => a.length);
        const y0q = Math.max(...lugs.map(l => pm(l.L)[1])) + 9;
        sides.forEach((ls, i) => { const y = y0q + i * 6; ls.forEach(l => { const x = pm(l.L)[0]; hdS(Math.min(x, cp[0]), Math.max(x, cp[0]), y, mm(l.L[1])); });
          T([Math.min(...ls.map(l => pm(l.L)[0]), cp[0]) - 2, y], ls.map(nm).join('-'), 2.1, 'QUOTE', 'right'); });
      }
    }
    place('front'); place('plan'); place('side');
    // tabella golfari e funi
    const t = R.tab, x0 = t[0] + 2; let y = t[1] + t[3] - 5;
    T([x0, y], multi ? 'PUNTI DI PRESA E FUNI' : 'GOLFARI E FUNI', 2.8); y -= 6;
    const cols = [0, 9, 19, 33, 46, 61, 76];
    ['', multi ? 'Gru' : 'Trave', 'Carico t', 'Tiro t', 'Angolo', 'Fune m', multi ? '' : 'Grillo'].forEach((h, i) => { T([x0 + cols[i], y], h, 2.3); P[P.length - 1].bold = true; }); y -= 2.5; Ln([x0, y], [t[0] + t[2] - 2, y], 'CORNICE', 0.2); y -= 5;
    lugs.forEach((l, i) => { const row = ['F' + (i + 1), multi ? String((l.hk || 0) + 1) : (l.g || ''), nf(l.P, 1), nf(l.T, 1), nf(l.alpha, 1) + '°', nf(l.Ls, 2)];
      row.forEach((v, j) => { T([x0 + cols[j], y], v, 2.7); if (j === 0 || j === 3) P[P.length - 1].bold = true; });
      const gr = String(l.type || l.shackle || '–').replace(/^Grillo\s+/i, ''); if (!multi) T([x0 + cols[6], y], gr, 2.2); y -= 8.5; });
    y -= 1; T([x0, y], `Tiro max ${nf(Math.max(...lugs.map(l => l.T)), 1)} t${d.skl && d.skl !== 1 ? ' · SKL ' + nf(d.skl, 2) + ' nelle verifiche' : ''}`, 2.8); P[P.length - 1].bold = true; y -= 6.5;
    if (multi) HK.forEach((H, j) => { const hl = (d.hookLoads || [])[j]; T([x0, y], `Gru ${j + 1}: gancio a quota ${lvl(zr(H[2]))} m${hl != null ? ` · carico ${nf(hl, 1)} t (${nf(hl / d.weight * 100, 0)}%)` : ''}`, 2.5); P[P.length - 1].bold = true; y -= 5.5; });
    else T([x0, y], `Gancio sopra il baricentro, quota ${lvl(zr(hook[2]))} m`, 2.5), y -= 5.5;
    T([x0, y], `COG a quota ${lvl(zr(0))} m`, 2.5); y -= 5.5;
    T([x0, y], `${multi ? 'Punti di presa' : 'Golfari'} a ${[...new Set(lugs.map(l => lvl(zr(l.L[2]))))].join(' / ')} m`, 2.5); y -= 5.5;
    // cartiglio
    const ty = 8, th = 38; rect(12, ty, 396, th, 'CORNICE', 0.35); Ln([250, ty], [250, ty + th], 'CORNICE', 0.25);
    T([14, ty + th - 6], `SCHEMA DI SOLLEVAMENTO ${multi ? `CON ${HK.length} GRU (TANDEM)` : 'CON GRU SINGOLA'} – ${d.name}`, 3.4); P[P.length - 1].bold = true;
    T([14, ty + th - 13], `Peso ${nf(d.weight, 2)} t · ${lugs.length} ${d.pointsLabel || 'golfari'} · scala 1:${S} su A3`, 2.5);
    T([14, ty + th - 19], `COG nel modello  X ${nf(c0[0], 3)}  Y ${nf(c0[1], 3)}  Z ${nf(c0[2], 3)} m`, 2.3);
    logos(P, ty);

    cartRight(P, 252, ty, th, d.project, [`Gruppo: ${d.group || ''}`], 'Peso e baricentro · Golfari · Trimble Connect');
    return {prims: P, scale: S};
  }

  // ------------------------------------------------------------------ IFC di funi, golfari, gancio e baricentro
  function lugIfc(d) {
    const out = []; let n = 0; const add = s => { n++; out.push(`#${n}=${s};`); return `#${n}`; };
    const G64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
    const guid = () => { let s = G64[Math.floor(Math.random() * 4)]; for (let i = 0; i < 21; i++) s += G64[Math.floor(Math.random() * 64)]; return s; };
    const str = s => `'${String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[^\x20-\x7e]/g, ch => { const c = ch.charCodeAt(0); return c < 256 ? `\\X\\${c.toString(16).toUpperCase().padStart(2, '0')}` : `\\X2\\${c.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`; })}'`;
    const o = d.origin; // metri, punto di inserimento del sito
    const mmf = v => (Math.round(v * 10000) / 10).toFixed(1);
    const pt = (p) => `(${mmf(p[0] - o[0])},${mmf(p[1] - o[1])},${mmf(p[2] - o[2])})`;
    const p0 = add('IFCCARTESIANPOINT((0.,0.,0.))'), dz = add('IFCDIRECTION((0.,0.,1.))'), dx = add('IFCDIRECTION((1.,0.,0.))'), a0 = add(`IFCAXIS2PLACEMENT3D(${p0},${dz},${dx})`);
    const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${a0},$)`), body = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
    const units = add(`IFCUNITASSIGNMENT((${add('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)')},${add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)')},${add('IFCSIUNIT(*,.MASSUNIT.,.KILO.,.GRAM.)')}))`);
    const proj = add(`IFCPROJECT('${guid()}',$,${str(d.project || 'Sollevamento')},${str('Schema di sollevamento - ' + d.name)},$,$,$,(${ctx}),${units})`);
    const sp = add(`IFCCARTESIANPOINT((${(o[0] * 1000).toFixed(1)},${(o[1] * 1000).toFixed(1)},${(o[2] * 1000).toFixed(1)}))`);
    const spl = add(`IFCLOCALPLACEMENT($,${add(`IFCAXIS2PLACEMENT3D(${sp},${dz},${dx})`)})`);
    const site = add(`IFCSITE('${guid()}',$,'Sollevamento',$,$,${spl},$,$,.ELEMENT.,$,$,$,$,$)`);
    add(`IFCRELAGGREGATES('${guid()}',$,$,$,${proj},(${site}))`);
    const pl = add(`IFCLOCALPLACEMENT(${spl},${a0})`);
    const styles = {}; const style = hex => { if (styles[hex]) return styles[hex]; const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
      const col = add(`IFCCOLOURRGB($,${r.toFixed(3)},${g.toFixed(3)},${b.toFixed(3)})`); return styles[hex] = add(`IFCSURFACESTYLE($,.BOTH.,(${add(`IFCSURFACESTYLESHADING(${col},0.)`)}))`); };
    const shape = (V, F, hex) => { const pl3 = add(`IFCCARTESIANPOINTLIST3D((${V.map(pt).join(',')}))`); const fs = add(`IFCTRIANGULATEDFACESET(${pl3},$,.T.,(${F.map(f => `(${f[0] + 1},${f[1] + 1},${f[2] + 1})`).join(',')}),$)`);
      add(`IFCSTYLEDITEM(${fs},(${style(hex)}),$)`); return add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${add(`IFCSHAPEREPRESENTATION(${body},'Body','Tessellation',(${fs}))`)}))`); };
    const pset = (obj, name, props) => { const ps = props.map(([k, v]) => add(`IFCPROPERTYSINGLEVALUE(${str(k)},$,${typeof v === 'number' ? `IFCREAL(${v.toFixed(3)})` : `IFCLABEL(${str(v)})`},$)`)); add(`IFCRELDEFINESBYPROPERTIES('${guid()}',$,$,$,(${obj}),${add(`IFCPROPERTYSET('${guid()}',$,${str(name)},$,(${ps.join(',')}))`)})`); };
    const proxy = (name, type, V, F, hex, props) => { const e = add(`IFCBUILDINGELEMENTPROXY('${guid()}',$,${str(name)},$,${str(type)},${pl},${shape(V, F, hex)},${str(name)},.NOTDEFINED.)`); if (props) pset(e, 'Sollevamento', props); return e; };
    // primitive
    const tube = (a, b, r, seg = 12) => { const ax = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]); let t = Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]; const u = norm(cross(ax, t)), w = cross(ax, u); const V = [], F = [];
      for (let i = 0; i < seg; i++) { const an = i / seg * Math.PI * 2, c = Math.cos(an) * r, s = Math.sin(an) * r; V.push([a[0] + u[0] * c + w[0] * s, a[1] + u[1] * c + w[1] * s, a[2] + u[2] * c + w[2] * s]); V.push([b[0] + u[0] * c + w[0] * s, b[1] + u[1] * c + w[1] * s, b[2] + u[2] * c + w[2] * s]); }
      for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; F.push([2 * i, 2 * j, 2 * i + 1], [2 * j, 2 * j + 1, 2 * i + 1]); }
      const ca = V.length; V.push(a); const cb = V.length; V.push(b); for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; F.push([ca, 2 * j, 2 * i], [cb, 2 * i + 1, 2 * j + 1]); }
      return [V, F]; };
    const prism = (base, h) => { // base: poligono convesso [[x,y,z]...] estruso lungo il vettore h
      const nb = base.length, V = [...base, ...base.map(p => [p[0] + h[0], p[1] + h[1], p[2] + h[2]])], F = [];
      for (let i = 1; i < nb - 1; i++) { F.push([0, i + 1, i]); F.push([nb, nb + i, nb + i + 1]); }
      for (let i = 0; i < nb; i++) { const j = (i + 1) % nb; F.push([i, j, nb + j], [i, nb + j, nb + i]); }
      return [V, F]; };
    const box = (c, sx, sy, sz) => prism([[c[0] - sx / 2, c[1] - sy / 2, c[2] - sz / 2], [c[0] + sx / 2, c[1] - sy / 2, c[2] - sz / 2], [c[0] + sx / 2, c[1] + sy / 2, c[2] - sz / 2], [c[0] - sx / 2, c[1] + sy / 2, c[2] - sz / 2]], [0, 0, sz]);
    const items = [];
    const ax = [d.ax[0], d.ax[1], 0], pv = [-d.ax[1], d.ax[0], 0];
    d.lugs.forEach((l, i) => {
      const L = d.lugL || 0.55, Hh = 0.3, th = 0.035, hole = [l.x, l.y, l.z + 0.16];
      const P = (u, z) => [l.x + ax[0] * u - pv[0] * th / 2, l.y + ax[1] * u - pv[1] * th / 2, l.z + z];
      const [V, F] = prism([P(-L / 2, 0), P(L / 2, 0), P(L * 0.2, Hh), P(-L * 0.2, Hh)], [pv[0] * th, pv[1] * th, 0]);
      items.push(proxy(`Golfare F${i + 1}`, l.type || 'Golfare', V, F, '#e2a900', [['Tiro_t', l.T], ['Carico_t', l.P], ['Tipo', l.type || ''], ['Grillo', l.shackle || ''], ['Trave', l.g || '']]));
      const [V2, F2] = tube(hole, d.hook, d.slingR || 0.03);
      items.push(proxy(`Fune F${i + 1}`, 'Fune di sollevamento', V2, F2, '#1f5fbf', [['Tiro_t', l.T], ['Lunghezza_m', l.Ls], ['Angolo_deg', l.alpha], ['Golfare', `F${i + 1}`]]));
    });
    const [Vh, Fh] = box([d.hook[0], d.hook[1], d.hook[2] + 0.4], 0.6, 0.4, 0.8);
    items.push(proxy('Gancio gru', 'Gancio', Vh, Fh, '#c0392b', [['Quota_m', d.hook[2]], ['Peso_sollevato_t', d.weight]]));
    const s = 0.4, c = d.cog, oct = [[c[0] + s, c[1], c[2]], [c[0] - s, c[1], c[2]], [c[0], c[1] + s, c[2]], [c[0], c[1] - s, c[2]], [c[0], c[1], c[2] + s], [c[0], c[1], c[2] - s]];
    items.push(proxy('COG ' + d.name, 'Baricentro', oct, [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]], '#d62728', [['Peso_t', d.weight], ['X', c[0]], ['Y', c[1]], ['Z', c[2]]]));
    add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',$,$,$,(${items.join(',')}),${site})`);
    return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');\nFILE_NAME(${str(d.name + '_sollevamento.ifc')},'${new Date().toISOString().slice(0, 19)}',(''),(''),'Peso e baricentro','Peso e baricentro','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n` + out.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n';
  }

  // ------------------------------------------------------------------ INSERIMENTO NEL FILE IFC ORIGINALE
  /**
   * Inserisce funi, golfari, gancio e baricentro nel testo IFC originale (IFC2X3 o IFC4).
   * setups: [{name, weight, cog, ax, hook, lugs:[{x,y,z,T,P,Ls,alpha,type,shackle,g}], lugL}] in coordinate del mondo IFC (metri).
   * Un eventuale blocco inserito in precedenza viene sostituito.
   */
  function insertIntoIfc(text, setups) {
    const B0 = '/* PESO-BARICENTRO SOLLEVAMENTO INIZIO */', B1 = '/* PESO-BARICENTRO SOLLEVAMENTO FINE */';
    const i0 = text.indexOf(B0); if (i0 >= 0) { const i1 = text.indexOf(B1, i0); if (i1 > 0) text = text.slice(0, i0) + text.slice(i1 + B1.length); }
    const schema = /FILE_SCHEMA\s*\(\s*\(\s*'IFC4/i.test(text) ? 'IFC4' : 'IFC2X3';
    const first = re => { const m = text.match(re); return m ? '#' + m[1] : null; };
    const owner = first(/#(\d+)\s*=\s*IFCOWNERHISTORY\s*\(/i);
    const body = first(/#(\d+)\s*=\s*IFCGEOMETRICREPRESENTATIONSUBCONTEXT\s*\(\s*'Body'/i) || first(/#(\d+)\s*=\s*IFCGEOMETRICREPRESENTATIONCONTEXT\s*\(/i);
    const cont = first(/#(\d+)\s*=\s*IFCBUILDINGSTOREY\s*\(/i) || first(/#(\d+)\s*=\s*IFCBUILDING\s*\(/i) || first(/#(\d+)\s*=\s*IFCSITE\s*\(/i);
    if (!body || !cont) throw new Error('struttura IFC non riconosciuta (contesto o contenitore spaziale mancante)');
    if (schema === 'IFC2X3' && !owner) throw new Error('IFC2X3 senza IfcOwnerHistory');
    const lu = text.match(/IFCSIUNIT\s*\(\s*\*\s*,\s*\.LENGTHUNIT\.\s*,\s*(\.\w+\.|\$)\s*,\s*\.METRE\.\s*\)/i);
    const scale = !lu ? 1000 : ({'.MILLI.': 1000, '.CENTI.': 100, '.DECI.': 10, '$': 1}[lu[1].toUpperCase()] || 1);
    let maxId = 0; const reId = /#(\d+)\s*=/g; let mm;
    while ((mm = reId.exec(text))) { const v = +mm[1]; if (v > maxId) maxId = v; }
    const out = []; let n = maxId; const add = s => { n++; out.push(`#${n}=${s};`); return `#${n}`; };
    const G64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
    const guid = () => { let g = G64[Math.floor(Math.random() * 4)]; for (let i = 0; i < 21; i++) g += G64[Math.floor(Math.random() * 64)]; return g; };
    const str = v => `'${String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[^\x20-\x7e]/g, ch => { const c = ch.charCodeAt(0); return c < 256 ? `\\X\\${c.toString(16).toUpperCase().padStart(2, '0')}` : `\\X2\\${c.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`; })}'`;
    const OH = schema === 'IFC2X3' ? owner : '$';
    const f = v => (Math.round(v * scale * 10) / 10).toFixed(1);
    const p0 = add('IFCCARTESIANPOINT((0.,0.,0.))'), dz = add('IFCDIRECTION((0.,0.,1.))'), dx = add('IFCDIRECTION((1.,0.,0.))');
    const pl = add(`IFCLOCALPLACEMENT($,${add(`IFCAXIS2PLACEMENT3D(${p0},${dz},${dx})`)})`); // coordinate assolute del mondo
    const styles = {};
    const style = hex => { if (styles[hex]) return styles[hex]; const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
      const col = add(`IFCCOLOURRGB($,${r.toFixed(3)},${g.toFixed(3)},${b.toFixed(3)})`);
      const sh = schema === 'IFC2X3' ? add(`IFCSURFACESTYLESHADING(${col})`) : add(`IFCSURFACESTYLESHADING(${col},0.)`);
      const ss = add(`IFCSURFACESTYLE($,.BOTH.,(${sh}))`);
      return styles[hex] = schema === 'IFC2X3' ? add(`IFCPRESENTATIONSTYLEASSIGNMENT((${ss}))`) : ss; };
    const shape = (V, F, hex) => {
      let item;
      if (schema === 'IFC4') { const pts = add(`IFCCARTESIANPOINTLIST3D((${V.map(v => `(${f(v[0])},${f(v[1])},${f(v[2])})`).join(',')}))`); item = add(`IFCTRIANGULATEDFACESET(${pts},$,.T.,(${F.map(t => `(${t[0] + 1},${t[1] + 1},${t[2] + 1})`).join(',')}),$)`); }
      else { const P = V.map(v => add(`IFCCARTESIANPOINT((${f(v[0])},${f(v[1])},${f(v[2])}))`));
        const faces = F.map(t => add(`IFCFACE((${add(`IFCFACEOUTERBOUND(${add(`IFCPOLYLOOP((${P[t[0]]},${P[t[1]]},${P[t[2]]}))`)},.T.)`)}))`));
        item = add(`IFCFACETEDBREP(${add(`IFCCLOSEDSHELL((${faces.join(',')}))`)})`); }
      add(`IFCSTYLEDITEM(${item},(${style(hex)}),$)`);
      return add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${add(`IFCSHAPEREPRESENTATION(${body},'Body','${schema === 'IFC4' ? 'Tessellation' : 'Brep'}',(${item}))`)}))`);
    };
    const pset = (obj, props) => { const ps = props.map(([k, v]) => add(`IFCPROPERTYSINGLEVALUE(${str(k)},$,${typeof v === 'number' ? `IFCREAL(${v.toFixed(3)})` : `IFCLABEL(${str(v)})`},$)`));
      add(`IFCRELDEFINESBYPROPERTIES('${guid()}',${OH},$,$,(${obj}),${add(`IFCPROPERTYSET('${guid()}',${OH},'PB_Sollevamento',$,(${ps.join(',')}))`)})`); };
    const tail = schema === 'IFC4' ? '.NOTDEFINED.' : '$';
    const proxy = (name, type, V, F, hex, props) => { const e = add(`IFCBUILDINGELEMENTPROXY('${guid()}',${OH},${str(name)},$,${str(type)},${pl},${shape(V, F, hex)},${str(name)},${tail})`); pset(e, props); return e; };
    const geo = solids();
    const items = [];
    setups.forEach(su => {
      const ax = [su.ax[0], su.ax[1], 0], pv = [-su.ax[1], su.ax[0], 0];
      su.lugs.forEach((l, i) => {
        const la = l.dir ? [l.dir[0], l.dir[1], 0] : ax, lp = l.dir ? [-l.dir[1], l.dir[0], 0] : pv;
        const [V, F] = geo.lug(l, la, lp, su.lugL || 0.55);
        items.push(proxy(`${su.name} - Golfare F${i + 1}`, 'PB_GOLFARE', V, F, '#e2a900', [['Sollevamento', su.name], ['Tiro_t', l.T], ['Carico_t', l.P], ['Tipo', l.type || ''], ['Grillo', l.shackle || ''], ['Trave', l.g || '']]));
        const [V2, F2] = geo.tube([l.x, l.y, l.z + 0.16], su.hook, 0.03);
        items.push(proxy(`${su.name} - Fune F${i + 1}`, 'PB_FUNE', V2, F2, '#1f5fbf', [['Sollevamento', su.name], ['Tiro_t', l.T], ['Lunghezza_m', l.Ls], ['Angolo_deg', l.alpha]]));
      });
      const [Vh, Fh] = geo.box([su.hook[0], su.hook[1], su.hook[2] + 0.4], 0.6, 0.4, 0.8);
      items.push(proxy(`${su.name} - Gancio`, 'PB_GANCIO', Vh, Fh, '#c0392b', [['Sollevamento', su.name], ['Quota_m', su.hook[2]], ['Peso_t', su.weight]]));
      const [Vc, Fc] = geo.oct(su.cog, 0.4);
      items.push(proxy(`${su.name} - Baricentro`, 'PB_BARICENTRO', Vc, Fc, '#d62728', [['Sollevamento', su.name], ['Peso_t', su.weight], ['X', su.cog[0]], ['Y', su.cog[1]], ['Z', su.cog[2]]]));
    });
    add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',${OH},'PB_Sollevamento',$,(${items.join(',')}),${cont})`);
    const k = text.lastIndexOf('ENDSEC;'); if (k < 0) throw new Error('file IFC incompleto');
    return {text: text.slice(0, k) + B0 + '\n' + out.join('\n') + '\n' + B1 + '\n' + text.slice(k), added: items.length, schema};
  }
  // solidi elementari (metri, coordinate del mondo)
  function solids() {
    const prism = (base, h) => { const nb = base.length, V = [...base, ...base.map(p => [p[0] + h[0], p[1] + h[1], p[2] + h[2]])], F = [];
      for (let i = 1; i < nb - 1; i++) { F.push([0, i + 1, i]); F.push([nb, nb + i, nb + i + 1]); }
      for (let i = 0; i < nb; i++) { const j = (i + 1) % nb; F.push([i, j, nb + j], [i, nb + j, nb + i]); }
      return [V, F]; };
    const tube = (a, b, r, seg = 10) => { const ax = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]); const t = Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]; const u = norm(cross(ax, t)), w = cross(ax, u);
      const ring = c => Array.from({length: seg}, (_, i) => { const an = i / seg * Math.PI * 2, cc = Math.cos(an) * r, ss = Math.sin(an) * r; return [c[0] + u[0] * cc + w[0] * ss, c[1] + u[1] * cc + w[1] * ss, c[2] + u[2] * cc + w[2] * ss]; });
      return prism(ring(a).reverse(), [b[0] - a[0], b[1] - a[1], b[2] - a[2]]); };
    const box = (c, sx, sy, sz) => prism([[c[0] - sx / 2, c[1] - sy / 2, c[2] - sz / 2], [c[0] + sx / 2, c[1] - sy / 2, c[2] - sz / 2], [c[0] + sx / 2, c[1] + sy / 2, c[2] - sz / 2], [c[0] - sx / 2, c[1] + sy / 2, c[2] - sz / 2]], [0, 0, sz]);
    const lug = (l, ax, pv, L) => { const Hh = 0.3, th = 0.035; const P = (u, z) => [l.x + ax[0] * u - pv[0] * th / 2, l.y + ax[1] * u - pv[1] * th / 2, l.z + z];
      return prism([P(-L / 2, 0), P(L / 2, 0), P(L * 0.2, Hh), P(-L * 0.2, Hh)], [pv[0] * th, pv[1] * th, 0]); };
    const oct = (c, s) => [[[c[0] + s, c[1], c[2]], [c[0] - s, c[1], c[2]], [c[0], c[1] + s, c[2]], [c[0], c[1] - s, c[2]], [c[0], c[1], c[2] + s], [c[0], c[1], c[2] - s]], [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]]];
    return {prism, tube, box, lug, oct};
  }

  const API = {genLift, setSheet, CLIENT_LOGOS, supportSetupMacro, placeSupportsMacro, supportSetup, girderProfile, computeSupports, supportModel, placeSupports, supportReactions, buildSupportSheet, buildLugLayout, buildLugShop, lugCheck, STEELS, LUG_GEO_DEFAULT, silhouette, insertIntoIfc, buildLugSheet, lugIfc, liftModel, placeLugs, slingForces, IFC, toDxfMulti, initIfc, openIfc, meshOf, leaves, volCentroid, bboxOf, buildSheet, toPdf, toDxf, featureEdges, hiddenLine};
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PBDraw = API;
})(typeof window !== 'undefined' ? window : globalThis);
