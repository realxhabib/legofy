// Printable building instructions (PDF), LEGO-booklet style: a cover, a parts inventory with a 3D picture
// of every piece, then numbered steps on pale blue pages. Each step has a callout of the pieces it needs,
// the model so far in 3D (every piece in its real colour, earlier ones slightly softer) and a top-down plan of the layer
// with the layer below as a guide. Sub-assemblies get their own steps and a "put it on" step.
// Everything is drawn in the browser; jsPDF (loaded on first use) assembles the file.
(function (L) {
  const PAGE_W = 210, PAGE_H = 297, M = 12;           // A4 portrait, millimetres
  const MAX_STEPS = 150;                               // very tall builds get several layers per step

  const hex = (rgb) => rgb.map((v) => Math.round(v));
  const lighten = (rgb, t) => rgb.map((v) => Math.round(v + (255 - v) * t));
  const darken = (rgb, t) => rgb.map((v) => Math.round(v * (1 - t)));

  // A piece seen from above: body, darker outline, studs.
  // shape: 'slope' / 'slope2' (the right-hand half slopes down, no studs) or 'inverted'.
  function drawPiece(doc, x, y, a, c, rgb, unit, shape = null) {
    const w = c * unit, h = a * unit;
    doc.setFillColor(...hex(rgb));
    doc.setDrawColor(...darken(rgb, 0.45));
    doc.setLineWidth(0.25);
    doc.roundedRect(x, y, w, h, unit * 0.12, unit * 0.12, 'FD');
    const sloped = shape === 'slope' || shape === 'slope2';
    if (sloped) {
      // the sloped half: lighter, with lines running down the slope
      doc.setFillColor(...lighten(rgb, 0.35));
      doc.rect(x + w / 2, y + 0.2, w / 2 - 0.2, h - 0.4, 'F');
      doc.setDrawColor(...darken(rgb, 0.2));
      doc.setLineWidth(0.12);
      for (let k = 1; k < 4; k++) doc.line(x + w / 2 + (k * w) / 8, y + 0.4, x + w / 2 + (k * w) / 8, y + h - 0.4);
    }
    doc.setFillColor(...lighten(rgb, 0.25));
    doc.setDrawColor(...darken(rgb, 0.25));
    doc.setLineWidth(0.15);
    for (let i = 0; i < (sloped ? c / 2 : c); i++) {
      for (let j = 0; j < a; j++) doc.circle(x + (i + 0.5) * unit, y + (j + 0.5) * unit, unit * 0.3, 'FD');
    }
    return w;
  }

  // Top-down plan of one step's layer(s): the layer below faded, the new pieces outlined with studs.
  function planImage(model, bricks, below) {
    const { cols, depth } = model;
    const cell = Math.max(6, Math.min(28, Math.floor(900 / Math.max(cols, depth))));
    const pad = cell;
    const c = document.createElement('canvas');
    c.width = cols * cell + pad * 2;
    c.height = depth * cell + pad * 2 + cell;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    // faint stud grid of the whole footprint
    g.fillStyle = '#e4e8ed';
    for (let z = 0; z < depth; z++) for (let x = 0; x < cols; x++) g.fillRect(pad + x * cell + cell * 0.35, pad + z * cell + cell * 0.35, cell * 0.3, cell * 0.3);
    const rect = (b) => [pad + b.x * cell, pad + b.z * cell, b.w * cell, b.d * cell];
    for (const b of below) {
      const [x, y, w, h] = rect(b);
      g.fillStyle = `rgb(${lighten(model.palette[b.color].rgb, 0.45).join(',')})`; // the layer below, in its colours
      g.fillRect(x + 1, y + 1, w - 2, h - 2);
    }
    for (const b of bricks) {
      const [x, y, w, h] = rect(b);
      const rgb = model.palette[b.color].rgb;
      g.fillStyle = `rgb(${rgb.join(',')})`;
      g.fillRect(x + 1, y + 1, w - 2, h - 2);
      g.strokeStyle = `rgb(${darken(rgb, 0.55).join(',')})`;
      g.lineWidth = Math.max(1.5, cell * 0.1);
      g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
      if (b.shape === 'slope' || b.shape === 'slope2') {
        // the sloped half, lighter, with lines running downhill
        g.fillStyle = `rgb(${lighten(rgb, 0.4).join(',')})`;
        g.strokeStyle = `rgb(${darken(rgb, 0.15).join(',')})`;
        g.lineWidth = 1;
        for (const [i, j] of L.lowCells(b)) {
          const cx = x + i * cell, cy = y + j * cell;
          g.fillRect(cx + 3, cy + 3, cell - 6, cell - 6);
          for (let k = 1; k < 3; k++) {
            g.beginPath();
            if (b.dir % 2 === 0) { g.moveTo(cx + 3, cy + (k * cell) / 3); g.lineTo(cx + cell - 3, cy + (k * cell) / 3); }
            else { g.moveTo(cx + (k * cell) / 3, cy + 3); g.lineTo(cx + (k * cell) / 3, cy + cell - 3); }
            g.stroke();
          }
        }
      }
      if (cell >= 10) {
        g.fillStyle = `rgb(${lighten(rgb, 0.22).join(',')})`;
        for (const [i, j] of L.studCells(b)) {
          g.beginPath();
          g.arc(x + (i + 0.5) * cell, y + (j + 0.5) * cell, cell * 0.28, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    g.fillStyle = '#8a9099';
    g.font = `600 ${Math.max(12, cell * 0.8)}px sans-serif`;
    g.textAlign = 'center';
    g.fillText('FRONT', c.width / 2, c.height - cell * 0.4);
    return { url: c.toDataURL('image/jpeg', 0.9), w: c.width, h: c.height };
  }

  // Place an image inside a box, keeping its aspect ratio.
  function fit(doc, url, iw, ih, x, y, w, h) {
    const k = Math.min(w / iw, h / ih);
    doc.addImage(url, 'JPEG', x + (w - iw * k) / 2, y + (h - ih * k) / 2, iw * k, ih * k);
  }

  function countPieces(bricks) {
    const map = new Map();
    for (const b of bricks) {
      const a = Math.min(b.w, b.d), c = Math.max(b.w, b.d);
      const key = `${b.color}:${b.shape || ''}${a}x${c}`;
      if (!map.has(key)) map.set(key, { color: b.color, a, c, n: 0, shape: b.shape || null });
      map.get(key).n++;
    }
    return [...map.values()].sort((p, q) => q.a * q.c - p.a * p.c || p.color - q.color);
  }

  function footer(doc, page, title) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(`${title} · Legofy`, M, PAGE_H - 7);
    doc.text(String(page), PAGE_W - M, PAGE_H - 7, { align: 'right' });
  }

  const PAGE_BG = [233, 242, 249];                     // pale blue pages, like a LEGO booklet

  function pageBackground(doc) {
    doc.setFillColor(...PAGE_BG);
    doc.rect(0, 0, PAGE_W, PAGE_H, 'F');
  }
  function panel(doc, x, y, w, h) {
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(205, 219, 230);
    doc.setLineWidth(0.3);
    doc.roundedRect(x, y, w, h, 2.5, 2.5, 'FD');
  }

  // Small 3D pictures of single pieces (cached by colour and shape), on white, for the parts lists.
  function pieceIcons(T, model) {
    const W = 240, H = 180;
    const canvas = document.createElement('canvas');
    const scene = new L.Scene3D(canvas, T);
    scene.setBackground('#f1f4f7'); // light grey, so white pieces still show
    scene.resize(W, H);
    scene.follow = false;
    scene.controls.autoRotate = false;
    const lh = model.layerHeight || L.BRICK_HEIGHT;
    const cache = new Map();
    return {
      aspect: W / H,
      // p: { color: palette index, a, c, shape }
      get(p) {
        const key = `${p.color}:${p.shape || ''}:${p.a}x${p.c}`;
        if (cache.has(key)) return cache.get(key);
        const w = p.shape ? 2 : p.c, d = p.shape ? (p.shape === 'slope2' ? 2 : 1) : p.a;
        const piece = { x: 0, z: 0, level: 0, w, d, color: p.color, shape: p.shape || undefined, dir: 0 };
        scene.setup({ cols: w, depth: d, rows: 1, bricks: [piece], palette: model.palette, layerHeight: lh }, { keepView: true });
        for (const part of scene.baseplate) part.visible = false;
        scene.showUpTo(1);
        const radius = 0.5 * Math.hypot(w, d, lh + 0.2);
        const fov = (scene.camera.fov * Math.PI) / 180;
        scene.controls.target.set(0, (lh + 0.2) / 2, 0);
        scene.camera.position.copy(new T.Vector3(0.8, 0.75, 1).normalize().multiplyScalar(radius / Math.sin(fov / 2) * 1.02))
          .add(scene.controls.target);
        scene.controls.update();
        scene.render(16);
        const url = canvas.toDataURL('image/jpeg', 0.9);
        cache.set(key, url);
        return url;
      },
      dispose() { scene.renderer.dispose(); scene.renderer.forceContextLoss(); },
    };
  }

  // model: the built model; parts: L.partsList(...); title: name for the cover.
  L.makeManual = async function ({ T, jsPDF, model, parts, title = 'Your build', onProgress = () => {} }) {
    const kind = model.piece || 'brick';
    const layerMm = (model.layerHeight || L.BRICK_HEIGHT) * 8;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    let page = 1;

    // An off-screen copy of the 3D scene, on white, for the pictures.
    const canvas = document.createElement('canvas');
    const scene = new L.Scene3D(canvas, T);
    scene.setBackground('#ffffff');
    const RW = 900, RH = 860; // about the shape of the picture boxes
    scene.resize(RW, RH);
    scene.setup(model, { baseplate: model.baseplate || false });
    scene.setProgress(model.rows);
    scene.resetView();
    scene.follow = false;
    scene.controls.autoRotate = false;
    // Frame the finished model tightly: fit its bounding sphere, seen from the front-right, above.
    {
      const h = model.rows * (model.layerHeight || L.BRICK_HEIGHT) + (scene.maxLift || 0);
      const radius = 0.5 * Math.hypot(model.cols, model.depth, h);
      const fov = (scene.camera.fov * Math.PI) / 180;
      const dist = (radius / Math.sin(fov / 2)) * 0.95;
      const dir = new T.Vector3(0.55, 0.5, 0.68).normalize();
      scene.controls.target.set(0, h / 2, 0);
      scene.camera.position.copy(dir.multiplyScalar(dist)).add(scene.controls.target);
      scene.controls.update();
    }
    // Zoom to what's built so far (like a LEGO booklet), from the same angle: fit the bounding sphere of
    // the pieces shown, never closer than a few studs across.
    const viewDir = new T.Vector3(0.55, 0.5, 0.68).normalize();
    const frame = (upTo) => {
      const lh = model.layerHeight || L.BRICK_HEIGHT;
      const min = new T.Vector3(Infinity, Infinity, Infinity), max = new T.Vector3(-Infinity, -Infinity, -Infinity);
      for (let k = 0; k < upTo; k++) {
        const b = model.bricks[k];
        const [x, y, z] = scene.brickOrigin(b);
        min.min(new T.Vector3(x - b.w / 2, y, z - b.d / 2));
        max.max(new T.Vector3(x + b.w / 2, y + lh, z + b.d / 2));
      }
      if (min.x === Infinity) return;
      const centre = min.clone().add(max).multiplyScalar(0.5);
      const radius = Math.max(6, 0.5 * max.distanceTo(min));
      const fov = (scene.camera.fov * Math.PI) / 180;
      scene.controls.target.copy(centre);
      scene.camera.position.copy(viewDir).multiplyScalar((radius / Math.sin(fov / 2)) * 0.95).add(centre);
      scene.controls.update();
    };
    // pending: a sub-assembly that's built but not put on yet (it floats above its spot).
    const snapshot = (upTo, fadeFrom, pending = 0, background = '#f3f5f8') => {
      scene.setBackground(background);
      scene.setLiftsAt(upTo, pending);
      frame(upTo);
      scene.showUpTo(upTo);
      scene.fadeBefore(fadeFrom);
      scene.render(16);
      return canvas.toDataURL('image/jpeg', 0.88);
    };
    const icons = pieceIcons(T, model);
    // A piece picture: 3D for bricks, plates and slopes; drawn flat for a baseplate.
    const pieceAt = (p, colorIndex, x, y, h) => {
      if (p.kind === 'baseplate') return drawPiece(doc, x, y + h * 0.15, 2, 3, p.color.rgb, h * 0.23);
      const w = h * icons.aspect;
      doc.addImage(icons.get({ color: colorIndex, a: p.a, c: p.c, shape: p.shape }), 'JPEG', x, y, w, h);
      return w;
    };

    try {
      // ---------- cover ----------
      onProgress(0, 'Drawing the cover…');
      const total = model.bricks.length;
      const colours = new Set(model.bricks.map((b) => b.color)).size;
      const side = 74;
      doc.setFillColor(238, 241, 244);
      doc.rect(0, 0, PAGE_W, PAGE_H, 'F');
      fit(doc, snapshot(total, 0, 0, '#eef1f4'), RW, RH, side + 4, 40, PAGE_W - side - 10, 200);
      doc.setFillColor(36, 40, 46);
      doc.rect(0, 0, side, PAGE_H, 'F');
      doc.setFillColor(208, 16, 18);
      doc.rect(0, 0, side, 5, 'F');
      doc.setTextColor(170);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text('BRICK MODEL OF', 10, 26);
      doc.setTextColor(255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(24);
      doc.text(doc.splitTextToSize(title, side - 18), 10, 38);
      // yellow tag
      doc.setFillColor(242, 205, 55);
      doc.roundedRect(10, 70, side - 20, 14, 1.5, 1.5, 'F');
      doc.setTextColor(30);
      doc.setFontSize(8.5);
      doc.text(doc.splitTextToSize('Unofficial fan-made building instructions', side - 26), 13, 76);
      doc.setTextColor(255);
      doc.setFontSize(22);
      doc.text(total.toLocaleString(), 10, 106);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(200);
      doc.text(`${model.pieces || 'bricks'} · ${colours} colours`, 10, 112);
      const inch = (mm) => (mm / 25.4).toFixed(1);
      doc.text(`${inch(model.cols * 8)} × ${inch(model.depth * 8)} × ${inch(model.rows * layerMm)} in built`, 10, 118);
      doc.text(`(${(model.cols * 0.8).toFixed(1)} × ${(model.depth * 0.8).toFixed(1)} × ${(model.rows * layerMm / 10).toFixed(1)} cm)`, 10, 123);
      const check = model.check;
      if (check) {
        const bits = [`${check.connections.toLocaleString()} stud connections`, check.collisions ? `${check.collisions} overlaps` : 'no overlaps'];
        if (check.buildable) bits.push('every step buildable');
        if (model.baseplate) bits.push('stands on a baseplate');
        else if (check.stable) bits.push('stands on its own');
        doc.setFillColor(35, 132, 61);
        doc.roundedRect(10, 130, side - 20, 8 + bits.length * 5, 1.5, 1.5, 'F');
        doc.setTextColor(255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.text('Build-checked', 13, 136);
        doc.setFont('helvetica', 'normal');
        bits.forEach((t, k) => doc.text(`- ${t}`, 13, 141.5 + k * 5));
      }
      if (model.assemblies && model.assemblies.length) {
        doc.setTextColor(200);
        doc.setFontSize(9);
        doc.text(`${model.assemblies.length} sub-assembl${model.assemblies.length === 1 ? 'y' : 'ies'}`, 10, 170);
      }
      doc.setFontSize(7);
      doc.setTextColor(150);
      doc.text(doc.splitTextToSize('Every piece is a real LEGO® brick, plate or slope in a colour LEGO has produced. LEGO® is a trademark of the LEGO Group, which does not sponsor or endorse these instructions.', side - 20), 10, PAGE_H - 24);

      // ---------- parts inventory ----------
      const drawInventory = () => {
        doc.addPage(); page++;
        pageBackground(doc);
        doc.setTextColor(30);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(18);
        doc.text('Parts you need', M, M + 8);
        footer(doc, page, title);
        return M + 16;
      };
      let y = drawInventory();
      const colW = (PAGE_W - 2 * M) / 3, rowH = 22;
      parts.forEach((p, n) => {
        const col = n % 3;
        if (col === 0 && n > 0) y += rowH;
        if (y + rowH > PAGE_H - 16) y = drawInventory();
        const x = M + col * colW;
        panel(doc, x, y, colW - 3, rowH - 3);
        pieceAt(p, p.color.id, x + 1.5, y + 1.5, rowH - 6);
        const tx = x + 1.5 + (rowH - 6) * icons.aspect + 2;
        doc.setTextColor(30);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.text(`${p.total}×`, tx, y + 6.5);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.text(p.shape ? p.size : `${p.a} × ${p.c} ${p.kind === 'baseplate' ? 'baseplate' : kind}`, tx, y + 11);
        doc.setTextColor(110);
        doc.text(p.color.name, tx, y + 14.5);
        if (p.partNum) doc.text(`#${p.partNum}`, tx, y + 17.5);
      });

      // ---------- steps ----------
      const perStep = Math.max(1, Math.ceil(model.rows / MAX_STEPS));
      const steps = [];
      let i = 0;
      const assemblies = model.assemblies || [];
      while (i < total) {
        const start = i, levelTo = model.bricks[i].level + perStep, group = model.bricks[i].group || 0;
        while (i < total && model.bricks[i].level < levelTo && (model.bricks[i].group || 0) === group) i++;
        steps.push({ start, end: i, level: model.bricks[start].level, group });
        // A finished sub-assembly gets its own step: put it on.
        const a = group && assemblies[group - 1];
        if (a && i >= a.end) steps.push({ attach: a, start: a.start, end: a.end });
      }
      const blockH = (PAGE_H - 2 * M - 8) / 2;
      for (let s = 0; s < steps.length; s++) {
        const { start, end, level, group = 0, attach } = steps[s];
        if (s % 2 === 0) { doc.addPage(); page++; pageBackground(doc); footer(doc, page, title); }
        const top = M + (s % 2) * (blockH + 6);
        onProgress((s + 1) / steps.length, `Drawing step ${s + 1} of ${steps.length}…`);
        await new Promise((r) => setTimeout(r, 0));

        // Pieces callout (top left, like a LEGO booklet), then the step number under it.
        const bricks = attach ? [] : model.bricks.slice(start, end);
        const pieces = countPieces(bricks);
        const ICON_H = 10, cellW = ICON_H * icons.aspect + 9;
        const perRow = Math.max(1, Math.floor((PAGE_W - 2 * M - 6) / cellW));
        const shown = pieces.slice(0, perRow * 2);
        const calloutRows = attach ? 0 : Math.max(1, Math.ceil(shown.length / perRow));
        const calloutH = attach ? 0 : 4 + calloutRows * (ICON_H + 2);
        if (!attach) {
          const calloutW = Math.min(PAGE_W - 2 * M, 6 + Math.min(shown.length, perRow) * cellW);
          panel(doc, M, top, calloutW, calloutH);
          shown.forEach((p, k) => {
            const px = M + 3 + (k % perRow) * cellW, py = top + 2 + Math.floor(k / perRow) * (ICON_H + 2);
            const w = pieceAt({ ...p, kind: 'piece' }, p.color, px, py, ICON_H);
            doc.setTextColor(30);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8.5);
            doc.text(`${p.n}×`, px + w + 0.5, py + ICON_H - 1.5);
          });
          if (shown.length < pieces.length) {
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7.5);
            doc.setTextColor(110);
            doc.text(`+${pieces.length - shown.length} more kinds`, M + calloutW - 3, top + calloutH - 2, { align: 'right' });
          }
        }
        const numY = top + calloutH + 11;
        doc.setTextColor(20);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(24);
        doc.text(String(s + 1), M, numY);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(90);

        if (attach) {
          // Put the sub-assembly on: one big picture of the model with it in place.
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(12);
          doc.setTextColor(30);
          doc.text(`Put sub-assembly ${attach.label} on top`, M + 16, numY - 1);
          const w = PAGE_W - 2 * M, h = blockH - 30;
          panel(doc, M, numY + 3, w, h);
          fit(doc, snapshot(end, 0), RW, RH, M + 1, numY + 4, w - 2, h - 2);
          doc.setFillColor(255, 244, 204);
          doc.roundedRect(M, numY + 6 + h, w, 9, 2, 2, 'F');
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          doc.setTextColor(60);
          doc.text(`Line sub-assembly ${attach.label} up over the studs it sits on and press it down firmly all the way round.`, M + 4, numY + 11.8 + h);
          continue;
        }

        const lastLevel = bricks.reduce((m, b) => Math.max(m, b.level), level);
        const hanging = bricks.filter((b) => b.hanging).length;
        const label = group ? `Sub-assembly ${assemblies[group - 1].label} (build it separately) · ` : '';
        doc.text(label + (level === lastLevel ? `Layer ${level + 1} of ${model.rows}` : `Layers ${level + 1}–${lastLevel + 1} of ${model.rows}`) +
          (hanging ? ` · clip ${hanging} ${hanging === 1 ? 'piece' : 'pieces'} on underneath` : ''), M + 16, numY - 1);

        // The layer under this step's pieces, as far as it's built (a sub-assembly only has its own).
        const below = model.bricks.filter((b, k) => k < start && b.level === level - 1 && (!group || b.group === group));
        const imgTop = numY + 3;
        const imgW = (PAGE_W - 2 * M - 6) / 2, imgH = top + blockH - imgTop;
        panel(doc, M, imgTop, imgW, imgH);
        panel(doc, M + imgW + 6, imgTop, imgW, imgH);
        fit(doc, snapshot(end, start, group), RW, RH, M + 1, imgTop + 1, imgW - 2, imgH - 2);
        const plan = planImage(model, bricks, below);
        fit(doc, plan.url, plan.w, plan.h, M + imgW + 7, imgTop + 1, imgW - 2, imgH - 2);
      }
      return doc.output('blob');
    } finally {
      icons.dispose();
      scene.renderer.dispose();
      scene.renderer.forceContextLoss();
    }
  };
})(window.Legofy = window.Legofy || {});
