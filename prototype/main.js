// AI 用量背屏卡片 · QuickJS Canvas（无 ES Module、无远程资源、无 ctx.filter / 新 DOM / 离屏画布）
// 有来源：最左 minimal，≥2 个来源再加 overview，其后各 provider:<id>。无来源为空态。
// 默认页仍是多来源总览、单来源详情。横滑跟手并以 360ms 缓入缓出；下拉阻尼，松手 200ms 回弹。
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
  var PAGE_MS = 360, PULL_MS = 200, PULL_THRESHOLD = 80, SWIPE_DISTANCE = 60;
  // 与 HoyoLab 相同的右上角安全边界；顶部不能沿用下方内容面板的右边缘。
  var HEADER_R = 838, HEADER_W = HEADER_R - L, HEADER_PAD = 22;
  var MINIMAL_Y = 30, MINIMAL_LOGO = 34, MINIMAL_TEXT_GAP = 10;

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

  function clamp(n, a, b) {
    if (n < a) return a;
    if (n > b) return b;
    return n;
  }

  function now() { return Date.now(); }

  function hasRAF() {
    return typeof window.requestAnimationFrame === 'function';
  }

  function easeInOut(progress) {
    var p = clamp(progress, 0, 1);
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  }

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
    var nowSec = now() / 1000;
    var d = new Date(ts * 1000);
    var diff = ts - nowSec;
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
    var nowSec = now() / 1000;
    var d = new Date(ts * 1000);
    var diff = ts - nowSec;
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

  // 当前壁纸。只解码这一对 sharp/blur，换图时丢掉上一张。
  var wallpaperToken = 0;
  var wall = {
    id: null, sharpSrc: null, blurSrc: null,
    sharpImg: null, blurImg: null,
    sharpReady: false, blurReady: false, sharpFailed: false
  };
  var layerX = 0, layerY = 0;

  function detachImage(img) {
    if (!img) return;
    img.onload = null;
    img.onerror = null;
  }

  function clearWallpaperImages() {
    detachImage(wall.sharpImg);
    detachImage(wall.blurImg);
    wall.sharpImg = null;
    wall.blurImg = null;
    wall.sharpReady = false;
    wall.blurReady = false;
    wall.sharpFailed = false;
  }

  function loadWallImage(src, token, which) {
    if (!src || typeof Image !== 'function') return;
    var img = new Image();
    if (which === 'sharp') wall.sharpImg = img;
    else wall.blurImg = img;
    img.onload = function () {
      if (token !== wallpaperToken) return;
      if (which === 'sharp') { wall.sharpReady = true; wall.sharpFailed = false; }
      else wall.blurReady = true;
      requestDraw();
    };
    img.onerror = function () {
      if (token !== wallpaperToken) return;
      if (which === 'sharp') { wall.sharpReady = false; wall.sharpFailed = true; }
      else wall.blurReady = false;
      requestDraw();
    };
    try {
      img.src = src;
      // 原生 Data URL 已同步解码，但 onload 会排到首帧之后；不能只等回调。
      if (img.complete && img.width > 0 && img.height > 0) img.onload();
    }
    catch (err) {
      if (which === 'sharp') wall.sharpFailed = true;
    }
  }

  function setWallpaperInternal(pair) {
    if (!pair || typeof pair !== 'object' || typeof pair.sharp !== 'string' || !pair.sharp) {
      wallpaperToken++;
      wall.id = null;
      wall.sharpSrc = null;
      wall.blurSrc = null;
      clearWallpaperImages();
      return;
    }
    var id = typeof pair.id === 'string' ? pair.id : '';
    var blurSrc = typeof pair.blur === 'string' ? pair.blur : '';
    if (wall.id === id && wall.sharpSrc === pair.sharp && wall.blurSrc === blurSrc &&
        wall.sharpImg && !wall.sharpFailed) return;
    wallpaperToken++;
    var token = wallpaperToken;
    clearWallpaperImages();
    wall.id = id;
    wall.sharpSrc = pair.sharp;
    wall.blurSrc = blurSrc;
    loadWallImage(pair.sharp, token, 'sharp');
    if (blurSrc) loadWallImage(blurSrc, token, 'blur');
  }

  function wallpaperOn() {
    return !!(wall.sharpReady && wall.sharpImg);
  }

  // 无壁纸时与原面板一致；有壁纸时用同构图预模糊裁出深色柔光玻璃。
  function panel(x, y, w, h) {
    var radius = 24;
    if (!wallpaperOn()) {
      round(x, y, w, h, radius);
      ctx.fillStyle = C.panel;
      ctx.fill();
      ctx.strokeStyle = C.panelEdge;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      return;
    }
    ctx.save();
    round(x, y, w, h, radius);
    ctx.clip();
    if (wall.blurReady && wall.blurImg && typeof ctx.drawImage === 'function') {
      ctx.drawImage(wall.blurImg, -layerX, -layerY, W, H);
    }
    ctx.fillStyle = 'rgba(10,12,18,0.62)';
    round(x, y, w, h, radius);
    ctx.fill();
    if (ctx.createLinearGradient) {
      var glow = ctx.createLinearGradient(x, y, x + w * 0.25, y + h);
      glow.addColorStop(0, 'rgba(255,255,255,0.16)');
      glow.addColorStop(0.45, 'rgba(255,255,255,0.05)');
      glow.addColorStop(1, 'rgba(0,0,0,0.20)');
      ctx.fillStyle = glow;
      round(x, y, w, h, radius);
      ctx.fill();
    }
    ctx.restore();
    round(x, y, w, h, radius);
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function headerGlass(x, y, w, h) {
    if (!wallpaperOn() || !(w > 0) || !(h > 0)) return;
    var radius = 18;
    ctx.save();
    round(x, y, w, h, radius);
    ctx.clip();
    if (wall.blurReady && wall.blurImg && typeof ctx.drawImage === 'function') {
      ctx.drawImage(wall.blurImg, -layerX, -layerY, W, H);
    }
    ctx.fillStyle = 'rgba(8,10,16,0.58)';
    round(x, y, w, h, radius);
    ctx.fill();
    if (ctx.createLinearGradient) {
      var sheen = ctx.createLinearGradient(x, y, x, y + h);
      sheen.addColorStop(0, 'rgba(255,255,255,0.16)');
      sheen.addColorStop(1, 'rgba(255,255,255,0.03)');
      ctx.fillStyle = sheen;
      round(x, y, w, h, radius);
      ctx.fill();
    }
    ctx.restore();
    round(x, y, w, h, radius);
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function paintSpinner(x, y, radius) {
    var angle = ((now() % 900) / 900) * Math.PI * 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.arc(0, 0, radius || 8, 0.2, Math.PI * 1.35);
    ctx.strokeStyle = 'rgba(242,243,247,0.92)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
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

  function percentLabel(p) {
    var win = shortWindow(p);
    if (!win) return '—';
    return clamp(Math.round(win.usedPercent), 0, 100) + '%';
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

  function drawHome(active) {
    headerGlass(L, 20, HEADER_W, 84);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = C.text;
    ctx.font = '700 32px sans-serif';
    ctx.fillText('AI 用量', L + HEADER_PAD, 56);
    ctx.fillStyle = C.sub;
    ctx.font = '400 22px sans-serif';
    var hint = refreshHint() || providers.length + ' 个来源' + (cfg.updatedAt ? ' · 更新于 ' + fmtClock(cfg.updatedAt) : '');
    ctx.fillText(hint, L + HEADER_PAD, 91);
    if (active && refreshing) paintSpinner(L + HEADER_PAD + ctx.measureText(hint).width + 22, 91, 8);
    badge(HEADER_R - HEADER_PAD, 62, '总览');

    for (var i = 0; i < providers.length; i++) drawHomeCell(providers[i], i);
  }

  function minimalLayout() {
    var items = [];
    var slotWidth = (HEADER_W - HEADER_PAD * 2) / providers.length;
    ctx.font = '600 24px sans-serif';
    var i;
    for (i = 0; i < providers.length; i++) {
      var p = providers[i];
      var label = percentLabel(p);
      var tw = ctx.measureText(label).width;
      var w = MINIMAL_LOGO + MINIMAL_TEXT_GAP + tw;
      var x = L + HEADER_PAD + i * slotWidth + (slotWidth - w) / 2;
      items.push({ id: p.id, provider: p, x: x, y: MINIMAL_Y, w: w, h: MINIMAL_LOGO, label: label });
    }
    return items;
  }

  function drawMinimal(active) {
    var items = minimalLayout();
    if (items.length) headerGlass(L, 16, HEADER_W, 56);
    var i;
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      brandMark(it.provider, it.x, it.y, MINIMAL_LOGO);
      ctx.font = '600 24px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = C.text;
      ctx.fillText(it.label, it.x + MINIMAL_LOGO + MINIMAL_TEXT_GAP, it.y + MINIMAL_LOGO / 2 + 1);
    }
    if (!active) return;
    if (refreshing) {
      paintSpinner(L + 8, 86, 7);
      return;
    }
    var shown = pullOffset();
    if (shown > 1) {
      var pct = pullDistance > 0 ? Math.min(1, pullDistance / PULL_THRESHOLD) : 0;
      round(L, 82, 64 * Math.max(pct, 0.18), 4, 2);
      ctx.fillStyle = 'rgba(255,255,255,0.82)';
      ctx.fill();
    }
  }

  // ---------- 详情页 ----------
  function drawDetailHeader(p, active) {
    headerGlass(L, 20, HEADER_W, 84);
    brandMark(p, L + HEADER_PAD, 42, 40);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = C.text;
    ctx.font = '700 32px sans-serif';
    ctx.fillText(p.name, L + HEADER_PAD + 52, 56);
    ctx.fillStyle = C.sub;
    ctx.font = '400 22px sans-serif';
    var hint = refreshHint() || '套餐用量' + (p.updatedAt || cfg.updatedAt ? ' · 更新于 ' + fmtClock(p.updatedAt || cfg.updatedAt) : '');
    ctx.fillText(hint, L + HEADER_PAD + 52, 91);
    if (active && refreshing) paintSpinner(L + HEADER_PAD + 52 + ctx.measureText(hint).width + 20, 91, 8);
    badge(HEADER_R - HEADER_PAD, 62, (p.plan || '未知套餐').toUpperCase());
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

  function extraLines(p) {
    var lines = (p.details || []).slice();
    if (p.credits) {
      lines.push('已用 ' + fmtBig(p.credits.used) + ' / 总量 ' + fmtBig(p.credits.limit) + ' Credits');
      if (p.credits.periodEnd) lines.push('当前周期至 ' + fmtDate(p.credits.periodEnd));
    }
    if (p.booster) {
      lines.push('加油包余额 ' + fmtMoney(p.booster.amount, p.booster.currency) +
        (p.booster.monthlyUsed != null ? ' · 本月已用 ' + fmtMoney(p.booster.monthlyUsed, p.booster.currency) : ''));
    }
    return lines;
  }

  function detailScrollLimit(p) {
    if (!p || p.id === 'deepseek') return 0;
    var wins = p.windows || [];
    if (wins.length <= 1) return 0;
    var lines = extraLines(p);
    var contentH = wins.length * 224 - 16 + (lines.length ? 16 + 104 : 0);
    return Math.max(0, contentH - SCROLL_H);
  }

  function drawDetail(p, active) {
    drawDetailHeader(p, active);
    var wins = p.windows || [];
    var lines = extraLines(p);
    var scroll = active ? detailScroll : 0;

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
      return;
    }

    // 多窗口（如 Kimi 老套餐 5h + 每周 + 月度）：纵向滚动列表，明细面板跟在末尾
    var stride = 224;
    ctx.save();
    ctx.beginPath();
    ctx.rect(L - 8, SCROLL_TOP, CW + 16, SCROLL_H);
    ctx.clip();
    for (var wi = 0; wi < wins.length; wi++) {
      usagePanel(SCROLL_TOP - scroll + wi * stride, 208, wins[wi].title, wins[wi]);
    }
    if (lines.length) {
      infoPanel(SCROLL_TOP - scroll + wins.length * stride, 104, '明细', lines.slice(0, 2));
    }
    ctx.restore();

    // 右侧滚动条
    var maxScroll = active ? detailMaxScroll : detailScrollLimit(p);
    if (maxScroll > 0) {
      var contentH = wins.length * stride - 16 + (lines.length ? 16 + 104 : 0);
      var trackH = SCROLL_H, tx = R + 10;
      var thumbH = Math.max(36, trackH * SCROLL_H / contentH);
      var thumbY = SCROLL_TOP + (trackH - thumbH) * scroll / maxScroll;
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
  // 有来源必有 minimal；≥2 个来源加 overview；再按稳定 key 排各详情。
  var pages = [];
  var pageIndex = 0;
  var pagePosition = 0;
  var pageAnim = null;
  var pageListener = null;

  var SCROLL_TOP = 110, SCROLL_H = 456;
  var detailScroll = 0, detailMaxScroll = 0;
  var refreshHandler = null, refreshing = false, refreshError = false, pullDistance = 0;
  var pullVisual = 0, pullAnim = null;

  function rebuildPages() {
    pages = [];
    if (!providers.length) return;
    pages.push({ key: 'minimal', type: 'minimal' });
    if (providers.length >= 2) pages.push({ key: 'overview', type: 'overview' });
    var i;
    for (i = 0; i < providers.length; i++) {
      pages.push({ key: 'provider:' + providers[i].id, type: 'detail', id: providers[i].id });
    }
  }

  function defaultKey() {
    if (providers.length >= 2) return 'overview';
    if (providers.length === 1) return 'provider:' + providers[0].id;
    return null;
  }

  function indexForKey(key) {
    if (!key) return -1;
    var i;
    for (i = 0; i < pages.length; i++) if (pages[i].key === key) return i;
    return -1;
  }

  function currentKey() {
    var page = pages[pageIndex];
    return page ? page.key : null;
  }

  function providerById(id) {
    var i;
    for (i = 0; i < providers.length; i++) if (providers[i].id === id) return providers[i];
    return null;
  }

  function bootIndex(key) {
    var idx = indexForKey(key);
    if (idx < 0) idx = indexForKey(defaultKey());
    if (idx < 0) idx = 0;
    pageIndex = pages.length ? idx : 0;
    pagePosition = pages.length ? pageIndex : 0;
    pageAnim = null;
    detailScroll = 0;
  }

  function refreshHint() {
    if (refreshing) return '刷新中…';
    if (pullDistance > 0) return pullDistance >= PULL_THRESHOLD ? '松开刷新' : '下拉刷新';
    return refreshError ? '刷新失败，请重试' : '';
  }

  function refreshScopeId() {
    var page = pages[pageIndex];
    if (page && page.type === 'detail') return page.id;
    return null;
  }

  function refreshCurrent() {
    if (!refreshHandler || refreshing) return;
    var id = refreshScopeId();
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

  function drawDots(activeIndex) {
    if (pages.length <= 1) return;
    var cx = (L + R) / 2, y = 576, gap = 22;
    var start = cx - (pages.length - 1) * gap / 2;
    for (var i = 0; i < pages.length; i++) {
      ctx.beginPath();
      ctx.arc(start + i * gap, y, i === activeIndex ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === activeIndex ? '#a8c0ff' : 'rgba(255,255,255,0.22)';
      ctx.fill();
    }
  }

  function paintPage(index) {
    var page = pages[index];
    if (!page) return;
    var active = index === pageIndex;
    if (page.type === 'minimal') {
      drawMinimal(active);
      return;
    }
    if (page.type === 'overview') drawHome(active);
    else {
      var provider = providerById(page.id);
      if (provider) drawDetail(provider, active);
    }
    drawDots(index);
  }

  function paintBackdrop() {
    var g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, C.bg0);
    g.addColorStop(1, C.bg1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (wallpaperOn() && typeof ctx.drawImage === 'function') {
      ctx.drawImage(wall.sharpImg, 0, 0, W, H);
    }
  }

  function syncActiveScroll() {
    var page = pages[pageIndex];
    var limit = 0;
    if (page && page.type === 'detail') limit = detailScrollLimit(providerById(page.id));
    detailMaxScroll = limit;
    detailScroll = clamp(detailScroll, 0, limit);
  }

  function tickMotion() {
    var t = now();
    if (pageAnim) {
      var p = (t - pageAnim.start) / PAGE_MS;
      if (p >= 1) {
        pagePosition = pageAnim.to;
        pageAnim = null;
      } else {
        pagePosition = pageAnim.from + (pageAnim.to - pageAnim.from) * easeInOut(p);
      }
    }
    if (pullAnim) {
      var q = (t - pullAnim.start) / PULL_MS;
      if (q >= 1) {
        pullAnim = null;
        pullVisual = 0;
      } else pullVisual = pullAnim.from * (1 - easeInOut(q));
    }
  }

  function dampPull(raw) {
    if (!(raw > 0)) return 0;
    var damped = raw * 0.34;
    return damped > 96 ? 96 : damped;
  }

  function pullOffset() {
    if (pullAnim) return pullVisual;
    if (pullDistance > 0) return dampPull(pullDistance);
    return 0;
  }

  function fingerShift(base, dx) {
    var proposed = base - dx / W;
    var max = Math.max(0, pages.length - 1);
    if (proposed < 0) return proposed * 0.28;
    if (proposed > max) return max + (proposed - max) * 0.28;
    return proposed;
  }

  function visualPosition() {
    if (downX != null && dragAxis === 'h') return fingerShift(pagePosition, lastMoveX - downX);
    return pagePosition;
  }

  function armPageAnim(from, to) {
    if (!isFinite(from)) from = to;
    if (!pages.length || !hasRAF() || Math.abs(from - to) < 0.001) {
      pageAnim = null;
      pagePosition = pages.length ? to : 0;
      return;
    }
    pageAnim = { from: from, to: to, start: now() };
    pagePosition = from;
  }

  function armPull(from) {
    pullDistance = 0;
    if (!(from > 0.5) || !hasRAF()) {
      pullAnim = null;
      pullVisual = 0;
      return;
    }
    pullAnim = { from: from, start: now() };
    pullVisual = from;
  }

  function applyIndex(next, from, notify) {
    if (!pages.length) {
      pageIndex = 0;
      pageAnim = null;
      pagePosition = 0;
      requestDraw();
      return;
    }
    next = clamp(next, 0, pages.length - 1);
    var prevKey = currentKey();
    pageIndex = next;
    var nextKey = currentKey();
    if (nextKey !== prevKey) {
      detailScroll = 0;
      refreshError = false;
      pullDistance = 0;
      pullAnim = null;
      pullVisual = 0;
    }
    armPageAnim(from, next);
    if (notify && nextKey !== prevKey && pageListener) pageListener(nextKey);
    requestDraw();
  }

  function previewPos() {
    tickMotion();
    return visualPosition();
  }

  // JsCanvas 只在原生帧记录期间发布绘制。触摸与图片回调都延迟到 RAF，
  // 空闲时不保持循环；翻页、下拉回弹或刷新转圈期间才继续要帧。
  function requestDraw() {
    if (renderQueued) return;
    if (!hasRAF()) {
      renderQueued = true;
      try { draw(); } finally { renderQueued = false; }
      return;
    }
    renderQueued = true;
    window.requestAnimationFrame(function () {
      renderQueued = false;
      draw();
    });
  }

  function draw() {
    tickMotion();
    syncActiveScroll();
    var pos = visualPosition();
    var py = pullOffset();
    paintBackdrop();
    detailMaxScroll = pages[pageIndex] && pages[pageIndex].type === 'detail' ? detailMaxScroll : 0;
    if (!pages.length) drawEmpty();
    else {
      var i;
      for (i = 0; i < pages.length; i++) {
        var ox = (i - pos) * W;
        if (ox <= -W || ox >= W) continue;
        layerX = ox;
        layerY = py;
        ctx.save();
        ctx.translate(ox, py);
        paintPage(i);
        ctx.restore();
      }
    }
    layerX = 0;
    layerY = 0;
    var done = afterDraw;
    afterDraw = null;
    if (done) done();
    if (hasRAF() && (refreshing || pageAnim || pullAnim)) requestDraw();
  }

  function placePage(key, keepScroll, previousKey) {
    var prevKey = previousKey === undefined ? currentKey() : previousKey;
    var prevScroll = detailScroll;
    var idx = indexForKey(key);
    if (idx < 0) idx = indexForKey(defaultKey());
    if (idx < 0) idx = 0;
    pageIndex = pages.length ? idx : 0;
    pageAnim = null;
    pagePosition = pages.length ? pageIndex : 0;
    var same = pages.length > 0 && currentKey() === prevKey;
    detailScroll = same && keepScroll ? prevScroll : 0;
    syncActiveScroll();
  }

  // 模块只替换数据，不重建手势监听或改变既有布局。
  window.AiUsageCard = {
    onRefresh: function (handler) { refreshHandler = handler; },
    onPageChange: function (handler) { pageListener = typeof handler === 'function' ? handler : null; },
    getState: function () {
      var page = pages[pageIndex];
      return {
        pageKey: page ? page.key : null,
        scrollY: page && page.type === 'detail' ? detailScroll : 0
      };
    },
    setWallpaper: function (pair) {
      setWallpaperInternal(pair);
      requestDraw();
    },
    restorePage: function (key) {
      placePage(key, true);
      downX = null;
      dragAxis = null;
      pullDistance = 0;
      pullAnim = null;
      pullVisual = 0;
      requestDraw();
    },
    update: function (config, done) {
      var next = config || {};
      var keepWall = !Object.prototype.hasOwnProperty.call(next, 'wallpaper');
      var keepPage = !Object.prototype.hasOwnProperty.call(next, 'pageKey');
      var prevKey = currentKey();
      cfg = next;
      providers = cfg.providers || [];
      rebuildPages();
      placePage(keepPage ? prevKey : next.pageKey, true, prevKey);
      afterDraw = typeof done === 'function' ? done : null;
      loadLogos();
      if (!keepWall) setWallpaperInternal(next.wallpaper);
      requestDraw();
    }
  };

  function hitDots(x, y) {
    if (pages.length <= 1 || y <= 556) return -1;
    var gap = 22;
    var start = (L + R) / 2 - (pages.length - 1) * gap / 2;
    var d;
    for (d = 0; d < pages.length; d++) {
      if (Math.abs(x - (start + d * gap)) < 12) return d;
    }
    return -1;
  }

  function handleTap(x, y) {
    var page = pages[pageIndex];
    if (!page) return;
    var from = previewPos();
    var i;
    if (page.type === 'minimal') {
      var items = minimalLayout();
      for (i = 0; i < items.length; i++) {
        var it = items[i];
        if (x >= it.x && x <= it.x + it.w && y >= it.y - 10 && y <= it.y + it.h + 14) {
          var dest = indexForKey('provider:' + it.id);
          if (dest >= 0) applyIndex(dest, from, true);
          return;
        }
      }
      return;
    }
    if (page.type === 'overview') {
      for (i = 0; i < providers.length; i++) {
        var r = cellRect(i);
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
          var cellDest = indexForKey('provider:' + providers[i].id);
          if (cellDest >= 0) applyIndex(cellDest, from, true);
          return;
        }
      }
    } else if (page.type === 'detail' && y < 110 && x >= L && indexForKey('overview') >= 0) {
      applyIndex(indexForKey('overview'), from, true);
      return;
    }
    var dot = hitDots(x, y);
    if (dot >= 0) applyIndex(dot, from, true);
  }

  // ---------- 交互（原型预览：鼠标/触摸/键盘；运行时以载体事件为准） ----------
  var downX = null, downY = null, lastY = null, lastMoveX = 0, dragAxis = null, pullFromTop = false;

  function pageCanPull() {
    if (typeof refreshHandler !== 'function') return false;
    var page = pages[pageIndex];
    if (!page) return false;
    if (page.type === 'detail') return detailScroll <= 0;
    return page.type === 'minimal' || page.type === 'overview';
  }

  function onDown(x, y) {
    downX = x;
    downY = y;
    lastY = y;
    lastMoveX = x;
    dragAxis = null;
    pullFromTop = pageCanPull();
    pullDistance = 0;
    pullAnim = null;
    pullVisual = 0;
  }

  function onMove(x, y) {
    if (downX == null) return;
    lastMoveX = x;
    var dx = x - downX, dy = y - downY;
    if (!dragAxis) {
      if (Math.abs(dy) > Math.abs(dx) + 8) {
        dragAxis = 'v';
        if (pageAnim) {
          pageIndex = pageAnim.to;
          pagePosition = pageAnim.to;
          pageAnim = null;
        }
      } else if (Math.abs(dx) > Math.abs(dy) + 8) {
        dragAxis = 'h';
        tickMotion();
        pageAnim = null;
      }
    }
    if (dragAxis === 'v' && pullFromTop && y > downY) {
      pullDistance = y - downY;
      requestDraw();
    } else if (dragAxis === 'v' && pages[pageIndex] && pages[pageIndex].type === 'detail' && detailMaxScroll > 0) {
      if (pullFromTop && y <= downY) pullDistance = 0;
      detailScroll = clamp(detailScroll - (y - lastY), 0, detailMaxScroll);
      lastY = y;
      requestDraw();
    } else if (dragAxis === 'h') {
      requestDraw();
    }
  }

  function onUp(x, y) {
    if (downX == null) return;
    var dx = x - downX, dy = y - downY;
    var axis = dragAxis;
    var fromTop = pullFromTop;
    lastMoveX = x;
    var fromH = axis === 'h' ? fingerShift(pagePosition, dx) : pagePosition;
    var pulled = dampPull(pullDistance);
    downX = null;
    downY = null;
    lastY = null;
    dragAxis = null;
    pullDistance = 0;
    if (axis === 'h') {
      var dir = 0;
      if (Math.abs(dx) >= SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy)) dir = dx < 0 ? 1 : -1;
      applyIndex(pageIndex + dir, fromH, true);
      return;
    }
    if (axis === 'v' || (!axis && dy > Math.abs(dx) + 8 && dy >= PULL_THRESHOLD)) {
      armPull(pulled);
      if (fromTop && dy >= PULL_THRESHOLD && dy > Math.abs(dx) + 8) refreshCurrent();
      else requestDraw();
      return;
    }
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) {
      if (pulled > 0) armPull(pulled);
      else requestDraw();
      return;
    }
    handleTap(x, y);
  }

  function toCanvas(e) {
    var rect = cv.getBoundingClientRect();
    var t = (e.changedTouches && e.changedTouches[0]) || e;
    return [(t.clientX - (rect.left || 0)) * W / (rect.width || W),
      (t.clientY - (rect.top || 0)) * H / (rect.height || H)];
  }

  if (cv.addEventListener) {
    // 原生背屏只收 pointer，不再注册浏览器兼容的 mouse/touch。
    var activePointer = null;
    function acceptsPointer(e) {
      return activePointer == null || e.pointerId === undefined || e.pointerId === activePointer;
    }
    function cancelPointer(e) {
      if (e && e.pointerId !== undefined && activePointer != null && e.pointerId !== activePointer) return;
      if (downX == null) {
        activePointer = null;
        return;
      }
      var axis = dragAxis;
      var fromH = axis === 'h' ? fingerShift(pagePosition, lastMoveX - downX) : pagePosition;
      var pulled = dampPull(pullDistance);
      downX = null;
      downY = null;
      lastY = null;
      dragAxis = null;
      activePointer = null;
      pullDistance = 0;
      if (axis === 'h') {
        applyIndex(pageIndex, fromH, false);
        return;
      }
      if (pulled > 0) armPull(pulled);
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
      var page = pages[pageIndex];
      if (page && page.type === 'detail' && detailMaxScroll > 0) {
        detailScroll = clamp(detailScroll + e.deltaY, 0, detailMaxScroll);
        requestDraw();
        e.preventDefault();
      }
    }, { passive: false });
    document.addEventListener('keydown', function (e) {
      if (!e) return;
      if (e.key === 'ArrowRight') applyIndex(pageIndex + 1, previewPos(), true);
      if (e.key === 'ArrowLeft') applyIndex(pageIndex - 1, previewPos(), true);
      if (e.key === 'Home') {
        var home = indexForKey(defaultKey());
        if (home >= 0) applyIndex(home, previewPos(), true);
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && pages[pageIndex] &&
          pages[pageIndex].type === 'detail' && detailMaxScroll > 0) {
        detailScroll = clamp(detailScroll + (e.key === 'ArrowDown' ? 60 : -60), 0, detailMaxScroll);
        requestDraw();
      }
    });
  }

  rebuildPages();
  bootIndex(cfg.pageKey);
  loadLogos();
  setWallpaperInternal(cfg.wallpaper);
  requestDraw();
})();
