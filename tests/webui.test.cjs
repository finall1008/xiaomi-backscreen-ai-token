const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'src/webui', name), 'utf8');
const tick = (rounds = 4) => new Promise(resolve => {
  let left = rounds;
  (function step() {
    if (--left <= 0) resolve();
    else setImmediate(step);
  })();
});

/* ---------- 静态约定 ---------- */

test('index.html：首个脚本是宿主注入的 bridge-shim，随后 core.js、appearance.js、wallpapers.js、main.js', () => {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(scripts, ['bridge-shim.js', 'core.js', 'appearance.js', 'wallpapers.js', 'main.js']);
  assert.match(html, /id="wallpaper-file"[^>]*accept="image\/jpeg,image\/png,image\/webp"[^>]*\smultiple[\s>]/);
  assert.ok(html.includes('卡片外观'));
  assert.ok(html.includes('请在卡片桥内打开模块设置'));
  assert.ok(!html.includes('刷新设置'));
  assert.ok(!html.includes('refresh-minutes'));
  assert.ok(!read('main.js').includes('refreshMinutes'));
  assert.ok(!read('main.js').includes('bridge.config'));
  assert.ok(read('main.js').includes('AiUsageWallpaperSettings'));
  assert.ok(read('main.js').includes('pageKey'));
});

