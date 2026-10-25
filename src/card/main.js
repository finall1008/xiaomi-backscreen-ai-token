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
  var pageRevision = 0;

  function publish() {
    if (!bridge.card.saveSnapshot) return;
    try {
      var saved = bridge.card.saveSnapshot(current);
      if (saved && typeof saved.catch === 'function') saved.catch(function () {});
    } catch (_) { /* 保存失败不清除当前画面。 */ }
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

  // 周期取数由宿主调度。重读数据和图库不推进本次点亮的壁纸。
  bridge.card.onRefresh(load);
  load();
})();
