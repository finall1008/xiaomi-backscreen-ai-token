/**
 * AI 用量共享业务核心：设置网页与背屏卡片共用，两端由构建复制同一份源码。
 *
 * 注入契约：
 *   create({storage, request, now?, sleep?, allowTokenRefresh?})
 *   - storage：bridge.storage，异步 get(key) / set(key, value) / remove(key)。
 *   - request({url, method?, headers?, body?, timeoutMs?, cookies?, redirect?})
 *     -> Promise<{status, body, url?, headers?}>。
 *     cookies 被显式传入时（含 false）原样交给宿主；cookies:true 不与自定义 Cookie 头同时使用。
 *   - now() 返回 Unix 毫秒（默认 Date.now）；快照 updatedAt 一律为 Unix 秒。
 *   - allowTokenRefresh 默认 true；背屏传 false，Codex 401 时提示去设置页刷新，不轮换令牌。
 *
 * 存储键：auth.<id>（凭据）、usage.<id>（归一化快照）、status.<id>（错误状态）。
 * MiMo / Cursor 网页登录只存 {"type":"webview"} 标记；Cookie 留在宿主 Profile，不进入业务存储。MiMo 旧的非空 Cookie 字符串仍可读。
 * status 形态固定为 {code, message, updatedAt}（updatedAt 为 Unix 秒）或 null；
 * code 取值 AUTH_REQUIRED / CANCELLED / ERROR，任何情况下不写入服务端响应原文或凭据。
 *
 * 用量快照的归一化字段：
 * id、plan、updatedAt、windows、balance、credits、booster、hint；Cursor 另有安全展示明细 details。字段缺失时不伪造 0。
 * display.providers 保存用户勾选的来源 ID；未保存偏好时展示前四个已配置来源，保存后允许全部取消。
 */
