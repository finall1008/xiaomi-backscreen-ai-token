function asyncGeneratorStep(n, t, e, r, o, a, c) { try { var i = n[a](c), u = i.value; } catch (n) { return void e(n); } i.done ? t(u) : Promise.resolve(u).then(r, o); }
function _asyncToGenerator(n) { return function () { var t = this, e = arguments; return new Promise(function (r, o) { var a = n.apply(t, e); function _next(n) { asyncGeneratorStep(a, r, o, _next, _throw, "next", n); } function _throw(n) { asyncGeneratorStep(a, r, o, _next, _throw, "throw", n); } _next(void 0); }); }; }
// 壁纸库与常显展示快照。无 DOM、网络或凭据；三端共用同一格式。
(function () {
  'use strict';

  var KEY = 'display.wallpapers';
  var PAGE_KEY = 'display.page';
  var LOCAL_KEY = 'aiUsage.presentation';
  var MAX_SNAPSHOT_CHARS = 800 * 1024;
  var JPEG = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/;
  function parsed(value) {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }
  function image(value) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.id) || typeof value.sharp !== 'string' || !JPEG.test(value.sharp) || typeof value.blur !== 'string' || !JPEG.test(value.blur) || value.sharp.length > 180 * 1024 || value.blur.length > 30 * 1024) return null;
    return {
      id: value.id,
      name: typeof value.name === 'string' ? value.name : '壁纸',
      sharp: value.sharp,
      blur: value.blur,
      width: Number(value.width) || 912,
      height: Number(value.height) || 596
    };
  }
  function normalize(value) {
    value = parsed(value);
    var images = [],
      ids = [];
    var source = value && Array.isArray(value.images) ? value.images : [];
    source.forEach(function (entry) {
      var item = image(entry);
      if (!item || ids.indexOf(item.id) !== -1) return;
      ids.push(item.id);
      images.push(item);
    });
    return {
      revision: value && typeof value.revision === 'number' ? value.revision : 0,
      images: images
    };
  }
  function buildSnapshot(config, previous, appearance) {
    previous = previous || {};
    var next = {
      schemaVersion: 1,
      config: config
    };
    if (typeof previous.page === 'string') next.page = previous.page;
    var view = normalize(appearance === undefined ? previous.appearance : appearance);
    if (view.images.length || view.revision) next.appearance = view;
    if (view.images.some(function (entry) {
      return entry.id === previous.wallpaperId;
    })) {
      next.wallpaperId = previous.wallpaperId;
    }
    if (JSON.stringify(next).length > MAX_SNAPSHOT_CHARS) {
      throw new Error('壁纸与用量的常显快照合计超过 800K，请减少图片或选择更易压缩的图片。');
    }
    return next;
  }

  // bridge_snapshot 会在新运行环境收到首个共享快照时被替换。
  // 页码与轮换位置另存原生同步 localStorage，避免刚翻页便熄屏时被尚未确认的旧副本覆盖。
  function restoreLocal(storage, snapshot) {
    if (!storage) return snapshot;
    try {
      var saved = parsed(storage.getItem(LOCAL_KEY));
      if (!saved) return snapshot;
      if (typeof saved.page === 'string') snapshot.page = saved.page;
      if (saved.appearanceRevision === normalize(snapshot.appearance).revision && typeof saved.wallpaperId === 'string') snapshot.wallpaperId = saved.wallpaperId;
    } catch (_) {/* 无原生本地存储时仍使用桥快照。 */}
    return snapshot;
  }
  function saveLocal(storage, snapshot) {
    if (!storage) return;
    try {
      storage.setItem(LOCAL_KEY, JSON.stringify({
        page: snapshot.page,
        wallpaperId: snapshot.wallpaperId,
        appearanceRevision: normalize(snapshot.appearance).revision
      }));
    } catch (_) {/* 共享快照与 bridge.storage 仍按原协议保存。 */}
  }

  // 卡片启动及息屏恢复时调用；数据刷新和预览更新不会推进轮换。
  function advance(snapshot) {
    var next = buildSnapshot(snapshot.config, snapshot);
    var images = normalize(next.appearance).images;
    if (!images.length) return {
      snapshot: next,
      wallpaper: null
    };
    var index = -1;
    images.forEach(function (entry, i) {
      if (entry.id === next.wallpaperId) index = i;
    });
    var selected = images[(index + 1) % images.length];
    next.wallpaperId = selected.id;
    return {
      snapshot: next,
      wallpaper: selected
    };
  }
  function read(_x) {
    return _read.apply(this, arguments);
  }
  function _read() {
    _read = _asyncToGenerator(function* (storage) {
      var catalog = parsed(yield storage.get(KEY));
      var entries = catalog && Array.isArray(catalog.images) ? catalog.images : [];
      var images = [];
      // 背屏的大值逐个读，不能 Promise.all 进入同一批 HostVar 返回。
      for (var i = 0; i < entries.length; i++) {
        var id = typeof entries[i] === 'string' ? entries[i] : entries[i] && entries[i].id;
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) continue;
        var value = image(parsed(yield storage.get('wallpaper.' + id)));
        if (value && value.id === id) images.push(value);
      }
      return normalize({
        revision: catalog && catalog.revision,
        images: images
      });
    });
    return _read.apply(this, arguments);
  }
  function save(_x2, _x3) {
    return _save.apply(this, arguments);
  }
  function _save() {
    _save = _asyncToGenerator(function* (storage, images) {
      var next = normalize({
        images: images
      });
      if (!Array.isArray(images) || next.images.length !== images.length) {
        throw new Error('壁纸数据无效，请重新选择图片。');
      }
      buildSnapshot({
        providers: []
      }, null, next);
      var old = parsed(yield storage.get(KEY));
      next.revision = Math.max(Date.now(), (old && Number(old.revision) || 0) + 1);
      for (var i = 0; i < next.images.length; i++) {
        yield storage.set('wallpaper.' + next.images[i].id, next.images[i]);
      }
      yield storage.set(KEY, {
        revision: next.revision,
        images: next.images.map(function (entry) {
          return entry.id;
        })
      });
      var prior = old && Array.isArray(old.images) ? old.images : [];
      for (var j = 0; j < prior.length; j++) {
        var id = typeof prior[j] === 'string' ? prior[j] : prior[j] && prior[j].id;
        if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id) && !next.images.some(function (entry) {
          return entry.id === id;
        })) {
          yield storage.remove('wallpaper.' + id);
        }
      }
      return next;
    });
    return _save.apply(this, arguments);
  }
  window.AiUsageAppearance = {
    KEY: KEY,
    PAGE_KEY: PAGE_KEY,
    MAX_SNAPSHOT_CHARS: MAX_SNAPSHOT_CHARS,
    normalize: normalize,
    buildSnapshot: buildSnapshot,
    advance: advance,
    restoreLocal: restoreLocal,
    saveLocal: saveLocal,
    read: read,
    save: save
  };
})();