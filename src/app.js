// UI wiring and the build playback loop.
(function (L) {
  const $ = (id) => document.getElementById(id);
  const el = {
    file: $('file'), dropzone: $('dropzone'), preview: $('preview'), sample: $('sample'),
    cols: $('cols'), colsOut: $('colsOut'), order: $('order'), dither: $('dither'), singles: $('singles'),
    parts: $('parts'), partsSummary: $('partsSummary'),
    canvasWrap: $('canvasWrap'), canvas: $('canvas'), empty: $('empty'), controls: $('controls'),
    swatch: $('swatch'), caption: $('caption'), counter: $('counter'), scrub: $('scrub'),
    restart: $('restart'), back: $('back'), play: $('play'), step: $('step'), finish: $('finish'),
    speed: $('speed'), speedOut: $('speedOut'), savePng: $('savePng'), saveCsv: $('saveCsv'),
    dropOverlay: $('dropOverlay'),
  };

  const renderer = new L.Renderer(el.canvas);
  const state = {
    img: null, model: null, parts: [], partEls: new Map(),
    placed: 0, active: [], playing: false, acc: 0, last: 0, uiDirty: true, lastUi: 0,
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

  // A little sunset scene so people can try it without an image.
  function sampleImage() {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, 300);
    sky.addColorStop(0, '#1d2b64');
    sky.addColorStop(0.55, '#c9447a');
    sky.addColorStop(1, '#fdb45c');
    g.fillStyle = sky;
    g.fillRect(0, 0, 640, 300);
    g.fillStyle = '#ffe36e';
    g.beginPath(); g.arc(320, 270, 90, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff';
    for (let i = 0; i < 40; i++) g.fillRect((i * 97) % 640, (i * 53) % 140, 3, 3);
    const hills = (color, base, amp, f, ph) => {
      g.fillStyle = color;
      g.beginPath(); g.moveTo(0, 480);
      for (let x = 0; x <= 640; x += 8) g.lineTo(x, base - amp * Math.sin(x * f + ph) - amp * 0.5 * Math.sin(x * f * 2.3));
      g.lineTo(640, 480); g.closePath(); g.fill();
    };
    hills('#6b3a78', 300, 60, 0.012, 1);
    hills('#3b2350', 320, 40, 0.018, 3);
    const sea = g.createLinearGradient(0, 330, 0, 480);
    sea.addColorStop(0, '#2b5e8c');
    sea.addColorStop(1, '#0d2340');
    g.fillStyle = sea;
    g.fillRect(0, 330, 640, 150);
    g.fillStyle = '#ffd36e';
    for (let y = 340; y < 470; y += 12) {
      const w = 110 - (y - 340) * 0.5;
      g.fillRect(320 - w / 2 + Math.sin(y) * 10, y, w, 4);
    }
    return c;
  }

  // ---------- settings ----------

  el.cols.addEventListener('input', () => { el.colsOut.value = el.cols.value; });
  el.cols.addEventListener('change', () => build(state.playing));
  for (const input of [el.order, el.dither, el.singles]) {
    input.addEventListener('change', () => build(state.playing));
  }

  function build(autoplay) {
    if (!state.img) return;
    state.model = L.buildMosaic(state.img, {
      cols: +el.cols.value,
      dither: el.dither.checked,
      onlySingles: el.singles.checked,
      order: el.order.value,
    });
    state.parts = L.partsList(state.model.bricks, state.model.palette);
    renderParts();
    el.empty.hidden = true;
    el.canvas.hidden = false;
    el.controls.hidden = false;
    el.scrub.max = state.model.bricks.length;
    state.placed = 0;
    state.active = [];
    layout();
    seek(0);
    setPlaying(autoplay);
  }

  function layout() {
    if (!state.model) return;
    const maxW = el.canvasWrap.clientWidth - 24;
    const maxH = Math.max(240, window.innerHeight - el.controls.offsetHeight - 140);
    renderer.setup(state.model, maxW, maxH);
    renderer.redrawTo(state.placed);
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { flushActive(); layout(); }, 150);
  });

  // ---------- playback ----------

  const bricksPerSecond = () => Math.round(Math.pow(10, (el.speed.value / 100) * 3)); // 1 .. 1000

  function spawn(now) {
    const brick = state.model.bricks[state.placed++];
    const duration = Math.min(450, Math.max(140, 4000 / bricksPerSecond()));
    state.active.push({ brick, start: now, duration });
    partFor(brick).placed++;
    state.uiDirty = true;
  }

  function flushActive() {
    for (const a of state.active) renderer.commit(a.brick);
    state.active = [];
  }

  function seek(n) {
    const total = state.model.bricks.length;
    state.placed = Math.max(0, Math.min(total, n));
    state.active = [];
    state.acc = 0;
    for (const p of state.parts) p.placed = 0;
    for (let i = 0; i < state.placed; i++) partFor(state.model.bricks[i]).placed++;
    renderer.redrawTo(state.placed);
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
        if (now - a.start < a.duration) return true;
        renderer.commit(a.brick);
        return false;
      });
      const ghost = !state.playing && !state.active.length && state.placed < total ? m.bricks[state.placed] : null;
      renderer.frame(state.active, now, ghost);
      if (state.uiDirty && now - state.lastUi > 60) updateUi(now);
    }
  }
  requestAnimationFrame(tick);

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
        <span class="plate" style="--c:${part.color.css}; --w:${part.size.split(' × ')[1]}; --h:${part.size.split(' × ')[0]}"></span>
        <span class="pname"><b>${part.size}</b> ${part.color.name}</span>
        <span class="pcount"></span>
        <span class="pbar"><i></i></span>`;
      el.parts.appendChild(li);
      state.partEls.set(part.key, { part, li, count: li.querySelector('.pcount'), bar: li.querySelector('.pbar i') });
    }
    const colors = new Set(state.model.bricks.map((b) => b.color)).size;
    el.partsSummary.textContent =
      `${state.model.bricks.length.toLocaleString()} plates · ${colors} colors · ${state.model.cols}×${state.model.rows} studs`;
  }

  function updateUi(now) {
    state.lastUi = now;
    state.uiDirty = false;
    const m = state.model;
    const total = m.bricks.length;
    el.scrub.value = state.placed;
    el.play.textContent = state.playing ? '❚❚ Pause'
      : state.placed >= total ? '↻ Build again' : state.placed ? '▶ Resume' : '▶ Build';
    el.counter.textContent = `${state.placed.toLocaleString()} / ${total.toLocaleString()}`;

    const next = !state.playing && state.placed < total ? m.bricks[state.placed] : null;
    const shown = next || m.bricks[state.placed - 1];
    const current = shown && shown.partKey;
    if (shown) {
      const c = m.palette[shown.color];
      el.swatch.style.background = c.css;
      el.swatch.hidden = false;
      const size = `${Math.min(shown.w, shown.h)} × ${Math.max(shown.w, shown.h)}`;
      el.caption.textContent = next
        ? `Next: ${size} ${c.name} plate at column ${next.x + 1}, row ${next.y + 1}`
        : `${size} ${c.name} plate`;
    } else {
      el.swatch.hidden = true;
      el.caption.textContent = 'Press Build to start';
    }
    if (state.placed === total && !state.active.length) el.caption.textContent = 'Done! Every plate is in place.';

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
    setPlaying(false);
    seek(Infinity);
    renderer.toBlob((blob) => download(blob, 'legofy-mosaic.png'));
  });

  el.saveCsv.addEventListener('click', () => {
    const rows = [['Color', 'Plate', 'Quantity'], ...state.parts.map((p) => [p.color.name, p.size.replace(' × ', 'x'), p.total])];
    download(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), 'legofy-parts.csv');
  });
})(window.Legofy);
