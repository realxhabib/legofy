// Image -> stud grid -> an upright wall of 1×N bricks with a bottom-up build order.
(function (L) {
  // Real 1×N brick lengths, longest first.
  const BRICK_LENGTHS = [8, 6, 4, 3, 2, 1];
  // A brick is 9.6mm tall and 8mm wide, so each "pixel" of the wall is taller than it is wide.
  L.BRICK_HEIGHT = 1.2;

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

  // Split each same-color run of every row into bricks, preferring long bricks whose
  // ends don't line up with a joint in the row below (staggered, like a real wall).
  function tile(grid, cols, rows, lengths) {
    const bricks = [];
    let jointsBelow = new Set();
    for (let level = 0; level < rows; level++) {
      const y = rows - 1 - level;
      const joints = new Set();
      let x = 0;
      while (x < cols) {
        const c = grid[y * cols + x];
        if (c < 0) { x++; continue; }
        let end = x;
        while (end < cols && grid[y * cols + end] === c) end++;
        while (x < end) {
          const fitting = lengths.filter((n) => x + n <= end);
          const n = fitting.find((n) => x + n === end || !jointsBelow.has(x + n)) || fitting[0];
          bricks.push({ x, y, level, w: n, h: 1, color: c });
          x += n;
          joints.add(x);
        }
      }
      jointsBelow = joints;
    }
    return bricks;
  }

  // Every order builds row by row from the bottom, so no brick ever floats.
  const ORDERS = {
    'left-right': (bricks) => bricks.sort((a, b) => a.level - b.level || a.x - b.x),
    zigzag: (bricks) => bricks.sort((a, b) =>
      a.level - b.level || (a.level % 2 ? b.x - a.x : a.x - b.x)),
    'center-out': (bricks, cols) => {
      const d = (b) => Math.abs(b.x + b.w / 2 - cols / 2);
      return bricks.sort((a, b) => a.level - b.level || d(a) - d(b));
    },
    random: (bricks) => {
      const key = new Map(bricks.map((b) => [b, Math.random()]));
      return bricks.sort((a, b) => a.level - b.level || key.get(a) - key.get(b));
    },
  };

  // Drop fully transparent margins so the subject stands directly on the baseplate.
  function crop(grid, cols, rows) {
    let x0 = cols, x1 = -1, y0 = rows, y1 = -1;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (grid[y * cols + x] < 0) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    if (x1 < 0) return { grid, cols, rows };
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const out = new Int16Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) out[y * w + x] = grid[(y + y0) * cols + x + x0];
    }
    return { grid: out, cols: w, rows: h };
  }

  L.buildMosaic = function (img, { cols: width, dither = false, onlySingles = false, order = 'left-right' }) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const fullRows = Math.max(1, Math.round((width * ih) / iw / L.BRICK_HEIGHT));
    const palette = L.PALETTE;
    const { grid, cols, rows } = crop(quantize(resize(img, width, fullRows), palette, dither), width, fullRows);
    const lengths = onlySingles ? [1] : BRICK_LENGTHS;
    const bricks = ORDERS[order](tile(grid, cols, rows, lengths), cols);
    bricks.forEach((b, i) => { b.step = i; });
    return { cols, rows, grid, bricks, palette };
  };

  // Aggregate bricks into a parts list keyed by color + length.
  L.partsList = function (bricks, palette) {
    const map = new Map();
    for (const b of bricks) {
      const key = `${b.color}:${b.w}`;
      b.partKey = key;
      if (!map.has(key)) {
        map.set(key, { key, color: palette[b.color], length: b.w, size: `1 × ${b.w}`, total: 0, placed: 0 });
      }
      map.get(key).total++;
    }
    return [...map.values()].sort((p, q) => q.total - p.total || q.length - p.length);
  };
})(window.Legofy = window.Legofy || {});
