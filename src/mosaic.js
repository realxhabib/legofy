// Image -> stud grid -> list of bricks with a build order.
(function (L) {
  // Plate footprints [w, h] in studs, largest first so the tiler prefers big pieces.
  const BRICK_SIZES = [
    [2, 8], [8, 2], [2, 6], [6, 2], [2, 4], [4, 2], [1, 8], [8, 1],
    [2, 3], [3, 2], [1, 6], [6, 1], [2, 2], [1, 4], [4, 1],
    [1, 3], [3, 1], [1, 2], [2, 1], [1, 1],
  ].sort((a, b) => b[0] * b[1] - a[0] * a[1]);

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

  // Returns Int16Array of palette indices per stud, -1 for transparent (empty) studs.
  function quantize(imageData, palette, dither) {
    const { width: w, height: h, data } = imageData;
    const buf = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      buf[i * 3] = data[i * 4];
      buf[i * 3 + 1] = data[i * 4 + 1];
      buf[i * 3 + 2] = data[i * 4 + 2];
    }
    const grid = new Int16Array(w * h);
    const spread = (x, y, er, eg, eb, f) => {
      if (x < 0 || x >= w || y >= h) return;
      const j = (y * w + x) * 3;
      buf[j] += er * f; buf[j + 1] += eg * f; buf[j + 2] += eb * f;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (data[i * 4 + 3] < 128) { grid[i] = -1; continue; }
        const r = Math.min(255, Math.max(0, buf[i * 3]));
        const g = Math.min(255, Math.max(0, buf[i * 3 + 1]));
        const b = Math.min(255, Math.max(0, buf[i * 3 + 2]));
        const idx = nearest(palette, r, g, b);
        grid[i] = idx;
        if (dither) {
          // partial error diffusion: smooth gradients without speckling flat areas
          const [pr, pg, pb] = palette[idx].rgb;
          const k = 0.7;
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

  // Greedily cover same-colored regions with the largest plates that fit.
  function tile(grid, cols, rows, sizes) {
    const used = new Uint8Array(cols * rows);
    const bricks = [];
    const fits = (x, y, w, h, c) => {
      if (x + w > cols || y + h > rows) return false;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const i = yy * cols + xx;
          if (used[i] || grid[i] !== c) return false;
        }
      }
      return true;
    };
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (used[i] || grid[i] < 0) continue;
        const c = grid[i];
        for (const [w, h] of sizes) {
          if (!fits(x, y, w, h, c)) continue;
          for (let yy = y; yy < y + h; yy++) {
            for (let xx = x; xx < x + w; xx++) used[yy * cols + xx] = 1;
          }
          bricks.push({ x, y, w, h, color: c });
          break;
        }
      }
    }
    return bricks;
  }

  const ORDERS = {
    'bottom-up': (bricks) =>
      bricks.sort((a, b) => (b.y + b.h) - (a.y + a.h) || a.x - b.x),
    'top-down': (bricks) =>
      bricks.sort((a, b) => a.y - b.y || a.x - b.x),
    'by-color': (bricks) => {
      const count = {};
      for (const b of bricks) count[b.color] = (count[b.color] || 0) + b.w * b.h;
      return bricks.sort((a, b) =>
        count[b.color] - count[a.color] || a.color - b.color ||
        (b.y + b.h) - (a.y + a.h) || a.x - b.x);
    },
    'center-out': (bricks, cols, rows) => {
      const d = (b) => Math.hypot(b.x + b.w / 2 - cols / 2, b.y + b.h / 2 - rows / 2);
      return bricks.sort((a, b) => d(a) - d(b));
    },
    random: (bricks) => {
      for (let i = bricks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bricks[i], bricks[j]] = [bricks[j], bricks[i]];
      }
      return bricks;
    },
  };

  L.buildMosaic = function (img, { cols, dither = false, onlySingles = false, order = 'bottom-up' }) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const rows = Math.max(1, Math.round(cols * ih / iw));
    const palette = L.PALETTE;
    const grid = quantize(resize(img, cols, rows), palette, dither);
    const sizes = onlySingles ? [[1, 1]] : BRICK_SIZES;
    const bricks = ORDERS[order](tile(grid, cols, rows, sizes), cols, rows);
    bricks.forEach((b, i) => { b.step = i; });
    return { cols, rows, grid, bricks, palette };
  };

  // Aggregate bricks into a parts list keyed by color + footprint.
  L.partsList = function (bricks, palette) {
    const map = new Map();
    for (const b of bricks) {
      const a = Math.min(b.w, b.h), c = Math.max(b.w, b.h);
      const key = `${b.color}:${a}x${c}`;
      b.partKey = key;
      if (!map.has(key)) {
        map.set(key, { key, color: palette[b.color], size: `${a} × ${c}`, area: a * c, total: 0, placed: 0 });
      }
      map.get(key).total++;
    }
    return [...map.values()].sort((p, q) => q.total - p.total || q.area - p.area);
  };
})(window.Legofy = window.Legofy || {});
