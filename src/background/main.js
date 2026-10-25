// 构建时在本文件前拼接共享核心，宿主在独立 WebView 中调用 refresh()。
// 不绘图、不设定时器、不打开登录窗口；周期与 60 秒任务上限由桥控制。
async function refresh() {
  var client = window.AiUsageCore.create({
    storage: bridge.storage,
    request: function (options) { return bridge.net.request(options); },
    // 与背屏一致：设置页是 Codex refresh token 的唯一轮换方。
    allowTokenRefresh: false
  });
  var rows = await client.state();
  var failed = false;
  // 来源并行，单来源失败保留成功缓存，不阻塞其他来源。
  await Promise.all(rows.map(async function (row) {
    if (!row.configured) return;
    try { await client.refresh(row.id); }
    catch (_) { failed = true; }
  }));
  var config = await client.cardConfig();
  config.emptyMessage = '请在卡片桥的模块设置中添加来源';
  // 后台保存是异步的，必须等桥确认完成，不能保存后即结束任务。
  var previous = bridge.card.readSnapshot ? bridge.card.readSnapshot() : null;
  var page = await bridge.storage.get(window.AiUsageAppearance.PAGE_KEY);
  if (typeof page === 'string') previous = Object.assign({}, previous || {}, { page: page });
  await bridge.card.saveSnapshot(window.AiUsageAppearance.buildSnapshot(config, previous));
  if (failed) throw new Error('部分来源后台刷新失败，请在模块设置中查看状态');
}
