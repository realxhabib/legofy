// 3D model (e.g. an iPhone scan) -> solid color volume ready for bricks.
// Surfaces are sampled densely, each sample takes its color from the texture, vertex colors or
// material, voxels average their samples, and the closed interior is filled in.
(function (L) {
  // Rotations that bring the chosen axis to +Y (up).
  const UP = {
    y: [0, 0, 0], z: [-Math.PI / 2, 0, 0], '-y': [Math.PI, 0, 0], '-z': [Math.PI / 2, 0, 0],
    x: [0, 0, Math.PI / 2], '-x': [0, 0, -Math.PI / 2],
  };

  const MAX_TEXTURE = 1024;

  function texturePixels(texture, cache) {
    if (cache.has(texture)) return cache.get(texture);
    let result = null;
    const img = texture.image;
    try {
      if (img && img.data && img.width && img.data.length === img.width * img.height * 4) {
        result = { data: img.data, w: img.width, h: img.height };
      } else if (img && img.width) {
        const scale = Math.min(1, MAX_TEXTURE / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, c.width, c.height);
        result = { data: g.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
      }
    } catch (err) {
      console.warn('Legofy: could not read a texture, using the material color instead.', err);
    }
    cache.set(texture, result);
    return result;
  }

  L.voxelizeModel = function (T, root, { size = 36, up = 'y' } = {}) {
    root.updateMatrixWorld(true);
    const rot = new T.Matrix4().makeRotationFromEuler(new T.Euler(...(UP[up] || UP.y)));

    // Gather every mesh / point cloud with its vertices already in the rotated world space.
    const parts = [];
    const min = new T.Vector3(Infinity, Infinity, Infinity);
    const max = new T.Vector3(-Infinity, -Infinity, -Infinity);
    const v = new T.Vector3();
    root.traverse((o) => {
      if (!(o.isMesh || o.isPoints) || !o.geometry?.attributes.position || o.visible === false) return;
      const pos = o.geometry.attributes.position;
      const matrix = new T.Matrix4().multiplyMatrices(rot, o.matrixWorld);
      const world = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
        world[i * 3] = v.x; world[i * 3 + 1] = v.y; world[i * 3 + 2] = v.z;
        min.min(v); max.max(v);
      }
      parts.push({ object: o, geometry: o.geometry, world });
    });
    if (!parts.length) throw new Error('No mesh or points found in that file.');

    // Scale so the longest side is `size` studs. Layers are a brick tall (1.2 studs).
    const ext = new T.Vector3().subVectors(max, min);
    const scale = size / Math.max(ext.x, ext.y, ext.z, 1e-6);
    const cols = Math.max(1, Math.floor(ext.x * scale) + 1);
    const depth = Math.max(1, Math.floor(ext.z * scale) + 1);
    const rows = Math.max(1, Math.floor((ext.y * scale) / L.BRICK_HEIGHT) + 1);
    const N = cols * rows * depth;
    // Each voxel keeps a running majority vote over the LEGO colors of its samples (Boyer-Moore),
    // so a seam between two colors stays crisp instead of averaging into a third color.
    const candidate = new Int16Array(N).fill(-1);
    const votes = new Uint32Array(N);
    const counts = new Uint32Array(N);
    const colorCache = new Int16Array(32768).fill(-1);
    const toPalette = (r, g, b) => {
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      if (colorCache[key] < 0) colorCache[key] = L.nearestColor(((r >> 3) << 3) + 4, ((g >> 3) << 3) + 4, ((b >> 3) << 3) + 4);
      return colorCache[key];
    };

    const toGrid = (wx, wy, wz, out) => {
      out[0] = (wx - min.x) * scale;
      out[1] = ((wy - min.y) * scale) / L.BRICK_HEIGHT;
      out[2] = (wz - min.z) * scale;
      return out;
    };
    const add = (gx, gy, gz, rgb) => {
      const x = Math.min(cols - 1, Math.max(0, Math.floor(gx)));
      const y = Math.min(rows - 1, Math.max(0, Math.floor(gy)));
      const z = Math.min(depth - 1, Math.max(0, Math.floor(gz)));
      const i = (y * depth + z) * cols + x;
      const c = toPalette(Math.min(255, rgb[0]) | 0, Math.min(255, rgb[1]) | 0, Math.min(255, rgb[2]) | 0);
      counts[i]++;
      if (candidate[i] === c) votes[i]++;
      else if (votes[i] === 0) { candidate[i] = c; votes[i] = 1; } else votes[i]--;
    };

    const textures = new Map();
    const color = new T.Color(), vertexColor = new T.Color();
    const uv = new T.Vector2();
    const rgb = [0, 0, 0];
    let triangles = 0, points = 0;

    for (const { object, geometry, world } of parts) {
      const colorAttr = geometry.attributes.color;
      const uvAttr = geometry.attributes.uv;
      const materials = Array.isArray(object.material) ? object.material : [object.material];

      // Linear color attribute/material -> sRGB 0..255, optionally tinted by a texture sample.
      const shade = (mat, a, b, c, wa, wb, wc) => {
        color.setRGB(1, 1, 1);
        if (mat?.color) color.copy(mat.color);
        if (colorAttr && (mat?.vertexColors || !mat?.map)) {
          const ch = (fn) => fn.call(colorAttr, a) * wa + fn.call(colorAttr, b) * wb + fn.call(colorAttr, c) * wc;
          color.multiply(vertexColor.setRGB(ch(colorAttr.getX), ch(colorAttr.getY), ch(colorAttr.getZ)));
        }
        color.getRGB(color, T.SRGBColorSpace);
        rgb[0] = color.r * 255; rgb[1] = color.g * 255; rgb[2] = color.b * 255;
        const tex = mat?.map;
        const px = tex && uvAttr && texturePixels(tex, textures);
        if (px) {
          uv.set(
            uvAttr.getX(a) * wa + uvAttr.getX(b) * wb + uvAttr.getX(c) * wc,
            uvAttr.getY(a) * wa + uvAttr.getY(b) * wb + uvAttr.getY(c) * wc,
          );
          if (tex.matrixAutoUpdate) tex.updateMatrix();
          tex.transformUv(uv);
          const tx = Math.min(px.w - 1, Math.max(0, Math.floor(uv.x * px.w)));
          const ty = Math.min(px.h - 1, Math.max(0, Math.floor(uv.y * px.h)));
          const k = (ty * px.w + tx) * 4;
          rgb[0] *= px.data[k] / 255; rgb[1] *= px.data[k + 1] / 255; rgb[2] *= px.data[k + 2] / 255;
        }
        return rgb;
      };

      const g = [0, 0, 0], p = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      const vertexCount = world.length / 3;

      if (object.isPoints) {
        for (let i = 0; i < vertexCount; i++) {
          toGrid(world[i * 3], world[i * 3 + 1], world[i * 3 + 2], g);
          add(g[0], g[1], g[2], shade(materials[0], i, i, i, 1, 0, 0));
          points++;
        }
        continue;
      }

      const index = geometry.index;
      const triCount = (index ? index.count : vertexCount) / 3;
      const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: triCount * 3, materialIndex: 0 }];
      for (const group of groups) {
        const mat = materials[group.materialIndex] || materials[0];
        const end = Math.min(group.start + group.count, triCount * 3);
        for (let t = group.start; t + 2 < end; t += 3) {
          const a = index ? index.getX(t) : t;
          const b = index ? index.getX(t + 1) : t + 1;
          const c = index ? index.getX(t + 2) : t + 2;
          for (const [k, vi] of [[0, a], [1, b], [2, c]]) toGrid(world[vi * 3], world[vi * 3 + 1], world[vi * 3 + 2], p[k]);
          // Sample the triangle on a barycentric grid finer than half a voxel.
          const edge = Math.max(
            Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1], p[0][2] - p[1][2]),
            Math.hypot(p[1][0] - p[2][0], p[1][1] - p[2][1], p[1][2] - p[2][2]),
            Math.hypot(p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]),
          );
          const n = Math.max(1, Math.ceil(edge / 0.4));
          for (let i = 0; i <= n; i++) {
            for (let j = 0; i + j <= n; j++) {
              const wa = i / n, wb = j / n, wc = 1 - wa - wb;
              add(
                p[0][0] * wa + p[1][0] * wb + p[2][0] * wc,
                p[0][1] * wa + p[1][1] * wb + p[2][1] * wc,
                p[0][2] * wa + p[1][2] * wb + p[2][2] * wc,
                shade(mat, a, b, c, wa, wb, wc),
              );
            }
          }
          triangles++;
        }
      }
    }

    // Everything reachable from outside without crossing the surface is air; the rest is solid.
    const outside = new Uint8Array(N);
    const queue = new Int32Array(N);
    let head = 0, tail = 0;
    const seed = (i) => { if (!counts[i] && !outside[i]) { outside[i] = 1; queue[tail++] = i; } };
    for (let y = 0; y < rows; y++) {
      for (let z = 0; z < depth; z++) {
        for (let x = 0; x < cols; x++) {
          if (x === 0 || y === 0 || z === 0 || x === cols - 1 || y === rows - 1 || z === depth - 1) {
            seed((y * depth + z) * cols + x);
          }
        }
      }
    }
    const neighbors = (i, fn) => {
      const x = i % cols, z = Math.floor(i / cols) % depth, y = Math.floor(i / (cols * depth));
      if (x > 0) fn(i - 1);
      if (x < cols - 1) fn(i + 1);
      if (z > 0) fn(i - cols);
      if (z < depth - 1) fn(i + cols);
      if (y > 0) fn(i - cols * depth);
      if (y < rows - 1) fn(i + cols * depth);
    };
    while (head < tail) neighbors(queue[head++], seed);

    // Surface voxels take their winning color; interior voxels inherit the nearest surface color.
    const voxels = new Int16Array(N).fill(-1);
    head = tail = 0;
    for (let i = 0; i < N; i++) {
      if (!counts[i]) continue;
      voxels[i] = candidate[i];
      queue[tail++] = i;
    }
    while (head < tail) {
      const i = queue[head++];
      neighbors(i, (n) => {
        if (outside[n] || voxels[n] >= 0) return;
        voxels[n] = voxels[i];
        queue[tail++] = n;
      });
    }

    return { cols, rows, depth, voxels, stats: { triangles, points } };
  };

  // A toadstool with a textured, spotted cap: a stand-in for a real scan.
  L.sampleModel = function (T) {
    const group = new T.Group();
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#d22a1e';
    g.fillRect(0, 0, 512, 256);
    g.fillStyle = '#fbf6ea';
    const spots = [[40, 60, 26], [150, 110, 30], [260, 50, 24], [370, 120, 32], [470, 70, 22],
      [100, 200, 20], [320, 210, 18], [210, 190, 16], [430, 200, 18], [20, 150, 14]];
    for (const [x, y, r] of spots) {
      for (const dx of [-512, 0, 512]) { g.beginPath(); g.arc(x + dx, y, r, 0, Math.PI * 2); g.fill(); }
    }
    const map = new T.CanvasTexture(c);
    map.colorSpace = T.SRGBColorSpace;

    const cap = new T.Mesh(
      new T.SphereGeometry(1, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2),
      new T.MeshStandardMaterial({ map }),
    );
    cap.scale.set(1.3, 0.9, 1.3);
    cap.position.y = 1.05;
    const gills = new T.Mesh(new T.CircleGeometry(1.3, 64), new T.MeshStandardMaterial({ color: '#e9dcc0' }));
    gills.rotation.x = Math.PI / 2;
    gills.position.y = 1.05;
    const stem = new T.Mesh(new T.CylinderGeometry(0.45, 0.58, 1.1, 48), new T.MeshStandardMaterial({ color: '#f4ecdc' }));
    stem.position.y = 0.55;
    group.add(cap, gills, stem);
    for (const x of [-0.17, 0.17]) {
      const eye = new T.Mesh(new T.SphereGeometry(0.09, 16, 12), new T.MeshStandardMaterial({ color: '#111111' }));
      eye.position.set(x, 0.72, 0.47);
      group.add(eye);
    }
    return group;
  };
})(window.Legofy = window.Legofy || {});

