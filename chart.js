/* DPR-aware canvas charts. No framework. */
(function (global) {
  function dprCtx(canvas) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: rect.width, h: rect.height, dpr };
  }

  function extent(values, pad) {
    let lo = Math.min.apply(null, values);
    let hi = Math.max.apply(null, values);
    if (!isFinite(lo) || !isFinite(hi)) return { lo: 0, hi: 1 };
    if (lo === hi) { lo -= Math.abs(lo) * 0.01 || 1; hi += Math.abs(hi) * 0.01 || 1; }
    const span = hi - lo;
    return { lo: lo - span * (pad || 0.08), hi: hi + span * (pad || 0.12) };
  }

  function line(canvas, data, opts) {
    opts = opts || {};
    const { ctx, w, h } = dprCtx(canvas);
    ctx.clearRect(0, 0, w, h);
    const points = (data && data.points) || [];
    const marks = (data && data.marks) || [];
    if (!points.length) return { positions: [] };

    const padL = 8, padR = 8, padT = 28, padB = 12;
    const xs = points.map((p) => p.t);
    const ys = points.map((p) => p.v);
    const x0 = xs[0], x1 = xs[xs.length - 1] === x0 ? x0 + 1 : xs[xs.length - 1];
    const yx = extent(ys, 0.1);
    const X = (t) => padL + ((t - x0) / (x1 - x0)) * (w - padL - padR);
    const Y = (v) => padT + (1 - (v - yx.lo) / (yx.hi - yx.lo)) * (h - padT - padB);

    const path = new Path2D();
    points.forEach((p, i) => {
      const x = X(p.t), y = Y(p.v);
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    });

    const fill = new Path2D(path);
    const last = points[points.length - 1];
    fill.lineTo(X(last.t), h - padB);
    fill.lineTo(X(points[0].t), h - padB);
    fill.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, h);
    grad.addColorStop(0, "rgba(0,211,90,0.28)");
    grad.addColorStop(1, "rgba(0,211,90,0)");
    ctx.fillStyle = grad;
    ctx.fill(fill);

    if (data.start_v != null) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(235,235,245,0.3)";
      ctx.lineWidth = 1;
      const y = Y(data.start_v);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.strokeStyle = "#00d35a";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke(path);

    // mark x positions for the overlay (avoid overlap in JS)
    const positions = marks.map((m) => ({
      x: X(m.t),
      y: Y(interp(points, m.t)),
      mark: m,
    }));
    return { positions, X, Y };
  }

  function interp(points, t) {
    if (!points.length) return 0;
    if (t <= points[0].t) return points[0].v;
    for (let i = 1; i < points.length; i++) {
      if (t <= points[i].t) {
        const a = points[i - 1], b = points[i];
        const u = (t - a.t) / ((b.t - a.t) || 1);
        return a.v + (b.v - a.v) * u;
      }
    }
    return points[points.length - 1].v;
  }

  function candles(canvas, rows, opts) {
    opts = opts || {};
    const { ctx, w, h } = dprCtx(canvas);
    ctx.clearRect(0, 0, w, h);
    const data = rows || [];
    if (!data.length) return;
    const padL = 8, padR = 8, padT = 16, padB = 16;
    const ys = data.map((c) => c.c).filter((v) => v != null);
    if (!ys.length) return;
    const yx = extent(ys, 0.08);
    const n = data.length;
    const slot = (w - padL - padR) / n;
    const Y = (v) => padT + (1 - (v - yx.lo) / (yx.hi - yx.lo)) * (h - padT - padB);
    if (opts.exit != null) {
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = "#ff9f0a";
      ctx.lineWidth = 1;
      const y = Y(opts.exit);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.restore();
    }
    data.forEach((c, i) => {
      const x = padL + (i + 0.5) * slot;
      const y = Y(c.c);
      const prev = i ? Y(data[i - 1].c) : y;
      const up = c.c >= (i ? data[i - 1].c : c.c);
      ctx.strokeStyle = up ? "#00d35a" : "#ff453a";
      ctx.fillStyle = up ? "#00d35a" : "#ff453a";
      ctx.beginPath();
      ctx.moveTo(x, prev);
      ctx.lineTo(x, y);
      ctx.stroke();
      const bw = Math.max(1.5, slot * 0.55);
      const top = Math.min(prev, y), bot = Math.max(prev, y);
      ctx.fillRect(x - bw / 2, top, bw, Math.max(1, bot - top));
    });
  }

  function ring(canvas, score, opts) {
    const { ctx, w, h } = dprCtx(canvas);
    ctx.clearRect(0, 0, w, h);
    const s = Math.min(w, h) / 2;
    const cx = w / 2, cy = h / 2, r = s - 3;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#2c2c2e";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    if (score == null) return;
    const pct = Math.max(0, Math.min(100, score)) / 100;
    ctx.strokeStyle = score >= 70 ? "#00d35a" : "#ffd60a";
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2);
    ctx.stroke();
  }

  global.DeskChart = { line, candles, ring, dprCtx };
})(window);
