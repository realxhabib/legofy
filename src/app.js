// UI wiring and the build playback loop. Legofy.start(THREE) is called once three.js has loaded.
(function (L) {
  const $ = (id) => document.getElementById(id);
  const el = {
    file: $('file'), dropzone: $('dropzone'), preview: $('preview'), sample: $('sample'),
    cols: $('cols'), colsOut: $('colsOut'), thick: $('thick'), thickOut: $('thickOut'),
    order: $('order'), removeBg: $('removeBg'), hollow: $('hollow'), dither: $('dither'), singles: $('singles'),
    parts: $('parts'), partsSummary: $('partsSummary'),
    canvasWrap: $('canvasWrap'), canvas: $('canvas'), empty: $('empty'), hint: $('hint'), controls: $('controls'),
    swatch: $('swatch'), caption: $('caption'), counter: $('counter'), scrub: $('scrub'),
    restart: $('restart'), back: $('back'), play: $('play'), step: $('step'), finish: $('finish'), view: $('view'),
    speed: $('speed'), speedOut: $('speedOut'), savePng: $('savePng'), saveCsv: $('saveCsv'),
    dropOverlay: $('dropOverlay'),
  };

  const state = {
    scene: null, img: null, model: null, parts: [], partEls: new Map(),
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

  L.start = function (THREE) {
    clearTimeout(loadTimeout);
    try {
      state.scene = new L.Scene3D(el.canvas, THREE);
    } catch (err) {
      showError('Your browser could not start WebGL, which the 3D build needs.');
      throw err;
    }
    state.scene.setBackground(getComputedStyle(document.documentElement).getPropertyValue('--stage').trim());
    // The orbit hint has done its job once someone drags the view.
    state.scene.controls.addEventListener('start', () => { el.hint.remove(); });
    if (state.img) build(true);
    requestAnimationFrame(tick);
  };

  // ---------- image input ----------

  function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => useImage(img, url);
    img.onerror = () => alert('Sorry, that image could not be read.');
    img.src = url;
  }

  function useImage(img, previewSrc) {
    state.img = img;
    el.preview.src = previewSrc;
    el.preview.hidden = false;
    el.dropzone.classList.add('has-image');
    build(true);
  }

  el.file.addEventListener('change', () => loadFile(el.file.files[0]));
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
    loadFile(e.dataTransfer.files[0]);
  });
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });

  el.sample.addEventListener('click', () => {
    const c = sampleImage();
    useImage(c, c.toDataURL());
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

  // ---------- settings ----------

  el.cols.addEventListener('input', () => { el.colsOut.value = el.cols.value; });
  el.thick.addEventListener('input', () => { el.thickOut.value = `${el.thick.value}%`; });
  for (const input of [el.cols, el.thick, el.order, el.removeBg, el.hollow, el.dither, el.singles]) {
    input.addEventListener('change', () => build(state.playing));
  }

  function build(autoplay) {
    if (!state.img || !state.scene) return;
    state.model = L.buildSculpture(state.img, {
      cols: +el.cols.value,
      thickness: el.thick.value / 100,
      removeBackground: el.removeBg.checked,
      hollow: el.hollow.checked,
      dither: el.dither.checked,
      onlySingles: el.singles.checked,
      order: el.order.value,
    });
    state.parts = L.partsList(state.model.bricks, state.model.palette);
    renderParts();
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
      `${state.model.bricks.length.toLocaleString()} bricks · ${colors} colors · ` +
      `${state.model.cols} × ${state.model.depth} studs, ${state.model.rows} bricks tall`;
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
        ? `Next: ${next.size} ${c.name} brick, layer ${next.level + 1} (the glowing spot)`
        : `${shown.size} ${c.name} brick, layer ${shown.level + 1} of ${m.rows}`;
    } else {
      el.swatch.hidden = true;
      el.caption.textContent = 'Press Build to start';
    }
    if (state.placed === total && !state.active.length) el.caption.textContent = 'Done! Every brick is in place.';

    for (const { part, li, count, bar } of state.partEls.values()) {
      count.textContent = `${part.placed}/${part.total}`;
      bar.style.width = `${(part.placed / part.total) * 100}%`;
      li.classList.toggle('done', part.placed === part.total);
      li.classList.toggle('current', part.key === current);
    }
  }

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
