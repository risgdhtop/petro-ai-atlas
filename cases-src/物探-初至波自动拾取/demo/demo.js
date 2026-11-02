(function () {
  'use strict';

  var NT = 48, NS = 280;
  var C = {
    ink: '#242b2e', ink2: '#4d565b', ink3: '#79828a', ink4: '#9ba3a9',
    line: '#e9e4d8', paper2: '#f5f2ea', jade: '#2f7d6b', clay: '#b26a39', bad: '#b05a51'
  };

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var rnd = mulberry32(20261104);
  function gauss() { return (rnd() + rnd() + rnd() - 1.5) * 1.15; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* ---------- 真值初至 ---------- */
  var tb = new Float32Array(NT);
  for (var x = 0; x < NT; x++) tb[x] = 26 + 2.6 * x + 0.028 * x * x;

  var clean = new Float32Array(NT * NS);
  for (x = 0; x < NT; x++) {
    for (var t = 0; t < NS; t++) {
      var u = t - tb[x];
      if (u < 0) { clean[t * NT + x] = 0; continue; }
      var env = Math.exp(-u / 60);
      clean[t * NT + x] = env * (Math.sin(2 * Math.PI * 0.085 * u) + 0.35 * Math.sin(2 * Math.PI * 0.16 * u + 1.1));
    }
  }

  /* ---------- 噪声与观测记录 ---------- */
  var noisy = new Float32Array(NT * NS);
  var dlp = new Float32Array(NT * NS);
  var ratio = new Float32Array(NT * NS);
  var dlPick = new Int32Array(NT), stPick = new Int32Array(NT);
  var dlConf = new Float32Array(NT);

  function build(noise) {
    var x, t, i;
    for (x = 0; x < NT; x++) {
      var sg = (0.05 + 0.30 * noise) * (1 + 0.85 * x / (NT - 1));
      for (t = 0; t < NS; t++) noisy[t * NT + x] = clean[t * NT + x] + sg * gauss();
    }
    /* 模拟深度模型概率场：真值附近的高斯 + 随噪声增多的伪峰 */
    for (x = 0; x < NT; x++) {
      var bias = (rnd() - 0.5) * 2 * (0.35 + 2.4 * noise) * (0.35 + x / NT);
      var pick = tb[x] + bias;
      var sig = 1.3 + 2.0 * noise;
      var peak = (1 - 0.16 * noise) * (1 - 0.16 * x / NT);
      for (t = 0; t < NS; t++) {
        var d = t - pick;
        dlp[t * NT + x] = peak * Math.exp(-d * d / (2 * sig * sig));
      }
      var nf = Math.floor(noise * 3.2);
      for (i = 0; i < nf; i++) {
        var tp = 20 + rnd() * (NS - 40), ap = 0.18 + 0.32 * noise, wd = 1.6 + rnd() * 1.6;
        for (t = Math.max(2, Math.floor(tp - 8)); t < Math.min(NS - 2, tp + 8); t++) {
          var dd = t - tp;
          dlp[t * NT + x] = Math.min(0.95, dlp[t * NT + x] + ap * Math.exp(-dd * dd / (2 * wd * wd)));
        }
      }
    }
    /* STA/LTA：真实计算 */
    var STA = 4, LTA = 30;
    for (x = 0; x < NT; x++) {
      var pre = new Float64Array(NS + 1);
      for (t = 0; t < NS; t++) pre[t + 1] = pre[t] + noisy[t * NT + x] * noisy[t * NT + x];
      for (t = 0; t < NS; t++) {
        var a = Math.max(0, t - STA + 1), b = Math.max(0, t - LTA + 1);
        var es = (pre[t + 1] - pre[a]) / Math.max(1, t + 1 - a);
        var el = (pre[t + 1] - pre[b]) / Math.max(1, t + 1 - b);
        ratio[t * NT + x] = el > 1e-9 ? es / el : 0;
      }
    }
  }

  /* ---------- 拾取 ---------- */
  var state = { noise: 0.2, pthr: 0.5, rthr: 3.0, show: 'both', hover: 24 };
  var M = {};

  function pickAll() {
    var hits = { dl: 0, st: 0 }, miss = { dl: 0, st: 0 }, absd = { dl: 0, st: 0 }, cnt = { dl: 0, st: 0 }, big = { dl: 0, st: 0 };
    for (var x = 0; x < NT; x++) {
      /* 深度模型：概率阈值 */
      var best = -1, bi = -1;
      for (var t = 4; t < NS - 4; t++) {
        var p = dlp[t * NT + x];
        if (p > best) { best = p; bi = t; }
      }
      if (best < state.pthr) { dlPick[x] = -1; miss.dl++; } else dlPick[x] = bi;
      dlConf[x] = best;
      /* STA/LTA：首次越过阈值 */
      stPick[x] = -1;
      for (t = 10; t < NS - 4; t++) {
        if (ratio[t * NT + x] > state.rthr) {
          var ok = true;
          for (var k = 1; k <= 2; k++) if (ratio[(t + k) * NT + x] < state.rthr * 0.6) ok = false;
          if (ok) { stPick[x] = t; break; }
        }
      }
      if (stPick[x] < 0) miss.st++;
      /* 统计 */
      var d1 = dlPick[x] < 0 ? 99 : Math.abs(dlPick[x] - tb[x]);
      var d2 = stPick[x] < 0 ? 99 : Math.abs(stPick[x] - tb[x]);
      if (d1 <= 2) hits.dl++; else if (d1 < 99) big.dl++;
      if (d2 <= 2) hits.st++; else if (d2 < 99) big.st++;
      if (d1 < 99) { absd.dl += d1; cnt.dl++; }
      if (d2 < 99) { absd.st += d2; cnt.st++; }
    }
    M = { hits: hits, miss: miss, big: big, mean: { dl: cnt.dl ? absd.dl / cnt.dl : 0, st: cnt.st ? absd.st / cnt.st : 0 } };
  }

  /* ---------- 位图 ---------- */
  var imgCv = document.createElement('canvas');
  imgCv.width = NT; imgCv.height = NS;
  function mix(a, b, t) {
    return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
  }
  function paintImage() {
    var c = imgCv.getContext('2d'), im = c.createImageData(NT, NS);
    var MID = [251, 250, 246], POS = [36, 50, 58], NEG = [176, 191, 199], JAD = [47, 125, 107];
    var amax = 0.001;
    for (var i = 0; i < noisy.length; i++) amax = Math.max(amax, Math.abs(noisy[i]));
    for (var x = 0; x < NT; x++) {
      for (var t = 0; t < NS; t++) {
        var v = Math.tanh(noisy[t * NT + x] / amax * 1.6);
        var col = v >= 0 ? mix(MID, POS, Math.pow(v, 0.8)) : mix(MID, NEG, Math.pow(-v, 0.8));
        var p = dlp[t * NT + x];
        if (state.show !== 'sta' && p > 0.12) {
          var a = Math.pow(p, 1.3) * 0.62;
          col = mix(col, JAD, a);
        }
        var id = (t * NT + x) * 4;
        im.data[id] = col[0]; im.data[id + 1] = col[1]; im.data[id + 2] = col[2]; im.data[id + 3] = 255;
      }
    }
    c.putImageData(im, 0, 0);
  }

  /* ---------- 画布 ---------- */
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

  var gCv = document.getElementById('gather');
  var eCv = document.getElementById('err');
  var sCv = document.getElementById('single');

  function drawGather() {
    var o = fit(gCv, 1.72), ctx = o.ctx, W = o.W, H = o.H;
    var L = 34, T = 8, R = 8, B = 16;
    var iw = W - L - R, ih = H - T - B;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.paper2; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(imgCv, L, T, iw, ih);

    function px(x) { return L + (x + 0.5) * iw / NT; }
    function py(t) { return T + (t / (NS - 1)) * ih; }

    /* 真值 */
    ctx.save();
    ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(36,43,46,.85)'; ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (x = 0; x < NT; x++) { var X = px(x), Y = py(tb[x]); if (x === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y); }
    ctx.stroke(); ctx.restore();

    function series(arr, color) {
      ctx.beginPath();
      var started = false;
      for (var i = 0; i < NT; i++) {
        if (arr[i] < 0) { started = false; continue; }
        var X = px(i), Y = py(arr[i]);
        if (!started) { ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
      }
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.9; ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (state.show !== 'sta') series(dlPick, '#1f7a63');
    if (state.show !== 'dl') series(stPick, '#b26a39');

    /* 悬停 */
    var hx = px(state.hover);
    ctx.strokeStyle = 'rgba(36,43,46,.45)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, T); ctx.lineTo(hx, T + ih); ctx.stroke();

    /* 轴 */
    ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
    for (var tt = 0; tt < NS; tt += 40) {
      var Y2 = py(tt);
      ctx.fillRect(L - 3, Y2, 3, 1);
      ctx.fillText(String(tt), 1, Y2 + 3);
    }
    for (var xx = 0; xx < NT; xx += 8) ctx.fillText('T' + xx, px(xx) - 6, H - 4);
    ctx.fillText('ms', 1, T + ih + 12);
    ctx.strokeStyle = C.line; ctx.strokeRect(L - .5, T - .5, iw + 1, ih + 1);
  }

  function drawErr() {
    var o = fit(eCv, 1.95), ctx = o.ctx, W = o.W, H = o.H;
    var L = 30, T = 10, R = 10, B = 24, iw = W - L - R, ih = H - T - B;
    var YMAX = 14;
    ctx.clearRect(0, 0, W, H);
    /* 容差带 */
    ctx.fillStyle = 'rgba(47,125,107,.10)';
    ctx.fillRect(L, T + ih - ih * 2 / YMAX, iw, ih * 2 / YMAX);
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var Y = T + ih * g / 4;
      ctx.beginPath(); ctx.moveTo(L, Y + .5); ctx.lineTo(L + iw, Y + .5); ctx.stroke();
      ctx.fillStyle = C.ink4;
      ctx.fillText(String(Math.round(YMAX * (1 - g / 4))), 2, Y + 3);
    }
    ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
    ctx.fillText('±2', L + 4, T + ih - ih * 2 / YMAX - 4);
    ctx.fillText('远偏移距 →', W - 58, T + ih + 14);
    var bw = iw / NT;
    for (var x = 0; x < NT; x++) {
      var d1 = dlPick[x] < 0 ? null : Math.min(YMAX, Math.abs(dlPick[x] - tb[x]));
      var d2 = stPick[x] < 0 ? null : Math.min(YMAX, Math.abs(stPick[x] - tb[x]));
      if (state.show !== 'sta' && d1 !== null) {
        ctx.fillStyle = 'rgba(47,125,107,.85)';
        ctx.fillRect(L + x * bw + 0.6, T + ih - d1 / YMAX * ih, Math.max(bw * 0.42, 1.5), 2.4);
      }
      if (state.show !== 'dl' && d2 !== null) {
        ctx.fillStyle = 'rgba(178,106,57,.85)';
        ctx.fillRect(L + x * bw + bw * 0.45, T + ih - d2 / YMAX * ih, Math.max(bw * 0.42, 1.5), 2.4);
      }
    }
    ctx.strokeStyle = C.line; ctx.strokeRect(L - .5, T - .5, iw + 1, ih + 1);
  }

  function drawSingle() {
    var o = fit(sCv, 1.95), ctx = o.ctx, W = o.W, H = o.H;
    ctx.clearRect(0, 0, W, H);
    var x = state.hover, L = 8, T = 8, R = 8;
    var hw = W - L - R, hh = (H - 20) * 0.58, hh2 = (H - 30) * 0.34;
    var base = T + hh * 0.5;
    /* 波形 */
    ctx.beginPath();
    var amax = 0.001;
    for (var t = 0; t < NS; t++) amax = Math.max(amax, Math.abs(noisy[t * NT + x]));
    for (t = 0; t < NS; t++) {
      var X = L + t / (NS - 1) * hw, Y = base - noisy[t * NT + x] / amax * hh * 0.46;
      if (t === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
    ctx.strokeStyle = 'rgba(77,86,91,.85)'; ctx.lineWidth = 0.9; ctx.stroke();
    /* 概率填充 */
    var pb = T + hh - 2, ph = hh * 0.62;
    ctx.beginPath(); ctx.moveTo(L, pb);
    for (t = 0; t < NS; t++) ctx.lineTo(L + t / (NS - 1) * hw, pb - dlp[t * NT + x] * ph);
    ctx.lineTo(L + hw, pb); ctx.closePath();
    ctx.fillStyle = 'rgba(47,125,107,.22)'; ctx.fill();
    ctx.beginPath();
    for (t = 0; t < NS; t++) {
      var Yp = pb - dlp[t * NT + x] * ph;
      if (t === 0) ctx.moveTo(L, Yp); else ctx.lineTo(L + t / (NS - 1) * hw, Yp);
    }
    ctx.strokeStyle = C.jade; ctx.lineWidth = 1.3; ctx.stroke();
    /* 拾取标记 */
    if (dlPick[x] >= 0) {
      var Xd = L + dlPick[x] / (NS - 1) * hw;
      ctx.strokeStyle = C.jade; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(Xd, T); ctx.lineTo(Xd, T + hh); ctx.stroke();
    }
    var Xt = L + tb[x] / (NS - 1) * hw;
    ctx.strokeStyle = 'rgba(36,43,46,.6)'; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(Xt, T); ctx.lineTo(Xt, T + hh); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
    ctx.fillText('波形 + 概率', L, T + 6);
    ctx.fillStyle = C.jade; ctx.fillText('p=' + dlConf[x].toFixed(2), L + 62, T + 6);

    /* 比值曲线 */
    var T2 = T + hh + 14;
    ctx.strokeStyle = C.line; ctx.strokeRect(L - .5, T2 - .5, hw + 1, hh2 + 1);
    var rmax = Math.max(state.rthr * 1.6, 6);
    ctx.beginPath();
    for (t = 0; t < NS; t++) {
      var Yr = T2 + hh2 - Math.min(ratio[t * NT + x], rmax) / rmax * hh2;
      if (t === 0) ctx.moveTo(L, Yr); else ctx.lineTo(L + t / (NS - 1) * hw, Yr);
    }
    ctx.strokeStyle = C.clay; ctx.lineWidth = 1.2; ctx.stroke();
    var Yth = T2 + hh2 - state.rthr / rmax * hh2;
    ctx.strokeStyle = 'rgba(176,90,81,.7)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(L, Yth); ctx.lineTo(L + hw, Yth); ctx.stroke();
    ctx.setLineDash([]);
    if (stPick[x] >= 0) {
      var Xs = L + stPick[x] / (NS - 1) * hw;
      ctx.strokeStyle = C.clay; ctx.beginPath(); ctx.moveTo(Xs, T2); ctx.lineTo(Xs, T2 + hh2); ctx.stroke();
    }
    ctx.fillStyle = C.ink4; ctx.fillText('STA/LTA 比值 · 阈值 ' + state.rthr.toFixed(1), L + 3, T2 + 9);
  }

  /* ---------- 更新 ---------- */
  function refresh() {
    var hd = M.hits.dl / NT, hs = M.hits.st / NT;
    document.getElementById('noiseOut').textContent = state.noise.toFixed(2);
    document.getElementById('pthrOut').textContent = state.pthr.toFixed(2);
    document.getElementById('rthrOut').textContent = state.rthr.toFixed(1);
    document.getElementById('gTag').textContent = 'NOISE ' + state.noise.toFixed(2);
    document.getElementById('roDh').textContent = hd.toFixed(3);
    document.getElementById('roSh').textContent = hs.toFixed(3);
    document.getElementById('roDe').textContent = M.mean.dl.toFixed(2);
    document.getElementById('roSe').textContent = M.mean.st.toFixed(2);
    document.getElementById('roMiss').innerHTML =
      '<span style="color:#a97a1c">' + M.miss.dl + '</span> / <span style="color:#b05a51">' + M.big.dl +
      '</span> <small>模型</small> · <span style="color:#a97a1c">' + M.miss.st + '</span> / <span style="color:#b05a51">' +
      M.big.st + '</span> <small>STA/LTA</small>';
    var a = document.getElementById('roDh').parentNode;
    a.className = 'ro ' + (hd > 0.9 ? 'good' : hd < 0.7 ? 'bad' : '');
    var b = document.getElementById('roSh').parentNode;
    b.className = 'ro ' + (hs > 0.9 ? 'good' : hs < 0.7 ? 'bad' : '');

    /* 远/近偏移距分档 */
    var nearD = 0, farD = 0, nearN = 0, farN = 0;
    for (x = 0; x < NT; x++) {
      var okd = dlPick[x] >= 0 && Math.abs(dlPick[x] - tb[x]) <= 2;
      if (x < 16) { nearN++; if (okd) nearD++; } else if (x >= 32) { farN++; if (okd) farD++; }
    }
    var msg;
    if (state.noise < 0.25) {
      msg = '<b>噪声 ' + state.noise.toFixed(2) + '</b> 模型命中 ' + hd.toFixed(2) + '，STA/LTA 命中 ' + hs.toFixed(2) +
        '。干净数据下两者都不错，但能量比法已经开始在远偏移距误拾——它的阈值是全局的。';
    } else if (state.noise < 0.65) {
      msg = '<b>噪声 ' + state.noise.toFixed(2) + '：远偏移距先失守</b> 近偏移距模型命中率 ' +
        (nearD / nearN).toFixed(2) + '，远偏移距掉到 ' + (farD / farN).toFixed(2) +
        '。STA/LTA 的误拾集中在远道——它把噪声尖峰当成了初至，误差往往超过 10 个采样。';
    } else {
      msg = '<b>噪声 ' + state.noise.toFixed(2) + '：两条曲线都塌了</b> 模型 ' + hd.toFixed(2) +
        '，STA/LTA ' + hs.toFixed(2) + '。此时真正该做的不是调阈值，而是检查这一炮的采集质量，' +
        '或者干脆把远道标为「不参与静校正」。';
    }
    if (state.pthr > 0.7) msg += '<br><span style="color:#8e5229">概率阈值 0.7 偏高：模型开始漏拾它本来能拾对的道（漏拾 ' + M.miss.dl + ' 道）。</span>';
    if (state.pthr < 0.3) msg += '<br><span style="color:#8e5229">概率阈值 0.3 偏低：伪峰也会越过阈值，误拾 ' + M.big.dl + ' 道。</span>';
    document.getElementById('note').innerHTML = msg;
    document.getElementById('trTag').textContent = 'TRACE ' + state.hover;

    drawGather(); drawErr(); drawSingle();
  }

  var gEl = document.getElementById('gather');
  gEl.addEventListener('mousemove', function (e) {
    var r = gEl.getBoundingClientRect();
    var L = 34, R = 8, iw = r.width - L - R;
    var x = Math.floor(clamp((e.clientX - r.left - L) / iw, 0, 0.999) * NT);
    if (x !== state.hover) {
      state.hover = x;
      drawGather(); drawSingle();
      document.getElementById('trTag').textContent = 'TRACE ' + x;
    }
  });
  document.getElementById('noise').addEventListener('input', function (e) {
    state.noise = parseFloat(e.target.value); build(state.noise); pickAll(); paintImage(); refresh();
  });
  document.getElementById('pthr').addEventListener('input', function (e) {
    state.pthr = parseFloat(e.target.value); pickAll(); refresh();
  });
  document.getElementById('rthr').addEventListener('input', function (e) {
    state.rthr = parseFloat(e.target.value); pickAll(); refresh();
  });
  document.getElementById('showSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.show = b.getAttribute('data-show');
    [].forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
    paintImage(); drawGather(); drawErr();
  });

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt); rt = setTimeout(function () { paintImage(); drawGather(); drawErr(); drawSingle(); }, 140);
  });

  build(state.noise); pickAll(); paintImage(); refresh();
})();
