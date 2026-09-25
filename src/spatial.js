// iPhone spatial photos: a HEIC holding two views taken a few centimetres apart (left and right eye).
// The shift of each point between the two views (its disparity) is proportional to 1 / distance, so
// the pair measures depth in the right proportion to the object's width and height. Stereo matching
// alone is sparse and noisy at this small baseline, so the AI depth model fills in a smooth, dense map
// and the stereo disparities calibrate it (the model's output is only defined up to scale and offset).
(function (L) {
  const WORK_WIDTH = 512;        // processing resolution
  const MAX_SHIFT = 40;          // largest disparity searched, in pixels at WORK_WIDTH
  const R = 3;                   // matching window radius (7×7)
  // Horizontal field of view assumed for the photo (iPhone main camera). Only affects how deep things
  // come out relative to their width, and only mildly.
  const FOV_H = (63 * Math.PI) / 180;

  // Decode every image in a HEIC/HEIF file to canvases.
  L.decodeHeic = async function (libheif, bytes) {
    const decoder = new libheif.HeifDecoder();
    const images = decoder.decode(bytes);
    const canvases = [];
    for (const image of images) {
      const w = image.get_width(), h = image.get_height();
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      const data = g.createImageData(w, h);
      await new Promise((resolve, reject) => image.display(data, (out) => (out ? resolve() : reject(new Error('Could not decode the HEIC image.')))));
      g.putImageData(data, 0, 0);
      canvases.push(c);
    }
    return canvases;
  };

  function scaled(source, w) {
    const h = Math.round((source.height * w) / source.width);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(source, 0, 0, w, h);
    return c;
  }

  function gray(canvas) {
    const { width: w, height: h } = canvas;
    const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const out = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    return out;
  }

  // Block matching on a sparse grid: for each textured pixel of the left image, find the horizontal
  // shift into the right image with the lowest sum of absolute differences. Keeps only clear winners,
  // refined to sub-pixel with a parabola. Returns [x, y, disparity] triples (sign as found).
  function matchStereo(a, b, w, h) {
    const pts = [];
    const costs = new Float32Array(2 * MAX_SHIFT + 1);
    for (let y = R + 1; y < h - R - 1; y += 3) {
      for (let x = R + MAX_SHIFT + 1; x < w - R - MAX_SHIFT - 1; x += 3) {
        // Skip flat patches: nothing to match on.
        let mean = 0;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) mean += a[(y + dy) * w + x + dx];
        mean /= (2 * R + 1) ** 2;
        let spread = 0;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) spread += Math.abs(a[(y + dy) * w + x + dx] - mean);
        if (spread / (2 * R + 1) ** 2 < 4) continue;
        let best = 0, bestCost = Infinity;
        for (let s = -MAX_SHIFT; s <= MAX_SHIFT; s++) {
          let cost = 0;
          for (let dy = -R; dy <= R; dy++) {
            const row = (y + dy) * w;
            for (let dx = -R; dx <= R; dx++) cost += Math.abs(a[row + x + dx] - b[row + x + dx - s]);
          }
          costs[s + MAX_SHIFT] = cost;
          if (cost < bestCost) { bestCost = cost; best = s; }
        }
        // Unique: the best must clearly beat everything not right next to it.
        let second = Infinity;
        for (let s = -MAX_SHIFT; s <= MAX_SHIFT; s++) {
          if (Math.abs(s - best) > 1) second = Math.min(second, costs[s + MAX_SHIFT]);
        }
        if (bestCost > second * 0.8 || Math.abs(best) === MAX_SHIFT) continue;
        const c0 = costs[best - 1 + MAX_SHIFT], c1 = bestCost, c2 = costs[best + 1 + MAX_SHIFT];
        const denom = c0 - 2 * c1 + c2;
        pts.push([x, y, best + (denom > 0 ? (0.5 * (c0 - c2)) / denom : 0)]);
      }
    }
    return pts;
  }

  // Cut the subject out of the (left) photo with the on-device segmenter, pointed at `keypoint`
  // (the middle of the photo unless told otherwise), and crop photo, depth and mask to it.
  L.spatialSubject = function ({ image, dist, segmenter, keypoint = { x: 0.5, y: 0.5 } }) {
    const w = image.width, h = image.height;
    const mask = L.segmentZoomed(segmenter, image, w, h, w, h, { keypoint }, null);
    // The finder picks the part under the point (a mushroom's cap, not its stem). Probe just outside
    // what we have and add neighbouring pieces that touch it, unless they look like background
    // (running off the photo, much bigger than the object so far, or much further away than it).
    for (let round = 0; round < 1; round++) {
      const box = boundsOf(mask, w, h);
      if (!box) break;
      const area = box.area, gap = Math.max(4, Math.round(Math.max(box.x1 - box.x0, box.y1 - box.y0) * 0.06));
      const cx = Math.round((box.x0 + box.x1) / 2), cy = Math.round((box.y0 + box.y1) / 2);
      const probes = [[cx, box.y1 + gap], [cx, box.y0 - gap], [box.x0 - gap, cy], [box.x1 + gap, cy]];
      let grew = false;
      for (const [px, py] of probes) {
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const part = L.segmentZoomed(segmenter, image, w, h, w, h, { keypoint: { x: (px + 0.5) / w, y: (py + 0.5) / h } }, null);
        const pb = boundsOf(part, w, h);
        if (!pb || pb.area > area * 3 || pb.area > w * h * 0.4 || pb.edge > (w + h) * 0.02) continue;
        let touches = 0;
        for (let i = 0; i < w * h && !touches; i++) {
          if (part[i] < 0.5) continue;
          const x = i % w, y = (i - x) / w;
          for (let dy = -3; dy <= 3 && !touches; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
              const xx = x + dx, yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < w && yy < h && mask[yy * w + xx] >= 0.5) { touches = 1; break; }
            }
          }
        }
        if (!touches) continue;
        // What the piece adds must be at the object's distance, not the wall's behind it.
        const own = [], added = [];
        for (let i = 0; i < w * h; i++) {
          if (mask[i] >= 0.5) own.push(dist[i]);
          else if (part[i] >= 0.5) added.push(dist[i]);
        }
        if (!added.length) continue;
        own.sort((a, b) => a - b); added.sort((a, b) => a - b);
        if (added[added.length >> 1] > own[Math.floor(own.length * 0.95)] * 1.1) continue;
        for (let i = 0; i < w * h; i++) if (part[i] > mask[i]) mask[i] = part[i];
        grew = true;
      }
      if (!grew) break;
    }
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x] < 0.5) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    if (x1 < 0 || (x1 - x0 + 1) * (y1 - y0 + 1) < w * h * 0.005) return null;
    const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04);
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    c.getContext('2d').drawImage(image, x0, y0, cw, ch, 0, 0, cw, ch);
    const cd = new Float32Array(cw * ch), cm = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        cd[y * cw + x] = dist[(y + y0) * w + x + x0];
        cm[y * cw + x] = mask[(y + y0) * w + x + x0];
      }
    }
    return { image: c, dist: cd, mask: cm };
  };

  function boundsOf(mask, w, h) {
    let x0 = w, x1 = -1, y0 = h, y1 = -1, area = 0, edge = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x] < 0.5) continue;
        area++;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge++;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    return area ? { x0, x1, y0, y1, area, edge } : null;
  }

  // Dense depth for the left view. Returns { image: canvas at WORK_WIDTH, dist: Float32Array of
  // relative distance per pixel (1 / disparity, arbitrary unit), f: focal length in pixels, stereoPoints }.
  L.spatialDepth = async function ({ left, right, depthModel, onProgress = () => {} }) {
    const lw = scaled(left, WORK_WIDTH);
    const w = lw.width, h = lw.height;
    const f = w / 2 / Math.tan(FOV_H / 2);
    let pts = [];
    if (right) {
      onProgress('Matching the two views…');
      await new Promise((r) => setTimeout(r, 0));
      const rw = scaled(right, WORK_WIDTH);
      pts = matchStereo(gray(lw), gray(rw), w, h);
      // Which image is the left eye isn't always marked; nearer things must shift more, in the positive
      // direction, so flip if most shifts came out negative.
      const neg = pts.filter((p) => p[2] < 0).length;
      if (neg > pts.length / 2) pts = pts.map(([x, y, d]) => [x, y, -d]);
    }

    onProgress('Estimating depth…');
    const out = await depthModel(lw.toDataURL('image/jpeg', 0.92));
    const pd = out.predicted_depth;
    const [dh, dw] = pd.dims.slice(-2);
    const rel = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) rel[y * w + x] = pd.data[Math.floor((y * dh) / h) * dw + Math.floor((x * dw) / w)];
    }

    // Calibrate the model's relative depth to true disparity: disparity = a·rel + b, fitted on the
    // stereo matches (least squares, then again on the 70% that agree best).
    let a = 0, b = 0, stereoUsed = 0;
    const good = pts.filter((p) => p[2] > 0.3);
    if (good.length >= 40) {
      const fit = (set) => {
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const [x, y, d] of set) {
          const r = rel[y * w + x];
          sx += r; sy += d; sxx += r * r; sxy += r * d;
        }
        const n = set.length, vx = sxx - (sx * sx) / n;
        const slope = vx ? (sxy - (sx * sy) / n) / vx : 0;
        return [slope, (sy - slope * sx) / n];
      };
      [a, b] = fit(good);
      const res = good.map(([x, y, d]) => Math.abs(a * rel[y * w + x] + b - d));
      const cut = [...res].sort((m, n) => m - n)[Math.floor(res.length * 0.7)];
      const kept = good.filter((_, n) => res[n] <= cut);
      [a, b] = fit(kept);
      stereoUsed = kept.length;
    }
    if (!(a > 0)) {
      // No usable stereo (not a spatial photo, or nothing textured to match): assume the nearest point
      // is about a third closer than the farthest, a gentle relief.
      let lo = Infinity, hi = -Infinity;
      for (const r of rel) { lo = Math.min(lo, r); hi = Math.max(hi, r); }
      a = 1 / Math.max(1e-6, hi - lo); b = 2;
    }
    const dist = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) dist[i] = 1 / Math.max(0.05, a * rel[i] + b);
    return { image: lw, dist, f, stereoPoints: good.length, stereoUsed, rel, fit: { a, b }, points: good };
  };
})(window.Legofy = window.Legofy || {});
