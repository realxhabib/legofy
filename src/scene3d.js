// three.js scene: a baseplate with the picture built on it as an upright wall of real-looking bricks.
// Units: 1 = one stud (8mm). Bricks are 1.2 tall, studs are 0.6 wide and 0.2 tall.
(function (L) {
  const STUD_R = 0.3, STUD_H = 0.2, PLATE_H = 0.4, GAP = 0.02;
  const DROP_HEIGHT = 7;

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
      this.controls.addEventListener('start', () => { this.follow = false; });

      this.scene.add(new T.HemisphereLight(0xffffff, 0x445066, 1.4));
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
        axis: new T.Vector3(0, 0, 1), one: new T.Vector3(1, 1, 1),
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
    }

    setBackground(css) {
      this.scene.background = new this.T.Color(css);
    }

    setup(model) {
      const T = this.T;
      this.model = model;
      this.world.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      this.world.clear();

      const { cols, rows, bricks } = model;
      this.wallH = rows * L.BRICK_HEIGHT;

      // Baseplate: a few studs of border around the wall.
      const bw = cols + 4, bd = 6;
      const plateColor = new T.Color('#237841');
      const base = new T.Mesh(this.boxGeometry(bw, PLATE_H, bd), new T.MeshStandardMaterial({ color: plateColor, roughness: 0.4 }));
      base.position.set(0, 0, 0);
      base.receiveShadow = true;
      base.castShadow = true;
      this.world.add(base);
      const baseStuds = new T.InstancedMesh(this.studGeometry(), new T.MeshStandardMaterial({ color: plateColor, roughness: 0.4 }), bw * bd);
      let k = 0;
      for (let z = 0; z < bd; z++) {
        for (let x = 0; x < bw; x++) {
          this.tmp.m.makeTranslation(x + 0.5 - bw / 2, PLATE_H, z + 0.5 - bd / 2);
          baseStuds.setMatrixAt(k++, this.tmp.m);
        }
      }
      baseStuds.castShadow = baseStuds.receiveShadow = true;
      this.world.add(baseStuds);

      // Ground to catch shadows.
      const ground = new T.Mesh(new T.CircleGeometry(Math.max(cols, this.wallH) * 3, 64), new T.ShadowMaterial({ opacity: 0.35 }));
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.001;
      ground.receiveShadow = true;
      this.world.add(ground);

      // One instanced mesh per brick length, plus one for every stud on every brick.
      const byLength = new Map();
      for (const b of bricks) byLength.set(b.w, (byLength.get(b.w) || 0) + 1);
      const meshes = new Map();
      for (const [len, count] of byLength) {
        const mesh = new T.InstancedMesh(this.boxGeometry(len - GAP, L.BRICK_HEIGHT - GAP, 1 - GAP), this.material, count);
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.userData.next = 0;
        meshes.set(len, mesh);
        this.world.add(mesh);
      }
      const studCount = bricks.reduce((n, b) => n + b.w, 0);
      this.studs = new T.InstancedMesh(this.studGeometry(), this.material, studCount);
      this.studs.castShadow = this.studs.receiveShadow = true;
      this.studs.frustumCulled = false;
      this.world.add(this.studs);

      let studIndex = 0;
      this.slots = bricks.map((b) => {
        const mesh = meshes.get(b.w);
        const slot = { mesh, index: mesh.userData.next++, stud: studIndex };
        studIndex += b.w;
        this.tmp.c.set(model.palette[b.color].css);
        mesh.setColorAt(slot.index, this.tmp.c);
        for (let i = 0; i < b.w; i++) this.studs.setColorAt(slot.stud + i, this.tmp.c);
        return slot;
      });
      this.meshes = [...meshes.values()];

      const reach = Math.max(cols, this.wallH);
      Object.assign(this.sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: reach * 6 });
      this.sun.shadow.camera.updateProjectionMatrix();
      this.sun.position.set(-reach * 0.8, reach * 1.6, reach * 1.4);
      this.sun.target.position.set(0, this.wallH / 2, 0);

      this.showUpTo(0);
      this.builtRows = 0;
      this.focus = null;
      this.resetView();
    }

    boxGeometry(w, h, d) {
      const g = new this.T.RoundedBoxGeometry(w, h, d, 2, 0.05);
      g.translate(0, h / 2, 0);
      return g;
    }

    studGeometry() {
      const g = new this.T.CylinderGeometry(STUD_R, STUD_R, STUD_H, 20);
      g.translate(0, STUD_H / 2, 0);
      return g;
    }

    brickOrigin(b) {
      return [b.x + b.w / 2 - this.model.cols / 2, PLATE_H + b.level * L.BRICK_HEIGHT, 0];
    }

    // Pose one brick: lift = height above its final spot, tilt = rotation in radians.
    pose(i, lift = 0, tilt = 0) {
      const { m, s, q, p, axis, one } = this.tmp;
      const b = this.model.bricks[i];
      const slot = this.slots[i];
      const [x, y, z] = this.brickOrigin(b);
      m.compose(p.set(x, y + lift, z), q.setFromAxisAngle(axis, tilt), one);
      slot.mesh.setMatrixAt(slot.index, m);
      for (let k = 0; k < b.w; k++) {
        s.makeTranslation(k + 0.5 - b.w / 2, L.BRICK_HEIGHT - GAP / 2, 0);
        this.studs.setMatrixAt(slot.stud + k, s.premultiply(m));
      }
      this.dirty = true;
    }

    hide(i) {
      const slot = this.slots[i];
      slot.mesh.setMatrixAt(slot.index, this.zero);
      for (let k = 0; k < this.model.bricks[i].w; k++) this.studs.setMatrixAt(slot.stud + k, this.zero);
      this.dirty = true;
    }

    showUpTo(n) {
      for (let i = 0; i < this.model.bricks.length; i++) {
        if (i < n) this.pose(i); else this.hide(i);
      }
    }

    place(i) { this.pose(i); }

    // t in [0, 1]: falls from above with a little bounce and a settling wobble.
    drop(i, t) {
      const e = easeOutBounce(t);
      const side = i % 2 ? 1 : -1;
      this.pose(i, DROP_HEIGHT * (1 - e), side * 0.35 * (1 - t) * (1 - t));
    }

    setGhost(i, now) {
      if (i == null) { this.ghost.visible = false; return; }
      const b = this.model.bricks[i];
      const [x, y, z] = this.brickOrigin(b);
      this.ghost.visible = true;
      this.ghost.scale.set(b.w, 1, 1);
      this.ghost.position.set(x, y + L.BRICK_HEIGHT / 2, z);
      const pulse = 0.5 + 0.5 * Math.sin(now / 180);
      this.ghost.material.color.set(this.model.palette[b.color].css);
      this.ghost.material.opacity = 0.2 + 0.35 * pulse;
      this.ghostEdges.material.opacity = 0.5 + 0.5 * pulse;
    }

    // Camera framing. Wide: the whole wall as built so far. Close: a window around the brick being placed.
    viewFor() {
      const T = this.T, { cols, rows } = this.model;
      const fov = (this.camera.fov * Math.PI) / 180;
      const aspect = Math.max(0.5, this.camera.aspect);
      const fitFor = (w, h) => (Math.max(h, w / aspect) * 0.62) / Math.tan(fov / 2) + 4;
      const f = this.focus;
      if (f && f.close && this.builtRows < rows) {
        const span = Math.min(cols, 22);
        const x = Math.max(-cols / 2 + span / 2, Math.min(cols / 2 - span / 2, f.x));
        const y = PLATE_H + (this.builtRows - 0.5) * L.BRICK_HEIGHT;
        const fit = fitFor(span, span / aspect);
        return {
          target: new T.Vector3(x, y, 0),
          position: new T.Vector3(x + span * 0.5, y + fit * 0.35, fit),
        };
      }
      const h = Math.max(this.builtRows, 6, rows / 3) * L.BRICK_HEIGHT;
      const fit = fitFor(cols, h);
      return {
        target: new T.Vector3(0, h * 0.45, 0),
        position: new T.Vector3(cols * 0.45, h * 0.55 + fit * 0.3, fit),
      };
    }

    // rows: how high the wall is so far; focus: { x, close } for the brick being placed.
    setProgress(rows, focus) {
      this.builtRows = rows;
      this.focus = focus;
    }

    resetView() {
      const v = this.viewFor();
      this.controls.target.copy(v.target);
      this.camera.position.copy(v.position);
      this.follow = true;
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
        const v = this.viewFor();
        const k = 1 - Math.exp(-dt / 400); // frame-rate independent easing
        this.controls.target.lerp(v.target, k);
        this.camera.position.lerp(v.position, k);
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    }

    snapshot(cb) {
      this.render();
      this.canvas.toBlob(cb, 'image/png');
    }
  }

  function easeOutBounce(t) {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  }

  L.Scene3D = Scene3D;
})(window.Legofy = window.Legofy || {});
