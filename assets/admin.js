/* Portfolio admin — commits straight to GitHub, no server involved.

   Model:
     draft      the photos.json we are about to publish
     pending    path -> { base64, url } for images not yet committed
     deletions  paths that exist on GitHub and should be removed
   Publishing turns all three into ONE commit via the git data API, so the
   site rebuilds once instead of once per file. */
(function () {
  'use strict';

  var CFG_KEY = 'pf-admin-cfg';
  var TOKEN_KEY = 'pf-admin-token';
  var DATA_PATH = 'data/photos.json';
  var MAX_EDGE = 2400;
  var THUMB_EDGE = 600;
  var API = 'https://api.github.com';

  var cfg = { owner: '', repo: '', branch: 'main' };
  var token = '';
  var draft = null;
  var remoteJson = '';                 // last known committed photos.json
  var pending = new Map();
  var deletions = new Set();
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
        remoteJson = text;
        draft = JSON.parse(text);
      })
      .catch(function (err) {
        if (err.status !== 404) throw err;
        remoteJson = '';
        draft = blankDraft();
        toast('repo 裡還沒有 ' + DATA_PATH + '，會在第一次發佈時建立');
      })
      .then(function () {
        if (!draft.profile) draft.profile = blankDraft().profile;
        if (!Array.isArray(draft.photos)) draft.photos = [];
        pending.clear();
        deletions.clear();
        $('repoChip').textContent = cfg.owner + '/' + cfg.repo + ' · ' + cfg.branch;
        $('profilePanel').hidden = false;
        $('photosPanel').hidden = false;
        $('connectPanel').hidden = true;
        fillProfile();
        render();
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
      var small = fit(srcW, srcH, THUMB_EDGE);
      return Promise.all([encode(bitmap, full, 0.82), encode(bitmap, small, 0.72)])
        .then(function (out) {
          var id = slugify(file.name) + '-' + Date.now().toString(36) +
            Math.random().toString(36).slice(2, 5);
          var srcPath = 'photos/' + id + '.' + out[0].ext;
          var thumbPath = 'photos/' + id + '-thumb.' + out[1].ext;
          return Promise.all([toBase64(out[0].blob), toBase64(out[1].blob)])
            .then(function (b64) {
              pending.set(srcPath, { base64: b64[0], url: URL.createObjectURL(out[0].blob) });
              pending.set(thumbPath, { base64: b64[1], url: URL.createObjectURL(out[1].blob) });
              if (bitmap.close) bitmap.close();
              return {
                id: id,
                src: srcPath,
                thumb: thumbPath,
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
    [p.src, p.thumb].forEach(function (path) {
      if (!path) return;
      if (pending.has(path)) {
        URL.revokeObjectURL(pending.get(path).url);
        pending.delete(path);       // never committed — nothing to delete remotely
      } else {
        deletions.add(path);
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
      out = out.replace(/(<title>)[^<]*(<\/title>)/, '$1' + name + ' — 攝影作品集$2');
      out = out.replace(/(<meta property="og:title" content=")[^"]*(")/,
        '$1' + name + ' — 攝影作品集$2');
    }
    return out === html ? null : out;
  }

  /* ── publish ───────────────────────────────────────────────── */

  function serialize() {
    return JSON.stringify({
      version: 1,
      hero: draft.hero,
      profile: draft.profile,
      photos: draft.photos.map(function (p) {
        return { id: p.id, src: p.src, thumb: p.thumb, w: p.w, h: p.h, caption: p.caption || '' };
      })
    }, null, 2) + '\n';
  }

  function changeCount() {
    var jsonChanged = serialize() !== remoteJson ? 1 : 0;
    return (pending.size / 2 | 0) + deletions.size + jsonChanged;
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
    var json = serialize();
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
        if (paths.length) msg += '（新增 ' + (paths.length / 2 | 0) + '）';
        if (deletions.size) msg += '（刪除 ' + (deletions.size / 2 | 0) + '）';
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

  loadCfg();
  if (cfg.owner && cfg.repo && token) connect();
})();
