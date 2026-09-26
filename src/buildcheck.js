// Build checks: does the brick model hold together, can it be built step by step, and does it stand?
//
// Pieces connect only through studs: a piece is joined to each piece in the layer directly above or
// below that overlaps it (one connection per shared stud). Pieces side by side in one layer are not
// joined. From that graph the check finds loose parts, a build order in which every piece attaches to
// something already built, weak joints held by a single stud, and whether the finished model balances.
(function (L) {
  // Real LEGO baseplates in Light Bluish Gray (Rebrickable/BrickLink part numbers), smallest first.
  const BASEPLATES = [
    { w: 16, d: 16, partNum: '3867' },
    { w: 16, d: 32, partNum: '3857' },
    { w: 32, d: 32, partNum: '3811' },
    { w: 48, d: 48, partNum: '4186' },
  ];

  // The baseplate(s) that fit under the bottom layer with a stud of margin all round.
  L.chooseBaseplate = function (model) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const b of model.bricks) {
      if (b.level !== 0) continue;
      x0 = Math.min(x0, b.x); z0 = Math.min(z0, b.z); x1 = Math.max(x1, b.x + b.w); z1 = Math.max(z1, b.z + b.d);
    }
    if (x0 === Infinity) { x0 = z0 = 0; x1 = model.cols; z1 = model.depth; }
    const need = [x1 - x0 + 2, z1 - z0 + 2];
    const one = BASEPLATES.find((p) => (p.w >= need[0] && p.d >= need[1]) || (p.d >= need[0] && p.w >= need[1]));
    let plate;
    if (one) {
      const turned = !(one.w >= need[0] && one.d >= need[1]);
      plate = { partNum: one.partNum, a: one.w, c: one.d, count: 1, w: turned ? one.d : one.w, d: turned ? one.w : one.d };
    } else {
      // Bigger than any single baseplate: a grid of 32 × 32s (pieces spanning the seams hold them together).
      const nx = Math.ceil(need[0] / 32), nz = Math.ceil(need[1] / 32);
      plate = { partNum: '3811', a: 32, c: 32, count: nx * nz, w: nx * 32, d: nz * 32 };
    }
    // Centred under the bottom layer, on the stud grid.
    plate.x0 = Math.floor((x0 + x1) / 2 - plate.w / 2);
    plate.z0 = Math.floor((z0 + z1) / 2 - plate.d / 2);
    return plate;
  };

  // Which piece fills each cell, and the stud connections between pieces in neighbouring layers
  // (adj[i]: Map of piece -> number of shared studs).
  function connect(model) {
    const { cols, depth, rows, bricks } = model;
    const n = bricks.length;
    const cell = (x, level, z) => (level * depth + z) * cols + x;
    const owner = new Int32Array(cols * depth * rows).fill(-1);
    let collisions = 0;
    bricks.forEach((b, i) => {
      for (let z = b.z; z < b.z + b.d; z++) for (let x = b.x; x < b.x + b.w; x++) {
        const k = cell(x, b.level, z);
        if (owner[k] >= 0) collisions++; else owner[k] = i;
      }
    });
    const adj = Array.from({ length: n }, () => new Map());
    let connections = 0;
    bricks.forEach((b, i) => {
      if (b.level + 1 >= rows) return;
      for (let z = b.z; z < b.z + b.d; z++) for (let x = b.x; x < b.x + b.w; x++) {
        const j = owner[cell(x, b.level + 1, z)];
        if (j < 0) continue;
        adj[i].set(j, (adj[i].get(j) || 0) + 1);
        adj[j].set(i, (adj[j].get(i) || 0) + 1);
        connections++;
      }
    });
    return { owner, adj, connections, collisions };
  }

  L.checkBuild = function (model, { baseplate = false } = {}) {
    const { bricks } = model;
    const n = bricks.length;
    let { adj, connections, collisions } = connect(model);
    // On a baseplate every stud of the bottom layer is a connection too, and it ties them all together.
    const grounded = (b) => b.level === 0;
    if (baseplate) for (const b of bricks) if (grounded(b)) connections += b.w * b.d;

    // Parts that hold together (a baseplate, node n, joins everything standing on it).
    const up = new Int32Array(n + 1).map((_, k) => k);
    const find = (k) => { while (up[k] !== k) { up[k] = up[up[k]]; k = up[k]; } return k; };
    const join = (a, b) => { a = find(a); b = find(b); if (a !== b) up[a] = b; };
    adj.forEach((m, i) => { for (const j of m.keys()) join(i, j); });
    if (baseplate) bricks.forEach((b, i) => { if (grounded(b)) join(i, n); });
    const ids = new Map();
    const part = new Int32Array(n);
    const sizes = [];
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!ids.has(r)) { ids.set(r, sizes.length); sizes.push(0); }
      part[i] = ids.get(r);
      sizes[part[i]]++;
    }
    let main = 0;
    sizes.forEach((sz, id) => { if (sz > sizes[main]) main = id; });
    const touchesGround = new Uint8Array(sizes.length);
    bricks.forEach((b, i) => { if (grounded(b)) touchesGround[part[i]] = 1; });
    const separate = [], floating = [];
    bricks.forEach((b, i) => { b.inMain = part[i] === main; });
    bricks.forEach((b, i) => {
      if (part[i] === main) return;
      (touchesGround[part[i]] ? separate : floating).push(i);
    });

    // Build order: keep the chosen order, but a piece with nothing to attach to yet waits, and goes in
    // right after the first piece it can hang from (clipped on underneath).
    const placed = new Uint8Array(n);
    const waiting = new Uint8Array(n);
    const order = [];
    let hanging = 0;
    const place = (start) => {
      const todo = [start];
      while (todo.length) {
        const i = todo.pop();
        if (placed[i]) continue;
        placed[i] = 1;
        // Nothing placed under it: it clips on underneath a piece above.
        bricks[i].hanging = !grounded(bricks[i]) && ![...adj[i].keys()].some((j) => placed[j] && bricks[j].level < bricks[i].level);
        order.push(bricks[i]);
        for (const j of adj[i].keys()) if (waiting[j] && !placed[j]) { waiting[j] = 0; todo.push(j); }
      }
    };
    bricks.forEach((b, i) => {
      b.hanging = false;
      b.loose = false;
      const ok = grounded(b) || [...adj[i].keys()].some((j) => placed[j]);
      if (ok) place(i); else waiting[i] = 1;
    });
    // Anything still waiting never touches the rest: it can't be built (it would float).
    bricks.forEach((b, i) => { if (!placed[i]) { b.loose = true; order.push(b); } });
    for (const b of order) if (b.hanging) hanging++;

    // Weak joints: a group of pieces held on by a single stud (a bridge in the connection graph whose
    // removal splits off at least a few pieces).
    const weak = findWeakJoints(bricks, adj, part, main, 4);
    for (const b of bricks) b.weak = false;
    for (const j of weak) { bricks[j.a].weak = true; bricks[j.b].weak = true; }

    // Balance: without a baseplate, the centre of mass must be over the footprint of the bottom layer.
    let stable = true, margin = Infinity, com = null;
    if (!baseplate) {
      let mx = 0, mz = 0, mass = 0;
      const pts = [];
      bricks.forEach((b, i) => {
        if (part[i] !== main) return;
        const m = b.w * b.d;
        mx += (b.x + b.w / 2) * m; mz += (b.z + b.d / 2) * m; mass += m;
        if (grounded(b)) pts.push([b.x, b.z], [b.x + b.w, b.z], [b.x, b.z + b.d], [b.x + b.w, b.z + b.d]);
      });
      com = [mx / mass, mz / mass];
      const hull = convexHull(pts);
      margin = insideMargin(hull, com);
      stable = margin > 0.25;
    }

    return {
      part, main, grounded: touchesGround,
      pieces: n, connections, collisions, parts: sizes.length,
      separate, floating, hanging, weak, stable, margin, com, baseplate,
      order, buildable: floating.length === 0,
    };
  };

  // Bricks for a volume, repaired until they hold together:
  // 1. A part that doesn't connect to the main one gets tied on with hidden pieces: a column through the
  //    solid inside of the model, straight up or down to the main part (studs join a column).
  // 2. Tiny specks that still can't attach to anything (a lone stud of colour on an edge, with nothing
  //    above or below) are left out: they would just fall off.
  // Returns { model, check, fixes: { hidden, specks } }.
  L.buildChecked = function (volume, opts = {}) {
    const { cols, rows, depth } = volume;
    const voxels = volume.voxels.slice(); // side joints may recolour a stud or two
    const force = new Uint8Array(voxels.length);
    const bonds = new Map(); // level -> [[cellA, cellB], ...]
    let model, check, hidden = 0, recoloured = 0;
    const MAX_SPECK = 4; // pieces
    for (let round = 0; round < 12; round++) {
      model = L.bricksFromVolume({ ...volume, voxels }, { ...opts, force, bonds });
      check = L.checkBuild(model, opts);
      const loose = [...check.floating, ...check.separate];
      if (!loose.length) break;
      // Kept cells and whether they're in the main part.
      const inMain = new Int8Array(voxels.length).fill(-1); // -1 empty, 0 other part, 1 main
      model.bricks.forEach((b, i) => {
        for (let z = b.z; z < b.z + b.d; z++) for (let x = b.x; x < b.x + b.w; x++) {
          inMain[(b.level * depth + z) * cols + x] = check.part[i] === check.main ? 1 : 0;
        }
      });
      let added = 0;
      const tied = new Set();
      for (const i of loose) {
        const p = check.part[i];
        if (tied.has(p)) continue;
        const b = model.bricks[i];
        let best = null;
        for (let z = b.z; z < b.z + b.d && !best; z++) for (let x = b.x; x < b.x + b.w; x++) {
          for (const dir of [1, -1]) {
            const path = [];
            for (let l = b.level + dir; l >= 0 && l < rows; l += dir) {
              const k = (l * depth + z) * cols + x;
              if (voxels[k] < 0) break; // outside the model: no hidden route
              if (inMain[k] === 1) { if (!best || path.length < best.length) best = path.slice(); break; }
              if (inMain[k] === 0) break;
              path.push(k);
            }
          }
          if (best && best.length <= 1) break;
        }
        if (!best) {
          // No hidden route: lock it on from the side instead. One piece has to span the seam, so the
          // stud on the other side takes this part's colour.
          const found = [];
          for (const j of loose) {
            if (check.part[j] !== p || found.length >= 2) continue;
            const q = model.bricks[j];
            for (let z = q.z; z < q.z + q.d && found.length < 2; z++) for (let x = q.x; x < q.x + q.w && found.length < 2; x++) {
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = x + dx, nz = z + dz;
                if (nx < 0 || nz < 0 || nx >= cols || nz >= depth) continue;
                const k = (q.level * depth + nz) * cols + nx;
                if (inMain[k] !== 1 || found.some((f) => f.k === k)) continue;
                found.push({ k, level: q.level, a: z * cols + x, b: nz * cols + nx, color: q.color });
                break;
              }
            }
          }
          for (const f of found) {
            if (voxels[f.k] !== f.color) recoloured++;
            voxels[f.k] = f.color;
            if (!bonds.has(f.level)) bonds.set(f.level, []);
            bonds.get(f.level).push([f.a, f.b]);
          }
          if (found.length) { added += found.length; tied.add(p); }
          continue;
        }
        if (best) {
          for (const k of best) force[k] = 1;
          added += best.length;
          hidden += best.length;
          tied.add(p);
          // A second column alongside, where the inside allows, so the tie isn't a single stud.
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const side = best.map((k) => k + dz * cols + dx);
            const ok = best.every((k, n) => {
              const x = k % cols, z = Math.floor(k / cols) % depth, j = side[n];
              return x + dx >= 0 && x + dx < cols && z + dz >= 0 && z + dz < depth && voxels[j] >= 0 && inMain[j] < 0;
            });
            if (ok) { for (const k of side) force[k] = 1; added += side.length; hidden += side.length; break; }
          }
        }
      }
      if (!added) break;
    }
    // Every piece has to connect. What still doesn't:
    // - tiny specks (a lone stud of colour on an edge) are left out: they'd just fall off;
    // - bigger parts that stand on the table next to the model (two objects side by side) are tied
    //   together with a baseplate under them all;
    // - anything else still floating is left out too.
    let autoBaseplate = false, removed = 0;
    const partSize = new Map();
    check.part.forEach((p) => partSize.set(p, (partSize.get(p) || 0) + 1));
    const speck = (i) => check.part[i] !== check.main && partSize.get(check.part[i]) <= MAX_SPECK;
    const specks = model.bricks.filter((b, i) => speck(i)).length;
    if (specks) {
      model.bricks = model.bricks.filter((b, i) => !speck(i));
      check = L.checkBuild(model, opts);
    }
    if (check.separate.length && !opts.baseplate) {
      autoBaseplate = true;
      check = L.checkBuild(model, { ...opts, baseplate: true });
    }
    const stray = [...check.floating, ...check.separate];
    if (stray.length) {
      const drop = new Set(stray.map((i) => model.bricks[i]));
      removed = drop.size;
      model.bricks = model.bricks.filter((b) => !drop.has(b));
      check = L.checkBuild(model, { ...opts, baseplate: opts.baseplate || autoBaseplate });
    }
    model.bricks = check.order;
    model.bricks.forEach((b, i) => { b.step = i; });
    return { model, check, fixes: { hidden, specks, recoloured, removed, autoBaseplate } };
  };

  // Sub-assemblies, like a real LEGO set. The model is cut into sections at its narrowest joints (a
  // neck, a waist); the bottom section is built in place, and each separate part of a higher section is
  // built on its own and then put on (in the animation it's built hovering above its spot, then lowered
  // into place). Reorders model.bricks, sets b.group on each piece (0 = built in place) and sets
  // model.assemblies = [{ group, label, start, end, lift }] (pieces start..end-1 make up that group).
  L.planAssemblies = function (model, { minRows = 14, minPieces = 8 } = {}) {
    const { rows, bricks } = model;
    const n = bricks.length;
    for (const b of bricks) b.group = 0;
    model.assemblies = [];
    if (rows < minRows || n < 60) return model;
    const { adj } = connect(model);

    // Where to cut: few studs joining two layers compared with how big they are.
    const cells = new Float64Array(rows), between = new Float64Array(rows);
    bricks.forEach((b, i) => {
      cells[b.level] += b.w * b.d;
      for (const [j, k] of adj[i]) if (bricks[j].level === b.level + 1) between[b.level] += k;
    });
    const sections = Math.max(2, Math.min(4, Math.round(rows / 14)));
    const minH = Math.max(4, Math.floor(rows / (sections + 1)));
    const candidates = [];
    for (let l = minH - 1; l <= rows - minH - 1; l++) {
      if (!between[l]) continue;
      // A neck: the joint is small next to the bigger of the two layers (stem under a cap, head on a body).
      candidates.push({ at: l + 1, score: between[l] / Math.max(1, cells[l], cells[l + 1]) });
    }
    candidates.sort((a, b) => a.score - b.score);
    const cuts = [];
    for (const c of candidates) {
      if (cuts.length >= sections - 1) break;
      if (c.score > 0.5) break; // only at a real narrowing: no sub-assemblies for a plain can or box
      if (cuts.every((k) => Math.abs(k - c.at) >= minH)) cuts.push(c.at);
    }
    if (!cuts.length) return model;
    const starts = [0, ...cuts.sort((a, b) => a - b)];

    const placed = new Uint8Array(n);
    const order = [];
    // Put members in order (keeping the current order where possible): a piece goes in when it is a base
    // piece or touches one already placed; `local` limits "placed" to the members themselves (a
    // sub-assembly is built on its own, away from the model).
    const build = (members, isBase, local) => {
      const inSet = local ? new Set(members) : null;
      const waiting = new Set();
      const touching = (i) => { for (const j of adj[i].keys()) if (placed[j] && (!inSet || inSet.has(j))) return true; return false; };
      const put = (start) => {
        const todo = [start];
        while (todo.length) {
          const i = todo.pop();
          if (placed[i]) continue;
          const b = bricks[i];
          b.hanging = !isBase(b) && ![...adj[i].keys()].some((j) => placed[j] && (!inSet || inSet.has(j)) && bricks[j].level < b.level);
          placed[i] = 1;
          order.push(b);
          for (const j of adj[i].keys()) if (waiting.has(j)) { waiting.delete(j); todo.push(j); }
        }
      };
      for (const i of members) {
        if (placed[i]) continue;
        if (isBase(bricks[i]) || touching(i)) put(i); else waiting.add(i);
      }
      return [...waiting];
    };
    // Groups of members that hold together among themselves.
    const groupsOf = (members) => {
      const inSet = new Set(members), seen = new Set(), out = [];
      for (const s0 of members) {
        if (seen.has(s0)) continue;
        const comp = [], stack = [s0];
        seen.add(s0);
        while (stack.length) {
          const i = stack.pop();
          comp.push(i);
          for (const j of adj[i].keys()) if (inSet.has(j) && !seen.has(j)) { seen.add(j); stack.push(j); }
        }
        out.push(comp.sort((a, b) => a - b));
      }
      return out.sort((a, b) => a[0] - b[0]);
    };

    const all = bricks.map((_, i) => i);
    let carry = build(all.filter((i) => bricks[i].level < starts[1]), (b) => b.level === 0, false);
    const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const height = rows * (model.layerHeight || L.BRICK_HEIGHT);
    for (let k = 1; k < starts.length; k++) {
      const bottom = starts[k], top = starts[k + 1] ?? rows;
      const members = [...carry, ...all.filter((i) => bricks[i].level >= bottom && bricks[i].level < top)].sort((a, b) => a - b);
      const later = [];
      carry = [];
      for (const comp of groupsOf(members)) {
        const standsOnBottom = comp.some((i) => bricks[i].level === bottom);
        if (!standsOnBottom) { (k + 1 < starts.length ? carry : later).push(...comp); continue; }
        // Too small to be worth building separately (a few pieces, or a hidden support): put on in place.
        if (comp.length < Math.max(minPieces, members.length * 0.08)) { later.push(...comp); continue; }
        const group = model.assemblies.length + 1;
        const start = order.length;
        for (const i of comp) bricks[i].group = group;
        build(comp, (b) => b.level === bottom, true);
        model.assemblies.push({
          group, label: LETTERS[(group - 1) % 26], start, end: order.length, bottom,
          lift: Math.max(6, height * 0.22),
        });
      }
      // Small bits of this section go on in place, after its sub-assemblies.
      carry.push(...build(later.sort((a, b) => a - b), (b) => b.level === 0, false));
    }
    for (let i = 0; i < n; i++) if (!placed[i]) { bricks[i].hanging = false; order.push(bricks[i]); }
    model.bricks = order;
    model.bricks.forEach((b, i) => { b.step = i; });
    return model;
  };

  // Bridges in the main part's connection graph that are a single stud and cut off >= minSide pieces.
  function findWeakJoints(bricks, adj, part, main, minSide) {
    const n = bricks.length;
    const disc = new Int32Array(n).fill(-1), low = new Int32Array(n), sub = new Int32Array(n);
    const parentOf = new Int32Array(n).fill(-1);
    const weak = [];
    let time = 0;
    for (let root = 0; root < n; root++) {
      if (part[root] !== main || disc[root] >= 0) continue;
      const stack = [[root, adj[root].keys()]];
      disc[root] = low[root] = time++; sub[root] = 1;
      while (stack.length) {
        const top = stack[stack.length - 1];
        const [v, it] = top;
        const next = it.next();
        if (!next.done) {
          const w = next.value;
          if (disc[w] < 0) {
            parentOf[w] = v; disc[w] = low[w] = time++; sub[w] = 1;
            stack.push([w, adj[w].keys()]);
          } else if (w !== parentOf[v]) {
            low[v] = Math.min(low[v], disc[w]);
          }
          continue;
        }
        stack.pop();
        const p = parentOf[v];
        if (p >= 0) {
          low[p] = Math.min(low[p], low[v]);
          sub[p] += sub[v];
          if (low[v] > disc[p] && adj[p].get(v) === 1) weak.push({ a: p, b: v, side: sub[v] });
        }
      }
      // The side cut off is the smaller of the subtree and the rest.
      const total = sub[root];
      for (const j of weak) if (j.total == null) { j.total = total; j.side = Math.min(j.side, total - j.side); }
    }
    return weak.filter((j) => j.side >= minSide);
  }

  function convexHull(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper); // counter-clockwise
  }

  // How far inside the (counter-clockwise) polygon the point is, in studs (negative: outside).
  function insideMargin(hull, [px, pz]) {
    if (hull.length < 3) return -Infinity;
    let m = Infinity;
    for (let i = 0; i < hull.length; i++) {
      const [ax, az] = hull[i], [bx, bz] = hull[(i + 1) % hull.length];
      const len = Math.hypot(bx - ax, bz - az) || 1;
      m = Math.min(m, ((bx - ax) * (pz - az) - (bz - az) * (px - ax)) / len);
    }
    return m;
  }
})(window.Legofy = window.Legofy || {});
