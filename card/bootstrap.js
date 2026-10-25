// 常显只截取最初帧：数据、页码、轮换图片都先从同步快照恢复。
(function () {
  'use strict';

  var snapshot = {
    schemaVersion: 1,
    config: {
      providers: []
    }
  };
  if (typeof bridge !== 'undefined' && bridge.card.readSnapshot) {
    try {
      var cached = bridge.card.readSnapshot();
      if (cached && cached.schemaVersion === 1 && cached.config && Array.isArray(cached.config.providers)) snapshot = cached;
    } catch (_) {/* 无可用快照时显示既有空态。 */}
  }
  var wallpaper = null;
  if (window.AiUsageAppearance) {
    try {
      var restored = window.AiUsageAppearance.advance(snapshot);
      snapshot = restored.snapshot;
      wallpaper = restored.wallpaper;
    } catch (_) {/* 旧数据不可用时仍绘制用量，不等待异步桥。 */}
  }
  var config = {};
  Object.keys(snapshot.config).forEach(function (key) {
    config[key] = snapshot.config[key];
  });
  config.emptyMessage = '请在卡片桥的模块设置中添加来源';
  config.pageKey = snapshot.page;
  config.wallpaper = wallpaper;
  window.CARD_SNAPSHOT = snapshot;
  window.CARD_CONFIG = config;
  if (wallpaper && typeof bridge !== 'undefined' && bridge.card.saveSnapshot) {
    // 本地快照在此调用内同步更新；共享副本异步保存不阻塞首帧。
    try {
      var pending = bridge.card.saveSnapshot(snapshot);
      if (pending && typeof pending.catch === 'function') pending.catch(function () {});
    } catch (_) {/* 绘制仍使用已经同步恢复的图片。 */}
  }
})();