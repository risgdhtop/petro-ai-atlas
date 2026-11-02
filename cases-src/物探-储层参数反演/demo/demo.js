(function () {
  'use strict';

  var NX = 260, NZ = 150;
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
  var rnd = mulberry32(20261105);
  function gauss() { return (rnd() + rnd() + rnd() - 1.5) * 1.15; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* ---------- 1. 真实孔隙度 ---------- */
  var phi = new Float32Array(NX * NZ);
  for (var x = 0; x < NX; x++) {
    for (var z = 0; z < NZ; z++) {
      var base = 0.075 + 0.012 * Math.sin(x * 0.021 + 1.1) + 0.009 * Math.cos(z * 0.045);
      var zc = 52 + 24 * Math.sin(x * 0.019 + 0.6);
      var ch = 0.145 * Math.exp(-(z - zc) * (z - zc) / (2 * 7.5 * 7.5)) * (x > 14 && x < 246 ? 1 : 0.35);
      var zc2 = 108 + 9 * Math.sin(x * 0.045 + 2.2);
      var ch2 = 0.080 * Math.exp(-(z - zc2) * (z - zc2) / (2 * 4.2 * 4.2)) * (x > 40 && x < 220 ? 1 : 0.2);
      var dx = x - 182, dz = z - 104;
      var lobe = 0.100 * Math.exp(-(dx * dx + dz * dz) / (2 * 17 * 17));
      phi[z * NX + x] = clamp(base + ch + ch2 + lobe + 0.005 * gauss(), 0.02, 0.31);
    }
  }

  /* ---------- 2. 正演：阻抗 → 反射系数 → 褶积 ---------- */
  var imp = new Float32Array(NX * NZ);
  for (var i = 0; i < phi.length; i++) imp[i] = 9.2 - 14.0 * phi[i];

  var refl = new Float32Array(NX * NZ);
  for (x = 0; x < NX; x++) {
    for (z = 1; z < NZ - 1; z++) {
      var z1 = imp[(z - 1) * NX + x], z2 = imp[(z + 1) * NX + x];
      refl[z * NX + x] = 0.5 * (z2 - z1) / (z2 + z1 + 1e-6);
    }
  }
  var RK = 11, rick = [];
  for (var k = -RK; k <= RK; k++) {
    var a1 = Math.PI * 0.14 * k, a2 = a1 * a1;
    rick.push((1 - 2 * a2) * Math.exp(-a2));
  }
  var syn = new Float32Array(NX * NZ);
  for (x = 0; x < NX; x++) {
    for (z = 0; z < NZ; z++) {
      var acc = 0;
      for (k = -RK; k <= RK; k++) {
        var zz = z - k;
        if (zz >= 0 && zz < NZ) acc += refl[zz * NX + x] * rick[k + RK];
      }
      syn[z * NX + x] = acc;
    }
  }
  var mx = 0;
  for (i = 0; i < syn.length; i++) mx = Math.max(mx, Math.abs(syn[i]));
  for (i = 0; i < syn.length; i++) syn[i] = syn[i] / (mx || 1) * 0.9;

  var seis = new Float32Array(NX * NZ);
  var hf = new Float32Array(NX * NZ);
  var zlow = new Float32Array(NX * NZ);
  var attr = new Float32Array(NX * NZ);

  /* ---------- 3. 观测记录 + 道积分高频 ---------- */
  function buildSeismic(noise) {
    var sg = 0.004 + 0.055 * noise, x, z;
    for (i = 0; i < syn.length; i++) seis[i] = syn[i] + sg * gauss();
    var W = 55;
    for (x = 0; x < NX; x++) {
      var cum = 0, arr = new Float64Array(NZ);
      for (z = 0; z < NZ; z++) { cum += seis[z * NX + x] * 0.6; arr[z] = cum; }
      var pre = new Float64Array(NZ + 1);
      for (z = 0; z < NZ; z++) pre[z + 1] = pre[z] + arr[z];
      for (z = 0; z < NZ; z++) {
        var a = Math.max(0, z - W), b = Math.min(NZ, z + W);
        var mean = (pre[b] - pre[a]) / (b - a);
        hf[z * NX + x] = arr[z] - mean;
      }
    }
  }

  /* ---------- 4. 井、低频模型 ---------- */
  var JIT = [3, -2, 4, -4, 1, -3, 2, -1, 3, -2, 4, -3];
  var wellX = [];
  function makeWells(n) {
    wellX = [];
    for (var i = 0; i < n; i++) {
      var base = n === 1 ? NX * 0.3 : 14 + i * (NX * 0.82 - 28) / (n - 1);
      wellX.push(Math.round(clamp(base + JIT[i % 12], 2, NX - 3)));
    }
  }

  function buildLowModel(wells) {
    var nb = wells.length, prof = [], wlen = 2, w, z;
    for (w = 0; w < nb; w++) {
      var col = wells[w], arr = new Float32Array(NZ);
      for (z = 0; z < NZ; z++) {
        var acc2 = 0, cnt = 0;
        for (var d = -wlen; d <= wlen; d++) {
          var zz = clamp(z + d, 0, NZ - 1);
          acc2 += imp[zz * NX + col]; cnt++;
        }
        arr[z] = acc2 / cnt;
      }
      prof.push(arr);
    }
    for (var x = 0; x < NX; x++) {
      var lo = -1, hi = -1;
      for (w = 0; w < nb; w++) {
        if (wells[w] <= x) lo = w;
        if (wells[w] >= x && hi < 0) hi = w;
      }
      if (lo < 0) lo = 0;
      if (hi < 0) hi = nb - 1;
      var u = lo === hi ? 0 : (x - wells[lo]) / (wells[hi] - wells[lo]);
      u = clamp(u, 0, 1);
      for (z = 0; z < NZ; z++) {
        zlow[z * NX + x] = prof[lo][z] * (1 - u) + prof[hi][z] * u;
      }
    }
  }

  function buildAttr() {
    var m = 0, n = attr.length, i2;
    /* 高频分量的振幅标定系数：使积分结果只对低频模型做 ±18% 的修正 */
    var hm = 0, hv = 0;
    for (i2 = 0; i2 < n; i2++) hm += hf[i2];
    hm /= n;
    for (i2 = 0; i2 < n; i2++) hv += (hf[i2] - hm) * (hf[i2] - hm);
    var hsd = Math.sqrt(hv / n) || 1;
    var k = 0.10 / hsd;
    for (var i = 0; i < n; i++) { attr[i] = zlow[i] * (1 + k * (hf[i] - hm)); m += attr[i]; }
    m /= n;
    var v = 0;
    for (i = 0; i < n; i++) v += (attr[i] - m) * (attr[i] - m);
    var sd = Math.sqrt(v / n) || 1;
    for (i = 0; i < n; i++) attr[i] = (attr[i] - m) / sd;
  }

  /* ---------- 5. 回归与预测 ---------- */
  function fitOn(wells) {
    var sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
    for (var w = 0; w < wells.length; w++) {
      var wx = wells[w];
      for (var z = 2; z < NZ - 2; z += 2) {
        var a = attr[z * NX + wx], p = phi[z * NX + wx];
        sx += a; sy += p; sxx += a * a; sxy += a * p; n++;
      }
    }
    var den = n * sxx - sx * sx;
    var b = den ? (n * sxy - sx * sy) / den : 0;
    return { a: (sy - b * sx) / (n || 1), b: b, n: n };
  }
  function predictAt(model, ai) { return clamp(model.a + model.b * ai, 0.015, 0.36); }

  var predMap = new Float32Array(NX * NZ);
  var resMap = new Float32Array(NX * NZ);

  function fillPred(model) {
    var sse = 0, sst = 0, mean = 0, n = phi.length;
    for (var i = 0; i < n; i++) mean += phi[i];
    mean /= n;
    for (i = 0; i < n; i++) {
      var p = predictAt(model, attr[i]);
      predMap[i] = p; resMap[i] = p - phi[i];
      sse += (p - phi[i]) * (p - phi[i]);
      sst += (phi[i] - mean) * (phi[i] - mean);
    }
    return 1 - sse / (sst || 1);
  }

  /* ---------- 6. 位图 ---------- */
  function mix(c1, c2, t) {
    return [Math.round(c1[0] + (c2[0] - c1[0]) * t), Math.round(c1[1] + (c2[1] - c1[1]) * t),
            Math.round(c1[2] + (c2[2] - c1[2]) * t)];
  }
  var PHI_LO = [247, 244, 234], PHI_HI = [26, 104, 87];
  var S_POS = [38, 52, 61], S_NEG = [176, 191, 199], S_MID = [251, 250, 246];
  function makeCv(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  var cvTrue = makeCv(NX, NZ), cvSeis = makeCv(NX, NZ), cvPred = makeCv(NX, NZ), cvRes = makeCv(NX, NZ);

  function paintPhi(cv, arr) {
    var c = cv.getContext('2d'), im = c.createImageData(NX, NZ);
    for (var i = 0; i < arr.length; i++) {
      var t = clamp((arr[i] - 0.045) / 0.17, 0, 1);
      var col = mix(PHI_LO, PHI_HI, Math.pow(t, 0.85));
      im.data[i * 4] = col[0]; im.data[i * 4 + 1] = col[1]; im.data[i * 4 + 2] = col[2]; im.data[i * 4 + 3] = 255;
    }
    c.putImageData(im, 0, 0);
  }
  function paintSeis() {
    var c = cvSeis.getContext('2d'), im = c.createImageData(NX, NZ);
    for (var i = 0; i < seis.length; i++) {
      var v = Math.tanh(seis[i] * 2.2);
      var col = v >= 0 ? mix(S_MID, S_POS, Math.pow(v, 0.8)) : mix(S_MID, S_NEG, Math.pow(-v, 0.8));
      im.data[i * 4] = col[0]; im.data[i * 4 + 1] = col[1]; im.data[i * 4 + 2] = col[2]; im.data[i * 4 + 3] = 255;
    }
    c.putImageData(im, 0, 0);
  }
  function paintRes() {
    var c = cvRes.getContext('2d'), im = c.createImageData(NX, NZ);
    for (var i = 0; i < resMap.length; i++) {
      var v = clamp(resMap[i] / 0.05, -1, 1);
      var col = v >= 0 ? mix([251, 250, 246], [176, 90, 81], Math.abs(v)) : mix([251, 250, 246], [65, 105, 155], Math.abs(v));
      im.data[i * 4] = col[0]; im.data[i * 4 + 1] = col[1]; im.data[i * 4 + 2] = col[2]; im.data[i * 4 + 3] = 255;
    }
    c.putImageData(im, 0, 0);
  }

  /* ---------- 7. 画布 ---------- */
  function fit(cv, aspect) {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = cv.clientWidth || 200;
    var h = Math.round(w / aspect);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.height = h + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, W: w, H: h };
  }

  var state = { wells: 6, noise: 0.2, view: 'map' };
  var curveData = [];

  function drawMap(cv, img, far) {
    var o = fit(cv, NX / NZ), ctx = o.ctx, W = o.W, H = o.H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.paper2; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, 0, 0, W, H);
    if (far) {
      for (var i = 0; i < NX; i++) {
        var dmin = 1e9;
        for (var w = 0; w < wellX.length; w++) dmin = Math.min(dmin, Math.abs(i - wellX[w]));
        if (dmin > 34) {
          ctx.fillStyle = 'rgba(176,90,81,.10)';
          ctx.fillRect(i / NX * W, 0, W / NX + 1, H);
        }
      }
    }
    for (i = 0; i < wellX.length; i++) {
      var X = wellX[i] / NX * W;
      ctx.strokeStyle = 'rgba(178,106,57,.9)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(X, 0); ctx.lineTo(X, H); ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(X, 6, 3, 0, 6.2832); ctx.fill();
      ctx.fillStyle = C.clay;
      ctx.beginPath(); ctx.arc(X, 6, 1.6, 0, 6.2832); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(36,43,46,.18)'; ctx.lineWidth = 1;
    ctx.strokeRect(.5, .5, W - 1, H - 1);
  }

  function drawScatter() {
    var cv = document.getElementById('scatter');
    var o = fit(cv, 1.9), ctx = o.ctx, W = o.W, H = o.H;
    var L = 34, R = 10, T = 12, B = 26, pw = W - L - R, ph = H - T - B;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var Y = T + ph * g / 4;
      ctx.beginPath(); ctx.moveTo(L, Y + .5); ctx.lineTo(L + pw, Y + .5); ctx.stroke();
    }
    var A0 = -2.8, A1 = 2.8, P0 = 0.02, P1 = 0.30;
    function px(a) { return L + (a - A0) / (A1 - A0) * pw; }
    function py(p) { return T + ph - (p - P0) / (P1 - P0) * ph; }
    for (var w = 0; w < wellX.length; w++) {
      for (var z = 2; z < NZ - 2; z += 2) {
        ctx.fillStyle = 'rgba(47,125,107,.40)';
        ctx.beginPath(); ctx.arc(px(attr[z * NX + wellX[w]]), py(phi[z * NX + wellX[w]]), 1.6, 0, 6.2832); ctx.fill();
      }
    }
    var model = fitOn(wellX);
    ctx.beginPath();
    ctx.moveTo(px(A0), py(clamp(model.a + model.b * A0, P0, P1)));
    ctx.lineTo(px(A1), py(clamp(model.a + model.b * A1, P0, P1)));
    ctx.strokeStyle = C.clay; ctx.lineWidth = 1.8; ctx.stroke();
    ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
    ctx.fillText('φ', 6, T + 4);
    ctx.fillText('相对阻抗（标准差）', L + pw / 2 - 40, H - 4);
    ctx.fillStyle = C.clay;
    ctx.fillText('φ = ' + model.a.toFixed(3) + (model.b < 0 ? ' − ' : ' + ') + Math.abs(model.b).toFixed(3) + '·a',
      L + 6, H - 4);
  }

  function drawCurve() {
    var cv = document.getElementById('curve');
    var o = fit(cv, 4.4), ctx = o.ctx, W = o.W, H = o.H;
    var L = 36, R = 12, T = 8, B = 18, pw = W - L - R, ph = H - T - B;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var Y = T + ph * g / 4;
      ctx.beginPath(); ctx.moveTo(L, Y + .5); ctx.lineTo(L + pw, Y + .5); ctx.stroke();
      ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
      ctx.fillText((1 - g / 4).toFixed(1), 4, Y + 3);
    }
    if (!curveData.length) return;
    var n0 = 2, n1 = 12;
    function px(n) { return L + (n - n0) / (n1 - n0) * pw; }
    function py(v) { return T + ph - v * ph; }
    ctx.beginPath();
    for (var i = 0; i < curveData.length; i++) {
      var X = px(curveData[i][0]), Y = py(curveData[i][1]);
      if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
    ctx.strokeStyle = C.jade; ctx.lineWidth = 1.8; ctx.stroke();
    for (i = 0; i < curveData.length; i++) {
      var cur = curveData[i][0] === state.wells;
      ctx.fillStyle = cur ? '#fff' : C.jade;
      ctx.strokeStyle = C.jade; ctx.lineWidth = cur ? 2 : 1;
      ctx.beginPath(); ctx.arc(px(curveData[i][0]), py(curveData[i][1]), cur ? 4.2 : 2.4, 0, 6.2832);
      ctx.fill(); if (cur) ctx.stroke();
    }
    ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
    ctx.fillText('井数 →', L + pw - 30, H - 4);
    ctx.fillText('R²', 4, T - 1);
    ctx.fillText('2', L - 3, H - 6);
    ctx.fillText('12', L + pw - 8, H - 6);
  }

  /* ---------- 8. 指标 ---------- */
  function metrics() {
    var model = fitOn(wellX);
    var r2 = fillPred(model);
    var blind = 0, nb = 0, w, z;
    for (w = 0; w < wellX.length; w++) {
      var others = wellX.filter(function (v, i) { return i !== w; });
      if (!others.length) continue;
      var savedLow = zlow.slice(), savedAttr = attr.slice();
      buildLowModel(others);
      buildAttr();
      var m2 = fitOn(others);
      for (z = 4; z < NZ - 4; z += 2) {
        var p = predictAt(m2, attr[z * NX + wellX[w]]);
        blind += (p - phi[z * NX + wellX[w]]) * (p - phi[z * NX + wellX[w]]);
        nb++;
      }
      zlow.set(savedLow); attr.set(savedAttr);
    }
    blind = Math.sqrt(blind / (nb || 1));
    var fe = 0, fn = 0, trust = 0;
    for (var x = 0; x < NX; x++) {
      var dmin = 1e9;
      for (w = 0; w < wellX.length; w++) dmin = Math.min(dmin, Math.abs(x - wellX[w]));
      for (z = 0; z < NZ; z += 2) {
        if (dmin <= 34) { trust++; continue; }
        fe += (predMap[z * NX + x] - phi[z * NX + x]) * (predMap[z * NX + x] - phi[z * NX + x]);
        fn++;
      }
    }
    return { r2: r2, blind: blind, far: Math.sqrt(fe / (fn || 1)), trust: trust / (trust + fn) };
  }

  function buildCurve() {
    curveData = [];
    var keep = wellX.slice();
    for (var n = 2; n <= 12; n++) {
      makeWells(n);
      buildLowModel(wellX);
      buildAttr();
      var m = fitOn(wellX);
      curveData.push([n, Math.max(0, fillPred(m))]);
    }
    wellX = keep;
    buildLowModel(wellX);
    buildAttr();
  }

  function refresh(full) {
    if (full) { buildSeismic(state.noise); paintSeis(); paintPhi(cvTrue, phi); }
    var model = fitOn(wellX);
    fillPred(model);
    paintPhi(cvPred, predMap);
    paintRes();
    drawMap(document.getElementById('ct'), cvTrue, false);
    drawMap(document.getElementById('cs'), state.view === 'res' ? cvRes : cvSeis, false);
    drawMap(document.getElementById('cp'), state.view === 'res' ? cvRes : cvPred, true);
    document.getElementById('obsTitle').textContent = state.view === 'res' ? '反演残差（预测 − 真实）' : '地震振幅（观测）';
    document.getElementById('obsSub').textContent = state.view === 'res' ? 'RESIDUAL' : 'SEISMIC';
    drawScatter();
    drawCurve();

    var m = metrics();
    document.getElementById('wellsOut').textContent = state.wells;
    document.getElementById('noiseOut').textContent = state.noise.toFixed(2);
    document.getElementById('wTag').textContent = 'WELLS ' + state.wells;
    document.getElementById('roR2').textContent = m.r2.toFixed(2);
    document.getElementById('roRmse').textContent = m.blind.toFixed(3);
    document.getElementById('roFar').textContent = m.far.toFixed(3);
    document.getElementById('roTrust').textContent = (m.trust * 100).toFixed(0) + '%';
    var a = document.getElementById('roR2').parentNode;
    a.className = 'ro ' + (m.r2 > 0.6 ? 'good' : m.r2 < 0.35 ? 'bad' : '');
    var b = document.getElementById('roRmse').parentNode;
    b.className = 'ro ' + (m.blind < 0.03 ? 'good' : m.blind > 0.05 ? 'bad' : '');

    var txt;
    if (state.wells <= 3) {
      txt = '<b>' + state.wells + ' 口井：低频模型几乎是猜的</b> R² ' + m.r2.toFixed(2) +
        '，盲井 RMSE ' + m.blind.toFixed(3) + '。注意反演图：横向出现明显的「拼接感」——' +
        '两口井之间的低频模型是一条直线，真实的地层起伏被拉平了。';
    } else if (state.wells <= 8) {
      txt = '<b>' + state.wells + ' 口井：进入可用区间</b> R² ' + m.r2.toFixed(2) + '，盲井 RMSE ' +
        m.blind.toFixed(3) + '（约 ' + (m.blind * 100).toFixed(0) + ' 个孔隙度单位）。' +
        '右侧红色区域是离井 &gt; 2 km 的外推区，那里的误差是井控区的 ' +
        (m.far / Math.max(m.blind, 1e-4)).toFixed(1) + ' 倍。';
    } else {
      txt = '<b>' + state.wells + ' 口井：边际收益已经很小</b> R² ' + m.r2.toFixed(2) + '，盲井 RMSE ' +
        m.blind.toFixed(3) + '。井控曲线在 8 口附近变平——继续加密井网，不如换一个更好的属性，' +
        '或者把低频模型做对。';
    }
    if (state.noise > 0.7) {
      txt += '<br><span style="color:#8e5229">噪声 0.7 以上：道积分把噪声也积起来了，属性本身被污染，加井救不回来。</span>';
    }
    document.getElementById('note').innerHTML = txt;
  }

  /* ---------- 9. 交互 ---------- */
  document.getElementById('wells').addEventListener('input', function (e) {
    state.wells = parseInt(e.target.value, 10);
    makeWells(state.wells);
    buildLowModel(wellX);
    buildAttr();
    buildCurve();
    refresh(false);
  });
  document.getElementById('noise').addEventListener('input', function (e) {
    state.noise = parseFloat(e.target.value);
    buildSeismic(state.noise);
    paintSeis();
    buildCurve();
    refresh(true);
  });
  document.getElementById('viewSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.view = b.getAttribute('data-view');
    [].forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
    refresh(false);
  });

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt); rt = setTimeout(function () { refresh(false); }, 140);
  });

  buildSeismic(state.noise);
  paintSeis();
  paintPhi(cvTrue, phi);
  makeWells(state.wells);
  buildLowModel(wellX);
  buildAttr();
  buildCurve();
  refresh(true);
})();
