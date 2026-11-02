(function () {
  'use strict';

  var N = 360, T0 = 250, T1 = T0 - 40;  /* 前兆先于事故出现 */
  var C = {
    ink: '#242b2e', ink2: '#4d565b', ink3: '#79828a', ink4: '#9ba3a9',
    line: '#e9e4d8', paper2: '#f5f2ea', jade: '#2f7d6b', clay: '#b26a39', bad: '#b05a51'
  };
  var CH = [
    { name: '立管压力', unit: 'MPa', base: 18.2, sd: 0.12, color: '#2f7d6b', dec: 1 },
    { name: '返出流量', unit: '%', base: 100, sd: 1.0, color: '#41699b', dec: 0 },
    { name: '池体积', unit: 'm³', base: 120, sd: 0.32, color: '#b26a39', dec: 1 },
    { name: '总烃', unit: '%', base: 0.25, sd: 0.045, color: '#7e5a8d', dec: 2 },
    { name: '扭矩', unit: 'kN·m', base: 12, sd: 0.28, color: '#767a2e', dec: 1 }
  ];

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var rnd = mulberry32(20261107);
  function gauss() { return (rnd() + rnd() + rnd() - 1.5) * 1.15; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function ramp(u, a, b) {
    var x = clamp((u - a) / (b - a), 0, 1);
    return x * x * (3 - 2 * x);
  }

  /* ---------- 场景 ---------- */
  function anomaly(scn, ch, u) {
    var v = 0;
    if (u < 0) return 0;
    if (scn === 'kick') {
      if (ch === 0) v = 1.10 * ramp(u, 0, 10) - 1.00 * ramp(u, 16, 44);
      if (ch === 1) v = 8.5 * ramp(u, 0, 30);
      if (ch === 2) v = 6.2 * ramp(u, 0, 36);
      if (ch === 3) v = 3.1 * ramp(u, 0, 26);
      if (ch === 4) v = 0.5 * ramp(u, 0, 34);
    } else if (scn === 'loss') {
      if (ch === 0) v = -1.35 * ramp(u, 0, 30);
      if (ch === 1) v = -9.0 * ramp(u, 0, 32);
      if (ch === 2) v = -8.0 * ramp(u, 0, 38);
      if (ch === 3) v = 0.03 * ramp(u, 0, 30);
      if (ch === 4) v = -0.4 * ramp(u, 0, 30);
    } else {
      if (ch === 0) v = 1.75 * ramp(u, 0, 18);
      if (ch === 1) v = -4.0 * ramp(u, 0, 22);
      if (ch === 2) v = 0.4 * ramp(u, 0, 30);
      if (ch === 3) v = 0.02 * ramp(u, 0, 22);
      if (ch === 4) v = 6.2 * ramp(u, 0, 10);
    }
    return v;
  }

  /* 正常工况扰动：接单根、起下钻、扭矩波动 —— 误报的主要来源 */
  function ops(t, c) {
    var v = 0;
    if (c === 0 && t >= 110 && t < 113) v -= 2.0;
    if (c === 1 && t >= 110 && t < 113) v -= 2.8;
    if (c === 2 && t >= 168 && t < 176) v += 2.6;
    if (c === 4 && t >= 145 && t < 149) v += 1.1;
    return v;
  }

  var raw = [], data = [];
  function build(scn) {
    raw = [];
    data = [];
    for (var c = 0; c < 5; c++) {
      var col = new Float64Array(N);
      for (var t = 0; t < N; t++) {
        var drift = 0.25 * Math.sin(t * 0.012 + c) + 0.12 * Math.sin(t * 0.043 + c * 2);
        var u = t - T1;
        col[t] = CH[c].base + CH[c].sd * 2.4 * drift + CH[c].sd * gauss() + ops(t, c) + anomaly(scn, c, u);
      }
      /* 气侵的总烃单位不同：直接把异常值当绝对值加 */
      data.push(col);
    }
  }

  /* ---------- 基线 + z 值 ---------- */
  var z = [], score = new Float64Array(N);
  var ALPHA = 0.016;
  function analyze() {
    z = [];
    for (var c = 0; c < 5; c++) {
      var zs = new Float64Array(N), mu = data[c][0], va = CH[c].sd * CH[c].sd;
      for (var t = 0; t < N; t++) {
        mu = mu + ALPHA * (data[c][t] - mu);
        var d = data[c][t] - mu;
        va = va + ALPHA * (d * d - va);
        zs[t] = d / Math.sqrt(va + 1e-6);
      }
      z.push(zs);
    }
    for (t = 0; t < N; t++) {
      var m = 0;
      for (c = 0; c < 5; c++) m = Math.max(m, Math.abs(z[c][t]));
      score[t] = m;
    }
  }

  /* ---------- 报警评估 ---------- */
  function evaluate(thr) {
    var alarms = [], run = 0;
    for (var t = 0; t < N; t++) {
      if (score[t] >= thr) {
        run++;
        if (run === 3) alarms.push(t - 2);
      } else run = 0;
    }
    var merged = [];
    for (var i = 0; i < alarms.length; i++) {
      if (!merged.length || alarms[i] - merged[merged.length - 1] > 12) merged.push(alarms[i]);
    }
    var WS = T1 - 40;
    var det = merged.filter(function (a) { return a >= WS && a <= T0 + 20; });
    var first = det.length ? det[0] : -1;
    return {
      list: merged, first: first,
      lead: first >= 0 ? T0 - first : 0,
      falseN: merged.filter(function (a) { return a < WS; }).length,
      missed: first < 0,
      ws: WS
    };
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

  var state = { scn: 'kick', thr: 4.0 };
  var trCv = document.getElementById('tracks');
  var coCv = document.getElementById('contrib');
  var swCv = document.getElementById('sweep');

  function drawTracks(res) {
    var o = fit(trCv, 2.15), ctx = o.ctx, W = o.W, H = o.H;
    var L = 62, R = 46, T = 10, B = 18;
    var rows = 6, rh = (H - T - B) / rows, pw = W - L - R;
    ctx.clearRect(0, 0, W, H);
    function px(t) { return L + t / (N - 1) * pw; }

    /* 异常区 */
    ctx.fillStyle = 'rgba(176,90,81,.07)';
    ctx.fillRect(px(T1), T, px(N - 1) - px(T1), H - T - B);

    /* 五个通道 */
    for (var c = 0; c < 5; c++) {
      var top = T + c * rh, hh = rh - 6;
      var arr = data[c], mn = 1e9, mx = -1e9;
      for (var t = 0; t < N; t++) { mn = Math.min(mn, arr[t]); mx = Math.max(mx, arr[t]); }
      var pad = (mx - mn) * 0.12 + 1e-6;
      mn -= pad; mx += pad;
      /* 零线 */
      ctx.strokeStyle = 'rgba(36,43,46,.10)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L, top + hh / 2); ctx.lineTo(L + pw, top + hh / 2); ctx.stroke();
      /* 基线 */
      ctx.beginPath();
      for (t = 0; t < N; t++) {
        var y = top + hh - (arr[t] - mn) / (mx - mn) * hh;
        if (t === 0) ctx.moveTo(px(t), y); else ctx.lineTo(px(t), y);
      }
      ctx.strokeStyle = CH[c].color; ctx.lineWidth = 1.1; ctx.stroke();
      /* 标签 */
      ctx.fillStyle = C.ink3; ctx.font = '9px ui-monospace,Consolas,monospace';
      ctx.fillText(CH[c].name, 2, top + hh / 2 + 3);
      ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
      ctx.fillText(arr[N - 1].toFixed(CH[c].dec), W - R + 4, top + hh / 2 + 3);
    }

    /* 分数 */
    var top2 = T + 5 * rh, hh2 = rh - 4;
    var smax = 8;
    ctx.strokeStyle = 'rgba(36,43,46,.10)';
    ctx.beginPath(); ctx.moveTo(L, top2 + hh2); ctx.lineTo(L + pw, top2 + hh2); ctx.stroke();
    ctx.beginPath();
    for (t = 0; t < N; t++) {
      var ys = top2 + hh2 - Math.min(score[t], smax) / smax * hh2;
      if (t === 0) ctx.moveTo(px(t), ys); else ctx.lineTo(px(t), ys);
    }
    ctx.strokeStyle = C.ink, ctx.lineWidth = 1.6; ctx.stroke();
    /* 阈值线 */
    var yth = top2 + hh2 - state.thr / smax * hh2;
    ctx.strokeStyle = C.bad; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(L, yth); ctx.lineTo(L + pw, yth); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.bad; ctx.font = '8px ui-monospace,Consolas,monospace';
    ctx.fillText('阈值 ' + state.thr.toFixed(1), L + 4, yth - 3);
    ctx.fillStyle = C.ink3; ctx.font = '9px ui-monospace,Consolas,monospace';
    ctx.fillText('异常分数', 2, top2 + hh2 / 2 + 3);

    /* 报警线 */
    for (var i = 0; i < res.list.length; i++) {
      var xa = px(res.list[i]);
      ctx.strokeStyle = res.list[i] < res.ws ? 'rgba(176,90,81,.35)' : 'rgba(176,90,81,.85)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(xa, T); ctx.lineTo(xa, H - B); ctx.stroke();
    }
    /* 事故时刻 */
    ctx.strokeStyle = C.jade; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(px(T0), T); ctx.lineTo(px(T0), H - B); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.jade; ctx.font = '8px ui-monospace,Consolas,monospace';
    ctx.fillText('事故', px(T0) + 3, T + 8);

    /* 时间轴 */
    ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
    for (t = 0; t <= N - 1; t += 60) {
      ctx.fillRect(px(t), H - B, 1, 3);
      ctx.fillText(t + ' min', px(t) - 10, H - 5);
    }
  }

  function drawContrib(res) {
    var o = fit(coCv, 1.75), ctx = o.ctx, W = o.W, H = o.H;
    ctx.clearRect(0, 0, W, H);
    var L = 66, R = 34, T = 14, B = 22;
    var bw = (H - T - B) / 5, pw = W - L - R;
    var at = res.first >= 0 ? res.first : T0 + 20;
    var vals = [], mx = 0.1;
    for (var c = 0; c < 5; c++) { var v = Math.abs(z[c][at]); vals.push(v); mx = Math.max(mx, v); }
    for (c = 0; c < 5; c++) {
      var y = T + c * bw + bw * 0.2, hh = bw * 0.52;
      ctx.fillStyle = C.ink3; ctx.font = '9px ui-monospace,Consolas,monospace';
      ctx.fillText(CH[c].name, 2, y + hh / 2 + 3);
      ctx.fillStyle = 'rgba(0,0,0,.05)'; ctx.fillRect(L, y, pw, hh);
      ctx.fillStyle = vals[c] > state.thr ? CH[c].color : 'rgba(121,130,138,.45)';
      ctx.fillRect(L, y, pw * clamp(vals[c] / mx, 0, 1), hh);
      ctx.fillStyle = C.ink2; ctx.font = '8.5px ui-monospace,Consolas,monospace';
      ctx.fillText(vals[c].toFixed(1) + 'σ', L + pw + 4, y + hh / 2 + 3);
    }
    ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
    ctx.fillText('报警时刻 t = ' + at + ' min 的各通道 |z|', L, H - 6);
  }

  function drawSweep() {
    var o = fit(swCv, 1.75), ctx = o.ctx, W = o.W, H = o.H;
    var L = 40, R = 44, T = 14, B = 28, pw = W - L - R, ph = H - T - B;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var Y = T + ph * g / 4;
      ctx.beginPath(); ctx.moveTo(L, Y + .5); ctx.lineTo(L + pw, Y + .5); ctx.stroke();
      ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
      ctx.fillText(String(Math.round(40 * (1 - g / 4))), 2, Y + 3);
      ctx.fillText(String(Math.round(4 * (1 - g / 4))), W - R + 8, Y + 3);
    }
    function px(th) { return L + (th - 2) / 7 * pw; }
    var lead = [], fals = [];
    for (var th = 2; th <= 9.01; th += 0.25) {
      var r = evaluate(th);
      lead.push([th, r.missed ? null : r.lead]);
      fals.push([th, r.falseN]);
    }
    function pyL(v) { return T + ph - Math.min(v, 40) / 40 * ph; }
    function pyF(v) { return T + ph - Math.min(v, 4) / 4 * ph; }
    /* 漏报区间 */
    var mStart = null, mEnd = null;
    lead.forEach(function (p) {
      if (p[1] === null) { if (mStart === null) mStart = p[0]; mEnd = p[0]; }
    });
    if (mStart !== null) {
      ctx.fillStyle = 'rgba(176,90,81,.10)';
      ctx.fillRect(px(mStart) - 2, T, Math.max(px(mEnd) - px(mStart) + 4, 3), ph);
      ctx.fillStyle = C.bad; ctx.font = '8px ui-monospace,Consolas,monospace';
      ctx.fillText('漏报区', px(mStart) + 3, T + 10);
    }
    /* 误报 */
    ctx.beginPath();
    fals.forEach(function (p, i) {
      var X = px(p[0]), Y = pyF(p[1]);
      if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    });
    ctx.strokeStyle = 'rgba(178,106,57,.85)'; ctx.lineWidth = 1.6; ctx.stroke();
    /* 提前量 */
    ctx.beginPath();
    var started = false;
    lead.forEach(function (p) {
      if (p[1] === null) { started = false; return; }
      var X = px(p[0]), Y = pyL(p[1]);
      if (!started) { ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
    });
    ctx.strokeStyle = C.jade; ctx.lineWidth = 1.9; ctx.stroke();
    /* 当前阈值 */
    var Xc = px(state.thr);
    ctx.strokeStyle = C.bad; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.moveTo(Xc, T); ctx.lineTo(Xc, T + ph); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.ink4; ctx.font = '8px ui-monospace,Consolas,monospace';
    ctx.fillText('阈值 →', L + pw - 34, H - 14);
    for (var k = 2; k <= 9; k += 1) ctx.fillText(String(k), px(k) - 2, H - 4);
    ctx.strokeStyle = C.jade; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(L, H - 9); ctx.lineTo(L + 10, H - 9); ctx.stroke();
    ctx.fillStyle = C.ink3; ctx.fillText('提前量(min)', L + 14, H - 6);
    ctx.strokeStyle = 'rgba(178,106,57,.85)';
    ctx.beginPath(); ctx.moveTo(L + 78, H - 9); ctx.lineTo(L + 88, H - 9); ctx.stroke();
    ctx.fillStyle = C.ink3; ctx.fillText('误报', L + 92, H - 6);
  }

  function update() {
    build(state.scn);
    analyze();
    var res = evaluate(state.thr);
    drawTracks(res);
    drawContrib(res);
    drawSweep();

    document.getElementById('thrOut').textContent = state.thr.toFixed(1);
    document.getElementById('scTag').textContent = { kick: 'KICK', loss: 'LOSS', stuck: 'STUCK' }[state.scn] +
      ' · THR ' + state.thr.toFixed(1);
    document.getElementById('roLead').textContent = res.lead > 0 ? res.lead : '—';
    document.getElementById('roFalse').textContent = res.falseN;
    document.getElementById('roAlarm').textContent = res.list.length;
    document.getElementById('roMax').textContent = Math.max.apply(null, Array.prototype.slice.call(score)).toFixed(1);
    var at = res.first >= 0 ? res.first : T0 + 20, best = 0;
    for (var c = 1; c < 5; c++) if (Math.abs(z[c][at]) > Math.abs(z[best][at])) best = c;
    document.getElementById('roWho').textContent = CH[best].name + '（|z| ' + Math.abs(z[best][at]).toFixed(1) + '）';

    var a = document.getElementById('roLead').parentNode;
    a.className = 'ro ' + (res.lead >= 12 ? 'good' : res.lead < 6 ? 'bad' : '');
    var b = document.getElementById('roFalse').parentNode;
    b.className = 'ro ' + (res.falseN === 0 ? 'good' : res.falseN > 2 ? 'bad' : '');

    var note = document.getElementById('note'), txt;
    var name = { kick: '气侵', loss: '井漏', stuck: '卡钻' }[state.scn];
    if (res.missed) {
      txt = '<b>' + name + ' · 阈值 ' + state.thr.toFixed(1) + '：漏报了</b> 到事故发生后 12 分钟内都没有形成报警。' +
        '阈值太高，弱前兆永远过不了线——这是预警系统最不能接受的结果。';
    } else if (res.falseN >= 3) {
      txt = '<b>' + name + ' · 阈值 ' + state.thr.toFixed(1) + '：提前 ' + res.lead + ' min，但误报 ' + res.falseN + ' 次</b> ' +
        '司钻会被前几次误报训练成「不看报警」。提前量是用信任换来的，换多了就没人信了。';
    } else if (res.falseN === 0) {
      txt = '<b>' + name + ' · 阈值 ' + state.thr.toFixed(1) + '：零误报，提前 ' + res.lead + ' min</b> ' +
        '这是这条曲线上的「好点」：报警只出现一次，且早于事故 ' + res.lead + ' 分钟。' +
        '但注意它离漏报只有一步之遥——再往右调一点，就可能完全错过。';
    } else {
      txt = '<b>' + name + ' · 阈值 ' + state.thr.toFixed(1) + '：提前 ' + res.lead + ' min，误报 ' + res.falseN + ' 次</b> ' +
        '每班 1—2 次是现场能接受的量级；超过这个数，报警就会被当成背景噪声。';
    }
    if (state.scn === 'kick' && state.thr < 3) {
      txt += '<br><span style="color:#8e5229">气侵的立压是「先升后降」，单通道阈值在下降段会再报一次——' +
        '这是同一事件的重复报警，不是新事故。</span>';
    }
    document.getElementById('note').innerHTML = txt;
  }

  document.getElementById('thr').addEventListener('input', function (e) {
    state.thr = parseFloat(e.target.value); update();
  });
  document.getElementById('scnSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.scn = b.getAttribute('data-s');
    [].forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
    update();
  });

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt); rt = setTimeout(update, 140);
  });

  update();
})();
