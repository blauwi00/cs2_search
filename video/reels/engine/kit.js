// Набор приёмов для роликов со СВОИМ каркасом (у каждого ролика своя сцена). Общее — только качество монтажа, как у эталона inv:
// фон ember (свет, узор, пылинки, виньетка), зерно, хлыст на склейках (рывок, размытие, вспышка), удар камеры под бит, стеклянные плашки,
// мини-баннер, запись бота на наклонной пластине и «крупная кнопка» (POP). Сцену ролик рисует сам в cfg.scene(t, K).
// cfg: base, dur, beat, pulse, whip{dist,blur,flash}, cuts[], punches[[t,сила]], mb[], stars{t0}, segs[], pops[], init(K), scene(t,K)
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var T = { bg: '#0A0A0C', hi: '255,170,90', mid: '60,45,35', deep: '18,16,16', edge: '255,200,150', glow: '200,90,20', glow2: '50,28,12', topo: '160,120,90', def: [255, 140, 40] };
  var clamp = function (x, a, b) { return Math.max(a, Math.min(b, x)); };
  var ease = function (x) { x = clamp(x, 0, 1); return 1 - Math.pow(1 - x, 3); };
  var inout = function (x) { x = clamp(x, 0, 1); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  var back = function (x) { x = clamp(x, 0, 1); var c = 1.7; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  var usd = function (c) { return '$' + (c / 100).toFixed(2); };
  var rgba = function (c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')'; };
  var STAR = '<svg viewBox="0 0 24 24" class="star"><path d="M12 1.8l3.1 6.4 7 1-5.1 4.9 1.2 7L12 17.8 5.8 21.1 7 14.1 1.9 9.2l7-1z" fill="#FFD23F"/></svg>';
  function vivid(c) {
    if (!c) return T.def; var mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
    if (mx - mn < 25) return T.def;
    return c.map(function (v) { return 255 * Math.pow((v - mn) / (mx - mn), 1.4) * 0.85 + 30; });
  }

  function run(cfg) {
    document.body.innerHTML = '<canvas id="bg" width="1080" height="1920"></canvas><div id="fx"><div id="fxi"><div id="sc"></div>' +
      '<div id="slabw"><div id="slab"><img id="slabimg"></div></div><canvas id="pc" width="1080" height="1920"></canvas><div id="pops"></div></div></div>' +
      '<div id="flash"></div><div class="mb" id="mb"><img src="assets/avatar.png"><div><div class="t">Ценолов</div><div class="u">@cenolow_bot</div></div><div class="sh" id="mbsh"></div></div>' +
      '<canvas id="grain" width="540" height="960" style="width:1080px;height:1920px"></canvas>';
    ['bg', 'hi', 'mid', 'deep', 'edge', 'glow'].forEach(function (k) { document.documentElement.style.setProperty('--' + k, T[k]); });
    var B = cfg.base || 'work/', BEAT = cfg.beat || 0.48, PULSE = cfg.pulse == null ? 0.018 : cfg.pulse;
    var WH = 0.16, WD = (cfg.whip && cfg.whip.dist) || 620, WB = (cfg.whip && cfg.whip.blur) || 26, WF = (cfg.whip && cfg.whip.flash) || 0.45;

    // Фон — как в эталоне.
    var bg = $('bg').getContext('2d'), centers = [[180, 380, 1.3], [900, 860, 2.1], [300, 1500, 0.7], [960, 1750, 2.9], [560, 1100, 4.2]];
    function starPath(c, x, y, r, rot) {
      c.beginPath();
      for (var i = 0; i < 10; i++) { var a = rot + i * Math.PI / 5 - Math.PI / 2, rr = i % 2 ? r * 0.45 : r; if (i) c.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a)); else c.moveTo(x + rr * Math.cos(a), y + rr * Math.sin(a)); }
      c.closePath();
    }
    function drawBg(t) {
      bg.fillStyle = T.bg; bg.fillRect(0, 0, 1080, 1920);
      var lx = 540 + 220 * Math.sin(t * 0.5), ly = 900 + 180 * Math.cos(t * 0.37);
      var g = bg.createRadialGradient(lx, ly, 0, lx, ly, 1100); g.addColorStop(0, 'rgba(' + T.glow + ',.55)'); g.addColorStop(.5, 'rgba(' + T.glow2 + ',.35)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      bg.fillStyle = g; bg.fillRect(0, 0, 1080, 1920);
      bg.strokeStyle = 'rgba(' + T.topo + ',.13)'; bg.lineWidth = 2;
      var dy = (t * 15) % 1920;
      for (var c = 0; c < centers.length; c++) for (var pass = 0; pass < 2; pass++) {
        var cx = centers[c][0], cy = centers[c][1] - dy + pass * 1920, ph = centers[c][2];
        for (var k = 1; k <= 14; k++) {
          bg.beginPath();
          for (var a = 0; a <= 64; a++) { var th = a / 64 * Math.PI * 2, r = k * 34 + 14 * Math.sin(3 * th + ph + k * 0.35 + t * 0.4) + 9 * Math.sin(5 * th - ph * 1.7 + k * 0.2); var x = cx + r * Math.cos(th) * 1.15, y = cy + r * Math.sin(th); if (a === 0) bg.moveTo(x, y); else bg.lineTo(x, y); }
          bg.stroke();
        }
      }
      for (var q = 0; q < 26; q++) {
        var px = (q * 397 % 1080) + Math.sin(t * 0.6 + q) * 30, py = ((q * 733 % 1920) - t * (20 + q % 5 * 8) + 1920 * 4) % 1920, pr = 6 + q % 4 * 7;
        var pg = bg.createRadialGradient(px, py, 0, px, py, pr * 3); pg.addColorStop(0, 'rgba(' + T.edge + ',.22)'); pg.addColorStop(1, 'rgba(0,0,0,0)');
        bg.fillStyle = pg; bg.fillRect(px - pr * 3, py - pr * 3, pr * 6, pr * 6);
      }
      if (cfg.stars && t >= cfg.stars.t0) {
        var s = t - cfg.stars.t0, fade = clamp(s / 0.8, 0, 1);
        for (var q2 = 0; q2 < 34; q2++) {
          var rr = 10 + (q2 * 7 % 5) * 6, sp = 70 + (q2 * 13 % 7) * 22, sx = (q2 * 211 % 1080) + Math.sin(s * 1.1 + q2) * 40, sy = ((q2 * 389 % 1920) - 300 + s * sp) % 2200 - 120;
          bg.save(); bg.globalAlpha = fade * (0.3 + (q2 % 3) * 0.18); bg.shadowColor = 'rgba(255,210,63,.8)'; bg.shadowBlur = 18; bg.fillStyle = '#FFD23F';
          starPath(bg, sx, sy, rr, s * (q2 % 2 ? 1.2 : -0.9) + q2); bg.fill(); bg.restore();
        }
      }
      var v = bg.createRadialGradient(540, 960, 500, 540, 960, 1250); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.7)');
      bg.fillStyle = v; bg.fillRect(0, 0, 1080, 1920);
    }
    var gr = $('grain').getContext('2d'), gimg = gr.createImageData(540, 960);
    function drawGrain(t) {
      var s = (Math.floor(t * 30) * 2654435761) >>> 0, d = gimg.data;
      for (var i = 0; i < d.length; i += 4) { s = (s * 1664525 + 1013904223) >>> 0; var v = s >>> 24; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
      gr.putImageData(gimg, 0, 0);
    }

    // Мини-баннер: [с, 'l'|'r'|'c'|x, y, угол, масштаб] или [с, 'off'].
    var MB = cfg.mb || [];
    function drawMb(t) {
      var el = $('mb'), cur = -1;
      for (var i = 0; i < MB.length; i++) if (t >= MB[i][0]) cur = i;
      if (cur < 0 || MB[cur][1] === 'off') {
        var pv = cur > 0 && MB[cur][1] === 'off' ? MB[cur - 1] : null;
        if (!pv || t > MB[cur][0] + 0.25) { el.style.opacity = 0; return; }
        cur--;
      }
      var m = MB[cur], nxt = cur + 1 < MB.length ? MB[cur + 1][0] : 1e9, W = 280 * m[4];
      var x = m[1] === 'c' ? 540 - W / 2 : m[1] === 'r' ? 880 - W : m[1] === 'l' ? 70 : m[1];
      var off = m[1] === 'r' ? 1080 - x + 40 : m[1] === 'l' ? -(x + W + 40) : 0;
      var inP = back((t - m[0]) / 0.3), outP = ease((t - (nxt - 0.2)) / 0.2);
      var dx = off * (1 - inP) + off * clamp(outP, 0, 1), sc = off ? m[4] : m[4] * clamp(inP, 0, 1.2) * (1 - clamp(outP, 0, 1));
      el.style.opacity = 1; el.style.transformOrigin = '50% 50%';
      el.style.transform = 'translate(' + (x + dx).toFixed(1) + 'px,' + m[2] + 'px) rotate(' + (m[3] + Math.sin(t * 2.4) * 0.8).toFixed(2) + 'deg) scale(' + sc.toFixed(3) + ')';
      $('mbsh').style.left = (-200 + ((t - m[0] - 0.3) % 1.6) / 0.6 * 600) + 'px';
    }

    // Запись бота на пластине: {t0,t1,clip,c0,n,k:[[с,x,y,зум]…],rect:[x,y,w,h],tilt:[ry0,ry1]}.
    var SEGS = cfg.segs || [], slab = null;
    function keyAt(k, x) {
      if (x <= k[0][0]) return k[0]; for (var i = 1; i < k.length; i++) if (x <= k[i][0]) { var a = k[i - 1], b = k[i], u = inout((x - a[0]) / (b[0] - a[0])); return [x, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u]; }
      return k[k.length - 1];
    }
    function drawSlab(t) {
      var sg = null; for (var i = 0; i < SEGS.length; i++) if (t >= SEGS[i].t0 && t < SEGS[i].t1) sg = SEGS[i];
      $('slabw').style.display = sg ? 'block' : 'none'; slab = null; if (!sg) return null;
      var x = t - sg.t0, f = Math.round((sg.c0 + x) * 30) + 1;
      if (f > sg.n) throw new Error('не хватает кадров записи ' + sg.clip + ': ' + f + ' > ' + sg.n);
      var R = sg.rect, src = (sg.base || B) + 'frames/' + sg.clip + '/' + ('0000' + Math.max(1, f)).slice(-5) + '.jpg', im = $('slabimg');
      var c = keyAt(sg.k, x), s = R[2] * c[3] / 1080;
      var L = clamp(R[2] / 2 - c[1] * s, R[2] - 1080 * s, 0), Tp = clamp(R[3] / 2 - c[2] * s, R[3] - 2338 * s, 0);
      im.style.transform = 'translate(' + L.toFixed(1) + 'px,' + Tp.toFixed(1) + 'px) scale(' + s.toFixed(4) + ')';
      var el = $('slab'), e = back(x / 0.35), tl = sg.tilt || [12, 0], ry = tl[0] + (tl[1] - tl[0]) * ease(x / 0.8);
      el.style.left = R[0] + 'px'; el.style.top = R[1] + 'px'; el.style.width = R[2] + 'px'; el.style.height = R[3] + 'px';
      el.style.transform = 'rotateY(' + ry.toFixed(2) + 'deg) scale(' + (0.9 + 0.1 * e).toFixed(3) + ')';
      slab = { x: R[0], y: R[1], L: L, T: Tp, s: s };
      if (im.getAttribute('src') !== src) { im.src = src; return im.decode().catch(function () {}); }
      return null;
    }
    // Крупная кнопка поверх пластины: {at, box:[x,y,w,h] CSS 390×844, text, size, to:[cx,cy]}.
    var POPS = (cfg.pops || []).map(function (p) {
      var d = document.createElement('div'); d.className = 'pop'; d.innerHTML = '<span>' + p.text + '</span><div class="sh"></div>';
      d.style.fontSize = (p.size || 96) + 'px'; $('pops').appendChild(d); return { cfg: p, el: d };
    });
    var popFlash = 0;
    function drawPops(t) {
      popFlash = 0;
      POPS.forEach(function (P) {
        var p = P.cfg, el = P.el, dt = t - p.at;
        if (dt < -0.55 || dt > 0.25 || !slab) { el.style.display = 'none'; return; }
        el.style.display = 'flex';
        var W = Math.min(820, el.scrollWidth), H = el.offsetHeight; el.style.width = W + 'px';
        var k = 1080 / 390, bx = slab.x + slab.L + (p.box[0] + p.box[2] / 2) * k * slab.s, by = slab.y + slab.T + (p.box[1] + p.box[3] / 2) * k * slab.s;
        var to = p.to || [480, 1000], s0 = Math.max(0.15, p.box[2] * k * slab.s / W), S1 = Math.min(1.25, 820 / W);
        var g = back((dt + 0.55) / 0.4), cx = bx + (to[0] - bx) * g, cy = by + (to[1] - by) * g, sc = s0 + (S1 - s0) * g, bl = 0, op = 1;
        if (dt > -0.15 && dt <= 0) sc *= 1 - 0.06 * Math.sin(clamp((dt + 0.15) / 0.15, 0, 1) * Math.PI);
        if (dt > 0) { var u = ease(dt / 0.25); sc *= 1 + 0.8 * u; bl = 12 * u; op = 1 - u; popFlash = Math.max(popFlash, 1 - u); }
        el.style.left = (cx - W / 2).toFixed(1) + 'px'; el.style.top = (cy - H / 2).toFixed(1) + 'px';
        el.style.transform = 'scale(' + sc.toFixed(3) + ')'; el.style.opacity = op; el.style.filter = bl > 0.3 ? 'blur(' + bl.toFixed(1) + 'px)' : 'none';
        el.querySelector('.sh').style.left = (-300 + ease((dt + 0.3) / 0.5) * (W + 600)) + 'px';
      });
    }

    // Камера: хлыст на склейках, удар на долю, удары-«акценты» (punches), лёгкое плавание.
    var CUTS = cfg.cuts || [], PUN = cfg.punches || [];
    function drawCam(t) {
      var x = 0, bl = 0, fl = 0, kick = 0;
      for (var i = 0; i < CUTS.length; i++) {
        var dt = t - CUTS[i];
        if (dt > -WH && dt < 0) { var a = ease((dt + WH) / WH); x = -a * WD; bl = a * WB; }
        if (dt >= 0 && dt < WH) { var b = 1 - ease(dt / WH); x = b * WD; bl = b * WB; fl = Math.max(fl, b); }
      }
      for (var j = 0; j < PUN.length; j++) { var d = t - PUN[j][0]; if (d >= 0 && d < 0.5) { var e = Math.exp(-d * 9); kick = Math.max(kick, PUN[j][1] * e); fl = Math.max(fl, PUN[j][1] * 4 * e); } }
      var bt = t % BEAT, pulse = 1 + PULSE * Math.exp(-bt * 9) + kick;
      var dr = Math.sin(t * 0.7) * 6;
      $('fxi').style.transform = 'translate(' + (x + dr).toFixed(1) + 'px,0) scale(' + pulse.toFixed(4) + ')';
      $('fxi').style.filter = bl > 0.3 ? 'blur(' + bl.toFixed(1) + 'px)' : 'none';
      $('flash').style.opacity = clamp(Math.max(fl * WF, popFlash * 0.35), 0, 0.6).toFixed(3);
    }

    // Помощники для сцены.
    var pc = $('pc').getContext('2d');
    var K = {
      B: B, T: T, pc: pc, star: starPath, vivid: vivid, rgba: rgba, usd: usd, clamp: clamp, ease: ease, inout: inout, back: back, STAR: STAR,
      el: function (html, cls, parent) { var d = document.createElement('div'); d.className = cls || ''; d.innerHTML = html || ''; (parent || $('sc')).appendChild(d); return d; },
      img: function (src, cls) { var i = document.createElement('img'); i.src = src; i.className = cls || ''; i.style.position = 'absolute'; $('sc').appendChild(i); return i; },
      plate: function (html, rect, fs) { var d = K.el('<div class="in">' + html + '</div><div class="sh"></div>', 'gl3'); K.box(d, rect); if (fs) d.style.fontSize = fs + 'px'; return d; },
      box: function (el, r) { el.style.left = r[0] + 'px'; el.style.top = r[1] + 'px'; el.style.width = r[2] + 'px'; el.style.height = r[3] + 'px'; },
      // Вход/выход с пружиной, размытием и наклоном. from: 'r','l','b','t','z' (из глубины). out — время ухода (необязательно).
      slam: function (el, t, at, from, out, outTo) {
        var p = (t - at) / 0.4, e = back(p), q = out != null ? ease((t - out) / 0.25) : 0;
        if (p <= 0 || q >= 1) { el.style.opacity = 0; el.style.visibility = 'hidden'; return 0; }
        el.style.visibility = 'visible'; el.style.opacity = 1 - q;
        var D = { r: [1100, 0], l: [-1100, 0], b: [0, 900], t: [0, -900], z: [0, 0] }[from || 'r'], O = { r: [1100, 0], l: [-1100, 0], b: [0, 900], t: [0, -900], z: [0, 0] }[outTo || 'l'];
        var tx = D[0] * (1 - e) + O[0] * q, ty = D[1] * (1 - e) + O[1] * q, sc = from === 'z' ? 0.6 + 0.4 * e : 1;
        el.style.transform = 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) rotate(' + ((1 - ease(p)) * -4).toFixed(2) + 'deg) scale(' + sc.toFixed(3) + ')';
        var bl = (1 - ease(p)) * 10 + q * 12; el.style.filter = bl > 0.3 ? 'blur(' + bl.toFixed(1) + 'px)' : 'none';
        var sh = el.querySelector(':scope > .sh'); if (sh) sh.style.left = (-300 + ease((p - 0.6) / 1.4) * 1500) + 'px';
        return ease(p);
      },
      // Объёмная пушка: n слоёв картинки по глубине (толщина), поворот в 3D, блик по форме скина, тень на полу. pose(t, {rz, ry, rx, s, blur, op, tx, ty}).
      gun3d: function (src, r, n, depth) {
        n = n || 14; depth = depth || 2.2;
        var w = K.el('<div class="shd"></div><div class="obj"></div>', 'g3'); K.box(w, r);
        var o = w.querySelector('.obj'), html = '';
        for (var i = n; i >= 1; i--) html += '<img src="' + src + '" style="transform:translateZ(' + (-i * depth).toFixed(1) + 'px);filter:brightness(' + (0.22 + 0.35 * (1 - i / n)).toFixed(2) + ') saturate(1.2)">';
        html += '<img src="' + src + '" style="transform:translateZ(0)"><div class="gls" style="-webkit-mask-image:url(\'' + src + '\')"></div>';
        o.innerHTML = html;
        var g = o.querySelector('.gls'), shd = w.querySelector('.shd');
        return { el: w, pose: function (t, p) {
          p = p || {}; var ry = p.ry || 0, rx = p.rx || 0;
          o.style.transform = 'translate(' + (p.tx || 0) + 'px,' + (p.ty || 0) + 'px) rotateZ(' + (p.rz || 0) + 'deg) rotateY(' + ry.toFixed(2) + 'deg) rotateX(' + rx.toFixed(2) + 'deg) scale(' + (p.s || 1).toFixed(3) + ')';
          g.style.backgroundPosition = (100 - ((ry + 30) / 60) * 100 + Math.sin(t * 0.7) * 20).toFixed(1) + '% 0';
          shd.style.transform = 'scaleX(' + (1 - Math.abs(ry) / 90).toFixed(3) + ')';
          w.style.opacity = p.op == null ? 1 : p.op; w.style.filter = p.blur > 0.3 ? 'blur(' + p.blur.toFixed(1) + 'px)' : 'none';
        } };
      },
      // Счётчик между a и b с вертикальным размытием, пока катится.
      roll: function (a, b, t, t0, dur) { var u = inout((t - t0) / dur); return { v: a + (b - a) * u, blur: u > 0 && u < 1 ? Math.sin(u * Math.PI) * 6 : 0 }; }
    };
    if (cfg.init) cfg.init(K);

    window.frameAt = function (t) {
      var wait = drawSlab(t);
      pc.clearRect(0, 0, 1080, 1920);
      drawBg(t); cfg.scene(t, K); drawPops(t); drawCam(t); drawMb(t); drawGrain(t);
      return wait;
    };
    window.frameAt(0);
  }
  window.KIT = { run: run };
})();