test('webui 不使用 localStorage / Cookie 请求头 / 远程资源', () => {
  for (const name of ['index.html', 'main.js', 'styles.css', 'wallpapers.js']) {
    const source = read(name);
    assert.ok(!source.includes('localStorage'), name + ' 不回退 localStorage');
    assert.ok(!source.includes('document.cookie'), name + ' 不读写 cookie');
    assert.ok(!/^\s*@import/m.test(source), name + ' 无远程 @import');
    assert.ok(!/url\(\s*["']?https?:/i.test(source), name + ' 无远程 url() 资源');
    assert.ok(!/<script[^>]+src="https?:/i.test(source), name + ' 无远程脚本');
    assert.ok(!/<link[^>]+href="https?:/i.test(source), name + ' 无远程样式');
  }
  const html = read('index.html');
  assert.ok(!/<img[^>]+src="https?:/i.test(html), '无远程图片');
  assert.ok(!/<a[^>]+href="https?:/i.test(html), '设置页链接由 JS 在设备码流程内按需设置');
});

test('main.js 覆盖桥缺失、预览消息、设备码与刷新联动', () => {
  const source = read('main.js');
  for (const needle of [
    'ai-usage-preview', 'AbortController', "credentials: 'omit'",
    'requestDeviceCode', 'completeDeviceLogin', 'isCancelled', 'saveSecret',
    'requestRefresh', 'allowTokenRefresh', 'WEBUI_REFRESHABLE', 'pagehide'
  ]) {
    assert.ok(source.includes(needle), '包含 ' + needle);
  }
  // MiMo 也可刷新，但携带会话的请求交给原生桥而非 fetch。
  const block = source.match(/WEBUI_REFRESHABLE = \{[^}]+\}/);
  assert.ok(block && block[0].includes('mimo'), '刷新来源包含 mimo');
  assert.ok(block && block[0].includes('cursor'), '刷新来源包含 cursor');
  assert.ok(block && block[0].includes('antigravity'), '刷新来源包含 antigravity');
  assert.ok(source.includes('requestMimoLoginUrl'));
  assert.ok(source.includes('checkMimoLogin'));
  assert.ok(source.includes('checkCursorLogin'));
  assert.ok(source.includes('requestAntigravityOAuth'));
  assert.ok(source.includes('completeAntigravityLogin'));
  assert.ok(source.includes('setAntigravityPool'));
  assert.ok(source.includes('setProviderVisible'));
  assert.ok(source.includes('https://cursor.com/dashboard/usage'));
  assert.ok(!source.includes('requestCursorLoginUrl'), 'Cursor 无签名登录入口');
  assert.ok(!source.includes('保存 Cookie'), '设置页不再要求手动复制 Cookie');
  // 取消路径只处理 CANCELLED 并结束会话，其后不追加任何保存调用。
  const cancelled = source.match(/code === 'CANCELLED'[\s\S]{0,320}/);
  assert.ok(cancelled, '存在取消分支');
  assert.ok(!cancelled[0].includes('saveSecret'), '取消分支不保存凭据');
});

/* ---------- 行为（有界 DOM 桩） ---------- */

function makeElement(id) {
  return {
    id, hidden: false, textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    className: '', href: '', style: {}, parentNode: null, listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    querySelectorAll() { return []; },
    setAttribute(name, value) { this['attr:' + name] = value; },
    removeAttribute(name) { delete this['attr:' + name]; },
    focus() {}, select() {}, setSelectionRange() {},
    contentDocument: { readyState: 'complete' },
    contentWindow: { postMessage(message) { this.messages.push(message); }, messages: [] }
  };
}

function makeEnvironment({ bridge, core }) {
  const elements = {};
  const controls = [makeElement('btn-a'), makeElement('btn-b'), makeElement('input-a')];
  const posted = [];
  const fetchCalls = [];
  const state = { fetchImpl: null, openImpl: () => ({}) };
  const document = {
    getElementById(id) { return elements[id] || (elements[id] = makeElement(id)); },
    querySelectorAll() { return controls; },
    addEventListener() {},
    activeElement: null,
    visibilityState: 'visible'
  };
  document.getElementById('preview').contentWindow.messages = posted;
  const sandbox = {
    console, setTimeout, clearTimeout, setImmediate, Date, Promise,
    AbortController, Object, Array, Math, JSON, Number, String, isFinite,
    document,
    navigator: {},
    fetch: (...args) => { fetchCalls.push(args); return state.fetchImpl(...args); },
    open: (...args) => state.openImpl(...args),
    addEventListener() {}
  };
  sandbox.window = sandbox;
  if (bridge) sandbox.bridge = bridge;
  if (core) sandbox.AiUsageCore = core;
  // 与 index.html 一致：两条横幅初始为 hidden，运行后由脚本按条件展示。
  document.getElementById('bridge-notice').hidden = true;
  document.getElementById('resource-error').hidden = true;
  for (const id of ['wallpaper-add', 'wallpaper-clear', 'wallpaper-file']) {
    controls.push(document.getElementById(id));
  }
  vm.createContext(sandbox);
  vm.runInContext(read('main.js'), sandbox, { filename: 'main.js' });
  return { elements, controls, posted, fetchCalls, state };
}

test('bridge 为 undefined：提示并禁用写入/网络，不建 client、不发请求', async () => {
  let created = 0;
  const env = makeEnvironment({
    bridge: undefined,
    core: { providers: [{ id: 'deepseek', name: 'DeepSeek', logoAsset: 'assets/deepseek.png' }], create() { created++; } }
  });
  await tick();
  assert.equal(env.elements['bridge-notice'].hidden, false, '展示桥缺失提示');
  assert.equal(created, 0, '不创建 client');
  assert.equal(env.fetchCalls.length, 0, '不发起任何网络请求');
  assert.ok(env.controls.every(control => control.disabled), '写入与网络控件全部禁用');
  assert.equal(env.elements['wallpaper-add'].disabled, true, '无桥时不能添加壁纸');
  assert.equal(env.elements['wallpaper-clear'].disabled, true, '无桥时不能清空壁纸');
  assert.equal(env.elements['wallpaper-file'].disabled, true, '无桥时文件选择不可用');
});

test('桥可用：client 接 bridge.storage、预览 postMessage、fetch 传输', async () => {
  const refreshCalls = { card: 0 };
  let createdOptions = null;
  const bridge = {
    storage: { get: async () => null, set: async () => {}, remove: async () => {} },
    card: { requestRefresh() { refreshCalls.card++; return Promise.resolve(); } },
    net: { request: async options => ({ status: 302, url: options.url, headers: { location: ['/callback'] }, body: '' }) }
  };
  const rows = [{
    id: 'deepseek', name: 'DeepSeek', logoAsset: 'assets/deepseek.png', configured: true,
    snapshot: { updatedAt: 1700000000, balance: { amount: 42, currency: 'CNY', isAvailable: true } },
    status: null
  }];
  const core = {
    providers: [{ id: 'deepseek', name: 'DeepSeek', logoAsset: 'assets/deepseek.png' }],
    create(options) {
      createdOptions = options;
      return {
        state: async () => rows,
        cardConfig: () => ({ updatedAt: 1700000000, providers: [{ id: 'deepseek' }] }),
        saveSecret: async () => {}, clear: async () => {}, refresh: async () => {},
        requestDeviceCode: async () => ({}), completeDeviceLogin: async () => ({})
      };
    }
  };
  const env = makeEnvironment({ bridge, core });
  await tick(6);

  assert.ok(createdOptions, 'client 已创建');
  assert.equal(createdOptions.storage, bridge.storage, '凭据只经 bridge.storage');
  assert.equal(createdOptions.allowTokenRefresh, true, '设置页负责 token 续期');
  assert.equal(typeof createdOptions.request, 'function');

  assert.equal(env.fetchCalls.length, 0, '读取状态与预览不发网络请求');
  const message = env.posted[0];
  assert.ok(message && message.type === 'ai-usage-preview', '向预览 iframe 发送配置');
  assert.equal(message.config.updatedAt, 1700000000);
  assert.ok(!JSON.stringify(message).includes('sk-'), '预览消息不含凭据');

  // 传输：成功返回 {status,body}，且不携带 Cookie。
  env.state.fetchImpl = async (url, init) => {
    assert.equal(init.credentials, 'omit');
    return { status: 200, text: async () => '{"ok":true}' };
  };
  const ok = await createdOptions.request({ url: 'https://example.invalid/api', method: 'GET' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, '{"ok":true}');

  const fetched = env.fetchCalls.length;
  for (const cookies of [true, false]) {
    const native = await createdOptions.request({ url: 'https://account.xiaomi.com/pass/serviceLogin', cookies, redirect: 'manual' });
    assert.equal(native.headers.location[0], '/callback', '原生响应元数据不被截掉');
  }
  assert.equal(env.fetchCalls.length, fetched, 'MiMo 的 Cookie 请求与登录入口均不走 fetch');

  // 传输：手动超时 -> 安全的 TIMEOUT 错误，不附带原始响应。
  env.state.fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  await assert.rejects(
    createdOptions.request({ url: 'https://example.invalid/slow', timeoutMs: 10 }),
    error => error.code === 'TIMEOUT' && !/aborted/.test(error.message)
  );
  assert.equal(refreshCalls.card, 0, '仅读取状态不会触发卡片刷新');
});

test('保存密钥立即查询；MiMo 开窗后检查；设备码终态失败不重复轮询', async () => {
  const calls = [];
  let stateReads = 0;
  const bridge = {
    storage: {},
    card: { requestRefresh() { calls.push('notify'); } }
  };
  const core = {
    providers: ['codex', 'deepseek', 'mimo'].map(id => ({ id, name: id })),
    create: () => ({
      state: async () => { stateReads++; return []; },
      cardConfig: async () => ({ providers: [] }),
      saveSecret: async id => { calls.push('save:' + id); },
      refresh: async id => { calls.push('refresh:' + id); },
      requestMimoLoginUrl: async () => { calls.push('mimo-url'); return 'https://account.xiaomi.com/pass/serviceLogin'; },
      checkMimoLogin: async () => { calls.push('mimo-check'); },
      clear: async id => { calls.push('clear:' + id); },
      requestDeviceCode: async () => ({ userCode: 'ABCD', verificationUrl: 'https://auth.openai.com/codex/device' }),
      completeDeviceLogin: async () => {
        calls.push('login');
        throw Object.assign(new Error('登录已失效，请重新登录'), { code: 'AUTH_REQUIRED' });
      }
    })
  };
  const env = makeEnvironment({ bridge, core });
  await tick();
  env.elements['secret-deepseek'].value = 'test-key';
  env.elements['save-deepseek'].listeners.click[0]();
  await tick();
  assert.deepEqual(calls, ['save:deepseek', 'refresh:deepseek', 'notify']);
  assert.equal(env.elements['secret-deepseek'].value, '');
  calls.length = 0;
  env.state.openImpl = (url, target) => {
    assert.equal(url, 'https://account.xiaomi.com/pass/serviceLogin');
    assert.equal(target, '_blank');
    calls.push('open');
    return {};
  };
  env.elements['login-mimo'].listeners.click[0]();
  await tick();
  assert.deepEqual(calls, ['mimo-url', 'open'], '仅打开登录窗口不视为登录成功');
  calls.length = 0;
  env.elements['check-mimo'].listeners.click[0]();
  await tick();
  assert.deepEqual(calls, ['mimo-check', 'notify']);
  calls.length = 0;
  env.elements['clear-mimo'].listeners.click[0]();
  await tick();
  assert.deepEqual(calls, ['clear:mimo', 'notify']);
  assert.match(env.elements['global-status'].textContent, /网页登录会话保留/);
  calls.length = 0;
  const readsBeforeLogin = stateReads;
  env.elements['login-codex'].listeners.click[0]();
  await tick();
  assert.deepEqual(calls, ['login', 'notify']);
  assert.ok(stateReads > readsBeforeLogin, '首次用量失败也回读已保存的授权状态');
  assert.equal(env.elements['device-codex'].hidden, true);
  assert.match(env.elements['error-codex'].textContent, /登录已失效/);
});

test('Cursor 开窗检查；背屏勾选自动保存，满 4 个时未选项禁用且已选可取消', async () => {
  const calls = [];
  const ids = ['codex', 'kimi', 'deepseek', 'mimo', 'cursor', 'antigravity', 'extra'];
  let rows = ids.map((id, index) => ({
    id,
    configured: id !== 'extra',
    visible: index < 4,
    snapshot: id === 'cursor' ? {
      plan: 'pro',
      details: ['个人消费 $1.00', '额外消费 $0.20', '接口未提供个人额度上限']
    } : null
  }));
  const bridge = {
    storage: {},
    card: { requestRefresh() { calls.push('notify'); } }
  };
  const core = {
    providers: ids.map(id => ({
      id,
      name: id,
      logoAsset: id === 'cursor' ? 'assets/cursor.png' : ''
    })),
    create: () => ({
      state: async () => rows,
      cardConfig: () => ({ providers: rows.filter(row => row.visible).map(row => ({ id: row.id })) }),
      setProviderVisible: async (id, visible) => {
        calls.push('visible:' + id + ':' + visible);
        const current = rows.find(row => row.id === id);
        const selected = rows.filter(row => row.visible).length;
        if (visible && current && !current.visible && selected >= 4) {
          throw new Error('背屏最多展示 4 个来源，请先取消一个');
        }
        rows = rows.map(row => row.id === id ? { ...row, visible } : row);
      },
      checkCursorLogin: async () => { calls.push('cursor-check'); },
      clear: async id => { calls.push('clear:' + id); },
      refresh: async () => {},
      saveSecret: async () => {},
      requestMimoLoginUrl: async () => 'https://account.xiaomi.com/pass/serviceLogin',
      checkMimoLogin: async () => {},
      requestDeviceCode: async () => ({}),
      completeDeviceLogin: async () => ({})
    })
  };
  const env = makeEnvironment({ bridge, core });
  await tick();

  assert.match(env.elements['metrics-cursor'].innerHTML, /套餐 pro/);
  assert.match(env.elements['metrics-cursor'].innerHTML, /个人消费 \$1\.00/);
  assert.match(env.elements['metrics-cursor'].innerHTML, /额外消费 \$0\.20/);
  assert.match(env.elements['metrics-cursor'].innerHTML, /接口未提供个人额度上限/);
  assert.equal(env.elements['refresh-cursor'].disabled, false, '隐藏背屏仍可刷新已配置来源');
  assert.equal(env.elements['visible-cursor'].checked, false);
  assert.equal(env.elements['visible-cursor'].disabled, true, '已满 4 个时未选项禁用');
  assert.equal(env.elements['visible-antigravity'].disabled, true, '已满 4 个时 Antigravity 不可勾选');
  assert.equal(env.elements['visible-codex'].checked, true);
  assert.equal(env.elements['visible-codex'].disabled, false, '已选项仍可取消');
  assert.equal(env.elements['visible-extra'].disabled, true, '未配置来源不可勾选');

  env.elements['visible-cursor'].checked = true;
  env.elements['visible-cursor'].listeners.change[0]();
  await tick();
  assert.deepEqual(calls, ['visible:cursor:true']);
  assert.match(env.elements['error-cursor'].textContent, /最多展示 4 个/);
  assert.equal(env.elements['visible-cursor'].checked, false, '超限保存失败后恢复未选');

  calls.length = 0;
  env.elements['visible-codex'].checked = false;
  env.elements['visible-codex'].listeners.change[0]();
  await tick();
  assert.deepEqual(calls, ['visible:codex:false', 'notify']);
  assert.equal(env.elements['visible-cursor'].disabled, false, '取消后空出名额');
  assert.equal(env.elements['visible-antigravity'].disabled, false, '取消后立即允许勾选 Antigravity');
  assert.equal(env.elements['visible-extra'].disabled, true);

  calls.length = 0;
  env.elements['visible-cursor'].checked = true;
  env.elements['visible-cursor'].listeners.change[0]();
  await tick();
  assert.deepEqual(calls, ['visible:cursor:true', 'notify']);
  assert.equal(env.elements['visible-cursor'].checked, true);
  assert.equal(env.elements['visible-cursor'].disabled, false, '已选中的来源可以再取消');
  assert.equal(env.elements['visible-codex'].disabled, true);

  calls.length = 0;
  env.state.openImpl = (url, target) => {
    assert.equal(url, 'https://cursor.com/dashboard/usage');
    assert.equal(target, '_blank');
    calls.push('open');
    return {};
  };
  env.elements['login-cursor'].listeners.click[0]();
  await tick();
  assert.deepEqual(calls, ['open'], 'Cursor 直接打开用量页，不请求签名入口');

  calls.length = 0;
  env.elements['check-cursor'].listeners.click[0]();
  await tick();
  assert.deepEqual(calls, ['cursor-check', 'notify']);

  calls.length = 0;
  env.elements['clear-cursor'].listeners.click[0]();
  await tick();
  assert.deepEqual(calls, ['clear:cursor', 'notify']);
  assert.match(env.elements['global-status'].textContent, /网页登录会话保留/);
});

test('预览首次带 display.page，之后刷新保留预览自身页且不附整图库', async () => {
  const bridge = {
    storage: {
      get: async key => key === 'display.page' ? '2' : null,
      set: async () => {},
      remove: async () => {}
    },
    card: { requestRefresh() {} }
  };
  const core = {
    providers: [{ id: 'deepseek', name: 'DeepSeek' }],
    create: () => ({
      state: async () => [],
      cardConfig: () => ({ providers: [{ id: 'deepseek' }], appearance: { images: ['not-sent'] }, pageKey: 'stale' }),
      refresh: async () => {},
      saveSecret: async () => {},
      clear: async () => {},
      setProviderVisible: async () => {},
      requestDeviceCode: async () => ({}),
      completeDeviceLogin: async () => ({}),
      requestMimoLoginUrl: async () => 'https://account.xiaomi.com/pass/serviceLogin',
      checkMimoLogin: async () => {},
      checkCursorLogin: async () => {}
    })
  };
  const env = makeEnvironment({ bridge, core });
  await tick(8);
  assert.ok(env.posted.length >= 1, '首帧预览已发出');
  assert.equal(env.posted[0].config.pageKey, '2');
  assert.equal(env.posted[0].config.wallpaper, null);
  assert.equal(env.posted[0].config.appearance, undefined, '预览不带整图库');
  assert.ok(!JSON.stringify(env.posted[0]).includes('not-sent'));
  const before = env.posted.length;
  env.elements['refresh-all'].listeners.click[0]();
  await tick(8);
  assert.ok(env.posted.length > before, '刷新后再次同步预览');
  for (let i = 1; i < env.posted.length; i++) {
    assert.equal(Object.prototype.hasOwnProperty.call(env.posted[i].config, 'pageKey'), false);
    assert.equal(env.posted[i].config.wallpaper, null);
    assert.equal(env.posted[i].config.appearance, undefined);
  }
});

test('Antigravity 授权面板、回调确认与背屏总览优先池单选切换', async () => {
  const calls = [];
  let preferredPool = 'gemini';
  let configured = false;
  const bridge = {
    storage: {},
    card: { requestRefresh() { calls.push('notify'); } }
  };
  const core = {
    providers: [{ id: 'antigravity', name: 'Antigravity', logoAsset: 'assets/antigravity.png' }],
    create: () => ({
      state: async () => [{
        id: 'antigravity',
        name: 'Antigravity',
        configured,
        visible: configured,
        preferredPool,
        snapshot: configured ? { updatedAt: 1700000000, windows: [{ title: 'Claude/GPT 5 小时', usedPercent: 60 }] } : null,
        status: null
      }],
      cardConfig: () => ({ providers: configured ? [{ id: 'antigravity' }] : [] }),
      requestAntigravityOAuth: () => ({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s1',
        state: 's1',
        codeVerifier: 'v1'
      }),
      completeAntigravityLogin: async (input, session) => {
        calls.push('complete:' + input + ':' + (session && session.state));
        configured = true;
      },
      setAntigravityPool: async pool => {
        calls.push('pool:' + pool);
        preferredPool = pool;
      },
      setProviderVisible: async () => {},
      clear: async id => { calls.push('clear:' + id); configured = false; },
      refresh: async () => {},
      saveSecret: async () => {},
      requestMimoLoginUrl: async () => 'https://account.xiaomi.com/pass/serviceLogin',
      checkMimoLogin: async () => {},
      checkCursorLogin: async () => {},
      requestDeviceCode: async () => ({}),
      completeDeviceLogin: async () => ({})
    })
  };
  const env = makeEnvironment({ bridge, core });
  await tick();

  assert.equal(env.elements['pool-gemini-antigravity'].checked, true);
  assert.equal(env.elements['pool-claude-antigravity'].checked, false);

  // 切换优先池为 Claude/GPT。
  env.elements['pool-claude-antigravity'].checked = true;
  env.elements['pool-gemini-antigravity'].checked = false;
  env.elements['pool-claude-antigravity'].listeners.change[0]();
  await tick();
  assert.deepEqual(calls, ['pool:claude', 'notify']);
  assert.equal(env.elements['pool-claude-antigravity'].checked, true);

  // 点击 Google 授权登录，展开面板并填入回调链接确认。
  calls.length = 0;
  env.elements['login-antigravity'].listeners.click[0]();
  await tick();
  assert.equal(env.elements['device-antigravity'].hidden, false);
  assert.equal(env.elements['verify-antigravity'].href, 'https://accounts.google.com/o/oauth2/v2/auth?state=s1');

  env.elements['code-antigravity'].value = 'https://antigravity.google/oauth-callback?code=4/0Axyz&state=s1';
  env.elements['submit-oauth-antigravity'].listeners.click[0]();
  await tick();
  assert.deepEqual(calls, ['complete:https://antigravity.google/oauth-callback?code=4/0Axyz&state=s1:s1', 'notify']);
  assert.equal(env.elements['code-antigravity'].value, '', '登录后清空输入凭据');
  assert.equal(env.elements['device-antigravity'].hidden, true, '登录成功后收起授权面板');
});
