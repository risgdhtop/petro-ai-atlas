(function () {
  'use strict';

  var NT = 56, NS = 240;
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
  var rnd = mulberry32(20261106);
  function gauss() { return (rnd() + rnd() + rnd() - 1.5) * 1.15; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* ---------- 合成：有效反射 + 面波 ---------- */
  var clean = new Float32Array(NT * NS);
  var gr = new Float32Array(NT * NS);
  var EV = [[55, 0.0120, 1.00], [100, 0.0100, 0.80], [145, 0.0080, 0.62]];
  for (var x = 0; x < NT; x++) {
    for (var t = 0; t < NS; t++) {
      var v = 0;
      for (var e = 0; e < 3; e++) {
        var tk = EV[e][0] + EV[e][1] * x * x;
        var d = t - tk;
        if (d > -9 && d < 9) v += EV[e][2] * Math.cos(2 * Math.PI * 0.075 * d) * Math.exp(-d * d / 26);
      }
      clean[t * NT + x] = v;
      var tg = 12 + 4.0 * x;
      var dg = t - tg;
      gr[t * NT + x] = Math.exp(-dg * dg / (2 * 13 * 13)) * Math.cos(2 * Math.PI * 0.052 * dg) * Math.exp(-x / 55);
    }
  }

  var noisy = new Float32Array(NT * NS);
  var res = [new Float32Array(NT * NS), new Float32Array(NT * NS), new Float32Array(NT * NS), new Float32Array(NT * NS)];
  var state = { gr: 0.9, noise: 0.2, diff: 1 };

  /* ---------- 三种处理 ---------- */
  function movingAvg(arr, win) {
    var out = new Float32Array(arr.length), h = (win - 1) >> 1;
    for (var x = 0; x < NT; x++) {
      var pre = new Float64Array(NS + 1);
      for (var t = 0; t < NS; t++) pre[t + 1] = pre[t] + arr[t * NT + x];
      for (t = 0; t < NS; t++) {
        var a = Math.max(0, t - h), b = Math.min(NS, t + h + 1);
        out[t * NT + x] = (pre[b] - pre[a]) / (b - a);
      }
    }
    return out;
  }

  function build() {
    var x, t, i;
    for (i = 0; i < clean.length; i++) noisy[i] = clean[i] + state.gr * gr[i] + state.noise * gauss();
    /* 1) 带通：减去 21 点滑动平均（压制低频面波） */
    var ma = movingAvg(noisy, 13);
    for (i = 0; i < noisy.length; i++) res[1][i] = noisy[i] - ma[i] * 1.0;
    /* 2) 空间中值（5 道）：按振幅排序取中位 */
    var buf = new Float64Array(5);
    for (t = 0; t < NS; t++) {
      for (x = 0; x < NT; x++) {
        for (var d2 = -2; d2 <= 2; d2++) buf[d2 + 2] = noisy[t * NT + clamp(x + d2, 0, NT - 1)];
        var arr2 = Array.prototype.slice.call(buf).sort(function (p1, p2) { return p1 - p2; });
        res[2][t * NT + x] = arr2[2];
      }
    }
    /* 3) 理想：直接减去已知面波 */
    for (i = 0; i < noisy.length; i++) res[3][i] = noisy[i] - state.gr * gr[i];
    /* 原始 */
    for (i = 0; i < noisy.length; i++) res[0][i] = noisy[i];
  }

  /* ---------- 指标 ---------- */
  var M = [];
  function metrics() {
    M = [];
    for (var k = 0; k < 4; k++) {
      var se = 0, ss = 0, dot = 0, na = 0, nb = 0, dv = 0, dvb = 0;
      for (var i = 0; i < clean.length; i++) {
        var r = res[k][i] - clean[i];
        se += r * r; ss += clean[i] * clean[i];
        dot += res[k][i] * clean[i];
        na += res[k][i] * res[k][i]; nb += clean[i] * clean[i];
      }
      var snr = 10 * Math.log10(ss / (se + 1e-9));
      var fid = dot / Math.sqrt(na * nb + 1e-12);
      M.push({ snr: snr, fid: fid });
    }
  }

  /* ---------- 位图 ---------- */
  var cvs = [0, 1, 2, 3].map(function () { var c = document.createElement('canvas'); c.width = NT; c.height = NS; return c; });
  function mix(a, b, t) {
    return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
  }
  var MID = [251, 250, 246], POS = [34, 48, 56], NEG = [176, 191, 199];

  function paint(idx, arr, amax) {
    var c = cvs[idx].getContext('2d'), im = c.createImageData(NT, NS);
    for (var x = 0; x < NT; x++) {
      for (var t = 0; t < NS; t++) {
        var v = Math.tanh(arr[t * NT + x] / amax * 1.7);
        var col = v >= 0 ? mix(MID, POS, Math.pow(v, 0.8)) : mix(MID, NEG, Math.pow(-v, 0.8));
        var id = (t * NT + x) * 4;
        im.data[id] = col[0]; im.data[id + 1] = col[1]; im.data[id + 2] = col[2]; im.data[id + 3] = 255;
      }
    }
    c.putImageData(im, 0, 0);
  }

  /* ---------- 画布 ---------- */
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

  function drawOne(cvId, idx, label) {
    var cv = document.getElementById(cvId);
    var o = fit(cv, 1.55), ctx = o.ctx, W = o.W, H = o.H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.paper2; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(cvs[idx], 0, 0, W, H);
    /* 面波位置提示（原始图） */
    if (idx === 0) {
      ctx.strokeStyle = 'rgba(176,90,81,.75)'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      for (var x = 0; x < NT; x++) {
        var X = (x + 0.5) / NT * W, Y = (12 + 4.0 * x) / NS * H;
        if (x === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.strokeStyle = 'rgba(36,43,46,.18)'; ctx.strokeRect(.5, .5, W - 1, H - 1);
    ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
    ctx.fillText(label, 4, H - 4);
  }

  function drawBars() {
    var cv = document.getElementById('bars');
    var o = fit(cv, 1.75), ctx = o.ctx, W = o.W, H = o.H;
    var L = 74, R = 52, T = 14, B = 22, pw = W - L - R, bh = (H - T - B) / 4;
    ctx.clearRect(0, 0, W, H);
    var names = ['原始', '带通', '空间中值', '只减面波'];
    var colors = ['#9ba3a9', C.clay, C.jade, '#41699b'];
    /* SNR 轴：-4 .. 26 dB */
    var lo = -4, hi = 26;
    for (var i = 0; i < 4; i++) {
      var y = T + i * bh;
      ctx.fillStyle = C.ink3; ctx.font = '9px ui-monospace,Consolas,monospace';
      ctx.fillText(names[i], 4, y + bh * 0.55);
      var w0 = clamp((M[i].snr - lo) / (hi - lo), 0, 1) * pw;
      ctx.fillStyle = 'rgba(0,0,0,.05)'; ctx.fillRect(L, y + bh * 0.28, pw, bh * 0.42);
      ctx.fillStyle = colors[i];
      ctx.fillRect(L, y + bh * 0.28, w0, bh * 0.42);
      ctx.fillStyle = C.ink2; ctx.font = '9px ui-monospace,Consolas,monospace';
      ctx.fillText(M[i].snr.toFixed(1) + ' dB', L + pw + 4, y + bh * 0.55);
      ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
      ctx.fillText('保真 ' + M[i].fid.toFixed(2), L + 4, y + bh * 0.92);
    }
    ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
    ctx.fillText('SNR（dB）', L, H - 6);
  }

  function drawDiff() {
    var cv = document.getElementById('diff');
    var o = fit(cv, 1.55), ctx = o.ctx, W = o.W, H = o.H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.paper2; ctx.fillRect(0, 0, W, H);
    var k = state.diff;
    var c2 = document.createElement('canvas'); c2.width = NT; c2.height = NS;
    var im = c2.getContext('2d').createImageData(NT, NS);
    var amax = 0.001;
    for (var i = 0; i < res[k].length; i++) amax = Math.max(amax, Math.abs(res[k][i] - clean[i]));
    for (var x = 0; x < NT; x++) {
      for (var t = 0; t < NS; t++) {
        var v = (res[k][t * NT + x] - clean[t * NT + x]) / amax;
        var col = v >= 0 ? mix(MID, [176, 90, 81], Math.min(1, Math.abs(v))) : mix(MID, [65, 105, 155], Math.min(1, Math.abs(v)));
        var id = (t * NT + x) * 4;
        im.data[id] = col[0]; im.data[id + 1] = col[1]; im.data[id + 2] = col[2]; im.data[id + 3] = 255;
      }
    }
    c2.getContext('2d').putImageData(im, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(c2, 0, 0, W, H);
    ctx.strokeStyle = 'rgba(36,43,46,.18)'; ctx.strokeRect(.5, .5, W - 1, H - 1);
  }

  function update() {
    build();
    var amax = 0.001;
    for (var i = 0; i < noisy.length; i++) amax = Math.max(amax, Math.abs(res[0][i]));
    for (var k = 0; k < 4; k++) paint(k, res[k], amax);
    metrics();
    drawOne('c0', 0, 'ORIGINAL');
    drawOne('c1', 1, 'BAND-PASS');
    drawOne('c2', 2, 'SPATIAL MEDIAN');
    drawOne('c3', 3, 'GROUND-ROLL ONLY');
    drawBars();
    drawDiff();

    document.getElementById('grOut').textContent = state.gr.toFixed(2);
    document.getElementById('noiseOut').textContent = state.noise.toFixed(2);
    document.getElementById('hTag').textContent = 'GR ' + state.gr.toFixed(2) + ' · NOISE ' + state.noise.toFixed(2);
    document.getElementById('diffTag').textContent = 'ORIGINAL − ' + ['', 'BAND-PASS', 'SPATIAL MEDIAN', 'GR ONLY'][state.diff];
    for (k = 0; k < 4; k++) document.getElementById('ro' + k).textContent = M[k].snr.toFixed(1);
    document.getElementById('roFid').textContent =
      M[1].fid.toFixed(2) + ' / ' + M[2].fid.toFixed(2) + ' / ' + M[3].fid.toFixed(2);
    var note = document.getElementById('note');
    var g1 = M[1].snr - M[0].snr, g2 = M[2].snr - M[0].snr, g3 = M[3].snr - M[0].snr;
    var txt;
    if (state.gr < 0.4) {
      txt = '<b>面波弱：三种方法差别不大</b> 带通 +' + g1.toFixed(1) + ' dB，中值 +' + g2.toFixed(1) +
        ' dB，只减面波 +' + g3.toFixed(1) + ' dB。提升空间本来就小——方法再先进也没有用武之地。';
    } else if (state.gr < 1.2) {
      txt = '<b>面波强、随机噪声中等：方法差距拉开</b> 带通 +' + g1.toFixed(1) + ' dB（保真 ' + M[1].fid.toFixed(2) +
        '），五道中值 +' + g2.toFixed(1) + ' dB（保真 ' + M[2].fid.toFixed(2) + '）。中值明显更好，' +
        '因为它用了<b>空间</b>这一维：面波在相邻道上错开好几个采样，中值直接把它投掉；顺带还压了随机噪声。';
    } else {
      txt = '<b>面波很强：带通几乎失效</b> 带通 +' + g1.toFixed(1) + ' dB，中值 +' + g2.toFixed(1) +
        ' dB。带通的保真度掉到 ' + M[1].fid.toFixed(2) + '——它压掉面波的方式是把整段低频一起削掉，' +
        '有效波的低频成分跟着一起没了。这就是「只用一个维度」的代价。';
    }
    if (state.noise > 0.5) {
      txt += '<br><span style="color:#8e5229">随机噪声 0.5 以上：中值在压面波的同时也把随机噪声抹平，' +
        '代价是横向分辨率——陡倾角同相轴会变糊。</span>';
    }
    note.innerHTML = txt;
  }

  document.getElementById('gr').addEventListener('input', function (e) {
    state.gr = parseFloat(e.target.value); update();
  });
  document.getElementById('noise').addEventListener('input', function (e) {
    state.noise = parseFloat(e.target.value); update();
  });
  document.getElementById('diffSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.diff = parseInt(b.getAttribute('data-d'), 10);
    [].forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
    drawDiff();
    document.getElementById('diffTag').textContent = 'ORIGINAL − ' + ['', 'BAND-PASS', 'SPATIAL MEDIAN', 'GR ONLY'][state.diff];
  });

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt); rt = setTimeout(update, 140);
  });

  update();
})();
