// Codex 用量背屏卡片 · 经典 JS（QuickJS Canvas 运行时兼容：无 ES Module、无远程资源）
(function () {
  'use strict';

  var cfg = window.CARD_CONFIG || {};
  var cv = document.getElementById('rear');
  var ctx = cv.getContext('2d');
  var W = window.CANVAS_W || 912, H = window.CANVAS_H || 596;

  // 左侧约 296px 为摄像头区域，内容区右移
  var L = 336, R = 876, CW = R - L;

  var C = {
    bg0: '#101014', bg1: '#17171f',
    panel: 'rgba(255,255,255,0.055)', panelEdge: 'rgba(255,255,255,0.10)',
    text: '#f2f3f7', sub: '#9aa0ae', dim: '#6b7180',
    track: 'rgba(255,255,255,0.12)'
  };

  function barColor(p) {
    if (p >= 90) return '#f85149';
    if (p >= 70) return '#d29922';
    return '#3fb950';
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

  // 静态 logo：随载体包 assets/ 安装，不占用热更新脚本体积。
  // 加载失败时退回到 Canvas 绘制的六瓣结占位。
  var logoImg = null;
  (function () {
    var img = new Image();
    img.onload = function () { logoImg = img; draw(); };
    img.onerror = function () { draw(); };
    img.src = cfg.logoAsset || 'assets/openai.png';
  })();

  function logo(cx, cy, r) {
    // 占位回退：logo 位图加载失败时绘制的简约六瓣结
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = '#e8e9f0';
    ctx.lineWidth = r * 0.34;
    ctx.lineCap = 'round';
    for (var i = 0; i < 6; i++) {
      var a = i * Math.PI / 3;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.42, Math.sin(a) * r * 0.42);
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.stroke();
    }
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

  function usagePanel(y, h, title, win) {
    var known = win && typeof win.usedPercent === 'number';
    var pct = known ? Math.max(0, Math.min(100, Math.round(win.usedPercent))) : 0;
    var numberText = known ? pct + '' : '—';
    var color = known ? barColor(pct) : C.dim;

    round(L, y, CW, h, 24);
    ctx.fillStyle = C.panel;
    ctx.fill();
    ctx.strokeStyle = C.panelEdge;
    ctx.lineWidth = 1.5;
    ctx.stroke();

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
    ctx.fillText(known ? (pct >= 90 ? '接近上限' : (pct >= 70 ? '用量偏高' : '余量充足')) : '暂无数据', L + CW - 32, y + 34);
    ctx.fillStyle = C.sub;
    ctx.font = '400 23px sans-serif';
    ctx.fillText(fmtReset(win.resetAt), L + CW - 32, y + h - 34);
    ctx.textAlign = 'left';

    // 进度条
    var bw = iw, bh = 14, by = y + h - 66;
    round(ix, by, bw, bh, bh / 2);
    ctx.fillStyle = C.track;
    ctx.fill();
    if (pct > 0) {
      round(ix, by, Math.max(bh, bw * pct / 100), bh, bh / 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  function draw() {
    // 背景
    var g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, C.bg0);
    g.addColorStop(1, C.bg1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 头部
    if (logoImg) ctx.drawImage(logoImg, L + 1, 41, 40, 40);
    else logo(L + 22, 62, 17);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = C.text;
    ctx.font = '700 32px sans-serif';
    ctx.fillText('OpenAI Codex', L + 52, 56);
    ctx.fillStyle = C.sub;
    ctx.font = '400 22px sans-serif';
    ctx.fillText('套餐用量' + (cfg.updatedAt ? ' · 更新于 ' + fmtClock(cfg.updatedAt) : ''), L + 52, 91);
    badge(R, 62, (cfg.planType || '未知套餐').toUpperCase());

    // 用量面板：Plus 等套餐有 5 小时 + 每周双窗口；Pro 无 5 小时窗口，单面板放大展示
    var hasPrimary = cfg.primary && typeof cfg.primary.usedPercent === 'number';
    if (hasPrimary) {
      usagePanel(118, 208, '5 小时限额', cfg.primary);
      usagePanel(342, 208, '本周限额', cfg.secondary || {});
    } else {
      usagePanel(140, 300, '本周限额', cfg.secondary || {});
      ctx.fillStyle = C.sub;
      ctx.font = '400 23px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(cfg.secondary ? '当前套餐无 5 小时限额' : '暂未返回用量窗口', (L + R) / 2, 500);
      ctx.textAlign = 'left';
    }

  }

  draw();
})();
