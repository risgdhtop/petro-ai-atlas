(function () {
  'use strict';

  var NX = 340, NZ = 190;
  var C = {
    ink: '#242b2e', ink2: '#4d565b', ink3: '#79828a', ink4: '#9ba3a9',
    line: '#e9e4d8', paper: '#fbfaf6', paper2: '#f5f2ea',
    jade: '#2f7d6b', jaded: '#235f51', clay: '#b26a39', clayd: '#8e5229', bad: '#b05a51'
  };

  /* ---------------- 随机数与合成 ---------------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var rnd = mulberry32(20261102);
  function gauss() { return (rnd() + rnd() + rnd() - 1.5) * 1.15; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  var FAULTS = [
    { x: 108, dip: 0.10, th: 8.0, name: 'F1' },
    { x: 222, dip: -0.075, th: -10.0, name: 'F2' },
    { x: 288, dip: 0.055, th: 5.0, name: 'F3' }
  ];
  var LAYERS = [
    { z: 26, dip: 0.012, a: 0.95 }, { z: 52, dip: -0.016, a: -0.80 },
    { z: 78, dip: 0.008, a: 0.90 }, { z: 104, dip: 0.018, a: -0.70 },
    { z: 130, dip: -0.010, a: 0.85 }, { z: 156, dip: 0.014, a: -0.75 },
    { z: 178, dip: 0.006, a: 0.60 }
  ];
  function fx(f, z) { return f.x + f.dip * (z - NZ * 0.5); }
  function sig(u) { u = clamp(u, -8, 8); return 1 / (1 + Math.exp(-u)); }

  var i, j, k, x, z, idx;
  var disp = new Float32Array(NX * NZ);
  for (z = 0; z < NZ; z++) {
    for (x = 0; x < NX; x++) {
      var d = 0;
      for (k = 0; k < FAULTS.length; k++) d += FAULTS[k].th * sig((x - fx(FAULTS[k], z)) / 1.15);
      disp[z * NX + x] = d;
    }
  }

  /* 反射系数：沿层界面高斯 */
  var refl = new Float32Array(NX * NZ);
  for (x = 0; x < NX; x++) {
    for (z = 0; z < NZ; z++) {
      var s = 0;
      for (k = 0; k < LAYERS.length; k++) {
        var zk = LAYERS[k].z + LAYERS[k].dip * x + disp[z * NX + x];
        var dz = z - zk;
        s += LAYERS[k].a * Math.exp(-dz * dz / 1.44);
      }
      refl[z * NX + x] = s;
    }
  }

  /* Ricker 子波褶积 */
  var rick = [], RK = 13, f0 = 0.15;
  for (k = -RK; k <= RK; k++) {
    var a1 = Math.PI * f0 * k, a2 = a1 * a1;
    rick.push((1 - 2 * a2) * Math.exp(-a2));
  }
  var amp = new Float32Array(NX * NZ);
  for (x = 0; x < NX; x++) {
    for (z = 0; z < NZ; z++) {
      var acc = 0;
      for (k = -RK; k <= RK; k++) {
        var zz = z - k;
        if (zz >= 0 && zz < NZ) acc += refl[zz * NX + x] * rick[k + RK];
      }
      amp[z * NX + x] = acc;
    }
  }
  /* 噪声：随机 + 一条低频背景 */
  var lowN = new Float32Array(NX * NZ);
  var ph = rnd() * 6.28;
  for (z = 0; z < NZ; z++)
    for (x = 0; x < NX; x++)
      lowN[z * NX + x] = Math.sin(x * 0.06 + z * 0.03 + ph) * 0.5 + Math.sin(x * 0.021 - z * 0.05) * 0.5;

  var sorted = Array.prototype.slice.call(amp).sort(function (a, b) { return Math.abs(a) - Math.abs(b); });
  var p99 = Math.abs(sorted[Math.floor(sorted.length * 0.99)]) || 1;
  var scale = 0.88 / p99;
  for (i = 0; i < amp.length; i++) amp[i] = clamp(amp[i] * scale + 0.10 * gauss() + 0.02 * lowN[i], -1, 1);

  /* 真值掩膜 */
  var gt = new Uint8Array(NX * NZ);
  var gtCount = 0;
  for (idx = 0; idx < gt.length; idx++) {
    z = Math.floor(idx / NX); x = idx % NX;
    for (k = 0; k < FAULTS.length; k++) {
      if (Math.abs(x - fx(FAULTS[k], z)) <= 1.4 && z > 6 && z < NZ - 6) { gt[idx] = 1; gtCount++; break; }
    }
  }
  /* 容差带：真值膨胀 2 体素，用于「骨架容差匹配」口径 */
  var gtT = new Uint8Array(NX * NZ);
  var TR = 2;
  for (z = 0; z < NZ; z++) {
    for (x = 0; x < NX; x++) {
      if (!gt[z * NX + x]) continue;
      for (var dz2 = -TR; dz2 <= TR; dz2++) {
        for (var dx2 = -TR; dx2 <= TR; dx2++) {
          var zz2 = z + dz2, xx2 = x + dx2;
          if (zz2 >= 0 && zz2 < NZ && xx2 >= 0 && xx2 < NX) gtT[zz2 * NX + xx2] = 1;
        }
      }
    }
  }

  /* ---------------- 相干属性 ---------------- */
  var cohP = new Float32Array(NX * NZ);
  for (z = 2; z < NZ - 2; z++) {
    for (x = 1; x < NX - 1; x++) {
      var st = 0, ss = 0;
      for (var dz = -2; dz <= 2; dz++) {
        var sum = 0;
        for (var dx = -1; dx <= 1; dx++) {
          var v = amp[(z + dz) * NX + x + dx];
          sum += v; ss += v * v;
        }
        st += sum * sum;
      }
      var coh = st / (3 * (ss + 1e-6));
      cohP[z * NX + x] = clamp(1 - coh, 0, 1);
    }
  }
  var vals = [];
  for (i = 0; i < cohP.length; i += 3) vals.push(cohP[i]);
  vals.sort(function (a, b) { return a - b; });
  var n995 = vals[Math.floor(vals.length * 0.995)] || 0.2;
  var cs = 0.88 / Math.max(n995, 0.12);
  for (i = 0; i < cohP.length; i++) cohP[i] = clamp(cohP[i] * cs, 0, 0.98);

  /* ---------------- 模拟模型概率体 ---------------- */
  var dlP = new Float32Array(NX * NZ);
  for (z = 0; z < NZ; z++) {
    for (x = 0; x < NX; x++) {
      var p = 0.02;
      for (k = 0; k < FAULTS.length; k++) {
        var f = FAULTS[k];
        var dd = x - fx(f, z);
        var vert = 0.80 + 0.20 * Math.sin(z * 0.075 + k * 2.1);
        var str = k === 2 ? 0.72 : 1.0;
        p += 0.93 * str * vert * Math.exp(-dd * dd / (2 * 2.5 * 2.5));
      }
      /* 典型误判一：强振幅亮点被当成断裂 */
      p += 0.62 * Math.exp(-((x - 176) * (x - 176) + (z - 138) * (z - 138)) / (2 * 9 * 9));
      p += 0.50 * Math.exp(-((x - 52) * (x - 52) + (z - 52) * (z - 52)) / (2 * 7 * 7));
      /* 典型误判二：沿层强反射被整段拉高 */
      p += 0.34 * Math.exp(-((z - 96) * (z - 96)) / (2 * 3.2 * 3.2)) *
           Math.exp(-((x - 196) * (x - 196)) / (2 * 34 * 34));
      /* 典型误判三：低信噪比区的散点 */
      p += 0.30 * Math.exp(-((x - 300) * (x - 300) + (z - 34) * (z - 34)) / (2 * 10 * 10));
      dlP[z * NX + x] = clamp(p + 0.045 * gauss(), 0, 0.995);
    }
  }

  /* ---------------- 位图 ---------------- */
  function mix(c1, c2, t) {
    return [Math.round(c1[0] + (c2[0] - c1[0]) * t),
            Math.round(c1[1] + (c2[1] - c1[1]) * t),
            Math.round(c1[2] + (c2[2] - c1[2]) * t)];
  }
  var POS = [38, 52, 61], NEG = [176, 191, 199], MID = [251, 250, 246];

  var imgCv = document.createElement('canvas');
  imgCv.width = NX; imgCv.height = NZ;
  (function () {
    var c = imgCv.getContext('2d');
    var im = c.createImageData(NX, NZ);
    for (i = 0; i < amp.length; i++) {
      var v = amp[i];
      var g2 = Math.tanh(v * 1.75);
      var col = g2 >= 0 ? mix(MID, POS, Math.pow(g2, 0.8)) : mix(MID, NEG, Math.pow(-g2, 0.8));
      im.data[i * 4] = col[0]; im.data[i * 4 + 1] = col[1]; im.data[i * 4 + 2] = col[2]; im.data[i * 4 + 3] = 255;
    }
    c.putImageData(im, 0, 0);
  })();

  var heatCv = { dl: document.createElement('canvas'), coh: document.createElement('canvas') };
  ['dl', 'coh'].forEach(function (s) { heatCv[s].width = NX; heatCv[s].height = NZ; });

  function buildHeat(src) {
    var p = src === 'dl' ? dlP : cohP;
    var c = heatCv[src].getContext('2d');
    var im = c.createImageData(NX, NZ);
    for (i = 0; i < p.length; i++) {
      var q = p[i];
      if (q < 0.06) continue;
      var a = 0.62 * Math.pow(clamp((q - 0.06) / 0.94, 0, 1), 1.0);
      im.data[i * 4] = 176; im.data[i * 4 + 1] = 90; im.data[i * 4 + 2] = 81;
      im.data[i * 4 + 3] = Math.round(a * 255);
    }
    c.putImageData(im, 0, 0);
  }
  buildHeat('dl'); buildHeat('coh');

  /* Marching squares 等值线：插值出光滑边界，而不是像素台阶 */
  function drawContour(ctx, p, thr, L, T, iw, ih) {
    var sx = iw / NX, sy = ih / NZ;
    ctx.beginPath();
    for (var zz = 0; zz < NZ - 1; zz++) {
      for (var xx = 0; xx < NX - 1; xx++) {
        var a = p[zz * NX + xx], b = p[zz * NX + xx + 1],
            c = p[(zz + 1) * NX + xx + 1], d = p[(zz + 1) * NX + xx];
        var m = (a >= thr ? 1 : 0) | (b >= thr ? 2 : 0) | (c >= thr ? 4 : 0) | (d >= thr ? 8 : 0);
        if (m === 0 || m === 15) continue;
        var X0 = L + xx * sx, X1 = X0 + sx, Y0 = T + zz * sy, Y1 = Y0 + sy;
        function P(pa, pb, xa, ya, xb, yb) {
          var u = (thr - pa) / (pb - pa + 1e-9);
          return [xa + (xb - xa) * u, ya + (yb - ya) * u];
        }
        var top = P(a, b, X0, Y0, X1, Y0), right = P(b, c, X1, Y0, X1, Y1),
            bot = P(d, c, X0, Y1, X1, Y1), left = P(a, d, X0, Y0, X0, Y1);
        function seg(p1, p2) { ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); }
        switch (m) {
          case 1: case 14: seg(left, top); break;
          case 2: case 13: seg(top, right); break;
          case 3: case 12: seg(left, right); break;
          case 4: case 11: seg(right, bot); break;
          case 6: case 9: seg(top, bot); break;
          case 7: case 8: seg(left, bot); break;
          case 5: seg(left, top); seg(right, bot); break;
          case 10: seg(top, right); seg(left, bot); break;
        }
      }
    }
    ctx.strokeStyle = 'rgba(138,50,40,.92)';
    ctx.lineWidth = 1.35;
    ctx.stroke();
  }
  /* ---------------- 指标 ---------------- */
  function metrics(p, thr) {
    var tp = 0, fp = 0, fn = 0;
    for (var q = 0; q < p.length; q++) {
      var d = p[q] >= thr, g = gtT[q] === 1;
      if (d && g) tp++; else if (d && !g) fp++; else if (!d && gt[q] === 1) fn++;
    }
    var R = tp / (tp + fn + 1e-9), P = tp / (tp + fp + 1e-9);
    var hit = 0;
    for (var f = 0; f < FAULTS.length; f++) {
      var tot = 0, ok = 0;
      for (var zz = 8; zz < NZ - 8; zz++) {
        var xx = Math.round(fx(FAULTS[f], zz));
        if (xx < 1 || xx >= NX - 1) continue;
        tot++;
        if (p[zz * NX + xx] >= thr) ok++;
      }
      if (tot && ok / tot > 0.5) hit++;
    }
    return { tp: tp, fp: fp, fn: fn, R: R, P: P, F: 2 * P * R / (P + R + 1e-9), hit: hit };
  }

  /* ---------------- 画布 ---------------- */
  function fit(cv, aspect) {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = cv.clientWidth || 600;
    var h = Math.round(w / aspect);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.height = h + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, W: w, H: h };
  }

  var secCv = document.getElementById('sec');
  var prCv = document.getElementById('pr');
  var histCv = document.getElementById('hist');

  var state = { src: 'dl', view: 'overlay', thr: 0.5 };

  function drawSection() {
    var o = fit(secCv, NX / NZ), ctx = o.ctx, W = o.W, H = o.H;
    var L = 26, T = 8, R = 10, B = 16;
    var iw = W - L - R, ih = H - T - B;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.paper2; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(imgCv, L, T, iw, ih);
    if (state.view === 'overlay') {
      ctx.globalAlpha = 1;
      ctx.drawImage(heatCv[state.src], L, T, iw, ih);
      drawContour(ctx, state.src === 'dl' ? dlP : cohP, state.thr, L, T, iw, ih);
      ctx.save();
      /* 真值：先画一条半透明宽带，再画虚线中心线，避免被红色等值线盖住 */
      for (var f = 0; f < FAULTS.length; f++) {
        ctx.beginPath();
        for (var zz = 0; zz < NZ; zz += 2) {
          var X = L + (fx(FAULTS[f], zz) / NX) * iw, Y = T + (zz / NZ) * ih;
          if (zz === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
        }
        ctx.strokeStyle = 'rgba(47,125,107,.20)'; ctx.lineWidth = 6; ctx.setLineDash([]); ctx.stroke();
        ctx.strokeStyle = 'rgba(35,95,81,.75)'; ctx.lineWidth = 1.2; ctx.setLineDash([6, 5]); ctx.stroke();
      }
      ctx.restore();
    }
    /* 轴 */
    ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
    for (var t = 0; t <= 300; t += 60) {
      var X2 = L + (t / NX) * iw;
      ctx.fillRect(X2, T + ih, 1, 3);
      ctx.fillText(String(t), Math.min(X2 - 5, W - 22), T + ih + 11);
    }
    for (var s = 0.1; s <= 0.31; s += 0.10) {
      var Y2 = T + (s / (NZ * 0.002)) * ih;
      if (Y2 > T + ih) break;
      ctx.fillRect(L - 3, Y2, 3, 1);
      ctx.fillText(s.toFixed(1), 1, Y2 + 3);
    }
    ctx.fillStyle = C.ink4; ctx.fillText('T/s', 1, T - 1);
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    ctx.strokeRect(L - .5, T - .5, iw + 1, ih + 1);
  }

  function drawPR() {
    var o = fit(prCv, 1.75), ctx = o.ctx, W = o.W, H = o.H;
    var L = 34, R = 12, T = 12, B = 26, pw = W - L - R, ph = H - T - B;
    ctx.clearRect(0, 0, W, H);
    /* 网格 */
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var yy = T + ph * g / 4, xx = L + pw * g / 4;
      ctx.beginPath(); ctx.moveTo(L, yy + .5); ctx.lineTo(L + pw, yy + .5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(xx + .5, T); ctx.lineTo(xx + .5, T + ph); ctx.stroke();
    }
    ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
    for (g = 0; g <= 4; g++) {
      ctx.fillText((1 - g / 4).toFixed(1), 2, T + ph * g / 4 + 3);
      if (g % 2 === 0) ctx.fillText((g / 4).toFixed(1), L + pw * g / 4 - 6, H - 10);
    }
    ctx.save();
    ctx.translate(9, T + ph / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('P', -3, 0); ctx.restore();
    ctx.fillText('R', L + pw / 2 - 4, H - 1);

    var p = state.src === 'dl' ? dlP : cohP;
    var pts = [];
    for (var t = 0.06; t <= 0.94; t += 0.02) {
      var m = metrics(p, t);
      pts.push([m.R, m.P]);
    }
    ctx.beginPath();
    for (var q = 0; q < pts.length; q++) {
      var X = L + pw * pts[q][0], Y = T + ph * (1 - pts[q][1]);
      if (q === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
    ctx.strokeStyle = state.src === 'dl' ? C.clay : C.jade;
    ctx.lineWidth = 1.8; ctx.stroke();

    var cur = metrics(p, state.thr);
    var cx = L + pw * cur.R, cy = T + ph * (1 - cur.P);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = state.src === 'dl' ? C.clay : C.jade; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 6.2832); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.ink3; ctx.font = '8.5px ui-monospace,Consolas,monospace';
    ctx.fillText('F1 ' + cur.F.toFixed(2), Math.min(cx + 8, W - 42), Math.max(cy - 6, 10));
  }

  function drawHist() {
    var o = fit(histCv, 1.75), ctx = o.ctx, W = o.W, H = o.H;
    var L = 12, R = 10, T = 10, B = 26, pw = W - L - R, ph = H - T - B;
    ctx.clearRect(0, 0, W, H);
    var p = state.src === 'dl' ? dlP : cohP;
    var NB = 27, bg = [], fg = [], b;
    for (b = 0; b < NB; b++) { bg.push(0); fg.push(0); }
    for (var q = 0; q < p.length; q++) {
      var bi = Math.min(NB - 1, Math.floor(p[q] * NB));
      if (gt[q]) fg[bi]++; else bg[bi]++;
    }
    var mb = Math.max.apply(null, bg) || 1, mf = Math.max.apply(null, fg) || 1;

    /* 基线 */
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, T + ph + .5); ctx.lineTo(L + pw, T + ph + .5); ctx.stroke();

    function curve(arr, max, stroke, fill) {
      var pts = [], n;
      for (n = 0; n < NB; n++) {
        pts.push([L + (n + 0.5) * (pw / NB), T + ph - (arr[n] / max) * ph * 0.90]);
      }
      ctx.beginPath();
      ctx.moveTo(L, T + ph);
      for (n = 0; n < pts.length; n++) ctx.lineTo(pts[n][0], pts[n][1]);
      ctx.lineTo(L + pw, T + ph);
      ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      ctx.beginPath();
      for (n = 0; n < pts.length; n++) {
        if (n === 0) ctx.moveTo(pts[n][0], pts[n][1]); else ctx.lineTo(pts[n][0], pts[n][1]);
      }
      ctx.strokeStyle = stroke; ctx.lineWidth = 1.6; ctx.stroke();
    }
    curve(bg, mb, '#79828a', 'rgba(121,130,138,.16)');
    curve(fg, mf, C.jade, 'rgba(47,125,107,.14)');

    /* 阈值线 */
    ctx.strokeStyle = C.bad; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.2;
    var tx = L + pw * state.thr;
    ctx.beginPath(); ctx.moveTo(tx, T - 2); ctx.lineTo(tx, T + ph + 3); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
    ctx.fillText('p=0', L, H - 14); ctx.fillText('0.5', L + pw * .5 - 6, H - 14); ctx.fillText('1.0', L + pw - 12, H - 14);
    ctx.strokeStyle = C.jade; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(L, H - 7); ctx.lineTo(L + 12, H - 7); ctx.stroke();
    ctx.fillStyle = C.ink3; ctx.fillText('断层体素', L + 16, H - 4);
    ctx.strokeStyle = '#79828a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(L + 70, H - 7); ctx.lineTo(L + 82, H - 7); ctx.stroke();
    ctx.fillStyle = C.ink3; ctx.fillText('背景体素', L + 86, H - 4);
  }
  /* ---------------- 数字与文案 ---------------- */
  function update(full) {
    var p = state.src === 'dl' ? dlP : cohP;
    var m = metrics(p, state.thr);
    document.getElementById('thrOut').textContent = state.thr.toFixed(2);
    document.getElementById('roR').textContent = m.R.toFixed(2);
    document.getElementById('roP').textContent = m.P.toFixed(2);
    document.getElementById('roF').textContent = m.F.toFixed(3);
    document.getElementById('roN').textContent = m.hit + '/3';
    document.getElementById('roErr').innerHTML = '<span style="color:#b05a51">' + fmt(m.fp) +
      '</span> <small>fp</small> · <span style="color:#a97a1c">' + fmt(m.fn) + '</span> <small>fn</small>';
    document.getElementById('srcTag').textContent = state.src === 'dl' ? 'MODEL PROBABILITY' : 'COHERENCE ATTRIBUTE';
    var ro = document.getElementById('roR').parentNode;
    ro.className = 'ro ' + (m.R > 0.8 ? 'good' : m.R < 0.55 ? 'bad' : '');
    ro = document.getElementById('roP').parentNode;
    ro.className = 'ro ' + (m.P > 0.7 ? 'good' : m.P < 0.35 ? 'bad' : '');

    var note = document.getElementById('note');
    var srcName = state.src === 'dl' ? '模型概率' : '相干属性';
    var txt;
    if (state.thr < 0.34) {
      txt = '<b>' + srcName + ' · 阈值 ' + state.thr.toFixed(2) + '：宁滥勿缺</b> 召回 ' + m.R.toFixed(2) +
        '，三条断层全在，但 ' + fmt(m.fp) + ' 个背景体素被误判。解释员面对的是成片的红，' +
        '工作量从「找断层」变成「删红点」——这就是低阈值的代价。';
    } else if (state.thr > 0.72) {
      txt = '<b>' + srcName + ' · 阈值 ' + state.thr.toFixed(2) + '：宁缺勿滥</b> 精确率 ' + m.P.toFixed(2) +
        '，但只检出 ' + m.hit + '/3 条断层，漏掉 ' + fmt(m.fn) + ' 个体素。小断距断层（F3）最先消失，' +
        '而它恰恰可能是沟通储层的关键。';
    } else {
      txt = '<b>' + srcName + ' · 阈值 ' + state.thr.toFixed(2) + '：折中区</b> F1 ' + m.F.toFixed(3) +
        '，检出 ' + m.hit + '/3 条。注意 F1 最大的点并不等于业务最优点：验收看的是<b>单剖面漏检条数</b>，' +
        '工程上常主动把阈值再降 0.1—0.15，用误检换召回。';
    }
    if (state.src === 'coh') {
      txt += '<br><span style="color:#8e5229">相干属性没有「学习」任何东西：它对亮点与噪声同样敏感，' +
        '在剖面左下角整片发红——那正是低信噪比区。模型概率在那里更干净，但代价是它也会在亮点处自信地判错。</span>';
    }
    note.innerHTML = txt;

    drawSection(); drawPR(); drawHist();
  }
  function fmt(n) { return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n); }

  /* ---------------- 交互 ---------------- */
  document.getElementById('thr').addEventListener('input', function (e) {
    state.thr = parseFloat(e.target.value);
    update(true);
  });
  document.getElementById('srcSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.src = b.getAttribute('data-src');
    [].forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
    update(true);
  });
  document.getElementById('viewSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.view = b.getAttribute('data-view');
    [].forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
    update(false);
  });

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { drawSection(); drawPR(); drawHist(); }, 120);
  });

  update(true);
})();
