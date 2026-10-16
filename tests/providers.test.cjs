/**
 * src/shared/core.js 的协议 / 登录 / 缓存测试。
 *
 * 运行：node --test tests/providers.test.cjs
 * core.js 在 vm realm 中加载，模拟 QuickJS 卡片环境：没有 atob、Buffer、TextDecoder，
 * 也没有宿主 fetch；storage / request / now / sleep 全部注入。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const coreSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'core.js'), 'utf8');

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEVICE_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const KIMI_USAGES_URL = 'https://api.kimi.com/coding/v1/usages';
const KIMI_ME_URL = 'https://api.kimi.com/coding/v1/me';
const DEEPSEEK_URL = 'https://api.deepseek.com/user/balance';
const MIMO_USAGE_URL = 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage';
const MIMO_DETAIL_URL = 'https://platform.xiaomimimo.com/api/v1/tokenPlan/detail';

const PLUS_USAGE = JSON.stringify({
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 23.5, limit_window_seconds: 18000, reset_at: 1800000100 },
    secondary_window: { used_percent: 4, limit_window_seconds: 604800, reset_at: 1800500000 }
  }
});
const KIMI_OFFICIAL = JSON.stringify({
  usages: {
    limit_5h: { used_ratio: '0.12', reset_time: '2026-10-13T12:00:00Z' },
    limit_7d: { used_ratio: 0.64 }
  },
  boosterWallet: {
    balance: { type: 'BOOSTER', amount: 10000000000, amountLeft: 8650000000 },
    monthlyUsed: { priceInCents: 1350, currency: 'CNY' }
  }
});
const KIMI_FULL = JSON.stringify({
  usages: {
    limit5h: { usedRatio: 0.25, resetAt: '2026-10-13T16:00:00+08:00' },
    limit7d: { usedRatio: 0.5, resetAt: '2026-10-20T00:00Z' },
    monthCode: { usedRatio: 0.125, resetAt: '2026-11-01T00:00:00.123Z' },
    monthTotal: { usedRatio: 0.9, resetAt: '2026-12-01T00:00:00Z' }
  },
  boosterWallet: { balanceCents: 1500, currency: 'CNY', monthlyUsedCents: 200 }
});
const DEEPSEEK_CNY = JSON.stringify({
  is_available: true,
  balance_infos: [
    { currency: 'USD', total_balance: '1.50', granted_balance: '1.00', topped_up_balance: '0.50' },
    { currency: 'CNY', total_balance: '10.25', granted_balance: '2.00', topped_up_balance: '8.25' }
  ]
});
const MIMO_USAGE_BODY = JSON.stringify({
  code: 0,
  data: { usage: { percent: 0.25, items: [
    { name: 'plan_total_token', used: 1, limit: 2 },
    { name: 'month_total_token', used: 1200, limit: 10000 }
  ] } }
});
const MIMO_DETAIL_BODY = JSON.stringify({ code: 0, data: { planName: 'MiMo-Pro', periodEnd: 1800000000000 } });

const epoch = (...parts) => Math.floor(Date.UTC(...parts) / 1000);
const EASTERN_NEW_PERIOD_END = epoch(2027, 6, 9, 23, 59, 59) - 8 * 3600; // 2027-07-09 23:59:59 +08:00

function loadCore() {
  // 仅注入定时器；atob / Buffer / TextDecoder / fetch 在该 realm 中不存在。
  const sandbox = { setTimeout, clearTimeout };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(coreSource, sandbox, { filename: 'core.js' });
  assert.equal(typeof sandbox.atob, 'undefined');
  return { core: sandbox.window.AiUsageCore, sandbox };
}

function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async key => (key in data ? data[key] : null),
    set: async (key, value) => { data[key] = value; },
    remove: async key => { delete data[key]; }
  };
}

function scripted(handler) {
  const calls = [];
  const request = async options => {
    calls.push(options);
    return handler(options, calls.length);
  };
  request.calls = calls;
  return request;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function rejection(promise) {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught, 'expected a rejection');
  return caught;
}

async function waitFor(condition, label = 'condition') {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function jwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.sig`;
}

function accountJwt(accountId, extra) {
  return jwt({ ...(extra || {}), 'https://api.openai.com/auth': { chatgpt_account_id: accountId } });
}

test('providers contract, secret lifecycle and state rows', async () => {
  const { core } = loadCore();
  assert.deepEqual(plain(core.providers), [
    { id: 'codex', name: 'Codex', logoAsset: 'assets/openai.png' },
    { id: 'kimi', name: 'Kimi Code', logoAsset: 'assets/kimi.png' },
    { id: 'deepseek', name: 'DeepSeek', logoAsset: 'assets/deepseek.png' },
    { id: 'mimo', name: '小米 MiMo', logoAsset: 'assets/mimo.png' },
    { id: 'cursor', name: 'Cursor', logoAsset: 'assets/cursor.png' }
  ]);

  const storage = makeStorage();
  const client = core.create({ storage, request: scripted(() => { throw new Error('unused'); }) });

  const rows = await client.state();
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.equal(row.configured, false);
    assert.equal(row.snapshot, null);
    assert.equal(row.status, null);
  }

  await assert.rejects(() => client.refresh('kimi'), { code: 'AUTH_REQUIRED', message: '尚未设置' });
  await assert.rejects(() => client.refresh('codex'), { code: 'AUTH_REQUIRED', message: '尚未登录' });
  await assert.rejects(() => client.refresh('unknown'), { code: 'ERROR' });

  // saveSecret 只接受 kimi / deepseek / mimo，trim 后不能为空。
  await assert.rejects(() => client.saveSecret('codex', 'sk-x'), { code: 'ERROR' });
  await assert.rejects(() => client.saveSecret('unknown', 'sk-x'), { code: 'ERROR' });
  await assert.rejects(() => client.saveSecret('kimi', '   '), { code: 'ERROR' });
  storage.data['status.kimi'] = JSON.stringify({ code: 'ERROR', message: '旧错误', updatedAt: 1 });
  storage.data['usage.kimi'] = { id: 'kimi', updatedAt: 1, windows: [] };
  await client.saveSecret('kimi', '  sk-kimi-secret  ');
  assert.equal(storage.data['auth.kimi'], 'sk-kimi-secret');
  assert.equal('status.kimi' in storage.data, false, '新凭据清理旧错误状态');
  assert.equal('usage.kimi' in storage.data, false, '新凭据不沿用旧账号缓存');

  await client.saveSecret('deepseek', 'sk-deepseek-secret');
  await client.saveSecret('mimo', 'session=abc');
  const configured = await client.state();
  assert.deepEqual(plain(configured.map(row => [row.id, row.configured])),
    [['codex', false], ['kimi', true], ['deepseek', true], ['mimo', true], ['cursor', false]]);
  assert.ok(!JSON.stringify(configured).includes('secret'), 'state 不返回凭据');

  await client.clear('kimi');
  await client.clear('codex');
  assert.deepEqual(Object.keys(storage.data).sort(), ['auth.deepseek', 'auth.mimo']);
  await assert.rejects(() => client.clear('unknown'), { code: 'ERROR' });
});

test('kimi official wire parses5h/week windows, booster and plan via me', async () => {
  const { core } = loadCore();
  const storage = makeStorage({ 'auth.kimi': 'sk-kimi' });
  const request = scripted(options => {
    if (options.url === KIMI_USAGES_URL) {
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer sk-kimi');
      assert.equal(options.cookies, undefined, '其他来源不带 cookies 字段');
      return { status: 200, body: KIMI_OFFICIAL };
    }
    if (options.url === KIMI_ME_URL) return { status: 200, body: '{"profile":{"level":"Ultra"}}' };
    throw new Error(`unexpected ${options.url}`);
  });
  const client = core.create({ storage, request, now: () => 1700000000000 });

  const snapshot = await client.refresh('kimi');
  assert.deepEqual(plain(snapshot), {
    id: 'kimi',
    plan: 'Ultra',
    updatedAt: 1700000000,
    windows: [
      { title: '5 小时窗口', usedPercent: 12, windowSeconds: 18000, resetAt: epoch(2026, 9, 13, 12) },
      { title: '本周额度', usedPercent: 64, windowSeconds: 604800, resetAt: null }
    ],
    balance: null,
    credits: null,
    booster: { amount: 86.5, currency: 'CNY', monthlyUsed: 13.5 },
    hint: null
  });
  assert.deepEqual(request.calls.map(call => call.url), [KIMI_USAGES_URL, KIMI_ME_URL]);
  assert.equal(JSON.parse(storage.data['usage.kimi']).booster.amount, 86.5);
  assert.equal('status.kimi' in storage.data, false, '刷新成功清除错误状态');

  // camelCase 官方入参：5h/周 + 月额度三窗口，加油包走 balanceCents。
  const request2 = scripted(options => {
    if (options.url === KIMI_USAGES_URL) return { status: 200, body: KIMI_FULL };
    if (options.url === KIMI_ME_URL) return { status: 200, body: '{}' };
    throw new Error(`unexpected ${options.url}`);
  });
  const client2 = core.create({ storage, request: request2, now: () => 9000 });
  const full = await client2.refresh('kimi');
  assert.equal(full.plan, null);
  assert.deepEqual(plain(full.windows), [
    { title: '5 小时窗口', usedPercent: 25, windowSeconds: 18000, resetAt: epoch(2026, 9, 13, 8) },
    { title: '本周额度', usedPercent: 50, windowSeconds: 604800, resetAt: epoch(2026, 9, 20) },
    { title: '本月额度', usedPercent: 12.5, windowSeconds: 2592000, resetAt: epoch(2026, 10, 1) }
  ]);
  assert.deepEqual(plain(full.booster), { amount: 15, currency: 'CNY', monthlyUsed: 2 });
});

test('kimi auth failure keeps cache and writes only safe status', async () => {
  const { core } = loadCore();
  const oldSnapshot = {
    id: 'kimi', plan: null, updatedAt: 4242,
    windows: [{ title: '5 小时窗口', usedPercent: 5, windowSeconds: 18000, resetAt: null }],
    balance: null, credits: null, booster: null, hint: null
  };
  const storage = makeStorage({ 'auth.kimi': 'sk-secret-key', 'usage.kimi': JSON.stringify(oldSnapshot) });
  const client = core.create({
    storage,
    request: scripted(() => ({ status: 401, body: 'secret-body-should-not-leak' }))
  });

  const error = await rejection(client.refresh('kimi'));
  assert.equal(error.code, 'AUTH_REQUIRED');
  assert.equal(error.message, 'Kimi Code API Key 无效或已过期');
  assert.ok(!error.message.includes('sk-secret-key'));
  assert.ok(!error.message.includes('secret-body'));

  const status = JSON.parse(storage.data['status.kimi']);
  assert.deepEqual(status, {
    code: 'AUTH_REQUIRED',
    message: 'Kimi Code API Key 无效或已过期',
    updatedAt: Math.floor(Date.now() / 1000)
  });
  assert.equal(JSON.parse(storage.data['usage.kimi']).updatedAt, 4242, '失败保留上次成功数据');

  const rows = await client.state();
  const kimi = rows.find(row => row.id === 'kimi');
  assert.equal(kimi.configured, true);
  assert.equal(kimi.snapshot.updatedAt, 4242);
  assert.equal(kimi.status.code, 'AUTH_REQUIRED');

  // me 接口失败不影响用量与套餐回退。
  const meDown = core.create({
    storage: makeStorage({ 'auth.kimi': 'sk-kimi' }),
    request: scripted(options => options.url === KIMI_USAGES_URL
      ? { status: 200, body: KIMI_FULL }
      : Promise.reject(new Error('me down')))
  });
  const snapshot = await meDown.refresh('kimi');
  assert.equal(snapshot.plan, null);
  assert.equal(snapshot.windows.length, 3);
});

test('deepseek balance prefers CNY, parses string amounts and round-trips cache', async () => {
  const { core } = loadCore();
  const storage = makeStorage({ 'auth.deepseek': 'sk-deepseek' });
  const client = core.create({
    storage,
    request: scripted(options => {
      assert.equal(options.url, DEEPSEEK_URL);
      assert.equal(options.headers.Authorization, 'Bearer sk-deepseek');
      return { status: 200, body: DEEPSEEK_CNY };
    }),
    now: () => 40000
  });

  const snapshot = await client.refresh('deepseek');
  assert.deepEqual(plain(snapshot), {
    id: 'deepseek',
    plan: 'api',
    updatedAt: 40,
    windows: [],
    balance: { amount: 10.25, currency: 'CNY', granted: 2, toppedUp: 8.25, isAvailable: true },
    credits: null,
    booster: null,
    hint: null
  });
  const cached = await client.state();
  assert.deepEqual(plain(cached.find(row => row.id === 'deepseek').snapshot.balance),
    { amount: 10.25, currency: 'CNY', granted: 2, toppedUp: 8.25, isAvailable: true });

  // 首行回退（无 CNY）且 is_available 只在根级别时也能读取。
  const { parsers } = core;
  const fallback = parsers.parseDeepSeekBalance(JSON.stringify({
    is_available: false,
    balance_infos: [{ currency: 'USD', total_balance: '3.5', granted_balance: '1.5', topped_up_balance: '2' }]
  }), 41);
  assert.deepEqual(plain(fallback.balance), { amount: 3.5, currency: 'USD', granted: 1.5, toppedUp: 2, isAvailable: false });
  assert.throws(() => parsers.parseDeepSeekBalance('{"balance_infos":[]}', 1), { code: 'ERROR' });
});

test('mimo manual cookie query parses usage, detail and degrades safely', async () => {
  const { core } = loadCore();
  const cookie = 'session=abc; token=xyz';
  const storage = makeStorage({ 'auth.mimo': cookie });
  const request = scripted(options => {
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Cookie, cookie);
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.cookies, false, '手动 Cookie 不走 Profile');
    if (options.url === MIMO_USAGE_URL) return { status: 200, body: MIMO_USAGE_BODY };
    if (options.url === MIMO_DETAIL_URL) return { status: 200, body: MIMO_DETAIL_BODY };
    throw new Error(`unexpected ${options.url}`);
  });
  const client = core.create({ storage, request, now: () => 80000 });

  const snapshot = await client.refresh('mimo');
  assert.deepEqual(plain(snapshot), {
    id: 'mimo',
    plan: 'mimo-pro',
    updatedAt: 80,
    windows: [{ title: '套餐额度', usedPercent: 25, windowSeconds: 0, resetAt: 1800000000 }],
    balance: null,
    credits: { used: 1, limit: 2, periodEnd: 1800000000 },
    booster: null,
    hint: null
  });
  assert.ok(!JSON.stringify(plain(snapshot)).includes('session=abc'));
  assert.deepEqual(request.calls.map(call => call.url), [MIMO_USAGE_URL, MIMO_DETAIL_URL]);

  // detail 不可用时降级：无套餐名、无周期，但用量窗口保留。
  const detailDown = core.create({
    storage: makeStorage({ 'auth.mimo': 'session=ok' }),
    request: scripted(options => options.url === MIMO_USAGE_URL
      ? { status: 200, body: MIMO_USAGE_BODY }
      : { status: 500, body: '' })
  });
  const degraded = await detailDown.refresh('mimo');
  assert.equal(degraded.plan, null);
  assert.deepEqual(plain(degraded.windows), [{ title: '套餐额度', usedPercent: 25, windowSeconds: 0, resetAt: null }]);
  assert.deepEqual(plain(degraded.credits), { used: 1, limit: 2, periodEnd: null });

  // 年度套餐：本地时间到期点、年度窗口标题、plan_total_token 优先。
  const yearly = core.create({
    storage: makeStorage({ 'auth.mimo': 'session=ok' }),
    request: scripted(options => options.url === MIMO_USAGE_URL
      ? { status: 200, body: JSON.stringify({ code: 0, data: { usage: { percent: 0.14, items: [
        { name: 'month_total_token', used: 5, limit: 10 },
        { name: 'plan_total_token', used: 14, limit: 100 }
      ] } } }) }
      : { status: 200, body: JSON.stringify({ code: 0, data: {
        planCode: 'lite:year', planName: 'Lite', currentPeriodEnd: '2027-07-09 23:59:59' } }) })
  });
  const year = await yearly.refresh('mimo');
  assert.equal(year.plan, 'Lite · 年度套餐');
  assert.equal(year.windows.length, 1);
  assert.equal(year.windows[0].title, '年度额度');
  assert.ok(Math.abs(year.windows[0].usedPercent - 14) < 1e-9, 'percent * 100 保留浮点误差，不做四舍五入');
  assert.equal(year.windows[0].windowSeconds, 365 * 24 * 3600);
  assert.equal(year.windows[0].resetAt, EASTERN_NEW_PERIOD_END);
  assert.deepEqual(plain(year.credits), { used: 14, limit: 100, periodEnd: EASTERN_NEW_PERIOD_END });

  // body code 401 与登录过期等价，错误不携带正文。
  const expiredStorage = makeStorage({ 'auth.mimo': 'cookie=secret' });
  const expiredRequest = scripted(() => ({ status: 200, body: '{"code":401,"message":"cookie-secret"}' }));
  const expired = core.create({ storage: expiredStorage, request: expiredRequest });
  const error = await rejection(expired.refresh('mimo'));
  assert.equal(error.code, 'AUTH_REQUIRED');
  assert.equal(error.message, '小米账号登录已过期，请重新登录');
  assert.ok(!error.message.includes('cookie'));
  assert.equal(expiredRequest.calls.length, 1, '手动 Cookie 过期不走 Passport 恢复');
  assert.equal(expiredRequest.calls[0].cookies, false);
  assert.equal(JSON.parse(expiredStorage.data['status.mimo']).code, 'AUTH_REQUIRED');
});

const MIMO_MARKER = JSON.stringify({ type: 'webview' });
const MIMO_LOGIN_URL = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform';
const MIMO_CACHED = {
  id: 'mimo', plan: 'cached', updatedAt: 11, windows: [],
  balance: null, credits: null, booster: null, hint: null
};

test('mimo webview check succeeds without prior auth and does not copy cookies', async () => {
  const { core } = loadCore();
  const storage = makeStorage();
  const request = scripted(options => {
    assert.equal(options.cookies, true);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.redirect, undefined);
    if (options.url === MIMO_USAGE_URL) return { status: 200, body: MIMO_USAGE_BODY };
    if (options.url === MIMO_DETAIL_URL) return { status: 200, body: MIMO_DETAIL_BODY };
    throw new Error(`unexpected ${options.url}`);
  });
  const client = core.create({ storage, request, now: () => 80000 });

  const snapshot = await client.checkMimoLogin();
  assert.equal(snapshot.plan, 'mimo-pro');
  assert.equal(snapshot.updatedAt, 80);
  assert.equal(storage.data['auth.mimo'], MIMO_MARKER);
  assert.equal(JSON.parse(storage.data['usage.mimo']).windows[0].usedPercent, 25);
  assert.equal('status.mimo' in storage.data, false);
  assert.deepEqual(request.calls.map(call => call.url), [MIMO_USAGE_URL, MIMO_DETAIL_URL]);
  const row = (await client.state()).find(item => item.id === 'mimo');
  assert.equal(row.configured, true);
  assert.equal(row.status, null);
  assert.ok(!JSON.stringify(row).includes('webview'), 'state 不返回会话标记');
  assert.ok(!JSON.stringify(await client.cardConfig()).includes('webview'));

  storage.data['auth.mimo'] = 'session=legacy-cookie';
  await client.checkMimoLogin();
  assert.equal(storage.data['auth.mimo'], MIMO_MARKER);
  assert.ok(!JSON.stringify(storage.data).includes('legacy-cookie'));

  await client.clear('mimo');
  assert.deepEqual(storage.data, {}, '清理只删业务键，不调用 Cookie 接口');

  const objectStorage = makeStorage({ 'auth.mimo': { type: 'webview' } });
  const objectRequest = scripted(options => {
    assert.equal(options.cookies, true);
    assert.equal(options.headers.Cookie, undefined);
    return options.url === MIMO_USAGE_URL
      ? { status: 200, body: MIMO_USAGE_BODY }
      : { status: 500, body: '' };
  });
  const objectClient = core.create({ storage: objectStorage, request: objectRequest, now: () => 1000 });
  const degraded = await objectClient.refresh('mimo');
  assert.equal(degraded.plan, null, 'detail 失败仍降级');
  assert.equal(objectStorage.data['auth.mimo'].type, 'webview');
});

test('mimo 401 passport chain upgrades http, follows relative redirects, then rereads usage', async () => {
  const { core } = loadCore();
  const storage = makeStorage({
    'auth.mimo': MIMO_MARKER,
    'usage.mimo': JSON.stringify(MIMO_CACHED)
  });
  let usageHits = 0;
  const request = scripted(options => {
    assert.equal(options.cookies, true);
    assert.equal(options.headers.Cookie, undefined);
    assert.ok(!JSON.stringify(options).includes('api-platform_serviceToken'));
    assert.ok(!JSON.stringify(options).includes('passToken'));
    if (options.url === MIMO_USAGE_URL || options.url === MIMO_DETAIL_URL) {
      assert.equal(options.redirect, undefined);
      assert.equal(options.headers.Accept, 'application/json');
      if (options.url === MIMO_DETAIL_URL) return { status: 200, body: MIMO_DETAIL_BODY };
      usageHits += 1;
      if (usageHits === 1) {
        return {
          status: 401,
          url: options.url,
          headers: { 'set-cookie': ['ignored=1'] },
          body: JSON.stringify({ code: 401, loginUrl: MIMO_LOGIN_URL })
        };
      }
      return { status: 200, body: MIMO_USAGE_BODY };
    }
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(Object.keys(options.headers), []);
    if (options.url === MIMO_LOGIN_URL) {
      return {
        status: 302,
        headers: {
          location: ['http://platform.xiaomimimo.com/sts'],
          'set-cookie': ['passToken=account-session; HttpOnly']
        },
        body: ''
      };
    }
    if (options.url === 'https://platform.xiaomimimo.com/sts') {
      return {
        status: 302,
        url: 'https://evil.example/stolen',
        headers: {
          location: ['/console/plan-manage'],
          'set-cookie': ['api-platform_serviceToken=renewed; HttpOnly; Path=/']
        },
        body: ''
      };
    }
    if (options.url === 'https://platform.xiaomimimo.com/console/plan-manage') {
      return { status: 200, headers: { 'content-type': ['text/html'] }, body: '' };
    }
    throw new Error(`unexpected ${options.url}`);
  });
  const client = core.create({ storage, request, now: () => 90000 });
  const snapshot = await client.refresh('mimo');
  assert.equal(snapshot.plan, 'mimo-pro');
  assert.equal(snapshot.updatedAt, 90);
  assert.deepEqual(request.calls.map(call => call.url), [
    MIMO_USAGE_URL,
    MIMO_LOGIN_URL,
    'https://platform.xiaomimimo.com/sts',
    'https://platform.xiaomimimo.com/console/plan-manage',
    MIMO_USAGE_URL,
    MIMO_DETAIL_URL
  ]);
  assert.ok(request.calls.every(call => call.url.startsWith('https://')));
  assert.equal(storage.data['auth.mimo'], MIMO_MARKER);
  const dumped = JSON.stringify(storage.data);
  assert.ok(!dumped.includes('serviceLogin'));
  assert.ok(!dumped.includes('api-platform_serviceToken'));
  assert.ok(!dumped.includes('passToken'));
  assert.ok(!dumped.includes('evil.example'));
  assert.equal(JSON.parse(storage.data['usage.mimo']).updatedAt, 90);
});

test('mimo terminal passport page keeps the old cache and does not mark a new login', async () => {
  const { core } = loadCore();
  const loginUrl = 'https://account.xiaomi.com/pass/serviceLogin';
  const storage = makeStorage({
    'auth.mimo': 'session=legacy-cookie',
    'usage.mimo': JSON.stringify(MIMO_CACHED)
  });
  const request = scripted(options => {
    if (options.url === MIMO_USAGE_URL) {
      assert.equal(options.cookies, true);
      return { status: 401, body: JSON.stringify({ code: 401, loginUrl }) };
    }
    assert.equal(options.url, loginUrl);
    assert.equal(options.cookies, true);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Cookie, undefined);
    return { status: 200, body: '<html>login required</html>' };
  });
  const client = core.create({ storage, request, now: () => 5000 });
  const error = await rejection(client.checkMimoLogin());
  assert.equal(error.code, 'AUTH_REQUIRED');
  assert.equal(error.message, '小米账号会话已失效，请重新登录');
  assert.ok(!error.message.includes(loginUrl));
  assert.ok(!error.message.includes('html'));
  assert.equal(request.calls.length, 2);
  assert.equal(storage.data['auth.mimo'], 'session=legacy-cookie');
  assert.equal(JSON.parse(storage.data['usage.mimo']).updatedAt, 11);
  const status = JSON.parse(storage.data['status.mimo']);
  assert.equal(status.code, 'AUTH_REQUIRED');
  assert.equal(status.message, error.message);

  const fresh = makeStorage();
  const freshRequest = scripted(options => options.url === MIMO_USAGE_URL
    ? { status: 401, body: JSON.stringify({ code: 401, loginUrl }) }
    : { status: 200, body: '<html>login required</html>' });
  const freshClient = core.create({ storage: fresh, request: freshRequest });
  const freshError = await rejection(freshClient.checkMimoLogin());
  assert.equal(freshError.code, 'AUTH_REQUIRED');
  assert.equal(freshRequest.calls.length, 2);
  assert.deepEqual(fresh.data, {});
});

test('mimo session does not retry network failures or recurse after passport', async () => {
  const { core } = loadCore();
  const loginUrl = 'https://account.xiaomi.com/pass/serviceLogin';
  const netStorage = makeStorage({
    'auth.mimo': MIMO_MARKER,
    'usage.mimo': JSON.stringify(MIMO_CACHED)
  });
  const netRequest = scripted(() => { throw Object.assign(new Error('timeout raw'), { code: 'TIMEOUT' }); });
  const netClient = core.create({ storage: netStorage, request: netRequest });
  const netError = await rejection(netClient.refresh('mimo'));
  assert.equal(netError.code, 'ERROR');
  assert.equal(netError.message, '网络请求失败');
  assert.ok(!netError.message.includes('timeout'));
  assert.equal(netRequest.calls.length, 1);
  assert.equal(JSON.parse(netStorage.data['usage.mimo']).updatedAt, 11);
  assert.equal(JSON.parse(netStorage.data['status.mimo']).message, '网络请求失败');

  const downStorage = makeStorage({
    'auth.mimo': MIMO_MARKER,
    'usage.mimo': JSON.stringify(MIMO_CACHED)
  });
  const downRequest = scripted(options => options.url === MIMO_USAGE_URL
    ? { status: 401, body: JSON.stringify({ code: 401, loginUrl }) }
    : { status: 503, body: 'upstream secret' });
  const downClient = core.create({ storage: downStorage, request: downRequest });
  const downError = await rejection(downClient.refresh('mimo'));
  assert.equal(downError.code, 'ERROR');
  assert.equal(downError.message, '小米授权服务响应异常（503）');
  assert.ok(!downError.message.includes('secret'));
  assert.equal(downRequest.calls.length, 2);
  assert.equal(JSON.parse(downStorage.data['usage.mimo']).updatedAt, 11);
  assert.ok(!JSON.parse(downStorage.data['status.mimo']).message.includes('secret'));

  const againStorage = makeStorage({
    'auth.mimo': MIMO_MARKER,
    'usage.mimo': JSON.stringify(MIMO_CACHED)
  });
  let usageHits = 0;
  const againRequest = scripted(options => {
    if (options.url === MIMO_USAGE_URL) {
      usageHits += 1;
      return { status: 401, body: JSON.stringify({ code: 401, loginUrl }) };
    }
    if (options.url === loginUrl) {
      return { status: 302, headers: { location: ['https://platform.xiaomimimo.com/done'] }, body: '' };
    }
    if (options.url === 'https://platform.xiaomimimo.com/done') return { status: 200, body: '' };
    throw new Error(`unexpected ${options.url}`);
  });
  const againClient = core.create({ storage: againStorage, request: againRequest });
  const againError = await rejection(againClient.refresh('mimo'));
  assert.equal(againError.code, 'AUTH_REQUIRED');
  assert.equal(againError.message, '小米账号登录已过期，请重新登录');
  assert.equal(usageHits, 2);
  assert.equal(againRequest.calls.length, 4, '恢复后只再查一次用量');
});

test('mimo login url stays in the return value and rejects unsafe targets', async () => {
  const { core } = loadCore();
  const signed = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&sig=signed-secret';
  const storage = makeStorage();
  const request = scripted(options => {
    assert.equal(options.url, MIMO_USAGE_URL);
    assert.equal(options.cookies, false);
    assert.equal(options.headers.Cookie, undefined);
    return { status: 200, body: JSON.stringify({ loginUrl: signed }) };
  });
  const client = core.create({ storage, request });
  assert.equal(await client.requestMimoLoginUrl(), signed);
  assert.deepEqual(storage.data, {});
  const rows = await client.state();
  assert.equal(rows.find(row => row.id === 'mimo').configured, false);
  assert.ok(!JSON.stringify(rows).includes('signed-secret'));

  const rejected = [
    'http://account.xiaomi.com/pass/serviceLogin',
    'https://evil.example/login',
    'https://account.xiaomi.com.evil.example/login',
    'https://user:pass@account.xiaomi.com/pass/serviceLogin',
    'https://account.xiaomi.com:8443/pass/serviceLogin',
    'https://account.xiaomi.com:443/pass/serviceLogin',
    'javascript:alert(1)',
    '//account.xiaomi.com/pass'
  ];
  for (const loginUrl of rejected) {
    const box = makeStorage();
    const calls = scripted(() => ({ status: 200, body: JSON.stringify({ loginUrl, token: 'raw-body' }) }));
    const one = core.create({ storage: box, request: calls });
    const error = await rejection(one.requestMimoLoginUrl());
    assert.equal(error.message, '小米账号登录入口异常');
    assert.ok(!error.message.includes(loginUrl));
    assert.ok(!error.message.includes('raw-body'));
    assert.equal(calls.calls.length, 1);
    assert.deepEqual(box.data, {});
  }

  const missingCalls = scripted(() => ({ status: 503, body: '<html>secret-page</html>' }));
  const missing = core.create({ storage: makeStorage(), request: missingCalls });
  const missingError = await rejection(missing.requestMimoLoginUrl());
  assert.equal(missingError.message, '无法获取小米账号登录入口（503），请重试');
  assert.ok(!missingError.message.includes('secret-page'));
  assert.equal(missingCalls.calls.length, 1);

  const badCalls = scripted(() => ({
    status: 401,
    body: JSON.stringify({ code: 401, loginUrl: 'https://evil.example/phish' })
  }));
  const bad = core.create({
    storage: makeStorage({ 'auth.mimo': MIMO_MARKER, 'usage.mimo': JSON.stringify(MIMO_CACHED) }),
    request: badCalls
  });
  const badError = await rejection(bad.refresh('mimo'));
  assert.equal(badError.message, '小米账号登录入口异常');
  assert.equal(badCalls.calls.length, 1);
  assert.ok(!badError.message.includes('evil'));

  const recoverCalls = scripted(options => {
    assert.equal(options.url, MIMO_USAGE_URL);
    if (options.cookies === true) return { status: 401, body: '{"code":401}' };
    assert.equal(options.cookies, false);
    assert.equal(options.headers.Cookie, undefined);
    return { status: 200, body: JSON.stringify({ loginUrl: 'https://evil.example/from-recovery' }) };
  });
  const recover = core.create({
    storage: makeStorage({ 'auth.mimo': MIMO_MARKER }),
    request: recoverCalls
  });
  const recoverError = await rejection(recover.refresh('mimo'));
  assert.equal(recoverError.message, '小米账号登录入口异常');
  assert.equal(recoverCalls.calls.length, 2);
  assert.equal(recoverCalls.calls[0].cookies, true);
  assert.equal(recoverCalls.calls[1].cookies, false);
  assert.ok(!recoverError.message.includes('evil'));

  const safeLogin = 'https://account.xiaomi.com/pass/serviceLogin';
  const hopCalls = scripted(options => {
    if (options.url === MIMO_USAGE_URL) {
      return { status: 401, body: JSON.stringify({ code: 401, loginUrl: safeLogin }) };
    }
    if (options.url === safeLogin) {
      return { status: 302, headers: { location: ['https://evil.example/phish'] }, body: '' };
    }
    throw new Error(`should not request ${options.url}`);
  });
  const hop = core.create({ storage: makeStorage({ 'auth.mimo': MIMO_MARKER }), request: hopCalls });
  const hopError = await rejection(hop.refresh('mimo'));
  assert.equal(hopError.message, '小米授权跳转地址异常');
  assert.equal(hopCalls.calls.length, 2);
  assert.ok(!hopError.message.includes('evil'));
});

test('codex usage payload parsing matches wham classification', async () => {
  const { core } = loadCore();
  const { parsers } = core;

  const plus = parsers.parseUsagePayload(PLUS_USAGE, 1800000100);
  assert.equal(plus.planType, 'plus');
  assert.deepEqual(plain(plus.primary), { usedPercent: 23.5, windowSeconds: 18000, resetAt: 1800000100 });
  assert.deepEqual(plain(plus.secondary), { usedPercent: 4, windowSeconds: 604800, resetAt: 1800500000 });

  const weeklyOnly = parsers.parseUsagePayload(JSON.stringify({
    plan_type: 'pro',
    rate_limit: {
      primary_window: null,
      secondary_window: { used_percent: 8.25, limit_window_seconds: 604800, reset_after_seconds: 3600 }
    }
  }), 1000);
  assert.equal(weeklyOnly.primary, null);
  assert.equal(weeklyOnly.secondary.resetAt, 4600);
  const mapped = parsers.usageToProviderSnapshot(weeklyOnly);
  assert.deepEqual(plain(mapped), {
    id: 'codex',
    plan: 'pro',
    updatedAt: 1000,
    windows: [{ title: '本周限额', usedPercent: 8.25, windowSeconds: 604800, resetAt: 4600 }],
    balance: null, credits: null, booster: null,
    hint: '当前套餐无 5 小时限额'
  });

  // 调换顺序也按时长归类；缺 used_percent 或窗口时长时不伪造 0。
  const swapped = parsers.parseUsagePayload(JSON.stringify({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 9, limit_window_seconds: 604800, reset_at: 90 },
      secondary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 20 }
    }
  }), 10);
  assert.equal(swapped.primary.windowSeconds, 18000);
  assert.equal(swapped.secondary.windowSeconds, 604800);

  const missing = parsers.parseUsagePayload(JSON.stringify({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { limit_window_seconds: 18000, reset_at: 20 },
      secondary_window: { used_percent: null, limit_window_seconds: 604800 }
    }
  }), 10);
  assert.equal(missing.primary, null);
  assert.equal(missing.secondary, null);

  const minutes = parsers.parseUsagePayload(JSON.stringify({
    plan_type: 'plus',
    rate_limit: { primary_window: { used_percent: 3, window_minutes: 300, resets_at: 77 } }
  }), 10);
  assert.equal(minutes.primary.windowSeconds, 18000);
  assert.equal(minutes.primary.resetAt, 77);

  const both = parsers.usageToProviderSnapshot(plus);
  assert.deepEqual(plain(both.windows), [
    { title: '5 小时限额', usedPercent: 23.5, windowSeconds: 18000, resetAt: 1800000100 },
    { title: '本周限额', usedPercent: 4, windowSeconds: 604800, resetAt: 1800500000 }
  ]);
  assert.equal(both.hint, null);
});

test('snapshot cache round-trip, jwt account id and time parsing', async () => {
  const { core } = loadCore();
  const { parsers } = core;

  const snapshot = parsers.usageToProviderSnapshot(parsers.parseUsagePayload(PLUS_USAGE, 1800000100));
  const restored = parsers.parseCachedProviderSnapshot(JSON.stringify(snapshot));
  assert.deepEqual(plain(restored), plain(snapshot));
  assert.equal(parsers.parseCachedProviderSnapshot('not-json'), null);
  assert.equal(parsers.parseCachedProviderSnapshot('{}'), null);
  // 解析器按缓存内的 id 归属；键与 id 不一致的缓存由 state() 视为无数据。
  assert.equal(parsers.parseCachedProviderSnapshot(JSON.stringify({ ...snapshot, id: 'kimi' })).id, 'kimi');
  const mismatch = core.create({
    storage: makeStorage({ 'usage.codex': JSON.stringify({ ...snapshot, id: 'kimi' }) }),
    request: scripted(() => { throw new Error('unused'); })
  });
  const mismatchRows = await mismatch.state();
  assert.equal(mismatchRows.find(row => row.id === 'codex').snapshot, null);

  // 字符串数字归一化；缺失字段为 null 而不是 0。
  const stringy = parsers.parseCachedProviderSnapshot(JSON.stringify({
    id: 'deepseek', updatedAt: '3000',
    windows: [{ title: '套餐额度', usedPercent: '12.5', windowSeconds: '1800', resetAt: null }],
    balance: { amount: '1.5', currency: 'CNY', isAvailable: 'true' }
  }));
  assert.deepEqual(plain(stringy), {
    id: 'deepseek', plan: null, updatedAt: 3000,
    windows: [{ title: '套餐额度', usedPercent: 12.5, windowSeconds: 1800, resetAt: null }],
    balance: { amount: 1.5, currency: 'CNY', granted: null, toppedUp: null, isAvailable: true },
    credits: null, booster: null, hint: null
  });

  // JWT 解码不依赖 atob / TextDecoder / Buffer。
  assert.equal(parsers.chatgptAccountId(accountJwt('acc_123')), 'acc_123');
  assert.equal(parsers.chatgptAccountId(accountJwt('acc-9', { name: '小米账号 ünïcode' })), 'acc-9');
  assert.equal(parsers.chatgptAccountId('not-a-jwt'), null);

  assert.equal(parsers.parseIso8601EpochSeconds('2026-10-13T12:00:00Z'), epoch(2026, 9, 13, 12));
  assert.equal(parsers.parseIso8601EpochSeconds('2026-10-20T00:00z'), epoch(2026, 9, 20));
  assert.equal(parsers.parseIso8601EpochSeconds('2026-10-13T08:00:00+0800'), epoch(2026, 9, 13, 0));
  assert.equal(parsers.parseIso8601EpochSeconds('2026-11-01T00:00:00.123Z'), epoch(2026, 10, 1));
  assert.equal(parsers.parseIso8601EpochSeconds('2026-02-30T00:00:00Z'), null);

  assert.equal(parsers.parseFlexibleEpoch(1800000000000), 1800000000);
  assert.equal(parsers.parseFlexibleEpoch('2027-07-09 23:59:59'), EASTERN_NEW_PERIOD_END);
  assert.equal(parsers.parseFlexibleEpoch('2026-11-01T00:00:00Z'), epoch(2026, 10, 1));
  assert.equal(parsers.parseFlexibleEpoch(''), null);
  assert.equal(parsers.parseFlexibleEpoch('not-a-date'), null);
});

test('codex device login polls, exchanges and persists account id from jwt', async () => {
  const { core } = loadCore();
  const storage = makeStorage({ 'status.codex': JSON.stringify({ code: 'ERROR', message: '旧错误', updatedAt: 1 }) });
  let clock = 1700000000000;
  const sleeps = [];
  let tokenPolls = 0;
  const request = scripted(options => {
    if (options.url === DEVICE_CODE_URL) {
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).client_id, CODEX_CLIENT_ID);
      return { status: 200, body: '{"device_auth_id":"dev-1","user_code":"ABCD-EFGH","interval":"5"}' };
    }
    if (options.url === DEVICE_TOKEN_URL) {
      const body = JSON.parse(options.body);
      assert.equal(body.device_auth_id, 'dev-1');
      assert.equal(body.user_code, 'ABCD-EFGH');
      tokenPolls++;
      if (tokenPolls === 1) return { status: 403, body: 'pending-secret' };
      return { status: 200, body: '{"authorization_code":"auth-code","code_verifier":"verifier-1","code_challenge":"ignored"}' };
    }
    if (options.url === OAUTH_TOKEN_URL) {
      assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
      const form = Object.fromEntries(options.body.split('&').map(pair => {
        const [key, value] = pair.split('=');
        return [decodeURIComponent(key), decodeURIComponent(value.replace(/\+/g, ' '))];
      }));
      assert.equal(form.grant_type, 'authorization_code');
      assert.equal(form.client_id, CODEX_CLIENT_ID);
      assert.equal(form.code, 'auth-code');
      assert.equal(form.redirect_uri, 'https://auth.openai.com/deviceauth/callback');
      assert.equal(form.code_verifier, 'verifier-1');
      return { status: 200, body: JSON.stringify({
        id_token: accountJwt('acc-9'), access_token: 'access-1', refresh_token: 'refresh-1'
      }) };
    }
    if (options.url === CODEX_USAGE_URL) {
      assert.equal(options.headers.Authorization, 'Bearer access-1');
      assert.equal(options.headers['ChatGPT-Account-Id'], 'acc-9');
      return { status: 200, body: PLUS_USAGE };
    }
    throw new Error(`unexpected ${options.url}`);
  });
  const client = core.create({
    storage, request, now: () => clock, sleep: async ms => { sleeps.push(ms); }
  });

  const login = await client.requestDeviceCode();
  assert.deepEqual(plain(login), {
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-EFGH',
    deviceAuthId: 'dev-1',
    interval: 5,
    start: clock
  });

  const snapshot = await client.completeDeviceLogin(login);
  assert.deepEqual(sleeps, [5000]);
  assert.equal(snapshot.plan, 'plus');
  assert.equal(snapshot.updatedAt, Math.floor(clock / 1000));
  assert.deepEqual(plain(snapshot.windows), [
    { title: '5 小时限额', usedPercent: 23.5, windowSeconds: 18000, resetAt: 1800000100 },
    { title: '本周限额', usedPercent: 4, windowSeconds: 604800, resetAt: 1800500000 }
  ]);

  const stored = JSON.parse(storage.data['auth.codex']);
  assert.equal(stored.accessToken, 'access-1');
  assert.equal(stored.refreshToken, 'refresh-1');
  assert.equal(stored.accountId, 'acc-9', 'account id 来自 id_token JWT 解码');
  assert.ok('usage.codex' in storage.data);
  assert.equal('status.codex' in storage.data, false, '登录成功清除错误状态');

  const codex = (await client.state()).find(row => row.id === 'codex');
  assert.equal(codex.configured, true);
  assert.equal(codex.snapshot.plan, 'plus');

  const denied = core.create({
    storage: makeStorage(),
    request: scripted(() => ({ status: 404, body: '' }))
  });
  const error = await rejection(denied.requestDeviceCode());
  assert.equal(error.code, 'ERROR');
  assert.equal(error.message, '当前服务未开启设备码登录');
});

test('device login stops at 15 minutes and honours cancellation without persisting', async () => {
  const { core } = loadCore();

  // 超时：任何轮询之前就失败，且不回显验证码。
  let polls = 0;
  const timeoutClient = core.create({
    storage: makeStorage(),
    request: scripted(() => { polls++; return { status: 403, body: '' }; }),
    now: () => 15 * 60 * 1000
  });
  const timeoutError = await rejection(timeoutClient.completeDeviceLogin({
    verificationUrl: 'x', userCode: 'CODE', deviceAuthId: 'dev', interval: 5, start: 0
  }));
  assert.equal(timeoutError.code, 'ERROR');
  assert.ok(timeoutError.message.includes('15'));
  assert.ok(!timeoutError.message.includes('CODE'));
  assert.equal(polls, 0);

  // 取消：停止轮询、不保存令牌。
  const storage = makeStorage();
  let cancelled = false;
  let releaseSleep;
  const sleepGate = new Promise(resolve => { releaseSleep = resolve; });
  let cancelPolls = 0;
  const cancelClient = core.create({
    storage,
    request: scripted(() => { cancelPolls++; return { status: 403, body: 'secret-body' }; }),
    now: () => 0,
    sleep: () => sleepGate
  });
  const pending = cancelClient.completeDeviceLogin(
    { verificationUrl: 'x', userCode: 'CODE', deviceAuthId: 'dev', interval: 5, start: 0 },
    { isCancelled: () => cancelled }
  );
  await waitFor(() => cancelPolls === 1, 'first poll');
  cancelled = true;
  releaseSleep();
  const cancelError = await rejection(pending);
  assert.equal(cancelError.code, 'CANCELLED');
  assert.equal(cancelPolls, 1, '取消后不再轮询');
  assert.equal('auth.codex' in storage.data, false, '取消不落盘令牌');
  assert.equal('usage.codex' in storage.data, false);
});

test('codex 401 without token refresh requires settings instead of rotating', async () => {
  const { core } = loadCore();
  const oldAuth = {
    accessToken: 'old-access', refreshToken: 'old-refresh',
    idToken: accountJwt('acc-1'), accountId: 'acc-1'
  };
  const usageSnapshot = JSON.stringify({
    id: 'codex', plan: 'plus', updatedAt: 5, windows: [], balance: null, credits: null, booster: null, hint: null
  });
  const storage = makeStorage({ 'auth.codex': JSON.stringify(oldAuth), 'usage.codex': usageSnapshot });
  let oauthCalls = 0;
  const client = core.create({
    storage,
    allowTokenRefresh: false,
    request: scripted(options => {
      if (options.url === CODEX_USAGE_URL) {
        return { status: 401, body: '{"access_token":"should-not-surface"}' };
      }
      if (options.url === OAUTH_TOKEN_URL) { oauthCalls++; return { status: 200, body: '{}' }; }
      throw new Error(`unexpected ${options.url}`);
    })
  });

  const error = await rejection(client.refresh('codex'));
  assert.equal(error.code, 'AUTH_REQUIRED');
  assert.ok(error.message.includes('模块设置'));
  assert.ok(!error.message.includes('should-not-surface'));
  assert.equal(oauthCalls, 0, '背屏不轮换 refresh token');
  assert.equal(JSON.parse(storage.data['auth.codex']).refreshToken, 'old-refresh');
  assert.equal(JSON.parse(storage.data['usage.codex']).updatedAt, 5, '失败保留缓存');
  assert.equal(JSON.parse(storage.data['status.codex']).code, 'AUTH_REQUIRED');
});

test('codex rotation is single-flight and keeps rotated refresh token', async () => {
  const { core } = loadCore();
  const oldAuth = {
    accessToken: 'old-access', refreshToken: 'old-refresh',
    idToken: accountJwt('acc-1'), accountId: 'acc-1'
  };

  // 并发刷新只轮换一次。
  const storage = makeStorage({ 'auth.codex': JSON.stringify(oldAuth) });
  let rotations = 0;
  let releaseRotation;
  const rotationGate = new Promise(resolve => { releaseRotation = resolve; });
  const request = scripted(async options => {
    if (options.url === CODEX_USAGE_URL) {
      if (options.headers.Authorization === 'Bearer old-access') return { status: 401, body: '' };
      return { status: 200, body: PLUS_USAGE };
    }
    if (options.url === OAUTH_TOKEN_URL) {
      rotations++;
      assert.equal(JSON.parse(options.body).refresh_token, 'old-refresh');
      await rotationGate;
      return { status: 200, body: JSON.stringify({ access_token: 'new-access', refresh_token: 'rotated' }) };
    }
    throw new Error(`unexpected ${options.url}`);
  });
  const client = core.create({ storage, request, now: () => 2000 });
  const pending = Promise.all([client.refresh('codex'), client.refresh('codex')]);
  await waitFor(() => rotations === 1, 'rotation started');
  releaseRotation();
  const [first, second] = await pending;
  assert.equal(rotations, 1, '同一运行时只轮换一次');
  assert.equal(first.plan, 'plus');
  assert.equal(second.plan, 'plus');
  const rotated = JSON.parse(storage.data['auth.codex']);
  assert.equal(rotated.refreshToken, 'rotated');
  assert.equal(rotated.accessToken, 'new-access');

  // 只回传 refresh_token 时保留原 access token；重试仍 401 但轮换结果已保存。
  const keepStorage = makeStorage({ 'auth.codex': JSON.stringify(oldAuth) });
  const keepClient = core.create({
    storage: keepStorage,
    request: scripted(options => {
      if (options.url === CODEX_USAGE_URL) return { status: 401, body: '' };
      if (options.url === OAUTH_TOKEN_URL) {
        return { status: 200, body: JSON.stringify({ refresh_token: 'rotated-only' }) };
      }
      throw new Error(`unexpected ${options.url}`);
    })
  });
  const keepError = await rejection(keepClient.refresh('codex'));
  assert.equal(keepError.code, 'AUTH_REQUIRED');
  assert.equal(keepError.message, '登录已失效，请重新登录');
  const kept = JSON.parse(keepStorage.data['auth.codex']);
  assert.equal(kept.refreshToken, 'rotated-only');
  assert.equal(kept.accessToken, 'old-access');
});

test('oauth failures surface only safe messages', async () => {
  const { core } = loadCore();
  const oldAuth = {
    accessToken: 'old-access', refreshToken: 'old-refresh',
    idToken: accountJwt('acc-1'), accountId: 'acc-1'
  };

  const expired = core.create({
    storage: makeStorage({ 'auth.codex': JSON.stringify(oldAuth) }),
    request: scripted(options => options.url === CODEX_USAGE_URL
      ? { status: 401, body: '' }
      : { status: 401, body: '{"error":"refresh_token_expired","error_description":"secret-refresh-detail"}' })
  });
  const expiredError = await rejection(expired.refresh('codex'));
  assert.equal(expiredError.code, 'AUTH_REQUIRED');
  assert.equal(expiredError.message, '登录已失效，请重新登录');
  assert.ok(!expiredError.message.includes('secret-refresh-detail'));

  const broken = core.create({
    storage: makeStorage({ 'auth.codex': JSON.stringify(oldAuth) }),
    request: scripted(options => options.url === CODEX_USAGE_URL
      ? { status: 401, body: '' }
      : { status: 500, body: '{"error":"server_error"}' })
  });
  const brokenError = await rejection(broken.refresh('codex'));
  assert.equal(brokenError.code, 'ERROR');
  assert.equal(brokenError.message, '登录续期失败（500）');

  const noAccount = core.create({
    storage: makeStorage({
      'auth.codex': JSON.stringify({ accessToken: 'a', refreshToken: 'r', idToken: jwt({ name: 'x' }), accountId: '' })
    }),
    request: scripted(() => { throw new Error('should not be called'); })
  });
  const noAccountError = await rejection(noAccount.refresh('codex'));
  assert.equal(noAccountError.code, 'ERROR');
  assert.ok(noAccountError.message.includes('ChatGPT'));
});

test('refreshAll isolates failures and returns full state', async () => {
  const { core } = loadCore();
  const oldKimi = {
    id: 'kimi', plan: null, updatedAt: 111, windows: [], balance: null, credits: null, booster: null, hint: null
  };
  const storage = makeStorage({
    'auth.kimi': 'sk-kimi', 'usage.kimi': JSON.stringify(oldKimi),
    'auth.deepseek': 'sk-deepseek'
  });
  const request = scripted(options => {
    if (options.url === KIMI_USAGES_URL) return { status: 500, body: 'boom' };
    if (options.url === DEEPSEEK_URL) return { status: 200, body: DEEPSEEK_CNY };
    throw new Error(`unexpected ${options.url}`);
  });
  const client = core.create({ storage, request, now: () => 40000 });

  const rows = await client.refreshAll();
  assert.deepEqual(plain(rows.map(row => row.id)), ['codex', 'kimi', 'deepseek', 'mimo', 'cursor']);
  const kimi = rows.find(row => row.id === 'kimi');
  assert.equal(kimi.status.code, 'ERROR');
  assert.equal(kimi.status.message, 'Kimi Code 读取失败（500）');
  assert.equal(kimi.snapshot.updatedAt, 111, '失败来源保留旧快照');
  const deepseek = rows.find(row => row.id === 'deepseek');
  assert.equal(deepseek.status, null);
  assert.equal(deepseek.snapshot.balance.amount, 10.25);
  assert.equal(rows.find(row => row.id === 'codex').configured, false);
});

test('cardConfig produces display-only data and never leaks auth', async () => {
  const { core } = loadCore();
  const deepseekSnapshot = {
    id: 'deepseek', plan: 'api', updatedAt: 3000000100, windows: [],
    balance: { amount: 25, currency: 'CNY', granted: null, toppedUp: 6, isAvailable: true },
    credits: null, booster: null, hint: null
  };
  const storage = makeStorage({
    'auth.kimi': 'sk-kimi-secret',
    'auth.deepseek': 'sk-deepseek-secret',
    'usage.deepseek': JSON.stringify(deepseekSnapshot)
  });
  const client = core.create({ storage, request: scripted(() => { throw new Error('unused'); }) });

  const config = await client.cardConfig();
  assert.equal(config.updatedAt, 3000000100);
  assert.deepEqual(plain(config.providers.map(entry => entry.id)), ['kimi', 'deepseek'], '未配置来源不出现');
  assert.deepEqual(Object.keys(config.providers[0]), ['id', 'name', 'logoAsset', 'windows']);
  assert.deepEqual(plain(config.providers[0]), {
    id: 'kimi', name: 'Kimi Code', logoAsset: 'assets/kimi.png', windows: []
  });
  assert.deepEqual(plain(config.providers[1]), {
    id: 'deepseek', name: 'DeepSeek', plan: 'api', logoAsset: 'assets/deepseek.png',
    windows: [],
    balance: { amount: 25, currency: 'CNY', toppedUp: 6, isAvailable: true },
    updatedAt: 3000000100
  });
  assert.ok(!JSON.stringify(config).includes('secret'), 'cardConfig 不包含凭据');

  // 已配置但还没有成功用量：updatedAt 为 0，不使用当前时间。
  const empty = core.create({
    storage: makeStorage({ 'auth.kimi': 'sk-kimi' }),
    request: scripted(() => { throw new Error('unused'); }),
    now: () => 99000
  });
  const emptyConfig = await empty.cardConfig();
  assert.equal(emptyConfig.updatedAt, 0);
  assert.equal(emptyConfig.providers.length, 1);
});

const CURSOR_SUMMARY = {
  membershipType: 'enterprise', billingCycleStart: '2026-04-02T14:00:00Z', billingCycleEnd: '2026-05-02T14:00:00Z',
  individualUsage: {
    overall: { enabled: true, used: 2500, limit: 10000 },
    plan: { enabled: true, used: 2000, limit: 2000, totalPercentUsed: 100 },
    onDemand: { enabled: true, used: 500, limit: null }
  },
  teamUsage: { pooled: { used: 800000, limit: 1000000 } }
};

test('Cursor seat uses the personal cap, separates shared quota, and preserves unknown limits', () => {
  const { core } = loadCore();
  const parse = data => plain(core.parsers.parseCursorUsage(JSON.stringify(data), 123));
  const seat = parse(CURSOR_SUMMARY);
  assert.equal(seat.plan, 'enterprise');
  assert.equal(seat.windows[0].title, '个人本期额度');
  assert.equal(seat.windows[0].usedPercent, 25, '个人预算优先于套餐内的100%和团队池的80%');
  assert.equal(seat.windows[0].resetAt, epoch(2026, 4, 2, 14));
  assert.equal(seat.windows[0].windowSeconds, 30 * 86400);
  assert.deepEqual(seat.details, ['个人本期已用 $25.00 / $100.00', '个人额外消费 $5.00']);
  const shared = parse({ ...CURSOR_SUMMARY, individualUsage: { overall: { used: 2500, limit: null } } });
  assert.equal(shared.windows[0].title, '团队共享额度');
  assert.equal(shared.windows[0].usedPercent, 80);
  assert.match(shared.details[0], /个人本期已用 \$25\.00.*上限未提供/);
  const unknown = parse({ membershipType: 'team', individualUsage: { overall: { used: 0, limit: null } } });
  assert.deepEqual(unknown.windows, [], '不能把缺少个人上限显示成0%');
  assert.match(unknown.details[0], /\$0\.00.*上限未提供/);
  const pro = parse({ membershipType: 'pro', individualUsage: { plan: {
    used: 7, limit: 2000, totalPercentUsed: 0.36, autoPercentUsed: 0, apiPercentUsed: 0.5
  } } });
  assert.deepEqual(pro.windows.map(win => win.usedPercent), [0.36, 0, 0.5], '官网百分比不再乘100');
  assert.throws(() => parse({}), { code: 'ERROR' });
});

test('Cursor login checks use the profile, cache only display data, and retain success after expiry', async () => {
  const { core } = loadCore();
  const storage = makeStorage();
  let response = { status: 401, body: 'raw session secret' };
  const request = scripted(options => {
    assert.equal(options.url, 'https://cursor.com/api/usage-summary');
    assert.equal(options.cookies, true);
    assert.equal(options.headers.Cookie, undefined);
    return response;
  });
  const client = core.create({ storage, request, now: () => 123000 });
  await assert.rejects(client.checkCursorLogin(), { code: 'AUTH_REQUIRED' });
  assert.deepEqual(storage.data, {}, '失败登录不新增标记');
  response = { status: 200, body: JSON.stringify({ ...CURSOR_SUMMARY, privateField: 'raw session secret' }) };
  await client.checkCursorLogin();
  assert.deepEqual(JSON.parse(storage.data['auth.cursor']), { type: 'webview' });
  const config = plain(await client.cardConfig());
  assert.equal(config.providers[0].id, 'cursor', '只配置Cursor时默认展示');
  assert.deepEqual(config.providers[0].details, ['个人本期已用 $25.00 / $100.00', '个人额外消费 $5.00']);
  assert.ok(!JSON.stringify(storage.data).includes('raw session secret'));
  assert.ok(!JSON.stringify(config).includes('webview'));
  response = { status: 403, body: 'raw session secret' };
  await assert.rejects(client.refresh('cursor'), { code: 'AUTH_REQUIRED' });
  assert.equal((await client.state()).find(row => row.id === 'cursor').snapshot.updatedAt, 123);
  assert.ok(!JSON.stringify(storage.data).includes('raw session secret'));
  await client.clear('cursor');
  assert.deepEqual(storage.data, {});
});

test('display selection caps at four and persists hiding without clearing credentials or cached usage', async () => {
  const { core } = loadCore();
  const storage = makeStorage({
    'auth.codex': { accessToken: 'access', refreshToken: 'refresh', accountId: 'account' },
    'auth.kimi': 'kimi-key', 'auth.deepseek': 'deepseek-key', 'auth.mimo': { type: 'webview' },
    'auth.cursor': { type: 'webview' }, 'usage.kimi': { id: 'kimi', updatedAt: 1, windows: [] }
  });
  const options = { storage, request: scripted(() => { throw new Error('unused'); }) };
  const client = core.create(options);
  assert.deepEqual(plain((await client.cardConfig()).providers.map(p => p.id)), ['codex', 'kimi', 'deepseek', 'mimo']);
  await assert.rejects(client.setProviderVisible('cursor', true), /最多展示 4/);
  assert.equal(storage.data['display.providers'], undefined);
  await client.setProviderVisible('kimi', false);
  assert.equal(storage.data['auth.kimi'], 'kimi-key');
  assert.ok(storage.data['usage.kimi']);
  await client.setProviderVisible('cursor', true);
  const reloaded = core.create(options);
  assert.deepEqual(plain((await reloaded.cardConfig()).providers.map(p => p.id)), ['codex', 'deepseek', 'mimo', 'cursor']);
  assert.equal((await reloaded.state()).find(row => row.id === 'kimi').visible, false);
  for (const id of ['codex', 'deepseek', 'mimo', 'cursor']) await reloaded.setProviderVisible(id, false);
  assert.deepEqual(plain((await reloaded.cardConfig()).providers), [], '取消全部不回退到默认来源');
});

test('generation guards drop stale in-flight writes after clear or replaced secrets', async () => {
  const { core } = loadCore();

  // clear 发生在刷新途中：不写回任何键。
  const clearStorage = makeStorage({ 'auth.kimi': 'sk-old' });
  let releaseClear;
  const clearGate = new Promise(resolve => { releaseClear = resolve; });
  const clearRequest = scripted(async options => {
    assert.equal(options.headers.Authorization, 'Bearer sk-old');
    await clearGate;
    return { status: 200, body: KIMI_OFFICIAL };
  });
  const clearClient = core.create({ storage: clearStorage, request: clearRequest });
  const pendingClear = clearClient.refresh('kimi');
  await waitFor(() => clearRequest.calls.length === 1, 'kimi request in flight');
  await clearClient.clear('kimi');
  releaseClear();
  const clearError = await rejection(pendingClear);
  assert.equal(clearError.code, 'CANCELLED');
  assert.deepEqual(Object.keys(clearStorage.data), [], '清理后无残留写入');

  // saveSecret 替换凭据：旧请求的结果既不覆盖新密钥也不写入缓存。
  const replaceStorage = makeStorage({ 'auth.kimi': 'sk-old' });
  let releaseReplace;
  const replaceGate = new Promise(resolve => { releaseReplace = resolve; });
  const replaceRequest = scripted(async options => {
    assert.equal(options.headers.Authorization, 'Bearer sk-old');
    await replaceGate;
    return { status: 200, body: KIMI_OFFICIAL };
  });
  const replaceClient = core.create({ storage: replaceStorage, request: replaceRequest });
  const pendingReplace = replaceClient.refresh('kimi');
  await waitFor(() => replaceRequest.calls.length === 1, 'kimi request in flight');
  await replaceClient.saveSecret('kimi', 'sk-new');
  releaseReplace();
  const replaceError = await rejection(pendingReplace);
  assert.equal(replaceError.code, 'CANCELLED');
  assert.equal(replaceStorage.data['auth.kimi'], 'sk-new', '旧请求不覆盖新凭据');
  assert.equal('usage.kimi' in replaceStorage.data, false, '旧凭据数据不落盘');
});
