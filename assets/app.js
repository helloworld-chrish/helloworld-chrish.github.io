/* Chris H. — portfolio front-end.
   Reads data/photos.json and renders it. No build step, no framework. */
(function () {
  'use strict';

  var DATA_URL = 'data/photos.json';
  var WIDE_RATIO = 1.4;      // w/h above this spans the full rail
  var THUMB_WIDTH = 600;     // these must match what admin.js generates
  var MID_WIDTH = 1200;

  var state = {
    photos: [],
    profile: {},
    revealed: Object.create(null),
    openIndex: -1,
    narrow: false,
    lastFocus: null
  };

  var el = {
    gallery: document.getElementById('gallery'),
    hero: document.getElementById('hero'),
    heroImg: document.getElementById('heroImg'),
    heroName: document.getElementById('heroName'),
    aboutBtn: document.getElementById('aboutBtn'),
    lightbox: document.getElementById('lightbox'),
    lbImg: document.getElementById('lbImg'),
    lbCaption: document.getElementById('lbCaption'),
    about: document.getElementById('about')
  };

  var narrowMQ = window.matchMedia('(max-width: 767px)');

  /* ── helpers ───────────────────────────────────────────────── */

  function pad(n) { return String(n).padStart(2, '0'); }

  function altFor(p, i) {
    return p.caption ? p.caption : '作品 ' + pad(i + 1);
  }

  function isWide(p) {
    return (p.w || 800) / (p.h || 1000) >= WIDE_RATIO;
  }

  /* ── rendering ─────────────────────────────────────────────── */

  function buildShot(p, i) {
    var fig = document.createElement('figure');
    fig.className = 'shot';
    fig.dataset.index = String(i);
    fig.tabIndex = 0;
    fig.setAttribute('role', 'button');
    fig.setAttribute('aria-label', altFor(p, i) + '（放大檢視）');
    if (state.revealed[p.id]) fig.classList.add('shot--revealed');

    var img = document.createElement('img');
    img.src = p.src;
    img.alt = altFor(p, i);
    img.draggable = false;
    img.loading = i < 2 ? 'eager' : 'lazy';
    img.decoding = 'async';
    if (p.w && p.h) {
      img.width = p.w;
      img.height = p.h;
      img.style.aspectRatio = p.w + ' / ' + p.h;
    }
    // Offer every rendition we have so the browser can pick the smallest
    // file that still covers the slot — without a mid size it jumps
    // straight to the full-resolution original for a ~420px column.
    var set = [];
    if (p.thumb) set.push(p.thumb + ' ' + THUMB_WIDTH + 'w');
    if (p.mid) set.push(p.mid + ' ' + MID_WIDTH + 'w');
    if (p.w) set.push(p.src + ' ' + p.w + 'w');
    if (set.length > 1) {
      img.srcset = set.join(', ');
      img.sizes = '(max-width: 767px) 92vw, min(540px, 30vw)';
      // start from the mid size so a stale cache never pulls the big one
      if (p.mid) img.src = p.mid;
    }

    var cap = document.createElement('figcaption');
    var idx = document.createElement('span');
    idx.className = 'shot__index';
    idx.textContent = pad(i + 1);
    var text = document.createElement('p');
    text.className = 'shot__caption';
    text.textContent = p.caption || '';
    cap.appendChild(idx);
    cap.appendChild(text);

    fig.appendChild(img);
    fig.appendChild(cap);
    return fig;
  }

  /* Wide shots break the two-column rhythm and span the whole rail;
     everything between them is balanced across two columns by height. */
  function layout() {
    var frag = document.createDocumentFragment();
    var run = [];

    function flush() {
      if (!run.length) return;
      var block = document.createElement('div');
      block.className = 'block block--pair';

      if (state.narrow) {
        var only = document.createElement('div');
        only.className = 'col';
        run.forEach(function (item) { only.appendChild(buildShot(item.p, item.i)); });
        block.appendChild(only);
      } else {
        var a = document.createElement('div');
        var b = document.createElement('div');
        a.className = b.className = 'col';
        var hA = 0, hB = 0;
        run.forEach(function (item) {
          var ratio = (item.p.h || 1000) / (item.p.w || 800);
          if (hA <= hB) { a.appendChild(buildShot(item.p, item.i)); hA += ratio + 0.08; }
          else { b.appendChild(buildShot(item.p, item.i)); hB += ratio + 0.08; }
        });
        block.appendChild(a);
        block.appendChild(b);
      }

      frag.appendChild(block);
      run = [];
    }

    state.photos.forEach(function (p, i) {
      if (isWide(p)) {
        flush();
        var wide = document.createElement('div');
        wide.className = 'block block--wide';
        wide.appendChild(buildShot(p, i));
        frag.appendChild(wide);
      } else {
        run.push({ p: p, i: i });
      }
    });
    flush();

    el.gallery.textContent = '';

    if (!state.photos.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'NO PHOTOS YET';
      el.gallery.appendChild(empty);
      return;
    }

    el.gallery.appendChild(frag);
    observeShots();
  }

  /* ── reveal on scroll ──────────────────────────────────────── */

  var io = null;

  function observeShots() {
    if (!('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(el.gallery.querySelectorAll('.shot'), function (n) {
        n.classList.add('shot--revealed');
      });
      return;
    }
    if (!io) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          io.unobserve(e.target);
          var p = state.photos[Number(e.target.dataset.index)];
          if (p) state.revealed[p.id] = true;
          e.target.classList.add('shot--revealed');
        });
      }, { rootMargin: '0px 0px -12% 0px' });
    }
    Array.prototype.forEach.call(el.gallery.querySelectorAll('.shot'), function (n, k) {
      n.style.transitionDelay = (k % 2) * 90 + 'ms';
      if (!n.classList.contains('shot--revealed')) io.observe(n);
    });
  }

  /* ── hero parallax ─────────────────────────────────────────── */

  function onScroll() {
    if (!el.hero) return;
    var p = Math.min(1, Math.max(0, window.scrollY / Math.max(1, window.innerHeight)));
    var fade = String(Math.max(0, 1 - p / 0.22));
    if (el.heroName) el.heroName.style.opacity = fade;
    if (el.aboutBtn) {
      el.aboutBtn.style.opacity = fade;
      el.aboutBtn.style.pointerEvents = p > 0.2 ? 'none' : 'auto';
    }
    var img = el.heroImg;
    if (img && img.offsetWidth && img.offsetHeight) {
      var cover = Math.max(
        window.innerWidth / img.offsetWidth,
        window.innerHeight / img.offsetHeight
      );
      img.style.transform = 'scale(' + (1 + p * (cover - 1)) + ')';
    }
  }

  /* ── overlays ──────────────────────────────────────────────── */

  function openOverlay(node) {
    state.lastFocus = document.activeElement;
    node.hidden = false;
    node.classList.remove('is-closing');
    var focusable = node.querySelector('button');
    if (focusable) focusable.focus();
  }

  function closeOverlay(node, done) {
    if (node.hidden || node.classList.contains('is-closing')) return;
    node.classList.add('is-closing');
    setTimeout(function () {
      node.hidden = true;
      node.classList.remove('is-closing');
      if (done) done();
      if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
    }, 220);
  }

  function openLightbox(i) {
    if (i < 0 || i >= state.photos.length) return;
    state.openIndex = i;
    paintLightbox(0);
    openOverlay(el.lightbox);
  }

  function paintLightbox(dir) {
    var p = state.photos[state.openIndex];
    if (!p) return;
    el.lbImg.classList.remove('slide-next', 'slide-prev');
    // force reflow so the animation restarts on repeated steps
    void el.lbImg.offsetWidth;
    el.lbImg.src = p.src;
    el.lbImg.alt = altFor(p, state.openIndex);
    el.lbCaption.textContent = p.caption || '';
    if (dir > 0) el.lbImg.classList.add('slide-next');
    else if (dir < 0) el.lbImg.classList.add('slide-prev');
    preload(state.openIndex + 1);
    preload(state.openIndex - 1);
  }

  function preload(i) {
    var p = state.photos[(i + state.photos.length) % state.photos.length];
    if (!p) return;
    var img = new Image();
    img.src = p.src;
  }

  function step(dir) {
    if (state.openIndex < 0 || !state.photos.length) return;
    state.openIndex = (state.openIndex + dir + state.photos.length) % state.photos.length;
    paintLightbox(dir);
  }

  function closeLightbox() {
    closeOverlay(el.lightbox, function () { state.openIndex = -1; });
  }

  /* ── profile ───────────────────────────────────────────────── */

  function paintProfile(profile, heroPhoto) {
    var name = profile.name || 'Portfolio';
    document.title = name + ' — 攝影作品集';
    document.getElementById('heroName').textContent = name;
    document.getElementById('footName').textContent = name.toUpperCase();
    document.getElementById('aboutName').textContent = name;
    document.getElementById('year').textContent = String(new Date().getFullYear());

    document.getElementById('bioZh').textContent = profile.bioZh || '';
    document.getElementById('bioEn').textContent = profile.bioEn || '';

    var links = document.getElementById('aboutLinks');
    links.textContent = '';
    if (profile.email) {
      var mail = document.createElement('a');
      mail.href = 'mailto:' + profile.email;
      mail.textContent = profile.email;
      links.appendChild(mail);
    }
    if (profile.instagram) {
      var handle = String(profile.instagram).replace(/^@/, '');
      var ig = document.createElement('a');
      ig.href = /^https?:/.test(handle) ? handle : 'https://instagram.com/' + handle;
      ig.target = '_blank';
      ig.rel = 'noreferrer noopener';
      ig.textContent = 'Instagram';
      links.appendChild(ig);
    }

    var portrait = document.getElementById('aboutPortrait');
    if (profile.portrait) {
      portrait.src = profile.portrait;
      portrait.alt = name;
      portrait.hidden = false;
    }

    // index.html already points at the cover for a fast first paint —
    // only swap if the committed cover has moved on since.
    if (heroPhoto) {
      if (el.heroImg.getAttribute('src') !== heroPhoto.src) el.heroImg.src = heroPhoto.src;
      el.heroImg.alt = altFor(heroPhoto, 0);
    }
  }

  /* ── events ────────────────────────────────────────────────── */

  el.gallery.addEventListener('click', function (e) {
    var shot = e.target.closest('.shot');
    if (shot) openLightbox(Number(shot.dataset.index));
  });

  el.gallery.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var shot = e.target.closest('.shot');
    if (!shot) return;
    e.preventDefault();
    openLightbox(Number(shot.dataset.index));
  });

  el.lightbox.addEventListener('click', function (e) {
    if (e.target.closest('#lbPanel')) return;
    if (e.target.id === 'lbPrev') { step(-1); return; }
    if (e.target.id === 'lbNext') { step(1); return; }
    closeLightbox();
  });

  document.getElementById('lbClose').addEventListener('click', closeLightbox);
  el.aboutBtn.addEventListener('click', function () { openOverlay(el.about); });
  document.getElementById('aboutClose').addEventListener('click', function () {
    closeOverlay(el.about);
  });
  el.about.addEventListener('click', function (e) {
    if (!e.target.closest('#aboutPanel')) closeOverlay(el.about);
  });

  window.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (typing) return;
    if (!el.lightbox.hidden) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); return; }
      if (e.key === 'Escape') { closeLightbox(); return; }
    }
    if (!el.about.hidden && e.key === 'Escape') closeOverlay(el.about);
  });

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  if (el.heroImg) el.heroImg.addEventListener('load', onScroll);

  function onBreakpoint(e) {
    if (e.matches === state.narrow) return;
    state.narrow = e.matches;
    layout();
  }
  if (narrowMQ.addEventListener) narrowMQ.addEventListener('change', onBreakpoint);
  else narrowMQ.addListener(onBreakpoint);

  /* ── boot ──────────────────────────────────────────────────── */

  state.narrow = narrowMQ.matches;

  // index.html starts this fetch in <head>; fall back if that script
  // was stripped or failed to run.
  (window.__photos || fetch(DATA_URL, { cache: 'no-cache' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }))
    .then(function (data) {
      state.photos = Array.isArray(data.photos) ? data.photos : [];
      state.profile = data.profile || {};
      var hero = state.photos.filter(function (p) { return p.id === data.hero; })[0]
        || state.photos[0];
      paintProfile(state.profile, hero);
      layout();
      onScroll();
    })
    .catch(function (err) {
      console.error('[portfolio] 無法載入 ' + DATA_URL, err);
      el.gallery.innerHTML =
        '<div class="empty">照片資料載入失敗，請稍後再試。</div>';
    });
})();
