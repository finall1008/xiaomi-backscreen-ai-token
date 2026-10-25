/*
 * 卡片外观 · 本机壁纸库（webroot/wallpapers.js）。
 *
 * 脚本顺序：bridge-shim.js → core.js → appearance.js（window.AiUsageAppearance）→ 本文件 → main.js。
 * 挂载：window.AiUsageWallpaperSettings.mount({ bridge, client, onChange })。
 * onChange 只收到当前用于预览的一张：null 或 {id, sharp, blur}，不会带上整个图库。
 *
 * 写入顺序：先用实际 cardConfig + display.page 做 buildSnapshot 校验，
 * 通过后才 appearance.save，再 await bridge.card.saveSnapshot(完整快照)，最后 requestRefresh。
 * 超过 800K 时不写入，保留原图库。没有 bridge 时禁用写入。
 */
(function () {
  'use strict';

  var SHARP_LIMIT = 180 * 1024;
  var BLUR_LIMIT = 30 * 1024;
  var INPUT_LIMIT = 25 * 1024 * 1024;
  var JPEG = /^data:image\/jpeg;base64,[A-Za-z0-9+\/]+=*$/;

  var bridge = null;
  var client = null;
  var onChange = null;
  var appearance = null;
  var images = [];
  var selectedId = null;
  var busy = false;
  var bound = false;
  var idCounter = 0;
  var canvasFilterSupport = null;
  var dom = {};

  function byId(id) { return document.getElementById(id); }

  function canWrite() {
    return !!(bridge && bridge.storage && client && appearance && !busy);
  }

  function isSizeError(error) {
    return !!(error && typeof error.message === 'string' && error.message.indexOf('800K') !== -1);
  }

  function asPage(value) {
    if (typeof value === 'number' && isFinite(value)) return String(value);
    if (typeof value !== 'string') return null;
    var text = value;
    if (text.charAt(0) === '"') {
      try {
        var parsed = JSON.parse(text);
        if (typeof parsed === 'string') text = parsed;
        else if (typeof parsed === 'number' && isFinite(parsed)) return String(parsed);
      } catch (_) { /* 保留原字符串。 */ }
    }
    return text ? text : null;
  }

  function imageName(file) {
    var name = String(file && file.name || '').replace(/[\r\n\t]/g, ' ').replace(/^\s+|\s+$/g, '');
    if (!name) name = '壁纸';
    return name.slice(0, 80);
  }

  function createId(used) {
    var id = '';
    do {
      idCounter += 1;
      id = ('w' + Date.now().toString(36) + idCounter.toString(36)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
    } while (!id || used[id]);
    used[id] = true;
    return id;
  }

  function isAllowedFile(file) {
    if (!file) return false;
    var type = String(file.type || '').toLowerCase();
    if (type === 'image/jpeg' || type === 'image/jpg' || type === 'image/png' || type === 'image/webp') return true;
    if (type && type !== 'application/octet-stream') return false;
    return /\.(jpe?g|png|webp)$/i.test(String(file.name || ''));
  }

  function canFilterCanvas() {
    if (canvasFilterSupport !== null) return canvasFilterSupport;
    try {
      var test = document.createElement('canvas');
      var ctx = test.getContext('2d');
      ctx.filter = 'blur(1px)';
      canvasFilterSupport = !!(ctx && ctx.filter === 'blur(1px)');
    } catch (_) {
      canvasFilterSupport = false;
    }
    return canvasFilterSupport;
  }

  function toJpeg(canvas, quality) {
    if (!canvas || typeof canvas.toDataURL !== 'function') throw new Error('浏览器不支持图片压缩。');
    var url = canvas.toDataURL('image/jpeg', quality);
    if (typeof url !== 'string' || !JPEG.test(url)) throw new Error('浏览器不支持图片压缩。');
    return url;
  }

  function encodeSharp(canvas) {
    var quality = 0.82;
    var url = toJpeg(canvas, quality);
    var guard = 0;
    while (url.length > SHARP_LIMIT && quality > 0.4 && guard < 12) {
      quality -= 0.08;
      guard += 1;
      url = toJpeg(canvas, quality);
    }
    if (url.length > SHARP_LIMIT) throw new Error('图片压缩后仍然过大，请换一张。');
    return url;
  }

  function encodeBlur(source, outW, outH) {
    var blur = document.createElement('canvas');
    blur.width = outW;
    blur.height = outH;
    var bctx = blur.getContext('2d');
    if (!bctx) throw new Error('浏览器不支持图片压缩。');
    if (canFilterCanvas()) {
      bctx.filter = 'blur(16px) saturate(1.2)';
      bctx.drawImage(source, 0, 0);
      bctx.filter = 'none';
    } else {
      var small = document.createElement('canvas');
      small.width = Math.max(1, Math.round(outW / 10));
      small.height = Math.max(1, Math.round(outH / 10));
      var sctx = small.getContext('2d');
      if (!sctx) throw new Error('浏览器不支持图片压缩。');
      sctx.drawImage(source, 0, 0, small.width, small.height);
      bctx.imageSmoothingEnabled = true;
      bctx.drawImage(small, 0, 0, outW, outH);
    }
    var quality = 0.62;
    var url = toJpeg(blur, quality);
    var guard = 0;
    while (url.length > BLUR_LIMIT && quality > 0.4 && guard < 12) {
      quality -= 0.06;
      guard += 1;
      url = toJpeg(blur, quality);
    }
    if (!url || url.length > BLUR_LIMIT) throw new Error('模糊背板生成失败。');
    return url;
  }

  function rasterize(image, file, used) {
    var aspect = 912 / 596;
    var iw = image.naturalWidth || image.width;
    var ih = image.naturalHeight || image.height;
    if (!iw || !ih) throw new Error('无法读取图片尺寸。');
    var cropW;
    var cropH;
    if (iw / ih > aspect) {
      cropH = ih;
      cropW = ih * aspect;
    } else {
      cropW = iw;
      cropH = iw / aspect;
    }
    var scale = Math.min(1, 912 / cropW, 596 / cropH);
    var outW = Math.max(1, Math.round(cropW * scale));
    var outH = Math.max(1, Math.round(cropH * scale));
    var canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持图片压缩。');
    ctx.fillStyle = '#0b1018';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(image, (iw - cropW) / 2, (ih - cropH) / 2, cropW, cropH, 0, 0, outW, outH);
    return {
      id: createId(used),
      name: imageName(file),
      sharp: encodeSharp(canvas),
      blur: encodeBlur(canvas, outW, outH),
      width: outW,
      height: outH
    };
  }

  function prepareFile(file, used) {
    return new Promise(function (resolve, reject) {
      if (!isAllowedFile(file)) { reject(new Error('请选择 JPEG、PNG 或 WebP 图片。')); return; }
      if (Number(file.size) > INPUT_LIMIT) { reject(new Error('图片超过 25MB，请换一张。')); return; }
      var reader = new window.FileReader();
      reader.onload = function () {
        var image = new window.Image();
        image.onload = function () {
          try { resolve(rasterize(image, file, used)); }
          catch (error) { reject(error instanceof Error ? error : new Error('图片无法处理。')); }
        };
        image.onerror = function () { reject(new Error('图片无法解码，请换一张。')); };
        image.src = String(reader.result || '');
      };
      reader.onerror = function () { reject(new Error('图片无法读取。')); };
      try { reader.readAsDataURL(file); }
      catch (_) { reject(new Error('图片无法读取。')); }
    });
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var image = new window.Image();
      image.onload = function () { resolve(image); };
      image.onerror = function () { reject(new Error('图片无法解码，请换一张。')); };
      image.src = src;
    });
  }

  async function recompress(item) {
    var image = await loadImage(item.sharp);
    var width = Number(item.width) || image.naturalWidth || image.width;
    var height = Number(item.height) || image.naturalHeight || image.height;
    if (!width || !height) return null;
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, width, height);
    var sharp = toJpeg(canvas, 0.5);
    if (sharp.length >= item.sharp.length || sharp.length > SHARP_LIMIT) sharp = toJpeg(canvas, 0.4);
    if (sharp.length >= item.sharp.length || sharp.length > SHARP_LIMIT) return null;
    var blur = encodeBlur(canvas, width, height);
    if (!blur || blur.length > BLUR_LIMIT) return null;
    return { id: item.id, name: item.name, sharp: sharp, blur: blur, width: width, height: height };
  }

  async function fit(nextImages, config, previous) {
    var working = [];
    for (var i = 0; i < nextImages.length; i++) {
      var item = nextImages[i];
      working.push({
        id: item.id, name: item.name, sharp: item.sharp, blur: item.blur,
        width: item.width, height: item.height
      });
    }
    var pack = { images: working };
    var lastError = null;
    try {
      return { images: working, snapshot: appearance.buildSnapshot(config, previous, pack) };
    } catch (error) {
      if (!isSizeError(error)) throw error;
      lastError = error;
    }
    for (var j = 0; j < working.length; j++) {
      var reduced = null;
      try { reduced = await recompress(working[j]); }
      catch (_) { reduced = null; }
      if (!reduced || reduced.sharp.length >= working[j].sharp.length) continue;
      working[j] = reduced;
      try {
        return { images: working, snapshot: appearance.buildSnapshot(config, previous, { images: working }) };
      } catch (error2) {
        if (!isSizeError(error2)) throw error2;
        lastError = error2;
      }
    }
    throw lastError || new Error('壁纸与用量的常显快照合计超过 800K，请减少图片或选择更易压缩的图片。');
  }

  function copyConfig(config) {
    var next = {};
    var keys = Object.keys(config);
    for (var i = 0; i < keys.length; i++) next[keys[i]] = config[keys[i]];
    return next;
  }

  function applySelection(preferred) {
    selectedId = null;
    if (preferred) {
      for (var i = 0; i < images.length; i++) {
        if (images[i].id === preferred) { selectedId = preferred; break; }
      }
    }
    if (!selectedId && images.length) selectedId = images[0].id;
  }

  function selected() {
    for (var i = 0; i < images.length; i++) if (images[i].id === selectedId) return images[i];
    return null;
  }

  function pairOf(item) {
    if (!item) return null;
    return { id: item.id, sharp: item.sharp, blur: item.blur };
  }

  function emit() {
    if (typeof onChange !== 'function') return;
    try { onChange(pairOf(selected())); }
    catch (_) { /* 预览回调失败不影响已保存的图库。 */ }
  }

  function showStatus(message) {
    if (dom.status) dom.status.textContent = message || '';
  }

  function showError(message) {
    if (!dom.error) return;
    dom.error.textContent = message || '';
    dom.error.hidden = !message;
  }

  function clearNode(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function render() {
    var writable = canWrite();
    if (dom.add) dom.add.disabled = !writable;
    if (dom.file) dom.file.disabled = !writable;
    if (dom.clear) dom.clear.disabled = !writable || images.length === 0;
    if (dom.empty) dom.empty.hidden = images.length > 0;
    if (!dom.list) return;
    clearNode(dom.list);
    for (var i = 0; i < images.length; i++) {
      var item = images[i];
      var wrap = document.createElement('div');
      wrap.className = 'wallpaper-item';
      var thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'wallpaper-thumb' + (item.id === selectedId ? ' is-selected' : '');
      thumb.setAttribute('aria-pressed', item.id === selectedId ? 'true' : 'false');
      var img = document.createElement('img');
      img.alt = '';
      img.src = item.sharp;
      thumb.appendChild(img);
      thumb.addEventListener('click', (function (id) {
        return function () {
          if (busy) return;
          selectedId = id;
          render();
          emit();
        };
      })(item.id));
      var caption = document.createElement('span');
      caption.className = 'wallpaper-name';
      caption.textContent = item.name || '壁纸';
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn wallpaper-remove';
      remove.textContent = '删除';
      remove.disabled = !writable;
      remove.setAttribute('aria-label', '删除' + (item.name || '壁纸'));
      remove.addEventListener('click', (function (id) {
        return function () { removeImage(id); };
      })(item.id));
      wrap.appendChild(thumb);
      wrap.appendChild(caption);
      wrap.appendChild(remove);
      dom.list.appendChild(wrap);
    }
  }

  function notifyRefresh() {
    if (!bridge || !bridge.card || typeof bridge.card.requestRefresh !== 'function') return;
    try {
      var result = bridge.card.requestRefresh();
      if (result && typeof result.catch === 'function') result.catch(function () {});
    } catch (_) { /* 快照已写入时，刷新通知失败不回滚图库。 */ }
  }

  async function persist(nextImages, okMessage, nextSelected, problemText) {
    var raw = await client.cardConfig();
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.providers)) {
      throw new Error('无法读取当前卡片配置。');
    }
    var config = copyConfig(raw);
    var page = await readPage();
    var previous = page ? { page: page } : null;
    var fitted = await fit(nextImages, config, previous);
    var saved = await appearance.save(bridge.storage, fitted.images);
    var snapshot = fitted.snapshot;
    try {
      snapshot = appearance.buildSnapshot(config, previous, saved);
    } catch (error) {
      if (!isSizeError(error)) throw error;
    }
    if (!bridge.card || typeof bridge.card.saveSnapshot !== 'function') {
      throw new Error('当前卡片桥无法保存常显快照。');
    }
    try {
      await bridge.card.saveSnapshot(snapshot);
    } catch (_) {
      images = saved.images;
      applySelection(nextSelected);
      emit();
      throw new Error('壁纸已保存在本机，但常显快照未能写入。请再试一次。');
    }
    images = saved.images;
    applySelection(nextSelected);
    showStatus(okMessage);
    showError(problemText || '');
    notifyRefresh();
    emit();
  }

  async function readPage() {
    try { return asPage(await bridge.storage.get(appearance.PAGE_KEY)); }
    catch (_) { return null; }
  }

  async function addFiles(files) {
    if (!canWrite()) return;
    busy = true;
    showError('');
    showStatus('正在处理 ' + files.length + ' 张图片…');
    render();
    var prepared = [];
    var problems = [];
    var used = {};
    for (var u = 0; u < images.length; u++) used[images[u].id] = true;
    try {
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        try {
          prepared.push(await prepareFile(file, used));
        } catch (error) {
          var label = file && file.name ? String(file.name).slice(0, 80) : '图片';
          problems.push(label + '：' + (error && error.message ? error.message : '无法处理'));
        }
      }
      if (!prepared.length) {
        showStatus('');
        showError(problems.join(' ') || '没有可添加的图片。');
        return;
      }
      var message = problems.length
        ? '已添加 ' + prepared.length + ' 张，' + problems.length + ' 张未加入。'
        : '已添加 ' + prepared.length + ' 张图片。';
      await persist(images.concat(prepared), message, prepared[0].id, problems.join(' '));
    } catch (error) {
      showStatus('');
      showError(error && error.message ? error.message : '壁纸保存失败');
    } finally {
      busy = false;
      render();
    }
  }

  async function removeImage(id) {
    if (!canWrite()) return;
    var index = -1;
    for (var i = 0; i < images.length; i++) if (images[i].id === id) index = i;
    if (index < 0) return;
    busy = true;
    render();
    try {
      var next = [];
      for (var j = 0; j < images.length; j++) if (images[j].id !== id) next.push(images[j]);
      var preferred = selectedId;
      if (selectedId === id) {
        var neighbor = next[index] || next[index - 1] || null;
        preferred = neighbor ? neighbor.id : null;
      }
      await persist(next, '已删除壁纸。', preferred, '');
    } catch (error) {
      showStatus('');
      showError(error && error.message ? error.message : '删除失败');
    } finally {
      busy = false;
      render();
    }
  }

  async function clearImages() {
    if (!canWrite() || !images.length) return;
    busy = true;
    render();
    try {
      await persist([], '已恢复默认背景。', null, '');
    } catch (error) {
      showStatus('');
      showError(error && error.message ? error.message : '恢复默认失败');
    } finally {
      busy = false;
      render();
    }
  }

  async function load() {
    try {
      var stored = await appearance.read(bridge.storage);
      images = stored && Array.isArray(stored.images) ? stored.images : [];
      applySelection(images.length ? images[0].id : null);
      showError('');
    } catch (_) {
      images = [];
      selectedId = null;
      showError('壁纸读取失败');
    }
    render();
    emit();
  }

  function onAddClick() {
    if (!canWrite() || !dom.file) return;
    dom.file.click();
  }

  function onFileChange() {
    var list = dom.file && dom.file.files ? Array.prototype.slice.call(dom.file.files) : [];
    if (dom.file) dom.file.value = '';
    if (!list.length || !canWrite()) return;
    addFiles(list);
  }

  function bind() {
    if (bound) return;
    bound = true;
    dom.add = byId('wallpaper-add');
    dom.clear = byId('wallpaper-clear');
    dom.file = byId('wallpaper-file');
    dom.list = byId('wallpaper-list');
    dom.empty = byId('wallpaper-empty');
    dom.status = byId('wallpaper-status');
    dom.error = byId('wallpaper-error');
    if (dom.add) dom.add.addEventListener('click', onAddClick);
    if (dom.clear) dom.clear.addEventListener('click', function () { clearImages(); });
    if (dom.file) dom.file.addEventListener('change', onFileChange);
  }

  function mount(options) {
    options = options || {};
    bridge = options.bridge || null;
    client = options.client || null;
    onChange = typeof options.onChange === 'function' ? options.onChange : null;
    appearance = window.AiUsageAppearance || null;
    images = [];
    selectedId = null;
    busy = false;
    bind();
    if (!bridge || !bridge.storage || !client || !appearance) {
      render();
      return { getWallpaper: function () { return null; } };
    }
    busy = true;
    render();
    load().then(function () {
      busy = false;
      render();
    }, function () {
      busy = false;
      render();
    });
    return {
      getWallpaper: function () { return pairOf(selected()); }
    };
  }

  window.AiUsageWallpaperSettings = { mount: mount };
})();
