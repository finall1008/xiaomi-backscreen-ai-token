(function () {
  'use strict';
  window.CARD_CONFIG = { providers: [], emptyMessage: '请在模块设置中添加来源' };
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'ai-usage-preview' || !data.config ||
        !Array.isArray(data.config.providers) || !window.AiUsageCard) return;
    window.AiUsageCard.update(data.config);
  });
})();
