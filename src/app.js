// UI wiring and the build playback loop. Legofy.start(THREE) is called once three.js has loaded.
(function (L) {
  const $ = (id) => document.getElementById(id);
  const el = {
    file: $('file'), dropzone: $('dropzone'), preview: $('preview'), modelCard: $('modelCard'),
    sample3d: $('sample3d'), sampleStarship: $('sampleStarship'), notice: $('notice'), ai3dBtn: $('ai3dBtn'),
    emptyPhoto: $('emptyPhoto'), emptyTitle: $('emptyTitle'), emptyText: $('emptyText'), emptyStatus: $('emptyStatus'),
    emptyGenerate: $('emptyGenerate'), emptyChoose: $('emptyChoose'), emptySample: $('emptySample'),
    edit: $('edit'), editBar: $('editBar'), editLargest: $('editLargest'), editUndo: $('editUndo'),
    editReset: $('editReset'), editDone: $('editDone'),
    buyBox: $('buyBox'), buyParts: $('buyParts'), buyParts2: $('buyParts2'), saveXml: $('saveXml'),
    life: $('life'), realHeight: $('realHeight'), lifeStats: $('lifeStats'), lifeNote: $('lifeNote'),
    cols: $('cols'), colsOut: $('colsOut'), detail: $('detail'), up: $('up'),
    order: $('order'), hollow: $('hollow'), singles: $('singles'), baseplate: $('baseplate'),
    buildCheck: $('buildCheck'), bcBadge: $('bcBadge'), bcHeadline: $('bcHeadline'), bcList: $('bcList'),
    parts: $('parts'), partsSummary: $('partsSummary'),
    canvasWrap: $('canvasWrap'), canvas: $('canvas'), empty: $('empty'), hint: $('hint'), controls: $('controls'),
    swatch: $('swatch'), caption: $('caption'), counter: $('counter'), scrub: $('scrub'),
    restart: $('restart'), back: $('back'), play: $('play'), step: $('step'), finish: $('finish'), view: $('view'),
    speed: $('speed'), speedOut: $('speedOut'), savePng: $('savePng'), saveCsv: $('saveCsv'), saveManual: $('saveManual'), saveVideo: $('saveVideo'),
    dropOverlay: $('dropOverlay'), toast: $('toast'),
  };

  const MODEL_TYPES = ['glb', 'gltf', 'obj', 'ply', 'stl', 'usdz'];
  const extOf = (f) => f.name.split('.').pop().toLowerCase();

  const state = {
    T: null, scene: null, source: null, model: null, parts: [], partEls: new Map(),
    placed: 0, active: [], playing: false, acc: 0, last: 0, uiDirty: true, lastUi: 0,
    // Bits the user deleted from the model, as a list of operations replayed on every rebuild:
    // { sphere: [x, y, z], r } in units of the model's longest side (so they survive a size change),
    // or { largest: true } to keep only the biggest connected part.
    edits: [], editing: false, brush: 3, volumeCache: null,
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
    L._scene = state.scene; // for automated tests
    state.scene.setBackground(getComputedStyle(document.documentElement).getPropertyValue('--stage').trim());
    // The orbit hint has done its job once someone drags the view.
    state.scene.controls.addEventListener('start', () => { el.hint.remove(); });
    if (state.source) build(true);
    requestAnimationFrame(tick);
  };


  // ---------- input: photos (turned into 3D models by the AI) and 3D models ----------

  function loadFiles(fileList) {
    const files = [...(fileList || [])];
    const heic = files.find((f) => /\.(heic|heif)$/i.test(f.name) || /hei[cf]/.test(f.type));
    if (heic) return loadHeic(heic);
    if (files.some((f) => MODEL_TYPES.includes(extOf(f)))) return loadModelFiles(files);
    const image = files.find((f) => f.type.startsWith('image/'));
    if (image) return loadImage(image);
    if (files.length) notice(`Can't read ${files[0].name}. Use a photo, or a 3D model (${MODEL_TYPES.join(', ')}).`, true);
  }

  function loadImage(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => useImage(img, url);
    img.onerror = () => notice('Sorry, that image could not be read.', true);
    img.src = url;
  }

  // HEIC (the iPhone's usual photo format): browsers can't read it, so it's decoded with libheif
  // (fetched on first use). A spatial photo holds two views; the first one is used.
  async function loadHeic(file) {
    if (!state.T) return notice('Still loading, try again in a moment.', true);
    try {
      notice(`Reading ${file.name}…`);
      const libheif = await state.T.loadHeif();
      const [image] = await L.decodeHeic(libheif, new Uint8Array(await file.arrayBuffer()));
      if (!image) throw new Error('no images inside');
      useImage(image, image.toDataURL('image/jpeg', 0.85));
    } catch (err) {
      console.error(err);
      notice(`Couldn't read ${file.name}: ${err.message || err}`, true);
    }
  }

  // A photo isn't built directly: it's shown, ready for the AI to turn it into a 3D model.
  function useImage(img, previewSrc) {
    state.source = { kind: 'image', img };
    state.model = null;
    setEditing(false);
    setPlaying(false);
    el.preview.src = previewSrc;
    el.preview.hidden = false;
    el.modelCard.hidden = true;
    el.dropzone.classList.add('has-image');
    notice('');
    showSettingsFor('image');
    clearParts();
    showEmpty('photo', previewSrc);
  }

  // The stage when nothing is built: the welcome screen, or the chosen photo waiting to be generated.
  function showEmpty(mode, photoSrc) {
    const photo = mode === 'photo';
    el.emptyPhoto.hidden = !photo;
    if (photo) el.emptyPhoto.src = photoSrc;
    el.empty.querySelector('.empty-bricks').hidden = photo;
    el.emptyTitle.textContent = photo ? 'Ready to make it 3D' : 'Build anything in LEGO';
    el.emptyText.textContent = photo
      ? 'Our AI builds a full 3D model of this object, back included (about a minute), then we turn it into LEGO.'
      : el.emptyText.dataset.welcome || (el.emptyText.dataset.welcome = el.emptyText.textContent);
    el.emptyGenerate.hidden = !photo;
    el.emptyChoose.textContent = photo ? 'Choose another' : 'Choose a photo or 3D model';
    el.emptyChoose.classList.toggle('primary', !photo);
    el.emptySample.hidden = photo;
    el.emptyStatus.hidden = true;
    el.empty.hidden = false;
    el.canvas.hidden = true;
    el.hint.hidden = true;
    el.controls.hidden = true;
  }

  function clearParts() {
    state.parts = [];
    state.partEls.clear();
    el.parts.textContent = '';
    el.partsSummary.textContent = '';
    el.buyBox.hidden = true;
    el.life.hidden = true;
    el.buildCheck.hidden = true;
  }

  function useModel(root, name, extra = {}) {
    state.source = { kind: 'model', root, name, ...extra };
    state.edits = [];
    state.volumeCache = null;
    setEditing(false);
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
    el.colsOut.value = el.cols.value;
    for (const node of document.querySelectorAll('[data-source]')) {
      node.hidden = !node.dataset.source.split(' ').includes(kind);
    }
  }

  // 3D files often come as several files (an .obj with its .mtl and texture, a .gltf with .bin),
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

  el.sample3d.addEventListener('click', () => {
    if (state.T) useModel(L.sampleModel(state.T), 'toadstool (sample model)');
  });
  el.sampleStarship.addEventListener('click', () => {
    el.life.open = true;
    if (!state.T) return;
    // Tall and thin: build it big enough that the fins, flaps and vents survive as bricks.
    showSettingsFor('model');
    el.cols.value = 300;
    el.colsOut.value = 300;
    useModel(L.starshipModel(state.T), 'Starship full stack (sample)', { realHeight: 123.1 });
  });

  el.emptyChoose.addEventListener('click', () => el.file.click());
  el.emptySample.addEventListener('click', () => el.sample3d.click());

  // ---------- AI 3D model from a photo (through our /api/generate-3d server function) ----------

  const AI3D_ENDPOINT = 'api/generate-3d';

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
      throw new Error('Couldn\'t reach the AI. Check your connection and try again.');
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // No JSON error means there is no server function here (opened from disk, GitHub Pages…).
      throw new Error(data.error || ([404, 405, 501].includes(r.status)
        ? 'The AI only works on the live site.'
        : `The AI service answered ${r.status}.`));
    }
    return data;
  }

  // Progress goes both under the photo in the panel and on the stage (which is what phones see first).
  function aiProgress(msg, isError = false) {
    notice(msg, isError);
    el.emptyStatus.textContent = msg;
    el.emptyStatus.hidden = !msg || !el.canvas.hidden;
    el.emptyStatus.classList.toggle('error', isError);
  }

  async function generate3d() {
    const src = state.source;
    if (!src || !src.img || state.generating) return;
    state.generating = true;
    el.ai3dBtn.disabled = el.emptyGenerate.disabled = true;
    const started = Date.now();
    try {
      aiProgress('Sending your photo…');
      const { id } = await callAi3d({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: photoAsJpeg(src.img, 1024) }),
      });
      let modelUrl = null;
      while (!modelUrl) {
        await new Promise((r) => setTimeout(r, 2500));
        const secs = Math.round((Date.now() - started) / 1000);
        if (secs > 600) throw new Error('It\'s taking too long; try again in a bit.');
        const job = await callAi3d({}, `?id=${encodeURIComponent(id)}`);
        if (job.status === 'COMPLETED') modelUrl = job.modelUrl;
        else if (job.status === 'IN_QUEUE') aiProgress(`Waiting for the AI${job.position ? ` (${job.position} ahead of you)` : ''}… ${secs}s`);
        else aiProgress(`Building your 3D model… ${secs}s (usually about a minute)`);
      }
      aiProgress('Downloading your 3D model…');
      const r = await fetch(modelUrl);
      if (!r.ok) throw new Error(`couldn't download the model (${r.status})`);
      if (state.source !== src) return; // they moved on to something else meanwhile
      const file = new File([await r.blob()], 'Your 3D model.glb', { type: 'model/gltf-binary' });
      await loadModelFiles([file]);
      if (state.source.kind === 'model') {
        state.source.photo = src;
        state.source.name = 'Your 3D model';
        el.modelCard.querySelector('strong').textContent = 'Your 3D model';
        notice('Here\'s your model. Anything extra? Use ✂ Remove parts under the build to delete it.');
      }
    } catch (err) {
      console.error(err);
      aiProgress(`Couldn't make the 3D model: ${err.message || err}`, true);
    } finally {
      state.generating = false;
      el.ai3dBtn.disabled = el.emptyGenerate.disabled = false;
    }
  }
  el.ai3dBtn.addEventListener('click', generate3d);
  el.emptyGenerate.addEventListener('click', generate3d);

  // ---------- settings ----------

  el.cols.addEventListener('input', () => { el.colsOut.value = el.cols.value; });
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
  // Turning the model changes where everything is, so earlier deletions no longer line up.
  el.up.addEventListener('change', () => { state.edits = []; });
  for (const input of [el.detail, el.cols, el.up, el.order, el.hollow, el.singles, el.baseplate]) {
    input.addEventListener('change', () => build(state.playing));
  }

  // The model as voxels, before any deletions. Voxelizing is the slow part, so it's kept while only
  // the edits, build order or hollowing change.
  function baseVolume(text, layer) {
    const key = [state.source.root.uuid, el.cols.value, el.up.value, layer].join('|');
    if (state.volumeCache?.key !== key) {
      state.volumeCache = {
        key,
        volume: L.voxelizeModel(state.T, state.source.root, {
          size: +el.cols.value, up: el.up.value, layer, maxTexture: text ? 2048 : 1024,
        }),
      };
    }
    return state.volumeCache.volume;
  }

  // Replays the user's deletions on a copy of the voxels.
  function applyEdits(volume, layer) {
    if (!state.edits.length) return volume;
    const { cols, rows, depth } = volume;
    const voxels = volume.voxels.slice();
    const size = +el.cols.value;
    for (const op of state.edits) {
      if (op.loose) continue; // applied to the bricks, in build()
      if (op.largest) { keepLargest(voxels, cols, rows, depth); continue; }
      const [cx, cy, cz] = op.sphere.map((v) => v * size);
      const r = op.r * size, r2 = r * r;
      const lo = (c, k) => Math.max(0, Math.floor((c - r) / k));
      for (let level = lo(cy, layer); level < rows && (level + 0.5) * layer <= cy + r; level++) {
        const dy = (level + 0.5) * layer - cy;
        for (let z = lo(cz, 1); z < depth && z + 0.5 <= cz + r; z++) {
          const dz = z + 0.5 - cz;
          for (let x = lo(cx, 1); x < cols && x + 0.5 <= cx + r; x++) {
            const dx = x + 0.5 - cx;
            if (dx * dx + dy * dy + dz * dz <= r2) voxels[(level * depth + z) * cols + x] = -1;
          }
        }
      }
    }
    return { ...volume, voxels };
  }

  // Keeps the biggest group of touching voxels and deletes the rest (stray bits, a separate base…).
  function keepLargest(voxels, cols, rows, depth) {
    const label = new Int32Array(voxels.length).fill(-1);
    const stack = [];
    let best = -1, bestSize = 0, id = 0;
    for (let start = 0; start < voxels.length; start++) {
      if (voxels[start] < 0 || label[start] >= 0) continue;
      let size = 0;
      label[start] = id;
      stack.push(start);
      while (stack.length) {
        const i = stack.pop();
        size++;
        const x = i % cols, z = Math.floor(i / cols) % depth, level = Math.floor(i / (cols * depth));
        const next = [
          x > 0 && i - 1, x < cols - 1 && i + 1,
          z > 0 && i - cols, z < depth - 1 && i + cols,
          level > 0 && i - cols * depth, level < rows - 1 && i + cols * depth,
        ];
        for (const j of next) {
          if (j !== false && voxels[j] >= 0 && label[j] < 0) { label[j] = id; stack.push(j); }
        }
      }
      if (size > bestSize) { bestSize = size; best = id; }
      id++;
    }
    for (let i = 0; i < voxels.length; i++) if (label[i] !== best) voxels[i] = -1;
  }

  function build(autoplay, { keepView = false, showAll = false } = {}) {
    if (!state.source || state.source.kind !== 'model' || !state.scene) return;
    const text = el.detail.value === 'text';
    const layer = text ? L.PLATE_HEIGHT : L.BRICK_HEIGHT;
    const opts = {
      hollow: el.hollow.checked, onlySingles: el.singles.checked, order: el.order.value, layer, baseplate: el.baseplate.checked,
    };
    let model, check, fixes;
    try {
      // Bricks, repaired and checked so the model holds together and every step can be built.
      ({ model, check, fixes } = L.buildChecked(applyEdits(baseVolume(text, layer), layer), opts));
      if (state.edits.some((op) => op.loose)) {
        // "Remove them": drop everything that doesn't connect to the main part.
        model.bricks = model.bricks.filter((b) => b.inMain);
        check = L.checkBuild(model, opts);
        model.bricks = check.order;
        model.bricks.forEach((b, i) => { b.step = i; });
      }
      // Sub-assemblies built separately and put on, like a real set.
      L.planAssemblies(model);
      check.hanging = model.bricks.filter((b) => b.hanging).length;
      if (opts.baseplate) model.baseplate = L.chooseBaseplate(model);
      model.check = check;
      model.fixes = fixes;
    } catch (err) {
      console.error(err);
      notice(`Couldn't build that: ${err.message || err}`, true);
      return;
    }
    if (!model.bricks.length) {
      notice(state.edits.length ? 'That removed everything. Use Undo to bring parts back.' : 'Nothing to build: the model came out empty.', true);
      return;
    }
    state.model = model;
    state.highlight = null;
    state.parts = L.partsList(model.bricks, model.palette, model.piece);
    if (model.baseplate) {
      const bp = model.baseplate, lbg = model.palette.find((c) => c.name === 'Light Bluish Gray');
      state.parts.unshift({
        key: 'baseplate', color: lbg, a: bp.a, c: bp.c, size: `${bp.a} × ${bp.c}`, kind: 'baseplate',
        partNum: bp.partNum, total: bp.count, placed: bp.count,
      });
    }
    renderParts();
    renderLifeSize();
    el.empty.hidden = true;
    el.canvas.hidden = false;
    if (el.hint.isConnected) el.hint.hidden = state.editing;
    el.controls.hidden = false;
    el.buyBox.hidden = false;
    el.scrub.max = model.bricks.length;
    state.placed = 0;
    state.active = [];
    layout();
    state.scene.setup(model, { keepView, baseplate: model.baseplate || false });
    renderChecks();
    seek(showAll ? Infinity : 0);
    setPlaying(autoplay);
  }

  // ---------- build check ----------

  function renderChecks() {
    const m = state.model, c = m.check, f = m.fixes || {};
    const loose = [...c.floating, ...c.separate].length;
    const rows = [];
    const row = (ok, text, actions = []) => rows.push({ ok, text, actions });
    row('ok', `<b>${c.connections.toLocaleString()} stud connections</b>, ${c.collisions ? `<b>${c.collisions} overlaps</b>` : 'no pieces overlap'}`);
    if (!loose) {
      const how = [f.hidden && 'a few hidden supports inside', f.recoloured && `${f.recoloured} ${f.recoloured === 1 ? 'stud' : 'studs'} recoloured so a piece can lock a side joint`].filter(Boolean);
      row('ok', `<b>Holds together</b> as one piece${how.length ? `, with ${how.join(' and ')}` : ''}`);
    } else {
      row('bad', `<b>${loose} ${m.pieces} don't connect</b> to the rest: they only touch it from the side, so they'd fall off`,
        [['Show', 'show-loose'], ['Remove them', 'remove-loose']]);
    }
    row(c.buildable ? 'ok' : 'bad', c.buildable
      ? `<b>Every step is buildable</b>${c.hanging ? `: ${c.hanging} ${m.pieces} clip on underneath the one above (the steps say when)` : ''}`
      : '<b>Some steps can\'t be built</b> until the loose pieces are fixed');
    if (m.baseplate) {
      row('ok', `<b>Stands on a ${m.baseplate.a} × ${m.baseplate.c} baseplate</b>${m.baseplate.count > 1 ? ` (${m.baseplate.count} of them)` : ''}, which holds the bottom together`);
    } else if (c.stable) {
      row('ok', `<b>Stands on its own</b>: its weight is ${c.margin.toFixed(1)} studs inside its base`);
    } else {
      row('warn', '<b>Would tip over</b>: its weight isn\'t over its base', [['Add a baseplate', 'baseplate']]);
    }
    if (c.weak.length) {
      row('warn', `<b>${c.weak.length} weak ${c.weak.length === 1 ? 'spot' : 'spots'}</b> held by a single stud: handle gently`, [['Show', 'show-weak']]);
    } else {
      row('ok', '<b>No weak spots</b> hanging on a single stud');
    }
    if (f.specks) row('info', `Left out ${f.specks} tiny loose ${f.specks === 1 ? 'bit' : 'bits'} that couldn't attach to anything`);

    const issues = rows.filter((r) => r.ok === 'bad' || r.ok === 'warn').length;
    const bad = rows.some((r) => r.ok === 'bad');
    el.buildCheck.dataset.state = bad ? 'bad' : issues ? 'warn' : 'ok';
    el.bcBadge.textContent = bad ? '!' : issues ? '!' : '✓';
    el.bcHeadline.textContent = bad ? 'Build check: needs a fix' : issues ? 'Build check: buildable, with notes' : 'Build check: ready to build';
    const icon = { ok: '✓', warn: '!', bad: '✕', info: 'i' };
    el.bcList.innerHTML = rows.map((r) => `<li class="bc-${r.ok}"><span class="bc-icon">${icon[r.ok]}</span>
      <span class="bc-text">${r.text}</span>${r.actions.map(([label, act]) => `<button type="button" class="bc-act" data-act="${act}">${label}</button>`).join('')}</li>`).join('');
    el.buildCheck.hidden = false;
  }

  el.bcList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || !state.model) return;
    const act = btn.dataset.act;
    if (act === 'remove-loose') return applyEdit({ loose: true });
    if (act === 'baseplate') { el.baseplate.checked = true; return build(false, { keepView: true, showAll: true }); }
    // Show: the problem pieces in colour, everything else washed out (press again to go back).
    const which = act === 'show-weak' ? (b) => b.weak : (b) => !b.inMain || b.loose;
    if (state.highlight === act) { state.highlight = null; state.scene.highlight(null); btn.textContent = 'Show'; return; }
    for (const other of el.bcList.querySelectorAll('[data-act^="show"]')) other.textContent = 'Show';
    state.highlight = act;
    setPlaying(false);
    seek(Infinity);
    state.scene.highlight(new Set(state.model.bricks.map((b, i) => (which(b) ? i : -1)).filter((i) => i >= 0)));
    btn.textContent = 'Hide';
  });

  // ---------- removing parts of the model ----------

  function setEditing(on) {
    state.editing = on;
    el.editBar.hidden = !on;
    el.edit.classList.toggle('on', on);
    el.canvasWrap.classList.toggle('edit-mode', on);
    if (el.hint.isConnected && state.model) el.hint.hidden = on;
    if (state.scene) state.scene.setBrush(null);
    if (on) {
      setPlaying(false);
      seek(Infinity);
      state.scene.controls.autoRotate = false;
      state.scene.follow = false;
    }
    updateEditButtons();
  }

  function updateEditButtons() {
    el.editUndo.disabled = el.editReset.disabled = !state.edits.length;
    for (const b of el.editBar.querySelectorAll('[data-brush]')) {
      b.setAttribute('aria-checked', String(+b.dataset.brush === state.brush));
    }
  }

  function applyEdit(op) {
    if (op) state.edits.push(op);
    build(false, { keepView: true, showAll: true });
    updateEditButtons();
  }

  el.edit.addEventListener('click', () => setEditing(!state.editing));
  el.editDone.addEventListener('click', () => setEditing(false));
  el.editUndo.addEventListener('click', () => { state.edits.pop(); applyEdit(); });
  el.editReset.addEventListener('click', () => { state.edits = []; applyEdit(); });
  el.editLargest.addEventListener('click', () => applyEdit({ largest: true }));
  for (const b of el.editBar.querySelectorAll('[data-brush]')) {
    b.addEventListener('click', () => { state.brush = +b.dataset.brush; updateEditButtons(); });
  }

  // A tap (not a drag, which turns the view) removes a ball of bricks around the spot.
  let press = null;
  el.canvas.addEventListener('pointerdown', (e) => { press = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  el.canvas.addEventListener('pointerup', (e) => {
    if (!state.editing || !press || !state.model) return;
    const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
    press = null;
    if (moved > 8) return;
    const hit = state.scene.pick(e.clientX, e.clientY);
    if (!hit) return;
    const size = +el.cols.value;
    applyEdit({ sphere: [hit.x / size, hit.y / size, hit.z / size], r: state.brush / size });
    if (e.pointerType === 'mouse') showBrush(e);
  });
  // Mouse users see the eraser before clicking.
  let brushFrame = 0;
  function showBrush(e) {
    if (!state.editing || e.pointerType !== 'mouse' || e.buttons) { state.scene?.setBrush(null); return; }
    const hit = state.scene.pick(e.clientX, e.clientY);
    state.scene.setBrush(hit && hit.world, state.brush);
  }
  el.canvas.addEventListener('pointermove', (e) => {
    if (!state.editing || brushFrame) return;
    brushFrame = requestAnimationFrame(() => { brushFrame = 0; showBrush(e); });
  });
  el.canvas.addEventListener('pointerleave', () => state.scene?.setBrush(null));

  function layout() {
    const w = el.canvasWrap.clientWidth;
    const h = Math.round(Math.max(320, Math.min(window.innerHeight - 250, w * 0.8)));
    state.scene.resize(w, h);
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.model && !state.recording) layout(); }, 100);
  });

  // ---------- playback ----------

  const bricksPerSecond = () => state.videoBps || Math.round(Math.pow(10, (el.speed.value / 100) * 3)); // 1 .. 1000

  function spawn(now) {
    const i = state.placed++;
    const duration = Math.min(700, Math.max(180, 6000 / bricksPerSecond()));
    state.active.push({ i, start: now, duration });
    state.scene.drop(i, 0);
    partFor(state.model.bricks[i]).placed++;
    state.uiDirty = true;
  }

  // The sub-assembly that's built and waiting to be put on before piece `state.placed` can go in.
  function dueAssembly() {
    const m = state.model;
    if (!m.assemblies) return null;
    const a = m.assemblies.find((x) => x.end === state.placed);
    return a && state.scene.lifts[a.group] > 0 ? a : null;
  }
  const ASSEMBLE_MS = 1100;
  function startAssembly(a, now) {
    state.assembling = { a, start: now };
    state.uiDirty = true;
  }
  function finishAssembly(a) {
    state.scene.setLift(a.group, 0, state.placed);
    state.assembling = null;
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
    state.assembling = null;
    state.scene.setLiftsAt(state.placed);
    for (const p of state.parts) p.placed = p.kind === 'baseplate' ? p.total : 0;
    for (let i = 0; i < state.placed; i++) partFor(state.model.bricks[i]).placed++;
    state.scene.showUpTo(state.placed);
    state.uiDirty = true;
  }

  function setPlaying(on) {
    if (!state.model) return;
    if (on && state.highlight) {
      state.highlight = null;
      state.scene.highlight(null);
      for (const b of el.bcList.querySelectorAll('[data-act^="show"]')) b.textContent = 'Show';
    }
    if (on && state.placed >= state.model.bricks.length && !dueAssembly()) seek(0);
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
      if (state.assembling) {
        // Lower the finished sub-assembly onto the model.
        const { a, start } = state.assembling;
        const t = Math.min(1, (now - start) / ASSEMBLE_MS);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        if (t >= 1) finishAssembly(a); else state.scene.setLift(a.group, a.lift * (1 - e), state.placed);
      } else if (state.playing) {
        state.acc += (dt / 1000) * bricksPerSecond();
        while (state.acc >= 1 && state.placed < total) {
          const due = dueAssembly();
          if (due) {
            if (!state.active.length) startAssembly(due, now); // once its last pieces have landed
            state.acc = Math.min(state.acc, 1);
            break;
          }
          spawn(now);
          state.acc--;
        }
        if (state.placed >= total && !state.assembling) {
          const due = dueAssembly();
          if (due && !state.active.length) startAssembly(due, now);
          else if (!due && !state.active.length) setPlaying(false);
        }
      }
      state.active = state.active.filter((a) => {
        const t = (now - a.start) / a.duration;
        if (t < 1) { state.scene.drop(a.i, t); return true; }
        state.scene.place(a.i);
        return false;
      });
      const last = state.placed ? m.bricks[state.placed - 1] : null;
      state.scene.setProgress(last ? last.level + 1 : 0);
      state.scene.focusLift = last && last.group ? state.scene.lifts[last.group] : 0;
      const ghost = !state.playing && !state.active.length && state.placed < total ? state.placed : null;
      state.scene.setGhost(ghost, now);
      if (state.uiDirty && now - state.lastUi > 60) updateUi(now);
    }
    if (!el.canvas.hidden) state.scene.render(dt); // nothing to draw while the photo screen shows
  }

  el.play.addEventListener('click', () => setPlaying(!state.playing));
  el.step.addEventListener('click', () => {
    if (!state.model) return;
    setPlaying(false);
    flushActive();
    // A built sub-assembly goes on as one step.
    if (state.assembling) return finishAssembly(state.assembling.a);
    const due = dueAssembly();
    if (due) return finishAssembly(due);
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
        <span class="pname"><b>${part.size}</b> ${part.color.name}${part.partNum
    ? ` <a class="pnum" href="${bricklinkUrl(part)}" target="_blank" rel="noopener" title="See this part on BrickLink">#${part.partNum}</a>` : ''}</span>
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

  const sub = (b) => (b.group ? `, sub-assembly ${state.model.assemblies[b.group - 1].label}` : '');

  function updateUi(now) {
    state.lastUi = now;
    state.uiDirty = false;
    const m = state.model;
    const total = m.bricks.length;
    el.scrub.value = state.placed;
    el.counter.textContent = `${state.placed.toLocaleString()} / ${total.toLocaleString()}`;
    const due = dueAssembly();
    el.play.textContent = state.playing ? '❚❚ Pause'
      : state.placed >= total && !due ? '↻ Build again' : state.placed ? '▶ Resume' : '▶ Build';

    if (state.assembling || (due && !state.playing)) {
      const a = state.assembling ? state.assembling.a : due;
      el.swatch.hidden = true;
      el.caption.textContent = state.assembling ? `Putting sub-assembly ${a.label} on…` : `Next: put sub-assembly ${a.label} on top, pressing it down all round`;
      for (const { part, li, count, bar } of state.partEls.values()) {
        count.textContent = `${part.placed}/${part.total}`;
        bar.style.width = `${(part.placed / part.total) * 100}%`;
        li.classList.toggle('done', part.placed === part.total);
        li.classList.remove('current');
      }
      return;
    }
    const next = !state.playing && state.placed < total ? m.bricks[state.placed] : null;
    const shown = next || m.bricks[state.placed - 1];
    const current = shown && shown.partKey;
    if (shown) {
      const c = m.palette[shown.color];
      el.swatch.style.background = c.css;
      el.swatch.hidden = false;
      el.caption.textContent = next
        ? `Next: ${next.size} ${c.name} ${m.piece}, layer ${next.level + 1}${sub(next)} ${next.hanging ? '(clip it on under the piece above)' : '(the glowing spot)'}`
        : `${shown.size} ${c.name} ${m.piece}, layer ${shown.level + 1} of ${m.rows}${sub(shown)}`;
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

  const buildTitle = () => (state.source.name || '').replace(/\.[a-z0-9]+$/i, '').replace(/\s*\((sample|sample model)\)$/, '') || 'Your build';
  const fileTitle = () => buildTitle().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'legofy';

  // A square video of the whole build (about 6–14 s, then a victory lap), for sharing.
  async function recordVideo() {
    if (!state.model || state.recording) return;
    const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
    const mimeType = window.MediaRecorder && el.canvas.captureStream && types.find((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) return notice('This browser can\'t record video. Try Chrome, Edge or Safari.', true);
    const { scene } = state;
    const total = state.model.bricks.length;
    const label = el.saveVideo.textContent;
    const css = { w: el.canvas.style.width, h: el.canvas.style.height };
    state.recording = true;
    setEditing(false);
    el.saveVideo.disabled = true;
    try {
      // Square 1080 × 1080 frames; on screen the canvas turns square too while recording.
      const SIZE = 1080;
      scene.renderer.setPixelRatio(1);
      scene.resize(SIZE, SIZE);
      const side = Math.min(el.canvasWrap.clientWidth, window.innerHeight - 250);
      el.canvas.style.width = el.canvas.style.height = `${Math.max(240, side)}px`;
      state.videoBps = Math.max(1, total / Math.min(14, Math.max(6, total / 40)));
      setPlaying(false);
      seek(0);
      scene.resetView(0.85);
      scene.controls.autoRotateSpeed = 2.4;
      const chunks = [];
      const recorder = new MediaRecorder(el.canvas.captureStream(30), { mimeType, videoBitsPerSecond: 8e6 });
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
      recorder.start(500);
      setPlaying(true);
      await new Promise((resolve) => {
        const check = () => {
          el.saveVideo.textContent = `🎬 ${Math.round((state.placed / total) * 100)}%`;
          if (state.placed >= total && !state.active.length && !state.assembling && !dueAssembly()) resolve();
          else setTimeout(check, 100);
        };
        check();
      });
      el.saveVideo.textContent = '🎬 …';
      await new Promise((r) => setTimeout(r, 2500)); // a last look around the finished build
      recorder.stop();
      await stopped;
      const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
      download(new Blob(chunks, { type: mimeType.split(';')[0] }), `${fileTitle()}-build.${ext}`);
      notice('Video saved.');
    } catch (err) {
      console.error(err);
      notice(`Couldn't record the video: ${err.message || err}`, true);
    } finally {
      state.recording = false;
      state.videoBps = null;
      scene.controls.autoRotateSpeed = 0.8;
      scene.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      el.canvas.style.width = css.w;
      el.canvas.style.height = css.h;
      layout();
      el.saveVideo.disabled = false;
      el.saveVideo.textContent = label;
    }
  }
  el.saveVideo.addEventListener('click', recordVideo);

  el.savePng.addEventListener('click', () => {
    state.scene.snapshot((blob) => download(blob, 'legofy-build.png'));
  });

  // Who may download the instruction manual. Everyone, for now: this is where a payment check
  // (e.g. Stripe Checkout) plugs in. Return { allowed: true } or { allowed: false, message }.
  L.manualAccess = L.manualAccess || (async () => ({ allowed: true }));

  el.saveManual.addEventListener('click', async () => {
    if (!state.model || !state.T) return;
    el.saveManual.disabled = true;
    const label = el.saveManual.textContent;
    try {
      const access = await L.manualAccess({ model: state.model, source: state.source });
      if (!access.allowed) { notice(access.message || 'The instructions aren\'t available right now.', true); return; }
      const jsPDF = await state.T.loadJsPdf();
      const title = buildTitle();
      const blob = await L.makeManual({
        T: state.T, jsPDF, model: state.model, parts: state.parts, title,
        onProgress: (f, text) => { el.saveManual.textContent = `${Math.round(f * 100)}%`; notice(text); },
      });
      download(blob, `${fileTitle()}-instructions.pdf`);
      notice('Instructions downloaded.');
    } catch (err) {
      console.error(err);
      notice(`Couldn't make the instructions: ${err.message || err}`, true);
    } finally {
      el.saveManual.disabled = false;
      el.saveManual.textContent = label;
    }
  });

  // ---------- buying the parts ----------

  // BrickLink is where LEGO fans buy loose parts: thousands of shops, with a Wanted List upload and
  // "Easy Buy", which finds the fewest shops that together have the whole list.
  const BRICKLINK_UPLOAD = 'https://www.bricklink.com/v2/wanted/upload.page';

  function bricklinkUrl(part) {
    return `https://www.bricklink.com/v2/catalog/catalogitem.page?P=${part.partNum}&idColor=${part.color.bricklinkId}`;
  }

  // BrickLink's Wanted List XML (part number, BrickLink colour id, quantity).
  function bricklinkXml() {
    const items = state.parts
      .filter((p) => p.partNum && p.color.bricklinkId != null)
      .map((p) => `  <ITEM>\n    <ITEMTYPE>P</ITEMTYPE>\n    <ITEMID>${p.partNum}</ITEMID>\n` +
        `    <COLOR>${p.color.bricklinkId}</COLOR>\n    <MINQTY>${p.total}</MINQTY>\n  </ITEM>`);
    return `<INVENTORY>\n${items.join('\n')}\n</INVENTORY>\n`;
  }

  let toastTimer;
  function toast(html) {
    el.toast.innerHTML = html;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 30000);
  }
  el.toast.addEventListener('click', (e) => { if (e.target.closest('.toast-close')) el.toast.hidden = true; });

  function buyParts() {
    if (!state.parts.length) return;
    const xml = bricklinkXml();
    const pieces = state.parts.reduce((n, p) => n + p.total, 0);
    // Start the copy before opening the tab: the page must still have focus for the clipboard.
    const copied = navigator.clipboard ? navigator.clipboard.writeText(xml).then(() => true, () => false) : Promise.resolve(false);
    window.open(BRICKLINK_UPLOAD, '_blank', 'noopener');
    copied.then((ok) => {
      if (!ok) download(new Blob([xml], { type: 'text/xml' }), 'legofy-bricklink-list.xml');
      toast(`<button class="toast-close" aria-label="Close">×</button>
        <b>Your ${pieces.toLocaleString()} pieces (${state.parts.length} kinds) are ${ok ? 'copied' : 'saved as an XML file'}.</b>
        <ol>
          <li>On the BrickLink tab, sign in (it's free) and ${ok ? 'paste into the box' : 'upload the file'}.</li>
          <li>Press <b>Proceed to verify items</b>, then add them to a Wanted List.</li>
          <li>Open the list and press <b>Easy Buy</b>: it finds shops that have everything, often in one or two orders.</li>
        </ol>`);
    });
  }
  el.buyParts.addEventListener('click', buyParts);
  el.buyParts2.addEventListener('click', buyParts);
  el.saveXml.addEventListener('click', () => {
    if (state.parts.length) download(new Blob([bricklinkXml()], { type: 'text/xml' }), 'legofy-bricklink-list.xml');
  });

  el.saveCsv.addEventListener('click', () => {
    // Rebrickable's parts-list import format (part number, Rebrickable colour id, quantity), so the list
    // can go straight into Rebrickable and on to BrickLink or LEGO Pick a Brick.
    const rows = [['Part', 'Color', 'Quantity'], ...state.parts.map((p) => [p.partNum, p.color.rebrickableId, p.total])];
    download(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), 'legofy-parts-rebrickable.csv');
  });
})(window.Legofy);
