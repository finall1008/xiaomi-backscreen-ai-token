/*
 * AI 用量背屏 · 模块设置页（webroot/main.js）。
 *
 * 脚本顺序：bridge-shim.js（宿主注入，定义 window.bridge）→ core.js（构建复制，
 * 定义 window.AiUsageCore）→ appearance.js（构建复制，定义 window.AiUsageAppearance）→
 * wallpapers.js（定义 window.AiUsageWallpaperSettings）→ 本文件。bridge 为 undefined（普通网页打开）时只提示
 * 「请在卡片桥内打开模块设置」并禁用写入与网络操作：不伪造桥、不回退浏览器本地存储、
 * 不发送任何真实请求，也不演示数据。
 *
 * 职责：
 *   - Kimi Code / DeepSeek 保存 API Key 并刷新；Codex 设备码登录（可取消、外链验证、手动复制）；
 *     MiMo 与 Cursor 使用桥的独立登录窗口，关闭窗口后检查登录；Cookie 留在宿主的模块 Profile 中。
 *     MiMo 仍先获取签名登录入口；Cursor 直接打开用量页，没有签名入口。
 *   - 每个来源可勾选是否在背屏显示，最多 4 个，勾选后自动保存；取消勾选只隐藏预览与背屏，不清除凭据或网页会话。
 *   - 凭据只经 core 写入 bridge.storage。
 *     凭据不进日志、不进预览消息、不落浏览器本地存储。
 *   - 用量、授权或背屏勾选变化后调用 bridge.card.requestRefresh() 让卡片重读缓存。
 */
