// 常显只截取最初帧：在任何异步桥调用之前恢复展示数据。
(function () {
  'use strict';
  var config = { providers: [] };
  if (typeof bridge !== 'undefined' && bridge.card.readSnapshot) {
    try {
      var snapshot = bridge.card.readSnapshot();
      if (snapshot && snapshot.schemaVersion === 1 && snapshot.config &&
          Array.isArray(snapshot.config.providers)) config = snapshot.config;
    } catch (_) { /* 无可用快照时显示既有空态。 */ }
  }
  config.emptyMessage = '请在卡片桥的模块设置中添加来源';
  window.CARD_CONFIG = config;
})();
