// AI 用量背屏卡片 · 多来源原型（QuickJS Canvas 运行时兼容：无 ES Module、无远程资源）
// 页面结构：0 个已配置来源 → 空态；1 个 → 直接详情页；≥2 个 → 首页 2x2 网格 + 各来源详情页。
// 导航：点击首页卡片进入对应详情；左右滑动 / 点击底部圆点切换页面；详情页点击标题回首页。
(function () {
  'use strict';

  var cfg = window.CARD_CONFIG || {};
  var providers = cfg.providers || [];
  var cv = document.getElementById('rear');
  var ctx = cv.getContext('2d');
  var renderQueued = false, afterDraw = null;
  var W = window.CANVAS_W || 912, H = window.CANVAS_H || 596;

  // 左侧约 296px 为摄像头区域，内容区右移
  var L = 336, R = 876, CW = R - L;

  var C = {
    bg0: '#101014', bg1: '#17171f',
    panel: 'rgba(255,255,255,0.055)', panelEdge: 'rgba(255,255,255,0.10)',
    panelActive: 'rgba(140,170,255,0.16)',
    text: '#f2f3f7', sub: '#9aa0ae', dim: '#6b7180',
    track: 'rgba(255,255,255,0.12)'
  };

  // 各来源的主题色（用于首字母占位 logo 与首页卡片点缀）
  var BRAND = {
    codex:    { color: '#e8e9f0', initial: 'C' },
    kimi:     { color: '#5e8bff', initial: 'K' },
    deepseek: { color: '#4d6bfe', initial: 'D' },
    mimo:     { color: '#ff6900', initial: 'M' },
    cursor:   { color: '#e8e9f0', initial: 'C' }
  };

  function barColor(p) {
    if (p >= 90) return '#f85149';
    if (p >= 70) return '#d29922';
    return '#3fb950';
  }

  function statusText(p) {
    return p >= 90 ? '接近上限' : (p >= 70 ? '用量偏高' : '余量充足');
  }

  function statusShort(p) {
    return p >= 90 ? '告急' : (p >= 70 ? '偏高' : '充足');
  }

  // 文本超宽截断加省略号
  function fitText(text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    var t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  function round(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtClock(ts) {
    var d = new Date(ts * 1000);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtReset(ts) {
    if (!ts) return '';
    var now = Date.now() / 1000;
    var d = new Date(ts * 1000);
    var diff = ts - now;
    if (diff <= 0) return '即将重置';
    if (diff < 24 * 3600) {
      var h = Math.floor(diff / 3600), m = Math.round((diff % 3600) / 60);
      return (h > 0 ? h + ' 小时 ' : '') + m + ' 分钟后重置';
    }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + fmtClock(ts) + ' 重置';
  }

  // 首页卡片底部用的紧凑重置文案：2h14m / 10月31日
  function fmtResetShort(ts) {
    if (!ts) return '';
    var now = Date.now() / 1000;
    var d = new Date(ts * 1000);
    var diff = ts - now;
    if (diff <= 0) return '即将重置';
    if (diff < 24 * 3600) {
      var h = Math.floor(diff / 3600), m = Math.round((diff % 3600) / 60);
      return (h > 0 ? h + 'h' : '') + (m > 0 ? m + 'm' : '');
    }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function fmtDate(ts) {
    if (!ts) return '';
    var d = new Date(ts * 1000);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // 大额数字缩写：23.6B / 110B（Credits 等）
  function fmtBig(n) {
    if (typeof n !== 'number') return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e11 ? 0 : 1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n + '';
  }

  function fmtMoney(amount, currency) {
    if (typeof amount !== 'number') return '—';
    var sym = currency === 'USD' ? '$' : '¥';
    return sym + amount.toFixed(2);
  }

  // ---------- 静态 logo ----------
  // 静态 logo：随载体包 assets/ 安装，不占用热更新脚本体积。
  // 无位图的来源退回首字母圆角方块。
  var logos = {}, logoPaths = {};
  function loadLogos() {
    providers.forEach(function (p) {
      if (!p.logoAsset || logoPaths[p.id] === p.logoAsset) return;
      logoPaths[p.id] = p.logoAsset;
      var img = new Image();
      img.onload = function () { logos[p.id] = img; requestDraw(); };
      img.onerror = function () { requestDraw(); };
      img.src = p.logoAsset;
    });
  }
  loadLogos();

  function brandMark(p, x, y, size) {
    var img = logos[p.id];
    if (img) { ctx.drawImage(img, x, y, size, size); return; }
    var brand = BRAND[p.id] || { color: '#e8e9f0', initial: '?' };
    ctx.save();
    round(x, y, size, size, size * 0.28);
    ctx.fillStyle = brand.color;
    ctx.fill();
    ctx.fillStyle = '#101014';
    ctx.font = '700 ' + Math.round(size * 0.55) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(brand.initial, x + size / 2, y + size / 2 + 1);
    ctx.restore();
  }

  function badge(x, y, text) {
    ctx.font = '600 24px sans-serif';
    var w = ctx.measureText(text).width + 32;
    round(x - w, y - 20, w, 40, 20);
    ctx.fillStyle = 'rgba(120,160,255,0.16)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,170,255,0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#a8c0ff';
    ctx.textAlign = 'center';
    ctx.fillText(text, x - w / 2, y + 1);
    ctx.textAlign = 'left';
  }

  function panel(x, y, w, h) {
    round(x, y, w, h, 24);
    ctx.fillStyle = C.panel;
    ctx.fill();
    ctx.strokeStyle = C.panelEdge;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function progressBar(x, y, w, h, pct, color) {
    round(x, y, w, h, h / 2);
    ctx.fillStyle = C.track;
    ctx.fill();
    if (pct > 0) {
      round(x, y, Math.max(h, w * pct / 100), h, h / 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  // ---------- 来源展示辅助 ----------
  // 首页卡片优先展示最短时间窗口的用量；无窗口（纯余额）展示余额。
  function shortWindow(p) {
    var wins = (p.windows || []).filter(function (w) { return w && typeof w.usedPercent === 'number'; });
    if (!wins.length) return null;
    wins.sort(function (a, b) { return (a.windowSeconds || 1e12) - (b.windowSeconds || 1e12); });
    return wins[0];
  }

  // ---------- 首页：2x2 网格 ----------
  var GRID_TOP = 110, GRID_BOTTOM = 566, GRID_GAP = 16;
  var CELL_W = (CW - GRID_GAP) / 2;
  var CELL_H = (GRID_BOTTOM - GRID_TOP - GRID_GAP) / 2;

  function cellRect(i) {
    return {
      x: L + (i % 2) * (CELL_W + GRID_GAP),
      y: GRID_TOP + Math.floor(i / 2) * (CELL_H + GRID_GAP),
      w: CELL_W, h: CELL_H
    };
  }

  function drawHomeCell(p, i) {
    var r = cellRect(i);
    panel(r.x, r.y, r.w, r.h);

    var pad = 22;
    var win = shortWindow(p);
    var known = !!win;
    var pct = known ? Math.max(0, Math.min(100, Math.round(win.usedPercent))) : 0;
    var color = known ? barColor(pct) : C.dim;

    // 顶部：小 logo + 名称，右侧短状态（名称超宽时截断）
    brandMark(p, r.x + pad, r.y + pad - 4, 30);
    ctx.textBaseline = 'middle';
    var statusLabel = known ? statusShort(pct) : (p.balance ? '余额' : '—');
    ctx.font = '600 20px sans-serif';
    var statusW = ctx.measureText(statusLabel).width;
    var nameX = r.x + pad + 42;
    ctx.fillStyle = color;
    ctx.textAlign = 'right';
    ctx.fillText(statusLabel, r.x + r.w - pad, r.y + pad + 12);
    ctx.textAlign = 'left';
    ctx.fillStyle = C.text;
    ctx.font = '600 24px sans-serif';
    ctx.fillText(fitText(p.name, r.x + r.w - pad - statusW - 12 - nameX), nameX, r.y + pad + 12);

    // 中部大数字：短时间窗口用量 %，或余额
    ctx.fillStyle = C.text;
    ctx.font = '700 74px sans-serif';
    var big;
    if (known) big = pct + '';
    else if (p.balance) big = fmtMoney(p.balance.amount, p.balance.currency);
    else big = '—';
    ctx.fillText(big, r.x + pad, r.y + r.h / 2 + 6);
    if (known) {
      var nw = ctx.measureText(big).width;
      ctx.fillStyle = C.sub;
      ctx.font = '600 30px sans-serif';
      ctx.fillText('%', r.x + pad + nw + 6, r.y + r.h / 2 + 16);
    }

    // 底部：窗口标题 + 紧凑重置时间 + 进度条（超宽截断）
    ctx.fillStyle = C.dim;
    ctx.font = '400 20px sans-serif';
    var foot = known ? (win.title + ' · ' + fmtResetShort(win.resetAt))
      : (p.balance ? 'DeepSeek 开放平台' : (p.id === 'cursor' && p.updatedAt ? '未提供额度比例' : '等待首次刷新'));
    ctx.fillText(fitText(foot, r.w - pad * 2), r.x + pad, r.y + r.h - 52);
    if (known) progressBar(r.x + pad, r.y + r.h - 36, r.w - pad * 2, 10, pct, color);
  }

  function drawHome() {
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = C.text;
    ctx.font = '700 32px sans-serif';
    ctx.fillText('AI 用量', L, 56);
    ctx.fillStyle = C.sub;
    ctx.font = '400 22px sans-serif';
    ctx.fillText(refreshHint() || providers.length + ' 个来源' + (cfg.updatedAt ? ' · 更新于 ' + fmtClock(cfg.updatedAt) : ''), L, 91);
    badge(R, 62, '总览');

    for (var i = 0; i < providers.length; i++) drawHomeCell(providers[i], i);
  }

  // ---------- 详情页 ----------
  function drawDetailHeader(p) {
    brandMark(p, L, 42, 40);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = C.text;
    ctx.font = '700 32px sans-serif';
    ctx.fillText(p.name, L + 52, 56);
    ctx.fillStyle = C.sub;
    ctx.font = '400 22px sans-serif';
    ctx.fillText(refreshHint() || '套餐用量' + (p.updatedAt || cfg.updatedAt ? ' · 更新于 ' + fmtClock(p.updatedAt || cfg.updatedAt) : ''), L + 52, 91);
    badge(R, 62, (p.plan || '未知套餐').toUpperCase());
  }

  function usagePanel(y, h, title, win) {
    var known = win && typeof win.usedPercent === 'number';
    var pct = known ? Math.max(0, Math.min(100, Math.round(win.usedPercent))) : 0;
    var numberText = known ? pct + '' : '—';
    var color = known ? barColor(pct) : C.dim;

    panel(L, y, CW, h);

    var ix = L + 32, iw = CW - 64;

    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.sub;
    ctx.font = '500 26px sans-serif';
    ctx.fillText(title, ix, y + 34);

    // 大字号百分比
    ctx.fillStyle = C.text;
    var numberSize = h >= 300 ? 156 : 112;
    ctx.font = '700 ' + numberSize + 'px sans-serif';
    ctx.fillText(numberText, ix, y + h / 2 - 8);
    var numW = ctx.measureText(numberText).width;
    ctx.fillStyle = C.sub;
    ctx.font = '600 ' + (h >= 300 ? 48 : 40) + 'px sans-serif';
    if (known) ctx.fillText('%', ix + numW + 8, y + h / 2 + 14);

    // 右侧状态
    ctx.textAlign = 'right';
    ctx.fillStyle = color;
    ctx.font = '600 24px sans-serif';
    ctx.fillText(known ? statusText(pct) : '暂无数据', L + CW - 32, y + 34);
    ctx.fillStyle = C.sub;
    ctx.font = '400 23px sans-serif';
    ctx.fillText(fmtReset(win && win.resetAt), L + CW - 32, y + h - 34);
    ctx.textAlign = 'left';

    // 进度条
    progressBar(ix, y + h - 66, iw, 14, pct, color);
  }

  // 余额面板（DeepSeek：只显示余额）
  function balancePanel(y, h, balance) {
    panel(L, y, CW, h);
    var ix = L + 32;

    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.sub;
    ctx.font = '500 26px sans-serif';
    ctx.fillText('账户余额', ix, y + 34);

    ctx.fillStyle = C.text;
    ctx.font = '700 120px sans-serif';
    var amountText = balance ? fmtMoney(balance.amount, balance.currency) : '—';
    ctx.fillText(amountText, ix, y + h / 2);

    ctx.textAlign = 'right';
    ctx.fillStyle = balance && balance.isAvailable ? '#3fb950' : '#d29922';
    ctx.font = '600 24px sans-serif';
    ctx.fillText(balance ? (balance.isAvailable ? '余额可用' : '余额不足') : '暂无数据', L + CW - 32, y + 34);
    ctx.fillStyle = C.sub;
    ctx.font = '400 23px sans-serif';
    if (balance) {
      ctx.fillText('充值 ' + fmtMoney(balance.toppedUp, balance.currency) +
        ' · 赠金 ' + fmtMoney(balance.granted, balance.currency), L + CW - 32, y + h - 40);
    }
    ctx.textAlign = 'left';
  }

  // 明细面板（MiMo：Credits 数字；Kimi：加油包等附加信息）
  function infoPanel(y, h, title, lines) {
    panel(L, y, CW, h);
    var ix = L + 32;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.sub;
    ctx.font = '500 24px sans-serif';
    ctx.fillText(title, ix, y + 28);
    ctx.font = '400 24px sans-serif';
    lines.forEach(function (line, i) {
      ctx.fillStyle = i === 0 ? C.text : C.sub;
      ctx.fillText(fitText(line, CW - 64), ix, y + 62 + i * 32);
    });
  }

  function drawDetail(p) {
    drawDetailHeader(p);
    var wins = p.windows || [];

    // 附加明细（Credits / 加油包 / 有效期 / Cursor 消费）
    var lines = (p.details || []).slice();
    if (p.credits) {
      lines.push('已用 ' + fmtBig(p.credits.used) + ' / 总量 ' + fmtBig(p.credits.limit) + ' Credits');
      if (p.credits.periodEnd) lines.push('当前周期至 ' + fmtDate(p.credits.periodEnd));
    }
    if (p.booster) {
      lines.push('加油包余额 ' + fmtMoney(p.booster.amount, p.booster.currency) +
        (p.booster.monthlyUsed != null ? ' · 本月已用 ' + fmtMoney(p.booster.monthlyUsed, p.booster.currency) : ''));
    }

    if (p.id === 'deepseek') {
      // 纯余额来源：单面板放大
      balancePanel(140, 300, p.balance);
      ctx.fillStyle = C.sub;
      ctx.font = '400 23px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('DeepSeek API 按量计费，无套餐窗口', (L + R) / 2, 500);
      ctx.textAlign = 'left';
      return;
    }

    // 单窗口套餐档位（如 Codex Pro 只有周限额）：放大面板
    if (wins.length <= 1) {
      if (wins.length === 1) {
        usagePanel(140, 300, wins[0].title, wins[0]);
        if (p.hint) {
          ctx.fillStyle = C.sub;
          ctx.font = '400 23px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(p.hint, (L + R) / 2, 500);
          ctx.textAlign = 'left';
        }
      } else {
        usagePanel(140, 300, '用量', null);
      }
      if (lines.length) infoPanel(452, 104, '明细', lines.slice(0, 2));
      detailMaxScroll = 0;
      return;
    }

    // 多窗口（如 Kimi 老套餐 5h + 每周 + 月度）：纵向滚动列表，明细面板跟在末尾
    var stride = 224;
    var contentH = wins.length * stride - 16 + (lines.length ? 16 + 104 : 0);
    detailMaxScroll = Math.max(0, contentH - SCROLL_H);
    detailScroll = Math.max(0, Math.min(detailMaxScroll, detailScroll));

    ctx.save();
    ctx.beginPath();
    ctx.rect(L - 8, SCROLL_TOP, CW + 16, SCROLL_H);
    ctx.clip();
    for (var wi = 0; wi < wins.length; wi++) {
      usagePanel(SCROLL_TOP - detailScroll + wi * stride, 208, wins[wi].title, wins[wi]);
    }
    if (lines.length) {
      infoPanel(SCROLL_TOP - detailScroll + wins.length * stride, 104, '明细', lines.slice(0, 2));
    }
    ctx.restore();

    // 右侧滚动条
    if (detailMaxScroll > 0) {
      var trackH = SCROLL_H, tx = R + 10;
      var thumbH = Math.max(36, trackH * SCROLL_H / contentH);
      var thumbY = SCROLL_TOP + (trackH - thumbH) * detailScroll / detailMaxScroll;
      round(tx, SCROLL_TOP, 6, trackH, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fill();
      round(tx, thumbY, 6, thumbH, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      ctx.fill();
    }
  }

  function drawEmpty() {
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = C.sub;
    ctx.font = '500 28px sans-serif';
    ctx.fillText('尚未设置用量来源', (L + R) / 2, H / 2 - 20);
    ctx.fillStyle = C.dim;
    ctx.font = '400 23px sans-serif';
    ctx.fillText(cfg.emptyMessage || '请在卡片桥的模块设置中添加来源', (L + R) / 2, H / 2 + 22);
    ctx.textAlign = 'left';
  }

  // ---------- 页面与导航 ----------
  // pages: ≥2 个来源时第 0 页为首页，其后为各来源详情；1 个来源时仅详情页。
  var hasHome = providers.length >= 2;
  var pageCount = hasHome ? providers.length + 1 : providers.length;
  var page = 0;

  // 详情页纵向滚动（多窗口来源，如 Kimi 老套餐）
  var SCROLL_TOP = 110, SCROLL_H = 456;
  var detailScroll = 0, detailMaxScroll = 0;
  var refreshHandler = null, refreshing = false, refreshError = false, pullDistance = 0;
  var PULL_THRESHOLD = 80;

  function refreshHint() {
    if (refreshing) return '刷新中…';
    if (pullDistance > 0) return pullDistance >= PULL_THRESHOLD ? '松开刷新' : '下拉刷新';
    return refreshError ? '刷新失败，请重试' : '';
  }

  function refreshCurrent() {
    if (!refreshHandler || refreshing) return;
    var id = providers.length && !(hasHome && page === 0)
      ? providers[hasHome ? page - 1 : page].id : null;
    refreshing = true;
    refreshError = false;
    requestDraw();
    Promise.resolve().then(function () { return refreshHandler(id); }).then(function () {
      refreshing = false;
      requestDraw();
    }, function () {
      refreshing = false;
      refreshError = true;
      requestDraw();
    });
  }

  function drawDots() {
    if (pageCount <= 1) return;
    var cx = (L + R) / 2, y = 576, gap = 22;
    var start = cx - (pageCount - 1) * gap / 2;
    for (var i = 0; i < pageCount; i++) {
      ctx.beginPath();
      ctx.arc(start + i * gap, y, i === page ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === page ? '#a8c0ff' : 'rgba(255,255,255,0.22)';
      ctx.fill();
    }
  }

  // JsCanvas publishes drawing only while nativeExecuteFrame records its canvas.
  // Touch/image callbacks update state outside that recording window: defer drawing
  // to RAF and coalesce changes, rather than continuously redrawing a static card.
  function requestDraw() {
    if (renderQueued) return;
    if (typeof window.requestAnimationFrame !== 'function') { draw(); return; }
    renderQueued = true;
    window.requestAnimationFrame(function () {
      renderQueued = false;
      draw();
    });
  }

  function draw() {
    var g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, C.bg0);
    g.addColorStop(1, C.bg1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    detailMaxScroll = 0;
    if (!providers.length) drawEmpty();
    else {
      if (hasHome && page === 0) drawHome();
      else drawDetail(providers[hasHome ? page - 1 : page]);
      drawDots();
    }
    var done = afterDraw;
    afterDraw = null;
    if (done) done();
  }

  // 模块只替换数据，不重建手势监听或改变既有布局。
  window.AiUsageCard = {
    onRefresh: function (handler) { refreshHandler = handler; },
    update: function (config, done) {
      var selected = providers.length && !(hasHome && page === 0)
        ? providers[hasHome ? page - 1 : page].id : null;
      cfg = config || {};
      providers = cfg.providers || [];
      hasHome = providers.length >= 2;
      pageCount = hasHome ? providers.length + 1 : providers.length;
      var index = providers.map(function (p) { return p.id; }).indexOf(selected);
      page = index < 0 ? 0 : index + (hasHome ? 1 : 0);
      detailScroll = 0;
      downX = downY = lastY = dragAxis = null;
      pullDistance = 0;
      afterDraw = typeof done === 'function' ? done : null;
      loadLogos();
      requestDraw();
    }
  };

  function goTo(i) {
    page = Math.max(0, Math.min(pageCount - 1, i));
    detailScroll = 0;
    pullDistance = 0;
    refreshError = false;
    requestDraw();
  }

  // ---------- 交互（原型预览：鼠标/触摸/键盘；运行时以载体事件为准） ----------
  var downX = null, downY = null, lastY = null, dragAxis = null;

  var pullFromTop = false;
  function onDown(x, y) {
    downX = x; downY = lastY = y; dragAxis = null;
    pullFromTop = detailScroll === 0;
  }

  function onMove(x, y) {
    if (downX == null) return;
    var dx = x - downX, dy = y - lastY;
    if (!dragAxis) {
      var tdy = y - downY;
      if (Math.abs(tdy) > Math.abs(dx) + 8) dragAxis = 'v';
      else if (Math.abs(dx) > Math.abs(tdy) + 8) dragAxis = 'h';
    }
    if (dragAxis === 'v' && pullFromTop && refreshHandler && y > downY) {
      pullDistance = y - downY;
      requestDraw();
    } else if (dragAxis === 'v' && detailMaxScroll > 0) {
      detailScroll = Math.max(0, Math.min(detailMaxScroll, detailScroll - dy));
      lastY = y;
      requestDraw();
    }
  }

  function onUp(x, y) {
    if (downX == null) return;
    var dx = x - downX, dy = y - downY;
    var axis = dragAxis;
    downX = downY = lastY = null;
    dragAxis = null;
    pullDistance = 0;
    if (axis === 'v' || (!axis && dy > Math.abs(dx) + 8 && dy >= PULL_THRESHOLD)) {
      if (pullFromTop && dy >= PULL_THRESHOLD && dy > Math.abs(dx) + 8) refreshCurrent();
      requestDraw();
      return;
    }
    if (Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy)) {
      goTo(page + (dx < 0 ? 1 : -1)); // 左滑下一页，右滑上一页
      return;
    }
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) return; // 拖拽不触发点击
    if (hasHome && page === 0) {
      for (var i = 0; i < providers.length; i++) {
        var r = cellRect(i);
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { goTo(i + 1); return; }
      }
    } else if (hasHome && y < 110 && x >= L) {
      goTo(0); // 详情页点标题区回首页
    }
    // 底部圆点直跳
    if (pageCount > 1 && y > 556) {
      var gap = 22, start = (L + R) / 2 - (pageCount - 1) * gap / 2;
      for (var d = 0; d < pageCount; d++) {
        if (Math.abs(x - (start + d * gap)) < 12) { goTo(d); return; }
      }
    }
  }

  function toCanvas(e) {
    var rect = cv.getBoundingClientRect();
    var t = (e.changedTouches && e.changedTouches[0]) || e;
    return [(t.clientX - (rect.left || 0)) * W / (rect.width || W),
      (t.clientY - (rect.top || 0)) * H / (rect.height || H)];
  }

  if (cv.addEventListener) {
    // The original Xiaomi JsCanvas cards receive pointer events, not mouse/touch events.
    // Register just this event family to avoid duplicate browser compatibility events.
    var activePointer = null;
    function acceptsPointer(e) {
      return activePointer == null || e.pointerId === undefined || e.pointerId === activePointer;
    }
    function cancelPointer() {
      downX = downY = lastY = null;
      dragAxis = null;
      activePointer = null;
      if (pullDistance) { pullDistance = 0; requestDraw(); }
    }
    cv.addEventListener('pointerdown', function (e) {
      if (e.isPrimary === false || downX != null) return;
      if (e.preventDefault) e.preventDefault();
      activePointer = e.pointerId === undefined ? null : e.pointerId;
      var p = toCanvas(e); onDown(p[0], p[1]);
      if (cv.setPointerCapture && e.pointerId !== undefined) {
        try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      }
    }, { passive: false });
    cv.addEventListener('pointermove', function (e) {
      if (!acceptsPointer(e)) return;
      var p = toCanvas(e); onMove(p[0], p[1]);
    });
    cv.addEventListener('pointerup', function (e) {
      if (!acceptsPointer(e)) return;
      var p = toCanvas(e); onUp(p[0], p[1]);
      activePointer = null;
    });
    cv.addEventListener('pointercancel', cancelPointer);
    cv.addEventListener('lostpointercapture', cancelPointer);
    cv.addEventListener('pointerleave', function (e) {
      if (!cv.hasPointerCapture || e.pointerId === undefined || !cv.hasPointerCapture(e.pointerId)) cancelPointer();
    });
    cv.addEventListener('wheel', function (e) {
      if (detailMaxScroll > 0) {
        detailScroll = Math.max(0, Math.min(detailMaxScroll, detailScroll + e.deltaY));
        requestDraw();
        e.preventDefault();
      }
    }, { passive: false });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') goTo(page + 1);
      if (e.key === 'ArrowLeft') goTo(page - 1);
      if (e.key === 'Home') goTo(0);
      if (e.key === 'ArrowDown' && detailMaxScroll > 0) { detailScroll = Math.min(detailMaxScroll, detailScroll + 60); requestDraw(); }
      if (e.key === 'ArrowUp' && detailMaxScroll > 0) { detailScroll = Math.max(0, detailScroll - 60); requestDraw(); }
    });
  }

  requestDraw();
})();
