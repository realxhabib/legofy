// Walk-around scanning in the browser, no markers and no upload.
//
// Where is the camera? The phone's motion sensors give its orientation, and because the user keeps
// the object in view while walking around it, the camera must sit on the ray through the object's
// silhouette at a steady distance. What is the object? An on-device segmenter cuts it out of each
// frame (the user taps it once, after that we follow its silhouette). Every captured view then
// carves away voxels that it sees background through (a "visual hull"), and the surviving surface
// takes its colors from the views that face it most directly.
(function (L) {
  const FOV_LONG = (67 * Math.PI) / 180; // typical phone main camera, across the long side of the frame
  const G = 64;                           // carving resolution per axis
  const ANALYSIS_LONG_SIDE = 400;         // frames are analysed at this size (px)
  const MIN_NEW_ANGLE = (7 * Math.PI) / 180;
  const MIN_DIP = (12 * Math.PI) / 180;    // below this, looking down says too little about distance
  const WIDE_SCALES = [0.3, 0.38, 0.47, 0.57, 0.68, 0.8, 0.9, 1, 1.12, 1.27, 1.45, 1.7, 2, 2.4];
  const REFINE_SCALES = [0.75, 0.83, 0.9, 0.95, 1, 1.05, 1.11, 1.2, 1.33];
  const FINE_SCALES = [0.9, 0.94, 0.97, 1, 1.03, 1.07, 1.11];

  // ---------- reconstruction ----------

  function maskStats(mask, w, h) {
    let area = 0, sx = 0, sy = 0, minX = w, maxX = -1, minY = h, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x] < 0.5) continue;
        area++; sx += x; sy += y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (!area) return { area };
    // How much of the silhouette runs off the frame (tables and walls do; a framed object doesn't).
    let edge = 0;
    for (let x = 0; x < w; x++) edge += (mask[x] >= 0.5) + (mask[(h - 1) * w + x] >= 0.5);
    for (let y = 0; y < h; y++) edge += (mask[y * w] >= 0.5) + (mask[y * w + w - 1] >= 0.5);
    // Widest extent of the silhouette just above its lowest row: roughly the base's width.
    let baseHalf = 0;
    const cx = sx / area;
    for (let y = Math.max(minY, maxY - 3); y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (mask[y * w + x] >= 0.5) baseHalf = Math.max(baseHalf, Math.abs(x + 0.5 - cx));
      }
    }
    return { area, cx, cy: sy / area, minX, maxX, minY, maxY, baseHalf, edge };
  }

  // Threshold, then grow the silhouette a little so small pose errors don't eat into the object.
  function binarize(mask, w, h, grow) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x] < 0.5) continue;
        for (let dy = -grow; dy <= grow; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -grow; dx <= grow; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < w) out[yy * w + xx] = 1;
          }
        }
      }
    }
    return out;
  }

  // Pixels safely inside the silhouette, away from its edge: the only ones trusted for color.
  function core(mask, w, h, shrink) {
    const background = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) background[i] = mask[i] >= 0.5 ? 0 : 1;
    const grown = binarize(background, w, h, shrink);
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = grown[i] ? 0 : 1;
    return out;
  }

  const rotate = (R, v) => [
    R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
    R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
    R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
  ];
  const normalize = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

  class Carver {
    constructor() {
      this.all = [];   // every accepted capture, in order
      this.views = []; // the ones currently used (the user can switch any off during review)
      // Colour models learned from accepted captures: what the object looks like, and what's around it.
      this.objectColors = new Float32Array(4096);
      this.backgroundColors = new Float32Array(4096);
    }

    get count() { return this.views.length; }

    // Camera looking straight along -Z of its rotation; forward vector in world space.
    static forward(R) { return [-R[2], -R[5], -R[8]]; }

    // True when a camera with rotation R would see the object from a new enough direction.
    isNewDirection(R) {
      const f = Carver.forward(R);
      return this.views.every((v) => {
        const g = Carver.forward(v.R);
        return Math.acos(Math.max(-1, Math.min(1, f[0] * g[0] + f[1] * g[1] + f[2] * g[2]))) > MIN_NEW_ANGLE;
      });
    }

    // image: ImageData; mask: per-pixel object confidence (0..1), same size as the image;
    // rotation: 3×3 row-major camera→world (camera looks down its -Z, image up is +Y, world +Y is up).
    // Returns the new view (with its .stats), or null when it was rejected.
    // `anchored`: the user pointed at the object for this capture (the first tap, or a re-tap), so it
    // is trusted: it skips the consistency check and teaches us what the object's colours are.
    addView(capture, { anchored = false } = {}) {
      const view = this.tryView(capture, anchored);
      if (view) this.learnColors(view, anchored);
      return view;
    }

    tryView({ image, mask, rotation }, anchored) {
      const { width: w, height: h } = image;
      const stats = maskStats(mask, w, h);
      if (stats.area < w * h * 0.005 || stats.area > w * h * 0.8) return null;
      if (stats.edge > (w + h) * 0.04) return null;
      // Between captures the phone turns only ~10°, so the outline should look much like the last
      // one. A sudden change (the sign plus a cloud beside it) means the finder grabbed background.
      // (If the outline really does change fast, the scanner asks the user to tap the object instead.)
      const prev = this.all[this.all.length - 1];
      if (prev && !anchored && shapeSimilarity(prev, mask, stats) < 0.55) return null;
      const f = Math.max(w, h) / 2 / Math.tan(FOV_LONG / 2);
      const R = Float64Array.from(rotation);
      // The object's centre lies on the ray through the silhouette centroid.
      const dir = normalize(rotate(R, [(stats.cx + 0.5 - w / 2) / f, -(stats.cy + 0.5 - h / 2) / f, -1]));

      if (!this.all.length) {
        // Units: the object is about 2 across in this first view.
        const halfH = (stats.maxY - stats.minY + 1) / 2 / f;
        const halfW = (stats.maxX - stats.minX + 1) / 2 / f;
        this.distance = 1 / halfH;
        this.half = 1.8 * Math.max(1, halfW * this.distance);
        this.step = (2 * this.half) / G;
        this.outside = new Uint16Array(G * G * G);
        this.seen = new Uint16Array(G * G * G);
        // People hold the phone at a fairly steady height while walking around, so when looking down
        // at the object, how steeply we look down tells us how far away we are.
        const dip = Math.asin(Math.max(-1, Math.min(1, -dir[1])));
        this.cameraHeight = dip > MIN_DIP ? this.distance * Math.sin(dip) : 0;
      }
      const grow = Math.max(1, Math.round(w / 150));
      const view = { image, bin: binarize(mask, w, h, grow), w, h, f, R, dir, stats };
      let dist = this.distanceFor(dir);
      if (this.yawBins().size >= 12) {
        // Seen from half the way round, the shape is trustworthy: find this camera's distance by
        // matching its cut-out to the shape. (Earlier, the loose shape would bias this.)
        // This copes with walking closer, crouching down, or raising the phone.
        const fit = this.fitDistance(view, this.solidList(), dist, WIDE_SCALES);
        if (fit.score < 0.35) return null; // matches nothing we've seen: probably the wrong thing
        dist = fit.dist;
      } else if (this.views.length >= 3) {
        // Early on, a cut-out far bigger or smaller than the others (allowing for distance) is suspect.
        const sizes = this.views.map((v) => v.stats.area * v.dist * v.dist).sort((a, b) => a - b);
        const median = sizes[sizes.length >> 1], size = stats.area * dist * dist;
        if (size > median * 3 || size < median / 3) return null;
      }
      view.dist = view.base = dist;
      view.pos = [-dir[0] * dist, -dir[1] * dist, -dir[2] * dist];
      view.core = core(mask, w, h, grow + 1);
      // Once a quarter of the way round, a cut-out that spills well outside the shape so far has
      // grabbed background (sky next to a white sign, the floor under a shoe): skip it.
      if (this.yawBins().size >= 6 && this.agreement(view).extra > 0.45) return null;
      // Once the shape is established, a cut-out that misses a big part of what the shape says should
      // be visible (e.g. only the lid of a jar) would wrongly carve that part away, so skip it.
      if (this.yawBins().size >= 12 && this.coverageOf(view) < 0.6) return null;
      view.enabled = true;
      view.index = this.all.length;
      this.all.push(view);
      this.views.push(view);
      this.carve(view, 1);
      return view;
    }

    // Camera distance to the object centre for a view looking along `dir`.
    distanceFor(dir) {
      const dip = Math.asin(Math.max(-1, Math.min(1, -dir[1])));
      if (!this.cameraHeight || dip <= MIN_DIP) return this.distance;
      return Math.min(2 * this.distance, Math.max(0.5 * this.distance, this.cameraHeight / Math.sin(dip)));
    }

    // Fine-tune every capture's distance so its cut-out best matches the shape seen by all the others
    // (people drift closer and further, and hold the phone higher or lower, as they walk).
    solidList() {
      const solids = [];
      for (let i = 0; i < this.outside.length; i++) if (this.solidAt(i)) solids.push(i);
      return solids;
    }

    // Try the view at several distances along its ray; keep the one whose projected shape overlaps
    // its cut-out best (intersection over union).
    fitDistance(view, solids, base, scales) {
      const p = [0, 0, 0];
      const hit = new Uint8Array(view.w * view.h);
      const r = Math.max(0, Math.round((view.f * this.step) / base / 2));
      let best = base, bestScore = -1, baseScore = 0;
      for (const k of scales) {
        const d = base * k;
        const trial = { ...view, pos: [-view.dir[0] * d, -view.dir[1] * d, -view.dir[2] * d] };
        hit.fill(0);
        for (const i of solids) {
          const px = this.project(trial, this.center(i, p));
          if (px < 0) continue;
          hit[px] = 1;
          if (r) { // splat so a far-away shape doesn't turn into a sparse dot cloud
            const u = px % view.w, v = (px - u) / view.w;
            for (let dy = -r; dy <= r; dy++) {
              for (let dx = -r; dx <= r; dx++) {
                const x = u + dx, y = v + dy;
                if (x >= 0 && y >= 0 && x < view.w && y < view.h) hit[y * view.w + x] = 1;
              }
            }
          }
        }
        let both = 0, either = 0;
        for (let q = 0; q < hit.length; q++) {
          const a = hit[q], b = view.bin[q];
          both += a & b; either += a | b;
        }
        const score = either ? both / either : 0;
        if (k === 1) baseScore = score;
        if (score > bestScore) { bestScore = score; best = d; }
      }
      return { dist: best, score: bestScore, baseScore };
    }

    async refine(onProgress) {
      for (let pass = 0; pass < 2; pass++) {
        for (let n = 0; n < this.views.length; n++) {
          const view = this.views[n];
          this.carve(view, -1);
          const fit = this.fitDistance(view, this.solidList(), view.dist, pass ? FINE_SCALES : REFINE_SCALES);
          // Only move a capture when it clearly fits better; small gains are mostly segmentation noise.
          const best = fit.score - fit.baseScore > 0.03 ? fit.dist : view.dist;
          view.dist = best;
          view.pos = [-view.dir[0] * best, -view.dir[1] * best, -view.dir[2] * best];
          this.carve(view, 1);
          if (onProgress) onProgress((pass * this.views.length + n + 1) / (2 * this.views.length));
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }

    learnColors(view, anchored) {
      const { image, core: inside, bin, w, h, stats } = view;
      const d = image.data;
      // Background: a band around the outline, about a fifth of the object's size wide.
      const band = Math.max(3, Math.round(Math.max(stats.maxX - stats.minX, stats.maxY - stats.minY) * 0.2));
      const x0 = Math.max(0, stats.minX - band), x1 = Math.min(w - 1, stats.maxX + band);
      const y0 = Math.max(0, stats.minY - band), y1 = Math.min(h - 1, stats.maxY + band);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * w + x;
          const c = ((d[i * 4] >> 4) << 8) | ((d[i * 4 + 1] >> 4) << 4) | (d[i * 4 + 2] >> 4);
          if (inside[i]) { if (anchored) this.objectColors[c]++; } else if (!bin[i]) this.backgroundColors[c]++;
        }
      }
      this.objectTotal = this.objectColors.reduce((a, b) => a + b, 0);
      this.backgroundTotal = this.backgroundColors.reduce((a, b) => a + b, 0);
    }

    // True for a pixel colour that's far more typical of the surroundings than of the object.
    looksLikeBackground(r, g, b) {
      if (!this.objectTotal || !this.backgroundTotal) return false;
      const c = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const po = (this.objectColors[c] + 0.5) / this.objectTotal;
      const pb = (this.backgroundColors[c] + 0.5) / this.backgroundTotal;
      return pb > po * 6;
    }

    // Leave a capture out (or put it back). Its carving votes are simply taken back.
    setEnabled(view, on) {
      if (view.enabled === on) return;
      view.enabled = on;
      this.carve(view, on ? 1 : -1);
      this.views = this.all.filter((v) => v.enabled);
    }

    // How well a capture agrees with the shape built from the captures in use: `missing` is the share
    // of the shape its cut-out leaves out, `extra` the share of its cut-out that isn't the shape.
    agreement(view) {
      const predicted = this.predictedSilhouette(view);
      let shape = 0, covered = 0, cut = 0, extra = 0;
      for (let k = 0; k < predicted.length; k++) {
        if (predicted[k]) { shape++; covered += view.bin[k]; }
        if (view.core[k]) { cut++; if (!predicted[k]) extra++; }
      }
      return { missing: shape ? 1 - covered / shape : 0, extra: cut ? extra / cut : 0 };
    }

    // Which of 24 directions around the object have been captured.
    yawBins() {
      const bins = new Set();
      for (const v of this.views) {
        const yaw = Math.atan2(v.pos[0], v.pos[2]);
        bins.add(Math.floor(((yaw + Math.PI) / (2 * Math.PI)) * 24) % 24);
      }
      return bins;
    }

    // Pixels where the current shape is expected to appear in a view.
    predictedSilhouette(view) {
      const { w, h } = view;
      const hit = new Uint8Array(w * h);
      const p = [0, 0, 0];
      const r = Math.max(1, Math.round((view.f * this.step) / this.distance / 2));
      for (let i = 0; i < this.outside.length; i++) {
        if (!this.solidAt(i)) continue;
        const k = this.project(view, this.center(i, p));
        if (k < 0) continue;
        const u = k % w, v = (k - u) / w;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const x = u + dx, y = v + dy;
            if (x >= 0 && y >= 0 && x < w && y < h) hit[y * w + x] = 1;
          }
        }
      }
      return hit;
    }

    // Fraction of the predicted silhouette that a view's cut-out actually covers.
    coverageOf(view) {
      const predicted = this.predictedSilhouette(view);
      let total = 0, covered = 0;
      for (let k = 0; k < predicted.length; k++) {
        if (!predicted[k]) continue;
        total++;
        covered += view.bin[k];
      }
      return total ? covered / total : 1;
    }

    center(i, out) {
      const x = i % G, z = Math.floor(i / G) % G, y = Math.floor(i / (G * G));
      out[0] = -this.half + (x + 0.5) * this.step;
      out[1] = -this.half + (y + 0.5) * this.step;
      out[2] = -this.half + (z + 0.5) * this.step;
      return out;
    }

    // Pixel index where world point p lands in the view, or -1 if it's behind or off-frame.
    project(view, p) {
      const { R, pos, f, w, h } = view;
      const px = p[0] - pos[0], py = p[1] - pos[1], pz = p[2] - pos[2];
      const cz = R[2] * px + R[5] * py + R[8] * pz;
      if (cz > -1e-3) return -1;
      const u = Math.floor(w / 2 + (f * (R[0] * px + R[3] * py + R[6] * pz)) / -cz);
      const v = Math.floor(h / 2 - (f * (R[1] * px + R[4] * py + R[7] * pz)) / -cz);
      return u < 0 || v < 0 || u >= w || v >= h ? -1 : v * w + u;
    }

    carve(view, sign) {
      const p = [0, 0, 0];
      for (let i = 0; i < G * G * G; i++) {
        const k = this.project(view, this.center(i, p));
        if (k < 0) continue;
        this.seen[i] += sign;
        if (!view.bin[k]) this.outside[i] += sign;
      }
    }

    // A voxel survives when (almost) every view that saw it saw the object there.
    solidAt(i) {
      const seen = this.seen[i];
      if (seen < Math.min(3, this.views.length)) return false;
      const allowed = this.views.length < 6 ? 0 : Math.max(1, Math.floor(seen * 0.08));
      return this.outside[i] <= allowed;
    }

    // Nothing can see underneath the object, so the carved shape keeps a phantom block below where
    // it stands. Find the floor: the ray through the lowest point of each outline grazes the object
    // where it touches the floor, so the point where that ray first enters the carved shape is at (or
    // just above) floor level. A low percentile over all views is the floor; everything below goes.
    floorHeight() {
      const heights = [];
      const { half, step } = this;
      for (const v of this.views) {
        const { stats, R, pos, f, w, h, bin } = v;
        let row = -1, sx = 0, n = 0;
        for (let y = h - 1; y >= 0 && row < 0; y--) {
          for (let x = 0; x < w; x++) if (bin[y * w + x]) { row = y; sx += x; n++; }
        }
        if (row < 0) continue;
        const d = normalize(rotate(R, [(sx / n + 0.5 - w / 2) / f, -(row + 1 - h / 2) / f, -1]));
        if (d[1] > -0.02) continue; // looking up or level: says nothing about the floor
        for (let t = 0; t < v.dist * 3; t += step * 0.5) {
          const x = Math.floor((pos[0] + t * d[0] + half) / step);
          const y = Math.floor((pos[1] + t * d[1] + half) / step);
          const z = Math.floor((pos[2] + t * d[2] + half) / step);
          if (x < 0 || y < 0 || z < 0 || x >= G || y >= G || z >= G) continue;
          if (this.solidAt((y * G + z) * G + x)) { heights.push(pos[1] + t * d[1]); break; }
        }
      }
      if (heights.length < 3) return -Infinity;
      heights.sort((x, y) => x - y);
      return heights[Math.floor(heights.length * 0.2)] - step * 0.5;
    }

    occupancy() {
      const floor = this.floorHeight();
      const solid = new Uint8Array(G * G * G);
      const p = [0, 0, 0];
      const dug = this.useOpenings && this.dug;
      for (let i = 0; i < solid.length; i++) {
        if (this.solidAt(i) && !(dug && dug[i]) && this.center(i, p)[1] >= floor) solid[i] = 1;
      }
      return solid;
    }

    // ---------- openings from AI depth ----------
    // Outlines alone can never open up a hollow (the inside of a shoe or a mug): no view sees through
    // it. A depth estimate can: looking into the shoe, the inside is further away than the carved
    // "lid" over it. The model's depth is relative (unknown scale and offset), so each view's depth is
    // calibrated against the carved shape itself, ignoring the pixels that disagree most (the openings).

    setDepth(view, raw) { view.depth = raw; }

    // Recompute which voxels the depth views see straight through.
    applyDepth() {
      const withDepth = this.views.filter((v) => v.depth);
      if (!withDepth.length) { this.dug = null; return 0; }
      const floor = this.floorHeight();
      const p = [0, 0, 0];
      const solids = [];
      for (let i = 0; i < this.outside.length; i++) if (this.solidAt(i) && this.center(i, p)[1] >= floor) solids.push(i);
      let reach = 0;
      for (const i of solids) { this.center(i, p); reach = Math.max(reach, Math.hypot(p[0], p[2])); }
      const floorRadius = reach * 2.5;
      const free = new Uint16Array(this.outside.length), looked = new Uint16Array(this.outside.length);
      for (const v of withDepth) {
        const { R, pos, f, w, h, core: inside, depth } = v;
        // Distance along the camera axis to a world point (positive in front).
        const camDepth = (q) => -(R[2] * (q[0] - pos[0]) + R[5] * (q[1] - pos[1]) + R[8] * (q[2] - pos[2]));
        // 1. The carved shape's nearest surface in this view (a z-buffer).
        const zb = new Float32Array(w * h).fill(Infinity);
        const r = Math.max(1, Math.round((f * this.step) / v.dist / 2));
        for (const i of solids) {
          const k = this.project(v, this.center(i, p));
          if (k < 0) continue;
          const z = camDepth(p), u = k % w, vv = (k - u) / w;
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              const x = u + dx, y = vv + dy;
              if (x >= 0 && y >= 0 && x < w && y < h && z < zb[y * w + x]) zb[y * w + x] = z;
            }
          }
        }
        // 2. Calibrate: fit 1/depth = a·raw + b on pixels whose true distance we know.
        //    - The floor around the object: we know its height and the camera, so each floor pixel's
        //      distance is exact, from near to far (and nothing on it is hidden).
        //    - The outline: the carved shape touches the real object there (skipping the outermost
        //      pixels, which the depth model blurs into what's behind).
        //    Then refit on the 70% of pixels that agree best.
        const fromEdge = depthMap(inside, w, h);
        const rim = Math.max(3, Math.round(w / 50));
        const xs = [], ys = [];
        for (let k = 0; k < w * h; k++) {
          if (inside[k] && fromEdge[k] > 2 && fromEdge[k] <= rim + 2 && depth[k] > 0 && zb[k] < Infinity) {
            xs.push(depth[k]); ys.push(1 / zb[k]);
          }
        }
        if (floor > -Infinity) {
          for (let y = 0; y < h; y += 2) {
            for (let x = 0; x < w; x += 2) {
              const k = y * w + x;
              if (v.bin[k] || !(depth[k] > 0)) continue;
              const d = normalize(rotate(R, [(x + 0.5 - w / 2) / f, -(y + 0.5 - h / 2) / f, -1]));
              if (d[1] > -0.05) continue;
              const t = (floor - pos[1]) / d[1];
              const hx = pos[0] + t * d[0], hz = pos[2] + t * d[2];
              if (Math.hypot(hx, hz) > floorRadius) continue; // stay on the table near the object
              const z = t * -(R[2] * d[0] + R[5] * d[1] + R[8] * d[2]);
              xs.push(depth[k]); ys.push(1 / z);
            }
          }
        }
        if (xs.length < 50) continue;
        let fit = linearFit(xs, ys);
        const res = xs.map((q, n) => Math.abs(fit.a * q + fit.b - ys[n]));
        const cut = [...res].sort((m, n) => m - n)[Math.floor(res.length * 0.7)];
        fit = linearFit(xs.filter((_, n) => res[n] <= cut), ys.filter((_, n) => res[n] <= cut));
        if (!(fit.a > 0 && fit.r2 > 0.5)) continue; // depth doesn't line up with the scene: don't trust it
        v.depthFit = fit;
        // 3. Voxels clearly in front of the observed surface are air.
        for (const i of solids) {
          const k = this.project(v, this.center(i, p));
          if (k < 0 || !inside[k]) continue;
          const inv = fit.a * depth[k] + fit.b;
          if (inv <= 0) continue;
          const observed = 1 / inv, z = camDepth(p);
          looked[i]++;
          if (z < observed - Math.max(2 * this.step, 0.06 * observed)) free[i]++;
        }
      }
      this.dug = new Uint8Array(this.outside.length);
      let count = 0;
      for (const i of solids) {
        if (free[i] >= 2 && free[i] >= looked[i] * 0.5) { this.dug[i] = 1; count++; }
      }
      return count;
    }

    // Surface voxels for the live preview: [x, y, z, nx, ny, nz] in world units.
    surfacePoints(limit = 6000) {
      const pts = [];
      if (!this.views.length) return pts;
      const solid = this.occupancy();
      const p = [0, 0, 0];
      for (let i = 0; i < solid.length; i++) {
        if (!solid[i]) continue;
        const n = this.outwardNormal(solid, i);
        if (!n) continue;
        this.center(i, p);
        pts.push([p[0], p[1], p[2], n[0], n[1], n[2]]);
      }
      const stride = Math.max(1, Math.ceil(pts.length / limit));
      return stride > 1 ? pts.filter((_, k) => k % stride === 0) : pts;
    }

    // Normal from the empty neighbours; null for voxels buried inside.
    outwardNormal(solid, i) {
      const x = i % G, z = Math.floor(i / G) % G, y = Math.floor(i / (G * G));
      let nx = 0, ny = 0, nz = 0, open = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy && !dz) continue;
            const X = x + dx, Y = y + dy, Z = z + dz;
            const empty = X < 0 || Y < 0 || Z < 0 || X >= G || Y >= G || Z >= G || !solid[(Y * G + Z) * G + X];
            if (!empty) continue;
            nx += dx; ny += dy; nz += dz;
            if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) === 1) open = true;
          }
        }
      }
      if (!open) return null;
      const l = Math.hypot(nx, ny, nz);
      return l ? [nx / l, ny / l, nz / l] : [0, 1, 0];
    }

    // Surface color: majority LEGO color among the (up to) three views that face the voxel best.
    colorAt(i, n, p) {
      const scored = [];
      for (const v of this.views) {
        const k = this.project(v, p);
        if (k < 0 || !v.core[k]) continue;
        const toCam = normalize([v.pos[0] - p[0], v.pos[1] - p[1], v.pos[2] - p[2]]);
        const facing = n[0] * toCam[0] + n[1] * toCam[1] + n[2] * toCam[2];
        if (facing > 0.1) scored.push([facing, v, k]);
      }
      if (!scored.length) return -1;
      scored.sort((a, b) => b[0] - a[0]);
      const votes = new Map();
      for (const [facing, v, k] of scored.slice(0, 3)) {
        const d = v.image.data;
        const c = L.nearestColor(d[k * 4], d[k * 4 + 1], d[k * 4 + 2]);
        votes.set(c, (votes.get(c) || 0) + facing);
      }
      return [...votes].sort((a, b) => b[1] - a[1])[0][0];
    }

    // Resample the carved shape onto a LEGO grid whose longest side is `size` studs.
    volume({ size = 36 } = {}) {
      if (!this.views.length) throw new Error('Nothing scanned yet.');
      const solid = this.occupancy();
      let x0 = G, x1 = -1, y0 = G, y1 = -1, z0 = G, z1 = -1;
      for (let i = 0; i < solid.length; i++) {
        if (!solid[i]) continue;
        const x = i % G, z = Math.floor(i / G) % G, y = Math.floor(i / (G * G));
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
      if (x1 < 0) throw new Error('The scan came out empty. Try again, keeping the object in view.');

      // Colors for the carved surface.
      const color = new Int16Array(solid.length).fill(-1);
      const p = [0, 0, 0];
      for (let i = 0; i < solid.length; i++) {
        if (!solid[i]) continue;
        const n = this.outwardNormal(solid, i);
        if (n) color[i] = this.colorAt(i, n, this.center(i, p));
      }

      const ext = Math.max(x1 - x0 + 1, (y1 - y0 + 1), z1 - z0 + 1) * this.step;
      const s = ext / size; // world units per stud
      const cols = Math.max(1, Math.round(((x1 - x0 + 1) * this.step) / s));
      const depth = Math.max(1, Math.round(((z1 - z0 + 1) * this.step) / s));
      const rows = Math.max(1, Math.round(((y1 - y0 + 1) * this.step) / (s * L.BRICK_HEIGHT)));
      const voxels = new Int16Array(cols * rows * depth).fill(-1);
      const filled = new Uint8Array(voxels.length);
      const toCarve = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(v)));
      for (let level = 0; level < rows; level++) {
        const gy = toCarve(y0 + ((level + 0.5) * s * L.BRICK_HEIGHT) / this.step, y0, y1);
        for (let z = 0; z < depth; z++) {
          const gz = toCarve(z0 + ((z + 0.5) * s) / this.step, z0, z1);
          for (let x = 0; x < cols; x++) {
            const gx = toCarve(x0 + ((x + 0.5) * s) / this.step, x0, x1);
            const i = (gy * G + gz) * G + gx;
            if (!solid[i]) continue;
            const j = (level * depth + z) * cols + x;
            filled[j] = 1;
            voxels[j] = color[i];
          }
        }
      }
      // Cells that landed on interior (uncolored) voxels inherit the nearest surface color.
      const queue = [];
      for (let j = 0; j < voxels.length; j++) if (filled[j] && voxels[j] >= 0) queue.push(j);
      for (let head = 0; head < queue.length; head++) {
        const j = queue[head];
        const x = j % cols, z = Math.floor(j / cols) % depth, y = Math.floor(j / (cols * depth));
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const X = x + dx, Y = y + dy, Z = z + dz;
          if (X < 0 || Y < 0 || Z < 0 || X >= cols || Y >= rows || Z >= depth) continue;
          const n = (Y * depth + Z) * cols + X;
          if (filled[n] && voxels[n] < 0) { voxels[n] = voxels[j]; queue.push(n); }
        }
      }
      const grey = L.PALETTE.findIndex((c) => c.name === 'Light Bluish Gray');
      for (let j = 0; j < voxels.length; j++) if (filled[j] && voxels[j] < 0) voxels[j] = grey;
      return { cols, rows, depth, voxels };
    }
  }

  // ---------- zoomed-in segmentation ----------

  // Small objects come out rough when segmented in a whole frame, so cut out a crop around where the
  // object should be (from the full-resolution source), segment that at high resolution and map the
  // result back to the analysis frame. `box` is where we expect the object, in 0..1 frame units.
  const cropCanvas = document.createElement('canvas');
  const cropCtx = cropCanvas.getContext('2d');
  L.segmentZoomed = function (segmenter, source, srcW, srcH, w, h, roi, box) {
    const aspect = srcW / srcH;
    let cx = 0.5, cy = 0.5, size = 0.75; // size: crop height as a share of the frame height
    if (box) {
      cx = (box.x0 + box.x1) / 2; cy = (box.y0 + box.y1) / 2;
      size = Math.max(box.y1 - box.y0, (box.x1 - box.x0) * aspect) * 2;
    } else {
      const q = roi.keypoint || roi.scribble[0];
      cx = q.x; cy = q.y;
    }
    size = Math.min(1, Math.max(0.3, size));
    const ch = size, cw = Math.min(1, size / aspect); // square in pixels
    const x0 = Math.min(1 - cw, Math.max(0, cx - cw / 2)), y0 = Math.min(1 - ch, Math.max(0, cy - ch / 2));
    const pxW = cw * srcW, pxH = ch * srcH;
    const k = Math.min(1, 480 / Math.max(pxW, pxH));
    cropCanvas.width = Math.max(8, Math.round(pxW * k));
    cropCanvas.height = Math.max(8, Math.round(pxH * k));
    cropCtx.drawImage(source, x0 * srcW, y0 * srcH, pxW, pxH, 0, 0, cropCanvas.width, cropCanvas.height);
    const toCrop = (q) => ({ x: Math.min(1, Math.max(0, (q.x - x0) / cw)), y: Math.min(1, Math.max(0, (q.y - y0) / ch)) });
    const cropRoi = roi.scribble ? { scribble: roi.scribble.map(toCrop) } : { keypoint: toCrop(roi.keypoint) };
    const result = segmenter.segment(cropCanvas, cropRoi);
    const conf = result.confidenceMasks && result.confidenceMasks[0];
    const m = conf ? conf.getAsFloat32Array() : null;
    const mw = conf ? conf.width : 0, mh = conf ? conf.height : 0;
    const mask = new Float32Array(w * h);
    if (m) {
      // Average the high-resolution mask over each analysis pixel.
      for (let y = 0; y < h; y++) {
        const fy0 = ((y / h - y0) / ch) * mh, fy1 = (((y + 1) / h - y0) / ch) * mh;
        if (fy1 <= 0 || fy0 >= mh) continue;
        for (let x = 0; x < w; x++) {
          const fx0 = ((x / w - x0) / cw) * mw, fx1 = (((x + 1) / w - x0) / cw) * mw;
          if (fx1 <= 0 || fx0 >= mw) continue;
          let sum = 0, n = 0;
          for (let yy = Math.max(0, Math.floor(fy0)); yy < Math.min(mh, Math.ceil(fy1)); yy++) {
            for (let xx = Math.max(0, Math.floor(fx0)); xx < Math.min(mw, Math.ceil(fx1)); xx++) { sum += m[yy * mw + xx]; n++; }
          }
          if (n) mask[y * w + x] = sum / n;
        }
      }
    }
    result.close();
    return mask;
  };

  // Least-squares line y = a·x + b, with r².
  function linearFit(xs, ys) {
    const n = xs.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (let k = 0; k < n; k++) { sx += xs[k]; sy += ys[k]; sxx += xs[k] * xs[k]; sxy += xs[k] * ys[k]; syy += ys[k] * ys[k]; }
    const vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n, cxy = sxy - (sx * sy) / n;
    const a = vx ? cxy / vx : 0, b = (sy - a * sx) / n;
    return { a, b, r2: vx && vy ? (cxy * cxy) / (vx * vy) : 0 };
  }

  // Overlap (IoU) between a new cut-out and a previous view's outline, after lining up their centres.
  function shapeSimilarity(prev, mask, stats) {
    const { w, h, bin } = prev;
    const dx = Math.round(stats.cx - prev.stats.cx), dy = Math.round(stats.cy - prev.stats.cy);
    let both = 0, prevArea = 0;
    for (let i = 0; i < w * h; i++) prevArea += bin[i];
    for (let y = stats.minY; y <= stats.maxY; y++) {
      const py = y - dy;
      if (py < 0 || py >= h) continue;
      for (let x = stats.minX; x <= stats.maxX; x++) {
        const px = x - dx;
        if (px >= 0 && px < w && mask[y * w + x] >= 0.5 && bin[py * w + px]) both++;
      }
    }
    return both / (stats.area + prevArea - both);
  }

  // Distance (in pixels, roughly) from each object pixel to the nearest non-object pixel.
  function depthMap(bin, w, h) {
    const d = new Uint16Array(w * h);
    const BIG = 65535;
    for (let i = 0; i < w * h; i++) d[i] = bin[i] ? BIG : 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!d[i]) continue;
        const up = y ? d[i - w] : 0, left = x ? d[i - 1] : 0;
        d[i] = Math.min(d[i], up + 1, left + 1);
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (!d[i]) continue;
        const down = y < h - 1 ? d[i + w] : 0, right = x < w - 1 ? d[i + 1] : 0;
        d[i] = Math.min(d[i], down + 1, right + 1);
      }
    }
    return d;
  }

  // Where to point the segmenter in a new frame: the deepest-inside points of the previous capture's
  // cut-out, one per horizontal band, so thin parts (a pole) and wide parts (the sign on it) are both
  // prompted without any point landing on background.
  function promptFrom(prev, fallback) {
    if (!prev) return { keypoint: fallback };
    const { core: c, w, h, stats } = prev;
    const depth = depthMap(c, w, h);
    const bands = 6, pts = [];
    const span = stats.maxY - stats.minY + 1;
    for (let b = 0; b < bands; b++) {
      const y0 = stats.minY + Math.floor((b * span) / bands), y1 = stats.minY + Math.floor(((b + 1) * span) / bands);
      let best = -1, bestD = 1;
      for (let y = y0; y < y1; y++) {
        for (let x = stats.minX; x <= stats.maxX; x++) {
          const k = y * w + x;
          if (depth[k] > bestD) { bestD = depth[k]; best = k; }
        }
      }
      if (best >= 0) pts.push({ x: ((best % w) + 0.5) / w, y: (Math.floor(best / w) + 0.5) / h });
    }
    const box = { x0: stats.minX / w, x1: (stats.maxX + 1) / w, y0: stats.minY / h, y1: (stats.maxY + 1) / h };
    if (!pts.length) return { keypoint: fallback, box };
    return pts.length === 1 ? { keypoint: pts[0], box } : { scribble: pts, box };
  }

  const pointsOf = (roi) => roi.scribble || [roi.keypoint];
  const pixelOf = (q, w, h) => Math.min(h - 1, Math.floor(q.y * h)) * w + Math.min(w - 1, Math.floor(q.x * w));

  // Keep only the parts of the cut-out connected to the prompted points (drops stray blobs).
  function keepConnected(mask, w, h, roi) {
    const keep = new Uint8Array(w * h);
    const stack = [];
    for (const q of pointsOf(roi)) {
      const k = pixelOf(q, w, h);
      if (mask[k] >= 0.5 && !keep[k]) { keep[k] = 1; stack.push(k); }
    }
    while (stack.length) {
      const k = stack.pop();
      const x = k % w, y = (k - x) / w;
      if (x > 0) visit(k - 1);
      if (x < w - 1) visit(k + 1);
      if (y > 0) visit(k - w);
      if (y < h - 1) visit(k + w);
    }
    function visit(n) { if (!keep[n] && mask[n] >= 0.5) { keep[n] = 1; stack.push(n); } }
    for (let i = 0; i < w * h; i++) if (!keep[i]) mask[i] = Math.min(mask[i], 0.49);
    return mask;
  }

  // Cut the object out of a new frame during scanning. `source` is the full-resolution frame
  // (the video), `prev` the last accepted capture. Returns a w×h confidence mask, or null.
  L.cutOut = function ({ segmenter, source, srcW, srcH, w, h, prev, keypoint, carver, image }) {
    const holds = (m, roi) => {
      const pts = pointsOf(roi);
      return pts.filter((q) => m[pixelOf(q, w, h)] >= 0.5).length >= Math.ceil(pts.length * 0.6);
    };
    const roi = promptFrom(prev, keypoint);
    let used = roi;
    let mask = L.segmentZoomed(segmenter, source, srcW, srcH, w, h, roi, roi.box);
    if (!holds(mask, roi)) {
      // The prompt didn't take (finder grabbed something else): retry once from the last centre.
      used = { keypoint };
      mask = L.segmentZoomed(segmenter, source, srcW, srcH, w, h, used, roi.box);
      if (!holds(mask, used)) return null;
    }
    // Trim parts whose colour clearly belongs to the surroundings (trees, grass, sky), then keep
    // what's still connected to the prompt.
    if (carver && image) {
      const d = image.data;
      let area = 0, trimmed = 0;
      for (let i = 0; i < w * h; i++) {
        if (mask[i] < 0.5) continue;
        area++;
        if (carver.looksLikeBackground(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])) { mask[i] = 0; trimmed++; }
      }
      if (trimmed > area * 0.25) return null; // mostly background: the finder lost the object
    }
    return keepConnected(mask, w, h, used);
  };

  // Keep a sharp, full-resolution crop around the object for the depth model (the analysis frame is
  // too coarse to see into a shoe). Stored as a JPEG with where it sits in the frame (0..1 units).
  const depthCanvas = document.createElement('canvas');
  L.captureCrop = function (view, source, srcW, srcH) {
    const { stats, w, h } = view;
    const aspect = srcW / srcH;
    const bw = (stats.maxX - stats.minX + 1) / w, bh = (stats.maxY - stats.minY + 1) / h;
    const ch = Math.min(1, Math.max(bh, bw * aspect) * 1.3), cw = Math.min(1, ch / aspect);
    const cx = (stats.minX + stats.maxX + 1) / 2 / w, cy = (stats.minY + stats.maxY + 1) / 2 / h;
    const x0 = Math.min(1 - cw, Math.max(0, cx - cw / 2)), y0 = Math.min(1 - ch, Math.max(0, cy - ch / 2));
    const k = Math.min(1, 518 / Math.max(cw * srcW, ch * srcH));
    depthCanvas.width = Math.max(8, Math.round(cw * srcW * k));
    depthCanvas.height = Math.max(8, Math.round(ch * srcH * k));
    depthCanvas.getContext('2d').drawImage(source, x0 * srcW, y0 * srcH, cw * srcW, ch * srcH, 0, 0, depthCanvas.width, depthCanvas.height);
    view.crop = { url: depthCanvas.toDataURL('image/jpeg', 0.88), x0, y0, cw, ch };
  };

  // One capture while scanning, shared by the phone UI and the tests. `state` carries the last known
  // centre (keypoint), a pending user tap, and how many captures in a row failed. After a few failures
  // we stop guessing and ask the user to tap the object (needTap).
  L.scanStep = function ({ carver, segmenter, source, srcW, srcH, image, rotation, state }) {
    const { width: w, height: h } = image;
    let mask, anchored = false;
    if (state.tap) {
      const roi = { keypoint: state.tap };
      mask = keepConnected(L.segmentZoomed(segmenter, source, srcW, srcH, w, h, roi, null), w, h, roi);
      anchored = true;
      state.tap = null;
    } else if (state.needTap) {
      return null;
    } else {
      mask = L.cutOut({ segmenter, source, srcW, srcH, w, h, prev: carver.all[carver.all.length - 1], keypoint: state.keypoint, carver, image });
    }
    const view = mask && carver.addView({ image, mask, rotation }, { anchored });
    if (view) {
      L.captureCrop(view, source, srcW, srcH);
      state.keypoint = { x: (view.stats.cx + 0.5) / w, y: (view.stats.cy + 0.5) / h };
      state.misses = 0;
      state.needTap = false;
      state.lastMask = mask;
    } else if (anchored || ++state.misses >= 3) {
      state.needTap = true;
    }
    return view;
  };

  // ---------- phone pose ----------

  // DeviceOrientation (alpha, beta, gamma in degrees, earth frame east-north-up) plus the screen
  // rotation -> camera→world rotation in our frame (x east, y up, z south), row-major.
  function cameraRotation(alpha, beta, gamma, screenAngle) {
    const r = Math.PI / 180;
    const cA = Math.cos(alpha * r), sA = Math.sin(alpha * r);
    const cB = Math.cos(beta * r), sB = Math.sin(beta * r);
    const cG = Math.cos(gamma * r), sG = Math.sin(gamma * r);
    // Device -> earth: Rz(alpha) * Rx(beta) * Ry(gamma)
    const D = [
      cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG,
      sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG,
      -cB * sG, sB, cB * cG,
    ];
    // Camera image axes are the device axes turned by the screen orientation.
    const cS = Math.cos(screenAngle * r), sS = Math.sin(screenAngle * r);
    const S = [cS, -sS, 0, sS, cS, 0, 0, 0, 1];
    const DS = mul3(D, S);
    // East-north-up -> (east, up, -north)
    const M = [1, 0, 0, 0, 0, 1, 0, -1, 0];
    return mul3(M, DS);
  }

  function mul3(a, b) {
    const o = new Array(9);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
    return o;
  }

  // ---------- capture UI ----------

  class Scanner {
    constructor(T, ui, onDone) {
      this.T = T;
      this.ui = ui;
      this.onDone = onDone;
      this.frame = document.createElement('canvas');
      this.fctx = this.frame.getContext('2d', { willReadFrequently: true });
      this.maskCanvas = document.createElement('canvas');
      this.onOrientation = (e) => {
        if (e.alpha == null) return;
        const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
        const R = cameraRotation(e.alpha, e.beta, e.gamma, angle);
        const now = performance.now();
        if (this.rotation) {
          const f0 = Carver.forward(this.rotation), f1 = Carver.forward(R);
          const ang = Math.acos(Math.max(-1, Math.min(1, f0[0] * f1[0] + f0[1] * f1[1] + f0[2] * f1[2])));
          const dt = Math.max(1, now - this.rotationAt) / 1000;
          this.turnRate = 0.7 * (this.turnRate || 0) + 0.3 * (ang / dt);
        }
        this.rotation = R;
        this.rotationAt = now;
      };
      ui.cancel.addEventListener('click', () => this.close());
      ui.done.addEventListener('click', () => this.finish());
      ui.overlay.addEventListener('pointerdown', (e) => this.tap(e));
      ui.confirmYes.addEventListener('click', () => this.confirm(true));
      ui.confirmNo.addEventListener('click', () => this.confirm(false));
      ui.reviewBuild.addEventListener('click', () => this.build());
      ui.reviewMore.addEventListener('click', () => this.scanMore());
      ui.reviewCancel.addEventListener('click', () => this.close());
      ui.openings.addEventListener('change', async () => {
        if (this.refining || !this.carver) return;
        this.carver.useOpenings = ui.openings.checked;
        if (ui.openings.checked && !this.carver.views.some((v) => v.depth)) {
          this.refining = true;
          ui.reviewBuild.disabled = true;
          await this.findOpenings();
          this.refining = false;
          ui.reviewBuild.disabled = false;
        }
        this.refreshReview();
      });
    }

    status(msg) { this.ui.status.textContent = msg; }

    // Must be called from a tap/click: iOS only grants motion sensors inside a user gesture.
    async open() {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser can\'t use the camera. Open the page over https in Safari or Chrome on your phone.');
      }
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const answer = await DeviceOrientationEvent.requestPermission();
        if (answer !== 'granted') throw new Error('Scanning needs motion & orientation access to know where the phone is.');
      }
      this.carver = new Carver();
      this.keypoint = null;
      this.pending = null;
      this.guide = null;
      this.phase = 'select';
      await this.startCamera();
      this.status('Tap the object you want to build.');
    }

    // Camera, sensors and the capture loop. Also used to resume after reviewing.
    async startCamera() {
      const { ui } = this;
      this.busy = false;
      this.rotation = null;
      this.lastMaskAt = 0;
      window.addEventListener('deviceorientation', this.onOrientation);
      ui.root.hidden = false;
      ui.review.hidden = true;
      ui.live.hidden = false;
      document.body.classList.add('scanning');
      this.status('Starting the camera…');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
      });
      ui.video.srcObject = this.stream;
      await ui.video.play();

      this.status('Loading the object finder…');
      this.segmenter = this.segmenter || await this.T.loadSegmenter();

      if (!this.rotation) {
        await new Promise((r) => setTimeout(r, 1200));
        if (!this.rotation) {
          this.close();
          throw new Error('No motion sensor data. Walk-around scanning needs a phone, so open this page on one.');
        }
      }
      this.running = true;
      this.updateUi();
      requestAnimationFrame((t) => this.loop(t));
    }

    stopCamera() {
      this.running = false;
      window.removeEventListener('deviceorientation', this.onOrientation);
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }

    close() {
      this.stopCamera();
      this.reviewing = false;
      this.ui.root.hidden = true;
      this.ui.confirm.hidden = true;
      document.body.classList.remove('scanning');
    }

    // The first cut-out is shown to the user; scanning only starts once they say it's the whole object.
    confirm(yes) {
      const { pending } = this;
      this.pending = null;
      this.ui.confirm.hidden = true;
      this.lastMaskAt = 0;
      if (!yes || !pending) {
        this.phase = 'select';
        this.status('Tap the object you want to build. Tap its middle so the whole thing lights up.');
        return;
      }
      const view = this.carver.addView(pending, { anchored: true });
      if (view) L.captureCrop(view, this.ui.video, this.ui.video.videoWidth, this.ui.video.videoHeight);
      if (!view) {
        this.phase = 'select';
        this.status('That cut-out can\'t be used (it runs off the screen or is tiny). Step back and tap again.');
        return;
      }
      this.accepted(view);
      this.state = { keypoint: this.keypoint, misses: 0, needTap: false, tap: null };
      this.guide = { ...view.stats, w: view.w, h: view.h };
      this.phase = 'scanning';
      this.updateUi();
    }

    // Walking is over: show the reconstruction and every capture so the user can prune bad ones.
    finish() {
      if (!this.carver || this.carver.count < 4) return;
      this.stopCamera();
      this.ui.live.hidden = true;
      this.ui.review.hidden = false;
      this.reviewing = true;
      this.renderReviewGrid();
      this.ui.reviewInfo.textContent = 'Lining up your captures…';
      this.ui.reviewBuild.disabled = true;
      requestAnimationFrame(() => this.reviewLoop());
      this.refining = true;
      this.carver.refine((f) => { this.ui.reviewInfo.textContent = `Lining up your captures… ${Math.round(f * 100)}%`; })
        .catch((err) => console.error(err))
        .then(() => this.findOpenings())
        .catch((err) => console.error(err))
        .then(() => {
          this.refining = false;
          this.ui.reviewBuild.disabled = false;
          if (this.reviewing) this.refreshReview();
        });
    }

    // Run the depth model on up to 10 captures spread around the object, then dig out what they see into.
    async findOpenings() {
      const { ui, carver } = this;
      if (!ui.openings.checked) return;
      const todo = carver.views.filter((v) => !v.depth);
      const pick = todo.filter((_, n) => n % Math.max(1, Math.ceil(todo.length / 10)) === 0).slice(0, 10);
      if (!pick.length) { carver.useOpenings = true; carver.applyDepth(); return; }
      ui.reviewInfo.textContent = 'Looking for openings (the first time, this downloads a 27 MB AI model)…';
      try {
        this.depthModel = this.depthModel || await this.T.loadDepth();
        const c = document.createElement('canvas');
        for (let n = 0; n < pick.length; n++) {
          if (!this.reviewing) return;
          ui.reviewInfo.textContent = `Looking for openings… ${n + 1} of ${pick.length}`;
          const v = pick[n];
          // Prefer the sharp crop kept at capture time; fall back to the whole analysis frame.
          let crop = v.crop;
          if (!crop) {
            c.width = v.w; c.height = v.h;
            c.getContext('2d').putImageData(v.image, 0, 0);
            crop = { url: c.toDataURL('image/jpeg', 0.9), x0: 0, y0: 0, cw: 1, ch: 1 };
          }
          const out = await this.depthModel(crop.url);
          const d = out.predicted_depth;
          const [dh, dw] = d.dims.slice(-2);
          const raw = new Float32Array(v.w * v.h);
          for (let y = 0; y < v.h; y++) {
            const sy = Math.floor((((y + 0.5) / v.h - crop.y0) / crop.ch) * dh);
            if (sy < 0 || sy >= dh) continue;
            for (let x = 0; x < v.w; x++) {
              const sx = Math.floor((((x + 0.5) / v.w - crop.x0) / crop.cw) * dw);
              if (sx >= 0 && sx < dw) raw[y * v.w + x] = d.data[sy * dw + sx];
            }
          }
          carver.setDepth(v, raw);
        }
        carver.useOpenings = true;
        carver.applyDepth();
      } catch (err) {
        console.error(err);
        ui.openings.checked = false;
        ui.reviewInfo.textContent = `Couldn't run the depth model (${err.message}). The shape is outline-only.`;
      }
    }

    build() {
      const carver = this.carver;
      this.close();
      this.onDone(carver);
    }

    async scanMore() {
      this.reviewing = false;
      this.phase = 'scanning';
      try {
        await this.startCamera();
      } catch (err) {
        this.status(err.message);
      }
    }

    // Where the video actually sits inside the overlay (object-fit: cover, so it may overflow).
    videoRect() {
      const { video, overlay } = this.ui;
      const W = overlay.clientWidth, H = overlay.clientHeight;
      const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
      const k = Math.max(W / vw, H / vh);
      return { x: (W - vw * k) / 2, y: (H - vh * k) / 2, w: vw * k, h: vh * k };
    }

    // Tapping picks the object; while scanning, a tap re-anchors on it (always allowed, and asked for
    // when the finder loses track).
    tap(e) {
      if (!this.running) return;
      const r = this.videoRect();
      const box = this.ui.overlay.getBoundingClientRect();
      const x = (e.clientX - box.left - r.x) / r.w, y = (e.clientY - box.top - r.y) / r.h;
      if (x < 0 || y < 0 || x > 1 || y > 1) return;
      if (this.phase === 'scanning') this.state.tap = { x, y };
      else this.keypoint = { x, y };
      this.forceCapture = true;
    }

    grabFrame() {
      const { video } = this.ui;
      const k = ANALYSIS_LONG_SIDE / Math.max(video.videoWidth, video.videoHeight);
      const w = Math.round(video.videoWidth * k), h = Math.round(video.videoHeight * k);
      if (this.frame.width !== w || this.frame.height !== h) { this.frame.width = w; this.frame.height = h; }
      this.fctx.drawImage(video, 0, 0, w, h);
      return this.fctx.getImageData(0, 0, w, h);
    }

    // One capture: segment the frame around the keypoint and hand it to the carver.
    capture() {
      const rotation = this.rotation.slice();
      const image = this.grabFrame();
      const { video } = this.ui;
      if (this.phase === 'scanning') {
        const view = L.scanStep({
          carver: this.carver, segmenter: this.segmenter, source: video, srcW: video.videoWidth,
          srcH: video.videoHeight, image, rotation, state: this.state,
        });
        if (view) {
          this.accepted(view);
          this.drawMask(this.state.lastMask, image.width, image.height);
        }
        return view && view.stats;
      }
      const mask = keepConnected(L.segmentZoomed(this.segmenter, video, video.videoWidth, video.videoHeight,
        image.width, image.height, { keypoint: this.keypoint }, null), image.width, image.height, { keypoint: this.keypoint });
      if (this.phase !== 'scanning') {
        // Picking the object: hold the cut-out for the user to confirm.
        const { width: w, height: h } = image;
        const stats = maskStats(mask, w, h);
        if (!stats.area || stats.area < w * h * 0.005) return null;
        if (stats.area > w * h * 0.8 || stats.edge > (w + h) * 0.04) {
          this.status('That selection runs off the screen. Step back so the whole object fits, then tap it.');
          return stats;
        }
        this.pending = { image, mask, rotation, stats };
        this.drawMask(mask, image.width, image.height);
        this.lastMaskAt = Infinity; // keep it on screen until they answer
        this.phase = 'confirm';
        this.ui.confirm.hidden = false;
        this.status('Is the highlighted area the whole object?');
        return stats;
      }
    }

    // Bookkeeping for a new capture: follow the object, and keep a thumbnail for the review.
    accepted(view) {
      const { stats, w, h } = view;
      this.keypoint = { x: (stats.cx + 0.5) / w, y: (stats.cy + 0.5) / h };
      const thumb = document.createElement('canvas');
      thumb.width = w; thumb.height = h;
      const g = thumb.getContext('2d');
      const img = new ImageData(new Uint8ClampedArray(view.image.data), w, h);
      for (let i = 0; i < w * h; i++) {
        if (view.core[i]) continue; // dim everything that isn't the object
        img.data[i * 4] *= 0.35; img.data[i * 4 + 1] *= 0.35; img.data[i * 4 + 2] *= 0.35;
      }
      g.putImageData(img, 0, 0);
      view.thumb = thumb;
    }

    loop() {
      if (!this.running) return;
      requestAnimationFrame((t) => this.loop(t));
      const ready = this.keypoint && this.rotation && !this.busy;
      const steady = (this.turnRate || 0) < 1.2; // rad/s: skip blurry frames while turning fast
      const walking = this.phase === 'scanning' && !this.state.needTap && steady && this.carver.isNewDirection(this.rotation);
      if (ready && (this.forceCapture || walking)) {
        this.busy = true;
        const forced = this.forceCapture;
        this.forceCapture = false;
        // Let the browser paint first so the UI never looks frozen during segmentation.
        setTimeout(() => {
          try {
            const stats = this.capture();
            if (!stats && forced) this.status('Couldn\'t pick out the object. Tap right on it again.');
            if (stats || (this.state && this.state.needTap)) this.updateUi();
          } catch (err) {
            console.error(err);
            this.status(`Scanning hiccup: ${err.message}`);
          }
          this.busy = false;
        }, 0);
      }
      this.drawOverlay();
    }

    updateUi() {
      const { ui, carver } = this;
      const bins = carver.yawBins();
      const pct = Math.round((bins.size / 24) * 100);
      ui.done.disabled = carver.count < 4;
      ui.done.textContent = carver.count ? `Done · ${carver.count}` : 'Done';
      if (carver.count) {
        // Views from above only see the outline, not the height: ask for some low side views too.
        const lowest = Math.min(...carver.views.map((v) => Math.asin(Math.max(-1, Math.min(1, -v.dir[1])))));
        const needLow = carver.count >= 8 && lowest > (35 * Math.PI) / 180;
        this.status(this.state && this.state.needTap
          ? 'I lost track of the object. Tap it on the screen to carry on.'
          : needLow && pct >= 50
          ? 'Now crouch down and walk around it low, looking at it from the side, to capture its height.'
          : pct >= 85
            ? 'Looks good! Tap Done, or keep going to sharpen details.'
            : `Walk slowly around the object and keep it inside the frame. ${pct}% covered.`);
      }
      this.drawRing(bins);
      this.drawPreview();
    }

    drawMask(mask, w, h) {
      const c = this.maskCanvas;
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      const img = g.createImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        if (mask[i] < 0.5) continue;
        img.data[i * 4] = 255; img.data[i * 4 + 1] = 205; img.data[i * 4 + 2] = 55; img.data[i * 4 + 3] = 110;
      }
      g.putImageData(img, 0, 0);
      this.lastMaskAt = performance.now();
    }

    drawOverlay() {
      const { overlay } = this.ui;
      const dpr = window.devicePixelRatio || 1;
      const W = overlay.clientWidth, H = overlay.clientHeight;
      if (overlay.width !== Math.round(W * dpr)) { overlay.width = Math.round(W * dpr); overlay.height = Math.round(H * dpr); }
      const g = overlay.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const r = this.videoRect();
      // The latest captured silhouette fades out over a second.
      const age = this.lastMaskAt === Infinity ? 0 : (performance.now() - this.lastMaskAt) / 1000;
      if (this.maskCanvas.width && age < 1.2) {
        g.globalAlpha = Math.max(0, 1 - age / 1.2);
        g.drawImage(this.maskCanvas, r.x, r.y, r.w, r.h);
        g.globalAlpha = 1;
      }
      // Guide frame: keep the object about the size it was in the first capture.
      if (this.guide) {
        const { minX, maxX, minY, maxY, w, h } = this.guide;
        const bw = ((maxX - minX) / w) * r.w * 1.15, bh = ((maxY - minY) / h) * r.h * 1.15;
        g.strokeStyle = 'rgba(255,255,255,0.85)';
        g.lineWidth = 2;
        g.setLineDash([10, 8]);
        g.strokeRect(r.x + r.w / 2 - bw / 2, r.y + r.h / 2 - bh / 2, bw, bh);
        g.setLineDash([]);
      }
      if (this.keypoint) {
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.arc(r.x + this.keypoint.x * r.w, r.y + this.keypoint.y * r.h, 6, 0, Math.PI * 2);
        g.fill();
      }
    }

    drawRing(bins) {
      const c = this.ui.ring;
      const g = c.getContext('2d');
      const s = c.width, R = s / 2 - 6;
      g.clearRect(0, 0, s, s);
      for (let k = 0; k < 24; k++) {
        const a0 = (k / 24) * Math.PI * 2 - Math.PI / 2, a1 = a0 + (Math.PI * 2) / 24 - 0.05;
        g.strokeStyle = bins.has(k) ? '#f2cd37' : 'rgba(255,255,255,0.25)';
        g.lineWidth = 8;
        g.beginPath(); g.arc(s / 2, s / 2, R, a0, a1); g.stroke();
      }
    }

    // A small rotating clay preview of the shape carved so far.
    drawPreview() {
      const c = this.ui.preview;
      const g = c.getContext('2d');
      const s = c.width;
      g.clearRect(0, 0, s, s);
      if (this.carver.count < 2) return;
      const pts = this.carver.surfacePoints(5000);
      const last = this.carver.views[this.carver.views.length - 1];
      const yaw = Math.atan2(last.pos[0], last.pos[2]);
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const scale = s / (2.2 * this.carver.half);
      const light = normalize([-0.4, 0.8, 0.5]);
      const proj = pts.map(([x, y, z, nx, ny, nz]) => {
        const rx = x * cy - z * sy, rz = x * sy + z * cy;
        const rnx = nx * cy - nz * sy, rnz = nx * sy + nz * cy;
        const shade = 0.35 + 0.65 * Math.max(0, rnx * light[0] + ny * light[1] + rnz * light[2]);
        return [rx, y, rz, shade];
      }).sort((a, b) => a[2] - b[2]);
      const px = Math.max(2, this.carver.step * scale * 1.3);
      for (const [x, y, , shade] of proj) {
        const v = Math.round(90 + 140 * shade);
        g.fillStyle = `rgb(${v},${Math.round(v * 0.93)},${Math.round(v * 0.8)})`;
        g.fillRect(s / 2 + x * scale - px / 2, s / 2 - y * scale - px / 2, px, px);
      }
    }
  }

  // ---------- review ----------

  Object.assign(Scanner.prototype, {
    renderReviewGrid() {
      const grid = this.ui.reviewGrid;
      grid.textContent = '';
      this.reviewItems = this.carver.all.map((view) => {
        const item = document.createElement('div');
        item.className = 'capture';
        view.thumb.className = 'capture-img';
        const eye = document.createElement('button');
        eye.type = 'button';
        eye.className = 'eye';
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = '⚠';
        badge.title = 'This capture doesn\'t match the others. Try hiding it.';
        const num = document.createElement('span');
        num.className = 'num';
        num.textContent = view.index + 1;
        item.append(view.thumb, eye, badge, num);
        const toggle = () => {
          if (this.refining) return;
          if (view.enabled && this.carver.count <= 4) return; // keep enough to carve with
          this.carver.setEnabled(view, !view.enabled);
          this.refreshReview();
        };
        eye.addEventListener('click', toggle);
        view.thumb.addEventListener('click', toggle);
        return { view, item, eye, badge };
      });
      grid.append(...this.reviewItems.map((r) => r.item));
    },

    refreshReview() {
      const { carver, ui } = this;
      if (carver.useOpenings) carver.applyDepth(); // captures may have been switched on or off
      for (const { view, item, eye, badge } of this.reviewItems) {
        item.classList.toggle('off', !view.enabled);
        eye.innerHTML = view.enabled ? EYE : EYE_OFF;
        eye.setAttribute('aria-label', `${view.enabled ? 'Hide' : 'Show'} capture ${view.index + 1}`);
        const { missing, extra } = carver.agreement(view);
        badge.hidden = !(missing > 0.2 || extra > 0.35);
      }
      const dug = carver.useOpenings && carver.dug ? carver.dug.reduce((a, b) => a + b, 0) : 0;
      ui.reviewInfo.textContent = `Using ${carver.count} of ${carver.all.length} captures` +
        (dug ? ', with openings dug out from depth' : '') +
        '. Tap the eye on a capture to leave it out and see if the shape gets better.';
      this.renderReview3d();
    },

    // The shape as it would be built: a coloured voxel model you can spin around.
    renderReview3d() {
      const T = this.T;
      if (!this.r3d) {
        const renderer = new T.WebGLRenderer({ canvas: this.ui.reviewCanvas, antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        const scene = new T.Scene();
        scene.add(new T.HemisphereLight(0xffffff, 0x445066, 2));
        const sun = new T.DirectionalLight(0xffffff, 1.6);
        sun.position.set(-1, 2, 1.5);
        scene.add(sun);
        const camera = new T.PerspectiveCamera(35, 1, 0.1, 1000);
        const controls = new T.OrbitControls(camera, this.ui.reviewCanvas);
        controls.autoRotate = true;
        controls.autoRotateSpeed = 1.5;
        controls.enableDamping = true;
        controls.addEventListener('start', () => { controls.autoRotate = false; });
        this.r3d = { renderer, scene, camera, controls, mesh: null };
      }
      const { scene, camera, controls } = this.r3d;
      const vol = this.carver.volume({ size: 40 });
      const { cols, rows, depth, voxels } = vol;
      const filled = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < cols && y < rows && z < depth &&
        voxels[(y * depth + z) * cols + x] >= 0;
      const cells = [];
      for (let y = 0; y < rows; y++) {
        for (let z = 0; z < depth; z++) {
          for (let x = 0; x < cols; x++) {
            const c = voxels[(y * depth + z) * cols + x];
            if (c < 0) continue;
            if (filled(x + 1, y, z) && filled(x - 1, y, z) && filled(x, y + 1, z) && filled(x, y - 1, z) &&
              filled(x, y, z + 1) && filled(x, y, z - 1)) continue;
            cells.push([x, y, z, c]);
          }
        }
      }
      if (this.r3d.mesh) { scene.remove(this.r3d.mesh); this.r3d.mesh.geometry.dispose(); }
      const mesh = new T.InstancedMesh(new T.BoxGeometry(0.96, L.BRICK_HEIGHT * 0.96, 0.96),
        new T.MeshStandardMaterial({ roughness: 0.4 }), Math.max(1, cells.length));
      const m = new T.Matrix4(), color = new T.Color();
      cells.forEach(([x, y, z, c], i) => {
        m.makeTranslation(x - cols / 2, (y + 0.5) * L.BRICK_HEIGHT, z - depth / 2);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, color.set(L.PALETTE[c].css));
      });
      scene.add(mesh);
      this.r3d.mesh = mesh;
      const h = rows * L.BRICK_HEIGHT, span = Math.max(h, cols, depth);
      if (!this.r3d.framed) {
        // Look down at it from about 40°, so openings (the inside of a shoe or cup) are visible.
        controls.target.set(0, h / 2, 0);
        camera.position.set(span * 0.8, h / 2 + span * 1.3, span * 1.3);
        this.r3d.framed = true;
      }
    },

    reviewLoop() {
      if (!this.reviewing) { if (this.r3d) this.r3d.framed = false; return; }
      requestAnimationFrame(() => this.reviewLoop());
      if (!this.r3d) return;
      const { renderer, scene, camera, controls } = this.r3d;
      const c = this.ui.reviewCanvas;
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== Math.round(w * renderer.getPixelRatio())) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      controls.update(1 / 60);
      renderer.render(scene, camera);
    },
  });

  const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M2 12s3.6-7 10-7c2 0 3.8.7 5.2 1.6M22 12s-3.6 7-10 7c-2 0-3.8-.7-5.2-1.6M3 3l18 18"/></svg>';

  L.maskStats = maskStats;
  L.Carver = Carver;
  L.Scanner = Scanner;
  L.cameraRotation = cameraRotation;
})(window.Legofy = window.Legofy || {});
