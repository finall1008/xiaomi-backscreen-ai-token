const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test, before } = require('node:test');
const { unzipSync } = require('fflate');
let entries;
before(async () => {
  const { buildModule } = await import('../scripts/build-module.mjs');
  const result = await buildModule();
  entries = unzipSync(fs.readFileSync(result.output));
});
const text = name => Buffer.from(entries[name]).toString('utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshot = amount => ({ id: 'deepseek', updatedAt: Math.floor(Date.now() / 1000),
  windows: [], balance: { amount, currency: 'CNY', isAvailable: true } });

function card(cached, { stale = false, failNetwork = false, respond, initialSnapshot } = {}) {
  const frames = [], texts = [], listeners = {}, handlers = {}, timers = [], saved = [];
  let recording = false, requestCount = 0, promises = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const data = { 'auth.deepseek': 'test-key-not-a-real-credential',
    'usage.deepseek': { ...cached, updatedAt: stale ? 1 : cached.updatedAt } };
  class BridgePromise extends Promise {
    constructor(executor) { super(executor); promises++; }
  }
  // 宿主注入 es6-promise，不提供 Promise.prototype.finally。
  BridgePromise.prototype.finally = undefined;
  const ctx = new Proxy({
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: value => ({ width: String(value).length * 12 }),
    fillRect() { assert.ok(recording); texts.length = 0; },
    fillText(value) { assert.ok(recording); texts.push(String(value)); }
  }, { get: (target, key) => target[key] || (() => {}) });
  const canvas = { getContext: () => ctx, addEventListener: (type, fn) => { handlers[type] = fn; },
    getBoundingClientRect: () => ({ width: 912, height: 596 }) };
  const bridge = {
    storage: { get: async key => { await gate; return data[key] ?? null; }, set: async (key, value) => { data[key] = value; },
      remove: async key => { delete data[key]; } },
    card: { readSnapshot: () => initialSnapshot || ({ schemaVersion: 1, config: { providers: [
      { ...snapshot(9), name: 'DeepSeek', logoAsset: 'assets/deepseek.png' }
    ] } }), saveSnapshot: value => saved.push(value), onRefresh: fn => { listeners.refresh = fn; } },
    net: { request: async options => {
      requestCount++;
      if (respond) return respond(options);
      return failNetwork ? { status: 401, body: '{}' } : { status: 200,
        body: JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '43' }] }) };
    } }
  };
  const sandbox = { bridge, Promise: BridgePromise, document: { getElementById: () => canvas, addEventListener() {} },
    Image: function () {}, setInterval: fn => { timers.push(fn); },
    setTimeout, clearTimeout, requestAnimationFrame: fn => frames.push(fn) };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of ['bootstrap.js', 'renderer.js', 'core.js', 'main.js']) {
    vm.runInContext(text('card/' + name), context, { filename: name });
  }
  function flush() {
    recording = true;
    try { frames.splice(0).forEach(fn => fn()); } finally { recording = false; }
  }
  function swipe(x,y,toX,toY) {
    for (const [type,cx,cy] of [['pointerdown',x,y],['pointermove',toX,toY],['pointerup',toX,toY]]) {
      handlers[type]({clientX:cx,clientY:cy,pointerId:1,isPrimary:true,preventDefault(){}});
    }
    flush();
  }
  return { data, saved, listeners, timers, texts, release, flush, swipe,
    pull: () => swipe(450,150,450,280),
    requests: () => requestCount, promises: () => promises };
}

