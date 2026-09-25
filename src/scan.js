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
      this.views = [];
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
    // Returns the silhouette stats, or null when the view was rejected.
    addView({ image, mask, rotation }) {
      const { width: w, height: h } = image;
      const stats = maskStats(mask, w, h);
      if (stats.area < w * h * 0.005 || stats.area > w * h * 0.8) return null;
      if (stats.edge > (w + h) * 0.04) return null;
      if (this.views.length >= 3) {
        const areas = this.views.map((v) => v.stats.area).sort((a, b) => a - b);
        const median = areas[areas.length >> 1];
        if (stats.area > median * 2.5 || stats.area < median / 2.5) return null; // grabbed the wrong thing
      }
      const f = Math.max(w, h) / 2 / Math.tan(FOV_LONG / 2);
      const R = Float64Array.from(rotation);

      if (!this.views.length) {
        // Units: the object is about 2 tall. The camera keeps this distance for the whole scan
        // (the guide frame on screen asks the user to keep the object the same size).
        const halfH = (stats.maxY - stats.minY + 1) / 2 / f;
        const halfW = (stats.maxX - stats.minX + 1) / 2 / f;
        this.distance = 1 / halfH;
        this.half = 1.8 * Math.max(1, halfW * this.distance);
        this.step = (2 * this.half) / G;
        this.outside = new Uint16Array(G * G * G);
        this.seen = new Uint16Array(G * G * G);
      }

      // The object's centre lies on the ray through the silhouette centroid.
      const dir = normalize(rotate(R, [(stats.cx + 0.5 - w / 2) / f, -(stats.cy + 0.5 - h / 2) / f, -1]));
      const pos = [-dir[0] * this.distance, -dir[1] * this.distance, -dir[2] * this.distance];
      const grow = Math.max(1, Math.round(w / 150));
      const view = { image, bin: binarize(mask, w, h, grow), w, h, f, R, pos, stats };
      // Once the shape is established, a cut-out that misses a big part of what the shape says should
      // be visible (e.g. only the lid of a jar) would wrongly carve that part away, so skip it.
      if (this.yawBins().size >= 12 && this.coverageOf(view) < 0.75) return null;
      view.core = core(mask, w, h, grow + 1);
      this.views.push(view);
      this.carve(view);
      return stats;
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

    // Where to point the segmenter in a new frame: a scribble down the middle of the shape carved
    // so far, so it selects the whole object rather than just the part under one point.
    promptFor(R, w, h, fallback) {
      if (this.views.length < 3) return { keypoint: fallback };
      const f = Math.max(w, h) / 2 / Math.tan(FOV_LONG / 2);
      const fw = Carver.forward(R);
      const view = { R, w, h, f, pos: [-fw[0] * this.distance, -fw[1] * this.distance, -fw[2] * this.distance] };
      const bands = 6;
      const rows = Array.from({ length: bands }, () => []);
      const ys = [];
      const p = [0, 0, 0];
      const floor = this.floorHeight();
      for (let i = 0; i < this.outside.length; i += 3) {
        if (!this.solidAt(i) || this.center(i, p)[1] < floor) continue;
        const k = this.project(view, p);
        if (k >= 0) ys.push(k);
      }
      if (ys.length < 20) return { keypoint: fallback };
      let minV = h, maxV = 0;
      for (const k of ys) { const v = Math.floor(k / w); minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
      for (const k of ys) {
        const v = Math.floor(k / w), u = k % w;
        const b = Math.min(bands - 1, Math.floor(((v - minV) / (maxV - minV + 1)) * bands));
        rows[b].push([u, v]);
      }
      const scribble = [];
      // The lowest band is skipped: it's where a scribble would most easily slip onto the table.
      for (const pts of rows.slice(0, bands - 1)) {
        if (pts.length < 3) continue;
        pts.sort((a, b) => a[0] - b[0]);
        const [u] = pts[pts.length >> 1];
        const v = pts.reduce((sum, q) => sum + q[1], 0) / pts.length;
        scribble.push({ x: (u + 0.5) / w, y: (v + 0.5) / h });
      }
      return scribble.length >= 2 ? { scribble } : { keypoint: fallback };
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

    carve(view) {
      const p = [0, 0, 0];
      for (let i = 0; i < G * G * G; i++) {
        const k = this.project(view, this.center(i, p));
        if (k < 0) continue;
        this.seen[i]++;
        if (!view.bin[k]) this.outside[i]++;
      }
    }

    // A voxel survives when (almost) every view that saw it saw the object there.
    solidAt(i) {
      const seen = this.seen[i];
      if (seen < Math.min(3, this.views.length)) return false;
      const allowed = this.views.length < 6 ? 0 : Math.max(1, Math.floor(seen * 0.08));
      return this.outside[i] <= allowed;
    }

    // Views looking down can't carve the space hidden under the object, so estimate the tabletop
    // height: the lowest silhouette point is the front edge of the base, which touches the table.
    floorHeight() {
      const heights = [];
      for (const v of this.views) {
        const { stats, R, pos, f, w, h } = v;
        const d = normalize(rotate(R, [(stats.cx + 0.5 - w / 2) / f, -(stats.maxY + 1 - h / 2) / f, -1]));
        if (d[1] >= 0) continue;
        const baseR = (stats.baseHalf * this.distance) / f;
        // Point on the ray whose horizontal distance from the vertical axis equals the base radius.
        const a = d[0] * d[0] + d[2] * d[2];
        const b = 2 * (pos[0] * d[0] + pos[2] * d[2]);
        const c = pos[0] * pos[0] + pos[2] * pos[2] - baseR * baseR;
        const disc = b * b - 4 * a * c;
        const t = disc >= 0 ? (-b - Math.sqrt(disc)) / (2 * a) : -b / (2 * a);
        heights.push(pos[1] + t * d[1]);
      }
      if (!heights.length) return -Infinity;
      heights.sort((x, y) => x - y);
      return heights[Math.floor(heights.length * 0.5)];
    }

    occupancy() {
      const floor = this.floorHeight();
      const solid = new Uint8Array(G * G * G);
      const p = [0, 0, 0];
      for (let i = 0; i < solid.length; i++) {
        if (this.solidAt(i) && this.center(i, p)[1] >= floor) solid[i] = 1;
      }
      return solid;
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
    }

    status(msg) { this.ui.status.textContent = msg; }

    // Must be called from a tap/click: iOS only grants motion sensors inside a user gesture.
    async open() {
      const { ui } = this;
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser can\'t use the camera. Open the page over https in Safari or Chrome on your phone.');
      }
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const answer = await DeviceOrientationEvent.requestPermission();
        if (answer !== 'granted') throw new Error('Scanning needs motion & orientation access to know where the phone is.');
      }
      this.carver = new Carver();
      this.keypoint = null;
      this.busy = false;
      this.rotation = null;
      this.lastMaskAt = 0;
      window.addEventListener('deviceorientation', this.onOrientation);

      ui.root.hidden = false;
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
      this.status('Tap the object you want to build.');
      this.running = true;
      this.updateUi();
      requestAnimationFrame((t) => this.loop(t));
    }

    close() {
      this.running = false;
      window.removeEventListener('deviceorientation', this.onOrientation);
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.ui.root.hidden = true;
      document.body.classList.remove('scanning');
    }

    finish() {
      if (!this.carver || this.carver.count < 4) return;
      const carver = this.carver;
      this.close();
      this.onDone(carver);
    }

    // Where the video actually sits inside the overlay (object-fit: cover, so it may overflow).
    videoRect() {
      const { video, overlay } = this.ui;
      const W = overlay.clientWidth, H = overlay.clientHeight;
      const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
      const k = Math.max(W / vw, H / vh);
      return { x: (W - vw * k) / 2, y: (H - vh * k) / 2, w: vw * k, h: vh * k };
    }

    tap(e) {
      if (!this.running) return;
      const r = this.videoRect();
      const box = this.ui.overlay.getBoundingClientRect();
      const x = (e.clientX - box.left - r.x) / r.w, y = (e.clientY - box.top - r.y) / r.h;
      if (x < 0 || y < 0 || x > 1 || y > 1) return;
      this.keypoint = { x, y };
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
      const roi = this.carver.promptFor(rotation, image.width, image.height, this.keypoint);
      const result = this.segmenter.segment(this.frame, roi);
      const conf = result.confidenceMasks && result.confidenceMasks[0];
      const mask = conf ? Float32Array.from(conf.getAsFloat32Array()) : null;
      result.close();
      if (!mask || mask.length !== image.width * image.height) return null;
      const stats = this.carver.addView({ image, mask, rotation });
      if (stats) {
        this.keypoint = { x: (stats.cx + 0.5) / image.width, y: (stats.cy + 0.5) / image.height };
        this.drawMask(mask, image.width, image.height);
        if (this.carver.count === 1) this.guide = { ...stats, w: image.width, h: image.height };
      }
      return stats;
    }

    loop() {
      if (!this.running) return;
      requestAnimationFrame((t) => this.loop(t));
      const ready = this.keypoint && this.rotation && !this.busy;
      const steady = (this.turnRate || 0) < 1.2; // rad/s: skip blurry frames while turning fast
      if (ready && (this.forceCapture || (steady && this.carver.count && this.carver.isNewDirection(this.rotation)))) {
        this.busy = true;
        const forced = this.forceCapture;
        this.forceCapture = false;
        // Let the browser paint first so the UI never looks frozen during segmentation.
        setTimeout(() => {
          try {
            const stats = this.capture();
            if (!stats && forced) this.status('Couldn\'t pick out the object. Tap right on it again.');
            if (stats) this.updateUi();
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
        this.status(pct >= 85
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
      const age = (performance.now() - this.lastMaskAt) / 1000;
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

  L.Carver = Carver;
  L.Scanner = Scanner;
  L.cameraRotation = cameraRotation;
})(window.Legofy = window.Legofy || {});