(function () {
  'use strict';

  var PROVIDERS = [
    { id: 'codex', name: 'Codex', logoAsset: 'assets/openai.png' },
    { id: 'kimi', name: 'Kimi Code', logoAsset: 'assets/kimi.png' },
    { id: 'deepseek', name: 'DeepSeek', logoAsset: 'assets/deepseek.png' },
    { id: 'mimo', name: '小米 MiMo', logoAsset: 'assets/mimo.png' },
    { id: 'cursor', name: 'Cursor', logoAsset: 'assets/cursor.png' }
  ];
  var SECRET_PROVIDER = { kimi: true, deepseek: true, mimo: true };
  var ERROR_CODE = { AUTH_REQUIRED: true, CANCELLED: true, ERROR: true };
  var CANCELLED_MESSAGE = '操作已取消';

  // Codex 官方端点与常量。
  var CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
  var AUTH_ISSUER = 'https://auth.openai.com';
  var DEVICE_CODE_URL = AUTH_ISSUER + '/api/accounts/deviceauth/usercode';
  var DEVICE_TOKEN_URL = AUTH_ISSUER + '/api/accounts/deviceauth/token';
  var VERIFICATION_URL = AUTH_ISSUER + '/codex/device';
  var OAUTH_TOKEN_URL = AUTH_ISSUER + '/oauth/token';
  var DEVICE_REDIRECT_URI = AUTH_ISSUER + '/deviceauth/callback';
  var CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
  var DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
  var LONG_WINDOW_SECONDS = 24 * 60 * 60;

  var KIMI_USAGES_URL = 'https://api.kimi.com/coding/v1/usages';
  var KIMI_ME_URL = 'https://api.kimi.com/coding/v1/me';
  var DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
  var MIMO_USAGE_URL = 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage';
  var MIMO_DETAIL_URL = 'https://platform.xiaomimimo.com/api/v1/tokenPlan/detail';
  var CURSOR_USAGE_URL = 'https://cursor.com/api/usage-summary';
  var DISPLAY_PROVIDERS_KEY = 'display.providers';
  var MAX_DISPLAY_PROVIDERS = 4;

  var REQUEST_TIMEOUT_MS = 30000;
  var FIVE_HOUR_SECONDS = 5 * 3600;
  var WEEK_SECONDS = 7 * 24 * 3600;
  var MONTH_SECONDS = 30 * 24 * 3600;

  // 运行时单飞：同一执行环境里只允许一次 Codex refresh token 轮换在途。
  var codexRotateFlight = null;

  function coreError(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }

  function cancelledError() {
    return coreError('CANCELLED', CANCELLED_MESSAGE);
  }

  /** 只保留三种错误码；外部注入抛出的原始异常统一收敛为安全文案。 */
  function toCoreError(error) {
    if (error && typeof error.code === 'string' && ERROR_CODE[error.code]) return error;
    return coreError('ERROR', '操作失败');
  }

  function findProvider(id) {
    for (var i = 0; i < PROVIDERS.length; i++) {
      if (PROVIDERS[i].id === id) return PROVIDERS[i];
    }
    return null;
  }

  function authKey(id) { return 'auth.' + id; }
  function usageKey(id) { return 'usage.' + id; }
  function statusKey(id) { return 'status.' + id; }

  // ---------- JSON 读取辅助（对齐 org.json 的宽松转换语义） ----------

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function hasOwn(obj, name) {
    return isObject(obj) && Object.prototype.hasOwnProperty.call(obj, name);
  }

  /** org.json has(name) && !isNull(name)：键存在且不是 null。 */
  function hasValue(obj, name) {
    return hasOwn(obj, name) && obj[name] !== null;
  }

  function parseJson(text) {
    if (typeof text !== 'string') return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function readJson(body, failure) {
    var json = parseJson(body);
    if (!isObject(json)) throw coreError('ERROR', failure);
    return json;
  }

  /** JSON.toString 粗略对应：字符串原样，数字/布尔转字符串，对象序列化。 */
  function jsonText(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch (_) {
        return '';
      }
    }
    return String(value);
  }

  /** Kotlin stringOrNull：optString().trim() 非空，否则 null。 */
  function trimmedString(value) {
    if (value === null || value === undefined) return null;
    var text = jsonText(value).trim();
    return text === '' ? null : text;
  }

  /** Kotlin nullableString：仅字符串 / 数字 / 布尔转文本，不 trim，对象为 null。 */
  function cacheString(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return null;
  }

  /** Kotlin textValue：字符串 trim 后非空。 */
  function textValue(value) {
    if (typeof value !== 'string') return null;
    var text = value.trim();
    return text === '' ? null : text;
  }

  /** Kotlin toDoubleOrNull 近似：严格数字文本，拒绝十六进制等 parseDouble 不接受的写法。 */
  function strictNumber(text) {
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
    var value = Number(text);
    return isFinite(value) ? value : null;
  }

  function finiteNumber(raw) {
    if (typeof raw === 'number') return isFinite(raw) ? raw : null;
    if (typeof raw === 'string') {
      var trimmed = raw.trim();
      return trimmed === '' ? null : strictNumber(trimmed);
    }
    return null;
  }

  function finiteDouble(obj, name) {
    if (!hasValue(obj, name)) return null;
    return finiteNumber(obj[name]);
  }

  function firstFinite(obj, names) {
    for (var i = 0; i < names.length; i++) {
      var value = finiteDouble(obj, names[i]);
      if (value !== null) return value;
    }
    return null;
  }

  function longOf(raw) {
    var value = null;
    if (typeof raw === 'number') {
      value = isFinite(raw) ? Math.trunc(raw) : null;
    } else if (typeof raw === 'string') {
      var trimmed = raw.trim();
      if (/^[+-]?\d+$/.test(trimmed)) {
        value = Number(trimmed);
      } else {
        var parsed = strictNumber(trimmed);
        value = parsed === null ? null : Math.trunc(parsed);
      }
    }
    if (value === null || !isFinite(value)) return null;
    return value;
  }

  function nullableLong(obj, name) {
    if (!hasValue(obj, name)) return null;
    return longOf(obj[name]);
  }

  function flexibleInt(obj, name) {
    if (!hasValue(obj, name)) return null;
    var raw = obj[name];
    if (typeof raw === 'number') return isFinite(raw) ? Math.trunc(raw) : null;
    if (typeof raw === 'string') {
      var trimmed = raw.trim();
      if (/^[+-]?\d+$/.test(trimmed)) return Number(trimmed);
      var parsed = strictNumber(trimmed);
      return parsed === null ? null : Math.trunc(parsed);
    }
    return null;
  }

  function flexibleBoolean(obj, name) {
    if (!hasValue(obj, name)) return null;
    var raw = obj[name];
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return Math.trunc(raw) !== 0;
    if (typeof raw === 'string') {
      var text = raw.trim().toLowerCase();
      if (text === 'true' || text === '1') return true;
      if (text === 'false' || text === '0') return false;
      return null;
    }
    return null;
  }

  /** 第一个“存在且非 null”的键决定结果（可能转换失败为 null），与 DeepSeekClient 的分支顺序一致。 */
  function flexibleBooleanAny(obj, names) {
    for (var i = 0; i < names.length; i++) {
      if (hasValue(obj, names[i])) return flexibleBoolean(obj, names[i]);
    }
    return null;
  }

  // ---------- base64url / UTF-8 / JWT（QuickJS 无 atob、TextDecoder、Buffer） ----------

  var BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function decodeBase64Url(text) {
    var source = String(text).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    var bytes = [];
    var index = 0;
    while (index + 4 <= source.length) {
      var a = BASE64_CHARS.indexOf(source.charAt(index));
      var b = BASE64_CHARS.indexOf(source.charAt(index + 1));
      var c = BASE64_CHARS.indexOf(source.charAt(index + 2));
      var d = BASE64_CHARS.indexOf(source.charAt(index + 3));
      if (a < 0 || b < 0 || c < 0 || d < 0) return null;
      bytes.push(((a << 2) | (b >> 4)) & 255);
      bytes.push(((b << 4) | (c >> 2)) & 255);
      bytes.push(((c << 6) | d) & 255);
      index += 4;
    }
    var rest = source.length - index;
    if (rest === 1) return null;
    if (rest === 2) {
      var a2 = BASE64_CHARS.indexOf(source.charAt(index));
      var b2 = BASE64_CHARS.indexOf(source.charAt(index + 1));
      if (a2 < 0 || b2 < 0) return null;
      bytes.push(((a2 << 2) | (b2 >> 4)) & 255);
    } else if (rest === 3) {
      var a3 = BASE64_CHARS.indexOf(source.charAt(index));
      var b3 = BASE64_CHARS.indexOf(source.charAt(index + 1));
      var c3 = BASE64_CHARS.indexOf(source.charAt(index + 2));
      if (a3 < 0 || b3 < 0 || c3 < 0) return null;
      bytes.push(((a3 << 2) | (b3 >> 4)) & 255);
      bytes.push(((b3 << 4) | (c3 >> 2)) & 255);
    }
    return bytes;
  }

  /** 最小 UTF-8 解码：非法序列按 U+FFFD 处理，不依赖任何宿主编码 API。 */
  function utf8ToString(bytes) {
    var out = '';
    var i = 0;
    while (i < bytes.length) {
      var c = bytes[i++];
      if (c < 0x80) {
        out += String.fromCharCode(c);
      } else if (c >= 0xc2 && c < 0xe0) {
        var d1 = bytes[i];
        if (d1 === undefined || (d1 & 0xc0) !== 0x80) { out += '�'; continue; }
        i++;
        out += String.fromCharCode(((c & 0x1f) << 6) | (d1 & 0x3f));
      } else if (c >= 0xe0 && c < 0xf0) {
        var d2 = bytes[i];
        var e2 = bytes[i + 1];
        if (d2 === undefined || e2 === undefined || (d2 & 0xc0) !== 0x80 || (e2 & 0xc0) !== 0x80) { out += '�'; continue; }
        var code = ((c & 0x0f) << 12) | ((d2 & 0x3f) << 6) | (e2 & 0x3f);
        if (code < 0x800) { out += '�'; continue; }
        i += 2;
        out += String.fromCharCode(code);
      } else if (c >= 0xf0 && c < 0xf5) {
        var d3 = bytes[i];
        var e3 = bytes[i + 1];
        var f3 = bytes[i + 2];
        if (d3 === undefined || e3 === undefined || f3 === undefined ||
            (d3 & 0xc0) !== 0x80 || (e3 & 0xc0) !== 0x80 || (f3 & 0xc0) !== 0x80) { out += '�'; continue; }
        var plane = ((c & 0x07) << 18) | ((d3 & 0x3f) << 12) | ((e3 & 0x3f) << 6) | (f3 & 0x3f);
        if (plane < 0x10000 || plane > 0x10ffff) { out += '�'; continue; }
        i += 3;
        var offset = plane - 0x10000;
        out += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
      } else {
        out += '�';
      }
    }
    return out;
  }

  function decodeJwtPayload(jwt) {
    if (typeof jwt !== 'string') return null;
    var parts = jwt.split('.');
    var payload = parts.length > 1 ? parts[1] : '';
    if (!payload) return null;
    var bytes = decodeBase64Url(payload);
    if (!bytes) return null;
    return parseJson(utf8ToString(bytes));
  }

  function chatgptAccountId(jwt) {
    var payload = decodeJwtPayload(jwt);
    if (!isObject(payload)) return null;
    var auth = payload['https://api.openai.com/auth'];
    if (!isObject(auth)) return null;
    return trimmedString(auth.chatgpt_account_id);
  }

  // ---------- ISO 8601 / 本地时间解析（对齐 parseIso8601EpochSeconds） ----------

  function hasZone(text) {
    if (text.charAt(text.length - 1) === 'Z') return true;
    return /[+-]\d{2}:?\d{2}$/.test(text);
  }

  function parseIso8601EpochSeconds(raw) {
    if (typeof raw !== 'string') return null;
    var trimmed = raw.trim();
    if (trimmed.charAt(trimmed.length - 1) === 'z') trimmed = trimmed.slice(0, -1) + 'Z';
    if (trimmed === '') return null;
    var zoned = hasZone(trimmed) ? trimmed : trimmed + 'Z';
    var withColon = zoned.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    var normalized = withColon.replace(/T(\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/, 'T$1:00$2');
    var match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(normalized);
    if (!match) return null;
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var hour = Number(match[4]);
    var minute = Number(match[5]);
    var second = match[6] === undefined ? 0 : Number(match[6]);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
    var zone = match[7];
    var offsetMinutes = 0;
    if (zone !== 'Z') {
      var sign = zone.charAt(0) === '-' ? -1 : 1;
      var zoneHour = Number(zone.slice(1, 3));
      var zoneMinute = Number(zone.slice(4, 6));
      if (zoneHour > 23 || zoneMinute > 59) return null;
      offsetMinutes = sign * (zoneHour * 60 + zoneMinute);
    }
    var utc = Date.UTC(year, month - 1, day, hour, minute, second);
    var date = new Date(utc);
    // Date.UTC 会把 2 月 30 日之类溢出到下个月，Java 解析会拒绝；这里做往返校验。
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day || date.getUTCHours() !== hour ||
        date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;
    return Math.floor((utc - offsetMinutes * 60000) / 1000);
  }

  /** 中国大陆平台本地时间（UTC+8 固定无夏令时）到 Unix 秒。 */
  function parseShanghaiEpochSeconds(text) {
    var match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
    if (!match) return null;
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var hour = Number(match[4]);
    var minute = Number(match[5]);
    var second = Number(match[6]);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
    var utc = Date.UTC(year, month - 1, day, hour, minute, second);
    var date = new Date(utc);
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return Math.floor((utc - 8 * 3600000) / 1000);
  }

  function normalizeEpoch(value) {
    if (value === null || value <= 0) return null;
    return value >= 1000000000000 ? Math.trunc(value / 1000) : value;
  }

  /** Kotlin parseFlexibleEpoch：数字、数字串、ISO 串、平台本地时间串。 */
  function parseFlexibleEpoch(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number') return isFinite(raw) ? normalizeEpoch(Math.trunc(raw)) : null;
    if (typeof raw !== 'string') return null;
    var trimmed = raw.trim();
    if (trimmed === '') return null;
    if (/^[+-]?\d+$/.test(trimmed)) return normalizeEpoch(Number(trimmed));
    var asNumber = strictNumber(trimmed);
    if (asNumber !== null) return normalizeEpoch(Math.trunc(asNumber));
    var iso = parseIso8601EpochSeconds(trimmed);
    if (iso !== null) return normalizeEpoch(iso);
    return normalizeEpoch(parseShanghaiEpochSeconds(trimmed));
  }

  // ---------- Codex 协议 ----------

  function deviceCodeRequestBody() {
    return JSON.stringify({ client_id: CODEX_CLIENT_ID });
  }

  function devicePollRequestBody(deviceAuthId, userCode) {
    return JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode });
  }

  function formEncode(value) {
    return encodeURIComponent(value).replace(/%20/g, '+');
  }

  function authorizationCodeForm(code, codeVerifier) {
    return 'grant_type=' + formEncode('authorization_code') +
      '&client_id=' + formEncode(CODEX_CLIENT_ID) +
      '&code=' + formEncode(code) +
      '&redirect_uri=' + formEncode(DEVICE_REDIRECT_URI) +
      '&code_verifier=' + formEncode(codeVerifier);
  }

  function refreshTokenBody(refreshToken) {
    return JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });
  }

  function parseDeviceLogin(body, nowMillis) {
    var json = readJson(body, '设备码响应无法解析');
    var deviceAuthId = trimmedString(json.device_auth_id);
    if (deviceAuthId === null) throw coreError('ERROR', '设备码响应缺少登录标识');
    var userCode = trimmedString(json.user_code);
    if (userCode === null) userCode = trimmedString(json.usercode);
    if (userCode === null) throw coreError('ERROR', '设备码响应缺少验证码');
    var interval = nullableLong(json, 'interval');
    if (interval === null || interval <= 0) throw coreError('ERROR', '设备码响应缺少轮询间隔');
    return {
      verificationUrl: VERIFICATION_URL,
      userCode: userCode,
      deviceAuthId: deviceAuthId,
      interval: interval,
      start: nowMillis
    };
  }

  function parseDeviceAuthorization(body) {
    var json = readJson(body, '设备码确认响应无法解析');
    var code = trimmedString(json.authorization_code);
    var verifier = trimmedString(json.code_verifier);
    if (code === null || verifier === null) throw coreError('ERROR', '设备码确认响应不完整');
    return { authorizationCode: code, codeVerifier: verifier };
  }

  function parseExchangedTokens(body) {
    var json = readJson(body, '令牌交换响应无法解析');
    var idToken = trimmedString(json.id_token);
    var accessToken = trimmedString(json.access_token);
    var refreshToken = trimmedString(json.refresh_token);
    if (idToken === null || accessToken === null || refreshToken === null) {
      throw coreError('ERROR', '令牌交换响应不完整');
    }
    return { idToken: idToken, accessToken: accessToken, refreshToken: refreshToken };
  }

  function withAccountId(credentials) {
    if (credentials.accountId !== '') return credentials;
    var resolved = chatgptAccountId(credentials.idToken) || chatgptAccountId(credentials.accessToken) || '';
    return {
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      idToken: credentials.idToken,
      accountId: resolved
    };
  }

  /** 轮换响应：省略的字段保留当前值，但轮换后的 refresh token 即使未回传 access 也保留。 */
  function applyRefreshResponse(current, body) {
    var json = readJson(body, '登录续期响应无法解析');
    var present = hasOwn(json, 'access_token') || hasOwn(json, 'refresh_token') || hasOwn(json, 'id_token');
    if (!present) throw coreError('ERROR', '登录续期响应不完整');
    var accessToken = trimmedString(json.access_token);
    var refreshToken = trimmedString(json.refresh_token);
    var idToken = trimmedString(json.id_token);
    return withAccountId({
      accessToken: accessToken === null ? current.accessToken : accessToken,
      refreshToken: refreshToken === null ? current.refreshToken : refreshToken,
      idToken: idToken === null ? current.idToken : idToken,
      accountId: current.accountId
    });
  }

  /** 只回显服务端给出的安全错误码，绝不携带响应正文。 */
  function oauthFailureMessage(status, body) {
    var json = parseJson(body);
    var code = null;
    if (isObject(json)) {
      code = trimmedString(json.error);
      if (code !== null && !/^[A-Za-z0-9_]+$/.test(code)) code = null;
    }
    if (code === 'refresh_token_expired' || code === 'refresh_token_reused' ||
        code === 'refresh_token_invalidated' || code === 'invalid_grant') {
      return '登录已失效，请重新登录';
    }
    if (status === 401) return '登录已失效，请重新登录';
    return '登录续期失败（' + status + '）';
  }

  function oauthError(status, body) {
    var message = oauthFailureMessage(status, body);
    return coreError(message === '登录已失效，请重新登录' ? 'AUTH_REQUIRED' : 'ERROR', message);
  }

  // ---------- Codex 用量解析 ----------

  function windowSecondsOf(obj) {
    var limit = nullableLong(obj, 'limit_window_seconds');
    if (limit !== null) return limit;
    var windowSeconds = nullableLong(obj, 'window_seconds');
    if (windowSeconds !== null) return windowSeconds;
    var minutes = nullableLong(obj, 'window_minutes');
    if (minutes !== null) return minutes * 60;
    return null;
  }

  function resetAtOf(obj, nowSeconds) {
    var resetAt = nullableLong(obj, 'reset_at');
    if (resetAt !== null && resetAt > 0) return resetAt;
    var resetsAt = nullableLong(obj, 'resets_at');
    if (resetsAt !== null && resetsAt > 0) return resetsAt;
    var after = nullableLong(obj, 'reset_after_seconds');
    if (after === null || after < 0) return null;
    return nowSeconds + after;
  }

  function parseApiWindow(rate, key, nowSeconds) {
    if (!hasValue(rate, key)) return null;
    var obj = rate[key];
    if (!isObject(obj)) return null;
    var used = finiteDouble(obj, 'used_percent');
    if (used === null) return null;
    var seconds = windowSecondsOf(obj);
    if (seconds === null || seconds <= 0) return null;
    return { usedPercent: used, windowSeconds: seconds, resetAt: resetAtOf(obj, nowSeconds) };
  }

  /** 短于 24 小时的窗口归入 5 小时槽，24 小时及以上归入周额度；缺失的一侧保持 null。 */
  function classifyWindows(windows) {
    var primary = null;
    var secondary = null;
    for (var i = 0; i < windows.length; i++) {
      var window = windows[i];
      if (window.windowSeconds <= 0) continue;
      if (window.windowSeconds < LONG_WINDOW_SECONDS) {
        if (primary === null) primary = window;
      } else if (secondary === null) {
        secondary = window;
      }
    }
    return { primary: primary, secondary: secondary };
  }

  /** chatgpt.com wham 用量；缺失或非数字的 used_percent 不会变成 0。 */
  function parseUsagePayload(body, updatedAt) {
    var json = readJson(body, '用量数据无法解析');
    var rate = isObject(json.rate_limit) ? json.rate_limit : null;
    var plan = trimmedString(json.plan_type);
    if (plan === null && rate !== null) plan = trimmedString(rate.plan_type);
    if (plan === null) plan = '';
    var windows = [];
    if (rate !== null) {
      var primary = parseApiWindow(rate, 'primary_window', updatedAt);
      if (primary !== null) windows.push(primary);
      var secondary = parseApiWindow(rate, 'secondary_window', updatedAt);
      if (secondary !== null) windows.push(secondary);
    }
    var classified = classifyWindows(windows);
    return { planType: plan, updatedAt: updatedAt, primary: classified.primary, secondary: classified.secondary };
  }

  /** UsageSnapshot -> ProviderSnapshot：窗口固定为 5 小时 / 周标题与时长。 */
  function usageToProviderSnapshot(usage) {
    var windows = [];
    if (usage.primary) {
      windows.push({
        title: '5 小时限额',
        usedPercent: usage.primary.usedPercent,
        windowSeconds: FIVE_HOUR_SECONDS,
        resetAt: usage.primary.resetAt
      });
    }
    if (usage.secondary) {
      windows.push({
        title: '本周限额',
        usedPercent: usage.secondary.usedPercent,
        windowSeconds: WEEK_SECONDS,
        resetAt: usage.secondary.resetAt
      });
    }
    var hint = !usage.primary && usage.secondary ? '当前套餐无 5 小时限额' : null;
    return {
      id: 'codex',
      plan: usage.planType,
      updatedAt: usage.updatedAt,
      windows: windows,
      balance: null,
      credits: null,
      booster: null,
      hint: hint
    };
  }

  // ---------- Kimi 解析 ----------

  var KIMI_WINDOW_KEYS = {
    limit5h: { wire: 'limit_5h', title: '5 小时窗口', seconds: FIVE_HOUR_SECONDS },
    limit7d: { wire: 'limit_7d', title: '本周额度', seconds: WEEK_SECONDS },
    monthCode: { wire: 'limit_month_code', title: '本月额度', seconds: MONTH_SECONDS },
    monthTotal: { wire: 'limit_month_total', title: '本月额度', seconds: MONTH_SECONDS }
  };

  function isoReset(obj, name) {
    if (!hasValue(obj, name)) return null;
    var raw = obj[name];
    if (typeof raw !== 'string') return null;
    return parseIso8601EpochSeconds(raw);
  }

  function kimiWindow(usages, key, title, windowSeconds) {
    var spec = KIMI_WINDOW_KEYS[key];
    var obj = isObject(usages[spec.wire]) ? usages[spec.wire] : (isObject(usages[key]) ? usages[key] : null);
    if (!obj) return null;
    var ratio = finiteDouble(obj, 'used_ratio');
    if (ratio === null) ratio = finiteDouble(obj, 'usedRatio');
    if (ratio === null) return null;
    var resetAt = isoReset(obj, 'reset_time');
    if (resetAt === null) resetAt = isoReset(obj, 'resetAt');
    return { title: title, usedPercent: ratio * 100, windowSeconds: windowSeconds, resetAt: resetAt };
  }

  function nonBlankText(obj, name) {
    if (!hasValue(obj, name)) return null;
    var text = jsonText(obj[name]);
    return text.trim() === '' ? null : text;
  }

  function kimiBooster(json) {
    var wallet = null;
    if (hasOwn(json, 'boosterWallet')) {
      wallet = isObject(json.boosterWallet) ? json.boosterWallet : null;
    } else if (isObject(json.usages) && isObject(json.usages.boosterWallet)) {
      wallet = json.usages.boosterWallet;
    }
    if (!wallet) return null;
    var balance = isObject(wallet.balance) ? wallet.balance : null;
    if (balance !== null && balance.type === 'BOOSTER') {
      // 官方接口以百万分之一美分为单位，与 CLI 的 balanceCents 不同。
      var left = finiteDouble(balance, 'amountLeft');
      if (left === null) return null;
      var used = isObject(wallet.monthlyUsed) ? wallet.monthlyUsed : null;
      var limit = isObject(wallet.monthlyChargeLimit) ? wallet.monthlyChargeLimit : null;
      var currency = nonBlankText(limit, 'currency') || nonBlankText(used, 'currency') || 'USD';
      var monthlyUsed = used === null ? null : finiteDouble(used, 'priceInCents');
      return {
        amount: left / 100000000,
        currency: currency,
        monthlyUsed: monthlyUsed === null ? null : monthlyUsed / 100
      };
    }
    var cents = finiteDouble(wallet, 'balanceCents');
    if (cents === null) return null;
    var monthlyCents = finiteDouble(wallet, 'monthlyUsedCents');
    return {
      amount: cents / 100,
      currency: jsonText(wallet.currency === undefined ? '' : wallet.currency),
      monthlyUsed: monthlyCents === null ? null : monthlyCents / 100
    };
  }

  function parseKimiUsages(body, plan, updatedAt) {
    var json = readJson(body, 'Kimi Code 用量数据无法解析');
    var usages = isObject(json.usages) ? json.usages : null;
    var windows = [];
    if (usages) {
      var window5h = kimiWindow(usages, 'limit5h', '5 小时窗口', FIVE_HOUR_SECONDS);
      if (window5h !== null) windows.push(window5h);
      var window7d = kimiWindow(usages, 'limit7d', '本周额度', WEEK_SECONDS);
      if (window7d !== null) windows.push(window7d);
      var month = kimiWindow(usages, 'monthCode', '本月额度', MONTH_SECONDS);
      if (month === null) month = kimiWindow(usages, 'monthTotal', '本月额度', MONTH_SECONDS);
      if (month !== null) windows.push(month);
    }
    return {
      id: 'kimi',
      plan: plan === undefined ? null : plan,
      updatedAt: updatedAt,
      windows: windows,
      balance: null,
      credits: null,
      booster: kimiBooster(json),
      hint: null
    };
  }

  var MEMBERSHIP_KEYS = ['user_level_name', 'membership', 'tier', 'plan', 'level'];

  function membershipText(obj) {
    for (var i = 0; i < MEMBERSHIP_KEYS.length; i++) {
      var key = MEMBERSHIP_KEYS[i];
      if (!hasValue(obj, key)) continue;
      var raw = obj[key];
      if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
    }
    return null;
  }

  function parseKimiPlan(body) {
    var json = parseJson(body);
    if (!isObject(json)) return null;
    var direct = membershipText(json);
    if (direct !== null) return direct;
    var keys = Object.keys(json);
    for (var i = 0; i < keys.length; i++) {
      var nested = json[keys[i]];
      if (!isObject(nested)) continue;
      var value = membershipText(nested);
      if (value !== null) return value;
    }
    return null;
  }

  // ---------- DeepSeek 解析 ----------

  function selectBalance(infos) {
    var first = null;
    for (var i = 0; i < infos.length; i++) {
      var item = infos[i];
      if (!isObject(item)) continue;
      if (first === null) first = item;
      if (jsonText(item.currency === undefined ? '' : item.currency).trim() === 'CNY') return item;
    }
    return first;
  }

  function parseDeepSeekBalance(body, updatedAt) {
    var json = readJson(body, 'DeepSeek 余额数据无法解析');
    var infos = Array.isArray(json.balance_infos) ? json.balance_infos : null;
    var selected = infos === null ? null : selectBalance(infos);
    if (selected === null) throw coreError('ERROR', 'DeepSeek 余额数据无法解析');
    var total = firstFinite(selected, ['total_balance', 'totalBalance', 'total']);
    if (total === null) throw coreError('ERROR', 'DeepSeek 余额数据无法解析');
    var currency = jsonText(selected.currency === undefined ? '' : selected.currency).trim();
    var granted = firstFinite(selected, ['granted_balance', 'grantedBalance', 'granted']);
    var toppedUp = firstFinite(selected, ['topped_up_balance', 'toppedUpBalance', 'topped_up', 'toppedUp']);
    var available = flexibleBooleanAny(selected, ['is_available', 'isAvailable']);
    if (available === null) available = flexibleBooleanAny(json, ['is_available', 'isAvailable']);
    if (available === null) available = false;
    return {
      id: 'deepseek',
      plan: 'api',
      updatedAt: updatedAt,
      windows: [],
      balance: {
        amount: total,
        currency: currency,
        granted: granted,
        toppedUp: toppedUp,
        isAvailable: available
      },
      credits: null,
      booster: null,
      hint: null
    };
  }

  // ---------- 小米 MiMo 解析 ----------

  var MIMO_PLAN_KEYS = ['planName', 'plan_name', 'name', 'title', 'planNameCn'];
  var MIMO_PERIOD_KEYS = ['currentPeriodEnd', 'periodEnd', 'period_end', 'endTime', 'end_time', 'expireTime'];

  function findUsageItem(items, name) {
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!isObject(item)) continue;
      if (jsonText(item.name === undefined ? '' : item.name) === name) return item;
    }
    return null;
  }

  function jsonCode(body) {
    var json = parseJson(body);
    if (!isObject(json)) return null;
    return flexibleInt(json, 'code');
  }

  function parseMimoUsage(body, detail, updatedAt) {
    var json = readJson(body, '小米 MiMo 用量数据无法解析');
    var code = flexibleInt(json, 'code');
    if (code === 401) throw coreError('AUTH_REQUIRED', '小米账号登录已过期，请重新登录');
    if (code === null) throw coreError('ERROR', '小米 MiMo 用量数据无法解析');
    if (code !== 0) throw coreError('ERROR', '小米 MiMo 读取失败（' + code + '）');
    var data = isObject(json.data) ? json.data : null;
    var usage = data !== null && isObject(data.usage) ? data.usage : null;
    var items = usage !== null && Array.isArray(usage.items) ? usage.items : null;
    var creditItem = items === null ? null : findUsageItem(items, 'plan_total_token');
    if (creditItem === null && items !== null) creditItem = findUsageItem(items, 'month_total_token');
    var periodEnd = detail === null || detail === undefined ? null : detail.periodEnd;
    var credits = null;
    if (creditItem !== null) {
      var used = finiteDouble(creditItem, 'used');
      var limit = finiteDouble(creditItem, 'limit');
      if (used !== null && limit !== null) credits = { used: used, limit: limit, periodEnd: periodEnd };
    }
    var percent = usage === null ? null : finiteDouble(usage, 'percent');
    var windows = [];
    if (percent !== null) {
      var cycle = detail === null || detail === undefined ? null : detail.cycle;
      var title = cycle === 'year' ? '年度额度' : (cycle === 'month' ? '本月额度' : '套餐额度');
      var seconds = cycle === 'year' ? 365 * 24 * 3600 : (cycle === 'month' ? MONTH_SECONDS : 0);
      windows.push({ title: title, usedPercent: percent * 100, windowSeconds: seconds, resetAt: periodEnd });
    }
    return {
      id: 'mimo',
      plan: detail === null || detail === undefined ? null : detail.plan,
      updatedAt: updatedAt,
      windows: windows,
      balance: null,
      credits: credits,
      booster: null,
      hint: null
    };
  }

  function parseMimoDetail(body) {
    var json = parseJson(body);
    if (!isObject(json)) return null;
    var code = flexibleInt(json, 'code');
    if (code !== null && code !== 0) return null;
    var data = isObject(json.data) ? json.data : null;
    if (data === null) return null;
    var planCode = textValue(data.planCode);
    var cycle = null;
    if (planCode !== null) {
      var suffix = planCode.toLowerCase().split(':').pop();
      if (suffix === 'year' || suffix === 'month') cycle = suffix;
    }
    var name = null;
    for (var i = 0; i < MIMO_PLAN_KEYS.length && name === null; i++) {
      name = textValue(data[MIMO_PLAN_KEYS[i]]);
    }
    var plan = null;
    if (cycle === 'year' && name !== null) plan = name + ' · 年度套餐';
    else if (cycle === 'month' && name !== null) plan = name + ' · 月度套餐';
    else if (name !== null) plan = name.toLowerCase();
    var periodEnd = null;
    for (var j = 0; j < MIMO_PERIOD_KEYS.length && periodEnd === null; j++) {
      var key = MIMO_PERIOD_KEYS[j];
      if (!hasValue(data, key)) continue;
      periodEnd = parseFlexibleEpoch(data[key]);
    }
    if (plan === null && periodEnd === null) return null;
    return { plan: plan, periodEnd: periodEnd, cycle: cycle };
  }

  // ---------- Cursor 官网用量（网页会话；不使用团队管理员密钥） ----------

  function parseCursorUsage(body, updatedAt) {
    var data = readJson(body, 'Cursor 用量响应格式错误');
    if (!isObject(data.individualUsage) && !isObject(data.teamUsage) && data.isUnlimited !== true) {
      throw coreError('ERROR', 'Cursor 用量响应缺少额度信息');
    }
    var individual = isObject(data.individualUsage) ? data.individualUsage : {};
    var team = isObject(data.teamUsage) ? data.teamUsage : {};
    var overall = isObject(individual.overall) && individual.overall.enabled !== false ? individual.overall : null;
    var plan = isObject(individual.plan) && individual.plan.enabled !== false ? individual.plan : null;
    // 团队席位的个人总预算与套餐内额度不是同一概念，优先展示明确的个人预算。
    var personal = overall || plan;
    var start = parseFlexibleEpoch(data.billingCycleStart);
    var end = parseFlexibleEpoch(data.billingCycleEnd);
    var seconds = start !== null && end !== null && end > start ? end - start : MONTH_SECONDS;
    var windows = [];
    var details = [];

    function money(value) { return '$' + (value / 100).toFixed(2); }
    function nonnegative(obj, key) {
      var value = finiteDouble(obj, key);
      return value !== null && value >= 0 ? value : null;
    }
    function addWindow(title, percent) {
      if (percent === null) return;
      windows.push({ title: title, usedPercent: Math.max(0, Math.min(100, percent)), windowSeconds: seconds, resetAt: end });
    }
    var used = nonnegative(personal, 'used');
    var limit = nonnegative(personal, 'limit');
    var percent = personal === plan && plan !== null ? nonnegative(plan, 'totalPercentUsed') : null;
    if (percent === null && used !== null && limit !== null && limit > 0) percent = used / limit * 100;
    addWindow(overall ? '个人本期额度' : '套餐本期额度', percent);
    if (used !== null) {
      details.push((overall ? '个人本期已用 ' : '套餐已用 ') + money(used) +
        (limit !== null && limit > 0 ? ' / ' + money(limit) : ' · 上限未提供'));
    }
    if (overall === null && plan !== null) {
      addWindow('Auto / Cursor 模型', nonnegative(plan, 'autoPercentUsed'));
      addWindow('第三方模型', nonnegative(plan, 'apiPercentUsed'));
    }
    var pooled = isObject(team.pooled) && team.pooled.enabled !== false ? team.pooled : null;
    var pooledUsed = nonnegative(pooled, 'used');
    var pooledLimit = nonnegative(pooled, 'limit');
    // 共享池不能冒充个人剩余额度；仅在个人比例缺失时提供明确标注的团队窗口。
    if (!windows.length && pooledUsed !== null && pooledLimit !== null && pooledLimit > 0) {
      addWindow('团队共享额度', pooledUsed / pooledLimit * 100);
    }
    var extra = isObject(individual.onDemand) && individual.onDemand.enabled !== false ? individual.onDemand : null;
    var extraUsed = nonnegative(extra, 'used');
    var extraLimit = nonnegative(extra, 'limit');
    if (extraUsed !== null) {
      details.push('个人额外消费 ' + money(extraUsed) + (extraLimit !== null && extraLimit > 0 ? ' / ' + money(extraLimit) : ''));
    }
    if (!details.length && !windows.length) details.push(data.isUnlimited === true ? '当前套餐无固定额度上限' : '接口未提供个人额度上限');
    return {
      id: 'cursor', plan: trimmedString(data.membershipType), updatedAt: updatedAt,
      windows: windows, balance: null, credits: null, booster: null, hint: null, details: details
    };
  }

  function hasWebviewSession(raw) {
    var value = typeof raw === 'string' ? parseJson(raw) : raw;
    return isObject(value) && value.type === 'webview';
  }

  async function fetchCursorUsage(context) {
    var response = await http({
      request: context.request, url: CURSOR_USAGE_URL, headers: { Accept: 'application/json' }, cookies: true
    });
    if (response.status === 401 || response.status === 403) {
      throw coreError('AUTH_REQUIRED', 'Cursor 登录已失效或无权查看，请在设置页重新登录并检查');
    }
    if (!isSuccess(response.status)) throw coreError('ERROR', 'Cursor 读取失败（' + response.status + '）');
    return parseCursorUsage(response.body, context.nowSeconds());
  }

  // ---------- 归一化快照缓存 ----------

  function normalizeWindows(raw) {
    if (!Array.isArray(raw)) return [];
    var windows = [];
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      if (!isObject(item)) continue;
      var title = cacheString(item.title);
      var percent = finiteDouble(item, 'usedPercent');
      var seconds = nullableLong(item, 'windowSeconds');
      if (title === null || percent === null || seconds === null) continue;
      windows.push({
        title: title,
        usedPercent: percent,
        windowSeconds: seconds,
        resetAt: nullableLong(item, 'resetAt')
      });
    }
    return windows;
  }

  function normalizeBalance(raw) {
    if (!isObject(raw)) return null;
    var amount = finiteDouble(raw, 'amount');
    var currency = cacheString(raw.currency);
    if (amount === null || currency === null) return null;
    var available = flexibleBoolean(raw, 'isAvailable');
    return {
      amount: amount,
      currency: currency,
      granted: finiteDouble(raw, 'granted'),
      toppedUp: finiteDouble(raw, 'toppedUp'),
      isAvailable: available === null ? false : available
    };
  }

  function normalizeCredits(raw) {
    if (!isObject(raw)) return null;
    var used = finiteDouble(raw, 'used');
    var limit = finiteDouble(raw, 'limit');
    if (used === null || limit === null) return null;
    return { used: used, limit: limit, periodEnd: nullableLong(raw, 'periodEnd') };
  }

  function normalizeBooster(raw) {
    if (!isObject(raw)) return null;
    var amount = finiteDouble(raw, 'amount');
    var currency = cacheString(raw.currency);
    if (amount === null || currency === null) return null;
    return { amount: amount, currency: currency, monthlyUsed: finiteDouble(raw, 'monthlyUsed') };
  }

  function normalizeSnapshot(raw, id) {
    if (!isObject(raw)) return null;
    var wireId = cacheString(raw.id);
    if (wireId === null || wireId !== id) return null;
    var updatedAt = nullableLong(raw, 'updatedAt');
    if (updatedAt === null) return null;
    var snapshot = {
      id: id,
      plan: cacheString(raw.plan),
      updatedAt: updatedAt,
      windows: normalizeWindows(raw.windows),
      balance: normalizeBalance(raw.balance),
      credits: normalizeCredits(raw.credits),
      booster: normalizeBooster(raw.booster),
      hint: cacheString(raw.hint)
    };
    if (Array.isArray(raw.details)) snapshot.details = raw.details.filter(function (line) { return typeof line === 'string'; });
    return snapshot;
  }

  function parseCachedProviderSnapshot(text) {
    var json = typeof text === 'string' ? parseJson(text) : (isObject(text) ? text : null);
    if (!isObject(json)) return null;
    var wireId = cacheString(json.id);
    if (wireId === null) return null;
    return normalizeSnapshot(json, wireId);
  }

  // ---------- 网络 ----------

  /**
   * 统一走注入的 request；传输层异常与缺少状态码都收敛成安全文案，
   * 服务端响应正文只进入解析器，不进入错误信息。
   * cookies 为 false 时也必须原样传出：设置页以“是否带有 cookies 字段”选择原生桥。
   * 响应的 url / headers 只供本次跳转判断，不写入快照、状态或日志。
   */
  async function http(options) {
    var params = {
      url: options.url,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeoutMs: REQUEST_TIMEOUT_MS
    };
    if (options.body !== undefined && options.body !== null) params.body = options.body;
    if (hasOwn(options, 'cookies')) params.cookies = options.cookies;
    if (hasOwn(options, 'redirect')) params.redirect = options.redirect;
    var response;
    try {
      response = await options.request(params);
    } catch (_) {
      throw coreError('ERROR', '网络请求失败');
    }
    var status = null;
    if (response && (typeof response.status === 'number' || typeof response.status === 'string')) {
      status = Number(response.status);
    }
    if (status === null || !isFinite(status)) throw coreError('ERROR', '网络请求失败');
    var result = {
      status: Math.trunc(status),
      body: response && response.body !== null && response.body !== undefined ? String(response.body) : ''
    };
    if (response && typeof response.url === 'string') result.url = response.url;
    if (response && isObject(response.headers)) result.headers = response.headers;
    return result;
  }

  function isSuccess(status) {
    return status >= 200 && status <= 299;
  }

  function jsonHeaders(secret) {
    return { Authorization: 'Bearer ' + secret, Accept: 'application/json' };
  }

  async function fetchDeepSeek(secret) {
    var response = await http({
      request: this.request,
      url: DEEPSEEK_BALANCE_URL,
      method: 'GET',
      headers: jsonHeaders(secret)
    });
    if (response.status === 401) throw coreError('AUTH_REQUIRED', 'DeepSeek API Key 无效或已过期');
    if (!isSuccess(response.status)) throw coreError('ERROR', 'DeepSeek 读取失败（' + response.status + '）');
    return parseDeepSeekBalance(response.body, this.nowSeconds());
  }

  async function readKimiPlan(secret) {
    try {
      var response = await http({
        request: this.request,
        url: KIMI_ME_URL,
        method: 'GET',
        headers: jsonHeaders(secret)
      });
      if (!isSuccess(response.status)) return null;
      return parseKimiPlan(response.body);
    } catch (_) {
      return null;
    }
  }

  async function fetchKimi(secret) {
    var response = await http({
      request: this.request,
      url: KIMI_USAGES_URL,
      method: 'GET',
      headers: jsonHeaders(secret)
    });
    if (response.status === 401) throw coreError('AUTH_REQUIRED', 'Kimi Code API Key 无效或已过期');
    if (!isSuccess(response.status)) throw coreError('ERROR', 'Kimi Code 读取失败（' + response.status + '）');
    var snapshot = parseKimiUsages(response.body, null, this.nowSeconds());
    snapshot.plan = await readKimiPlan.call(this, secret);
    return snapshot;
  }

  var MIMO_ACCOUNT_HOST = 'account.xiaomi.com';
  var MIMO_PLATFORM_HOST = 'platform.xiaomimimo.com';
  var MIMO_PASSPORT_HOPS = 8;

  /** 业务存储里的 MiMo 凭据：网页会话标记，或迁移期保留的手动 Cookie 字符串。 */
  function parseMimoAuth(raw) {
    if (isObject(raw)) return raw.type === 'webview' ? { kind: 'webview' } : null;
    if (typeof raw !== 'string') return null;
    var text = raw.trim();
    if (text === '') return null;
    var parsed = parseJson(text);
    if (isObject(parsed) && parsed.type === 'webview') return { kind: 'webview' };
    return { kind: 'cookie', secret: text };
  }

  function mimoMarker() {
    return JSON.stringify({ type: 'webview' });
  }

  /**
   * 只识别实际会遇到的绝对 http(s) URL。不用 URL / URI，避免依赖 QuickJS 没有的宿主 API。
   * 拒绝 userinfo、显式端口、空白和控制字符；host 按小写比较。
   */
  function parseAbsoluteHttpUrl(url) {
    if (typeof url !== 'string' || url === '') return null;
    if (/[\u0000-\u0020\u007f\\]/.test(url)) return null;
    var match = /^(https?):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url);
    if (!match) return null;
    var scheme = match[1];
    if (scheme !== 'http' && scheme !== 'https') return null;
    var authority = match[2];
    if (authority === '' || authority.indexOf('@') !== -1) return null;
    var host = authority;
    var port = null;
    var colon = authority.indexOf(':');
    if (colon !== -1) {
      if (authority.indexOf(':', colon + 1) !== -1) return null;
      host = authority.slice(0, colon);
      var portText = authority.slice(colon + 1);
      if (!/^\d+$/.test(portText)) return null;
      port = portText;
    }
    host = host.toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(host)) return null;
    return {
      scheme: scheme,
      host: host,
      port: port,
      path: match[3] === '' ? '/' : match[3],
      query: match[4] || ''
    };
  }

  function acceptedAccountLoginUrl(url) {
    var parts = parseAbsoluteHttpUrl(url);
    if (!parts || parts.scheme !== 'https' || parts.port !== null || parts.host !== MIMO_ACCOUNT_HOST) {
      return null;
    }
    return url;
  }

  function acceptedMimoHop(url) {
    var parts = parseAbsoluteHttpUrl(url);
    if (!parts || parts.port !== null) return null;
    if (parts.host !== MIMO_ACCOUNT_HOST && parts.host !== MIMO_PLATFORM_HOST) return null;
    if (parts.scheme === 'http') return 'https://' + url.slice('http://'.length);
    if (parts.scheme !== 'https') return null;
    return url;
  }

  function removeDotSegments(path) {
    var segments = path.split('/');
    var out = [];
    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i];
      if (segment === '' || segment === '.') {
        if (i === 0 || (segment === '' && i === segments.length - 1)) out.push('');
        continue;
      }
      if (segment === '..') {
        if (out.length > 1) out.pop();
        continue;
      }
      out.push(segment);
    }
    if (out.length === 0 || (out.length === 1 && out[0] === '')) return '/';
    var joined = out.join('/');
    return joined.charAt(0) === '/' ? joined : '/' + joined;
  }

  /** 绝对地址原样保留；根相对与目录相对按当前跳的路径拼接。协议相对和其他 scheme 拒绝。 */
  function resolveMimoRedirect(baseUrl, location) {
    if (typeof location !== 'string') return null;
    var ref = location.trim();
    if (ref === '' || /[\u0000-\u0020\u007f\\]/.test(ref)) return null;
    if (ref.indexOf('https://') === 0 || ref.indexOf('http://') === 0) return ref;
    if (ref.charAt(0) === '/' && ref.charAt(1) === '/') return null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) return null;
    var base = parseAbsoluteHttpUrl(baseUrl);
    if (!base || base.port !== null) return null;
    var noHash = ref.split('#')[0];
    var queryAt = noHash.indexOf('?');
    var pathPart = queryAt === -1 ? noHash : noHash.slice(0, queryAt);
    var query = queryAt === -1 ? '' : noHash.slice(queryAt);
    var path;
    if (pathPart === '') path = base.path;
    else if (pathPart.charAt(0) === '/') path = removeDotSegments(pathPart);
    else {
      var slash = base.path.lastIndexOf('/');
      var dir = slash >= 0 ? base.path.slice(0, slash + 1) : '/';
      path = removeDotSegments(dir + pathPart);
    }
    if (path.charAt(0) !== '/') path = '/' + path;
    return 'https://' + base.host + path + query;
  }

  function firstHeader(headers, name) {
    if (!isObject(headers)) return null;
    var wanted = name.toLowerCase();
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i]).toLowerCase() !== wanted) continue;
      var value = headers[keys[i]];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
      if (Array.isArray(value)) {
        for (var j = 0; j < value.length; j++) {
          if (typeof value[j] === 'string' && value[j].trim() !== '') return value[j].trim();
        }
      }
    }
    return null;
  }

  function mimoLoginUrlFromBody(body) {
    var json = parseJson(body);
    if (!isObject(json) || typeof json.loginUrl !== 'string') return null;
    var url = json.loginUrl.trim();
    return url === '' ? null : url;
  }

  function mimoNeedsLogin(response) {
    return response.status === 401 || jsonCode(response.body) === 401;
  }

  function isMimoRedirect(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
  }

  /**
   * mode: session 使用 Profile Cookie；cookie 发送手动 Cookie 且 cookies:false；
   * anonymous 强制 cookies:false，让平台返回签名登录地址。
   */
  async function mimoRequest(context, url, mode, secret) {
    var headers = { Accept: 'application/json' };
    if (mode === 'cookie') headers.Cookie = secret;
    return http({
      request: context.request,
      url: url,
      method: 'GET',
      headers: headers,
      cookies: mode === 'session'
    });
  }

  async function readMimoDetail(context, mode, secret) {
    try {
      var response = await mimoRequest(context, MIMO_DETAIL_URL, mode, secret);
      if (!isSuccess(response.status)) return null;
      return parseMimoDetail(response.body);
    } catch (_) {
      return null;
    }
  }

  async function loadMimoLoginUrl(context) {
    var response = await mimoRequest(context, MIMO_USAGE_URL, 'anonymous');
    var loginUrl = mimoLoginUrlFromBody(response.body);
    if (loginUrl === null) {
      throw coreError('ERROR', '无法获取小米账号登录入口（' + response.status + '），请重试');
    }
    if (acceptedAccountLoginUrl(loginUrl) === null) throw coreError('ERROR', '小米账号登录入口异常');
    return loginUrl;
  }

  /** 用已有 Passport 会话走签名回调。Cookie 由宿主按跳读写，这里不解析 Set-Cookie。 */
  async function restoreMimoPassport(context, authResponse) {
    var loginUrl = mimoLoginUrlFromBody(authResponse.body);
    if (loginUrl === null) loginUrl = await loadMimoLoginUrl(context);
    else if (acceptedAccountLoginUrl(loginUrl) === null) throw coreError('ERROR', '小米账号登录入口异常');
    var url = loginUrl;
    for (var hop = 0; hop < MIMO_PASSPORT_HOPS; hop++) {
      var requestUrl = acceptedMimoHop(url);
      if (requestUrl === null) throw coreError('ERROR', '小米授权跳转地址异常');
      var response = await http({
        request: context.request,
        url: requestUrl,
        method: 'GET',
        headers: {},
        cookies: true,
        redirect: 'manual'
      });
      if (response.status >= 500) throw coreError('ERROR', '小米授权服务响应异常（' + response.status + '）');
      if (isMimoRedirect(response.status)) {
        var location = firstHeader(response.headers, 'location');
        if (location === null) throw coreError('ERROR', '小米授权跳转缺少地址');
        var resolved = resolveMimoRedirect(requestUrl, location);
        if (resolved === null) throw coreError('ERROR', '小米授权跳转地址异常');
        url = resolved;
        continue;
      }
      var parts = parseAbsoluteHttpUrl(requestUrl);
      if (!parts || parts.host !== MIMO_PLATFORM_HOST || response.status === 401) {
        throw coreError('AUTH_REQUIRED', '小米账号会话已失效，请重新登录');
      }
      return;
    }
    throw coreError('ERROR', '小米授权跳转次数过多');
  }

  async function fetchMimoUsage(context, mode, secret) {
    var response = await mimoRequest(context, MIMO_USAGE_URL, mode, secret);
    if (mode === 'session' && mimoNeedsLogin(response)) {
      await restoreMimoPassport(context, response);
      response = await mimoRequest(context, MIMO_USAGE_URL, 'session');
    }
    if (mimoNeedsLogin(response)) throw coreError('AUTH_REQUIRED', '小米账号登录已过期，请重新登录');
    if (!isSuccess(response.status)) throw coreError('ERROR', '小米 MiMo 读取失败（' + response.status + '）');
    var detail = await readMimoDetail(context, mode, secret);
    return parseMimoUsage(response.body, detail, context.nowSeconds());
  }

  // ---------- Codex 客户端 ----------

  function normalizeCodexAuth(raw) {
    var source = typeof raw === 'string' ? parseJson(raw) : raw;
    if (!isObject(source)) return null;
    var accessToken = typeof source.accessToken === 'string' ? source.accessToken : '';
    var refreshToken = typeof source.refreshToken === 'string' ? source.refreshToken : '';
    if (accessToken.trim() === '' || refreshToken.trim() === '') return null;
    return withAccountId({
      accessToken: accessToken,
      refreshToken: refreshToken,
      idToken: typeof source.idToken === 'string' ? source.idToken : '',
      accountId: typeof source.accountId === 'string' ? source.accountId : ''
    });
  }

  async function usageRequest(credentials) {
    return http({
      request: this.request,
      url: CODEX_USAGE_URL,
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + credentials.accessToken,
        'ChatGPT-Account-Id': credentials.accountId,
        Accept: 'application/json'
      }
    });
  }

  /** 轮换单飞：并发 401 只发一次 refresh_token 请求，且写回前重读当前凭据。 */
  async function rotateCodexTokens(context, seen, generation) {
    if (codexRotateFlight) return codexRotateFlight;
    var flight = (async function () {
      var latest = normalizeCodexAuth(await context.storage.get(authKey('codex')));
      if (latest === null) throw coreError('AUTH_REQUIRED', '尚未登录');
      if (latest.accessToken !== seen.accessToken || latest.refreshToken !== seen.refreshToken) {
        return latest; // 其他已经完成的轮换：直接采用最新凭据，不重复轮换。
      }
      var response = await http({
        request: context.request,
        url: OAUTH_TOKEN_URL,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: refreshTokenBody(latest.refreshToken)
      });
      if (!isSuccess(response.status)) throw oauthError(response.status, response.body);
      var updated = applyRefreshResponse(latest, response.body);
      await context.guardedSet('codex', generation, authKey('codex'), JSON.stringify(updated));
      return updated;
    })();
    codexRotateFlight = flight.then(function (value) {
      codexRotateFlight = null;
      return value;
    }, function (error) {
      codexRotateFlight = null;
      throw error;
    });
    return codexRotateFlight;
  }

  async function fetchCodex(context, generation) {
    var current = normalizeCodexAuth(await context.storage.get(authKey('codex')));
    if (current === null) throw coreError('AUTH_REQUIRED', '尚未登录');
    if (current.accountId === '') throw coreError('ERROR', '缺少 ChatGPT 账户标识，无法读取用量');
    var response = await usageRequest.call(context, current);
    if (response.status === 401) {
      if (!context.allowTokenRefresh) {
        throw coreError('AUTH_REQUIRED', '登录已失效，请在模块设置中刷新登录');
      }
      current = await rotateCodexTokens(context, current, generation);
      response = await usageRequest.call(context, current);
    }
    if (response.status === 401) throw coreError('AUTH_REQUIRED', '登录已失效，请重新登录');
    if (!isSuccess(response.status)) throw coreError('ERROR', '读取用量失败（' + response.status + '）');
    var usage = parseUsagePayload(response.body, context.nowSeconds());
    return usageToProviderSnapshot(usage);
  }

  async function pollForAuthorization(context, login, isCancelled) {
    var interval = Number(login.interval);
    var start = Number(login.start);
    for (;;) {
      if (isCancelled !== null && isCancelled()) throw cancelledError();
      if (context.now() - start >= DEVICE_LOGIN_TIMEOUT_MS) {
        throw coreError('ERROR', '设备码登录已超过 15 分钟，请重新获取验证码');
      }
      var response = await http({
        request: context.request,
        url: DEVICE_TOKEN_URL,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: devicePollRequestBody(login.deviceAuthId, login.userCode)
      });
      if (isSuccess(response.status)) return parseDeviceAuthorization(response.body);
      if (response.status === 403 || response.status === 404) {
        var remaining = DEVICE_LOGIN_TIMEOUT_MS - (context.now() - start);
        if (remaining <= 0) throw coreError('ERROR', '设备码登录已超过 15 分钟，请重新获取验证码');
        await context.sleep(Math.min(interval * 1000, remaining));
        continue;
      }
      throw coreError('ERROR', '设备码确认失败（' + response.status + '）');
    }
  }

  // ---------- create ----------

  function create(options) {
    if (!options || !options.storage || typeof options.request !== 'function') {
      throw coreError('ERROR', '缺少 storage 或 request 注入');
    }
    var storage = options.storage;
    var now = typeof options.now === 'function' ? options.now : function () { return Date.now(); };
    var sleep = typeof options.sleep === 'function' ? options.sleep : function (ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    };
    // 背屏显式关闭续期；设置页默认允许轮换。
    var allowTokenRefresh = options.allowTokenRefresh !== false;

    // 每个来源的代数：clear / saveSecret 递增，用于丢弃在途写入。
    var generations = { codex: 0, kimi: 0, deepseek: 0, mimo: 0, cursor: 0 };

    var context = {
      storage: storage,
      request: options.request,
      allowTokenRefresh: allowTokenRefresh,
      now: now,
      nowSeconds: function () { return Math.floor(now() / 1000); },
      sleep: sleep
    };

    /** 写入前校验代数，写入期间发生变化则撤回，避免清理后残留旧数据。 */
    async function guardedSet(id, generation, key, value) {
      if (generations[id] !== generation) throw cancelledError();
      await storage.set(key, value);
      if (generations[id] !== generation) {
        try { await storage.remove(key); } catch (_) { /* 撤回失败不再放大 */ }
        throw cancelledError();
      }
    }

    context.guardedSet = guardedSet;

    async function readSecret(id) {
      var value = await storage.get(authKey(id));
      if (typeof value !== 'string') return null;
      var secret = value.trim();
      return secret === '' ? null : secret;
    }

    async function readSnapshot(id) {
      var value = await storage.get(usageKey(id));
      var raw = typeof value === 'string' ? parseJson(value) : value;
      return normalizeSnapshot(raw, id);
    }

    async function readStatus(id) {
      var value = await storage.get(statusKey(id));
      var raw = typeof value === 'string' ? parseJson(value) : value;
      if (!isObject(raw)) return null;
      var code = typeof raw.code === 'string' && ERROR_CODE[raw.code] ? raw.code : null;
      if (code === null || typeof raw.message !== 'string') return null;
      var updatedAt = typeof raw.updatedAt === 'number' && isFinite(raw.updatedAt) ? raw.updatedAt : null;
      return { code: code, message: raw.message, updatedAt: updatedAt };
    }

    async function isConfigured(id) {
      if (id === 'codex') return normalizeCodexAuth(await storage.get(authKey(id))) !== null;
      if (id === 'mimo') return parseMimoAuth(await storage.get(authKey(id))) !== null;
      if (id === 'cursor') return hasWebviewSession(await storage.get(authKey(id)));
      return (await readSecret(id)) !== null;
    }

    async function writeStatus(id, failure, generation) {
      if (generations[id] !== generation) return;
      var status = {
        code: typeof failure.code === 'string' && ERROR_CODE[failure.code] ? failure.code : 'ERROR',
        message: typeof failure.message === 'string' && failure.message !== '' ? failure.message : '操作失败',
        updatedAt: context.nowSeconds()
      };
      try {
        await guardedSet(id, generation, statusKey(id), JSON.stringify(status));
      } catch (_) {
        // 状态写入失败（含清理竞争）不改变刷新本身的结论。
      }
    }

    async function persistSnapshot(id, snapshot, generation) {
      await guardedSet(id, generation, usageKey(id), JSON.stringify(snapshot));
      if (generations[id] !== generation) throw cancelledError();
      try {
        await storage.remove(statusKey(id));
      } catch (_) { /* 状态清理失败保留旧状态，不影响展示 */ }
      if (generations[id] !== generation) throw cancelledError();
    }

    async function fetchProvider(id, generation) {
      if (id === 'codex') return fetchCodex(context, generation);
      if (id === 'cursor') return fetchCursorUsage(context);
      if (id === 'mimo') {
        var auth = parseMimoAuth(await storage.get(authKey('mimo')));
        if (auth === null) throw coreError('AUTH_REQUIRED', '尚未设置');
        if (auth.kind === 'webview') return fetchMimoUsage(context, 'session');
        return fetchMimoUsage(context, 'cookie', auth.secret);
      }
      var secret = await readSecret(id);
      if (secret === null) throw coreError('AUTH_REQUIRED', '尚未设置');
      if (id === 'kimi') return fetchKimi.call(context, secret);
      if (id === 'deepseek') return fetchDeepSeek.call(context, secret);
      throw coreError('ERROR', '不支持的来源');
    }

    async function runRefresh(id) {
      var generation = generations[id];
      if (!await isConfigured(id)) {
        throw coreError('AUTH_REQUIRED', id === 'codex' ? '尚未登录' : '尚未设置');
      }
      try {
        var snapshot = await fetchProvider(id, generation);
        await persistSnapshot(id, snapshot, generation);
        return snapshot;
      } catch (error) {
        var failure = toCoreError(error);
        if (generations[id] !== generation) throw cancelledError();
        await writeStatus(id, failure, generation);
        throw failure;
      }
    }

    async function visibleProviderIds() {
      var raw = await storage.get(DISPLAY_PROVIDERS_KEY);
      var saved = typeof raw === 'string' ? parseJson(raw) : raw;
      var ids = [];
      for (var i = 0; i < PROVIDERS.length; i++) {
        var id = PROVIDERS[i].id;
        if (Array.isArray(saved) && saved.indexOf(id) === -1) continue;
        if (await isConfigured(id)) ids.push(id);
      }
      // 无偏好时兼容已有四个来源；新安装只配置 Cursor 时也会默认展示它。
      return ids.slice(0, MAX_DISPLAY_PROVIDERS);
    }

    async function setProviderVisible(id, visible) {
      if (!findProvider(id)) throw coreError('ERROR', '不支持的来源');
      if (!await isConfigured(id)) throw coreError('ERROR', '请先配置该来源');
      var ids = await visibleProviderIds();
      var index = ids.indexOf(id);
      if (visible && index === -1) {
        if (ids.length >= MAX_DISPLAY_PROVIDERS) throw coreError('ERROR', '背屏最多展示 4 个来源，请先取消一个');
        ids.push(id);
      } else if (!visible && index !== -1) ids.splice(index, 1);
      await storage.set(DISPLAY_PROVIDERS_KEY, JSON.stringify(ids));
    }

    async function state() {
      var visible = await visibleProviderIds();
      var rows = [];
      for (var i = 0; i < PROVIDERS.length; i++) {
        var provider = PROVIDERS[i];
        rows.push({
          id: provider.id,
          name: provider.name,
          logoAsset: provider.logoAsset,
          configured: await isConfigured(provider.id),
          visible: visible.indexOf(provider.id) !== -1,
          snapshot: await readSnapshot(provider.id),
          status: await readStatus(provider.id)
        });
      }
      return rows;
    }

    /** 卡片展示数据：仅勾选且已配置的最多四个来源，缺省字段不输出。 */
    async function cardConfig() {
      var entries = [];
      var newest = null;
      var visible = await visibleProviderIds();
      for (var i = 0; i < PROVIDERS.length; i++) {
        var provider = PROVIDERS[i];
        if (visible.indexOf(provider.id) === -1) continue;
        var snapshot = await readSnapshot(provider.id);
        var entry = { id: provider.id, name: provider.name };
        if (snapshot !== null && snapshot.plan !== null) entry.plan = snapshot.plan;
        entry.logoAsset = provider.logoAsset;
        entry.windows = snapshot === null ? [] : snapshot.windows.map(function (window) {
          var wire = { title: window.title, usedPercent: window.usedPercent, windowSeconds: window.windowSeconds };
          if (window.resetAt !== null) wire.resetAt = window.resetAt;
          return wire;
        });
        if (snapshot !== null) {
          if (snapshot.balance !== null) {
            var balance = { amount: snapshot.balance.amount, currency: snapshot.balance.currency };
            if (snapshot.balance.granted !== null) balance.granted = snapshot.balance.granted;
            if (snapshot.balance.toppedUp !== null) balance.toppedUp = snapshot.balance.toppedUp;
            balance.isAvailable = snapshot.balance.isAvailable;
            entry.balance = balance;
          }
          if (snapshot.credits !== null) {
            var credits = { used: snapshot.credits.used, limit: snapshot.credits.limit };
            if (snapshot.credits.periodEnd !== null) credits.periodEnd = snapshot.credits.periodEnd;
            entry.credits = credits;
          }
          if (snapshot.booster !== null) {
            var booster = { amount: snapshot.booster.amount, currency: snapshot.booster.currency };
            if (snapshot.booster.monthlyUsed !== null) booster.monthlyUsed = snapshot.booster.monthlyUsed;
            entry.booster = booster;
          }
          if (snapshot.hint !== null) entry.hint = snapshot.hint;
          if (snapshot.details) entry.details = snapshot.details;
          entry.updatedAt = snapshot.updatedAt;
          if (newest === null || snapshot.updatedAt > newest) newest = snapshot.updatedAt;
        }
        entries.push(entry);
      }
      // 还没有任何成功用量时不写当前时间，避免空卡片每次刷新都被当成新数据重绘。
      return { updatedAt: newest === null ? 0 : newest, providers: entries };
    }

    async function saveSecret(id, secret) {
      if (id === 'codex') throw coreError('ERROR', 'Codex 使用设备码登录，不能直接保存密钥');
      if (!SECRET_PROVIDER[id]) throw coreError('ERROR', '不支持的来源');
      var value = typeof secret === 'string' ? secret.trim() : '';
      if (value === '') throw coreError('ERROR', '密钥不能为空');
      generations[id]++;
      await storage.set(authKey(id), value);
      // 新凭据不能继续展示或跳过查询旧账号的缓存。
      await storage.remove(usageKey(id));
      try {
        await storage.remove(statusKey(id));
      } catch (_) { /* 新凭据下的旧错误状态尽力清理 */ }
    }

    async function clear(id) {
      if (!findProvider(id)) throw coreError('ERROR', '不支持的来源');
      generations[id]++;
      await storage.remove(authKey(id));
      await storage.remove(usageKey(id));
      await storage.remove(statusKey(id));
    }

    async function refresh(id) {
      if (!findProvider(id)) throw coreError('ERROR', '不支持的来源');
      return runRefresh(id);
    }

    /** 不要求事先配置。成功后写入网页会话标记并覆盖旧的手动 Cookie；失败不新标记为已配置。 */
    async function checkMimoLogin() {
      var generation = generations.mimo;
      var prior = parseMimoAuth(await storage.get(authKey('mimo')));
      try {
        var snapshot = await fetchMimoUsage(context, 'session');
        await guardedSet('mimo', generation, authKey('mimo'), mimoMarker());
        await persistSnapshot('mimo', snapshot, generation);
        return snapshot;
      } catch (error) {
        var failure = toCoreError(error);
        if (generations.mimo !== generation) throw cancelledError();
        if (prior !== null) await writeStatus('mimo', failure, generation);
        throw failure;
      }
    }

    async function requestMimoLoginUrl() {
      return loadMimoLoginUrl(context);
    }

    async function checkCursorLogin() {
      var generation = generations.cursor;
      var configured = await isConfigured('cursor');
      try {
        var snapshot = await fetchCursorUsage(context);
        await guardedSet('cursor', generation, authKey('cursor'), JSON.stringify({ type: 'webview' }));
        await persistSnapshot('cursor', snapshot, generation);
        return snapshot;
      } catch (error) {
        var failure = toCoreError(error);
        if (generations.cursor !== generation) throw cancelledError();
        if (configured) await writeStatus('cursor', failure, generation);
        throw failure;
      }
    }

    /** 逐来源刷新；单来源失败只写状态，最后返回完整 state 数组。 */
    async function refreshAll() {
      for (var i = 0; i < PROVIDERS.length; i++) {
        try {
          await runRefresh(PROVIDERS[i].id);
        } catch (_) {
          // 单来源失败隔离：状态已由 runRefresh 写入，继续其他来源。
        }
      }
      return state();
    }

    async function requestDeviceCode() {
      var response = await http({
        request: context.request,
        url: DEVICE_CODE_URL,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: deviceCodeRequestBody()
      });
      if (response.status === 404) throw coreError('ERROR', '当前服务未开启设备码登录');
      if (!isSuccess(response.status)) throw coreError('ERROR', '设备码申请失败（' + response.status + '）');
      return parseDeviceLogin(response.body, now());
    }

    async function completeDeviceLogin(login, options) {
      var isCancelled = options && typeof options.isCancelled === 'function' ? options.isCancelled : null;
      var generation = generations.codex;
      try {
        if (!login || !String(login.deviceAuthId || '').trim() ||
            !String(login.userCode || '').trim() || !(Number(login.interval) > 0)) {
          throw coreError('ERROR', '设备码登录信息不完整');
        }
        var authorization = await pollForAuthorization(context, login, isCancelled);
        var response = await http({
          request: context.request,
          url: OAUTH_TOKEN_URL,
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: authorizationCodeForm(authorization.authorizationCode, authorization.codeVerifier)
        });
        if (!isSuccess(response.status)) throw coreError('ERROR', '授权码交换失败（' + response.status + '）');
        var tokens = parseExchangedTokens(response.body);
        var stored = withAccountId({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          idToken: tokens.idToken,
          accountId: ''
        });
        // 取消或凭据已被替换时不落盘令牌。
        if (isCancelled !== null && isCancelled()) throw cancelledError();
        await guardedSet('codex', generation, authKey('codex'), JSON.stringify(stored));
        await storage.remove(usageKey('codex'));
        return await runRefresh('codex');
      } catch (error) {
        throw toCoreError(error);
      }
    }

    return {
      state: state,
      cardConfig: cardConfig,
      setProviderVisible: setProviderVisible,
      checkCursorLogin: checkCursorLogin,
      saveSecret: saveSecret,
      clear: clear,
      refresh: refresh,
      refreshAll: refreshAll,
      requestMimoLoginUrl: requestMimoLoginUrl,
      checkMimoLogin: checkMimoLogin,
      requestDeviceCode: requestDeviceCode,
      completeDeviceLogin: completeDeviceLogin
    };
  }

  window.AiUsageCore = {
    providers: PROVIDERS,
    create: create,
    parsers: {
      parseDeviceLogin: parseDeviceLogin,
      parseDeviceAuthorization: parseDeviceAuthorization,
      parseExchangedTokens: parseExchangedTokens,
      applyRefreshResponse: applyRefreshResponse,
      oauthFailureMessage: oauthFailureMessage,
      chatgptAccountId: chatgptAccountId,
      parseUsagePayload: parseUsagePayload,
      usageToProviderSnapshot: usageToProviderSnapshot,
      parseCachedProviderSnapshot: parseCachedProviderSnapshot,
      parseKimiUsages: parseKimiUsages,
      parseKimiPlan: parseKimiPlan,
      parseIso8601EpochSeconds: parseIso8601EpochSeconds,
      parseDeepSeekBalance: parseDeepSeekBalance,
      parseMimoUsage: parseMimoUsage,
      parseMimoDetail: parseMimoDetail,
      parseCursorUsage: parseCursorUsage,
      parseFlexibleEpoch: parseFlexibleEpoch
    }
  };
})();
