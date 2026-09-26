// three.js scene: the sculpture built from real-looking bricks in a bright studio (optionally on a baseplate).
// Units: 1 = one stud (8mm). Bricks are 1.2 tall, studs are 0.6 wide and 0.2 tall.
(function (L) {
  const STUD_R = 0.3, STUD_H = 0.2, PLATE_H = 0.4, GAP = 0.02;
  // Pieces fly in from all around (up and to the side), leaving a short motion trail.
  const FLY_UP = 9, FLY_OUT = 7, TRAIL = 5, TRAIL_GAP = 0.05, MAX_TRAIL = 3000;

  class Scene3D {
    constructor(canvas, T) {
      this.T = T;
      this.canvas = canvas;
      this.renderer = new T.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = T.PCFSoftShadowMap;
      this.renderer.toneMapping = T.ACESFilmicToneMapping;

      this.scene = new T.Scene();
      this.camera = new T.PerspectiveCamera(35, 1, 0.1, 2000);
      this.controls = new T.OrbitControls(this.camera, canvas);
      this.controls.enableDamping = true;
      this.controls.maxPolarAngle = Math.PI * 0.49;
      // The camera follows the build as it grows until the user takes over.
      this.follow = true;
      this.builtRows = 0;
      this.controls.autoRotateSpeed = 0.8;
      this.controls.addEventListener('start', () => { this.follow = false; this.controls.autoRotate = false; });

      this.scene.add(new T.HemisphereLight(0xffffff, 0x8aa4b8, 1.7));
      const sun = new T.DirectionalLight(0xffffff, 2.2);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.bias = -0.0005;
      sun.shadow.normalBias = 0.02;
      this.sun = sun;
      this.scene.add(sun, sun.target);

      this.material = new T.MeshStandardMaterial({ roughness: 0.32, metalness: 0 });
      this.world = new T.Group();
      this.scene.add(this.world);

      this.tmp = {
        m: new T.Matrix4(), s: new T.Matrix4(), q: new T.Quaternion(), p: new T.Vector3(), c: new T.Color(),
        axis: new T.Vector3(0, 0, 1), one: new T.Vector3(1, 1, 1), sc: new T.Vector3(), turn: new T.Matrix4(),
      };
      this.zero = new T.Matrix4().makeScale(0, 0, 0);

      const ghostMat = new T.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false });
      this.ghost = new T.Mesh(new T.BoxGeometry(1, L.BRICK_HEIGHT, 1), ghostMat);
      this.ghostEdges = new T.LineSegments(
        new T.EdgesGeometry(new T.BoxGeometry(1, L.BRICK_HEIGHT, 1)),
        new T.LineBasicMaterial({ color: 0xffffff, transparent: true }),
      );
      this.ghost.add(this.ghostEdges);
      this.ghost.visible = false;
      this.scene.add(this.ghost);

      // Motion trails: see-through copies of flying pieces a moment behind them.
      this.trail = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1),
        new T.MeshBasicMaterial({ transparent: true, opacity: 0.16, depthWrite: false }), MAX_TRAIL);
      this.trail.frustumCulled = false;
      this.trail.count = 0;
      this.trailCount = 0;
      this.scene.add(this.trail);
    }

    // For instruction pictures: pieces before `from` are washed out, so the new ones stand out.
    fadeBefore(from) {
      const c = this.tmp.c, white = new this.T.Color(1, 1, 1);
      this.model.bricks.forEach((b, i) => {
        c.set(this.model.palette[b.color].css);
        if (i < from) c.lerp(white, 0.62);
        const slot = this.slots[i];
        slot.mesh.setColorAt(slot.index, c);
        for (let k = 0; k < slot.studs.length; k++) this.studs.setColorAt(slot.stud + k, c);
      });
      for (const m of this.meshes) if (m.instanceColor) m.instanceColor.needsUpdate = true;
      if (this.studs.instanceColor) this.studs.instanceColor.needsUpdate = true;
    }

    // Show every piece, with the ones in `set` (indices) in full colour and the rest washed out; null clears.
    highlight(set) {
      const c = this.tmp.c, white = new this.T.Color(1, 1, 1);
      this.model.bricks.forEach((b, i) => {
        c.set(this.model.palette[b.color].css);
        if (set && !set.has(i)) c.lerp(white, 0.82);
        const slot = this.slots[i];
        slot.mesh.setColorAt(slot.index, c);
        for (let k = 0; k < slot.studs.length; k++) this.studs.setColorAt(slot.stud + k, c);
      });
      for (const m of this.meshes) if (m.instanceColor) m.instanceColor.needsUpdate = true;
      if (this.studs.instanceColor) this.studs.instanceColor.needsUpdate = true;
    }

    setBackground(css) {
      this.scene.background = new this.T.Color(css);
    }

    setup(model, { keepView = false, baseplate = false } = {}) {
      const T = this.T;
      this.model = model;
      this.world.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      this.world.clear();

      const { cols, rows, depth, bricks } = model;
      this.lh = model.layerHeight || L.BRICK_HEIGHT; // 1.2 bricks, 0.4 plates
      // Sub-assemblies float this high above their spot until they're put on (lifts[group], studs).
      this.assemblies = model.assemblies || [];
      this.lifts = new Float32Array(this.assemblies.length + 1);
      this.maxLift = this.assemblies.reduce((m, a) => Math.max(m, a.lift), 0);
      this.focusLift = 0;
      this.height = rows * this.lh;
      this.ghost.scale.y = this.lh / L.BRICK_HEIGHT;

      // Baseplate: a couple of studs of border around the sculpture.
      // baseplate: false, or { w, d, x0, z0 } in studs (a real baseplate under the model).
      this.floor = baseplate ? PLATE_H : 0; // where the first layer sits
      const bw = baseplate ? baseplate.w : cols + 4, bd = baseplate ? baseplate.d : depth + 4;
      const plateColor = new T.Color(baseplate ? '#A0A5A9' : '#237841');
      const px = baseplate ? baseplate.x0 + bw / 2 - cols / 2 : 0, pz = baseplate ? baseplate.z0 + bd / 2 - depth / 2 : 0;
      const base = new T.Mesh(this.boxGeometry(bw, PLATE_H, bd), new T.MeshStandardMaterial({ color: plateColor, roughness: 0.4 }));
      base.position.set(px, 0, pz);
      base.receiveShadow = true;
      base.castShadow = true;
      this.world.add(base);
      const baseStuds = new T.InstancedMesh(this.studGeometry(), new T.MeshStandardMaterial({ color: plateColor, roughness: 0.4 }), bw * bd);
      let k = 0;
      for (let z = 0; z < bd; z++) {
        for (let x = 0; x < bw; x++) {
          this.tmp.m.makeTranslation(px + x + 0.5 - bw / 2, PLATE_H, pz + z + 0.5 - bd / 2);
          baseStuds.setMatrixAt(k++, this.tmp.m);
        }
      }
      baseStuds.castShadow = baseStuds.receiveShadow = true;
      this.world.add(baseStuds);
      this.baseplate = [base, baseStuds]; // display only, and optional: not part of the kit
      base.visible = baseStuds.visible = !!baseplate;

      // Ground to catch shadows.
      const ground = new T.Mesh(new T.CircleGeometry(Math.max(cols, depth, this.height) * 3, 64), new T.ShadowMaterial({ opacity: 0.22 }));
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.001;
      ground.receiveShadow = true;
      this.world.add(ground);

      // One instanced mesh per piece shape, plus one for every stud on every piece. Slopes are made facing
      // +x and turned to face their way.
      const shapeKey = (b) => (b.shape ? b.shape : `${b.w}x${b.d}`);
      const byShape = new Map();
      for (const b of bricks) byShape.set(shapeKey(b), (byShape.get(shapeKey(b)) || 0) + 1);
      const meshes = new Map();
      for (const [shape, count] of byShape) {
        let geometry;
        if (shape === 'slope' || shape === 'slope2' || shape === 'inverted') geometry = this.slopeGeometry(shape);
        else {
          const [w, d] = shape.split('x').map(Number);
          geometry = this.boxGeometry(w - GAP, this.lh - GAP, d - GAP);
        }
        const mesh = new T.InstancedMesh(geometry, this.material, count);
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.userData.next = 0;
        meshes.set(shape, mesh);
        this.world.add(mesh);
      }
      const studCells = bricks.map((b) => L.studCells(b));
      const studCount = studCells.reduce((n, c) => n + c.length, 0);
      this.studs = new T.InstancedMesh(this.studGeometry(), this.material, studCount);
      this.studs.castShadow = this.studs.receiveShadow = true;
      this.studs.frustumCulled = false;
      this.world.add(this.studs);

      let studIndex = 0;
      this.slots = bricks.map((b, n) => {
        const mesh = meshes.get(shapeKey(b));
        const slot = { mesh, index: mesh.userData.next++, stud: studIndex, studs: studCells[n] };
        studIndex += slot.studs.length;
        this.tmp.c.set(model.palette[b.color].css);
        mesh.setColorAt(slot.index, this.tmp.c);
        for (let i = 0; i < slot.studs.length; i++) this.studs.setColorAt(slot.stud + i, this.tmp.c);
        return slot;
      });
      this.meshes = [...meshes.values()];

      const reach = Math.max(cols, depth, this.height);
      Object.assign(this.sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: reach * 6 });
      this.sun.shadow.camera.updateProjectionMatrix();
      this.sun.position.set(-reach * 0.8, reach * 1.6, reach * 1.4);
      this.sun.target.position.set(0, this.height / 2, 0);

      this.showUpTo(0);
      this.builtRows = 0;
      if (!keepView) this.resetView();
    }

    // The point on the sculpture under a screen position (client pixels), nudged a little inside the
    // brick that was hit, in grid units: x/z in studs from the model's corner, y in studs above the plate.
    pick(clientX, clientY) {
      const T = this.T;
      const r = this.canvas.getBoundingClientRect();
      const ndc = new T.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      this.raycaster = this.raycaster || new T.Raycaster();
      this.raycaster.setFromCamera(ndc, this.camera);
      // three.js caches each instanced mesh's bounds the first time they're asked for, possibly while
      // pieces were still hidden (zero size), which would make every tap miss: refresh them.
      const targets = [...this.meshes, this.studs];
      for (const m of targets) m.computeBoundingSphere();
      const hit = this.raycaster.intersectObjects(targets, false)[0];
      if (!hit) return null;
      const p = hit.point.clone().addScaledVector(this.raycaster.ray.direction, 0.3);
      return { world: hit.point, x: p.x + this.model.cols / 2, y: p.y - this.floor, z: p.z + this.model.depth / 2 };
    }

    // A see-through red ball showing what the eraser will remove (radius in studs), or null to hide it.
    setBrush(world, radius) {
      if (!this.brush) {
        const T = this.T;
        this.brush = new T.Mesh(new T.SphereGeometry(1, 24, 16),
          new T.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.35, depthWrite: false }));
        this.brush.renderOrder = 2;
        this.scene.add(this.brush);
      }
      this.brush.visible = !!world;
      if (world) { this.brush.position.copy(world); this.brush.scale.setScalar(radius); }
    }

    boxGeometry(w, h, d) {
      const g = new this.T.RoundedBoxGeometry(w, h, d, 2, 0.05);
      g.translate(0, h / 2, 0);
      return g;
    }

    // A 45° slope facing +x, 2 studs long (x) and 1 or 2 wide (z), origin at the bottom centre: the back
    // half is flat on top (with its studs), the front half slopes down to a small lip. Inverted: the
    // underside slopes instead.
    slopeGeometry(shape) {
      const T = this.T;
      const H = this.lh - GAP, X = 1 - GAP / 2, lip = 0.15, depth = (shape === 'slope2' ? 2 : 1) - GAP;
      const pts = shape === 'inverted'
        ? [[-X, 0], [0, 0], [X, H - lip], [X, H], [-X, H]]
        : [[-X, 0], [X, 0], [X, lip], [0, H], [-X, H]];
      const outline = new T.Shape(pts.map(([x, y]) => new T.Vector2(x, y)));
      const g = new T.ExtrudeGeometry(outline, { depth, bevelEnabled: false });
      g.translate(0, 0, -depth / 2);
      return g;
    }

    studGeometry() {
      const g = new this.T.CylinderGeometry(STUD_R, STUD_R, STUD_H, 14);
      g.translate(0, STUD_H / 2, 0);
      return g;
    }

    brickOrigin(b) {
      const { cols, depth } = this.model;
      return [b.x + b.w / 2 - cols / 2, this.floor + b.level * this.lh + (this.lifts[b.group || 0] || 0), b.z + b.d / 2 - depth / 2];
    }

    // Pose one brick: offset = [x, y, z] away from its final spot, tilt = rotation in radians.
    pose(i, offset = null, tilt = 0) {
      const { m, s, q, p, axis, one } = this.tmp;
      const b = this.model.bricks[i];
      const slot = this.slots[i];
      const [x, y, z] = this.brickOrigin(b);
      p.set(x, y, z);
      if (offset) p.set(x + offset[0], y + offset[1], z + offset[2]);
      m.compose(p, q.setFromAxisAngle(axis, tilt), one);
      // Studs sit on the footprint's grid; a slope's body is also turned to face its way.
      slot.studs.forEach(([dx, dz], k) => {
        s.makeTranslation(dx + 0.5 - b.w / 2, this.lh - GAP / 2, dz + 0.5 - b.d / 2);
        this.studs.setMatrixAt(slot.stud + k, s.premultiply(m));
      });
      if (b.shape) m.multiply(this.tmp.turn.makeRotationY([0, -Math.PI / 2, Math.PI, Math.PI / 2][b.dir]));
      slot.mesh.setMatrixAt(slot.index, m);
      this.dirty = true;
    }

    hide(i) {
      const slot = this.slots[i];
      slot.mesh.setMatrixAt(slot.index, this.zero);
      const b = this.model.bricks[i];
      for (let k = 0; k < slot.studs.length; k++) this.studs.setMatrixAt(slot.stud + k, this.zero);
      this.dirty = true;
    }

    showUpTo(n) {
      for (let i = 0; i < this.model.bricks.length; i++) {
        if (i < n) this.pose(i); else this.hide(i);
      }
    }

    place(i) { this.pose(i); }

    // Lifts for a point in the build: sub-assemblies finished by piece n are on (except `pending`, one
    // that's built but not put on yet); the rest still float. Call showUpTo(n) after.
    setLiftsAt(n, pending = 0) {
      for (const a of this.assemblies) this.lifts[a.group] = a.end <= n && a.group !== pending ? 0 : a.lift;
    }

    // Move one sub-assembly (its pieces before `shown` are visible) to a new height above its spot.
    setLift(group, lift, shown) {
      this.lifts[group] = lift;
      const a = this.assemblies[group - 1];
      for (let i = a.start; i < Math.min(a.end, shown); i++) this.pose(i);
    }

    // Where piece i flies in from, and how it's turned: a steady direction per piece, from all around.
    flight(i, t) {
      const h = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
      const r = h - Math.floor(h);
      const angle = r * Math.PI * 2;
      const e = 1 - Math.pow(1 - t, 3); // fast, then settling in
      const k = 1 - e;
      return {
        offset: [Math.cos(angle) * FLY_OUT * k, FLY_UP * k * (0.7 + 0.3 * r), Math.sin(angle) * FLY_OUT * k],
        tilt: (r - 0.5) * 1.6 * k * k,
      };
    }

    // t in [0, 1]: piece i flies into place, with a fading trail behind it.
    drop(i, t) {
      const { offset, tilt } = this.flight(i, t);
      this.pose(i, offset, tilt);
      if (t <= 0 || t >= 1) return;
      const b = this.model.bricks[i];
      const [x, y, z] = this.brickOrigin(b);
      const { m, q, p, axis, c } = this.tmp;
      c.set(this.model.palette[b.color].css);
      for (let k = 1; k <= TRAIL && this.trailCount < MAX_TRAIL; k++) {
        const tk = t - k * TRAIL_GAP;
        if (tk <= 0) break;
        const f = this.flight(i, tk);
        const sc = this.tmp.sc.set(b.w * (1 - k * 0.06), this.lh, b.d * (1 - k * 0.06));
        m.compose(p.set(x + f.offset[0], y + f.offset[1] + this.lh / 2, z + f.offset[2]), q.setFromAxisAngle(axis, f.tilt), sc);
        this.trail.setMatrixAt(this.trailCount, m);
        this.trail.setColorAt(this.trailCount, c);
        this.trailCount++;
      }
    }

    setGhost(i, now) {
      if (i == null) { this.ghost.visible = false; return; }
      const b = this.model.bricks[i];
      const [x, y, z] = this.brickOrigin(b);
      this.ghost.visible = true;
      this.ghost.scale.set(b.w, this.lh / L.BRICK_HEIGHT, b.d);
      this.ghost.position.set(x, y + this.lh / 2, z);
      const pulse = 0.5 + 0.5 * Math.sin(now / 180);
      this.ghost.material.color.set(this.model.palette[b.color].css);
      this.ghost.material.opacity = 0.2 + 0.35 * pulse;
      this.ghostEdges.material.opacity = 0.5 + 0.5 * pulse;
    }

    // Where the camera looks: the middle of what has been built so far (never below a third of the way up).
    focusTarget() {
      const h = Math.max(this.builtRows, 4, this.model.rows / 3) * this.lh;
      return new this.T.Vector3(0, this.floor + h * 0.5 + this.focusLift * 0.5, 0);
    }

    // rows: how many layers have been built so far.
    setProgress(rows) {
      this.builtRows = rows;
    }

    // Front three-quarter view that fits the whole sculpture, slowly orbiting while following the build.
    // zoom < 1 frames the model tighter (the build video uses it).
    resetView(zoom = 1) {
      const { cols, depth } = this.model;
      const fov = (this.camera.fov * Math.PI) / 180;
      const aspect = Math.max(0.5, this.camera.aspect);
      const size = Math.max(this.height + (this.maxLift || 0) * 0.5, Math.hypot(cols, depth) / aspect);
      const dist = ((size * 0.66) / Math.tan(fov / 2) + 4) * zoom;
      const target = this.focusTarget();
      this.controls.target.copy(target);
      this.camera.position.set(target.x + dist * 0.5, target.y + dist * 0.35, target.z + dist * 0.8);
      this.follow = true;
      this.controls.autoRotate = true;
      this.controls.update();
    }

    resize(w, h) {
      this.renderer.setSize(w, h, false);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    render(dt = 16) {
      if (this.dirty) {
        for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
        this.studs.instanceMatrix.needsUpdate = true;
        this.dirty = false;
      }
      if (this.follow && this.model) {
        // Raise the camera with the build; move eye and target together so the viewing angle holds.
        const k = 1 - Math.exp(-dt / 500); // frame-rate independent easing
        const delta = this.focusTarget().sub(this.controls.target).multiplyScalar(k);
        this.controls.target.add(delta);
        this.camera.position.add(delta);
      }
      this.controls.update(dt / 1000);
      // Trails were gathered by drop() since the last frame.
      this.trail.count = this.trailCount;
      this.trail.instanceMatrix.needsUpdate = true;
      if (this.trail.instanceColor) this.trail.instanceColor.needsUpdate = true;
      this.trailCount = 0;
      this.renderer.render(this.scene, this.camera);
    }

    snapshot(cb) {
      this.render();
      this.canvas.toBlob(cb, 'image/png');
    }
  }

  L.Scene3D = Scene3D;
})(window.Legofy = window.Legofy || {});