// Starship, full stack (Block 2 proportions from public figures): Super Heavy booster, vented
// hot-staging ring and Ship, ~123 m tall and 9 m across. Units are meters; +x is the windward side
// (the black heat-shield tiles), the flaps sit where tiles meet steel, raceways run down the lee side.
(function (L) {
  L.starshipModel = function (T) {
    const group = new T.Group();
    const R = 4.5;
    const mat = (color) => new T.MeshStandardMaterial({ color });
    const steel = mat('#bcc1c6');
    const skirt = mat('#6c6e68');
    const tiles = mat('#1c1e21');
    const vent = mat('#141517');
    const fin = mat('#55595e');
    const conduit = mat('#9aa0a6');
    const place = (geometry, material, x, y, z, rotY = 0) => {
      const m = new T.Mesh(geometry, material);
      m.position.set(x, y, z);
      m.rotation.y = rotY;
      group.add(m);
      return m;
    };
    // A box hugging the hull at azimuth a (0 = +x), centred at height y.
    const onHull = (w, h, d, material, a, y, out = 0) => {
      const r = R + d / 2 + out;
      return place(new T.BoxGeometry(d, h, w), material, Math.cos(a) * r, y, -Math.sin(a) * r, a);
    };
    // A flap: a tapered plate (root chord along the hull, shorter tip), sticking out at azimuth a.
    const flap = (span, root, tip, thick, a, y0, radius) => {
      const shape = new T.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(span, (root - tip) * 0.35);
      shape.lineTo(span, (root - tip) * 0.35 + tip);
      shape.lineTo(0, root);
      shape.closePath();
      const g = new T.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
      g.translate(0, 0, -thick / 2);
      const m = new T.Mesh(g, tiles);
      m.position.set(Math.cos(a) * (radius - 0.3), y0, -Math.sin(a) * (radius - 0.3));
      m.rotation.y = a;
      group.add(m);
    };

    // ---- Super Heavy booster (0 – 69.2 m) ----
    const boosterTop = 69.2;
    place(new T.CylinderGeometry(R, R, 1.2, 64), skirt, 0, 0.6, 0);                  // sooty base of the engine skirt
    place(new T.CylinderGeometry(R, R, boosterTop - 1.2, 64), steel, 0, 1.2 + (boosterTop - 1.2) / 2, 0);
    onHull(0.7, boosterTop - 8, 0.4, conduit, Math.PI, 4.6 + (boosterTop - 8) / 2 + 1);   // raceway, lee side
    // Four lattice grid fins near the top: horizontal waffles sticking straight out.
    const finY = 64.2, finOut = 3.4, finWide = 4.4, finDeep = 1.1, bar = 0.28;
    for (const deg of [45, 135, 225, 315]) {
      const a = (deg * Math.PI) / 180;
      const holder = new T.Group();
      holder.position.set(0, finY, 0);
      holder.rotation.y = a;
      const add = (w, d, x, z) => {
        const m = new T.Mesh(new T.BoxGeometry(w, finDeep, d), fin);
        m.position.set(x, 0, z);
        holder.add(m);
      };
      const x0 = R + 0.2, x1 = R + 0.2 + finOut;
      add(finOut, bar, (x0 + x1) / 2, -finWide / 2);                 // frame
      add(finOut, bar, (x0 + x1) / 2, finWide / 2);
      add(bar, finWide, x1, 0);
      add(bar, finWide, x0, 0);
      for (let k = 1; k < 4; k++) add(finOut, bar * 0.8, (x0 + x1) / 2, -finWide / 2 + (k * finWide) / 4); // lattice
      for (let k = 1; k < 3; k++) add(bar * 0.8, finWide, x0 + (k * finOut) / 3, 0);
      // actuator housing between fin and hull
      const box = new T.Mesh(new T.BoxGeometry(0.8, 1.6, 1.6), skirt);
      box.position.set(R + 0.3, 0.2, 0);
      holder.add(box);
      group.add(holder);
    }
    // Catch fittings the tower's arms lift the booster by, under two of the fins.
    for (const deg of [45, 315]) onHull(0.9, 0.8, 0.9, fin, (deg * Math.PI) / 180, finY - 2.2);

    // ---- Hot-staging ring (69.2 – 71 m): steel band with dark vent openings all round ----
    const ringY = boosterTop + 0.9;
    place(new T.CylinderGeometry(R, R, 1.8, 64), steel, 0, ringY, 0);
    for (let k = 0; k < 20; k++) onHull(0.8, 1.25, 0.15, vent, (k / 20) * Math.PI * 2, ringY);

    // ---- Ship (71 – 123.1 m) ----
    const shipBase = 71, barrel = 33.1, noseLen = 123.1 - shipBase - barrel;
    const noseBase = shipBase + barrel;
    place(new T.CylinderGeometry(R, R, barrel, 64), steel, 0, shipBase + barrel / 2, 0);
    // Heat shield: tiles over the windward (+x) half, from just above the aft skirt up to the nose.
    // (Cylinder and lathe both sweep from +z through +x to -z for angles 0..π.)
    place(new T.CylinderGeometry(R + 0.1, R + 0.1, barrel - 1, 64, 1, true, 0, Math.PI),
      tiles, 0, shipBase + 1 + (barrel - 1) / 2, 0);
    onHull(0.6, barrel - 6, 0.35, conduit, Math.PI, shipBase + 3 + (barrel - 6) / 2);    // raceway
    onHull(3.6, 1.1, 0.12, vent, Math.PI * 0.72, shipBase + barrel - 7);               // payload door
    // Ogive nose; tiles wrap its windward half and the whole tip.
    const nose = [];
    for (let i = 0; i <= 32; i++) {
      const t = i / 32;
      nose.push(new T.Vector2(R * Math.sqrt(Math.max(0, 1 - Math.pow(t, 2.1))) * (1 - 0.12 * t * t), t * noseLen));
    }
    place(new T.LatheGeometry(nose, 64), steel, 0, noseBase, 0);
    const shieldNose = nose.map((p) => new T.Vector2(p.x + 0.1, p.y));
    place(new T.LatheGeometry(shieldNose, 64, 0, Math.PI), tiles, 0, noseBase, 0);
    const tipStart = Math.floor(nose.length * 0.8);
    place(new T.LatheGeometry(shieldNose.slice(tipStart), 64), tiles, 0, noseBase, 0);
    // Flaps at the tile/steel boundary (±z): big aft pair low on the ship, smaller forward pair on the nose.
    for (const side of [1, -1]) {
      const a = (side * Math.PI) / 2;
      flap(4.6, 12.5, 7.5, 0.6, a, shipBase + 1.5, R);
      flap(3.2, 8.5, 4.5, 0.5, a + side * -0.25, noseBase + 2.5, R * 0.92);
    }
    return group;
  };
})(window.Legofy = window.Legofy || {});
