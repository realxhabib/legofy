// Printable building instructions (PDF), LEGO-manual style: a cover, a parts inventory, then numbered
// steps. Each step shows the model so far in 3D (new pieces in full colour, earlier ones faded), a
// top-down plan of the layer with the layer below as a guide, and the pieces that step needs.
// Everything is drawn in the browser; jsPDF (loaded on first use) assembles the file.
(function (L) {
  const PAGE_W = 210, PAGE_H = 297, M = 12;           // A4 portrait, millimetres
  const MAX_STEPS = 150;                               // very tall builds get several layers per step

  const hex = (rgb) => rgb.map((v) => Math.round(v));
  const lighten = (rgb, t) => rgb.map((v) => Math.round(v + (255 - v) * t));
  const darken = (rgb, t) => rgb.map((v) => Math.round(v * (1 - t)));

  // A piece seen from above: body, darker outline, studs.
  function drawPiece(doc, x, y, a, c, rgb, unit) {
    const w = c * unit, h = a * unit;
    doc.setFillColor(...hex(rgb));
    doc.setDrawColor(...darken(rgb, 0.45));
    doc.setLineWidth(0.25);
    doc.roundedRect(x, y, w, h, unit * 0.12, unit * 0.12, 'FD');
    doc.setFillColor(...lighten(rgb, 0.25));
    doc.setDrawColor(...darken(rgb, 0.25));
    doc.setLineWidth(0.15);
    for (let i = 0; i < c; i++) {
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
    g.fillStyle = '#eef1f4';
    g.fillRect(0, 0, c.width, c.height);
    // faint stud grid of the whole footprint
    g.fillStyle = '#dde1e6';
    for (let z = 0; z < depth; z++) for (let x = 0; x < cols; x++) g.fillRect(pad + x * cell + cell * 0.35, pad + z * cell + cell * 0.35, cell * 0.3, cell * 0.3);
    const rect = (b) => [pad + b.x * cell, pad + b.z * cell, b.w * cell, b.d * cell];
    for (const b of below) {
      const [x, y, w, h] = rect(b);
      g.fillStyle = `rgb(${lighten(model.palette[b.color].rgb, 0.72).join(',')})`;
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
      if (cell >= 10) {
        g.fillStyle = `rgb(${lighten(rgb, 0.22).join(',')})`;
        for (let i = 0; i < b.w; i++) {
          for (let j = 0; j < b.d; j++) {
            g.beginPath();
            g.arc(x + (i + 0.5) * cell, y + (j + 0.5) * cell, cell * 0.28, 0, Math.PI * 2);
            g.fill();
          }
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
      const key = `${b.color}:${a}x${c}`;
      if (!map.has(key)) map.set(key, { color: b.color, a, c, n: 0 });
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

  // model: the built model; parts: L.partsList(...); title: name for the cover.
  L.makeManual = async function ({ T, jsPDF, model, parts, title = 'Your build', onProgress = () => {} }) {
    const kind = model.piece || 'brick';
    const layerMm = (model.layerHeight || L.BRICK_HEIGHT) * 8;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    let page = 1;

    // An off-screen copy of the 3D scene, on white, for the pictures.
    const canvas = document.createElement('canvas');
    const scene = new L.Scene3D(canvas, T);
    scene.setBackground('#eef1f4');
    const RW = 900, RH = 860; // about the shape of the picture boxes
    scene.resize(RW, RH);
    scene.setup(model);
    for (const part of scene.baseplate) part.visible = false; // not part of the kit
    scene.setProgress(model.rows);
    scene.resetView();
    scene.follow = false;
    scene.controls.autoRotate = false;
    // Frame the finished model tightly: fit its bounding sphere, seen from the front-right, above.
    {
      const h = model.rows * (model.layerHeight || L.BRICK_HEIGHT);
      const radius = 0.5 * Math.hypot(model.cols, model.depth, h);
      const fov = (scene.camera.fov * Math.PI) / 180;
      const dist = (radius / Math.sin(fov / 2)) * 0.95;
      const dir = new T.Vector3(0.55, 0.5, 0.68).normalize();
      scene.controls.target.set(0, h / 2, 0);
      scene.camera.position.copy(dir.multiplyScalar(dist)).add(scene.controls.target);
      scene.controls.update();
    }
    const snapshot = (upTo, fadeFrom) => {
      scene.showUpTo(upTo);
      scene.fadeBefore(fadeFrom);
      scene.render(16);
      return canvas.toDataURL('image/jpeg', 0.88);
    };

    try {
      // ---------- cover ----------
      onProgress(0, 'Drawing the cover…');
      const total = model.bricks.length;
      doc.setFillColor(208, 16, 18);
      doc.rect(0, 0, PAGE_W, 34, 'F');
      doc.setTextColor(255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(26);
      doc.text(title, M, 22);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.text('Building instructions', PAGE_W - M, 22, { align: 'right' });
      fit(doc, snapshot(total, 0), RW, RH, M, 44, PAGE_W - 2 * M, 190);
      doc.setTextColor(40);
      doc.setFontSize(13);
      doc.setFont('helvetica', 'bold');
      const colours = new Set(model.bricks.map((b) => b.color)).size;
      doc.text(`${total.toLocaleString()} ${model.pieces || 'bricks'} · ${colours} colours`, M, 250);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.text(`${(model.cols * 0.8).toFixed(1)} × ${(model.depth * 0.8).toFixed(1)} × ${(model.rows * layerMm / 10).toFixed(1)} cm when built`, M, 258);
      doc.setFontSize(9);
      doc.setTextColor(120);
      doc.text('All pieces are real LEGO® bricks and plates in colours LEGO has produced. The parts list starts on the next page.', M, 270, { maxWidth: PAGE_W - 2 * M });
      footer(doc, page, title);

      // ---------- parts inventory ----------
      const drawInventory = () => {
        doc.addPage(); page++;
        doc.setTextColor(40);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(18);
        doc.text('Parts you need', M, M + 8);
        footer(doc, page, title);
        return M + 18;
      };
      let y = drawInventory();
      const colW = (PAGE_W - 2 * M) / 3, rowH = 21;
      parts.forEach((p, n) => {
        const col = n % 3;
        if (col === 0 && n > 0) y += rowH;
        if (y + rowH > PAGE_H - 16) y = drawInventory();
        const x = M + col * colW;
        const unit = Math.min(4.2, 30 / p.c);
        drawPiece(doc, x, y + 2, p.a, p.c, p.color.rgb, unit);
        doc.setTextColor(30);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.text(`${p.total}×`, x + 36, y + 6);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.text(`${p.a} × ${p.c} ${kind}`, x + 36, y + 10.5);
        doc.setTextColor(110);
        doc.text(`${p.color.name}${p.partNum ? ` · #${p.partNum}` : ''}`, x + 36, y + 14.5);
      });

      // ---------- steps ----------
      const perStep = Math.max(1, Math.ceil(model.rows / MAX_STEPS));
      const steps = [];
      let i = 0;
      while (i < total) {
        const start = i, levelTo = model.bricks[i].level + perStep;
        while (i < total && model.bricks[i].level < levelTo) i++;
        steps.push({ start, end: i, level: model.bricks[start].level });
      }
      const blockH = (PAGE_H - 2 * M - 8) / 2;
      for (let s = 0; s < steps.length; s++) {
        const { start, end, level } = steps[s];
        if (s % 2 === 0) { doc.addPage(); page++; footer(doc, page, title); }
        const top = M + (s % 2) * (blockH + 6);
        onProgress((s + 1) / steps.length, `Drawing step ${s + 1} of ${steps.length}…`);
        await new Promise((r) => setTimeout(r, 0));

        doc.setTextColor(20);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(26);
        doc.text(String(s + 1), M, top + 10);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(120);
        const lastLevel = model.bricks[end - 1].level;
        doc.text(level === lastLevel ? `Layer ${level + 1} of ${model.rows}` : `Layers ${level + 1}–${lastLevel + 1} of ${model.rows}`, M + 18, top + 9);

        const bricks = model.bricks.slice(start, end);
        const below = model.bricks.filter((b) => b.level === level - 1);
        const imgW = (PAGE_W - 2 * M - 6) / 2, imgH = blockH - 44;
        doc.setDrawColor(225);
        doc.setLineWidth(0.3);
        doc.roundedRect(M, top + 14, imgW, imgH, 2, 2, 'S');
        doc.roundedRect(M + imgW + 6, top + 14, imgW, imgH, 2, 2, 'S');
        fit(doc, snapshot(end, start), RW, RH, M + 1, top + 15, imgW - 2, imgH - 2);
        const plan = planImage(model, bricks, below);
        fit(doc, plan.url, plan.w, plan.h, M + imgW + 7, top + 15, imgW - 2, imgH - 2);

        // pieces for this step (up to two rows; a note if there are more kinds than fit)
        const boxY = top + 16 + imgH;
        const pieces = countPieces(bricks);
        const layout = [];
        let x = M + 4, row = 0;
        for (const p of pieces) {
          const unit = Math.min(3, 18 / p.c), w = p.c * unit;
          if (x + w + 12 > PAGE_W - M - 22) { x = M + 4; row++; }
          if (row > 1) break;
          layout.push({ p, x, row, unit, w });
          x += w + 12;
        }
        const rows = layout.length ? layout[layout.length - 1].row + 1 : 1;
        doc.setFillColor(244, 246, 248);
        doc.roundedRect(M, boxY, PAGE_W - 2 * M, 6 + rows * 10, 2, 2, 'F');
        for (const { p, x: px, row: r, unit, w } of layout) {
          const py = boxY + 3.5 + r * 10;
          drawPiece(doc, px, py, p.a, p.c, model.palette[p.color].rgb, unit);
          doc.setTextColor(30);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(9);
          doc.text(`${p.n}×`, px + w + 1.5, py + 3.5);
        }
        if (layout.length < pieces.length) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(110);
          doc.text(`+${pieces.length - layout.length} more kinds`, PAGE_W - M - 4, boxY + 8, { align: 'right' });
        }
      }
      return doc.output('blob');
    } finally {
      scene.renderer.dispose();
      scene.renderer.forceContextLoss();
    }
  };
})(window.Legofy = window.Legofy || {});
