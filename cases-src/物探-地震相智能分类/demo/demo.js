(function () {
  'use strict';

  var NX = 300, NZ = 160;
  var C = {
    ink: '#242b2e', ink2: '#4d565b', ink3: '#79828a', ink4: '#9ba3a9',
    line: '#e9e4d8', paper2: '#f5f2ea', jade: '#2f7d6b', clay: '#b26a39', bad: '#b05a51'
  };
  var CLS = [
    { name: '席状砂', short: '席状', color: '#2f7d6b' },
    { name: '河道砂', short: '河道', color: '#b26a39' },
    { name: '前积砂', short: '前积', color: '#41699b' },
    { name: '泥岩', short: '泥岩', color: '#8a8578' }
  ];

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var rnd = mulberry32(20261103);
  function gauss() { return (rnd() + rnd() + rnd() - 1.5) * 1.15; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function sig(u) { u = clamp(u, -6, 6); return 1 / (1 + Math.exp(-u)); }

  /* ---------- 四类相带的正演响应 ---------- */
  var RK = 13, rick = [];
  for (var k = -RK; k <= RK; k++) {
    var a1 = Math.PI * 0.15 * k, a2 = a1 * a1;
    rick.push((1 - 2 * a2) * Math.exp(-a2));
  }

  var BOUNDS = [72, 136, 208];
  var WID = 4.2;
  function weights(x) {
    var s = [], i;
    for (i = 0; i < 3; i++) s.push(sig((x - BOUNDS[i]) / WID));
    return [1 - s[0], s[0] - s[1], s[1] - s[2], s[2]];
  }

  /* 每类：一组层界面（间距、倾角、振幅、曲率） */
  /* 四类相带的差异体现在「层间距、振幅强弱、振幅调制」上，这正是地震相识别的实际依据 */
  var SPEC = [
    { gap: 9.0, z0: 10, dip: 0.020, amp: 0.88, curv: 0.0000, mod: 0.00 },  // 席状：均匀平行、强振幅
    { gap: 7.0, z0: 6, dip: 0.050, amp: 0.95, curv: 0.0000, mod: 0.55 },   // 河道：厚层、振幅忽强忽弱
    { gap: 10.6, z0: 4, dip: 0.075, amp: 0.80, curv: 0.0012, mod: 0.00 },  // 前积：层厚大、低角度前积
    { gap: 5.4, z0: 12, dip: 0.010, amp: 0.40, curv: 0.0000, mod: 0.00 }   // 泥岩：弱振幅、密集平行
  ];

  var clean = new Float32Array(NX * NZ);
  var clsRefl = [];
  for (var c = 0; c < 4; c++) clsRefl.push(new Float32Array(NX * NZ));

  for (c = 0; c < 4; c++) {
    var sp = SPEC[c];
    for (var x = 0; x < NX; x++) {
      for (var z = 0; z < NZ; z++) {
        var s = 0;
        for (var n = -1; n < 26; n++) {
          var zk = sp.z0 + n * sp.gap + sp.dip * x + sp.curv * (x - 140) * (x - 140) * 0.1 +
                   0.9 * Math.sin(x * 0.13 + z * 0.6);
          if (zk < -14 || zk > NZ + 14) continue;
          var dz = z - zk;
          if (dz > 3.4 || dz < -3.4) continue;
          s += sp.amp * (1 + sp.mod * Math.sin(z * 0.085)) * Math.exp(-dz * dz / 1.44);
        }
        clsRefl[c][z * NX + x] = s;
      }
    }
  }

  /* 混合 + 褶积 */
  var refl = new Float32Array(NX * NZ);
  for (x = 0; x < NX; x++) {
    var w = weights(x);
    for (z = 0; z < NZ; z++) {
      refl[z * NX + x] = w[0] * clsRefl[0][z * NX + x] + w[1] * clsRefl[1][z * NX + x] +
                         w[2] * clsRefl[2][z * NX + x] + w[3] * clsRefl[3][z * NX + x];
    }
  }

  var base = new Float32Array(NX * NZ);
  for (x = 0; x < NX; x++) {
    for (z = 0; z < NZ; z++) {
      var acc = 0;
      for (k = -RK; k <= RK; k++) {
        var zz = z - k;
        if (zz >= 0 && zz < NZ) acc += refl[zz * NX + x] * rick[k + RK];
      }
      base[z * NX + x] = acc;
    }
  }
  var mx = 0;
  for (var i = 0; i < base.length; i++) mx = Math.max(mx, Math.abs(base[i]));
  for (i = 0; i < base.length; i++) base[i] *= 0.92 / (mx || 1);

  /* 真值标签 */
  var truth = new Uint8Array(NX), truthW = [];
  var bndFlag = new Uint8Array(NX);
  for (x = 0; x < NX; x++) {
    var ww = weights(x), bi = 0;
    for (c = 1; c < 4; c++) if (ww[c] > ww[bi]) bi = c;
    truth[x] = bi; truthW.push(ww);
    for (c = 0; c < 3; c++) if (Math.abs(x - BOUNDS[c]) <= 5) bndFlag[x] = 1;
  }

  /* ---------- 分类器：与四类干净模板的相关系数 ---------- */
  var W0 = 52, W1 = 100;
  function windowVec(arr, x) {
    var out = new Float64Array(W1 - W0), m = 0, j;
    for (j = W0; j < W1; j++) { out[j - W0] = arr[j * NX + x]; m += out[j - W0]; }
    m /= (W1 - W0);
    var v = 0;
    for (j = 0; j < out.length; j++) { out[j] -= m; v += out[j] * out[j]; }
    v = Math.sqrt(v) || 1;
    for (j = 0; j < out.length; j++) out[j] /= v;
    return out;
  }
  /* 每类取 3 个原型（不同位置），等价于让分类器对相位漂移不敏感 */
  var TEMPL = [];
  [[16, 38, 58], [88, 104, 122], [148, 170, 194], [222, 250, 284]].forEach(function (arr, c) {
    arr.forEach(function (x) { TEMPL.push({ c: c, v: windowVec(base, x) }); });
  });

  var noisy = new Float32Array(NX * NZ);
  var probs = new Float32Array(NX * 4);
  var pred = new Uint8Array(NX);
  var ent = new Float32Array(NX);

  function classify(noise) {
    var sg = 0.10 + 0.85 * noise, j, q;
    for (i = 0; i < base.length; i++) noisy[i] = base[i] + sg * gauss();
    for (var x = 0; x < NX; x++) {
      var vec = windowVec(noisy, x), corr = [-9, -9, -9, -9];
      for (var t2 = 0; t2 < TEMPL.length; t2++) {
        var s = 0, tv = TEMPL[t2].v;
        for (j = 0; j < vec.length; j++) s += vec[j] * tv[j];
        if (s > corr[TEMPL[t2].c]) corr[TEMPL[t2].c] = s;
      }
      var mxc = Math.max.apply(null, corr);
      var sum = 0, pp = [];
      for (c = 0; c < 4; c++) { var e = Math.exp((corr[c] - mxc) / 0.12); pp.push(e); sum += e; }
      var best = 0;
      for (c = 0; c < 4; c++) {
        pp[c] /= sum; probs[x * 4 + c] = pp[c];
        if (pp[c] > pp[best]) best = c;
      }
      pred[x] = best;
      var H = 0;
      for (c = 0; c < 4; c++) if (pp[c] > 1e-6) H -= pp[c] * Math.log(pp[c]);
      ent[x] = H / Math.log(4);
    }
  }

  /* ---------- 位图 ---------- */
  var imgCv = document.createElement('canvas');
  imgCv.width = NX; imgCv.height = NZ;
  function mix(c1, c2, t) {
    return [Math.round(c1[0] + (c2[0] - c1[0]) * t), Math.round(c1[1] + (c2[1] - c1[1]) * t),
            Math.round(c1[2] + (c2[2] - c1[2]) * t)];
  }
  function paintImage() {
    var c = imgCv.getContext('2d'), im = c.createImageData(NX, NZ);
    var MID = [251, 250, 246], POS = [38, 52, 61], NEG = [176, 191, 199];
    for (var i = 0; i < noisy.length; i++) {
      var v = Math.tanh(noisy[i] * 1.8);
      var col = v >= 0 ? mix(MID, POS, Math.pow(v, 0.8)) : mix(MID, NEG, Math.pow(-v, 0.8));
      im.data[i * 4] = col[0]; im.data[i * 4 + 1] = col[1]; im.data[i * 4 + 2] = col[2]; im.data[i * 4 + 3] = 255;
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

  var secCv = document.getElementById('sec');
  var cmCv = document.getElementById('cm');
  var trCv = document.getElementById('trace');
  var state = { noise: 0.2, view: 'all', hover: 150 };

  function drawSection() {
    var o = fit(secCv, 1.62), ctx = o.ctx, W = o.W, H = o.H;
    var L = 24, T = 8, R = 8, B = 58;
    var iw = W - L - R, ih = H - T - B;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.paper2; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(imgCv, L, T, iw, ih);
    if (state.view === 'err') {
      ctx.fillStyle = 'rgba(251,250,246,.62)'; ctx.fillRect(L, T, iw, ih);
      for (var x = 0; x < NX; x++) {
        if (pred[x] === truth[x]) continue;
        ctx.fillStyle = 'rgba(176,90,81,.38)';
        ctx.fillRect(L + x * iw / NX, T, iw / NX + 0.8, ih);
      }
    }
    /* 真实边界虚线 */
    ctx.save();
    ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(47,125,107,.55)'; ctx.lineWidth = 1;
    for (var b = 0; b < BOUNDS.length; b++) {
      var X = L + BOUNDS[b] * iw / NX;
      ctx.beginPath(); ctx.moveTo(X, T); ctx.lineTo(X, T + ih); ctx.stroke();
    }
    ctx.restore();

    /* 两条色带 */
    var sx = iw / NX, y1 = T + ih + 12, hh = 12;
    ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
    ctx.fillText('真值', 1, y1 + 9);
    ctx.fillText('预测', 1, y1 + 26);
    for (x = 0; x < NX; x++) {
      ctx.fillStyle = CLS[truth[x]].color;
      ctx.fillRect(L + x * sx, y1, sx + 0.6, hh);
      ctx.fillStyle = CLS[pred[x]].color;
      ctx.fillRect(L + x * sx, y1 + 15, sx + 0.6, hh);
      if (pred[x] !== truth[x]) {
        ctx.fillStyle = 'rgba(176,90,81,.85)';
        ctx.fillRect(L + x * sx, y1 + 15 + hh, sx + 0.6, 2.4);
      }
    }
    /* 轴 */
    ctx.fillStyle = C.ink4;
    for (var t = 0; t <= 300; t += 60) {
      var X2 = L + (t / NX) * iw;
      ctx.fillRect(X2, T + ih, 1, 3);
      if (t % 60 === 0) ctx.fillText(String(t), Math.min(X2 - 5, W - 20), y1 + 42);
    }
    ctx.fillText('CDP', W - 26, y1 + 42);
    ctx.strokeStyle = C.line; ctx.strokeRect(L - .5, T - .5, iw + 1, ih + 1);

    /* 悬停线 */
    var hx = L + state.hover * sx;
    ctx.strokeStyle = 'rgba(36,43,46,.55)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, T - 3); ctx.lineTo(hx, y1 + 27); ctx.stroke();
    ctx.fillStyle = C.ink2; ctx.fillRect(hx - 1, T - 3, 2, 4);
  }

  function drawCM() {
    var o = fit(cmCv, 1.42), ctx = o.ctx, W = o.W, H = o.H;
    ctx.clearRect(0, 0, W, H);
    var m = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (var x = 0; x < NX; x++) m[truth[x]][pred[x]]++;
    var rows = m.map(function (r) { return r.reduce(function (a, b) { return a + b; }, 0) || 1; });
    var cw = Math.min((W - 62) / 4, (H - 34) / 4), x0 = 54, y0 = 18;
    ctx.font = '8px ui-monospace,Consolas,monospace';
    for (var j = 0; j < 4; j++) {
      ctx.fillStyle = C.ink3;
      ctx.fillText(CLS[j].short, x0 + j * cw + cw / 2 - 8, y0 - 6);
      ctx.fillStyle = C.ink4;
      ctx.fillText(CLS[j].short, 6, y0 + j * cw + cw / 2 + 3);
    }
    for (var i2 = 0; i2 < 4; i2++) {
      for (j = 0; j < 4; j++) {
        var pct = m[i2][j] / rows[i2] * 100;
        var al = Math.pow(pct / 100, 0.75);
        ctx.fillStyle = i2 === j ? 'rgba(47,125,107,' + (0.10 + al * 0.82) + ')'
                                 : 'rgba(176,90,81,' + (0.06 + al * 0.80) + ')';
        ctx.fillRect(x0 + j * cw + 1.5, y0 + i2 * cw + 1.5, cw - 3, cw - 3);
        ctx.fillStyle = pct > 42 ? '#fff' : C.ink3;
        ctx.fillText(pct.toFixed(0), x0 + j * cw + cw / 2 - 5, y0 + i2 * cw + cw / 2 + 3);
      }
    }
    ctx.fillStyle = C.ink4;
    ctx.fillText('行 = 真实 · 列 = 预测 · 单位 %', 6, H - 3);
  }

  function drawTrace() {
    var o = fit(trCv, 1.42), ctx = o.ctx, W = o.W, H = o.H;
    ctx.clearRect(0, 0, W, H);
    var x = state.hover;
    var L = 6, T = 8, wf = Math.min(W * 0.42, 150), ih = H - 26;
    /* 波形 */
    ctx.strokeStyle = C.line; ctx.strokeRect(L - .5, T - .5, wf + 1, ih + 1);
    ctx.beginPath();
    var midX = L + wf / 2, amp = wf * 0.46, vmax = 0, j;
    for (j = W0; j < W1; j++) vmax = Math.max(vmax, Math.abs(noisy[j * NX + x]));
    vmax = vmax || 1;
    for (j = W0; j < W1; j++) {
      var yy = T + (j - W0) / (W1 - W0) * ih;
      var xx = midX + noisy[j * NX + x] / vmax * amp;
      if (j === W0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
    }
    ctx.strokeStyle = C.ink2; ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = 'rgba(36,43,46,.18)';
    ctx.beginPath(); ctx.moveTo(midX, T); ctx.lineTo(midX, T + ih); ctx.stroke();

    /* 四类概率条 */
    var bx = L + wf + 18, bw = W - bx - 34;
    ctx.font = '9px ui-monospace,Consolas,monospace';
    for (var c = 0; c < 4; c++) {
      var p = probs[x * 4 + c], by = T + 4 + c * 17;
      ctx.fillStyle = C.ink3;
      ctx.fillText(CLS[c].short, bx - 30, by + 7);
      ctx.fillStyle = 'rgba(0,0,0,.06)';
      ctx.fillRect(bx, by, bw, 8);
      ctx.fillStyle = CLS[c].color;
      ctx.fillRect(bx, by, bw * p, 8);
      ctx.fillStyle = C.ink2;
      ctx.fillText(p.toFixed(2), bx + bw + 4, by + 7);
    }
    /* 真值 / 预测 / 熵 */
    ctx.fillStyle = C.ink4;
    ctx.font = '8px ui-monospace,Consolas,monospace';
    ctx.fillText('真值 ' + CLS[truth[x]].name + ' · 预测 ' + CLS[pred[x]].name +
      ' · 熵 ' + ent[x].toFixed(2), L, H - 4);
    ctx.fillStyle = pred[x] === truth[x] ? '#3f8560' : '#b05a51';
    ctx.fillText(pred[x] === truth[x] ? '正确' : '错分', L + wf - 18, H - 4);
  }

  /* ---------- 指标与文案 ---------- */
  function update() {
    classify(state.noise);
    paintImage();
    var ok = 0, bad = 0, bo = 0, bt = 0, es = 0;
    for (var x = 0; x < NX; x++) {
      if (pred[x] === truth[x]) ok++; else bad++;
      if (bndFlag[x]) { bt++; if (pred[x] === truth[x]) bo++; }
      es += ent[x];
    }
    var acc = ok / NX, bacc = bt ? bo / bt : 0;
    document.getElementById('noiseOut').textContent = state.noise.toFixed(2);
    document.getElementById('hzTag').textContent = 'NOISE ' + state.noise.toFixed(2);
    document.getElementById('roAcc').textContent = acc.toFixed(3);
    document.getElementById('roBnd').textContent = bacc.toFixed(3);
    document.getElementById('roErr').textContent = String(bad);
    document.getElementById('roEnt').textContent = (es / NX).toFixed(2);
    var a = document.getElementById('roAcc').parentNode;
    a.className = 'ro ' + (acc > 0.9 ? 'good' : acc < 0.72 ? 'bad' : '');
    var b = document.getElementById('roBnd').parentNode;
    b.className = 'ro ' + (bacc > 0.8 ? 'good' : bacc < 0.55 ? 'bad' : '');

    var note = document.getElementById('note');
    var msg;
    if (state.noise < 0.22) {
      msg = '<b>噪声 ' + state.noise.toFixed(2) + '：几乎全对</b> 总体准确率 ' + acc.toFixed(3) +
        '，错的道只有 ' + bad + ' 条。但注意边界带准确率仍只有 ' + bacc.toFixed(3) +
        '——干净数据下错误也已经全部堆在相带边界上。';
    } else if (state.noise < 0.6) {
      msg = '<b>噪声 ' + state.noise.toFixed(2) + '：边界先崩</b> 总体准确率 ' + acc.toFixed(3) +
        '，边界带掉到 ' + bacc.toFixed(3) + '。' + bad + ' 条错道几乎都贴着三条相带边界，' +
        '因为那里的波形是两类响应的混合，与任何一类模板都不像。';
    } else {
      msg = '<b>噪声 ' + state.noise.toFixed(2) + '：整段误判</b> 总体准确率 ' + acc.toFixed(3) +
        '，边界带 ' + bacc.toFixed(3) + '。高噪声下河道与前积开始互相吞并（见混淆矩阵非对角），' +
        '此时再调分类器意义不大——该做的是提高信噪比，或者直接把这些道交给人工。';
    }
    if (state.view === 'err') msg += '<br><span style="color:#8e5229">当前视图只显示判错的道：它们聚成几条窄带，而不是随机散布。</span>';
    note.innerHTML = msg;

    drawSection(); drawCM(); drawTrace();
    document.getElementById('cdpTag').textContent = 'CDP ' + state.hover;
  }

  var secEl = document.getElementById('sec');
  secEl.addEventListener('mousemove', function (e) {
    var r = secEl.getBoundingClientRect();
    var L = 24, R = 8, iw = r.width - L - R;
    var x = Math.round(clamp((e.clientX - r.left - L) / iw, 0, 1) * NX);
    if (x !== state.hover) { state.hover = x; drawSection(); drawTrace(); document.getElementById('cdpTag').textContent = 'CDP ' + x; }
  });
  document.getElementById('noise').addEventListener('input', function (e) {
    state.noise = parseFloat(e.target.value); update();
  });
  document.getElementById('viewSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.view = b.getAttribute('data-view');
    [].forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
    drawSection();
  });

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { update(); }, 140);
  });

  update();
})();
