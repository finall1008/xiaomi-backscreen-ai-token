(function () {
  'use strict';
  if (typeof bridge === 'undefined' || !window.AiUsageCore || !window.AiUsageCard || !window.AiUsageAppearance) return;

  var appearance = window.AiUsageAppearance;
  var card = window.AiUsageCard;
  var client = window.AiUsageCore.create({
    storage: bridge.storage,
    request: function (options) { return bridge.net.request(options); },
    // 设置页负责续期与保存 refresh token，背屏不同时轮换同一份凭据。
    allowTokenRefresh: false
  });
  var refreshing = false, reloadPending = false, loading = null;
  var current = window.CARD_SNAPSHOT || { schemaVersion: 1, config: { providers: [] } };
  var displayed = JSON.stringify(current.config);
  var snapshotConfig = displayed;
  var pageRevision = 0;
  var snapshotCheckedAt = 0;

  function publish() {
    snapshotConfig = JSON.stringify(current.config);
    appearance.saveLocal(typeof localStorage === 'undefined' ? null : localStorage, current);
    if (!bridge.card.saveSnapshot) return;
    try {
      var saved = bridge.card.saveSnapshot(current);
      if (saved && typeof saved.catch === 'function') saved.catch(function () {});
    } catch (_) { /* 保存失败不清除当前画面。 */ }
  }

  // 宿主会同步替换本地快照，但运行中的脚本不一定收到 refresh 通知。
  // readSnapshot 只读原生本地存储，不产生桥请求或网络访问。
  function applySharedSnapshot() {
    var shared = bridge.card.readSnapshot ? bridge.card.readSnapshot() : null;
    if (!shared || !shared.config || !Array.isArray(shared.config.providers)) return;
    var serialized = JSON.stringify(shared.config);
    if (serialized === snapshotConfig) return;
    snapshotConfig = serialized;
    if (serialized === displayed) return;
    current = appearance.buildSnapshot(shared.config, current, shared.appearance);
    displayed = serialized;
    card.update(current.config, function () {
      current.page = card.getState().pageKey;
      publish();
    });
  }

  async function readAppearance() {
    var raw = await bridge.storage.get(appearance.KEY);
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch (_) { return false; }
    }
    // 无旧图库记录不是一次“清空”；用户清空会写入新的空目录版本。
    if (!raw || raw.revision === appearance.normalize(current.appearance).revision) return false;
    var next = await appearance.read(bridge.storage);
    current = appearance.buildSnapshot(current.config, current, next);
    var selected = next.images[0] || null;
    if (selected) current.wallpaperId = selected.id;
    else delete current.wallpaperId;
    card.setWallpaper(selected);
    return true;
  }

  async function display() {
    var config = await client.cardConfig();
    config.emptyMessage = '请在卡片桥的模块设置中添加来源';
    var changedAppearance = await readAppearance();
    var serialized = JSON.stringify(config);
    if (serialized === displayed && !changedAppearance) return;
    displayed = serialized;
    current = appearance.buildSnapshot(config, current);
    card.update(config, function () {
      current.page = card.getState().pageKey;
      publish();
    });
  }

  function load() {
    if (refreshing || loading) {
      reloadPending = true;
      return loading;
    }
    loading = display().catch(function () {
      // 桥暂不可用时保留已绘制的本地快照。
    }).then(function () {
      loading = null;
      if (reloadPending) { reloadPending = false; load(); }
    });
    return loading;
  }

  card.onPageChange(function (pageKey) {
    pageRevision++;
    current.page = pageKey;
    // 先同步保存本地快照，翻页后立即息屏也能恢复目标页。
    publish();
    var saved = bridge.storage.set(appearance.PAGE_KEY, pageKey);
    if (saved && typeof saved.catch === 'function') saved.catch(function () {});
  });

  if (!current.page) {
    var initialRevision = pageRevision;
    bridge.storage.get(appearance.PAGE_KEY).then(function (pageKey) {
      if (pageRevision !== initialRevision || typeof pageKey !== 'string') return;
      card.restorePage(pageKey);
      current.page = card.getState().pageKey;
      publish();
    }).catch(function () {});
  }

  card.onRefresh(async function (providerId) {
    if (loading) await loading;
    refreshing = true;
    var failed = false;
    try {
      var rows = await client.state();
      // 简洁页/总览刷新全部，详情只刷新当前来源。
      await Promise.all(rows.map(async function (row) {
        if (!row.configured || (providerId && row.id !== providerId)) return;
        try { await client.refresh(row.id); }
        catch (_) { failed = true; }
      }));
      await display();
      if (failed) throw new Error('部分来源刷新失败');
    } finally {
      refreshing = false;
      if (reloadPending) { reloadPending = false; load(); }
    }
  });

  // AOD 有 visibilitychange，但直接 OFF/ON 不发事件，恢复时也可能沿用旧 JS。
  // 宿主本来就有统一 RAF 循环；这里只观察回调中断，不在每帧绘图或访问桥。
  var wasHidden = document.hidden === true || document.visibilityState === 'hidden';
  var lastFrame = null, resumePending = false;
  function hidden() {
    return document.hidden === true || document.visibilityState === 'hidden';
  }
  function resume() {
    wasHidden = false;
    resumePending = false;
    lastFrame = Date.now();
    snapshotCheckedAt = lastFrame;
    applySharedSnapshot();
    current.page = card.getState().pageKey;
    var restored = appearance.advance(current);
    current = restored.snapshot;
    // 即使未配置壁纸也请求一帧，恢复原生已经清空的 Canvas。
    card.setWallpaper(restored.wallpaper);
    publish();
    load();
  }
  document.addEventListener('visibilitychange', function () {
    if (hidden()) { wasHidden = true; publish(); }
    else if (wasHidden) resumePending = true;
    // OFF 时也可能先收到 AOD EXIT；等原生真正恢复帧回调后再轮换，避免 OFF/ON 推进两次。
  });
  function observeFrame() {
    var time = Date.now();
    if (!hidden() && (resumePending || (lastFrame !== null && time - lastFrame > 1000))) resume();
    else if (!hidden() && time - snapshotCheckedAt >= 1000) {
      snapshotCheckedAt = time;
      applySharedSnapshot();
    }
    lastFrame = time;
    window.requestAnimationFrame(observeFrame);
  }
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(observeFrame);

  // 周期取数由宿主调度。重读数据和图库不推进本次点亮的壁纸。
  bridge.card.onRefresh(load);
  load();
})();
