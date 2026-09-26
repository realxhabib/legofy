// UI wiring and the build playback loop. Legofy.start(THREE) is called once three.js has loaded.
(function (L) {
  const $ = (id) => document.getElementById(id);
  const el = {
    file: $('file'), dropzone: $('dropzone'), preview: $('preview'), modelCard: $('modelCard'),
    sample: $('sample'), sample3d: $('sample3d'), sampleStarship: $('sampleStarship'),
    notice: $('notice'), scanBtn: $('scanBtn'), ai3dBtn: $('ai3dBtn'), ai3dTextured: $('ai3dTextured'),
    life: $('life'), realHeight: $('realHeight'), lifeStats: $('lifeStats'), lifeNote: $('lifeNote'),
    cols: $('cols'), colsOut: $('colsOut'), detail: $('detail'), thick: $('thick'), thickOut: $('thickOut'), up: $('up'),
    order: $('order'), removeBg: $('removeBg'), hollow: $('hollow'), dither: $('dither'), singles: $('singles'),
    parts: $('parts'), partsSummary: $('partsSummary'),
    canvasWrap: $('canvasWrap'), canvas: $('canvas'), empty: $('empty'), hint: $('hint'), controls: $('controls'),
    swatch: $('swatch'), caption: $('caption'), counter: $('counter'), scrub: $('scrub'),
    restart: $('restart'), back: $('back'), play: $('play'), step: $('step'), finish: $('finish'), view: $('view'),
    speed: $('speed'), speedOut: $('speedOut'), savePng: $('savePng'), saveCsv: $('saveCsv'),
    dropOverlay: $('dropOverlay'),
  };

  const MODEL_TYPES = ['glb', 'gltf', 'obj', 'ply', 'stl', 'usdz'];
  const extOf = (f) => f.name.split('.').pop().toLowerCase();

  const state = {
    T: null, scene: null, source: null, model: null, parts: [], partEls: new Map(),
    placed: 0, active: [], playing: false, acc: 0, last: 0, uiDirty: true, lastUi: 0,
  };

  // If three.js never arrives (offline, blocked CDN), say so instead of silently doing nothing.
  const loadTimeout = setTimeout(() => {
    if (!state.scene) showError('Could not load the 3D engine (three.js). Check your internet connection and reload.');
  }, 10000);

  function showError(msg) {
    el.empty.querySelector('p').textContent = msg;
    el.empty.hidden = false;
    el.canvas.hidden = true;
  }

  function notice(msg, isError = false) {
    el.notice.textContent = msg || '';
    el.notice.hidden = !msg;
    el.notice.classList.toggle('error', isError);
  }

  L.start = function (THREE) {
    clearTimeout(loadTimeout);
    state.T = THREE;
    try {
      state.scene = new L.Scene3D(el.canvas, THREE);
    } catch (err) {
      showError('Your browser could not start WebGL, which the 3D build needs.');
      throw err;
    }
    state.scene.setBackground(getComputedStyle(document.documentElement).getPropertyValue('--stage').trim());
    // The orbit hint has done its job once someone drags the view.
    state.scene.controls.addEventListener('start', () => { el.hint.remove(); });
    state.scanner = new L.Scanner(THREE, {
      root: $('scanner'), live: $('scanLive'), video: $('scanVideo'), overlay: $('scanOverlay'), ring: $('scanRing'),
      status: $('scanStatus'), preview: $('scanPreview'), cancel: $('scanCancel'), done: $('scanDone'),
      confirm: $('scanConfirm'), confirmYes: $('confirmYes'), confirmNo: $('confirmNo'),
      review: $('scanReview'), reviewInfo: $('reviewInfo'), reviewCanvas: $('reviewCanvas'), reviewGrid: $('reviewGrid'),
      reviewBuild: $('reviewBuild'), reviewMore: $('reviewMore'), reviewCancel: $('reviewCancel'),
      openings: $('reviewOpenings'),
    }, useScan);
    L.scanner = state.scanner; // handy for debugging and automated tests
    if (state.source) build(true);
    requestAnimationFrame(tick);
  };

  el.scanBtn.addEventListener('click', async () => {
    if (!state.scanner) return notice('Still loading, try again in a moment.', true);
    notice('');
    try {
      await state.scanner.open();
    } catch (err) {
      console.error(err);
      state.scanner.close();
      notice(err.message || String(err), true);
    }
  });

  // A finished walk-around scan (also usable from the console with a hand-built Legofy.Carver).
  function useScan(carver) {
    state.source = { kind: 'scan', carver };
    el.modelCard.querySelector('strong').textContent = 'Your scan';
    el.modelCard.querySelector('span').textContent = `${carver.count} camera views`;
    el.modelCard.hidden = false;
    el.preview.hidden = true;
    el.dropzone.classList.add('has-image');
    notice('');
    showSettingsFor('scan');
    build(true);
  }
  L.useScan = useScan;

  // ---------- input: images and 3D scans ----------

  function loadFiles(fileList) {
    const files = [...(fileList || [])];
    const heic = files.find((f) => /\.(heic|heif)$/i.test(f.name) || /hei[cf]/.test(f.type));
    if (heic) return loadHeic(heic);
    if (files.some((f) => MODEL_TYPES.includes(extOf(f)))) return loadModelFiles(files);
    const image = files.find((f) => f.type.startsWith('image/'));
    if (image) return loadImage(image);
    if (files.length) notice(`Can't read ${files[0].name}. Use an image, or a 3D model (${MODEL_TYPES.join(', ')}).`, true);
  }

  function loadImage(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => useImage(img, url);
    img.onerror = () => notice('Sorry, that image could not be read.', true);
    img.src = url;
  }

  // HEIC: a spatial photo carries two views (left and right eye) that give real depth. Browsers can't
  // read HEIC themselves, so it's decoded with libheif (fetched on first use).
  async function loadHeic(file) {
    if (!state.T) return notice('Still loading, try again in a moment.', true);
    try {
      notice(`Reading ${file.name}…`);
      const libheif = await state.T.loadHeif();
      const views = await L.decodeHeic(libheif, new Uint8Array(await file.arrayBuffer()));
      if (!views.length) throw new Error('no images inside');
      const [left, right] = views;
      const stereo = right && right.width === left.width && right.height === left.height;
      if (!stereo) {
        notice('That HEIC holds one photo, not a spatial pair, so it\'s built like a normal picture.');
        return useImage(left, left.toDataURL('image/jpeg', 0.85), true);
      }
      notice('Spatial photo found: measuring depth. The first time, this downloads a 27 MB AI model…');
      const depthModel = state.depthModel || (state.depthModel = await state.T.loadDepth());
      const result = await L.spatialDepth({ left, right, depthModel, onProgress: (m) => notice(m) });
      notice('Finding the subject…');
      state.segmenter = state.segmenter || await state.T.loadSegmenter();
      const subject = L.spatialSubject({ image: result.image, dist: result.dist, segmenter: state.segmenter });
      const relief = subject
        ? { dist: subject.dist, mask: subject.mask, f: result.f }
        : { dist: result.dist, f: result.f };
      state.source = { kind: 'spatial', img: subject ? subject.image : result.image, relief };
      el.preview.src = result.image.toDataURL('image/jpeg', 0.85);
      el.preview.hidden = false;
      el.modelCard.hidden = true;
      el.dropzone.classList.add('has-image');
      notice(result.stereoUsed
        ? `Spatial photo: depth measured from ${result.stereoUsed.toLocaleString()} matched points between the two views.`
        : 'Couldn\'t match the two views (too little texture?), so the depth is AI-estimated only.');
      showSettingsFor('spatial');
      build(true);
    } catch (err) {
      console.error(err);
      notice(`Couldn't read ${file.name}: ${err.message || err}`, true);
    }
  }

  async function useImage(img, previewSrc, keepNotice) {
    const source = { kind: 'image', img };
    state.source = source;
    el.preview.src = previewSrc;
    el.preview.hidden = false;
    el.modelCard.hidden = true;
    el.dropzone.classList.add('has-image');
    if (!keepNotice) notice('');
    showSettingsFor('image');
    // Pick out the object with the on-device finder (works on busy backgrounds, unlike the plain-
    // background cut-out); fall back to the original if it isn't available or finds nothing.
    if (state.T) {
      try {
        notice('Finding the object in your photo…');
        state.segmenter = state.segmenter || await state.T.loadSegmenter();
        const c = document.createElement('canvas');
        const k = Math.min(1, 1024 / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
        c.width = Math.round((img.naturalWidth || img.width) * k);
        c.height = Math.round((img.naturalHeight || img.height) * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const subject = L.spatialSubject({ image: c, dist: null, segmenter: state.segmenter });
        if (state.source !== source) return; // another image arrived meanwhile
        if (subject) source.cutout = subject.cutout;
        notice(subject ? 'Picked the object in the middle of the photo.' : '');
      } catch (err) {
        console.error(err);
        notice('');
      }
    }
    if (state.source === source) build(true);
  }

  function useModel(root, name, extra = {}) {
    state.source = { kind: 'model', root, name, ...extra };
    let triangles = 0;
    root.traverse((o) => {
      if (o.isMesh && o.geometry) triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    });
    el.modelCard.querySelector('strong').textContent = name;
    el.modelCard.querySelector('span').textContent = triangles
      ? `${Math.round(triangles).toLocaleString()} triangles` : '3D point cloud';
    el.modelCard.hidden = false;
    el.preview.hidden = true;
    el.dropzone.classList.add('has-image');
    notice('');
    showSettingsFor('model');
    build(true);
  }

  function showSettingsFor(kind) {
    // 3D models and scans can go much bigger than pictures (whose thickness grows with width).
    el.cols.max = kind === 'image' || kind === 'spatial' ? 120 : 320;
    if (+el.cols.value > +el.cols.max) el.cols.value = el.cols.max;
    el.colsOut.value = el.cols.value;
    for (const node of document.querySelectorAll('[data-source]')) {
      node.hidden = !node.dataset.source.split(' ').includes(kind);
    }
  }

  // Scans often come as several files (an .obj with its .mtl and texture, a .gltf with .bin),
  // so every dropped file is made available to the loaders by name.
  async function loadModelFiles(files) {
    if (!state.T) return notice('The 3D engine is still loading, try again in a moment.', true);
    const T = state.T;
    const main = MODEL_TYPES.map((e) => files.find((f) => extOf(f) === e)).find(Boolean);
    notice(`Loading ${main.name}…`);
    const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
    const urls = new Map();
    const urlFor = (f) => {
      if (!urls.has(f)) urls.set(f, URL.createObjectURL(f));
      return urls.get(f);
    };
    let pending = 0;
    let idle = null;
    const manager = new T.LoadingManager();
    manager.onStart = manager.onProgress = (url, loaded, total) => { pending = total - loaded; };
    manager.onLoad = () => { pending = 0; if (idle) idle(); };
    manager.setURLModifier((url) => {
      if (url.startsWith('data:')) return url;
      const name = decodeURIComponent(url.split(/[\\/]/).pop().split(/[?#]/)[0]).toLowerCase();
      const file = byName.get(name);
      return file ? urlFor(file) : url;
    });

    try {
      const X = await T.loadModelLoaders();
      const url = urlFor(main);
      let root;
      switch (extOf(main)) {
        case 'glb':
        case 'gltf': {
          const loader = new X.GLTFLoader(manager);
          loader.setDRACOLoader(new X.DRACOLoader(manager).setDecoderPath(X.DRACO_DECODER_PATH));
          loader.setMeshoptDecoder(X.MeshoptDecoder);
          root = (await loader.loadAsync(url)).scene;
          break;
        }
        case 'obj': {
          const loader = new X.OBJLoader(manager);
          const mtl = files.find((f) => extOf(f) === 'mtl');
          if (mtl) {
            const materials = await new X.MTLLoader(manager).loadAsync(urlFor(mtl));
            materials.preload();
            loader.setMaterials(materials);
          }
          root = await loader.loadAsync(url);
          break;
        }
        case 'ply': {
          const geometry = await new X.PLYLoader(manager).loadAsync(url);
          const vertexColors = !!geometry.attributes.color;
          root = geometry.index
            ? new T.Mesh(geometry, new T.MeshStandardMaterial({ vertexColors }))
            : new T.Points(geometry, new T.PointsMaterial({ vertexColors }));
          break;
        }
        case 'stl': {
          const geometry = await new X.STLLoader(manager).loadAsync(url);
          const vertexColors = !!geometry.attributes.color;
          root = new T.Mesh(geometry, new T.MeshStandardMaterial({ vertexColors, color: vertexColors ? '#ffffff' : '#a0a5a9' }));
          break;
        }
        case 'usdz':
          try {
            root = await new X.USDZLoader(manager).loadAsync(url);
          } catch (err) {
            if (/crate|usdc/i.test(err.message)) {
              throw new Error('This USDZ is in Apple\'s binary format, which browsers can\'t read yet. ' +
                'Export the scan as GLB or OBJ instead (most scanning apps offer it).');
            }
            throw err;
          }
          break;
      }
      // Textures (e.g. the .jpg next to an .obj) may still be arriving.
      if (pending > 0) await new Promise((resolve) => { idle = resolve; });
      useModel(root, main.name);
    } catch (err) {
      console.error(err);
      notice(`Couldn't load ${main.name}: ${err.message || err}`, true);
    } finally {
      setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 5000);
    }
  }

  el.file.addEventListener('change', () => { loadFiles(el.file.files); el.file.value = ''; });
  el.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.file.click(); }
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    el.dropOverlay.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; el.dropOverlay.hidden = true; }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.dropOverlay.hidden = true;
    loadFiles(e.dataTransfer.files);
  });
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) loadImage(item.getAsFile());
  });

  el.sample.addEventListener('click', () => {
    const c = sampleImage();
    useImage(c, c.toDataURL());
  });
  el.sample3d.addEventListener('click', () => {
    if (state.T) useModel(L.sampleModel(state.T), 'toadstool (sample model)');
  });
  el.sampleStarship.addEventListener('click', () => {
    if (!state.T) return;
    // Tall and thin: build it big enough that the fins, flaps and vents survive as bricks.
    showSettingsFor('model');
    el.cols.value = 300;
    el.colsOut.value = 300;
    useModel(L.starshipModel(state.T), 'Starship full stack (sample)', { realHeight: 123.1 });
  });

  // A rubber duck on a plain background: a good subject to inflate into a sculpture.
  function sampleImage() {
    const c = document.createElement('canvas');
    c.width = 600; c.height = 560;
    const g = c.getContext('2d');
    g.fillStyle = '#f7f4ee';
    g.fillRect(0, 0, 600, 560);
    const ellipse = (x, y, rx, ry, color, rot = 0) => {
      g.fillStyle = color;
      g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); g.fill();
    };
    ellipse(300, 400, 230, 140, '#f5c518');        // body
    ellipse(505, 330, 70, 40, '#f5c518', -0.6);    // tail
    ellipse(230, 200, 125, 120, '#f5c518');        // head
    ellipse(330, 410, 120, 70, '#e8ae0c', -0.15);  // wing
    ellipse(110, 225, 70, 28, '#fe8a18', 0.08);    // beak
    ellipse(205, 165, 24, 28, '#ffffff');          // eye
    ellipse(198, 170, 13, 16, '#1b2a34');
    return c;
  }

  // ---------- AI 3D model (Hunyuan3D v2 on fal.ai, through our /api/hunyuan3d function) ----------

  const AI3D_ENDPOINT = 'api/hunyuan3d';

  function photoAsJpeg(img, maxSide) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const k = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; // transparent pictures get a plain white background
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.9);
  }

  async function callAi3d(init, query = '') {
    let r;
    try {
      r = await fetch(AI3D_ENDPOINT + query, init);
    } catch (err) {
      throw new Error('The AI service is only available on the deployed site (it needs its server function).');
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // No JSON error means there is no server function here (opened from disk, GitHub Pages…).
      throw new Error(data.error || ([404, 405, 501].includes(r.status)
        ? 'The AI service is only available on the Vercel deployment (it needs its server function).'
        : `The AI service answered ${r.status}.`));
    }
    return data;
  }

  el.ai3dBtn.addEventListener('click', async () => {
    const src = state.source;
    if (!src || !src.img) return;
    el.ai3dBtn.disabled = true;
    const started = Date.now();
    try {
      notice('Sending your photo to Hunyuan3D…');
      const { id } = await callAi3d({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: photoAsJpeg(src.img, 1024), textured: el.ai3dTextured.checked }),
      });
      let modelUrl = null;
      while (!modelUrl) {
        await new Promise((r) => setTimeout(r, 2500));
        const secs = Math.round((Date.now() - started) / 1000);
        if (secs > 600) throw new Error('It\'s taking too long; try again in a bit.');
        const job = await callAi3d({}, `?id=${encodeURIComponent(id)}`);
        if (job.status === 'COMPLETED') modelUrl = job.modelUrl;
        else if (job.status === 'IN_QUEUE') notice(`Waiting in line at fal.ai${job.position != null ? ` (position ${job.position + 1})` : ''}… ${secs}s`);
        else notice(`Building the 3D model… ${secs}s (usually about a minute)`);
      }
      notice('Downloading the 3D model…');
      const r = await fetch(modelUrl);
      if (!r.ok) throw new Error(`couldn't download the model (${r.status})`);
      const file = new File([await r.blob()], 'AI model (Hunyuan3D).glb', { type: 'model/gltf-binary' });
      await loadModelFiles([file]);
    } catch (err) {
      console.error(err);
      notice(`AI 3D model failed: ${err.message || err}`, true);
    } finally {
      el.ai3dBtn.disabled = false;
    }
  });

  // ---------- settings ----------

  el.cols.addEventListener('input', () => { el.colsOut.value = el.cols.value; });
  el.thick.addEventListener('input', () => { el.thickOut.value = `${el.thick.value}%`; });
  // Text needs size: letters only read once each is several studs tall. Switching to "keep text"
  // makes the build big (and built from plates, see build()); switching back restores the old size.
  let normalSize = +el.cols.value;
  el.detail.addEventListener('change', () => {
    if (el.detail.value === 'text') {
      normalSize = +el.cols.value;
      el.cols.value = Math.min(+el.cols.max, Math.max(normalSize, 96));
    } else {
      el.cols.value = normalSize;
    }
    el.colsOut.value = el.cols.value;
  });
  for (const input of [el.detail, el.cols, el.thick, el.up, el.order, el.removeBg, el.hollow, el.dither, el.singles]) {
    input.addEventListener('change', () => build(state.playing));
  }

  function build(autoplay) {
    if (!state.source || !state.scene) return;
    const text = el.detail.value === 'text';
    const layer = text ? L.PLATE_HEIGHT : L.BRICK_HEIGHT;
    const shared = { hollow: el.hollow.checked, onlySingles: el.singles.checked, order: el.order.value, layer };
    try {
      const { kind } = state.source;
      const picture = el.removeBg.checked && state.source.cutout ? state.source.cutout : state.source.img;
      state.model = kind === 'image' || kind === 'spatial'
        ? L.buildSculpture(picture, {
          ...shared,
          cols: +el.cols.value,
          thickness: el.thick.value / 100,
          removeBackground: el.removeBg.checked,
          dither: el.dither.checked,
          relief: state.source.relief || null,
          layer,
        })
        : L.bricksFromVolume(kind === 'scan'
          ? state.source.carver.volume({ size: +el.cols.value, layer })
          : L.voxelizeModel(state.T, state.source.root, {
            size: +el.cols.value, up: el.up.value, layer, maxTexture: text ? 2048 : 1024,
          }), shared);
    } catch (err) {
      console.error(err);
      notice(`Couldn't build that: ${err.message || err}`, true);
      return;
    }
    if (!state.model.bricks.length) {
      notice('Nothing to build: the subject came out empty. Try turning off "Cut out the subject".', true);
      return;
    }
    state.parts = L.partsList(state.model.bricks, state.model.palette);
    renderParts();
    renderLifeSize();
    el.empty.hidden = true;
    el.canvas.hidden = false;
    if (el.hint.isConnected) el.hint.hidden = false;
    el.controls.hidden = false;
    el.scrub.max = state.model.bricks.length;
    state.placed = 0;
    state.active = [];
    layout();
    state.scene.setup(state.model);
    seek(0);
    setPlaying(autoplay);
  }

  function layout() {
    const w = el.canvasWrap.clientWidth;
    const h = Math.round(Math.max(320, Math.min(window.innerHeight - 250, w * 0.8)));
    state.scene.resize(w, h);
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.model) layout(); }, 100);
  });

  // ---------- playback ----------

  const bricksPerSecond = () => Math.round(Math.pow(10, (el.speed.value / 100) * 3)); // 1 .. 1000

  function spawn(now) {
    const i = state.placed++;
    const duration = Math.min(700, Math.max(180, 6000 / bricksPerSecond()));
    state.active.push({ i, start: now, duration });
    state.scene.drop(i, 0);
    partFor(state.model.bricks[i]).placed++;
    state.uiDirty = true;
  }

  function flushActive() {
    for (const a of state.active) state.scene.place(a.i);
    state.active = [];
  }

  function seek(n) {
    const total = state.model.bricks.length;
    state.placed = Math.max(0, Math.min(total, n));
    state.active = [];
    state.acc = 0;
    for (const p of state.parts) p.placed = 0;
    for (let i = 0; i < state.placed; i++) partFor(state.model.bricks[i]).placed++;
    state.scene.showUpTo(state.placed);
    state.uiDirty = true;
  }

  function setPlaying(on) {
    if (!state.model) return;
    if (on && state.placed >= state.model.bricks.length) seek(0);
    state.playing = on;
    state.acc = 1; // place the first brick immediately
    state.uiDirty = true;
  }

  function tick(now) {
    requestAnimationFrame(tick);
    const dt = Math.min(100, now - (state.last || now));
    state.last = now;
    const m = state.model;
    if (m) {
      const total = m.bricks.length;
      if (state.playing) {
        state.acc += (dt / 1000) * bricksPerSecond();
        while (state.acc >= 1 && state.placed < total) { spawn(now); state.acc--; }
        if (state.placed >= total && !state.active.length) setPlaying(false);
      }
      state.active = state.active.filter((a) => {
        const t = (now - a.start) / a.duration;
        if (t < 1) { state.scene.drop(a.i, t); return true; }
        state.scene.place(a.i);
        return false;
      });
      state.scene.setProgress(state.placed ? m.bricks[state.placed - 1].level + 1 : 0);
      const ghost = !state.playing && !state.active.length && state.placed < total ? state.placed : null;
      state.scene.setGhost(ghost, now);
      if (state.uiDirty && now - state.lastUi > 60) updateUi(now);
    }
    state.scene.render(dt);
  }

  el.play.addEventListener('click', () => setPlaying(!state.playing));
  el.step.addEventListener('click', () => {
    if (!state.model) return;
    setPlaying(false);
    flushActive();
    if (state.placed < state.model.bricks.length) spawn(performance.now());
  });
  el.back.addEventListener('click', () => { setPlaying(false); seek(state.placed - 1); });
  el.restart.addEventListener('click', () => { setPlaying(false); seek(0); });
  el.finish.addEventListener('click', () => { setPlaying(false); seek(Infinity); });
  el.view.addEventListener('click', () => state.scene.resetView());
  el.scrub.addEventListener('input', () => { setPlaying(false); seek(+el.scrub.value); });
  el.speed.addEventListener('input', () => { el.speedOut.value = `${bricksPerSecond()}/s`; });
  el.speedOut.value = `${bricksPerSecond()}/s`;

  window.addEventListener('keydown', (e) => {
    if (!state.model || /INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)) return;
    const actions = {
      ' ': el.play, ArrowRight: el.step, ArrowLeft: el.back, Home: el.restart, End: el.finish,
    };
    if (actions[e.key]) { e.preventDefault(); actions[e.key].click(); }
  });

  // ---------- UI ----------

  function partFor(brick) {
    return state.partEls.get(brick.partKey).part;
  }

  function renderParts() {
    el.parts.textContent = '';
    state.partEls.clear();
    for (const part of state.parts) {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="plate" style="--c:${part.color.css}; --w:${part.c}; --h:${part.a}"></span>
        <span class="pname"><b>${part.size}</b> ${part.color.name}</span>
        <span class="pcount"></span>
        <span class="pbar"><i></i></span>`;
      el.parts.appendChild(li);
      state.partEls.set(part.key, { part, li, count: li.querySelector('.pcount'), bar: li.querySelector('.pbar i') });
    }
    const colors = new Set(state.model.bricks.map((b) => b.color)).size;
    el.partsSummary.textContent =
      `${state.model.bricks.length.toLocaleString()} ${state.model.pieces} · ${colors} colors · ` +
      `${state.model.cols} × ${state.model.depth} studs, ${state.model.rows} ${state.model.pieces} tall`;
  }

  function updateUi(now) {
    state.lastUi = now;
    state.uiDirty = false;
    const m = state.model;
    const total = m.bricks.length;
    el.scrub.value = state.placed;
    el.counter.textContent = `${state.placed.toLocaleString()} / ${total.toLocaleString()}`;
    el.play.textContent = state.playing ? '❚❚ Pause'
      : state.placed >= total ? '↻ Build again' : state.placed ? '▶ Resume' : '▶ Build';

    const next = !state.playing && state.placed < total ? m.bricks[state.placed] : null;
    const shown = next || m.bricks[state.placed - 1];
    const current = shown && shown.partKey;
    if (shown) {
      const c = m.palette[shown.color];
      el.swatch.style.background = c.css;
      el.swatch.hidden = false;
      el.caption.textContent = next
        ? `Next: ${next.size} ${c.name} ${m.piece}, layer ${next.level + 1} (the glowing spot)`
        : `${shown.size} ${c.name} ${m.piece}, layer ${shown.level + 1} of ${m.rows}`;
    } else {
      el.swatch.hidden = true;
      el.caption.textContent = 'Press Build to start';
    }
    if (state.placed === total && !state.active.length) el.caption.textContent = `Done! Every ${m.piece} is in place.`;

    for (const { part, li, count, bar } of state.partEls.values()) {
      count.textContent = `${part.placed}/${part.total}`;
      bar.style.width = `${(part.placed / part.total) * 100}%`;
      li.classList.toggle('done', part.placed === part.total);
      li.classList.toggle('current', part.key === current);
    }
  }

  // ---------- real-size estimate ----------

  const STUD_M = 0.008;

  function formatCount(n) {
    if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} billion`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} million`;
    return Math.round(n).toLocaleString();
  }
  function formatMass(g) {
    if (g >= 1e6) return `${(g / 1e6).toLocaleString(undefined, { maximumFractionDigits: g >= 1e8 ? 0 : 1 })} tonnes`;
    if (g >= 1e3) return `${(g / 1e3).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
    return `${Math.round(g)} g`;
  }
  function formatLength(m) {
    return m >= 1 ? `${m.toLocaleString(undefined, { maximumFractionDigits: 1 })} m` : `${(m * 100).toFixed(1)} cm`;
  }
  function formatDuration(seconds) {
    const h = seconds / 3600;
    if (h < 1) return `${Math.max(1, Math.round(seconds / 60))} minutes`;
    if (h < 48) return `${h.toFixed(1)} hours`;
    const d = h / 24;
    if (d < 730) return `${Math.round(d).toLocaleString()} days`;
    return `${(d / 365).toFixed(1)} years`;
  }

  // Scale the current build up (or down) to a real-world height. Up to about twice the model size we
  // simply scale this build's bricks. Beyond that we assume a sturdy 2-stud-thick shell of 2×4 bricks
  // (8 stud-cells, 2.3 g each), whose brick count grows with the surface area, or a solid fill of 2×4s
  // when "Hollow" is off.
  function renderLifeSize() {
    const m = state.model;
    if (!m) { el.life.hidden = true; return; }
    const layerM = (m.layerHeight || L.BRICK_HEIGHT) * STUD_M; // 9.6 mm a brick, 3.2 mm a plate
    const modelHeight = m.rows * layerM;
    // Until someone types a height, show the build at its own real size.
    const height = state.source.realHeight || modelHeight;
    if (document.activeElement !== el.realHeight) el.realHeight.value = +height.toFixed(3);
    const k = +(height / modelHeight).toFixed(6);
    const hollow = el.hollow.checked;
    const studCells = m.bricks.reduce((n, b) => n + b.w * b.d, 0);
    // Cells are brick-sized, or a third of that in plate mode: convert to brick-sized cells.
    const perBrick = (m.layerHeight || L.BRICK_HEIGHT) / L.BRICK_HEIGHT;

    let bricks, cells, how;
    if (k <= 2) {
      bricks = m.bricks.length * k ** (hollow ? 2 : 3);
      cells = studCells * perBrick * k ** (hollow ? 2 : 3);
      how = k === 1 ? 'Exactly this build.' : 'This build, scaled.';
    } else if (hollow) {
      cells = m.stats.shellVoxels * perBrick * k * k * 2;
      bricks = cells / 8;
      how = 'Estimate: a hollow shell 2 studs thick, built from 2×4 bricks.';
    } else {
      cells = m.stats.solidVoxels * perBrick * k ** 3;
      bricks = cells / 8;
      how = 'Estimate: solid all the way through, built from 2×4 bricks.';
    }
    const grams = cells * 0.29;       // a 2×4 brick is ~2.3 g for its 8 stud-cells
    const dollars = bricks * 0.1;     // roughly 10¢ per brick
    const rows = [
      [k <= 2 ? m.pieces[0].toUpperCase() + m.pieces.slice(1) : 'Bricks', `≈ ${formatCount(bricks)}`, 'big'],
      ['Size', `${formatLength(m.cols * k * STUD_M)} × ${formatLength(m.depth * k * STUD_M)} × ${formatLength(height)} tall`],
      [`Rows of ${m.pieces}`, formatCount(height / layerM)],
      ['Weight', `≈ ${formatMass(grams)}`],
      ['Cost', `≈ $${formatCount(dollars)} at ~10¢ a brick`],
      ['Build time', `${formatDuration(bricks)} at one brick a second, nonstop`],
    ];
    el.lifeStats.innerHTML = rows.map(([t, d, cls]) => `<dt>${t}</dt><dd class="${cls || ''}">${d}</dd>`).join('');
    el.lifeNote.textContent = `${how} Based on the shape above (${m.rows} ${m.pieces} tall), scaled ${k >= 10 ? Math.round(k).toLocaleString() : k.toFixed(2)}×.`;
    el.life.hidden = false;
  }

  el.realHeight.addEventListener('input', () => {
    if (!state.source) return;
    const v = parseFloat(el.realHeight.value);
    if (v > 0) { state.source.realHeight = v; renderLifeSize(); }
  });

  // ---------- export ----------

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  el.savePng.addEventListener('click', () => {
    state.scene.snapshot((blob) => download(blob, 'legofy-build.png'));
  });

  el.saveCsv.addEventListener('click', () => {
    const rows = [['Color', 'Brick', 'Quantity'], ...state.parts.map((p) => [p.color.name, `${p.a}x${p.c}`, p.total])];
    download(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), 'legofy-parts.csv');
  });
})(window.Legofy);
