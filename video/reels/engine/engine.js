// Движок роликов «Ценолова» (монтаж эталона inv.html, см. ../STYLE.md). Ролик = страница с REEL.run(cfg): только сценарий и данные.
// Полосы кадра: крючок 200–430, баннер 446–542, основное окно #fx 565–1315, жёлтое слово 1330–1460.
// cfg: base, hook(html), words, cuts, mb, hero{items|draw}, cards{items,c0,step,end}, total{t0,t1,big(t),fc{at,html},nc{at,text}},
//      segs (запись бота), pops (крупная кнопка), stars{t0}, fin{t0}, dur.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var THEMES = {
    blue: { bg: '#050A18', hi: '110,160,255', mid: '30,50,110', deep: '8,14,40', edge: '170,200,255', glow: '40,80,200', glow2: '14,24,70', topo: '90,130,220', def: [80, 140, 255] },
    violet: { bg: '#0B0614', hi: '190,140,255', mid: '70,35,120', deep: '22,10,40', edge: '215,185,255', glow: '120,60,220', glow2: '40,16,80', topo: '150,110,220', def: [160, 100, 255] },
    ember: { bg: '#0A0A0C', hi: '255,170,90', mid: '60,45,35', deep: '18,16,16', edge: '255,200,150', glow: '200,90,20', glow2: '50,28,12', topo: '160,120,90', def: [255, 140, 40] }
  };
  var usd = function (c) { return '$' + (c / 100).toFixed(2); };
  var clamp = function (x, a, b) { return Math.max(a, Math.min(b, x)); };
  var ease = function (x) { x = clamp(x, 0, 1); return 1 - Math.pow(1 - x, 3); };
  var inout = function (x) { x = clamp(x, 0, 1); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  var back = function (x) { x = clamp(x, 0, 1); var c = 1.7; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  var rgba = function (c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')'; };
  // Звезда — SVG (эмодзи в наложениях нельзя).
  var STAR = '<svg viewBox="0 0 24 24" class="star"><path d="M12 1.8l3.1 6.4 7 1-5.1 4.9 1.2 7L12 17.8 5.8 21.1 7 14.1 1.9 9.2l7-1z" fill="#FFD23F"/></svg>';

  var SKELETON = '<canvas id="bg" width="1080" height="1920"></canvas>\n' +
    '<div id="fx"><div id="fxi"><div id="hero"><div id="halo"></div><img id="heroimg"><div id="streak"></div></div>\n' +
    '<div id="stage"><div id="deck"></div></div>\n' +
    '<div id="ph"><img id="phimg"></div>\n' +
    '<div id="fin"><div class="tc" id="f1"><img src="assets/avatar.png"><b>ЦЕНОЛОВ</b></div><div class="tc" id="f2">@cenolow_bot</div><div class="tc" id="f3">не покупает и не просит пароль</div></div>\n' +
    '<div id="tot"><div id="plate"><div class="sh" id="psh"></div><div class="big" id="big"></div></div><div class="tc" id="fc"></div><div class="tc" id="nc"></div></div>\n' +
    '<div id="pops"></div></div></div>\n' +
    '<div id="flash"></div>\n' +
    '<div class="hook" id="hook"></div>\n' +
    '<div class="mb" id="mb"><img src="assets/avatar.png" onerror="this.style.display=\'none\'"><div><div class="t">Ценолов</div><div class="u">@cenolow_bot</div></div><div class="sh" id="mbsh"></div></div>\n' +
    '<div class="word" id="word"></div>\n' +
    '<canvas id="grain" width="540" height="960" style="width:1080px;height:1920px"></canvas>\n';

  function run(cfg) {
    document.body.innerHTML = SKELETON;
    var B = cfg.base || 'work/';
    var T = THEMES[(location.search.match(/theme=(\w+)/) || [])[1]] || THEMES.ember;
    ['bg', 'hi', 'mid', 'deep', 'edge', 'glow'].forEach(function (k) { document.documentElement.style.setProperty('--' + k, T[k]); });

    // Крючок: не больше двух строк, иначе стоп.
    $('hook').innerHTML = cfg.hook;
    if ((cfg.hook.match(/<br>/g) || []).length > 1) throw new Error('крючок длиннее двух строк');
    function drawHook(t) {
      var p = (t - 0.05) / 0.4, e = back(p), el = $('hook');
      el.style.opacity = p > 0 ? 1 : 0;
      el.style.transform = 'translateX(' + ((1 - e) * 1100).toFixed(1) + 'px) rotate(' + ((1 - ease(p)) * -4).toFixed(2) + 'deg)';
      el.style.filter = p < 1 ? 'blur(' + ((1 - ease(p)) * 10).toFixed(1) + 'px)' : 'none';
    }

    var MB = cfg.mb || [[0.6, 'r', 446, 2, 1], [1.5, 'l', 446, -2, 1], [3.9, 'r', 446, 2, 1], [6, 'l', 446, -2, 1], [8, 'r', 446, 2, 1], [10, 'l', 446, -2, 1], [11.5, 'c', 446, 0, 1], [14.5, 'r', 446, 2, 1], [17.5, 'off']];
    function drawMb(t) {
      var el = $('mb'), cur = -1;
      for (var i = 0; i < MB.length; i++) if (t >= MB[i][0]) cur = i;
      if (cur < 0 || MB[cur][1] === 'off' && t > MB[cur][0] + 0.2) { el.style.opacity = 0; return; }
      if (MB[cur][1] === 'off') cur--;
      var m = MB[cur], nxt = cur + 1 < MB.length ? MB[cur + 1][0] : 1e9, W = 280 * m[4];
      var x = m[1] === 'c' ? 540 - W / 2 : m[1] === 'r' ? 900 - W : 70, off = m[1] === 'r' ? 1080 - x + 40 : m[1] === 'l' ? -(x + W + 40) : 0;
      var inP = back((t - m[0]) / 0.3), outP = ease((t - (nxt - 0.2)) / 0.2);
      var dx = off * (1 - inP) + off * clamp(outP, 0, 1), dy = 0;
      var rot = m[3] + Math.sin(t * 2.4) * 0.8;
      el.style.opacity = 1; el.style.transformOrigin = '0 0';
      var sc = m[1] === 'c' ? m[4] * clamp(inP, 0, 1.2) * (1 - clamp(outP, 0, 1)) : m[4];
      el.style.transformOrigin = '50% 50%';
      el.style.transform = 'translate(' + (x + dx).toFixed(1) + 'px,' + (m[2] + dy).toFixed(1) + 'px) rotate(' + rot.toFixed(2) + 'deg) scale(' + sc.toFixed(3) + ')';
      $('mbsh').style.left = (-200 + ((t - m[0] - 0.3) % 1.6) / 0.6 * 600) + 'px';
    }

    function vivid(c) {
      if (!c) return T.def;
      var mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
      if (mx - mn < 25) return T.def;
      return c.map(function (v) { return 255 * Math.pow((v - mn) / (mx - mn), 1.4) * 0.85 + 30; });
    }

    var bg = $('bg').getContext('2d');
    var centers = [[180, 380, 1.3], [900, 860, 2.1], [300, 1500, 0.7], [960, 1750, 2.9], [560, 1100, 4.2]];
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
          for (var a = 0; a <= 64; a++) {
            var th = a / 64 * Math.PI * 2, r = k * 34 + 14 * Math.sin(3 * th + ph + k * 0.35 + t * 0.4) + 9 * Math.sin(5 * th - ph * 1.7 + k * 0.2);
            var x = cx + r * Math.cos(th) * 1.15, y = cy + r * Math.sin(th); if (a === 0) bg.moveTo(x, y); else bg.lineTo(x, y);
          }
          bg.stroke();
        }
      }
      for (var q = 0; q < 26; q++) {
        var px = (q * 397 % 1080) + Math.sin(t * 0.6 + q) * 30, py = ((q * 733 % 1920) - t * (20 + q % 5 * 8) + 1920 * 4) % 1920, pr = 6 + q % 4 * 7;
        var pg = bg.createRadialGradient(px, py, 0, px, py, pr * 3); pg.addColorStop(0, 'rgba(' + T.edge + ',.22)'); pg.addColorStop(1, 'rgba(0,0,0,0)');
        bg.fillStyle = pg; bg.fillRect(px - pr * 3, py - pr * 3, pr * 6, pr * 6);
      }
      if (cfg.stars && t >= cfg.stars.t0) drawStars(t - cfg.stars.t0);
      var v = bg.createRadialGradient(540, 960, 500, 540, 960, 1250); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.7)');
      bg.fillStyle = v; bg.fillRect(0, 0, 1080, 1920);
    }
    // Звездопад (ролик про поддержку): золотые звёзды медленно падают в фоне, за карточками.
    function starPath(x, y, r, rot) {
      bg.beginPath();
      for (var i = 0; i < 10; i++) { var a = rot + i * Math.PI / 5 - Math.PI / 2, rr = i % 2 ? r * 0.45 : r; if (i) bg.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a)); else bg.moveTo(x + rr * Math.cos(a), y + rr * Math.sin(a)); }
      bg.closePath();
    }
    function drawStars(s) {
      var fade = clamp(s / 0.6, 0, 1);
      for (var q = 0; q < 34; q++) {
        var r = 10 + (q * 7 % 5) * 6, sp = 90 + (q * 13 % 7) * 30;
        var x = (q * 211 % 1080) + Math.sin(s * 1.1 + q) * 40, y = ((q * 389 % 1920) - 300 + s * sp) % 2200 - 120;
        bg.save(); bg.globalAlpha = fade * (0.35 + (q % 3) * 0.2); bg.shadowColor = 'rgba(255,210,63,.8)'; bg.shadowBlur = 18;
        bg.fillStyle = '#FFD23F'; starPath(x, y, r, s * (q % 2 ? 1.2 : -0.9) + q); bg.fill(); bg.restore();
      }
    }
    var gr = $('grain').getContext('2d'), gimg = gr.createImageData(540, 960);
    function drawGrain(t) {
      var s = (Math.floor(t * 30) * 2654435761) >>> 0, d = gimg.data;
      for (var i = 0; i < d.length; i += 4) { s = (s * 1664525 + 1013904223) >>> 0; var v = s >>> 24; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
      gr.putImageData(gimg, 0, 0);
    }

    var WORDS = cfg.words;
    function word(t) {
      var w = WORDS[0]; for (var i = 0; i < WORDS.length; i++) if (t >= WORDS[i][0]) w = WORDS[i];
      var el = $('word');
      if (el.textContent !== w[1]) { el.textContent = w[1]; el.style.fontSize = ''; var fs = 124; while (el.scrollWidth > 960 && fs > 96) { fs -= 4; el.style.fontSize = fs + 'px'; } }
      el.style.transform = 'scale(' + (1 + 0.1 * (1 - clamp((t - w[0]) / 0.1, 0, 1))) + ')';
    }

    // Герой (0–1,5 с): три крупных картинки со светом своего цвета. Элемент: {img, tint} или {html} (свой рисунок, напр. звезда).
    var HERO = cfg.hero || [];
    function drawHero(t) {
      var on = t < 1.5; $('hero').style.display = on ? 'block' : 'none'; if (!on) return;
      var i = Math.min(2, Math.floor(t / 0.5)), l = t - i * 0.5, h = HERO[i], im = $('heroimg');
      var src = h.img ? (h.abs ? h.img : B + h.img) : h.src;
      if (im.getAttribute('src') !== src) im.src = src;
      var c = h.color || vivid(h.tint);
      $('halo').style.background = 'radial-gradient(' + rgba(c, .9) + ',' + rgba(c, .25) + ' 45%,transparent 70%)';
      var punch = 1 - ease(l / 0.18), rot = h.rot != null ? h.rot : -9;
      im.style.transform = 'rotate(' + (rot + l * 4) + 'deg) scale(' + ((h.scale || 1) * (1.02 + 0.22 * punch + l * 0.06)) + ')';
      im.style.filter = 'drop-shadow(0 40px 50px rgba(0,0,0,.6)) blur(' + (punch * 6).toFixed(1) + 'px)';
      $('streak').style.left = (-400 + ease(l / 0.4) * 1900) + 'px';
    }

    // Колода карточек: {img|icon, p (html цены), n (подпись), tint}.
    var CD = cfg.cards || { items: [] }, deck = $('deck'), C0 = CD.c0 || 8.0, CSTEP = CD.step || 0.48, CEND = CD.end || 11.5;
    var cards = CD.items.map(function (it) {
      var d = document.createElement('div'); d.className = 'card' + (it.icon ? ' ic' : '');
      d.innerHTML = '<div class="clip"><div class="gl"></div><div class="sh"></div></div>' + (it.icon ? '<div class="icon">' + it.icon + '</div>' : '<img src="' + B + it.img + '">') + '<div class="p">' + it.p + '</div>' + (it.n ? '<div class="n">' + it.n + '</div>' : '');
      deck.appendChild(d); return d;
    });
    function drawCards(t) {
      var on = t >= C0 && t < CEND; $('stage').style.display = on ? 'block' : 'none'; if (!on) return;
      var k = (t - C0) / 3.5, collapse = ease((t - (CEND - 0.2)) / 0.2);
      var n = clamp((t - C0) / CSTEP, 0, cards.length - 1), scroll = Math.max(0, n - 1.6) * 250;
      deck.style.transform = 'translateY(' + (60 - scroll) + 'px) rotateX(' + (24 - k * 6) + 'deg) rotateZ(' + (-7 + k * 3) + 'deg) scale(' + (0.98 + k * 0.05) + ')';
      for (var i = 0; i < cards.length; i++) {
        var d = cards[i], c = CD.items[i].color || vivid(CD.items[i].tint);
        d.querySelector('.gl').style.background = rgba(c, .9);
        var p = (t - C0 - i * CSTEP) / 0.4;
        if (p < 0) { d.style.opacity = 0; continue; }
        var e = back(p), y = 600 + i * 250;
        d.style.top = y + 'px'; d.style.zIndex = 10 + i;
        d.style.transform = 'translateX(' + ((1 - e) * 1100) + 'px) translateZ(' + (collapse * -600) + 'px)';
        d.style.filter = 'blur(' + ((1 - ease(p)) * 10).toFixed(1) + 'px)';
        d.style.opacity = 1 - collapse;
        d.querySelector('.sh').style.left = (-300 + ease((p - 0.8) / 1.2) * 1300) + 'px';
      }
    }

    // Итог на плите: big(t) отдаёт html числа; fc/nc — карточки под плитой.
    var TT = cfg.total;
    function slideIn(el, t, at) {
      var p = (t - at) / 0.4, e = back(p);
      el.style.opacity = p > 0 ? 1 : 0;
      el.style.transform = 'translateX(' + ((1 - e) * 1100).toFixed(1) + 'px) rotate(' + ((1 - ease(p)) * -4).toFixed(2) + 'deg)';
      el.style.filter = p < 1 ? 'blur(' + ((1 - ease(p)) * 10).toFixed(1) + 'px)' : 'none';
    }
    function drawTotal(t) {
      var on = TT && t >= TT.t0 && t < TT.t1; $('tot').style.display = on ? 'block' : 'none'; if (!on) return;
      var k = (t - TT.t0) / (TT.t1 - TT.t0), a = back((t - TT.t0) / 0.45);
      $('plate').style.transform = 'translateY(' + ((1 - a) * 300) + 'px) rotateX(' + (14 - k * 10) + 'deg) rotateY(' + (-12 + k * 9) + 'deg)';
      $('plate').style.opacity = clamp((t - TT.t0) / 0.15, 0, 1);
      $('big').innerHTML = TT.big(t);
      var bw = $('big').scrollWidth; $('big').style.transform = 'scale(' + Math.min(1, 900 / bw) + ')';
      $('fc').innerHTML = TT.fc.html; $('nc').textContent = TT.nc.text;
      [['fc', TT.fc.at], ['nc', TT.nc.at]].forEach(function (c) { slideIn($(c[0]), t, c[1]); });
      $('psh').style.left = (-300 + ease((t - TT.t0 - 0.5) / 0.8) * 1500) + 'px';
    }

    // Запись бота: отрезки [t0,t1) из кадров <base>frames/<клип>/NNNNN.jpg; камера по ключам [с, x, y, зум] в пикселях записи 1080×2338.
    var SEGS = cfg.segs || [];
    function keyAt(k, x) {
      if (x <= k[0][0]) return k[0]; for (var i = 1; i < k.length; i++) if (x <= k[i][0]) { var a = k[i - 1], b = k[i], u = inout((x - a[0]) / (b[0] - a[0])); return [x, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u]; }
      return k[k.length - 1];
    }
    var cam = null; // текущее положение записи в окне — для POP
    function drawPhone(t) {
      var sg = null; for (var i = 0; i < SEGS.length; i++) if (t >= SEGS[i].t0 && t < SEGS[i].t1) sg = SEGS[i];
      $('ph').style.display = sg ? 'block' : 'none'; cam = null; if (!sg) return null;
      var x = t - sg.t0, f = Math.max(1, Math.min(sg.n, Math.round((sg.c0 + x) * 30) + 1));
      var src = (sg.base || B) + 'frames/' + sg.clip + '/' + ('0000' + f).slice(-5) + '.jpg', im = $('phimg');
      var c = keyAt(sg.k, x), s = 780 * c[3] / 1080;
      var L = clamp(390 - c[1] * s, 780 - 1080 * s, 0), Tp = clamp(345 - c[2] * s, 690 - 2338 * s, 0);
      im.style.width = '1080px'; im.style.transform = 'translate(' + L.toFixed(1) + 'px,' + Tp.toFixed(1) + 'px) scale(' + s.toFixed(4) + ')';
      var e = back(x / 0.3); $('ph').style.transform = 'scale(' + (0.92 + 0.08 * e).toFixed(3) + ')';
      cam = { L: L, T: Tp, s: s };
      if (im.getAttribute('src') !== src) { im.src = src; return im.decode().catch(function () {}); }
      return null;
    }

    // Крупная кнопка (POP): копия кнопки бота на стеклянной карточке. Появляется поверх кнопки, растёт к центру, нажимается и вылетает в камеру.
    // {at: время касания, box: [x,y,w,h] в CSS-пикселях записи 390×844, text: html, size: px}
    var POPS = (cfg.pops || []).map(function (p) {
      var d = document.createElement('div'); d.className = 'pop'; d.innerHTML = '<span>' + p.text + '</span><div class="sh"></div>';
      d.style.fontSize = (p.size || 84) + 'px'; $('pops').appendChild(d); return { cfg: p, el: d };
    });
    var popFlash = 0;
    function drawPops(t) {
      popFlash = 0;
      POPS.forEach(function (P) {
        var p = P.cfg, el = P.el, dt = t - p.at;
        if (dt < -0.55 || dt > 0.25 || !cam) { el.style.display = 'none'; return; }
        el.style.display = 'flex';
        var W = Math.min(900, el.scrollWidth), H = el.offsetHeight;
        el.style.width = W + 'px';
        var k = 1080 / 390, bx = 150 + cam.L + (p.box[0] + p.box[2] / 2) * k * cam.s, by = 595 + cam.T + (p.box[1] + p.box[3] / 2) * k * cam.s;
        var s0 = Math.max(0.15, p.box[2] * k * cam.s / W);
        var S1 = Math.min(1.3, 960 / W), g = back((dt + 0.55) / 0.4), cx = bx + (540 - bx) * g, cy = by + (940 - by) * g, sc = s0 + (S1 - s0) * g, bl = 0, op = 1;
        if (dt > -0.15 && dt <= 0) sc *= 1 - 0.06 * Math.sin(clamp((dt + 0.15) / 0.15, 0, 1) * Math.PI);
        if (dt > 0) { var u = ease(dt / 0.25); sc *= 1 + 0.8 * u; bl = 12 * u; op = 1 - u; popFlash = Math.max(popFlash, 1 - u); }
        el.style.left = (cx - W / 2).toFixed(1) + 'px'; el.style.top = (cy - H / 2).toFixed(1) + 'px';
        el.style.transform = 'scale(' + sc.toFixed(3) + ')'; el.style.opacity = op;
        el.style.filter = bl > 0.3 ? 'blur(' + bl.toFixed(1) + 'px)' : 'none';
        el.querySelector('.sh').style.left = (-300 + ease((dt + 0.3) / 0.5) * (W + 600)) + 'px';
      });
    }

    var FIN = (cfg.fin && cfg.fin.t0) || 17.5;
    function drawFin(t) {
      var on = t >= FIN; $('fin').style.display = on ? 'block' : 'none'; if (!on) return;
      [['f1', FIN + 0.05], ['f2', FIN + 0.35], ['f3', FIN + 0.65]].forEach(function (c) { slideIn($(c[0]), t, c[1]); });
      $('fin').style.opacity = 1 - ease((t - (FIN + 2.05)) / 0.45);
    }

    var CUTS = cfg.cuts || [1.5, 3.9, 6, 8, 11.5, 14.5, 17.5], WH = 0.16;
    function drawCam(t) {
      var x = 0, bl = 0, fl = 0;
      for (var i = 0; i < CUTS.length; i++) {
        var dt = t - CUTS[i];
        if (dt > -WH && dt < 0) { var a = ease((dt + WH) / WH); x = -a * 620; bl = a * 26; }
        if (dt >= 0 && dt < WH) { var b = 1 - ease(dt / WH); x = b * 620; bl = b * 26; fl = Math.max(fl, b); }
      }
      var bt = t % 0.48, pulse = 1 + 0.018 * Math.exp(-bt * 9);
      var dr = Math.sin(t * 0.7) * 6;
      $('fxi').style.transform = 'translate(' + (x + dr).toFixed(1) + 'px,0) scale(' + pulse.toFixed(4) + ')';
      $('fxi').style.filter = bl > 0.3 ? 'blur(' + bl.toFixed(1) + 'px)' : 'none';
      $('flash').style.opacity = (Math.max(fl * 0.45, popFlash * 0.35)).toFixed(3);
    }

    window.frameAt = function (t) {
      var wait = drawPhone(t); drawFin(t);
      drawBg(t); drawHero(t); drawCards(t); drawTotal(t); drawPops(t); drawCam(t); word(t); drawHook(t); drawMb(t); drawGrain(t);
      return wait;
    };
    window.frameAt(0);
  }
  window.REEL = { run: run, usd: usd, clamp: clamp, ease: ease, inout: inout, back: back, STAR: STAR };
})();