test('ZIP contains an API v2 module, static logos and compiled classic card scripts', () => {
  const manifest = JSON.parse(text('module.json'));
  assert.equal(manifest.apiVersion, 2);
  assert.deepEqual(manifest.capabilities, ['network', 'storage']);
  assert.deepEqual(manifest.background, { intervalMinutes: 30 });
  assert.ok(text('background/main.js').includes('async function refresh()'), 'background WebView keeps native async');
  assert.ok(text('background/main.js').includes('window.AiUsageCore ='), 'background entry is self-contained');
  assert.ok(!text('background/main.js').includes('getContext('), 'background does not draw Canvas');
  const scripts = [...text('webroot/index.html').matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(scripts, ['bridge-shim.js', 'core.js', 'main.js']);
  for (const id of ['openai', 'kimi', 'deepseek', 'mimo']) {
    assert.deepEqual(Buffer.from(entries[`card/assets/${id}.png`]), fs.readFileSync(`prototype/assets/${id}.png`));
  }
  assert.ok(text('webroot/core.js').includes('async '), 'browser source stays native async');
  for (const name of ['main.js', 'core.js']) {
    assert.ok(!/\basync\s+function\b/.test(text('card/' + name)), name + ' is compiled');
  }
  assert.ok(!Object.keys(entries).some(name => /^(app|signing|node_modules)\//.test(name)));
  assert.ok(!Object.keys(entries).some(name => name.endsWith('bridge-shim.js')), 'host supplies current shim');
});

test('repository import files match the release ZIP byte for byte', () => {
  for (const [name, bytes] of Object.entries(entries)) {
    assert.deepEqual(fs.readFileSync(name), Buffer.from(bytes), name);
  }
  for (const html of ['card/index.html', 'webroot/index.html', 'webroot/preview.html']) {
    const base = html.slice(0, html.lastIndexOf('/') + 1);
    for (const match of text(html).matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (match[1] === 'bridge-shim.js') continue; // 宿主提供
      assert.ok(entries[base + match[1]], html + ' references ' + match[1]);
    }
  }
});

test('compiled card draws synchronous AOD snapshot before bridge responses, then shares WebUI cache changes', async () => {
  const runtime = card(snapshot(42));
  runtime.flush();
  assert.ok(runtime.texts.includes('¥9.00'), 'first frame comes from synchronous snapshot');
  assert.equal(runtime.saved.length, 0);
  runtime.release(); await tick(); runtime.flush();
  assert.ok(runtime.texts.includes('¥42.00'));
  assert.equal(runtime.requests(), 0, 'fresh cache is not re-fetched');
  assert.ok(runtime.promises() > 0, 'compiled async uses injected global Promise');
  assert.equal(runtime.saved.at(-1).config.providers[0].balance.amount, 42);
  assert.ok(!JSON.stringify(runtime.saved).includes('test-key'));
  runtime.data['usage.deepseek'] = snapshot(50);
  runtime.listeners.refresh(); await tick(); runtime.flush();
  assert.ok(runtime.texts.includes('¥50.00'));
  assert.equal(runtime.requests(), 0, 'WebUI refresh event only rereads already updated cache');
  delete runtime.data['auth.deepseek']; delete runtime.data['usage.deepseek'];
  runtime.listeners.refresh(); await tick(); runtime.flush();
  assert.ok(runtime.texts.includes('尚未设置用量来源'));
  assert.equal(runtime.saved.at(-1).config.providers.length, 0);
});

test('manual pull fetches even fresh usage and saves only display data', async () => {
  const runtime = card(snapshot(42));
  runtime.release(); await tick(); runtime.flush();
  assert.equal(runtime.requests(), 0);
  runtime.pull(); await tick(); runtime.flush();
  assert.equal(runtime.requests(), 1);
  assert.ok(runtime.texts.includes('¥43.00'));
  assert.equal(runtime.saved.at(-1).config.providers[0].balance.amount, 43);
});

test('compiled card refreshes MiMo through the shared WebView profile without exporting its session', async () => {
  const runtime = card(snapshot(42), { respond: options => {
    assert.equal(options.cookies, true);
    assert.equal(options.headers.Cookie, undefined);
    if (options.url.endsWith('/usage')) return { status: 200, body: JSON.stringify({ code: 0,
      data: { usage: { percent: 0.25, items: [] } } }) };
    return { status: 200, body: JSON.stringify({ code: 0, data: { planName: 'MiMo-Pro', planCode: 'pro:month' } }) };
  } });
  delete runtime.data['auth.deepseek'];
  delete runtime.data['usage.deepseek'];
  runtime.data['auth.mimo'] = JSON.stringify({ type: 'webview' });
  runtime.release(); await tick(); runtime.flush();
  assert.equal(runtime.requests(), 0);
  runtime.pull(); await tick(); runtime.flush();
  assert.equal(runtime.requests(), 2, 'usage and detail use native cookie-aware requests');
  assert.ok(runtime.texts.includes('本月额度'));
  const config = runtime.saved.at(-1).config;
  assert.equal(config.providers[0].id, 'mimo');
  assert.equal(config.providers[0].windows[0].usedPercent, 25);
  assert.ok(!JSON.stringify(config).includes('webview'), 'session marker stays out of AOD display data');
});

test('background saves successful usage and cached failures, awaits the shared snapshot, and feeds the card first frame', async () => {
  const data = {
    'auth.deepseek': 'test-key',
    'auth.codex': JSON.stringify({ accessToken: 'test-access', refreshToken: 'test-refresh', idToken: '', accountId: 'test-account' }),
    'usage.codex': { id: 'codex', updatedAt: 1, windows: [{ title: '本周限额', usedPercent: 12, windowSeconds: 604800 }] }
  };
  let saved, confirmSave, completed = false, requests = 0;
  const gate = new Promise(resolve => { confirmSave = resolve; });
  const context = vm.createContext({
    bridge: {
      storage: { get: async key => data[key] ?? null, set: async (key, value) => { data[key] = value; }, remove: async key => { delete data[key]; } },
      net: { request: async options => {
        requests++;
        assert.ok(!options.url.includes('/oauth/'), 'background does not race settings token rotation');
        if (options.url.includes('chatgpt.com')) return { status: 401, body: '{}' };
        return { status: 200, body: JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '99' }] }) };
      } },
      card: { saveSnapshot: async value => { saved = value; await gate; } }
    }
  });
  context.window = context;
  vm.runInContext(text('background/main.js'), context);
  const completion = assert.rejects(context.refresh(), /部分来源后台刷新失败/).then(() => { completed = true; });
  await tick();
  assert.equal(requests, 2);
  assert.ok(saved, 'other providers finish despite one auth failure');
  assert.equal(completed, false, 'refresh waits for native snapshot save confirmation');
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.config.providers.find(row => row.id === 'deepseek').balance.amount, 99);
  assert.equal(saved.config.providers.find(row => row.id === 'codex').windows[0].usedPercent, 12);
  assert.ok(!/test-key|test-access|test-refresh|auth\./.test(JSON.stringify(saved)));
  confirmSave(); await completion;
  const runtime = card(snapshot(42), { initialSnapshot: saved });
  runtime.flush();
  assert.ok(runtime.texts.includes('¥99.00'), 'AOD first frame uses background snapshot before any bridge response');
  // Resolve the fake card bridge so no asynchronous test work is left waiting.
  runtime.release(); await tick(); runtime.flush();
});

