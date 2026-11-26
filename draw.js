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
  const LOGO_METALSAN = {data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAWIAAACECAIAAAAlVLYGAAAzQElEQVR42u2dd2AUZfrHn/edmZ1tyZZ0QgIEgnQE4aSDBRBFRc+uXFEPxYaoYC9nQbHf2c569o56FlDv1LOBNOk9BAglfWu2THnf9/fH7G42yQZSNoD3ez8gbp+ZnX2/87T3eRFjDDgcDqd1MP8KOBwOlwkOh8NlgsPhcJngcDhcJjgcDpcJDofDZYLD4XCZ4HA4XCY4HA6ni2Tirm+3X/7hmsO2xwv+u2PuZ+v5meNwDhuok8Xaw1/4aU1ZDYQUW5Zt842Tix2WLt3dqa8s/Xp5OVDI6ZX9y5XjS9w2fgo5nKNXJp5avvu6T34FjYLdDAIGbwgIff1PY2YOK+qKHV2xz3v8U99BQxTyHIAA6hqA0nvPOPbOyf35WeRwjkaZGPzCjxu3VIJFApMUe0hAoOpQHZg+vu9nM49P717e9932u95dAU4LZFiAUGAACEDVoDKQ3St72dWT+nCzgsM5emTiiZ/Lb/hoNQgYzBIAAEKAEAAAAsAACENNEMzSV7PGT+mT0/n9OxCMHvuPH2v31EOOHTACygAAGABjAAwQAl8Ywuq8M4c9fNogfjo5nCMsE5tqg5d+tGbF1iqwmkDEYLwvWSYQACDACCIq+CN3zxh2z8n9OrNz76zff9GrSwEhcNmAUgAW22hCJhgARqASqPJ375v39aVj++dm8JPK4RwZmXjql13XfbgKNAIZFkAIUOIDWsgEAGAMjMEBr7VX9sa/jO/lsnZgz85/b/X7322FvEwwiUCYoQ0pZMK4iwE8IWhQFlwy6taT+vHzyuEcVplYtd9/zjsr9uytB4sEkggMDi0TxiMihmAUvOHXrpjwh2O7t32fNlYHB//tG4iokJMBjAEFYHAImTBuUQqVfjE385tZEyaUZPOzy+EcDpl45Icd8z9ZAwiBWYpLA2qrTCAAjIEQqAmeMrr3kotGtmWHHvlx5/wPVkGmGWwyEBoXhTbIhHEgGIM3BMHoDTOGPzZjKD/BHE4XysSvlf6z3llRsaMGMs0gicBYR2QCIcAAgKC+ARD69YaThxU4WtuV2rA66KWfa3ZUQ34mYAw0PvLbJRNGtEInsNdrLXKvvP6kAXmZ/DRzOOmXiZu/3vLw5+sAAdjkJsO+AzJhvFLAEFHBE54zfciTU1JUOny4percF38CswgOS5IR0SGZAADGAGPwhSAYveyUwS9dOJKfaQ4nbTLxXXnd5R+uLt/rAYsEIgaGYqO9kzJhvIwy8IRyilzL/zi6l7OxXvOcD39d9NNOyLKBJABLNiI6IRNGbQWlUOm3Fbr/e+WEEcVufr45nM7KxC1LNi1cvB4wAospSRTSJBPGQyICXwR84S/mTTm1Z9b+BqX7fYsBGGTZgEG8LCJNMgFJ0YrahqvOH/nMOcP5KedwoGNTv74uq817YPHCT9aAWQKLqQs3SBk4LJBtn794IwD8vNcLUQ2y7XEt6AIIhUwL9M5+9rO1wjXv/HdnLT/rHE67ZWLmJ5umPvZlTaUXnFbACLp65Q7GINNSICAA6G6XwW6KGRFdukUGUOikjJ5w978uenNVfVTn557DaatM/Hflujf/9ROYnWAzw2Fb2odQkATDtoDDtpwQYZBhhuysdxatWPDmZ/zcczhtlQmXHrgle1s/sweIFZhwGEft4QUBMICwaLXod4yOzsjna51xOG2WCT8RLIxeY9l2qmUXIAGY/D+oFAhAQ6AIo7Ijz5XUDbLSiNnBzz2H01aZEDDyMJOPms6W9lxt3QJYBWr5X9OIKAIKl/UK3V8SMEtSJdgEzLv7cTjtCWFiYArgPdQ2WPAusG3qJ3tBtwDFv3mzwnA0gshsY08MDl9SoFZRSxDJZknAgsDPPYfTvoQoQoAxOgAZDgFuyCw/zXEAGAYi/YaVAgGoABEY1Y29PkQ73on2EgsTJbMkSZJJ4jLB4bQZEQAQQgLGGAsYYy+WbBgud1SXWrQn6/NBlUDWf5MaEWKA4NJ+cFUP4lXFclUySWBUZEmSxK0JDqcdMoEQEgRBEERDKAQkEAHvYuZx9kiprfKZ2uzNPhlMDET2mxEIChCkNqewcBCe6Ka7w0KUgUWCpGwsFUWRn3sOp60ygRESJUkURYxjFgUSMMbCASYXmOijPb0v1WV+dMACBIGZHe0uCAJQGETpyCLpoaFigQl2hAAEkAVI9p4opQK3JjicdlgTGEuiKAiCIAg4LhXGHw8y6YDmFinDnPjOMhkaAGxHuaNBgMJ1wy3XlkpeFXYqTGpiNLC4TDAuExxOu6wJLAiiKEpYwEJCI+I3VIz36sKUbCh1kPt3CBsPELBhkNDR6Gj4NHCbXv5dxsm5wt4Ia6DMbEooA4tNBEMADChjPDbB4bRHJgQsSaIoibEYJsaCEDMnYvaFIOzWcC+78M8RwqNl4nvbVdApWPHR4oAgAIVCg/67EtuTx2eW2PDWAKXAzFJCFhrFAuLzTEVeN8HhtEMmMBYlURRELCABN/kT0wtBELBQqWGXIDw+TByRI89bGQK/BpkSHHGrAiMIakDYNaPdtw3NiOqwNaSLYlNLgQFDkDxdhVFuTXA47bUmREmUhIT5EDciEjph3MRRELZHhJkl8pBcy/W/BLbsDUGGaMzgOmKORn0U3PIr43PP72XZFSR+jZqN5YWSTIiYy4Ea7QnGgMcmOJz2xSYkSZJisYmmzobQ1KzAAhbwtogwxG365nT73GWe99Z5QAawSV0+E7y5RiBQCDQoQ0sc/zwpf7BTWu/VGGBzTLOSfQwGjR11Eg8gLhMcTvudDlE0tABjQcDYMC0a/8MCFgUBC4KIBSzsDrMsmb06IXt8vvma76vBq4DTBIfT0fCroOhXjyt4dExeSGPr/Zoois3a9THGEEIx46GZC4K4NcHhtEcmBGw4HaLQzHwwzAkhFtIUxVi6FBgTEHgU0qDTP5Xa+ru6X/lj3Y5yP2SZwSwC7WJHAwCqguCyvj2j5MK+jv0NmlehFqO+MhaxbCoKjKX6GMSnfnE47YpNCIbT0UQasNB4QxREQUAII9Q46jACjbINXvU4t+m7GcU/Rx3n/3MlRMLgtsf6YneFEaHqUBU8Z9IxD43P721H5R5Vo9gs4RZxiKZlEk28D4gVp3NrgsNpl9MhSZIkiQkXA8edjIRUIIQYa35hRgAmUdzs16x64NzBBec9PqPfcz9vW7cLCl3xPGT6EDB4ghDVvr1l2gklWdDg2VbtNwmCLACg2BIi8RLRxiZ98YRoY2LU+AchJAjcmuBw2uV0SJIoSs3sCEEQBSEhEM0HPcYIYxyNqtFoJEjof5aumjx62NbZYxf8UHD7u8sh2w6yCGlpmWd06z7gdXZzrpw9oY/bBgC7vRGLScIYNTEcWpoRrMUdAGCAMObWBIfTAWtCSoQhEkZFa769IAiUsmCwIRpVRFG0mmVBsH2zatOI3oW3Tegzvpd7wsNfg1UEp7WzGRCMQCFQGzhtbJ/PL/5d4mGrbCKEIEMmkrbAUmkEavE4ppTXTXA47a3ClIxMhxGGOIhAGFHMaDTa0BBijJlkkySKhgHicjq2VPtzg+vHDxjAnjqvx6PfVFTUQr4TUEcnjGEEvjA0KO/NnnTe4G7Jz0iShDBCCEFzcwIxaLk5lrwcCQOGKA9hcjgdqJswSWJSGCL1S0WREOL3B6LRqCiKsizHfZOYAWI3mRoYbN20tV//PntuOunGr7Y+/tlayMsAUehIRqM6YHVa18yf2jfL1mJPBIQAIcSaxSrjQpDKumi8TxnFmFsTHE57rAmTSTJJUmthCMbAUIFwOBIMBimjsiwnTSpNxDIEQRBMWEAC3rqjol9x7mNT+53aN/fkx74GpxkyrW3NgCAEGoEq/++G9Vh++djUdgbGCCGEEEtVaZlcX5XSkmGU8RAmh9OuEKYgimJysrMZJpOk67rH44lEFUkULbIlIQqNCoFxUmJEkE2mXTWB/EztpF457OkLsu5f4qn0Q37moasqBAz+CPjCb18x8cIhha3utCgxlmKFD3YI6yLunGCGudPB4bSrexVA6qSEIAgIoVAoFAwGCaFmsyyKkoCx4WfgeM1Vkj40TgqRJMmrUrWu1pGdU3/HtGu+2PjMV5sgzwECTr0xY8HRKr/ksPx6z+mDcuwH22lJbD76WXN1SH6kaYYUGOPWBIfTHplgrRj+oijpuu7z+cPhsCRJFoslyXpojEdgoz1ek1ljidoLgSDk8XjcbvfTpw2a2CvrvOd/BJcVbKbmdgBGoFGo8vUtzVt95Xj7oaaTdSwAyRhfwofDgY531k4eS4IgSKIpGAxWVVVHIhGLxWw2mwVREERBFIVYTiTud4i4iQMSj1c0ziKTJFMwGAQg5w4o2H//GQ4AqGsAHFuqHMUmg0ehLvjMzFHbrp1kb8OUU8YYpSwlBw16NIGfew6nHZ21kweSyWRSVbWuvt4wIsyyOTbjSxCFhBURmxvW1IxItLyK/w8lmmsiHI1qZhm6ZZjLb5k6/d1VyzYdIHbZkAioD6Es26r5U4fnZ7ZxpwkhjDGAQwz21p7mSsHhdEQmGGOSJGGM/IGA1+NljFosFjHRhaK5tdA0HtHYoyL5BsbYkAqEMUYI64SJAnObpaV/Gj1r8aZvyusAYHl1UHLZ1PvPbNdOU0pjhkPSUEdtyqKgRK6EF2JyOG0EVVfX7Cwvt9lskUjE4/FGIhGTSZJluUn6QmiS9UwlE412RCNxjTDyl8a/xlYVnciiAADVITXP1u5J6OFwBIC1Yg4gQIeQDAYgCqIk8R78HE5bO2sjURQ9Hq/X62EMLBZLPPpgzOo4qEAkApbJ/kZcITDCKG5KJDILhBBVVS0CABFAMHVAI2KlD5Q2llc1sSZaczSahjYQauZwcTicVmVCUZSd5eUCFmRZlmUZY2yoRCKf0awyonlaI8nPSLYiko2IRJGCruuqpumaFgpruqopmlpYUCBKUnt3mlBKCUUohdkQb1OFUgsGaj7ZnMPhHFomuhcW5ufm1tXXS5KUbD6IsckauKkVkTpg2SQckRSPEASEUEwjNE1TVU3TdU1TdUI0Xa+trZMkU7eC/I7YEpSmdjpQaw8kTydlhFJ+7jmcdoQwJ02aWFa2c8u2bSaQmuU72+JoIJx4JEkh4taEYeSrmqZpmq5pqqYRQhRF9Xp94VC4YwECQiihpJlMHNzpMB6OGxOMUW5QcDjtzHT06dM7Jzdn5arVhOiG63HwgGVj1BI1SWqgJlqBAIBSajgamqarmkoJDUciXq9X0zRRElGHevhTSikhCTulpT6gg4oFpczEuDXB4bS/bsKRmTl+7JgdZeX+gN9qsRiriraIRjTGIQQhOQjRzIzAxpWeEKLFBULXdaKThoaQz++jlIqiqGlax3aaEEIIRZilSHIc1I4w/k8ppdya4HA6Vl4ly/Kggf0r9u6rq6tDCImJORvxZTsM26Fl5jOR2GgesFQ1XTcsCU3XSSAQCAQCAJ1tbE0pJZRihlokM1irwQrU1BihhJ97DqcjMmFQXNQ9y+3evWcPMCaITaoimuc1EG7pb0A8YBkPR2g60TVV83i94XA4WUc6DKGUEJ017RmBUkpCqhdQSnmug8PplEwAgM1m7du3tKqyStU0SRIbExkCFrAQD0egpLopbDTOBADGWDxYqauaRimJRqIer1dRFGPKaed3WlPVFgO99XJMw8hI2i6llPJMB4fTSZkAAEkUi4q6e7zeUCgsJBsRQlMjIu5rNCY11ETIUiOEhMMRr8er6Zoopq2cyWa3eeo9YJKa2w+o1ewoalz3CwjjMsHhpEMmDNwul81q9QcCCKN4aCJJG3As0xH3BYimxvOeOiGEBAMBn9/PGGtNIzrWJzMnO9tsNu/du8+oFGWH6svdTD8IIYxnOjicdMkEAMiynOV2h0JhAEjUSSRnNeJjT1fVWFKD6ETXdZ/fHwwGD7J2TqoGVG0lw24vKelVUbE3oigmSQLGAKGDFluhxCodlPDgBIeTVpkwEhOZmRmqquo6QU1LLZsELHVdVVVKqKKqXq83HAoJopgyGGEM0k72iTHLct/SPrt27wkEAiZJSi0TCLVUEEIJ404Hh5NemYBYU0yTIBBKaaLG0hjwmqYaGqFpGiEkEol6PB5VVVubrMFYvAMdo6zTq4P16tmjvr5+954KSZLalGdFiPBUB4fTRTJhmBWGBRGvsGSa1pj6JISGQiGv16vrespgRJIRwRhjhLG0rCGYlZVltli2bduhqqosyy2NlGYWDSWEhzA5HOhwk7u2dHZJjDpNVRRVVVVV1TSiE7/fX1dXRwhpTSMYS2gEpZRRSlma1hq1Wa3Dhw01WyzhcJi2gCRh3OFVmBxOF8qEwaINB55eViabzTKQiKrpulbv8Xi93pQByySBoMyY3UkNpaDpbWM7aED/wm7dGkIhTdOMSs0UkkEpITw2weF0mdNhcNrryxd/sxns5n2+0EOTemZgUlZVp0QjKaun4o4GBWCUQnJ7W0po2vOS3bsX2my2zVu2IIQlk5TCWEHAYxMcThfKxIFAtPD+LyAQgZ7ZoOgLF21YdsD38ugs0KItHY1mkQijFTYkNcWmlDBI/1Xd5XKOOO64X9esjYTDsiy3fAHl1gSH00VOx6urKwpv+gCiGuRlAmUgC5Bt/2FL7dbaBpfFlMrRMDrix70MIxrRaPwTPdYgO/3Ismn0qN/l5+f7A0Fd15uFJ3RCCOMyweGk25o4783lH3y9CfIzwWwCygBQzJ53mDNkQacsRb4TKGPQ1Igw/okFJiihXSQTBn1L+zgyM9dv2CCIoslkYowBA4SAEsoIlwkOJ30ysa7Sf+yCxRDVoIcbAICy1nq+NPMyEivsxPIajEHshmFWsMOQccjLyx2bMXr5ilUNwQaLxQKJdhU808HhpMvpeOL77cfe8QkAQL4DUtZWI0CA4haEEaqMiQJN2AzEkAdCjF63saQk0Yl+GOZWWK3WEyZNyMvNbWgIEqJTSgjlczo4nDRZE1P+8f2/v98BRS4wCamNCMYAgYCA0FZDldR4oGkalFJCKNV1/bD1pBw2bKjT6Vi/cZNskgxXiJ97DqdTMrFqn3fkA4tBUaEkG4ABTT2xKtYzLhaJYEaeMZHubJQJGvM1YgqRiGLq6cyIbq4K/FBeW+ELD8p3nNw3L9fePMfRq1fPzMzMpct+UVUNtUEmttcEvy+va1A0u9k0roe7f4u1C5eW1wVUHUEHe2jolGXZTMcXu5s9vq02uKsuxAAE3IXLF+qE5WbII4pciUe+3FRJMRLTsVFKWYZZLHZai1zWFGeqOrDXE2aAjClBOqFOq2lMz6z0HuD+/Qc0XQdgXfQlapqek5PtcDiSH9xRttOUvmWiGANJkgoLu7X2gpqa2l+WL2eU2TPs+Xl5AwcO6PxGd5aXC4KAkvYBCzjFIT3yzdb5bywDuwzdXEAYHGqdTgEoZUAa85ysMUxpeB4kXkpllEnHipyorutpiU18trX63Ie/VFQNAEAWIaSCgOecNezJc46D5mXd7tOnn/rF4i8rq6oHDRp4kM887dnvF3+7BSQBJAyEAoX83jn/vu6kQbkZxgu+2Fw5/Z5PIdcOGEMHDgIBUAZhlb3yp2bPDLntI1UUwCRCF5tapTkZ2++abtx+bmn5Vc9+C257GhYxMX4wDQpQhk3ijacNefjMocnPD7zvCwhFINMCFAABEAohdf2Cswd3c6TluPyBwAMPPOj3+41VILvo21MUZeyYMZdd9ufEI2VlZXfeebfT6UzX8rSGXU4ZnXzSSeedd06zZ7/6+t/vvPseo1SSJEopwtjtcv3xDzMP/sM+OGvWrn322ecTLaZSWxOeiDb26W+3rtgNPbNAEoDQQy3NyWQECJhuCELCnmh0MFgT+yEeqzBuqKoajUY6+VUeCETPuHURFDjAbY1NFnfbgdC/vbvy4y1Ve+48LYUEnHpKZVVVax+41xcuvuUj8IWhV1aikw0AVO3zDL7hPfbm5cZdk4AhLxMkDJ35TcgpZLpXn9xtNcHDYEkW5dgTt90WCRwWEDGk6+LrsgIAJfSR15c+u3xXw4IZiWeyC511+ymI8WpdjMBlTZdGAMAtt97eEAxmZ2d3aR6NUup2N7EEJclkrImV3lWsdV1//4MP1q1f/8D99yYeXL9+wzPPPNejR7EkScZhIoQCweD9Cx78w8xLTp12SgcDeRarLJua1UmaTKZGrf2xvC7rune2bq+C0lwQcNsuZUgHoI2xylhphBGqjM2f0EnTmgWd6IQSqqmaPxDIsGd08kt8ftVusElguBgsYSch6J1TsbMaXfba9tqGlu8qyE+9htBHG/YXz34LKIUeWc1DtjmZoOi/VHiMezGPAKFO/RVw6kVQMe7sJ7fhL0ryL2JmZtq3IgpQkhOqqFu629M4nFIeXbp8zy1bGoLB3Nzc5KXnuwKjPVOzns1GG7f0IklSjx49du/evXHT5sS2Pv3si6Ki7gmNMEwPm9Wan5f3zjvvPf30Mx00BFs50tjV7PYvNix44xfIsYNdBkLbftrMAMAoIYbTEbMpDGuBJZVTxSwIYqQ9WDQaraurP+f3Z/XoUdzJn8UeXxhyMlOIGqGQ5wBf+Jjr311087SzhxQe+ir0r3UL31kOORlgkaBlYQVl4Lbu90WgOG5NJIMRaAT8EQDW1m+PMYjoLR8u31kD+FAjBwHoFADAYUk2eWJ7EogAYSAdwhuqOOBr9TmMIKpBVEspZIfAIoEgNDovjEG2/fMd1WN6ug+DieSp92RmZibPAMYIEUq9Xi+hFKdPjyKRSGVl5UFegDFWVTUcDkM7o1eUUqvVKsty4iiM7g1KNJp0/pnZbG420ZkxhjHOyclesXLVzbfcetuttzQLnXQ8hLmlJjhi4ZJwdQCKnCAI7fWHBQTAGKGGOMRcjHhiI8nbILE/jLFQOBSNRn9/9oySkl5pOABJBEpT/5oJBYcFZPH393567cWj/37WsQf5nNFP/OeXpWVQ5D6YJWUS9bh8iM22qOjOnIy7zhquEaZR2pZfBSVUTuU5P/nncat21ckW08G91kxZ8qnaCz/uANR0JWVVv3BSvx4Oqy+iHuTnSRgbmJvZ6gZU0rNH9pmluYQyjFAb48wyRg2K/sa6veGQAk2vtLJ8mBZ2Npmaf2+arsuyfMnFF8lmMyUkjSHMXr16Hjx4UVxcNHToUE3TGDuk/x4fUBgrqrpmzVqv15s8AYIxSJ55IJlMKZshGMZFTk5Ofb1nzvU33n3X7b16pWOU/brfF95WDYVOkAQg7fbldABCiQCMkEZ5iFVPNTUjCCGMsVAoFIlELrnowpycnPScLpTim4ZgFAAgwwyEgixCj6ynPlq9dp/nh2tPTGGm1gQH3vExRDQoyYkZEYRCSIEMM2DU5IJMWSIG3NzvVbRRha65E0o7f0CzR5fA6JI2vviFb7aCiEFEjb+msPbItEGFDkundiIQuXVMn1mjO/ILI7L40tcbQZYO0vKjC2mxIUVRHQ7H5Mknw+FF07QB/QdMnTK5A+/Nz89/4YUXnU5n8mEdPNSCMY5EIoIgGBFNh8MRDodvve3Oq6+6cvz4cZ08FnzxsKI9b15uddtgd13z61IbkBAYVRDEmKGtE0qIToxumJoRitB1Xdd0Sqjf5w/4A5dd+ue0aURKwsr540qteQ6oCYCAgQFgBAWOH5fuzLz1o6oGJfm1n2zYP3DuewAA3ZxAKGAEqg6+yF9OGezOd4DW5osPxhFyJJYIMgnNhVIWK7zhzkfZ/UoH12SzSgJgBEcNCKEj0oXIcDo6/N725mgQQieddCJCKBKJGIdssVhycrJffPHlN958Kw1VmMVOS+jBs/8wbQjs9oCitescY2CMEJ3olBBdJ4QQXTf+6oQQQyCMyVd1dfWSJMy+clZmRkbXnh9P6KrRJaG7p0sZFtjnjSkFZVDsDlYHCma/ub7Sb7zwxk/WnnX3p5BtB6cVCI2ZIft9K+4944Wzh6lV/nYlr3LMJvgfosMDXSMUjiKVAMaYyST9tr78DjhHgUDg92efNX/ejeFI2Fg3izEmSZI7y/3ll18teGhheoq1X5s56pM7TgNPCOpDbQ1cIUQY6KRJQkOPGRPEEAiDmpqa3LycK2bNyuhqjQAAk/D1tmoAUP9+waTjS6CsJmYmEArZdsg0D7110SM/7Jj+2rLHP1gFJdmxGlOMoNIHir7h6QtHFrkBoKE+BEKbf++i4Ff0/yWVyJA7OLRsZikWXj06EATBZJKPwFCn1CR38MrRMjx5SIwpS927d3/80UcopXV1dYZSIITy8/O3b9v+l1lX7tq9Ow1VmGcO6rbtsfOOe+TrhgM+yHcAOlQPOgZmBIgSjVCdJGczYn+MvKjH4ynsVnjxRRccpvPjtu+vjMXwv7vuxIf65d/6+lLIMEOGBSgFmwyyNP/lH0EWodAZi1YigAO+XqV5K+edkmWND49sO9A2XxjN0rdbDmTe9AF0JlZX33DnBcfPm9T3yI+tTPODP5dtrglQYBjaGsLECFySuGhbJXRujdj0Yjabamtrr5sz12KxmFqJ/HWMmpra6+dc21rtoyRJmzdvMUkmVVPbHsJEgERR3L5ju81ma68abtmytX//fllZWS88/9zjT/xtxYqV+fl5GGNKaVZWVjDYcNdd99x4w9xjjx3a2WLtvtn24MKzJ//jh/8sLYP8TBDFg6+lIQAzghFET9II0qgZlVVVI0eMmHbKlMN4+cAoaazeMmXAuNLc8Xf/C6Ia5GbGLIucjFiOEyNQCVTUz5g+9ONLxzb9bjCotO2mLWEsCAg6bFMgBIpWE1KOirFlEvdU1P19RyW0t4qRMTBLIHd5CWm79ogxakQKOhwsgFZyogf5QFmW9+7du23btvaGb42wQnsNima+1Q1z53zw4aJFiz7KysoyPiojwy7LpoUPP3LGGadfeMH5aZjT8e8rJ7wyvPiyv/8H3HZwWKC17gwIUQZ6PB4Rq6miVCc6o0zTtOrqmokTJ5wwacLhtfZYY4UfAACM65Xtef4PPe77PLijGnpkGVHjWE7EFwZf5N07Tz9/WFGKz+lcjL3dP2eMXeajw4umDEwimMSOv/2o8qC6LM9ykDUfKKWiKGZmZnbYZ+lkQOncc34/oH//Rx97PKooToeDUipJUl5e3pIlX1ZWVt0wd04aJpJf+rue6x45FyiDSj9g1Noq3zJioCdHIXRN14hOIpGI1+s98cSJh1sjkltfJOGySIEFZ82/eBTsqY9VDRnBCECbn7oghUZ0fNOdu0Bp5GgZW5R1cH7HEZUIXdO6KA7agdLvDr+ro55R820NHDhg4UMPZrndtbV1CcXMzs5ev379dXPmVlVVp2Ei+ZACB3v6wtF///aXVbuguxsEnOJ3w4DouqbpOqFUpzrVGaWKonm8nrNmnDl0yOCj6qqycMaxY/vknnn/F2CVIKINGlq04ZZTIK2XLasAAsYgoI6MFrPktBwd1gRGEmNmBmCR2iEWCECnUcK0VEp9uCIRMdJrjESjUUIIQqjtw94oc5YkSRTFdr0rGo1SStOVx83NzXl44YPPPPPcz0uX5uTkCILAGMvKygoEg/NvvuX222495pi+aehetey6E5/5aec1z39vpAmalGAhYIxpuqbrRNepUUDV0NBQV1d3xay/9OrVE44+zhjUbf8LM/ve8fGZJ/R7a+aoNJswAn7v8vHTS3Pht04w+tdzR9564jEdeOsfP1n3+vdbO1LlnQ6GDx82fPiwrvjkL75Y8tnnX1gsbRUgVVVPPvmkGWee0YFt/bx06RtvvJXot9Z5rr569qBBA59/4UWHw2G1WimlmRkZisl0z1/vm3nJxaeeekpi3cyOt8y9elzvn+4/E3QK1f6mVRUIA6W6pmm6pmuEEJ/PpyjKrFmXH50aYdAt09zw9wvTrBFxpfhf0AgAiKq59g4m8zKsJiAE/uewWCyqqrRrZqdZ7qBRY7PZFSXNweyJEyfcfdedmqZ5vV4j/WEymXJzc956++1/PP9C7PfbSmeZtkr+2B5Z7KkLevXKhf3exnAdQoyx2MqAOvH5fH6//+qrZpeko4z8N0lEW1rp/03uOWteBrg/0ME5/lFFa3c097fQTCwUCrWrMtJwHw7PttrIMcf0fenF53Nzc2tqaoywLsY4Ly9v6dJl8+bfAgADBvRPKU/t25Xym6fecd5I2FMPEdWYxcgY0zWNEFJbV6soyu233ep0Ov6fagRlEFbHFPwmD1/RKegEtMa/0Q6XSKH2K5QkHP1fkdPlbHc8sqMJlmbtF4yCZpImG+2hBx+YOmVKVVWVoihGCVZOTk59ff1f77v/i8VLzKn6ZbQ743Xf1AGTeuec/OQ3ENXA5cLAiK5XVddn5ebOufYa+P8MRpBpvvaTtZmyVB1SZAGzNH1qIKRM6J17+agutNFyM80Q0cAix37ZlMldViLFWh6hICz4blu+WQSMAXcmVyIWmiJFNBBOX2s7BEjXdUmStm/fYbVaD89PSTJJkiQlz3Y1mUxC+s7IJZdcVFTU/fU33lRV1Zh373K5qiqrPv30M7vd3jJ02pHE+El9cryP/j7/4a+Usjqt1FRVVVXQrXj2VbPh/zkIgYSf/nQtAAOLKZ21A4SuKKvtUpmYXJrLXr/s8HxPqta0oQlGoGq3L1oNsth8Sm67sR7HdpxFt9UhG6R1EpfhPjQreeq6GWWjRx0/etTxXXoWJk6cMGTI4Hvve6C2ttbtdjPGjPRQyoPqYP2M0yxF75o+d8n2Jxct7jmm9/mXXg6cWOsaW/o/ViPFvXP+Z74ki4xB0ZrUbiEERl0ZS8OQRunukmtE+5oNIYSQLJsaQqHf7olwuVxPPP7o2++8u3jxEofDKcumll6VIAgNDQ2dCpM8Ma3vstvOP8IaodPmU1olAVSSnjmSqLl5TOL5YMoYHLYeCrj1GvCW+4CQfmSLIPUWXYKMeXdxLj22CPb6gMFRNZG0Ay0qdV0v7dP7t67aF114wbx5N0YiYZ/P16xiFSEUCATsdltnewqNKik4sgcZBgBPCJxJTqOnQRhenIaPDqlAaWN0jQF4Qtb4NTAQ1aEhChmHZephILq7IUXMfL8/AsEISAKIuHEn60M2k3gEz8h+VQdfGDIsjbaBL8ySyufvnTxgzR7P5//eBLIIDkvqsr0OKjtViRLWIwoWuqhfrjGKIpFIOBy59NI/JndO0VoUgAYCXdX6eN++fS03F4l0MLEydMiQxx59+OVX/rlp02aMsSAIsixrmq4oUb8/8Nd77hJ/61p44cBuZgY4qSU09YT/Mi4NXaQumzaYqQQlPpkB9UeOLYo1FJrWP//Ppx+LETQO0a5zZQKR00f0bPl4ocPy58mDkCSgRPcqnVKNDO/uPIJn5P7xpQWEYZscS6MxoIRObroMx2eXj9t3zvBf9/q+qKjXNILT9B1SIgy15I0WhnhJVzXGMdbOdjmdubm5zbo0ulyuCePH22xWhDAAKEp00OBBXfQlX3D+ecFgMPnKzxjrTOt9l8t104037NhRtmnz5srKytraOovFkp2VNXHShIKCAsT4+lccDqcza4hyOBwOlwkOh8NlgsPhcJngcDhcJjgcDpcJDqcpc66/4f4HFnT47XNvuOnxJ/6WuPvAgofmzb/FWKO8S/n++x/OPe+CRR99fMS/wG+//e6cc8//9rv/HvxlH3/y6UWX/GHxki+5THB+ezAG27Zth04UQW3evHn37j3G3WAwWFZWtmdPRVfvdvfu3adOnRLtaJlTGundp/fkySfX1tQc/GWDBg6YMH5cQ0MDdLJ7FYfTdaxe/WtFxV6d6G63e8jgwTk52YliIYfD8f77HxZ0Kxg/rrHj+YaNG4OB4Jgxo1euWlVf7zllamPH9q1bt23fvuOMM6YDgK7rdrt9yZIvzz77rLy8XIRQbm7uylWrQ+HQ6FGj1q5dt2fPnjOT+kqtWbtuz+7dM2acCY3N9Wt27dpNKR09Ota+6L/f/+D1+iRJ7FFcPLiVuqnevUsqKipOOGFS4pGdO8vLy8sbQiGXyzWgfz9jqfSUbN68ZUdZmapqdrutqKhoUFJf/8qqqs2btwQCAbPZfMwxfZv1c1m27JfqmhpKSc8ePROdu3oUF/fp0+ekE09IvOy7/37v9/t1TcvOzunf/5i8vDwAKC3ts6ei4uSTTkzejbKdO4muZzocgwYOzMvL5TLBOZLccefdu3fvNskyRsjr9SmKsvChBfFlLxhj7MuvvjrrrBkQ7zH34aJFgUCgT58+Y8aMXrx4ic/nDwYC5557jmEvLHjwoaysLEMmjPevWr166tTJALkIgdls/ve//22320aPGvXe+x9UV1c7HI5JkyYCQEVFxRNPPOl0OhMy8eBDD2/ZskUURUVVR48e5fF451w/V1EUi8USjUY1TR87dsyNN1zf8oj+8823L7308o8//XzXnbcDwD9ffX3JkiWMsYyMjIaGBl3XZ826/JSpU1u+8YEFD65Zs9Zmsxkb1TVtyuTJl176JwDYtGnzvffdryiKw+FQVZVSOnXqlEv//CfjjX+ZNdvjqTcmdzY0NHTr1u3JJx6TZfnTTz9/+5131q1bf8PcOZFI5Mab5tfXeywWsyiKqqoqivr4Yw8XFha+9tob//nmm7Vr191041wAeP75lxZ/ucQsy2bZrKiKKIp33XlH376lXCY4R4Z3331/586dw4cNmzfvRgCorqn561/v+8fzLzz19ycNryEcjtx22y3G3Kqfly579rl/dO9eOG7cOONKbrFYfT6/3Z6RWHZcEIRE8TJjTFGU+fNvKikpAQBZNldU7L3m6qvGjRsL8VXLE+vl+Px+i6VxBso9f71v06bNeXm5I0YcV1paCgDPPPscpXTeTTeOHDkCAF586eUPPviwd++Sln0urVar2WwOBoMAUFa28+OPPxl1/O9mXfGX7KysdevXP/XUM2+//e7IESOzstwtvCQ86y+XT5kyGQBqa+seWvjwV19/bcjEw48+lpGRcfvttw4ZPHjv3n1/f+rpTz/9fOyYMccc0/eRRx6tq6s977xzjXU3Xnr5lX/967MXX3zlmmtmFxTky7Ls9XgAYOOmzcVFRdfPua5v31IAWL58xWNPPPn+B4vmXn9dYfdCSZIagg0AsH7Dhs8+/2z48OFXzLq8sLBwyZdfvfHGm489/sTz/3iWywTnyGDPsDPGamtrf/r55969exfk5z/7zFNNFy3BTkdskYsPPvgwI8N+1VWzE73aQ4Y7jRJLOGGjERMk9XFJtKI0LqH5+XnGXZvVmjxnPfYylnBethYVdb/1lvnGtK59+/btKCvLz883NAIA+vXr53K5fvzxp5TtcI2FcwBgz549drutb9/S7KwsABg6ZEhWVtb+/fv37dvXUiZuu/Vm40ZZ2c7Nm7dQSowWODt3lvv9/tOnnzZk8GAAKCrq/sjDDzV6NOW7cnJyEmvzXH7ZpZdfdmnyAsv2DDsAjBxx3MgRxwFAXV3d/v0HVq1a7YqvdW50/c7KdgPAiuUrBUG85OKLCgsLAWDaKVM3bty4YsXK9es3cJngHBmmn3YqpXTJki8feeQxjIWMDPvIkSPOO/ccw2fWdT25v4Ou6263O3k9B4vVGo5EErMkm/VlMzrlJ9o6MsYwxoqiNj6dWNIJwBAXw24v37VLEMRu3QoSUz9VVcMIMcb+9OfLrFYrYywSidhstkAg0NqhRaMKALiz3CaTXFNbC0nLBQKAKKUYdMuWLX/zrbcCgaDZbLbb7SaTbMhEdU1NdlZWypV3q6qqIpFIQbfUU7Q1XYOkOaPvvvf+kiVfaZrqcDpzs7NNJpMkiYljl0ST4bNYrVans3He4DF9j/nxx5/9fj+XCc4R44zTp59x+vSdO3eWl+9eunTpmjVrV61a/dqrrwCA1WpRVVUUxcQAwxjvKCsr7dMnPmtbDQQCPXrEOgZkZmYmr4JDCMEYi/HZ64ZqGKM00SrCbrfHjAu7DSFEGTNEQZZNxhTP+PVWCIVCxcXFN8+f1xBq6F1SAm1c/o0BpUTAQrKhgRDCLVqEbNy46aGFC4877rj582/qUVwMADfcOM8fCACA0+kIBoOqkmIJQlGUACDUEGplsiwFAGPMP/eP5xcv/vKq2VeOGvU7l8vl9XqvuXaOIcTAgDFgQAEAC5gQEok0tkquqa0VRcFsNvOEKOfI8PIrr866Yvava9b07t178uST7r77TqfTSSndUbbTMIYBWOynDKAoCqU0ee25LLe7qqra5/UlPAVd1xPdqI0GszTensfv9wuCkOhzLYliOBzef+CAcbe2tjYUChnPMkqbdakqLi7GglBZWSnLJkMj6urrv/nm27Vr10Ga1vvbsHEjQmjq1CmGRlRX1/j9fuNQB/TvTwjZsHFjonXFylW/vvTSK9u2b8/OznK5XJWVldu2b4/bF9Vvvf3Ox//6l2EcMcYM92fz5i1ut2vkyBEul8uIQfj9gfz8fABQVQWAhUMhw3ZQlOgPP/5ofNqBAwfWrFkjm809e/bk1gTnyHDssUM+++zzp59+trS0T69everq6g4cqHQ5nUbMsq62VtP1x5/427Rpp0yaOIEQ0myh4GmnTvv2u/8+/8KLPy9d5na5l69YHggEZs68JG72RwVBePSxx+fNu7F3SUltbS1C6KVXXunTp89111x9wQXnrVi58tVXX1u/br3T5Vy6dJk/EJhz3bXG2FAUpa6uLnlXr5p9xWOPPzn3hnmDBw9SlOiaX9cGGoJ/e+KxlgcVDoUVRampqTVa1yiKUu+pTzxb7/EoiqK0MA3Gjhnz7rvvv/XW26tWrlQ1fe3atR6P98orZsW8s+mnLVr00XVzrh/Qv191Te2uXbtEUZxx1pkAcN2119w0b/4999xbWlpqs9nWrl174EDlo48sNLRMUdTt27cDwAknnPDOO+/ed/8DpaWllZWV5bt2Wa3WqVOmGE6Nqqr79lcCwNSpkz9ctOjTTz9ftWp1nz69V61a7fP5Zs68JCcnW7jnnnv4T5Zz+OlWUNC/fz+ik1279uzatcvv98+YcfoN8Sxjt27dMBLC4ZDdZh84cMC+vfuyc7JPO3Va4u0up/P4UcebZXnTps0HKvcPHDDwj3+YOW7sGOPZou7dGTCPx9e9sLBnzx4jRhwXjUaJpofD4RNOmORwOEaMGGEySevXb6yo2DtixIiZl1xsVBwEg8FAMDhwwICBSWULPXv0GDRwoNfn3bNnTzgcnjBxws3zbiouTtEhLRKNeL2+fv2OGT5sWDSq1NbVDR0y1MgvAED37t29Xt/oUaOaLVLhcDiGDB68t2Lvrt27/X7/gAED/viHSyZOnBDX06HFxcUej7e6pgZjPO2UqffcfZcRuXC5XMcff3woFKqsrPT7/aNGHX/z/Hn9+/czBMvv9/ftWzp0yJD+/fvJsmnv3n21tbWqqo4eNWru9XOys7MAIBQORyPRwYMHDRo40HADJVHaU1FRWVnZt2/fmTMvmTL5ZADgbWk4HA7wYm0Oh8NlgsPhcJngcDhcJjgcDpcJDofDZYLD4XCZ4HA4XCY4HA6HywSHw+kA/wfIcPhQz6aU8wAAAABJRU5ErkJggg==', w: 354, h: 132};
  /** loghi nell'angolo in basso a destra del cartiglio */
  function logos(P, ty) {
    const w = 26, h = w * LOGO.h / LOGO.w, x = 406 - w;
    P.push({t: 'image', p: [x, ty + 2], w, h, data: LOGO.data});
    if (LOGO_METALSAN.data) { const w2 = 46, h2 = w2 * LOGO_METALSAN.h / LOGO_METALSAN.w; P.push({t: 'image', p: [406 - w2, ty + 3 + h], w: w2, h: h2, data: LOGO_METALSAN.data}); }
    else P.push({t: 'text', p: [x + w / 2, ty + 7 + h], txt: 'METALSAN', s: 4.2, layer: 'TESTI', align: 'center', bold: true});
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
    T([302, ty + th - 5], d.project || '', 2.6, 'TESTI');
    T([302, ty + th - 12], `Gruppo: ${d.group || ''}`, 2.4, 'TESTI');
    T([302, ty + th - 19], `Viste 2D in scala 1:${S} su A3`, 2.4, 'TESTI'); T([302, ty + th - 26], `Data ${new Date().toLocaleDateString('it-IT')}`, 2.2, 'TESTI');
    logos(P, ty);
    T([302, ty + 3], 'Peso e baricentro · Trimble Connect', 1.8, 'TESTI');
    T([214, ty + 2], 'Quote in mm. COG sui volumi reali dei pezzi.', 1.8, 'TESTI');
    return {prims: P, scale: S, cogLocal: cogL};
  }
  function wrap(s, n) { const out = []; let cur = ''; s.split(', ').forEach(w => { if ((cur + ', ' + w).length > n && cur) { out.push(cur + ','); cur = w; } else cur = cur ? cur + ', ' + w : w; }); if (cur) out.push(cur); return out; }

  // ------------------------------------------------------------------ PDF
  const LW = {FUNI: [214, 0, 147], GOLFARI: [180, 120, 0], ASSI: [120, 120, 120], CONTORNI: [0, 0, 0], VISTA_3D: [40, 40, 40], QUOTE: [0, 90, 160], BARICENTRO: [200, 30, 30], ORIGINE: [0, 130, 60], TESTI: [20, 20, 20], CORNICE: [0, 0, 0], SEZIONI: [0, 140, 60], TAGLIO: [0, 0, 0]};
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
      } else if (p.t === 'image') { try { doc.addImage(p.data, 'PNG', p.p[0], Y(p.p[1] + p.h), p.w, p.h); } catch (e) {}
      } else if (p.t === 'tbox') { // sfondo bianco sotto un testo (allineato a sinistra)
        doc.setFontSize(p.s / 0.3528); const w = doc.getTextWidth(p.txt), pd = p.s * 0.35;
        const x0 = p.align === 'right' ? p.p[0] - w : p.align === 'center' ? p.p[0] - w / 2 : p.p[0]; doc.setFillColor(255, 255, 255); doc.setDrawColor(...c); doc.setLineWidth(0.2); doc.rect(x0 - pd, Y(p.p[1]) - p.s * 0.6 - pd * 0.5, w + 2 * pd, p.s * 1.2 + pd, 'FD');
      } else if (p.t === 'text') { doc.setTextColor(...c); doc.setFont('helvetica', p.bold ? 'bold' : 'normal'); doc.setFontSize(p.s / 0.3528); doc.text(p.txt, p.a ? p.a[0] : p.p[0], Y(p.p[1]), {align: p.align, baseline: 'middle'}); }
    }
  }

  // ------------------------------------------------------------------ DXF (R12, unità = mm reali per le viste in scala)
  const DXFCOL = {FUNI: 6, GOLFARI: 2, ASSI: 8, CONTORNI: 7, VISTA_3D: 8, QUOTE: 4, BARICENTRO: 1, ORIGINE: 3, TESTI: 7, CORNICE: 7, SEZIONI: 3, TAGLIO: 7};
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
    function pointAt(gi, u, lugL = 0.55, lugW = 0.15) {
      const g = girderAt(gi, u); const v = g.v;
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
      return {gi, u, v, x: xy[0], y: xy[1], z, d: Math.hypot(u, v), support: tot ? ok / tot : 0, el: main >= 0 ? els[main].m : null, studs, missing: !!g.missing};
    }
    const L = U1 - U0;
    return {ax, pv, girders: g0, stations, pointAt, girderAt, strips, length: L, umin: U0, umax: U1, cell, _dbg: {zt, NU, NV, U0, V0, els}};
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
    // §3.13.2 rifollamento e pressione di contatto
    push('fb', 'Rifollamento SLU (§3.13.2)', FEd, 1.5 * t * d * fy / g.gM0 / 1000, 'kN');
    push('fbs', 'Rifollamento SLE (§3.13.2)', FEk, 0.6 * t * d * fy / g.gM6 / 1000, 'kN');
    push('sh', 'Pressione di contatto (§3.13.2)', 0.591 * Math.sqrt(E * FEk * 1000 * (d0 - d) / (d * d * t)), 2.5 * fy / g.gM6, 'MPa');
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
    T([252, ty + th - 6], info.project || '', 2.6); T([252, ty + th - 13], `Data ${new Date().toLocaleDateString('it-IT')}`, 2.2);
    T([252, ty + 3], 'Peso e baricentro · Golfari · Trimble Connect', 1.8);
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
    let U0 = Infinity, U1 = -Infinity; local.forEach(m => { for (let i = 0; i < m.pos.length; i += 3) { if (m.pos[i] < U0) U0 = m.pos[i]; if (m.pos[i] > U1) U1 = m.pos[i]; } });
    const g = d.geo, Lp = g.L / 1000, tp = g.t / 1000, Hp = (g.ev + g.R) / 1000;
    const lugs = d.lugs.map(l => ({...l, L: toL(l.x, l.y, l.z)})).sort((a, b) => a.L[0] - b.L[0]);
    // bordi reali della piattabanda sotto ogni golfare: dal taglio della geometria alla progressiva del golfare
    lugs.forEach(l => { let lo = Infinity, hi = -Infinity;
      local.forEach(m => cutLines(m, 0, l.L[0] - 0.12).forEach(sg => sg.forEach(q => { if (Math.abs(q[2] - l.L[2]) < 0.08 && Math.abs(q[1] - l.gv) < l.gw / 2 + 0.25) { lo = Math.min(lo, q[1]); hi = Math.max(hi, q[1]); } })));
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
    const h0 = hiddenLine(local, local.map(m => contourEdges(edgeNormals(m), norm(PLAN.f))), PLAN, 1600), HP = {...h0, segs: dropShort(h0.segs, 0.3, 0.01)};
    // quote longitudinali: golfari quasi alla stessa progressiva su una sola riga
    const vMid = lugs.length ? (Math.max(...lugs.map(l => l.L[1])) + Math.min(...lugs.map(l => l.L[1]))) / 2 : 0;
    const upL = lugs.filter(l => l.L[1] > vMid + 0.3), dnL = lugs.filter(l => !(l.L[1] > vMid + 0.3));
    const nr = Math.max(upL.length, 1) + dnL.length + 1;
    const SP = pick(Math.max((HP.umax - HP.umin) / (RP[2] - 40), (HP.vmax - HP.vmin) / (RP[3] - 36 - nr * 7)) * 1000), k2 = 1000 / SP;
    const cu = (HP.umin + HP.umax) / 2, cv = (HP.vmin + HP.vmax) / 2, ox = RP[0] + RP[2] / 2, oy = RP[1] + RP[3] / 2 - (dnL.length + 1 - upL.length) * 3.5;
    const map = (u, v) => [ox + (u - cu) * k2, oy + (v - cv) * k2], pm = p => { const q = HP.prj(p[0], p[1], p[2]); return map(q[0], q[1]); };
    HP.segs.forEach(sg => Ln(map(sg[0], sg[1]), map(sg[2], sg[3]), 'CONTORNI', 0.3));
    T([RP[0] + 3, RP[1] + RP[3] - 5], `PIANTA – posizione dei golfari   1:${SP}`, 2.6);
    T([RP[0] + 3, RP[1] + RP[3] - 11], `Riferimento: ${d.refLabel}`, 2.0);
    // riferimento: estremità iniziale
    const r0 = pm([U0, 0, 0]), yTop = map(0, HP.vmax)[1], yBot = map(0, HP.vmin)[1];
    Ln([r0[0], yTop + 6 + upL.length * 7], [r0[0], yBot - 6 - dnL.length * 7], 'SEZIONI', 0.35); T([r0[0] - 1.5, yTop + 8 + upL.length * 7], 'RIF. 0', 2.2, 'SEZIONI', 'right');
    // golfari: impronta della piastra lungo l'asse e quote progressive dal riferimento
    lugs.forEach((l, i) => {
      const ph = l.phi || 0, cu2 = Math.cos(ph), sv2 = Math.sin(ph), cn = [[-Lp / 2, -tp / 2], [Lp / 2, -tp / 2], [Lp / 2, tp / 2], [-Lp / 2, tp / 2]].map(([a, b2]) => pm([l.L[0] + a * cu2 - b2 * sv2, l.L[1] + a * sv2 + b2 * cu2, 0]));
      cn.forEach((q, j) => Ln(q, cn[(j + 1) % 4], 'GOLFARI', 0.5)); const c = pm(l.L), hh = 1;
      if (Math.abs(ph) > 0.01) { const e = pm([l.L[0] + Lp * 0.9 * cu2, l.L[1] + Lp * 0.9 * sv2, 0]), e2 = pm([l.L[0] - Lp * 0.9 * cu2, l.L[1] - Lp * 0.9 * sv2, 0]); dashed(e2, e, 'GOLFARI');
        T([c[0] - 1.5, c[1] + (l.L[1] > vMid ? -4.5 : 3)], `${nf(Math.abs(ph) * 180 / Math.PI, 1)}°`, 1.8, 'GOLFARI', 'right'); }
      T([c[0] + 1.5, c[1] + (l.L[1] > 0 ? 3 : -4.5)], 'G' + l.n, 2.2, 'GOLFARI');
      // distanza trasversale dal bordo della piattabanda
      const eOut = l.gv + Math.sign(l.L[1] - l.gv || 1) * l.gw / 2, side = Math.sign(l.L[1]) || 1, edge = l.L[1] > l.gv ? l.gv + l.gw / 2 : l.gv - l.gw / 2;
      T([c[0] + 1.5, c[1] + (l.L[1] > 0 ? 7 : -8.5)], `${mm(l.L[1] - (l.gv - l.gw / 2))} / ${mm(l.gv + l.gw / 2 - l.L[1])} dai bordi`, 1.8, 'QUOTE');
    });
    // ogni golfare quotato dal RIF. 0: sopra quelli della trave superiore, sotto quelli dell'inferiore
    [...upL].sort((a, b) => a.L[0] - b.L[0]).forEach((l, i) => { const c = pm(l.L), yq = yTop + 6 + i * 7; Ln(c, [c[0], yq + 1], 'QUOTE', 0.12); hd(r0[0], c[0], yq, `${mm(l.L[0] - U0)}  G${l.n}`, null, null); });
    [...dnL].sort((a, b) => a.L[0] - b.L[0]).forEach((l, i) => { const c = pm(l.L), yq = yBot - 6 - i * 7; Ln(c, [c[0], yq - 1], 'QUOTE', 0.12); hd(r0[0], c[0], yq, `${mm(l.L[0] - U0)}  G${l.n}`, null, null); });
    hd(r0[0], pm([U1, 0, 0])[0], yBot - 6 - dnL.length * 7, `L = ${mm(U1 - U0)}`, null, null);
    // ---- sezioni trasversali sui golfari
    const nS = lugs.length, W = 396 / Math.max(1, nS);
    [...lugs].sort((a, b) => a.n - b.n).forEach((l, i) => {
      const r = [12 + W * i, 50, W - 2, 98]; rect(...r, 'CORNICE', 0.18);
      const at = l.L[0] - 0.12, view = {f: [1, 0, 0], up: [0, 0, 1]}, half = l.gw / 2 + 0.5;
      const lat = [[1, 1, l.gv - half], [1, -1, l.gv + half], [2, 1, l.L[2] - 0.8]]; // solo la parte alta della trave
      const latM = local.map(m => clipMesh(m, lat)), cuts = []; latM.forEach(m => cutLines(m, 0, at).forEach(c => cuts.push(c)));
      const pl = [...lat, [0, 1, at + 1e-4], [0, -1, at + 0.5]], beyond = local.map(m => clipMesh(m, pl)).filter(m => m.idx.length);
      const onClip = q => pl.some(([a, , v]) => Math.abs(q[a] - v) < 1e-5);
      const edges = beyond.map(m => contourEdges(edgeNormals(m), norm(view.f)).filter(e => !(onClip([e[0], e[1], e[2]]) && onClip([e[3], e[4], e[5]]))));
      const cm = {pos: new Float64Array(cuts.flat(2)), idx: new Uint32Array(0)};
      const hs = hiddenLine((beyond.length ? beyond : []).concat([cm]), edges, view, 1200), segs = dropShort(hs.segs, 0.03, 0.003);
      const cutS = cuts.map(c => { const a = hs.prj(...c[0]), b = hs.prj(...c[1]); return [a[0], a[1], b[0], b[1]]; });
      let u0 = hs.umin, u1 = hs.umax, v0 = hs.vmin, v1 = Math.max(hs.vmax, hs.prj(l.L[0], l.L[1], l.L[2] + Hp)[1]);
      const S = pick(Math.max((u1 - u0) / (r[2] - 30), (v1 - v0) / (r[3] - 40)) * 1000), k = 1000 / S;
      const ccu = (u0 + u1) / 2, ccv = (v0 + v1) / 2, sx = r[0] + r[2] / 2, sy = r[1] + r[3] / 2 - 4;
      const mp = (u, v) => [sx + (u - ccu) * k, sy + (v - ccv) * k], sp = p => { const q = hs.prj(p[0], p[1], p[2]); return mp(q[0], q[1]); };
      segs.forEach(sg => Ln(mp(sg[0], sg[1]), mp(sg[2], sg[3]), 'CONTORNI', 0.25));
      cutS.forEach(sg => Ln(mp(sg[0], sg[1]), mp(sg[2], sg[3]), 'TAGLIO', 0.6));
      T([r[0] + 2, r[1] + r[3] - 5], `SEZIONE G${l.n}   1:${S}`, 2.4);
      // golfare visto di taglio (spessore t, altezza H) sulla piattabanda
      const wv = Math.abs(Lp * Math.sin(l.phi || 0)) + Math.abs(tp * Math.cos(l.phi || 0)), gb = sp([l.L[0], l.L[1] - wv / 2, l.L[2]]), gt = sp([l.L[0], l.L[1] + wv / 2, l.L[2] + Hp]);
      rect(Math.min(gb[0], gt[0]), gb[1], Math.max(0.8, Math.abs(gt[0] - gb[0])), gt[1] - gb[1], 'GOLFARI', 0.5);
      const ca = sp([l.L[0], l.L[1], l.L[2]]); dashed([ca[0], ca[1] + (gt[1] - gb[1]) + 4], [ca[0], ca[1] - 14], 'ASSI');
      // quote: dai bordi della piattabanda all'asse del golfare; asse anima; altezza del golfare
      const eL = sp([l.L[0], l.gv - l.gw / 2, l.L[2]]), eR = sp([l.L[0], l.gv + l.gw / 2, l.L[2]]), yq = gt[1] + 6;
      const xs = [eL[0], ca[0], eR[0]].sort((a, b) => a - b);
      hd(xs[0], xs[1], yq, mm(Math.abs(l.L[1] - (xs[0] === eL[0] ? l.gv - l.gw / 2 : l.gv + l.gw / 2))), eL[1] + 1, ca[1] + 1);
      hd(xs[1], xs[2], yq, mm(Math.abs((xs[2] === eR[0] ? l.gv + l.gw / 2 : l.gv - l.gw / 2) - l.L[1])), ca[1] + 1, eR[1] + 1);
      hd(xs[0], xs[2], yq + 6, `piattabanda ${mm(l.gw)}`, null, null);
      const wa = sp([l.L[0], l.gv, l.L[2]]), off = l.L[1] - l.gv;
      T([ca[0], r[1] + 5], Math.abs(off) < 0.005 ? 'golfare in asse alla piattabanda' : `asse golfare a ${mm(off)} mm dall'asse della piattabanda`, 1.8, 'QUOTE', 'center');
      vd(gb[1], gt[1], Math.max(gb[0], gt[0]) + 4, `H ${nf(g.ev + g.R, 0)}`);
    });
    // cartiglio
    const ty = 8, th = 38; rect(12, ty, 396, th, 'CORNICE', 0.35); Ln([250, ty], [250, ty + th], 'CORNICE', 0.25);
    T([14, ty + th - 6], `POSIZIONAMENTO GOLFARI – ${d.name}`, 3.0); P[P.length - 1].bold = true;
    T([14, ty + th - 13], `Riferimento: ${d.refLabel} · golfari ${lugs.map(l => 'G' + l.n).join(', ')}`, 2.0);
    T([14, ty + th - 19], `Piastra ${nf(g.L, 0)} × ${nf(g.ev + g.R, 0)} × ${nf(g.t, 0)} mm, ${g.rot ? 'ruotata in pianta verso il punto di presa (angolo dall\'asse della trave)' : 'disposta lungo l\'asse della trave'}`, 1.9);
    T([14, ty + th - 25], 'Quote in mm. Distanze longitudinali dal RIF. 0 (estremità iniziale), misurate lungo l\'asse del concio.', 1.8);
    T([252, ty + th - 6], d.project || '', 2.4); T([252, ty + th - 12], `Data ${new Date().toLocaleDateString('it-IT')}`, 2.0);
    T([252, ty + 3], 'Peso e baricentro · Golfari · Trimble Connect', 1.6);
    logos(P, ty);
    return {prims: P, scale: SP};
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
    const SP = pick(need(EP, R.plan));
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
    const vd = (ya, yb, x, txt) => { Ln([x, ya], [x, yb], 'QUOTE', 0.18); Ln([x - 1.3, ya], [x + 1.3, ya], 'QUOTE', 0.18); Ln([x - 1.3, yb], [x + 1.3, yb], 'QUOTE', 0.18); T([x + 1.5, (ya + yb) / 2], txt, 2.1, 'QUOTE'); };
    const mapper = (h, e, r, S) => { const k2 = 1000 / S, cu = (e.u0 + e.u1) / 2, cv = (e.v0 + e.v1) / 2, ox = r[0] + r[2] / 2, oy = r[1] + r[3] / 2 - 1;
      const map = (u, v) => [ox + (u - cu) * k2, oy + (v - cv) * k2]; return {k2, map, pm: p => { const q = h.prj(p[0], p[1], p[2]); return map(q[0], q[1]); }}; };
    rect(5, 5, 410, 287, 'CORNICE', 0.5);
    rect(...R.plan, 'CORNICE', 0.18); rect(...R.tab, 'CORNICE', 0.18); secs.forEach(sc => rect(...sc.r, 'CORNICE', 0.18));
    // ---- pianta
    { const r = R.plan, {k2, map, pm} = mapper(HP, EP, r, SP), hpp = pm(hook), cp = pm([0, 0, 0]);
      HP.segs.forEach(sg => Ln(map(sg[0], sg[1]), map(sg[2], sg[3]), 'CONTORNI', 0.3));
      T([r[0] + 2, r[1] + r[3] - 4], 'PIANTA   1:' + SP, 2.8);
      dashed([r[0] + 4, cp[1]], [r[0] + r[2] - 4, cp[1]]); dashed([cp[0], r[1] + 4], [cp[0], r[1] + r[3] - 8]);
      lugs.forEach(l => { const lp = pm(l.L); Ln(lp, hpp, 'FUNI', 0.7); C(lp, Math.max(1.3, 0.15 * k2), 'GOLFARI', 0.6); const ox = lp[0] < cp[0] ? -1 : 1, oy = lp[1] < cp[1] ? -1 : 1; T([lp[0] + ox * 2.5, lp[1] + (oy > 0 ? 2.5 : -5.5)], 'F' + l.n, 2.4, 'FUNI', ox < 0 ? 'right' : 'left'); });
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
        T([ep[0] + (dx < 0 ? -1 : 1), ep[1] + 1], 'F' + l.n, 2.2, 'FUNI', dx < 0 ? 'right' : 'left');
        T([lp[0] + (dx < 0 ? a + 1.5 : -a - 1.5), lp[1] + hh + 2.2], lvl(zr(l.L[2])), 1.9, 'QUOTE', dx < 0 ? 'left' : 'right');
        yTop = Math.max(yTop, ep[1]);
      });
      // quote dei golfari dall'asse del baricentro
      const yq = Math.min(yTop + 3, r[1] + r[3] - 9);
      sc.lugs.forEach(l => { const x = pm(l.L)[0]; hd(Math.min(x, cp[0]), Math.max(x, cp[0]), yq, mm(sc.kind === 'T' ? l.L[1] : l.L[0])); });
    });
    // tabella
    const t = R.tab, x0 = t[0] + 2; let y = t[1] + t[3] - 5;
    T([x0, y], 'GOLFARI E FUNI', 2.8); y -= 5.5;
    const cols = [0, 10, 21, 35, 48, 62, 78];
    ['', 'Trave', 'Carico t', 'Tiro t', 'Angolo', 'Fune m', 'Grillo'].forEach((h, i) => T([x0 + cols[i], y], h, 1.9)); y -= 2; Ln([x0, y], [t[0] + t[2] - 2, y], 'CORNICE', 0.13); y -= 3.5;
    lugs.forEach(l => { const row = ['F' + l.n, l.g || '', nf(l.P, 1), nf(l.T, 1), nf(l.alpha, 1) + '°', nf(l.Ls, 2)];
      row.forEach((v, j) => T([x0 + cols[j], y], v, 2.1)); T([x0 + cols[6], y], (l.type || '–'), 1.9); T([x0 + cols[6], y - 3.4], (l.shackle || ''), 1.7); y -= 8.5; });
    y -= 1; T([x0, y], `Tiro max ${nf(Math.max(...lugs.map(l => l.T)), 1)} t${d.skl && d.skl !== 1 ? ' · SKL ' + nf(d.skl, 2) + ' nelle verifiche' : ''}`, 2.2); y -= 4.5;
    T([x0, y], `Gancio sopra il baricentro, quota ${lvl(zr(hook[2]))} m`, 2.0); y -= 4.5;
    T([x0, y], `COG a quota ${lvl(zr(0))} m · golfari a ${[...new Set(lugs.map(l => lvl(zr(l.L[2]))))].join(' / ')} m`, 2.0); y -= 4.5;
    // cartiglio
    const ty = 8, th = 38; rect(12, ty, 396, th, 'CORNICE', 0.35); Ln([250, ty], [250, ty + th], 'CORNICE', 0.25);
    T([14, ty + th - 6], `SCHEMA DI SOLLEVAMENTO CON GRU SINGOLA – ${d.name}`, 3.4); P[P.length - 1].bold = true;
    T([14, ty + th - 13], `Peso ${nf(d.weight, 2)} t · ${lugs.length} golfari · pianta 1:${SP}, sezioni 1:${ST}${nL ? ' / 1:' + SL : ''} su A3`, 2.5);
    T([14, ty + th - 19], `COG nel modello  X ${nf(c0[0], 3)}  Y ${nf(c0[1], 3)}  Z ${nf(c0[2], 3)} m`, 2.3);
    logos(P, ty);
    T([252, ty + th - 6], d.project || '', 2.6); T([252, ty + th - 13], `Gruppo: ${d.group || ''}`, 2.3);
    T([252, ty + th - 20], `Data ${new Date().toLocaleDateString('it-IT')}`, 2.2); T([252, ty + 3], 'Peso e baricentro · Golfari · Trimble Connect', 2.0);
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
    const lugs = d.lugs.map(l => ({...l, L: toL(l.x, l.y, l.z)})), hook = toL(d.hook[0], d.hook[1], d.hook[2]);
    const z0 = zeroLevel(local), zr = z => z - z0; // quote relative al ±0,00
    const VIEWS = {front: {f: [0, 1, 0], up: [0, 0, 1], title: 'PROSPETTO'}, plan: {f: [0, 0, -1], up: [0, 1, 0], title: 'PIANTA'}, side: {f: [1, 0, 0], up: [0, 0, 1], title: 'SEZIONE TRASVERSALE'}};
    const H = {}; for (const k in VIEWS) H[k] = d.outline ? (h => ({...h, segs: dropShort(h.segs, 0.4, 0.01)}))(hiddenLine(local, EN.map(en => contourEdges(en, norm(VIEWS[k].f))), VIEWS[k], 1600)) : hiddenLine(local, edges, VIEWS[k], 1400);
    // ingombri comprensivi di funi e gancio
    const ext = k => { const h = H[k]; let u0 = h.umin, u1 = h.umax, v0 = h.vmin, v1 = h.vmax; [hook, ...lugs.map(l => l.L)].forEach(p => { const q = h.prj(p[0], p[1], p[2]); u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); v0 = Math.min(v0, q[1]); v1 = Math.max(v1, q[1]); }); return {u0, u1, v0, v1}; };
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
      lugs.forEach((l, i) => { const lp = pm([l.L[0], l.L[1], l.L[2] + 0.16]); Ln(lp, hp, 'FUNI', k === 'plan' ? 1.0 : 0.6);
        const key = Math.round(lp[0] / 10) + ',' + Math.round(lp[1] / 10); if (!grp.has(key)) grp.set(key, {lp, ids: [], al: []}); grp.get(key).ids.push(i + 1); grp.get(key).al.push(l.alpha); });
      const placed = [];
      grp.forEach(gq => { const lp = gq.lp, mid = [(lp[0] + hp[0]) / 2, (lp[1] + hp[1]) / 2], left = lp[0] < hp[0] - 0.5, lab = gq.ids.map(x => 'F' + x).join('/');
        if (k === 'plan') { // fuori dalla struttura: sopra i golfari in alto, sotto quelli in basso, su fondo bianco
          const ext = {top: map(0, h.vmax)[1], bot: map(0, h.vmin)[1]};
          const up = lp[1] >= cp[1], yMinL = Math.min(...lugs.map(l2 => pm(l2.L)[1])), q = [lp[0], up ? Math.max(lp[1] + 6, ext.top + 4) : Math.min(yMinL - 15, ext.bot - 7)], sz = 3.2;
          Ln(lp, [q[0], q[1] + (up ? -1.5 : 3.5)], 'FUNI', 0.15);
          P.push({t: 'tbox', p: q, txt: lab, s: sz * 1.3, layer: 'FUNI', align: 'center'}); T(q, lab, sz, 'FUNI', 'center'); P[P.length - 1].bold = true;
        } else { const q = [mid[0] + (left ? -2.5 : 2.5), mid[1] + 1.5]; while (placed.some(o => Math.abs(o[0] - q[0]) < 12 && Math.abs(o[1] - q[1]) < 5.5)) q[1] -= 6; placed.push(q.slice()); P.push({t: 'tbox', p: q, txt: lab, s: 3.0 * 1.3, layer: 'FUNI', align: left ? 'right' : 'left'}); T(q, lab, 3.0, 'FUNI', left ? 'right' : 'left'); P[P.length - 1].bold = true; }
        if (k === 'front') T([lp[0] + (left ? -2 : 2), lp[1] - 6], gq.al.map(a => nf(a, 1) + '°').join(' / '), 2.1, 'QUOTE', left ? 'right' : 'left'); });
      // golfari
      lugs.forEach(l => { const lp = pm(l.L); if (k === 'front') { const a = 0.275 * k2, hh = 0.3 * k2; Ln([lp[0] - a, lp[1]], [lp[0] + a, lp[1]], 'GOLFARI', 0.35); Ln([lp[0] - a, lp[1]], [lp[0] - a * 0.4, lp[1] + hh], 'GOLFARI', 0.35); Ln([lp[0] + a, lp[1]], [lp[0] + a * 0.4, lp[1] + hh], 'GOLFARI', 0.35); Ln([lp[0] - a * 0.4, lp[1] + hh], [lp[0] + a * 0.4, lp[1] + hh], 'GOLFARI', 0.35); }
        else { C(lp, Math.max(0.8, 0.12 * k2), 'GOLFARI'); } });
      // gancio
      C(hp, 1.6, 'FUNI'); Ln([hp[0], hp[1] + 1.6], [hp[0], hp[1] + 6], 'FUNI', 0.35);
      if (k !== 'plan') T([hp[0] + 2.5, hp[1] + 4], `Gancio gru  ${lvl(zr(hook[2]))}`, 2.2, 'FUNI');
      if (k !== 'plan') { // livello ±0,00 e quote dei golfari
        const y0 = pm([0, 0, z0])[1], xr = Math.min(map(h.umax, 0)[0] + 3, r[0] + r[2] - 22), xl = map(h.umin, 0)[0] - 3;
        Ln([xl, y0], [xr + 10, y0], 'QUOTE', 0.25); Ln([xr + 4, y0], [xr + 2.5, y0 + 2.6], 'QUOTE', 0.25); Ln([xr + 4, y0], [xr + 5.5, y0 + 2.6], 'QUOTE', 0.25); Ln([xr + 2.5, y0 + 2.6], [xr + 5.5, y0 + 2.6], 'QUOTE', 0.25);
        T([xr + 6.5, y0 + 3], '±0,00', 2.4, 'QUOTE');
        const seen = new Set(); lugs.forEach(l => { const lp = pm(l.L), key = Math.round(lp[0] / 6); if (seen.has(key)) return; seen.add(key); const out = lp[0] < hp[0] ? -1 : 1; T([lp[0] + out * 3.5, lp[1] + 3.5], lvl(zr(l.L[2])), 2.0, 'QUOTE', out < 0 ? 'right' : 'left'); });
      }
      cogSym(cp, 2.0); { const tx = `COG = ${nf(d.weight, 1)} t` + (k !== 'plan' ? `  ${lvl(zr(0))}` : ''), al = k === 'side' ? 'right' : 'left', tp = [cp[0] + (al === 'right' ? -3.5 : 3.5), cp[1] - 5.5];
        P.push({t: 'tbox', p: tp, txt: tx, s: 2.3 * 1.3, layer: 'BARICENTRO', align: al}); T(tp, tx, 2.3, 'BARICENTRO', al); }
      // quote
      const hd = (xa, xb, y, txt) => { Ln([xa, y], [xb, y], 'QUOTE', 0.18); Ln([xa, y - 1.3], [xa, y + 1.3], 'QUOTE', 0.18); Ln([xb, y - 1.3], [xb, y + 1.3], 'QUOTE', 0.18); T([(xa + xb) / 2, y + 1], txt, 2.1, 'QUOTE', 'center'); };
      const vd = (ya, yb, x, txt) => { Ln([x, ya], [x, yb], 'QUOTE', 0.18); Ln([x - 1.3, ya], [x + 1.3, ya], 'QUOTE', 0.18); Ln([x - 1.3, yb], [x + 1.3, yb], 'QUOTE', 0.18); T([x + 1.5, (ya + yb) / 2], txt, 2.1, 'QUOTE'); };
      if (k === 'front') {
        const yq = Math.max(...lugs.map(l => pm(l.L)[1])) + 4;
        clusters(lugs.map(l => l.L[0])).forEach(c => { const x = pm([c.v, 0, 0])[0]; hd(Math.min(x, cp[0]), Math.max(x, cp[0]), yq, c.txt); });
        const lz = pm(lugs[0].L); vd(lz[1], hp[1], hp[0] - 10, mm(hook[2] - lugs[0].L[2]));
      }
      if (k === 'plan') {
        const xq = Math.max(...lugs.map(l => pm(l.L)[0])) + 8;
        clusters(lugs.map(l => l.L[1])).forEach(c => { const y = pm([0, c.v, 0])[1]; vd(Math.min(y, cp[1]), Math.max(y, cp[1]), xq, c.txt); });
        const yq = Math.min(...lugs.map(l => pm(l.L)[1])) - 8;
        clusters(lugs.map(l => l.L[0])).forEach(c => { const x = pm([c.v, 0, 0])[0]; hd(Math.min(x, cp[0]), Math.max(x, cp[0]), yq, c.txt); });
      }
      if (k === 'side') { const yq = Math.max(...lugs.map(l => pm(l.L)[1])) + 4;
        clusters(lugs.map(l => l.L[1])).forEach(c => { const x = pm([0, c.v, 0])[0]; hd(Math.min(x, cp[0]), Math.max(x, cp[0]), yq, c.txt); }); }
    }
    place('front'); place('plan'); place('side');
    // tabella golfari e funi
    const t = R.tab, x0 = t[0] + 2; let y = t[1] + t[3] - 5;
    T([x0, y], 'GOLFARI E FUNI', 2.8); y -= 6;
    const cols = [0, 9, 19, 33, 46, 61, 76];
    ['', 'Trave', 'Carico t', 'Tiro t', 'Angolo', 'Fune m', 'Grillo'].forEach((h, i) => { T([x0 + cols[i], y], h, 2.3); P[P.length - 1].bold = true; }); y -= 2.5; Ln([x0, y], [t[0] + t[2] - 2, y], 'CORNICE', 0.2); y -= 5;
    lugs.forEach((l, i) => { const row = ['F' + (i + 1), l.g || '', nf(l.P, 1), nf(l.T, 1), nf(l.alpha, 1) + '°', nf(l.Ls, 2)];
      row.forEach((v, j) => { T([x0 + cols[j], y], v, 2.7); if (j === 0 || j === 3) P[P.length - 1].bold = true; });
      const gr = String(l.type || l.shackle || '–').replace(/^Grillo\s+/i, ''); T([x0 + cols[6], y], gr, 2.2); y -= 8.5; });
    y -= 1; T([x0, y], `Tiro max ${nf(Math.max(...lugs.map(l => l.T)), 1)} t${d.skl && d.skl !== 1 ? ' · SKL ' + nf(d.skl, 2) + ' nelle verifiche' : ''}`, 2.8); P[P.length - 1].bold = true; y -= 6.5;
    T([x0, y], `Gancio sopra il baricentro, quota ${lvl(zr(hook[2]))} m`, 2.5); y -= 5.5;
    T([x0, y], `COG a quota ${lvl(zr(0))} m`, 2.5); y -= 5.5;
    T([x0, y], `Golfari a ${[...new Set(lugs.map(l => lvl(zr(l.L[2]))))].join(' / ')} m`, 2.5); y -= 5.5;
    // cartiglio
    const ty = 8, th = 38; rect(12, ty, 396, th, 'CORNICE', 0.35); Ln([250, ty], [250, ty + th], 'CORNICE', 0.25);
    T([14, ty + th - 6], `SCHEMA DI SOLLEVAMENTO CON GRU SINGOLA – ${d.name}`, 3.4); P[P.length - 1].bold = true;
    T([14, ty + th - 13], `Peso ${nf(d.weight, 2)} t · ${lugs.length} golfari · scala 1:${S} su A3`, 2.5);
    T([14, ty + th - 19], `COG nel modello  X ${nf(c0[0], 3)}  Y ${nf(c0[1], 3)}  Z ${nf(c0[2], 3)} m`, 2.3);
    logos(P, ty);

    T([252, ty + th - 6], d.project || '', 2.6); T([252, ty + th - 13], `Gruppo: ${d.group || ''}`, 2.3);
    T([252, ty + th - 20], `Data ${new Date().toLocaleDateString('it-IT')}`, 2.2); T([252, ty + 3], 'Peso e baricentro · Golfari · Trimble Connect', 2.0);
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

  const API = {buildLugLayout, buildLugShop, lugCheck, STEELS, LUG_GEO_DEFAULT, silhouette, insertIntoIfc, buildLugSheet, lugIfc, liftModel, placeLugs, slingForces, IFC, toDxfMulti, initIfc, openIfc, meshOf, leaves, volCentroid, bboxOf, buildSheet, toPdf, toDxf, featureEdges, hiddenLine};
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PBDraw = API;
})(typeof window !== 'undefined' ? window : globalThis);
