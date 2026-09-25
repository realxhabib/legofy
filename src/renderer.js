// Canvas renderer: a baseplate plus placed bricks cached offscreen, with falling bricks drawn on top.
(function (L) {
  const BASEPLATE = { css: '#d9dadb', light: '#eceded', dark: '#bfc1c3', darker: '#b3b5b7' };

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.board = document.createElement('canvas');
      this.bctx = this.board.getContext('2d');
      this.model = null;
    }

    setup(model, maxW, maxH) {
      this.model = model;
      const cell = Math.max(4, Math.min(28, Math.floor(Math.min(maxW / model.cols, maxH / model.rows))));
      const dpr = window.devicePixelRatio || 1;
      this.cell = cell * dpr;
      this.pad = Math.round(cell * 0.5) * dpr;
      const W = model.cols * this.cell + this.pad * 2;
      const H = model.rows * this.cell + this.pad * 2;
      for (const c of [this.canvas, this.board]) { c.width = W; c.height = H; }
      this.canvas.style.width = `${W / dpr}px`;
      this.canvas.style.height = `${H / dpr}px`;
      this.redrawTo(0);
    }

    // Rebuild the cached board with the first n bricks of the build order placed.
    redrawTo(n) {
      const { bctx: ctx, model, cell, pad } = this;
      ctx.clearRect(0, 0, this.board.width, this.board.height);
      ctx.fillStyle = BASEPLATE.css;
      roundRect(ctx, 0, 0, this.board.width, this.board.height, pad * 0.6);
      ctx.fill();
      for (let y = 0; y < model.rows; y++) {
        for (let x = 0; x < model.cols; x++) {
          drawStud(ctx, pad + (x + 0.5) * cell, pad + (y + 0.5) * cell, cell, BASEPLATE);
        }
      }
      for (let i = 0; i < n; i++) this.commit(model.bricks[i]);
    }

    commit(b) {
      this.drawBrick(this.bctx, b, 1, 1);
    }

    drawBrick(ctx, b, scale, alpha) {
      const { cell, pad } = this;
      const col = this.model.palette[b.color];
      const w = b.w * cell, h = b.h * cell;
      const cx = pad + b.x * cell + w / 2, cy = pad + b.y * cell + h / 2;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.translate(-w / 2, -h / 2);
      const inset = Math.max(0.5, cell * 0.03);
      ctx.fillStyle = col.dark;
      ctx.fillRect(inset, inset, w - inset * 2, h - inset * 2);
      const bevel = Math.max(1, cell * 0.08);
      ctx.fillStyle = col.light;
      ctx.fillRect(inset, inset, w - inset * 2, h - inset * 2 - bevel);
      ctx.fillStyle = col.css;
      ctx.fillRect(inset + bevel * 0.6, inset + bevel * 0.6, w - inset * 2 - bevel * 1.6, h - inset * 2 - bevel * 1.6);
      for (let y = 0; y < b.h; y++) {
        for (let x = 0; x < b.w; x++) drawStud(ctx, (x + 0.5) * cell, (y + 0.5) * cell, cell, col);
      }
      ctx.restore();
    }

    // Composite: board + outline for the next brick + bricks currently in flight.
    frame(active, now, ghost) {
      const { ctx, cell, pad } = this;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.board, 0, 0);
      if (ghost) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 180);
        ctx.save();
        ctx.lineWidth = Math.max(2, cell * 0.12);
        ctx.setLineDash([cell * 0.3, cell * 0.2]);
        ctx.strokeStyle = `rgba(20,20,20,${0.45 + pulse * 0.45})`;
        ctx.strokeRect(pad + ghost.x * cell, pad + ghost.y * cell, ghost.w * cell, ghost.h * cell);
        ctx.fillStyle = this.model.palette[ghost.color].css;
        ctx.globalAlpha = 0.25 + pulse * 0.25;
        ctx.fillRect(pad + ghost.x * cell, pad + ghost.y * cell, ghost.w * cell, ghost.h * cell);
        ctx.restore();
      }
      for (const a of active) {
        const t = Math.min(1, (now - a.start) / a.duration);
        const e = easeOutBounce(t);
        const scale = 1 + (1 - e) * 1.4;
        // shadow on the board darkens and tightens as the brick approaches
        const x = pad + a.brick.x * cell, y = pad + a.brick.y * cell;
        const w = a.brick.w * cell, h = a.brick.h * cell;
        const spread = (1 - t) * cell * 1.2;
        ctx.fillStyle = `rgba(0,0,0,${0.08 + 0.25 * t})`;
        ctx.fillRect(x - spread + cell * 0.15, y - spread + cell * 0.2, w + spread * 2, h + spread * 2);
        this.drawBrick(ctx, a.brick, scale, Math.min(1, t * 4));
      }
    }

    toBlob(cb) {
      this.board.toBlob(cb, 'image/png');
    }
  }

  function drawStud(ctx, cx, cy, cell, col) {
    const r = cell * 0.3;
    ctx.fillStyle = col.darker;
    ctx.beginPath();
    ctx.arc(cx + r * 0.18, cy + r * 0.22, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = col.css;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    if (cell >= 6) {
      ctx.strokeStyle = col.light;
      ctx.lineWidth = Math.max(0.75, r * 0.2);
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.72, Math.PI * 0.95, Math.PI * 1.55);
      ctx.stroke();
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function easeOutBounce(t) {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  }

  L.Renderer = Renderer;
})(window.Legofy = window.Legofy || {});