test('each host background invocation fetches configured sources even with fresh cache', async () => {
  let requests = 0, saved;
  const data = { 'auth.deepseek': 'test-key', 'usage.deepseek': snapshot(7) };
  const context = vm.createContext({ bridge: {
    storage: { get: async key => data[key] ?? null, set: async (key,value) => { data[key]=value; },
      remove: async key => { delete data[key]; } },
    net: { request: async () => { requests++; return {status:200,body:JSON.stringify({is_available:true,
      balance_infos:[{currency:'CNY',total_balance:'8'}]})}; } },
    card: { saveSnapshot: async value => { saved = value; } }
  } });
  context.window = context;
  vm.runInContext(text('background/main.js'), context);
  await context.refresh();
  await context.refresh();
  assert.equal(requests, 2);
  assert.equal(saved.config.providers[0].balance.amount, 8);
});

test('stale cache is not auto-fetched; failed pull retains it and allows another manual attempt', async () => {
  const runtime = card(snapshot(42), { stale: true, failNetwork: true });
  runtime.release(); await tick(); runtime.flush();
  assert.equal(runtime.requests(), 0);
  assert.equal(runtime.timers.length, 0);
  runtime.pull(); await tick(); runtime.flush();
  assert.equal(runtime.requests(), 1);
  assert.ok(runtime.texts.includes('¥42.00'));
  assert.ok(runtime.texts.includes('刷新失败，请重试'));
  runtime.listeners.refresh(); await tick(); runtime.flush();
  assert.equal(runtime.requests(), 1, 'cache notification never fetches');
  runtime.pull(); await tick(); runtime.flush();
  assert.equal(runtime.requests(), 2);
});

test('compiled home pull refreshes all configured providers while detail pull refreshes only its source', async () => {
  const urls = [];
  const runtime = card(snapshot(42), { initialSnapshot: {schemaVersion:1,config:{providers:[]}}, respond: options => {
    urls.push(options.url);
    return options.url.includes('deepseek')
      ? {status:200,body:JSON.stringify({is_available:true,balance_infos:[{currency:'CNY',total_balance:'43'}]})}
      : {status:200,body:JSON.stringify({rate_limit:{primary_window:{used_percent:12,limit_window_seconds:18000}}})};
  } });
  runtime.data['auth.codex'] = JSON.stringify({accessToken:'test-access',refreshToken:'test-refresh',accountId:'test-account'});
  runtime.data['usage.codex'] = {id:'codex',updatedAt:1,windows:[{title:'5 小时限额',usedPercent:10,windowSeconds:18000}]};
  runtime.release(); await tick(); runtime.flush();
  assert.ok(runtime.texts.includes('AI 用量'));
  runtime.pull(); await tick(); runtime.flush();
  assert.equal(urls.length,2);
  assert.ok(urls.some(url=>url.includes('chatgpt.com')));
  assert.ok(urls.some(url=>url.includes('deepseek.com')));
  runtime.swipe(800,200,650,200); // home -> Codex
  runtime.pull(); await tick(); runtime.flush();
  assert.equal(urls.length,3);
  assert.ok(urls.at(-1).includes('chatgpt.com'));
});
