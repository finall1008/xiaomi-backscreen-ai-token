function asyncGeneratorStep(n, t, e, r, o, a, c) { try { var i = n[a](c), u = i.value; } catch (n) { return void e(n); } i.done ? t(u) : Promise.resolve(u).then(r, o); }
function _asyncToGenerator(n) { return function () { var t = this, e = arguments; return new Promise(function (r, o) { var a = n.apply(t, e); function _next(n) { asyncGeneratorStep(a, r, o, _next, _throw, "next", n); } function _throw(n) { asyncGeneratorStep(a, r, o, _next, _throw, "throw", n); } _next(void 0); }); }; }
(function () {
  'use strict';

  if (typeof bridge === 'undefined' || !window.AiUsageCore || !window.AiUsageCard) return;
  var client = window.AiUsageCore.create({
    storage: bridge.storage,
    request: function (options) {
      return bridge.net.request(options);
    },
    // 设置页负责续期与保存 refresh token，背屏不同时轮换同一份凭据。
    allowTokenRefresh: false
  });
  var refreshing = false,
    reloadPending = false,
    loading = null;
  var displayed = JSON.stringify(window.CARD_CONFIG);
  function display() {
    return _display.apply(this, arguments);
  }
  function _display() {
    _display = _asyncToGenerator(function* () {
      var config = yield client.cardConfig();
      config.emptyMessage = '请在卡片桥的模块设置中添加来源';
      var serialized = JSON.stringify(config);
      if (serialized === displayed) return;
      displayed = serialized;
      window.AiUsageCard.update(config, function () {
        if (bridge.card.saveSnapshot) {
          var saved = bridge.card.saveSnapshot({
            schemaVersion: 1,
            config: config
          });
          if (saved && typeof saved.catch === 'function') saved.catch(function () {});
        }
      });
    });
    return _display.apply(this, arguments);
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
      if (reloadPending) {
        reloadPending = false;
        load();
      }
    });
    return loading;
  }
  window.AiUsageCard.onRefresh(/*#__PURE__*/function () {
    var _ref = _asyncToGenerator(function* (providerId) {
      if (loading) yield loading;
      refreshing = true;
      var failed = false;
      try {
        var rows = yield client.state();
        // 手动刷新不受缓存年龄限制；首页刷新全部，详情只刷新当前来源。
        yield Promise.all(rows.map(/*#__PURE__*/function () {
          var _ref2 = _asyncToGenerator(function* (row) {
            if (!row.configured || providerId && row.id !== providerId) return;
            try {
              yield client.refresh(row.id);
            } catch (_) {
              failed = true;
            }
          });
          return function (_x2) {
            return _ref2.apply(this, arguments);
          };
        }()));
        yield display();
        if (failed) throw new Error('部分来源刷新失败');
      } finally {
        refreshing = false;
        if (reloadPending) {
          reloadPending = false;
          load();
        }
      }
    });
    return function (_x) {
      return _ref.apply(this, arguments);
    };
  }());

  // 周期取数由宿主统一调度；启动及缓存通知只重读共享展示数据。
  bridge.card.onRefresh(load);
  load();
})();