(function () {
  'use strict';

  /** MiMo / Cursor / Antigravity 通过原生网络请求；其他来源保持 WebView fetch。 */
  var WEBUI_REFRESHABLE = { codex: true, kimi: true, deepseek: true, mimo: true, cursor: true, antigravity: true };
  var CURSOR_USAGE_PAGE = 'https://cursor.com/dashboard/usage';
  var MAX_CARD_PROVIDERS = 4;

  var bridge = window.bridge;
  var core = window.AiUsageCore;
  var client = null;
  var rows = [];
  var rowErrors = {};
  var busy = false;
  var previewReady = false;
  var currentWallpaper = null;
  var previewPageReady = false;
  var previewPageSeed = null;
  var previewPageSent = false;
  var device = null;
  var antigravitySession = null;

  var dom = {};
  /** id -> { article, badge, cache, metrics, status, error, ... } */
  var ui = {};

  /* ---------- 基础工具 ---------- */

  function byId(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function formatClock(value) {
    var seconds = Number(value);
    if (!isFinite(seconds) || seconds <= 0) return '';
    if (seconds > 1e12) seconds = Math.floor(seconds / 1000);
    var date = new Date(seconds * 1000);
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
      ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function moneyText(balance) {
    var amount = Number(balance && balance.amount);
    if (!isFinite(amount)) return '—';
    var symbol = balance.currency === 'USD' ? '$' : '¥';
    return symbol + amount.toFixed(2);
  }

  function bigText(value) {
    var n = Number(value);
    if (!isFinite(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e11 ? 0 : 1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  function periodText(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value)) return value;
    return formatClock(value);
  }

  /** 错误只显示 core / 传输层给出的安全文案，绝不附带原始响应内容。 */
  function errorText(error) {
    if (!error) return '操作失败';
    var code = error.code;
    if (code === 'AUTH_REQUIRED') return error.message || '尚未登录或凭据已失效';
    if (code === 'CANCELLED') return '已取消';
    if (code === 'TIMEOUT') return '请求超时，结果未知（未自动重试）';
    if (error.message) return String(error.message);
    if (code) return '操作失败（' + code + '）';
    return '操作失败';
  }

  function statusText(row) {
    var status = row && row.status;
    if (!status) return '';
    var message = status.message || '';
    if (!message && status.code === 'AUTH_REQUIRED') message = '登录已失效，请重新授权';
    if (!message && status.code) message = '状态：' + status.code;
    var time = formatClock(status.updatedAt);
    return message ? (time ? message + ' · ' + time : message) : '';
  }

  function metricLines(snapshot, id) {
    var source = snapshot || {};
    var lines = [];
    var windows = source.windows || [];
    for (var i = 0; i < windows.length; i++) {
      var win = windows[i];
      if (!win || typeof win.usedPercent !== 'number') continue;
      var percent = Math.max(0, Math.min(100, Math.round(win.usedPercent)));
      var line = (win.title || '用量窗口') + ' · ' + percent + '%';
      var reset = formatClock(win.resetAt);
      if (reset) line += ' · 重置 ' + reset;
      lines.push(line);
    }
    if (source.balance) {
      var balanceLine = '余额 ' + moneyText(source.balance);
      if (source.balance.isAvailable === false) balanceLine += '（不足）';
      lines.push(balanceLine);
    }
    if (source.credits) {
      var creditsLine = 'Credits ' + bigText(source.credits.used) + ' / ' + bigText(source.credits.limit);
      var period = periodText(source.credits.periodEnd);
      if (period) creditsLine += ' · 周期至 ' + period;
      lines.push(creditsLine);
    }
    if (source.booster) {
      var boosterLine = '加油包 ' + moneyText(source.booster);
      if (source.booster.monthlyUsed != null) {
        boosterLine += ' · 本月已用 ' + moneyText({ amount: source.booster.monthlyUsed, currency: source.booster.currency });
      }
      lines.push(boosterLine);
    }
    if (id === 'cursor' && source.plan) lines.push('套餐 ' + source.plan);
    var details = source.details;
    if (Array.isArray(details)) {
      for (var d = 0; d < details.length; d++) {
        if (typeof details[d] === 'string' && details[d]) lines.push(details[d]);
      }
    }
    return lines;
  }

  /* ---------- 设置页网络传输 ---------- */

  /**
   * MiMo / Cursor 的显式 cookies 选项交给原生桥，保留响应头与手动跳转控制。
   * 其他来源使用 fetch + AbortController 超时，默认 30 秒，credentials:'omit'；
   * 失败只抛安全的通用错误，不附带原始响应。
   */
  function request(options) {
    if (options.cookies !== undefined) return bridge.net.request(options);
    return new Promise(function (resolve, reject) {
      var controller = new window.AbortController();
      var timeoutMs = options && options.timeoutMs != null ? Number(options.timeoutMs) : 30000;
      if (!isFinite(timeoutMs) || timeoutMs < 0) timeoutMs = 30000;
      var timedOut = false;
      var timer = null;
      if (timeoutMs > 0) {
        timer = window.setTimeout(function () {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
      }
      window.fetch(options.url, {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body,
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal
      }).then(function (response) {
        return response.text().then(function (body) {
          if (timer !== null) window.clearTimeout(timer);
          resolve({ status: response.status, body: body });
        });
      }).catch(function () {
        if (timer !== null) window.clearTimeout(timer);
        var error = new Error(timedOut ? '网络请求超时，结果未知' : '网络请求失败，请稍后重试');
        error.code = timedOut ? 'TIMEOUT' : 'ERROR';
        reject(error);
      });
    });
  }

  /* ---------- 来源卡片渲染 ---------- */

  function authKind(id) {
    if (id === 'codex') return 'device';
    if (id === 'antigravity') return 'antigravity';
    if (id === 'mimo' || id === 'cursor') return 'webview';
    return 'key';
  }

  function webviewNotice(id) {
    if (id === 'cursor') {
      return '在新窗口打开 Cursor 用量页并完成网页登录，关闭窗口后点“检查登录”。Cookie 留在模块独立 Profile，无需手动填写，设置页也不读取本机 Cookie。';
    }
    return '在卡片桥的独立窗口中登录小米账号，完成后关闭窗口，再点“检查登录”。设置页与背屏共用模块会话，无需复制 Cookie。需要支持模块独立会话的新版卡片桥。';
  }

  function authHtml(id) {
    var kind = authKind(id);
    if (kind === 'device') {
      return '' +
        '<div class="device-panel" id="device-' + id + '" hidden>' +
        '  <p class="muted">在浏览器中打开验证页面，确认下方验证码后回到本页等待完成。</p>' +
        '  <div class="code-row">' +
        '    <label class="field"><span>验证码</span>' +
        '      <input id="code-' + id + '" type="text" readonly spellcheck="false">' +
        '    </label>' +
        '    <button id="copy-' + id + '" type="button" class="btn">复制</button>' +
        '  </div>' +
        '  <div class="actions">' +
        '    <a id="verify-' + id + '" class="btn btn-link" href="#" target="_blank" rel="noreferrer noopener">打开验证页面</a>' +
        '    <button id="cancel-device-' + id + '" type="button" class="btn">取消登录</button>' +
        '  </div>' +
        '  <p class="device-status" id="device-status-' + id + '" role="status">等待验证中…</p>' +
        '</div>' +
        '<div class="actions">' +
        '  <button id="login-' + id + '" type="button" class="btn btn-primary">设备码登录</button>' +
        '  <button id="refresh-' + id + '" type="button" class="btn">刷新用量</button>' +
        '  <button id="clear-' + id + '" type="button" class="btn btn-danger">退出登录</button>' +
        '</div>';
    }
    if (kind === 'antigravity') {
      return '' +
        '<div class="pool-select" id="pool-' + id + '">' +
        '  <span class="pool-label">背屏总览优先展示</span>' +
        '  <label class="pool-option"><input id="pool-gemini-' + id + '" type="radio" name="pool-' + id + '" value="gemini" checked><span>Gemini</span></label>' +
        '  <label class="pool-option"><input id="pool-argon-' + id + '" type="radio" name="pool-' + id + '" value="argon"><span>Argon</span></label>' +
        '  <label class="pool-option"><input id="pool-claude-' + id + '" type="radio" name="pool-' + id + '" value="claude"><span>Claude / GPT</span></label>' +
        '</div>' +
        '<div class="device-panel" id="device-' + id + '" hidden>' +
        '  <p class="muted">在内置窗口中打开 Google 授权页面完成登录，复制页面显示的授权码（或跳转后的回调链接）粘贴到下方，点“确认登录”后才完成配置。</p>' +
        '  <div class="actions">' +
        '    <a id="verify-' + id + '" class="btn btn-link" href="#" target="_blank" rel="noreferrer noopener">打开授权页面</a>' +
        '    <button id="copy-' + id + '" type="button" class="btn">复制授权链接</button>' +
        '  </div>' +
        '  <label class="field"><span>授权码 / 回调链接 / Refresh Token</span>' +
        '    <input id="code-' + id + '" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="粘贴授权码、回调链接或 1// 刷新令牌">' +
        '  </label>' +
        '  <div class="actions">' +
        '    <button id="submit-oauth-' + id + '" type="button" class="btn btn-primary">确认登录</button>' +
        '    <button id="cancel-device-' + id + '" type="button" class="btn">取消登录</button>' +
        '  </div>' +
        '  <p class="device-status" id="device-status-' + id + '" role="status">等待粘贴授权码并确认登录…</p>' +
        '</div>' +
        '<div class="actions">' +
        '  <button id="login-' + id + '" type="button" class="btn btn-primary">Google 授权登录</button>' +
        '  <button id="refresh-' + id + '" type="button" class="btn">刷新用量</button>' +
        '  <button id="clear-' + id + '" type="button" class="btn btn-danger">退出登录</button>' +
        '</div>';
    }
    if (kind === 'webview') {
      return '' +
        '<p class="notice">' + esc(webviewNotice(id)) + '</p>' +
        '<div class="actions">' +
        '  <button id="login-' + id + '" type="button" class="btn btn-primary">网页登录</button>' +
        '  <button id="check-' + id + '" type="button" class="btn">检查登录</button>' +
        '  <button id="refresh-' + id + '" type="button" class="btn">刷新用量</button>' +
        '  <button id="clear-' + id + '" type="button" class="btn btn-danger">移除来源</button>' +
        '</div>' +
        '<p class="muted">移除只清除本模块的来源与用量缓存，不清除网页登录会话。</p>';
    }
    return '' +
      '<label class="field"><span>API Key</span>' +
      '  <input id="secret-' + id + '" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-…">' +
      '</label>' +
      '<div class="actions">' +
      '  <button id="save-' + id + '" type="button" class="btn btn-primary">保存密钥</button>' +
      '  <button id="refresh-' + id + '" type="button" class="btn">刷新用量</button>' +
      '  <button id="clear-' + id + '" type="button" class="btn btn-danger">退出登录</button>' +
      '</div>';
  }

  function renderProviders() {
    var providers = (core && core.providers) || [];
    var html = '';
    for (var i = 0; i < providers.length; i++) {
      var meta = providers[i] || {};
      var id = String(meta.id || '');
      if (!id) continue;
      var name = meta.name || id;
      var logo = meta.logoAsset || '';
      var initial = name.charAt(0).toUpperCase();
      html += '' +
        '<article class="provider" id="provider-' + esc(id) + '">' +
        '  <div class="provider-head">' +
        '    <span class="provider-logo" data-initial="' + esc(initial) + '">' +
        (logo ? '<img src="' + esc(logo) + '" alt="">' : '') +
        '    </span>' +
        '    <div class="provider-title"><h3>' + esc(name) + '</h3><span class="badge badge-off" id="badge-' + esc(id) + '">未配置</span></div>' +
        '    <span class="provider-cache" id="cache-' + esc(id) + '">暂无缓存</span>' +
        '  </div>' +
        '  <ul class="metrics" id="metrics-' + esc(id) + '"></ul>' +
        '  <p class="provider-status" id="status-' + esc(id) + '"></p>' +
        '  <div class="banner banner-error" id="error-' + esc(id) + '" role="alert" hidden></div>' +
        '  <label class="show-on-card"><input id="visible-' + esc(id) + '" type="checkbox"><span>在背屏显示</span></label>' +
        '  ' + authHtml(id) +
        '</article>';
    }
    dom.providers.innerHTML = html;
    var images = dom.providers.querySelectorAll ? dom.providers.querySelectorAll('img') : [];
    for (var k = 0; k < images.length; k++) {
      // logo 缺失时移除图片，露出首字母占位；不依赖内联事件（兼容严格 CSP）。
      images[k].onerror = (function (img) {
        return function () { if (img.parentNode) img.parentNode.removeChild(img); };
      })(images[k]);
    }
    for (var j = 0; j < providers.length; j++) {
      var provider = providers[j] || {};
      if (provider.id) wireProvider(String(provider.id));
    }
  }

  function wireProvider(id) {
    ui[id] = {
      badge: byId('badge-' + id),
      cache: byId('cache-' + id),
      metrics: byId('metrics-' + id),
      status: byId('status-' + id),
      error: byId('error-' + id),
      secret: byId('secret-' + id),
      save: byId('save-' + id),
      refresh: byId('refresh-' + id),
      clear: byId('clear-' + id),
      visible: byId('visible-' + id),
      login: byId('login-' + id),
      check: byId('check-' + id),
      copy: byId('copy-' + id),
      cancelDevice: byId('cancel-device-' + id),
      devicePanel: byId('device-' + id),
      deviceStatus: byId('device-status-' + id),
      code: byId('code-' + id),
      verify: byId('verify-' + id),
      submitOAuth: byId('submit-oauth-' + id),
      poolGemini: byId('pool-gemini-' + id),
      poolArgon: byId('pool-argon-' + id),
      poolClaude: byId('pool-claude-' + id)
    };
    var entry = ui[id];
    if (entry.save) entry.save.addEventListener('click', function () { saveSecret(id); });
    if (entry.refresh) entry.refresh.addEventListener('click', function () { refreshProvider(id); });
    if (entry.clear) entry.clear.addEventListener('click', function () { clearProvider(id); });
    if (entry.visible) entry.visible.addEventListener('change', function () {
      setProviderVisible(id, !!entry.visible.checked);
    });
    if (entry.poolGemini) entry.poolGemini.addEventListener('change', function () {
      if (entry.poolGemini.checked) setAntigravityPool('gemini');
    });
    if (entry.poolArgon) entry.poolArgon.addEventListener('change', function () {
      if (entry.poolArgon.checked) setAntigravityPool('argon');
    });
    if (entry.poolClaude) entry.poolClaude.addEventListener('change', function () {
      if (entry.poolClaude.checked) setAntigravityPool('claude');
    });
    if (entry.login) entry.login.addEventListener('click', function () {
      if (id === 'mimo') startMimoLogin();
      else if (id === 'cursor') startCursorLogin();
      else if (id === 'antigravity') startAntigravityLogin();
      else startDeviceLogin(id);
    });
    if (entry.check) entry.check.addEventListener('click', function () {
      if (id === 'cursor') checkCursorLogin();
      else checkMimoLogin();
    });
    if (entry.submitOAuth) entry.submitOAuth.addEventListener('click', function () { submitAntigravityLogin(); });
    if (entry.cancelDevice) entry.cancelDevice.addEventListener('click', function () {
      if (id === 'antigravity') cancelAntigravitySession('已取消登录');
      else cancelDeviceSession('已取消登录');
    });
    if (entry.copy) entry.copy.addEventListener('click', function () {
      if (id === 'antigravity') copyAntigravityUrl();
      else copyCode(id);
    });
  }

  function providerName(id) {
    var providers = (core && core.providers) || [];
    for (var i = 0; i < providers.length; i++) {
      if (providers[i] && String(providers[i].id) === id) return providers[i].name || id;
    }
    return id;
  }

  /* ---------- 状态展示 ---------- */

  function showGlobal(message) {
    dom.globalStatus.textContent = message || '';
  }

  function showGlobalError(message) {
    dom.globalError.textContent = message || '';
    dom.globalError.hidden = !message;
  }

  function showRowError(id, message) {
    rowErrors[id] = message || '';
    var entry = ui[id];
    if (!entry || !entry.error) return;
    entry.error.textContent = rowErrors[id];
    entry.error.hidden = !rowErrors[id];
  }

  function visibleCount() {
    var count = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].visible) count++;
    }
    return count;
  }

  function updateEnabled() {
    var hasClient = !!client;
    var ready = hasClient && !busy;
    var shown = visibleCount();
    if (dom.refreshAll) dom.refreshAll.disabled = !ready;
    for (var id in ui) {
      if (!Object.prototype.hasOwnProperty.call(ui, id)) continue;
      var entry = ui[id];
      var row = findRow(id);
      var configured = !!(row && row.configured);
      var inSession = id === 'antigravity' ? !!antigravitySession : !!(device && device.id === id);
      var shownHere = !!(configured && row && row.visible);
      if (entry.secret) entry.secret.disabled = !ready;
      if (entry.save) entry.save.disabled = !ready;
      if (entry.refresh) entry.refresh.disabled = !ready || !configured;
      if (entry.clear) entry.clear.disabled = !ready || !configured;
      if (entry.login) entry.login.disabled = !ready || inSession;
      if (entry.check) entry.check.disabled = !ready;
      if (entry.visible) {
        entry.visible.checked = shownHere;
        entry.visible.disabled = !ready || !configured || (shown >= MAX_CARD_PROVIDERS && !shownHere);
      }
      if (entry.poolGemini && entry.poolClaude) {
        var pool = row && (row.preferredPool === 'claude' || row.preferredPool === 'argon') ? row.preferredPool : 'gemini';
        entry.poolGemini.checked = pool === 'gemini';
        entry.poolClaude.checked = pool === 'claude';
        entry.poolArgon.checked = pool === 'argon';
        entry.poolGemini.disabled = !ready;
        entry.poolClaude.disabled = !ready;
        entry.poolArgon.disabled = !ready;
      }
      if (entry.submitOAuth) entry.submitOAuth.disabled = !ready || !inSession;
      if (entry.code && id === 'antigravity') entry.code.disabled = !ready || !inSession;
      if (entry.cancelDevice) entry.cancelDevice.disabled = !inSession;
      if (entry.copy) entry.copy.disabled = !inSession;
    }
  }

  function setBusy(value, message) {
    busy = value;
    if (message) showGlobal(message);
    updateEnabled();
  }

  function findRow(id) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && String(rows[i].id) === id) return rows[i];
    }
    return null;
  }

  function render() {
    for (var id in ui) {
      if (!Object.prototype.hasOwnProperty.call(ui, id)) continue;
      var entry = ui[id];
      var row = findRow(id);
      var configured = !!(row && row.configured);
      if (entry.badge) {
        entry.badge.textContent = configured ? '已配置' : '未配置';
        entry.badge.className = 'badge ' + (configured ? 'badge-on' : 'badge-off');
      }
      var snapshot = row && row.snapshot;
      if (entry.cache) {
        var updated = snapshot && formatClock(snapshot.updatedAt);
        entry.cache.textContent = updated ? '缓存 ' + updated : '暂无缓存';
      }
      if (entry.metrics) {
        var lines = configured ? metricLines(snapshot, id) : [];
        var html = '';
        for (var i = 0; i < lines.length; i++) html += '<li>' + esc(lines[i]) + '</li>';
        if (!lines.length) html = '<li class="muted">' + (configured
          ? '暂无用量数据，点刷新获取'
          : ((id === 'mimo' || id === 'cursor') ? '尚未确认网页登录，请登录后检查' : '尚未配置凭据')) + '</li>';
        entry.metrics.innerHTML = html;
      }
      if (entry.status) entry.status.textContent = statusText(row);
      showRowError(id, rowErrors[id]);
    }
    updateEnabled();
  }

  /* ---------- 数据读写 ---------- */

  async function reload() {
    if (!client) return;
    try {
      rows = await client.state();
      showGlobalError(null);
    } catch (error) {
      showGlobalError(errorText(error));
    }
    render();
    sendPreview();
  }

  /** 用量、授权或背屏勾选变化后通知卡片重读缓存（卡片自行判断是否需要查询）。 */
  function notifyCard() {
    if (!bridge || !bridge.card || !bridge.card.requestRefresh) return;
    try {
      var result = bridge.card.requestRefresh();
      if (result && typeof result.catch === 'function') result.catch(function () {});
    } catch (_) { /* 桥暂不可用时忽略，不影响本页状态。 */ }
  }

  async function saveCardSnapshot() {
    var appearance = window.AiUsageAppearance;
    var config = await client.cardConfig();
    config.emptyMessage = '请在卡片桥的模块设置中添加来源';
    var page = await bridge.storage.get(appearance.PAGE_KEY);
    var view = await appearance.read(bridge.storage);
    var previous = typeof page === 'string' ? { page: page } : null;
    await bridge.card.saveSnapshot(appearance.buildSnapshot(config, previous, view));
  }

  async function setProviderVisible(id, visible) {
    if (!client || busy) return;
    setBusy(true, '');
    showRowError(id, null);
    try {
      await client.setProviderVisible(id, visible);
      await saveCardSnapshot();
      showGlobal(providerName(id) + (visible ? ' 将显示在背屏' : ' 已从背屏隐藏，登录保留'));
      notifyCard();
    } catch (error) {
      showRowError(id, errorText(error));
    } finally {
      await reload();
      setBusy(false);
    }
  }

  async function saveSecret(id) {
    var entry = ui[id];
    if (!client || !entry || !entry.secret) return;
    var value = entry.secret.value.replace(/^\s+|\s+$/g, '');
    if (!value) { showRowError(id, '请输入凭据内容'); return; }
    setBusy(true, '');
    showRowError(id, null);
    try {
      await client.saveSecret(id, value);
      entry.secret.value = '';
      showGlobal(providerName(id) + ' 凭据已保存');
      if (WEBUI_REFRESHABLE[id]) {
        await client.refresh(id);
        showGlobal(providerName(id) + ' 已刷新');
      }
    } catch (error) {
      showRowError(id, errorText(error));
    } finally {
      notifyCard();
      await reload();
      setBusy(false);
    }
  }

  async function clearProvider(id) {
    if (!client) return;
    if (device && device.id === id) cancelDeviceSession('');
    if (id === 'antigravity' && antigravitySession) cancelAntigravitySession('');
    setBusy(true, '');
    showRowError(id, null);
    try {
      await client.clear(id);
      var entry = ui[id];
      if (entry && entry.secret) entry.secret.value = '';
      if (entry && entry.code && id === 'antigravity') entry.code.value = '';
      showGlobal(providerName(id) + ((id === 'mimo' || id === 'cursor') ? ' 已移除，网页登录会话保留' : ' 已退出登录'));
      notifyCard();
      await reload();
    } catch (error) {
      showRowError(id, errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function refreshProvider(id) {
    if (!client || busy) return;
    setBusy(true, '正在刷新 ' + providerName(id) + '…');
    showRowError(id, null);
    try {
      await client.refresh(id);
      showGlobal(providerName(id) + ' 已刷新');
      notifyCard();
    } catch (error) {
      showRowError(id, errorText(error));
      showGlobal('');
    } finally {
      await reload();
      setBusy(false);
    }
  }

  /** 逐来源刷新；携带 cookies 的请求由 request 适配器交给原生桥。 */
  async function refreshAll() {
    if (!client || busy) return;
    setBusy(true, '正在刷新…');
    showGlobalError(null);
    var ok = 0, failed = 0, skipped = 0;
    try {
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row || !WEBUI_REFRESHABLE[row.id]) continue;
        if (!row.configured) { skipped++; continue; }
        try {
          await client.refresh(row.id);
          rowErrors[row.id] = null;
          ok++;
        } catch (error) {
          rowErrors[row.id] = errorText(error);
          failed++;
        }
      }
      if (ok) notifyCard();
      if (ok + failed === 0) showGlobal('没有可刷新的来源（' + skipped + ' 个未配置）');
      else if (failed) showGlobal('刷新完成：' + ok + ' 成功，' + failed + ' 失败');
      else showGlobal('已刷新 ' + ok + ' 个来源');
    } finally {
      await reload();
      setBusy(false);
    }
  }

  /* ---------- MiMo 网页登录 ---------- */

  async function startMimoLogin() {
    if (!client || busy) return;
    setBusy(true, '正在获取小米账号登录入口…');
    showRowError('mimo', null);
    try {
      var url = await client.requestMimoLoginUrl();
      if (!window.open(url, '_blank')) throw new Error('无法打开登录窗口，请在新版卡片桥中重试');
      showGlobal('请在新窗口完成登录，关闭窗口后点击“检查登录”');
    } catch (error) {
      showRowError('mimo', errorText(error));
      showGlobal('');
    } finally {
      setBusy(false);
    }
  }

  async function checkMimoLogin() {
    if (!client || busy) return;
    setBusy(true, '正在检查小米账号登录…');
    showRowError('mimo', null);
    try {
      await client.checkMimoLogin();
      showGlobal('小米 MiMo 登录已确认，用量已更新');
      notifyCard();
    } catch (error) {
      showRowError('mimo', errorText(error));
      showGlobal('');
    } finally {
      await reload();
      setBusy(false);
    }
  }

  function startCursorLogin() {
    if (!client || busy) return;
    showRowError('cursor', null);
    if (!window.open(CURSOR_USAGE_PAGE, '_blank')) {
      showRowError('cursor', '无法打开登录窗口，请在新版卡片桥中重试');
      return;
    }
    showGlobal('请在新窗口完成 Cursor 登录，关闭窗口后点击“检查登录”');
  }

  async function checkCursorLogin() {
    if (!client || busy) return;
    setBusy(true, '正在检查 Cursor 登录…');
    showRowError('cursor', null);
    try {
      await client.checkCursorLogin();
      showGlobal('Cursor 登录已确认，用量已更新');
      notifyCard();
    } catch (error) {
      showRowError('cursor', errorText(error));
      showGlobal('');
    } finally {
      await reload();
      setBusy(false);
    }
  }

  /* ---------- Antigravity 授权登录与优先池 ---------- */

  async function setAntigravityPool(pool) {
    if (!client || busy) return;
    setBusy(true, '');
    showRowError('antigravity', null);
    try {
      await client.setAntigravityPool(pool);
      await saveCardSnapshot();
      showGlobal('Antigravity 总览优先展示已切换为 ' + (pool === 'argon' ? 'Argon' : (pool === 'claude' ? 'Claude / GPT' : 'Gemini')));
      notifyCard();
    } catch (error) {
      showRowError('antigravity', errorText(error));
    } finally {
      await reload();
      setBusy(false);
    }
  }

  async function startAntigravityLogin() {
    if (!client || busy) return;
    cancelAntigravitySession('');
    showRowError('antigravity', null);
    try {
      var session = await Promise.resolve(client.requestAntigravityOAuth());
      if (!session || !session.authorizationUrl) {
        throw Object.assign(new Error('无法生成 Google 授权链接'), { code: 'ERROR' });
      }
      antigravitySession = session;
      var entry = ui.antigravity;
      if (entry) {
        if (entry.code) entry.code.value = '';
        if (entry.verify) {
          var url = String(session.authorizationUrl);
          if (/^https:\/\//i.test(url)) {
            entry.verify.href = url;
            entry.verify.removeAttribute('aria-disabled');
          } else {
            entry.verify.href = '#';
            entry.verify.setAttribute('aria-disabled', 'true');
          }
        }
        if (entry.devicePanel) entry.devicePanel.hidden = false;
      }
      showGlobal('请打开 Google 授权页面，完成后复制回调链接或授权码粘贴确认');
    } catch (error) {
      showRowError('antigravity', errorText(error));
    } finally {
      updateEnabled();
    }
  }

  async function submitAntigravityLogin() {
    var entry = ui.antigravity;
    if (!client || busy || !entry || !entry.code) return;
    var value = entry.code.value.replace(/^\s+|\s+$/g, '');
    if (!value) {
      showRowError('antigravity', '请粘贴回调链接、授权码或 Refresh Token');
      return;
    }
    var session = antigravitySession;
    setBusy(true, '正在验证 Antigravity 授权…');
    showRowError('antigravity', null);
    try {
      await client.completeAntigravityLogin(value, session);
      entry.code.value = '';
      cancelAntigravitySession('');
      showGlobal('Antigravity 登录成功，用量已更新');
      notifyCard();
    } catch (error) {
      showRowError('antigravity', errorText(error));
      showGlobal('');
      notifyCard();
    } finally {
      await reload();
      setBusy(false);
    }
  }

  function cancelAntigravitySession(message) {
    antigravitySession = null;
    var entry = ui.antigravity;
    if (entry) {
      if (entry.code) entry.code.value = '';
      if (entry.devicePanel) entry.devicePanel.hidden = true;
    }
    if (message) showGlobal(message);
    updateEnabled();
  }

  function copyAntigravityUrl() {
    if (!antigravitySession || !antigravitySession.authorizationUrl) return;
    var url = String(antigravitySession.authorizationUrl);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        showGlobal('授权链接已复制，请在浏览器中打开');
      }).catch(function () {
        showGlobal('请长按“打开授权页面”复制链接');
      });
    } else {
      showGlobal('请长按“打开授权页面”复制链接');
    }
  }

  /* ---------- Codex 设备码登录 ---------- */

  function setDeviceStatus(id, message) {
    var entry = ui[id];
    if (entry && entry.deviceStatus) entry.deviceStatus.textContent = message || '';
  }

  async function startDeviceLogin(id) {
    if (!client || busy) return;
    cancelDeviceSession('');
    setBusy(true, '');
    showRowError(id, null);
    try {
      var login = await client.requestDeviceCode();
      if (!login || !login.userCode || !login.verificationUrl) {
        throw Object.assign(new Error('设备码请求未返回验证码'), { code: 'ERROR' });
      }
      beginDeviceSession(id, login);
    } catch (error) {
      showRowError(id, errorText(error));
    } finally {
      setBusy(false);
    }
  }

  function beginDeviceSession(id, login) {
    var entry = ui[id];
    if (!entry) return;
    var session = { id: id, login: login, cancelled: false };
    device = session;
    if (entry.code) entry.code.value = String(login.userCode);
    if (entry.verify) {
      var url = String(login.verificationUrl);
      if (/^https:\/\//i.test(url)) {
        entry.verify.href = url;
        entry.verify.removeAttribute('aria-disabled');
      } else {
        entry.verify.href = '#';
        entry.verify.setAttribute('aria-disabled', 'true');
      }
    }
    if (entry.devicePanel) entry.devicePanel.hidden = false;
    setDeviceStatus(id, '等待验证中…（验证码 ' + login.userCode + '）');
    updateEnabled();
    attemptDeviceLogin(session);
  }

  function attemptDeviceLogin(session) {
    if (session.cancelled || device !== session || !client) return;
    var outcome;
    try {
      outcome = client.completeDeviceLogin(session.login, {
        isCancelled: function () { return session.cancelled; }
      });
    } catch (error) {
      outcome = Promise.reject(error);
    }
    Promise.resolve(outcome).then(function () {
      // 取消后到达的结果一律丢弃：不做保存、不触发卡片刷新。
      if (session.cancelled || device !== session) return;
      finishDeviceSession(session);
      showGlobal(providerName(session.id) + ' 登录成功');
      notifyCard();
      reload();
    }).catch(function (error) {
      if (session.cancelled || device !== session) return;
      if (error && error.code === 'CANCELLED') {
        finishDeviceSession(session);
        showGlobal('已取消登录');
        return;
      }
      // 核心负责轮询与 15 分钟超时。这里的失败已经是最终结果，不能重用授权码。
      finishDeviceSession(session);
      showRowError(session.id, errorText(error));
      // 令牌可能已保存、仅首次用量请求失败；仍需回读授权与错误状态。
      notifyCard();
      reload();
    });
  }

  function finishDeviceSession(session) {
    var entry = ui[session.id];
    if (entry && entry.devicePanel) entry.devicePanel.hidden = true;
    if (device === session) device = null;
    updateEnabled();
  }

  /** 取消当前设备码会话：进行中的轮询停止，取消后不产生任何保存。 */
  function cancelDeviceSession(message) {
    if (!device) return;
    var session = device;
    session.cancelled = true;
    finishDeviceSession(session);
    if (message) showGlobal(message);
  }

  function copyCode(id) {
    var entry = ui[id];
    if (!entry || !entry.code) return;
    var input = entry.code;
    input.focus();
    input.select();
    try { input.setSelectionRange(0, input.value.length); } catch (_) { /* 只读字段个别实现不支持。 */ }
    function fallback() {
      try {
        if (document.execCommand && document.execCommand('copy')) showGlobal('验证码已复制');
        else showGlobal('请长按 / 手动选择验证码复制');
      } catch (_) {
        showGlobal('请长按 / 手动选择验证码复制');
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(function () {
        showGlobal('验证码已复制');
      }).catch(fallback);
    } else {
      fallback();
    }
  }

  /* ---------- 卡片预览联动 ---------- */

  /** display.page 可能是字符串、数字或 JSON 字符串；空值不写入预览。 */
  function pageSeed(value) {
    if (typeof value === 'number' && isFinite(value)) return String(value);
    if (typeof value !== 'string') return null;
    var text = value;
    if (text.charAt(0) === '"') {
      try {
        var parsed = JSON.parse(text);
        if (typeof parsed === 'string') text = parsed;
        else if (typeof parsed === 'number' && isFinite(parsed)) return String(parsed);
      } catch (_) { /* 使用原字符串。 */ }
    }
    return text ? text : null;
  }

  function previewWallpaper(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.id !== 'string' || typeof value.sharp !== 'string' || typeof value.blur !== 'string') return null;
    return { id: value.id, sharp: value.sharp, blur: value.blur };
  }

  /**
   * mount({ bridge, client, onChange })
   * onChange(null | {id, sharp, blur}) 只描述当前选中的一张，不包含整图库。
   */
  function mountWallpapers() {
    var api = window.AiUsageWallpaperSettings;
    if (!api || typeof api.mount !== 'function') return;
    try {
      api.mount({
        bridge: bridge,
        client: client,
        onChange: function (wallpaper) {
          currentWallpaper = previewWallpaper(wallpaper);
          sendPreview();
        }
      });
    } catch (_) { /* 外观区域不可用时保留其余设置。 */ }
  }

  function readPreviewPage() {
    var lib = window.AiUsageAppearance;
    var key = lib && lib.PAGE_KEY ? lib.PAGE_KEY : 'display.page';
    var pending = null;
    try {
      if (bridge.storage && bridge.storage.get) pending = bridge.storage.get(key);
    } catch (_) {
      pending = null;
    }
    Promise.resolve(pending).then(function (value) {
      previewPageSeed = pageSeed(value);
    }, function () {
      previewPageSeed = null;
    }).then(function () {
      previewPageReady = true;
      sendPreview();
    });
  }

  function sendPreview() {
    if (!previewReady || !client || !previewPageReady) return;
    var config;
    try {
      config = client.cardConfig();
    } catch (_) {
      return;
    }
    Promise.resolve(config).then(function (value) {
      if (!value || !Array.isArray(value.providers)) return;
      var next = {};
      var keys = Object.keys(value);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] === 'wallpaper' || keys[i] === 'appearance' || keys[i] === 'pageKey') continue;
        next[keys[i]] = value[keys[i]];
      }
      if (!next.emptyMessage) next.emptyMessage = '请在模块设置中添加来源';
      next.wallpaper = currentWallpaper ? {
        id: currentWallpaper.id,
        sharp: currentWallpaper.sharp,
        blur: currentWallpaper.blur
      } : null;
      // 首次用 display.page 初始化；之后不再带 pageKey，预览保留自己的当前页。
      if (!previewPageSent) {
        if (typeof previewPageSeed === 'string') next.pageKey = previewPageSeed;
        previewPageSent = true;
      }
      // 预览消息只含展示数据（core 保证不含凭据），且只附当前一张壁纸。
      window.CARD_CONFIG = next;
      try {
        dom.preview.contentWindow.postMessage({ type: 'ai-usage-preview', config: next }, '*');
      } catch (_) { /* iframe 尚未就绪时忽略，下次状态变化会重发。 */ }
    });
  }

  function wirePreview() {
    if (!dom.preview) return;
    dom.preview.addEventListener('load', function () {
      previewReady = true;
      sendPreview();
    });
    try {
      if (dom.preview.contentDocument && dom.preview.contentDocument.readyState === 'complete') {
        previewReady = true;
      }
    } catch (_) { /* 跨源不可读时等待 load 事件。 */ }
    sendPreview();
  }

  /* ---------- 启动 ---------- */

  function disableAllControls() {
    var nodes = document.querySelectorAll('button, input');
    for (var i = 0; i < nodes.length; i++) nodes[i].disabled = true;
  }

  function init() {
    dom.providers = byId('providers');
    dom.refreshAll = byId('refresh-all');
    dom.globalStatus = byId('global-status');
    dom.globalError = byId('global-error');
    dom.bridgeNotice = byId('bridge-notice');
    dom.resourceError = byId('resource-error');
    dom.preview = byId('preview');

    wirePreview();

    if (!core) {
      if (dom.resourceError) dom.resourceError.hidden = false;
      disableAllControls();
      return;
    }
    renderProviders();

    if (!bridge) {
      // 普通网页打开：明确提示，禁用全部写入与网络入口，不伪造任何数据。
      if (dom.bridgeNotice) dom.bridgeNotice.hidden = false;
      disableAllControls();
      return;
    }

    try {
      client = core.create({
        storage: bridge.storage,
        request: request,
        // 设置页负责续期与保存 refresh token；卡片查询时不轮换令牌。
        allowTokenRefresh: true
      });
    } catch (_) {
      if (dom.resourceError) {
        dom.resourceError.textContent = '用量核心初始化失败，设置页不可用。';
        dom.resourceError.hidden = false;
      }
      disableAllControls();
      return;
    }

    mountWallpapers();
    readPreviewPage();
    dom.refreshAll.addEventListener('click', function () { refreshAll(); });
    // 离开页面才取消：切到外部验证浏览器不算离开（链接由系统浏览器打开，本页保持不变）。
    window.addEventListener('pagehide', function () {
      cancelDeviceSession('');
      cancelAntigravitySession('');
    });

    updateEnabled();
    reload();
  }

  init();
})();
