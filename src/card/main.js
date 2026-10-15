(function () {
  'use strict';
  if (typeof bridge === 'undefined' || !window.AiUsageCore || !window.AiUsageCard) return;

  var client = window.AiUsageCore.create({
    storage: bridge.storage,
    request: function (options) { return bridge.net.request(options); },
    // 设置页负责续期与保存 refresh token，背屏不同时轮换同一份凭据。
    allowTokenRefresh: false
  });
  var refreshing = false, reloadPending = false, loading = null;
  var displayed = JSON.stringify(window.CARD_CONFIG);

  async function display() {
    var config = await client.cardConfig();
    config.emptyMessage = '请在卡片桥的模块设置中添加来源';
    var serialized = JSON.stringify(config);
    if (serialized === displayed) return;
    displayed = serialized;
    window.AiUsageCard.update(config, function () {
      if (bridge.card.saveSnapshot) {
        var saved = bridge.card.saveSnapshot({ schemaVersion: 1, config: config });
        if (saved && typeof saved.catch === 'function') saved.catch(function () {});
      }
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

  window.AiUsageCard.onRefresh(async function (providerId) {
    if (loading) await loading;
    refreshing = true;
    var failed = false;
    try {
      var rows = await client.state();
      // 手动刷新不受缓存年龄限制；首页刷新全部，详情只刷新当前来源。
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

  // 周期取数由宿主统一调度；启动及缓存通知只重读共享展示数据。
  bridge.card.onRefresh(load);
  load();
})();
