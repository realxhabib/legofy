// Image -> 3D brick sculpture.
// The subject is cut out of its background, its silhouette is "inflated" into a rounded solid
// (thickest in the middle, tapering to the edges), and every layer of that solid is tiled with bricks.
(function (L) {
  // Brick footprints [w, d] in studs, both orientations; largest first.
  const FOOTPRINTS = [
    [2, 8], [2, 6], [2, 4], [1, 8], [2, 3], [1, 6], [2, 2], [1, 4], [1, 3], [1, 2], [1, 1],
  ];
  // A brick is 9.6mm tall and a stud 8mm wide.
  L.BRICK_HEIGHT = 1.2;
  // Plates are a third of a brick: building in plates triples the vertical detail (for text).
  L.PLATE_HEIGHT = 0.4;

  // Downscale in halving steps so small grids still average the whole source image.
  function resize(img, cols, rows) {
    let src = img;
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    while (w / 2 > cols * 2 && h / 2 > rows * 2) {
      w = Math.round(w / 2);
      h = Math.round(h / 2);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const cx = c.getContext('2d');
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(src, 0, 0, w, h);
      src = c;
    }
    const out = document.createElement('canvas');
    out.width = cols; out.height = rows;
    const ox = out.getContext('2d', { willReadFrequently: true });
    ox.imageSmoothingQuality = 'high';
    ox.drawImage(src, 0, 0, cols, rows);
    return ox.getImageData(0, 0, cols, rows);
  }

  const labDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // Foreground mask: opaque pixels, minus the background region flood-filled in from the border.
  function subjectMask(imageData, lab, removeBackground) {
    const { width: w, height: h, data } = imageData;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
    if (!removeBackground) return { mask, bg: null };

    const border = [];
    for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
    for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
    const opaqueBorder = border.filter((i) => mask[i]);
    if (!opaqueBorder.length) return { mask, bg: null };

    // The background color is whichever border color most other border pixels agree with.
    let bg = null, bestVotes = -1;
    for (let k = 0; k < opaqueBorder.length; k += Math.max(1, Math.floor(opaqueBorder.length / 60))) {
      const c = lab[opaqueBorder[k]];
      const votes = opaqueBorder.filter((i) => labDist(lab[i], c) < 12).length;
      if (votes > bestVotes) { bestVotes = votes; bg = c; }
    }
    // A busy border (no dominant color) means there's no clean background to remove.
    if (bestVotes < opaqueBorder.length * 0.35) return { mask, bg: null };

    const removed = new Uint8Array(w * h);
    const queue = opaqueBorder.filter((i) => labDist(lab[i], bg) < 20);
    for (const i of queue) removed[i] = 1;
    while (queue.length) {
      const i = queue.pop();
      const x = i % w, y = (i - x) / w;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (removed[n] || !mask[n]) continue;
        if (labDist(lab[n], bg) < 20 && labDist(lab[n], lab[i]) < 10) {
          removed[n] = 1;
          queue.push(n);
        }
      }
    }
    let kept = 0;
    for (let i = 0; i < w * h; i++) kept += mask[i] && !removed[i];
    if (kept < w * h * 0.03) return { mask, bg: null }; // removed nearly everything: the guess was wrong
    for (let i = 0; i < w * h; i++) if (removed[i]) mask[i] = 0;
    return { mask, bg };
  }

  // Distance from point p to the segment a-b in Lab space.
  function segmentDist(p, a, b) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2));
    return labDist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]);
  }

  // Anti-aliased pixels where two very different colors meet (or where the subject meets the
  // background) quantize to an unrelated in-between color, e.g. tan specks around a yellow duck.
  // Snap those pixels to the neighboring color they came from.
  function cleanBlends(grid, lab, w, h, palette, bg) {
    const src = grid.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const c = src[i];
        if (c < 0) continue;
        const counts = new Map();
        let touchesBg = false, same = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const n = src[ny * w + nx];
            if (n < 0) touchesBg = true;
            else if (n === c) same++;
            else counts.set(n, (counts.get(n) || 0) + 1);
          }
        }
        if (same >= 3) continue; // part of a real region of this color
        const ends = [...counts.keys()].map((n) => ({ n, lab: palette[n].lab }));
        if (touchesBg && bg) ends.push({ n: -1, lab: bg });
        let best = null, bestD = 8;
        for (let a = 0; a < ends.length; a++) {
          for (let b = a + 1; b < ends.length; b++) {
            if (labDist(ends[a].lab, ends[b].lab) < 30) continue;
            const d = segmentDist(lab[i], ends[a].lab, ends[b].lab);
            if (d >= bestD) continue;
            bestD = d;
            const [A, B] = [ends[a], ends[b]];
            best = A.n < 0 ? B.n : B.n < 0 ? A.n
              : labDist(lab[i], A.lab) < labDist(lab[i], B.lab) ? A.n : B.n;
          }
        }
        if (best != null) grid[i] = best;
      }
    }
  }

  function nearest(palette, r, g, b) {
    const [l, a, bb] = L.rgbToLab(r, g, b);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i].lab;
      const d = (p[0] - l) ** 2 + (p[1] - a) ** 2 + (p[2] - bb) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // Palette index per pixel, -1 outside the subject.
  function quantize(imageData, mask, palette, dither) {
    const { width: w, height: h, data } = imageData;
    const buf = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      buf[i * 3] = data[i * 4];
      buf[i * 3 + 1] = data[i * 4 + 1];
      buf[i * 3 + 2] = data[i * 4 + 2];
    }
    const grid = new Int16Array(w * h);
    const spread = (x, y, er, eg, eb, f) => {
      if (x < 0 || x >= w || y >= h || !mask[y * w + x]) return;
      const j = (y * w + x) * 3;
      buf[j] += er * f; buf[j + 1] += eg * f; buf[j + 2] += eb * f;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) { grid[i] = -1; continue; }
        const r = Math.min(255, Math.max(0, buf[i * 3]));
        const g = Math.min(255, Math.max(0, buf[i * 3 + 1]));
        const b = Math.min(255, Math.max(0, buf[i * 3 + 2]));
        const idx = nearest(palette, r, g, b);
        grid[i] = idx;
        if (dither) {
          const [pr, pg, pb] = palette[idx].rgb;
          const k = 0.7; // partial error diffusion: smooth gradients without speckling flat areas
          const er = (r - pr) * k, eg = (g - pg) * k, eb = (b - pb) * k;
          spread(x + 1, y, er, eg, eb, 7 / 16);
          spread(x - 1, y + 1, er, eg, eb, 3 / 16);
          spread(x, y + 1, er, eg, eb, 5 / 16);
          spread(x + 1, y + 1, er, eg, eb, 1 / 16);
        }
      }
    }
    return grid;
  }

  // Drop empty margins so the subject stands directly on the baseplate.
  function crop(grid, cols, rows) {
    let x0 = cols, x1 = -1, y0 = rows, y1 = -1;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (grid[y * cols + x] < 0) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    if (x1 < 0) return { grid, cols, rows, x0: 0, y0: 0 };
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const out = new Int16Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) out[y * w + x] = grid[(y + y0) * cols + x + x0];
    }
    return { grid: out, cols: w, rows: h, x0, y0 };
  }

  // Half-thickness (in studs) of the solid at every pixel. Each pixel's distance to the silhouette
  // edge d (in real units, bricks are taller than studs) maps onto a sphere profile sqrt(2Rd - d²),
  // so a disc becomes a ball and thin parts stay slim. The bottom edge counts as solid ground.
  function inflate(grid, cols, rows, thickness, layer) {
    const half = new Int16Array(cols * rows);
    if (thickness <= 0) return half;
    const outside = [];
    const empty = (x, y) => x < 0 || x >= cols || y < 0 || (y < rows && grid[y * cols + x] < 0);
    for (let y = -1; y < rows; y++) {
      for (let x = -1; x <= cols; x++) {
        if (!empty(x, y)) continue;
        const touches = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
          const nx = x + dx, ny = y + dy;
          return nx >= 0 && nx < cols && ny >= 0 && ny < rows && grid[ny * cols + nx] >= 0;
        });
        if (touches) outside.push([x, y * layer]);
      }
    }
    const dist = new Float32Array(cols * rows);
    let R = 0;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (grid[y * cols + x] < 0) continue;
        let d = Infinity;
        const py = y * layer;
        for (const [ox, oy] of outside) d = Math.min(d, Math.hypot(ox - x, oy - py));
        d = Math.max(0, d - 0.5);
        dist[y * cols + x] = d;
        R = Math.max(R, d);
      }
    }
    for (let i = 0; i < cols * rows; i++) {
      if (grid[i] < 0) continue;
      const d = Math.min(dist[i], R);
      half[i] = Math.round(thickness * Math.sqrt(Math.max(0, 2 * R * d - d * d)));
    }
    return half;
  }

  // Greedily cover each layer with the largest same-colored bricks that fit. Alternating the
  // preferred orientation per layer makes bricks overlap the joints below, like a real build.
  // made(color, "AxB"): whether that footprint is really produced in that colour (only real pieces).
  // Tiles one layer with the biggest real pieces, bonding it to the layer below like a brick wall:
  // a piece scores for bridging a joint underneath (tying two pieces below together) and loses points
  // for ending right above one (joints stacked in a line split a wall into separate towers).
  // below: which piece (index into out) fills each cell of the layer underneath, or -1.
  // bonds: optional [cellA, cellB] pairs in this layer that should end up in the same piece (the build
  // check uses them to lock a part that only touches the rest from the side).
  function tileLayer(layer, cols, depth, level, footprints, out, made, below, bonds) {
    const used = new Uint8Array(cols * depth);
    const owner = new Int32Array(cols * depth).fill(-1);
    const along = level % 2 === 0;
    const sizes = [];
    for (const [a, b] of footprints) {
      const first = along ? [b, a] : [a, b];
      sizes.push(first);
      if (a !== b) sizes.push([first[1], first[0]]);
    }
    const sizesFor = new Map(); // colour -> the sizes above that exist in it
    const available = (c) => {
      if (!sizesFor.has(c)) {
        sizesFor.set(c, sizes.filter(([w, d]) => made(c, `${Math.min(w, d)}x${Math.max(w, d)}`)));
      }
      return sizesFor.get(c);
    };
    const fits = (x, z, w, d, c) => {
      if (x + w > cols || z + d > depth) return false;
      for (let zz = z; zz < z + d; zz++) {
        for (let xx = x; xx < x + w; xx++) {
          const i = zz * cols + xx;
          if (used[i] || layer[i] !== c) return false;
        }
      }
      return true;
    };
    const open = (xx, zz) => xx >= 0 && zz >= 0 && xx < cols && zz < depth && layer[zz * cols + xx] >= 0;
    const ownersBelow = new Set();
    const inside = (k, x, z, w, d) => {
      const kx = k % cols, kz = Math.floor(k / cols);
      return kx >= x && kx < x + w && kz >= z && kz < z + d;
    };
    const score = (x, z, w, d) => {
      let s = w * d;
      if (bonds) for (const [a, b] of bonds) if (inside(a, x, z, w, d) && inside(b, x, z, w, d)) s += 60;
      if (!below) return s;
      ownersBelow.clear();
      for (let zz = z; zz < z + d; zz++) for (let xx = x; xx < x + w; xx++) {
        const o = below[zz * cols + xx];
        if (o >= 0) ownersBelow.add(o);
      }
      if (ownersBelow.size) s += 20 + 8 * (ownersBelow.size - 1); // rests on something, ties pieces together
      // Edges that sit exactly over a joint in the layer below, where this layer continues.
      const joint = (ax, az, bx, bz) => {
        if (!open(bx, bz)) return 0;
        const oa = below[az * cols + ax], ob = below[bz * cols + bx];
        return oa >= 0 && ob >= 0 && oa !== ob ? 1 : 0;
      };
      let stacked = 0;
      for (let zz = z; zz < z + d; zz++) stacked += joint(x, zz, x - 1, zz) + joint(x + w - 1, zz, x + w, zz);
      for (let xx = x; xx < x + w; xx++) stacked += joint(xx, z, xx, z - 1) + joint(xx, z + d - 1, xx, z + d);
      return s - 5 * stacked;
    };
    const put = (x, z, w, d, c) => {
      const id = out.length;
      for (let zz = z; zz < z + d; zz++) for (let xx = x; xx < x + w; xx++) { used[zz * cols + xx] = 1; owner[zz * cols + xx] = id; }
      out.push({ x, z, level, w, d, color: c });
    };
    // Seams to lock first: one piece straddling both cells.
    if (bonds) {
      for (const [a, b] of bonds) {
        const c = layer[a];
        if (c < 0 || layer[b] !== c || used[a] || used[b]) continue;
        const x = Math.min(a % cols, b % cols), z = Math.min(Math.floor(a / cols), Math.floor(b / cols));
        const w = a % cols === b % cols ? 1 : 2, d = w === 1 ? 2 : 1;
        if (made(c, '1x2')) put(x, z, w, d, c);
      }
    }
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < cols; x++) {
        const i = z * cols + x;
        if (used[i] || layer[i] < 0) continue;
        const c = layer[i];
        let best = null, bestScore = -Infinity;
        for (const [w, d] of available(c)) {
          if (!fits(x, z, w, d, c)) continue;
          const sc = score(x, z, w, d);
          if (sc > bestScore) { bestScore = sc; best = [w, d]; }
        }
        const [w, d] = best || [1, 1];
        put(x, z, w, d, c);
      }
    }
    return owner;
  }

  // Every order builds layer by layer from the bottom (the build check then moves any piece that has
  // nothing under it to right after the piece it hangs from).
  const ORDERS = {
    sweep: (bricks) => bricks.sort((a, b) => a.level - b.level || a.z - b.z || a.x - b.x),
    zigzag: (bricks) => bricks.sort((a, b) =>
      a.level - b.level || a.z - b.z || ((a.level + a.z) % 2 ? b.x - a.x : a.x - b.x)),
    'center-out': (bricks, cols, depth) => {
      const r = (b) => Math.hypot(b.x + b.w / 2 - cols / 2, b.z + b.d / 2 - depth / 2);
      return bricks.sort((a, b) => a.level - b.level || r(a) - r(b));
    },
    'outside-in': (bricks, cols, depth) => {
      const r = (b) => Math.hypot(b.x + b.w / 2 - cols / 2, b.z + b.d / 2 - depth / 2);
      return bricks.sort((a, b) => a.level - b.level || r(b) - r(a));
    },
    random: (bricks) => {
      const key = new Map(bricks.map((b) => [b, Math.random()]));
      return bricks.sort((a, b) => a.level - b.level || key.get(a) - key.get(b));
    },
  };

  // Average of a per-pixel map over each grid cell (the image is w×h, the grid cols×rows).
  function perCell(map, w, h, cols, rows) {
    const out = new Float32Array(cols * rows);
    for (let y = 0; y < rows; y++) {
      const y0 = Math.floor((y * h) / rows), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / rows));
      for (let x = 0; x < cols; x++) {
        const x0 = Math.floor((x * w) / cols), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / cols));
        let sum = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { sum += map[yy * w + xx]; n++; }
        out[y * cols + x] = sum / n;
      }
    }
    return out;
  }

  // Depth per grid cell from the object's own pixels only, taking a near-side value (30th percentile):
  // the depth model blurs object edges into the far background, which an average would pick up.
  function perCellDepth(dist, mask, w, h, cols, rows) {
    const out = new Float32Array(cols * rows);
    const vals = [];
    for (let y = 0; y < rows; y++) {
      const y0 = Math.floor((y * h) / rows), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / rows));
      for (let x = 0; x < cols; x++) {
        const x0 = Math.floor((x * w) / cols), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / cols));
        vals.length = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) if (!mask || mask[yy * w + xx] >= 0.5) vals.push(dist[yy * w + xx]);
        if (!vals.length) for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) vals.push(dist[yy * w + xx]);
        vals.sort((a, b) => a - b);
        out[y * cols + x] = vals[Math.floor(vals.length * 0.3)];
      }
    }
    return out;
  }

  // Otsu's threshold: the split of the values into two groups (near / far) with the clearest gap.
  function otsu(values) {
    let lo = Infinity, hi = -Infinity;
    for (const v of values) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const bins = 64, hist = new Float64Array(bins);
    for (const v of values) hist[Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo || 1)) * bins))]++;
    const total = values.length;
    let sum = 0;
    for (let i = 0; i < bins; i++) sum += i * hist[i];
    let wB = 0, sumB = 0, best = 0, split = bins / 2;
    for (let i = 0; i < bins; i++) {
      wB += hist[i];
      if (!wB || wB === total) continue;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / (total - wB);
      const between = wB * (total - wB) * (mB - mF) ** 2;
      if (between > best) { best = between; split = i + 1; }
    }
    return lo + (split / bins) * (hi - lo);
  }

  // relief: { dist, f } from a spatial photo — per-pixel relative distance for `img` and its focal
  // length in pixels. The front of the sculpture then follows the measured surface instead of being
  // inflated, and the hidden back is mirrored about the silhouette's depth (a ball stays a ball).
  L.buildSculpture = function (img, {
    cols: width, thickness = 0.5, removeBackground = true, hollow = true, dither = false, onlySingles = false,
    order = 'sweep', relief = null, layer = L.BRICK_HEIGHT,
  }) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const fullRows = Math.max(1, Math.round((width * ih) / iw / layer));
    const palette = L.PALETTE;
    const pixels = resize(img, width, fullRows);
    const lab = [];
    for (let i = 0; i < width * fullRows; i++) {
      lab.push(L.rgbToLab(pixels.data[i * 4], pixels.data[i * 4 + 1], pixels.data[i * 4 + 2]));
    }
    const { mask, bg } = subjectMask(pixels, lab, removeBackground);
    let cellDist = null;
    if (relief) {
      cellDist = perCellDepth(relief.dist, relief.mask, iw, ih, width, fullRows);
      if (relief.mask) {
        // The subject was already cut out (segmenter on the photo): use that outline.
        const cellMask = perCell(relief.mask, iw, ih, width, fullRows);
        for (let i = 0; i < mask.length; i++) mask[i] = cellMask[i] >= 0.5 ? 1 : 0;
      } else if (removeBackground) {
        // Depth separates the subject from what's behind it far better than colour can.
        const cut = otsu(cellDist);
        let kept = 0;
        for (let i = 0; i < mask.length; i++) { if (cellDist[i] > cut) mask[i] = 0; kept += mask[i]; }
        if (kept < mask.length * 0.02) for (let i = 0; i < mask.length; i++) mask[i] = 1; // gave up: keep all
      }
    }
    const colors = quantize(pixels, mask, palette, dither);
    if (!dither) cleanBlends(colors, lab, width, fullRows, palette, bg);
    const { grid, cols, rows, x0, y0 } = crop(colors, width, fullRows);
    if (relief) {
      return L.bricksFromVolume(reliefVolume(grid, cols, rows, cellDist, width, x0, y0, iw / width, relief.f),
        { hollow, onlySingles, order, layer });
    }
    const half = inflate(grid, cols, rows, thickness, layer);

    let maxHalf = 0;
    for (let i = 0; i < half.length; i++) maxHalf = Math.max(maxHalf, half[i]);
    const depth = maxHalf * 2 + 1;

    const volume = { cols, rows, depth, voxels: new Int16Array(cols * rows * depth).fill(-1) };
    for (let level = 0; level < rows; level++) {
      const y = rows - 1 - level;
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (grid[i] < 0) continue;
        for (let z = maxHalf - half[i]; z <= maxHalf + half[i]; z++) {
          volume.voxels[(level * depth + z) * cols + x] = grid[i];
        }
      }
    }
    return L.bricksFromVolume(volume, { hollow, onlySingles, order, layer });
  };

  // Front surface from measured depth, back mirrored about the silhouette's depth.
  function reliefVolume(grid, cols, rows, cellDist, fullCols, x0, y0, pxPerCell, f) {
    const at = (x, y) => cellDist[(y + y0) * fullCols + x + x0];
    const cells = [];
    for (let i = 0; i < grid.length; i++) if (grid[i] >= 0) cells.push(at(i % cols, Math.floor(i / cols)));
    cells.sort((a, b) => a - b);
    // Clamp to the 3rd–97th percentile so a few stray pixels can't stretch the whole sculpture.
    const nearest = cells[Math.floor(cells.length * 0.03)], farthest = cells[Math.floor(cells.length * 0.97)];
    const typical = cells[cells.length >> 1];
    // A stud is pxPerCell pixels wide at the object's distance, so a change in distance Δ (same unit as
    // the distance) spans f·Δ / (pxPerCell·typical) studs.
    const front = new Int16Array(grid.length);
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] < 0) continue;
      const d = Math.min(farthest, Math.max(nearest, at(i % cols, Math.floor(i / cols))));
      front[i] = Math.round((f * (d - nearest)) / (pxPerCell * typical));
    }
    // The silhouette sits at the object's widest part: its depth is where the back mirrors about.
    const edge = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (grid[i] < 0) continue;
        const out = (xx, yy) => xx < 0 || yy < 0 || xx >= cols || yy >= rows || grid[yy * cols + xx] < 0;
        if (out(x - 1, y) || out(x + 1, y) || out(x, y - 1)) edge.push(front[i]);
      }
    }
    edge.sort((a, b) => a - b);
    const mid = edge.length ? edge[edge.length >> 1] : 0;
    let deepest = 0;
    const back = new Int16Array(grid.length);
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] < 0) continue;
      back[i] = Math.max(front[i], 2 * mid - front[i]);
      deepest = Math.max(deepest, back[i]);
    }
    const depth = deepest + 1;
    const voxels = new Int16Array(cols * rows * depth).fill(-1);
    for (let level = 0; level < rows; level++) {
      const y = rows - 1 - level;
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (grid[i] < 0) continue;
        // z grows toward the viewer, so the nearest surface gets the largest z.
        for (let s = front[i]; s <= back[i]; s++) voxels[(level * depth + (depth - 1 - s)) * cols + x] = grid[i];
      }
    }
    return { cols, rows, depth, voxels };
  }

  // Solid color volume -> bricks. voxels[(level * depth + z) * cols + x] is a palette index or -1.
  // force: optional Uint8Array over the voxels; 1 keeps that voxel even inside a hollow model (the build
  // check uses it for hidden pieces that tie loose parts on).
  L.bricksFromVolume = function ({ cols, rows, depth, voxels }, {
    hollow = true, onlySingles = false, order = 'sweep', layer: layerHeight = L.BRICK_HEIGHT, force = null, bonds = null,
  }) {
    // Below the bottom layer is the baseplate, which counts as solid.
    const solid = (x, level, z) => {
      if (level < 0) return true;
      if (x < 0 || x >= cols || level >= rows || z < 0 || z >= depth) return false;
      return voxels[(level * depth + z) * cols + x] >= 0;
    };
    // Hollow: keep only voxels that touch the outside, like a real brick-built sculpture. "Touch" includes
    // along an edge, not just a face: where two shapes meet (a stem under a cap), the pieces in the
    // inner corner are what joins them, and a curved wall stays continuous instead of meeting at corners.
    const air = (x, level, z) => !solid(x, level, z);
    const visible = (x, level, z) => {
      if (!hollow) return true;
      for (let dl = -1; dl <= 1; dl++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if ((dl && dz && dx) || !(dl || dz || dx)) continue; // 18 neighbours: faces and edges
        if (air(x + dx, level + dl, z + dz)) return true;
      }
      return false;
    };
    // ...plus a second layer under roofs and over overhangs: a single layer of pieces side by side isn't
    // held together by anything, two layers with crossing joints are.
    const keep = (x, level, z) => visible(x, level, z) || (force && force[(level * depth + z) * cols + x]) ||
      (solid(x, level + 1, z) && air(x, level + 2, z)) || (solid(x, level - 1, z) && air(x, level - 2, z));

    const kind = layerHeight < L.BRICK_HEIGHT ? 'plate' : 'brick';
    const made = (c, size) => {
      const m = L.PALETTE[c].made;
      return !m || m[kind].has(size);
    };
    const bricks = [];
    const layer = new Int16Array(cols * depth);
    const footprints = onlySingles ? [[1, 1]] : FOOTPRINTS;
    let below = null;
    const at = (x, level, z) => voxels[(level * depth + z) * cols + x];
    for (let level = 0; level < rows; level++) {
      layer.fill(-1);
      for (let z = 0; z < depth; z++) {
        for (let x = 0; x < cols; x++) {
          const c = at(x, level, z);
          if (c >= 0 && keep(x, level, z)) layer[z * cols + x] = c;
        }
      }
      below = tileLayer(layer, cols, depth, level, footprints, bricks, made, below, bonds && bonds.get(level));
    }
    ORDERS[order](bricks, cols, depth);
    bricks.forEach((b, i) => { b.step = i; });

    // Solid and outer-shell voxel counts, for scaling estimates (e.g. "how many at real size?").
    let solidVoxels = 0, shellVoxels = 0;
    for (let level = 0; level < rows; level++) {
      for (let z = 0; z < depth; z++) {
        for (let x = 0; x < cols; x++) {
          if (voxels[(level * depth + z) * cols + x] < 0) continue;
          solidVoxels++;
          if (!(solid(x - 1, level, z) && solid(x + 1, level, z) && solid(x, level - 1, z) &&
            solid(x, level + 1, z) && solid(x, level, z - 1) && solid(x, level, z + 1))) shellVoxels++;
        }
      }
    }
    // layerHeight: 1.2 for bricks, 0.4 for plates (studs units); piece: what to call each part.
    const plates = layerHeight < L.BRICK_HEIGHT;
    return {
      cols, rows, depth, bricks, palette: L.PALETTE, stats: { solidVoxels, shellVoxels },
      layerHeight, piece: plates ? 'plate' : 'brick', pieces: plates ? 'plates' : 'bricks',
    };
  };

  L.nearestColor = (r, g, b) => nearest(L.PALETTE, r, g, b);

  // Aggregate bricks into a parts list keyed by color + footprint.
  // kind: 'brick' or 'plate'. Each entry carries the official part number (e.g. 3001 = Brick 2 x 4).
  L.partsList = function (bricks, palette, kind = 'brick') {
    const map = new Map();
    for (const b of bricks) {
      const a = Math.min(b.w, b.d), c = Math.max(b.w, b.d);
      const key = `${b.color}:${a}x${c}`;
      b.partKey = key;
      b.size = `${a} × ${c}`;
      if (!map.has(key)) {
        const partNum = L.PARTS ? L.PARTS[kind][`${a}x${c}`] : null;
        map.set(key, { key, color: palette[b.color], a, c, size: b.size, kind, partNum, total: 0, placed: 0 });
      }
      map.get(key).total++;
    }
    return [...map.values()].sort((p, q) => q.total - p.total || q.a * q.c - p.a * p.c);
  };
})(window.Legofy = window.Legofy || {});
