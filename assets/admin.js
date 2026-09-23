/* Portfolio admin — commits straight to GitHub, no server involved.

   Model:
     draft      the photos.json we are about to publish
     pending    path -> { base64, url } for images not yet committed
     deletions  paths that exist on GitHub and should be removed
                (deletedIds counts those by photo, for the UI's benefit)
   Publishing turns all three into ONE commit via the git data API, so the
   site rebuilds once instead of once per file. */
(function () {
  'use strict';

  var CFG_KEY = 'pf-admin-cfg';
  var TOKEN_KEY = 'pf-admin-token';
  var DATA_PATH = 'data/photos.json';
  var MAX_EDGE = 2400;
  var MID_EDGE = 1200;       // what the grid actually shows
  var THUMB_EDGE = 600;
  var RENDITIONS = 3;        // src + mid + thumb per photo
  var API = 'https://api.github.com';

  var cfg = { owner: '', repo: '', branch: 'main' };
  var token = '';
  var draft = null;
  var remoteJson = '';                 // committed photos.json, canonicalized
  var remoteExists = false;            // false until we have seen it on GitHub
  var pending = new Map();
  var deletions = new Set();
  var deletedIds = new Set();          // deletions counted by photo, not by file
  var drag = null;

  var $ = function (id) { return document.getElementById(id); };

  /* ── status / toast ────────────────────────────────────────── */

  function status(text, kind) {
    var s = $('status');
    s.textContent = text || '';
    s.className = 'status' + (kind ? ' status--' + kind : '');
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' toast--err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isErr ? 7000 : 3500);
  }

  /* ── github api ────────────────────────────────────────────── */

  function gh(path, opts) {
    opts = opts || {};
    var url = API + '/repos/' + cfg.owner + '/' + cfg.repo + path;
    var init = {
      method: opts.method || 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Authorization': 'Bearer ' + token
      }
    };
    if (opts.body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(url, init).then(function (res) {
      if (res.status === 204) return null;
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok) return data;
        var err = new Error(explain(res.status, data));
        err.status = res.status;
        throw err;
      });
    });
  }

  function explain(code, data) {
    var detail = data && data.message ? data.message : '';
    if (code === 401) return 'Token 無效或已過期（401）';
    if (code === 403) return 'Token 權限不足，需要 Contents: Read and write（403）';
    if (code === 404) return ' 找不到 ' + cfg.owner + '/' + cfg.repo + '，或 token 沒有這個 repo 的權限（404）';
    if (code === 409) return '遠端已經有新的 commit，請重新載入後再發佈（409）';
    if (code === 422) return '送出的內容被拒絕：' + detail + '（422）';
    return 'GitHub 回應 ' + code + '：' + detail;
  }

  /* ── config ────────────────────────────────────────────────── */

  function loadCfg() {
    try {
      var saved = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
      cfg.owner = saved.owner || '';
      cfg.repo = saved.repo || '';
      cfg.branch = saved.branch || 'main';
      token = localStorage.getItem(TOKEN_KEY) || '';
    } catch (e) { /* first run */ }
    $('fOwner').value = cfg.owner;
    $('fRepo').value = cfg.repo;
    $('fBranch').value = cfg.branch;
    $('fToken').value = token;
  }

  function saveCfg() {
    cfg.owner = $('fOwner').value.trim();
    cfg.repo = $('fRepo').value.trim();
    cfg.branch = $('fBranch').value.trim() || 'main';
    token = $('fToken').value.trim();
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    localStorage.setItem(TOKEN_KEY, token);
  }

  /* ── load ──────────────────────────────────────────────────── */

  function blankDraft() {
    return {
      version: 1,
      hero: '',
      profile: { name: '', bioZh: '', bioEn: '', email: '', instagram: '', portrait: '' },
      photos: []
    };
  }

  function connect() {
    saveCfg();
    if (!cfg.owner || !cfg.repo || !token) {
      toast('請填完帳號、repo 和 token', true);
      return;
    }
    status('連線中…', 'busy');
    gh('/contents/' + DATA_PATH + '?ref=' + encodeURIComponent(cfg.branch))
      .then(function (file) {
        var text = decodeURIComponent(escape(atob(file.content.replace(/\s/g, ''))));
        draft = JSON.parse(text);
        remoteExists = true;
      })
      .catch(function (err) {
        if (err.status !== 404) throw err;
        draft = blankDraft();
        remoteExists = false;
        toast('repo 裡還沒有 ' + DATA_PATH + '，會在第一次發佈時建立');
      })
      .then(function () {
        if (!draft.profile) draft.profile = blankDraft().profile;
        if (!Array.isArray(draft.photos)) draft.photos = [];
        // '' while the repo has no photos.json yet, so the first publish counts
        remoteJson = remoteExists ? serialize(draft) : '';
        pending.clear();
        deletions.clear();
        deletedIds.clear();
        $('repoChip').textContent = cfg.owner + '/' + cfg.repo + ' · ' + cfg.branch;
        $('profilePanel').hidden = false;
        $('photosPanel').hidden = false;
        $('connectPanel').hidden = true;
        fillProfile();
        render();
        renderStats();          // top-photo list can now show thumbnails
        markDirty();
        status('已連線', 'ok');
      })
      .catch(function (err) {
        console.error(err);
        status('連線失敗', 'err');
        toast(err.message, true);
      });
  }

  /* ── profile ───────────────────────────────────────────────── */

  var PROFILE_FIELDS = [
    ['pName', 'name'], ['pEmail', 'email'], ['pIg', 'instagram'],
    ['pBioZh', 'bioZh'], ['pBioEn', 'bioEn'], ['pPortrait', 'portrait']
  ];

  function fillProfile() {
    PROFILE_FIELDS.forEach(function (pair) {
      $(pair[0]).value = draft.profile[pair[1]] || '';
    });
  }

  PROFILE_FIELDS.forEach(function (pair) {
    $(pair[0]).addEventListener('input', function () {
      if (!draft) return;
      draft.profile[pair[1]] = this.value;
      markDirty();
    });
  });

  /* ── image processing ──────────────────────────────────────── */

  function fit(w, h, max) {
    if (w <= max && h <= max) return { w: w, h: h };
    var scale = max / Math.max(w, h);
    return { w: Math.round(w * scale), h: Math.round(h * scale) };
  }

  function loadBitmap(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return loadViaImg(file); });
    }
    return loadViaImg(file);
  }

  function loadViaImg(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('無法讀取圖片')); };
      img.src = url;
    });
  }

  function encode(bitmap, size, quality) {
    var canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, size.w, size.h);
    return new Promise(function (res) {
      canvas.toBlob(function (blob) {
        if (blob && blob.type === 'image/webp') { res({ blob: blob, ext: 'webp' }); return; }
        canvas.toBlob(function (jpg) { res({ blob: jpg, ext: 'jpg' }); }, 'image/jpeg', quality);
      }, 'image/webp', quality);
    });
  }

  function toBase64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(',')[1]); };
      r.onerror = function () { rej(r.error); };
      r.readAsDataURL(blob);
    });
  }

  function slugify(name) {
    return name.replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'photo';
  }

  function processFile(file) {
    return loadBitmap(file).then(function (bitmap) {
      var srcW = bitmap.width || bitmap.naturalWidth;
      var srcH = bitmap.height || bitmap.naturalHeight;
      var full = fit(srcW, srcH, MAX_EDGE);
      var mid = fit(srcW, srcH, MID_EDGE);
      var small = fit(srcW, srcH, THUMB_EDGE);
      return Promise.all([
        encode(bitmap, full, 0.82),
        encode(bitmap, mid, 0.78),
        encode(bitmap, small, 0.72)
      ]).then(function (out) {
          var id = slugify(file.name) + '-' + Date.now().toString(36) +
            Math.random().toString(36).slice(2, 5);
          var paths = [
            'photos/' + id + '.' + out[0].ext,
            'photos/' + id + '-mid.' + out[1].ext,
            'photos/' + id + '-thumb.' + out[2].ext
          ];
          return Promise.all(out.map(function (o) { return toBase64(o.blob); }))
            .then(function (b64) {
              paths.forEach(function (path, k) {
                pending.set(path, {
                  base64: b64[k],
                  url: URL.createObjectURL(out[k].blob)
                });
              });
              if (bitmap.close) bitmap.close();
              return {
                id: id,
                src: paths[0],
                mid: paths[1],
                thumb: paths[2],
                w: full.w,
                h: full.h,
                caption: '',
                _bytes: out[0].blob.size
              };
            });
        });
    });
  }

  function addFiles(list) {
    var files = Array.prototype.filter.call(list || [], function (f) {
      return f.type.indexOf('image/') === 0;
    });
    if (!files.length) return;
    status('壓縮中 0/' + files.length, 'busy');

    var done = 0;
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        return processFile(f).then(function (photo) {
          draft.photos.push(photo);
          done++;
          status('壓縮中 ' + done + '/' + files.length, 'busy');
          render();
        }).catch(function (err) {
          console.error(err);
          toast(f.name + '：' + err.message, true);
        });
      });
    });

    chain.then(function () {
      if (!draft.hero && draft.photos.length) draft.hero = draft.photos[0].id;
      markDirty();
      render();
      status('已加入 ' + done + ' 張，尚未發佈', 'warn');
    });
  }

  /* ── cards ─────────────────────────────────────────────────── */

  function previewSrc(p) {
    var hit = pending.get(p.thumb) || pending.get(p.src);
    return hit ? hit.url : (p.thumb || p.src);
  }

  function render() {
    var host = $('cards');
    host.textContent = '';
    $('countChip').textContent = String(draft.photos.length).padStart(2, '0');
    $('emptyHint').hidden = draft.photos.length > 0;

    draft.photos.forEach(function (p, i) {
      var card = document.createElement('div');
      card.className = 'card' + (pending.has(p.src) ? ' is-new' : '');
      card.dataset.id = p.id;

      var img = document.createElement('img');
      img.className = 'card__thumb';
      img.src = previewSrc(p);
      img.alt = '';
      img.draggable = false;
      card.appendChild(img);

      var body = document.createElement('div');
      body.className = 'card__body';

      var meta = document.createElement('div');
      meta.className = 'card__meta';
      var num = document.createElement('span');
      num.textContent = String(i + 1).padStart(2, '0') + ' · ' + p.w + '×' + p.h;
      meta.appendChild(num);
      if (draft.hero === p.id) {
        var cover = document.createElement('span');
        cover.className = 'badge badge--cover';
        cover.textContent = '封面';
        meta.appendChild(cover);
      } else if (pending.has(p.src)) {
        var isNew = document.createElement('span');
        isNew.className = 'badge badge--new';
        isNew.textContent = '未發佈';
        meta.appendChild(isNew);
      }
      body.appendChild(meta);

      var cap = document.createElement('input');
      cap.className = 'card__caption';
      cap.value = p.caption || '';
      cap.placeholder = '照片說明（可留空）';
      cap.addEventListener('input', function () { p.caption = this.value; markDirty(); });
      body.appendChild(cap);

      var actions = document.createElement('div');
      actions.className = 'card__actions';
      actions.appendChild(mkBtn('◀', '往前移', function () { move(i, -1); }));
      actions.appendChild(mkBtn('▶', '往後移', function () { move(i, 1); }));
      actions.appendChild(mkBtn('封面', '設為封面', function () {
        draft.hero = p.id; markDirty(); render();
      }));
      var del = mkBtn('刪除', '刪除這張', function () { remove(i); });
      del.classList.add('btn--danger');
      actions.appendChild(del);
      body.appendChild(actions);

      card.appendChild(body);
      host.appendChild(card);

      img.addEventListener('pointerdown', function (e) { startDrag(e, card, p.id); });
    });
  }

  function mkBtn(label, title, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function move(i, dir) {
    var j = i + dir;
    if (j < 0 || j >= draft.photos.length) return;
    var moved = draft.photos.splice(i, 1)[0];
    draft.photos.splice(j, 0, moved);
    markDirty();
    render();
  }

  function remove(i) {
    var p = draft.photos[i];
    if (!window.confirm('確定要刪除第 ' + (i + 1) + ' 張？發佈後才會真的從網站移除。')) return;
    [p.src, p.mid, p.thumb].forEach(function (path) {
      if (!path) return;
      if (pending.has(path)) {
        URL.revokeObjectURL(pending.get(path).url);
        pending.delete(path);       // never committed — nothing to delete remotely
      } else {
        deletions.add(path);
        deletedIds.add(p.id);       // a photo is one change, not three files
      }
    });
    draft.photos.splice(i, 1);
    if (draft.hero === p.id) draft.hero = draft.photos.length ? draft.photos[0].id : '';
    markDirty();
    render();
  }

  /* ── drag to reorder ───────────────────────────────────────── */

  function rects() {
    var map = {};
    Array.prototype.forEach.call($('cards').children, function (c) {
      map[c.dataset.id] = c.getBoundingClientRect();
    });
    return map;
  }

  function flip(before) {
    Array.prototype.forEach.call($('cards').children, function (c) {
      var b = before[c.dataset.id];
      if (!b) return;
      var a = c.getBoundingClientRect();
      var dx = b.left - a.left, dy = b.top - a.top;
      if (drag && c === drag.el) {
        drag.adjX += dx;
        drag.adjY += dy;
        applyDrag();
        return;
      }
      if (!dx && !dy) return;
      c.style.transition = 'none';
      c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      c.getBoundingClientRect();
      requestAnimationFrame(function () {
        c.style.transition = 'transform 240ms cubic-bezier(.2,.8,.2,1)';
        c.style.transform = '';
      });
    });
  }

  function applyDrag() {
    if (!drag) return;
    drag.el.style.transform =
      'translate(' + (drag.dx + drag.adjX) + 'px,' + (drag.dy + drag.adjY) + 'px) scale(1.02)';
  }

  function startDrag(e, card, id) {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { id: id, el: card, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, adjX: 0, adjY: 0, moved: false };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }

  function onDragMove(e) {
    if (!drag) return;
    drag.dx = e.clientX - drag.sx;
    drag.dy = e.clientY - drag.sy;
    if (!drag.moved) {
      if (Math.abs(drag.dx) + Math.abs(drag.dy) < 5) return;
      drag.moved = true;
      drag.el.style.transition = 'none';
      drag.el.classList.add('is-dragging');
      drag.el.style.pointerEvents = 'none';
    }
    applyDrag();

    var under = document.elementFromPoint(e.clientX, e.clientY);
    var target = under && under.closest ? under.closest('.card') : null;
    if (!target || target === drag.el) return;

    var from = draft.photos.findIndex(function (p) { return p.id === drag.id; });
    var to = draft.photos.findIndex(function (p) { return p.id === target.dataset.id; });
    if (from < 0 || to < 0) return;

    var before = rects();
    draft.photos.splice(to, 0, draft.photos.splice(from, 1)[0]);
    var host = $('cards');
    if (to > from) host.insertBefore(drag.el, target.nextSibling);
    else host.insertBefore(drag.el, target);
    flip(before);
  }

  function endDrag() {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    if (!drag) return;
    var el = drag.el, moved = drag.moved;
    drag = null;
    el.style.transition = 'transform 220ms cubic-bezier(.2,.8,.2,1)';
    el.style.transform = '';
    setTimeout(function () {
      el.classList.remove('is-dragging');
      el.style.pointerEvents = '';
      el.style.transition = '';
    }, 240);
    if (moved) { markDirty(); render(); }
  }

  /* ── keep index.html's static meta in sync ─────────────────── */

  /* app.js fills the page in at runtime, but crawlers and社群 previews read
     the raw HTML — so the cover image and name are patched into it too.
     Returns null when nothing needed changing. */
  function patchIndex(html) {
    var cover = draft.photos.filter(function (p) { return p.id === draft.hero; })[0]
      || draft.photos[0];
    var name = (draft.profile.name || '').trim();
    var out = html;

    if (cover) {
      // og:image has to be absolute for social previews — reuse og:url as the base
      var base = (html.match(/<meta property="og:url" content="([^"]*)"/) || [])[1] || '';
      out = out.replace(/(<meta property="og:image" content=")[^"]*(")/,
        '$1' + base + cover.src + '$2');
      out = out.replace(/(<img class="hero__img" id="heroImg" src=")[^"]*(")/,
        '$1' + cover.src + '$2');
    }
    if (name) {
      out = out.replace(/(<title>)[^<]*(<\/title>)/, '$1' + name + '$2');
      out = out.replace(/(<meta property="og:title" content=")[^"]*(")/,
        '$1' + name + ' — 攝影作品集$2');
    }
    return out === html ? null : out;
  }

  /* ── publish ───────────────────────────────────────────────── */

  /* The canonical form of photos.json. Both the draft and whatever is
     committed are run through this before they are compared, so a file
     whose keys sit in a different order than we write them does not look
     like a pending change forever. */
  function serialize(data) {
    return JSON.stringify({
      version: 1,
      hero: data.hero,
      profile: data.profile,
      photos: data.photos.map(function (p) {
        return {
          id: p.id, src: p.src, mid: p.mid, thumb: p.thumb,
          w: p.w, h: p.h, caption: p.caption || ''
        };
      })
    }, null, 2) + '\n';
  }

  function changeCount() {
    var jsonChanged = serialize(draft) !== remoteJson ? 1 : 0;
    return (pending.size / RENDITIONS | 0) + deletedIds.size + jsonChanged;
  }

  function markDirty() {
    var n = changeCount();
    $('publishBtn').disabled = n === 0;
    $('publishBtn').textContent = n ? '發佈（' + n + ' 項變更）' : '發佈';
  }

  function syncIndex(tree) {
    return gh('/contents/index.html?ref=' + encodeURIComponent(cfg.branch))
      .then(function (file) {
        var html = decodeURIComponent(escape(atob(file.content.replace(/\s/g, ''))));
        var patched = patchIndex(html);
        if (patched) {
          tree.push({ path: 'index.html', mode: '100644', type: 'blob', content: patched });
        }
      })
      .catch(function (err) {
        // a missing or unreadable index.html must not block publishing photos
        console.warn('index.html 未同步:', err.message);
      });
  }

  function publish() {
    if (!draft) return;
    var json = serialize(draft);
    var paths = Array.from(pending.keys());
    $('publishBtn').disabled = true;
    status('發佈中…', 'busy');

    var baseSha, baseTree;

    gh('/git/ref/heads/' + encodeURIComponent(cfg.branch))
      .then(function (ref) {
        baseSha = ref.object.sha;
        return gh('/git/commits/' + baseSha);
      })
      .then(function (commit) {
        baseTree = commit.tree.sha;
        var tree = [];
        var chain = Promise.resolve();
        paths.forEach(function (path, i) {
          chain = chain.then(function () {
            status('上傳中 ' + (i + 1) + '/' + paths.length, 'busy');
            return gh('/git/blobs', {
              method: 'POST',
              body: { content: pending.get(path).base64, encoding: 'base64' }
            }).then(function (blob) {
              tree.push({ path: path, mode: '100644', type: 'blob', sha: blob.sha });
            });
          });
        });
        return chain.then(function () {
          deletions.forEach(function (path) {
            tree.push({ path: path, mode: '100644', type: 'blob', sha: null });
          });
          tree.push({ path: DATA_PATH, mode: '100644', type: 'blob', content: json });
          return syncIndex(tree).then(function () {
            return gh('/git/trees', { method: 'POST', body: { base_tree: baseTree, tree: tree } });
          });
        });
      })
      .then(function (newTree) {
        var msg = 'portfolio: ' + draft.photos.length + ' 張照片';
        if (paths.length) msg += '（新增 ' + (paths.length / RENDITIONS | 0) + '）';
        if (deletedIds.size) msg += '（刪除 ' + deletedIds.size + '）';
        return gh('/git/commits', {
          method: 'POST',
          body: { message: msg, tree: newTree.sha, parents: [baseSha] }
        });
      })
      .then(function (commit) {
        return gh('/git/refs/heads/' + encodeURIComponent(cfg.branch), {
          method: 'PATCH',
          body: { sha: commit.sha }
        });
      })
      .then(function () {
        pending.forEach(function (item) { URL.revokeObjectURL(item.url); });
        pending.clear();
        deletions.clear();
        deletedIds.clear();
        remoteJson = json;
        markDirty();
        render();
        status('已發佈', 'ok');
        toast('已送出，GitHub Pages 約 30–60 秒後更新');
      })
      .catch(function (err) {
        console.error(err);
        status('發佈失敗', 'err');
        toast(err.message, true);
        markDirty();
      });
  }

  /* ── stats (GoatCounter) ───────────────────────────────────── */

  /* index.html reports to GoatCounter; this reads it back through the
     GoatCounter API (CORS-enabled, so no server needed). GoatCounter only
     counts unique visitors — reloading the page does not inflate anything.
     Lightbox opens arrive as events named photo/<id>. Independent of the
     GitHub connection: stats show even before connecting. */

  var GC_KEY = 'pf-admin-gc';
  var GC_TOKEN_KEY = 'pf-admin-gc-token';
  var STATS_DAYS = 30;
  var TOP_PHOTOS = 5;
  var WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  var gc = { code: 'helloworld-chrish', token: '' };
  var stats = null;        // { days: [{ key, date, n }], photos: [{ id, title, count }] }
  var sitePhotos = [];     // the deployed photos.json, for thumbnails before connecting

  function pad2(n) { return String(n).padStart(2, '0'); }

  function dayKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function shortDay(d) {
    return (d.getMonth() + 1) + '/' + d.getDate() + '（' + WEEKDAYS[d.getDay()] + '）';
  }

  function apiTime(d) { return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); }

  function loadGc() {
    try {
      gc.code = localStorage.getItem(GC_KEY) || gc.code;
      gc.token = localStorage.getItem(GC_TOKEN_KEY) || '';
    } catch (e) { /* storage blocked — form stays empty */ }
    $('gcCode').value = gc.code;
    $('gcToken').value = gc.token;
    syncTokenLink();
  }

  function saveGc() {
    gc.code = $('gcCode').value.trim().toLowerCase();
    gc.token = $('gcToken').value.trim();
    localStorage.setItem(GC_KEY, gc.code);
    localStorage.setItem(GC_TOKEN_KEY, gc.token);
    syncTokenLink();
  }

  function syncTokenLink() {
    $('gcTokenLink').href = 'https://' + (gc.code || 'www') + '.goatcounter.com/user/api';
  }

  function statsMsg(text, isErr) {
    var m = $('statsMsg');
    m.textContent = text || '';
    m.style.color = isErr ? 'var(--danger)' : '';
  }

  function loadStats() {
    if (!/^[a-z0-9-]+$/.test(gc.code) || !gc.token) {
      $('gcForm').hidden = false;
      statsMsg('填入 GoatCounter code 和 API token 後就能在這裡看每日訪客數。');
      return;
    }

    // One extra day of slack: GoatCounter buckets days in the site's own
    // timezone, so we ask for a little more and pick days by date string.
    var now = new Date();
    var start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - STATS_DAYS);
    var end = new Date(now);
    end.setMinutes(0, 0, 0);
    end.setHours(end.getHours() + 1);

    var url = 'https://' + gc.code + '.goatcounter.com/api/v0/stats/hits' +
      '?limit=200&start=' + encodeURIComponent(apiTime(start)) +
      '&end=' + encodeURIComponent(apiTime(end));

    $('statsRefresh').disabled = true;
    statsMsg('載入中…');

    fetch(url, { headers: { 'Authorization': 'Bearer ' + gc.token } })
      .catch(function () {
        throw new Error('連不到 GoatCounter。這台電腦的廣告／追蹤阻擋器（或 DNS 過濾）可能擋掉了 goatcounter.com，請把它加入允許清單。');
      })
      .then(function (res) {
        if (res.ok) {
          return res.json().catch(function () {
            throw new Error('回應不是 JSON，請求可能被本機的阻擋器或代理攔截了。');
          });
        }
        return res.text().catch(function () { return ''; }).then(function (body) {
          // What GoatCounter itself answers: 400 for an unknown site code,
          // 401 for a bad token. Anything else — 404 especially — usually
          // means something in front of it answered instead.
          var snippet = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
          if (res.status === 401 || res.status === 403) {
            throw new Error('GoatCounter token 無效或權限不足（需要 Read statistics）。');
          }
          if (res.status === 400) {
            throw new Error('GoatCounter 不認得 code「' + gc.code + '」，請確認。' + snippet);
          }
          throw new Error('回應 ' + res.status + '（不是 GoatCounter 的正常回應，可能被阻擋器或代理攔截）：' +
            (snippet || '（內容空白）'));
        });
      })
      .then(function (data) {
        stats = summarize(data, now);
        $('gcForm').hidden = true;
        var t = new Date();
        statsMsg('更新於 ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) +
          '。數字是不重複訪客；有裝廣告阻擋器的訪客不會被計入。');
        renderStats();
      })
      .catch(function (err) {
        console.error(err);
        statsMsg(err.message, true);
      })
      .then(function () { $('statsRefresh').disabled = false; });
  }

  function summarize(data, now) {
    var perDay = Object.create(null);
    var photos = [];

    (data.hits || []).forEach(function (h) {
      if (h.event) {
        if (String(h.path).indexOf('photo/') === 0) {
          photos.push({ id: h.path.slice(6), title: h.title || '', count: h.count || 0 });
        }
        return;
      }
      (h.stats || []).forEach(function (s) {
        perDay[s.day] = (perDay[s.day] || 0) + (s.daily || 0);
      });
    });

    var days = [];
    for (var k = STATS_DAYS - 1; k >= 0; k--) {
      var d = new Date(now);
      d.setHours(12, 0, 0, 0);            // noon: immune to DST edges
      d.setDate(d.getDate() - k);
      days.push({ key: dayKey(d), date: d, n: perDay[dayKey(d)] || 0 });
    }

    photos.sort(function (a, b) { return b.count - a.count; });
    return { days: days, photos: photos };
  }

  function renderStats() {
    if (!stats) return;
    $('statsBody').hidden = false;

    var days = stats.days;
    var sum = function (list) { return list.reduce(function (a, d) { return a + d.n; }, 0); };
    $('tToday').textContent = days[days.length - 1].n.toLocaleString();
    $('tWeek').textContent = sum(days.slice(-7)).toLocaleString();
    $('tMonth').textContent = sum(days).toLocaleString();

    renderChart(days);
    renderTop(stats.photos);
  }

  function renderChart(days) {
    var max = Math.max.apply(null, days.map(function (d) { return d.n; }));
    var bars = $('chartBars');
    var readout = $('chartReadout');
    var last = days[days.length - 1];

    function read(d) {
      readout.textContent = shortDay(d.date) + ' · ' + d.n.toLocaleString() + ' 位訪客';
    }

    bars.textContent = '';
    $('chartMax').textContent = max ? max.toLocaleString() : '';

    days.forEach(function (d) {
      var bar = document.createElement('div');
      bar.className = 'chart__bar' + (d === last ? ' is-today' : '');
      bar.tabIndex = 0;
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', shortDay(d.date) + ' ' + d.n + ' 位訪客');

      var fill = document.createElement('span');
      fill.className = 'chart__fill' + (d.n ? '' : ' is-zero');
      fill.style.height = d.n && max ? Math.max(2, d.n / max * 100) + '%' : '';
      bar.appendChild(fill);

      bar.addEventListener('pointerenter', function () { read(d); });
      bar.addEventListener('focus', function () { read(d); });
      bars.appendChild(bar);
    });

    bars.onpointerleave = function () { read(last); };
    bars.onfocusout = function () { read(last); };
    read(last);

    var axis = $('chartAxis');
    axis.textContent = '';
    [days[0], days[Math.floor(days.length / 2)], last].forEach(function (d, i) {
      var s = document.createElement('span');
      s.textContent = i === 2 ? '今天' : (d.date.getMonth() + 1) + '/' + d.date.getDate();
      axis.appendChild(s);
    });
  }

  function renderTop(list) {
    var host = $('topList');
    host.textContent = '';

    if (!list.length) {
      var none = document.createElement('li');
      none.className = 'toplist__empty';
      none.textContent = '還沒有資料——訪客在前台點開照片後就會出現在這裡。';
      host.appendChild(none);
      return;
    }

    var byId = Object.create(null);
    (draft ? draft.photos : sitePhotos).forEach(function (p) { byId[p.id] = p; });
    var top = list[0].count || 1;

    list.slice(0, TOP_PHOTOS).forEach(function (item) {
      var p = byId[item.id];
      var li = document.createElement('li');
      li.className = 'toplist__item';

      var img = document.createElement('img');
      img.className = 'toplist__thumb';
      img.alt = '';
      if (p) img.src = previewSrc(p);
      li.appendChild(img);

      var body = document.createElement('div');
      body.className = 'toplist__body';
      var name = document.createElement('span');
      name.className = 'toplist__name';
      name.textContent = (p && p.caption) || item.title || item.id;
      var meter = document.createElement('span');
      meter.className = 'toplist__meter';
      var fill = document.createElement('span');
      fill.style.width = (item.count / top * 100) + '%';
      meter.appendChild(fill);
      body.appendChild(name);
      body.appendChild(meter);
      li.appendChild(body);

      var count = document.createElement('span');
      count.className = 'toplist__count';
      count.textContent = item.count.toLocaleString() + ' 位';
      li.appendChild(count);

      host.appendChild(li);
    });
  }

  /* ── wiring ────────────────────────────────────────────────── */

  $('connectBtn').addEventListener('click', connect);
  $('publishBtn').addEventListener('click', publish);
  $('settingsBtn').addEventListener('click', function () {
    $('connectPanel').hidden = !$('connectPanel').hidden;
  });
  $('forgetBtn').addEventListener('click', function () {
    localStorage.removeItem(TOKEN_KEY);
    token = '';
    $('fToken').value = '';
    toast('已從這台電腦清除 token');
  });

  $('addBtn').addEventListener('click', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function () {
    addFiles(this.files);
    this.value = '';
  });

  var dz = $('dropzone');
  ['dragenter', 'dragover'].forEach(function (type) {
    dz.addEventListener(type, function (e) {
      if (!Array.prototype.includes.call(e.dataTransfer.types, 'Files')) return;
      e.preventDefault();
      dz.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    dz.addEventListener(type, function () { dz.classList.remove('is-over'); });
  });
  dz.addEventListener('drop', function (e) {
    if (!e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });

  window.addEventListener('beforeunload', function (e) {
    if (draft && changeCount() > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  $('statsRefresh').addEventListener('click', loadStats);
  $('statsSettings').addEventListener('click', function () {
    $('gcForm').hidden = !$('gcForm').hidden;
  });
  $('gcSave').addEventListener('click', function () { saveGc(); loadStats(); });
  $('gcForget').addEventListener('click', function () {
    localStorage.removeItem(GC_TOKEN_KEY);
    gc.token = '';
    $('gcToken').value = '';
    toast('已從這台電腦清除 GoatCounter token');
  });
  $('gcCode').addEventListener('input', function () {
    gc.code = this.value.trim().toLowerCase();
    syncTokenLink();
  });

  loadCfg();
  loadGc();
  loadStats();
  // admin.html is served next to the live site, so its photos.json is one
  // relative fetch away — enough to put faces on the top-photo list.
  fetch(DATA_PATH, { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !Array.isArray(data.photos)) return;
      sitePhotos = data.photos;
      renderStats();
    })
    .catch(function () { /* thumbnails are optional */ });
  if (cfg.owner && cfg.repo && token) connect();
})();
