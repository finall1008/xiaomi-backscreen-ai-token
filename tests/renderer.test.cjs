const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'prototype/main.js'), 'utf8');

function win(title, seconds, usedPercent = 12) {
  return { title, usedPercent, windowSeconds: seconds, resetAt: 2000000000 };
}

function providers() {
  return [
    { id: 'codex', name: 'Codex', windows: [win('5 小时限额', 18000), win('本周限额', 604800)] },
    { id: 'kimi', name: 'Kimi Code', windows: [win('5 小时窗口', 18000), win('本周额度', 604800), win('本月额度', 2592000)] },
    { id: 'deepseek', name: 'DeepSeek', balance: { amount: 25, currency: 'CNY', isAvailable: true } },
  ];
}

function createCard(config, frameOnly = true) {
  const handlers = {};
  const frames = [];
  const images = [];
  let recording = false;
  let text = [];
  let transforms = [];
  let drawn = [];
  let arcs = [];
  let now = 1700000000000;
  function requireRecording() {
    if (frameOnly) assert.ok(recording, 'draw outside a recorded frame');
  }
  function flushFrame() {
    const pending = frames.splice(0);
    recording = true;
    try { pending.forEach(fn => fn(100)); } finally { recording = false; }
  }
  const ctx = new Proxy({
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: value => ({ width: String(value).length * 12 }),
    fillRect() {
      requireRecording();
      text = [];
      transforms = [];
      drawn = [];
      arcs = [];
    },
    arcTo(...values) { requireRecording(); arcs.push(values); },
    fillText(value, x, y) { requireRecording(); text.push({ value: String(value), x, y }); },
    translate(x, y) { requireRecording(); transforms.push([x, y]); },
    drawImage(img) { requireRecording(); drawn.push(img && img.src); },
  }, { get: (target, key) => target[key] ?? requireRecording });
  const cv = {
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 912, height: 596 }),
    addEventListener: (type, fn) => { handlers[type] = fn; },
    setPointerCapture() {},
  };
  function Image() {
    this.onload = null;
    this.onerror = null;
    this.src = '';
    images.push(this);
  }
  const RealDate = Date;
  function ClockDate(...args) {
    if (args.length === 0) return new RealDate(now);
    return new RealDate(...args);
  }
  ClockDate.now = () => now;
  ClockDate.parse = RealDate.parse;
  ClockDate.UTC = RealDate.UTC;
  ClockDate.prototype = RealDate.prototype;
  const sandbox = {
    window: {
      CARD_CONFIG: config || { providers: providers() },
      requestAnimationFrame: frameOnly ? (fn => { frames.push(fn); return frames.length; }) : undefined,
    },
    document: { getElementById: () => cv, addEventListener() {} },
    Image,
    Date: ClockDate,
  };
  if (!frameOnly) delete sandbox.window.requestAnimationFrame;
  vm.runInNewContext(source, sandbox);
  if (frameOnly) flushFrame();
  const card = sandbox.window.AiUsageCard;
  function event(type, x, y, flush = true) {
    handlers[type]({ clientX: x, clientY: y, pointerId: 1, isPrimary: true, preventDefault() {} });
    if (flush) flushFrame();
  }
  function settle() {
    now += 500;
    if (frames.length) flushFrame();
  }
  return {
    card, handlers, images, event, settle, flushFrame,
    advance(ms) { now += ms; },
    pending: () => frames.length,
    text: () => text,
    transforms: () => transforms,
    drawn: () => drawn,
    arcs: () => arcs,
    has: value => text.some(entry => entry.value === value),
    pagesChanges: [],
  };
}

test('headers share the top-corner safe edge and minimal services use evenly spaced columns', () => {
  const rows = ['codex', 'kimi', 'mimo', 'cursor'].map(id => ({
    id, name: id, windows: [win('用量', 18000)]
  }));
  const view = createCard({ providers: rows, wallpaper: { id: 'test', sharp: 'data:image/jpeg;base64,AAAA' } });
  view.images[0].onload();
  view.flushFrame();
  for (const page of ['overview', 'provider:kimi', 'minimal']) {
    view.card.restorePage(page);
    view.flushFrame();
    const top = page === 'minimal' ? 16 : 20;
    assert.equal(view.arcs()[0][0], 838, page + ' stops before the physical rounded corner');
    // Native rear display: 912×596, top-right corner radius 106 (center 806,106).
    assert.ok(Math.pow(838 - 806, 2) + Math.pow(top - 106, 2) < 106 * 106);
    assert.equal(view.arcs()[0][1], top);
    assert.equal(view.arcs()[3][0], 336, page + ' left edge matches panels');
  }
  const labels = view.text().filter(entry => entry.value === '12%');
  assert.equal(labels.length, 4);
  for (let i = 1; i < labels.length; i++) assert.equal(labels[i].x - labels[i - 1].x, 114.5);
});

function listen(view) {
  const changes = [];
  view.card.onPageChange(key => changes.push(key));
  return changes;
}

test('time jump completes a page slide in one frame and frozen time does not', () => {
  const view = createCard();
  const changes = listen(view);
  assert.equal(view.card.getState().pageKey, 'overview');
  assert.equal(view.pending(), 0);
  view.event('pointerdown', 450, 200, false);
  view.event('pointerup', 450, 200, false);
  assert.deepEqual(changes, ['provider:codex']);
  assert.equal(view.pending(), 1);
  for (let i = 0; i < 8; i++) {
    view.flushFrame();
    assert.ok(view.has('AI 用量'));
    assert.ok(!view.has('本周限额'));
    assert.equal(view.pending(), 1);
  }
  view.advance(360);
  view.flushFrame();
  assert.ok(view.has('本周限额'));
  assert.ok(!view.has('AI 用量'));
  assert.equal(view.card.getState().pageKey, 'provider:codex');
  assert.equal(view.pending(), 0);
});

test('short swipe and edge drag rebound without changing page', () => {
  const view = createCard();
  const changes = listen(view);
  view.event('pointerdown', 500, 300, false);
  view.event('pointermove', 460, 300);
  assert.ok(view.transforms().some(([x]) => x < -20));
  view.event('pointerup', 460, 300, false);
  assert.deepEqual(changes, []);
  view.settle();
  assert.equal(view.card.getState().pageKey, 'overview');
  assert.ok(view.has('AI 用量'));
  assert.ok(!view.has('本周限额'));
  assert.ok(view.transforms().every(([x, y]) => Math.abs(x) < 1 && Math.abs(y) < 1));
  assert.equal(view.pending(), 0);

  view.card.restorePage('minimal');
  view.flushFrame();
  assert.deepEqual(changes, []);
  view.event('pointerdown', 400, 200, false);
  view.event('pointermove', 540, 200);
  assert.ok(view.transforms().some(([x]) => x > 10));
  view.event('pointerup', 540, 200, false);
  view.settle();
  assert.equal(view.card.getState().pageKey, 'minimal');
  assert.deepEqual(changes, []);
  assert.equal(view.pending(), 0);
});

test('continued swipe starts from the current position', () => {
  const view = createCard();
  view.event('pointerdown', 450, 200, false);
  view.event('pointerup', 450, 200, false);
  view.event('pointerdown', 800, 240, false);
  view.event('pointermove', 650, 240);
  view.event('pointerup', 650, 240, false);
  view.flushFrame();
  assert.ok(view.has('AI 用量'));
  assert.ok(view.has('本周限额'));
  assert.ok(!view.has('本周额度'));
  view.advance(360);
  view.flushFrame();
  assert.equal(view.card.getState().pageKey, 'provider:kimi');
  assert.ok(view.has('本周额度'));
  assert.ok(!view.has('AI 用量'));
  assert.equal(view.pending(), 0);
});

test('minimal page refreshes globally and keeps the service row tappable', () => {
  const view = createCard();
  const calls = [];
  let finish;
  view.card.onRefresh(id => {
    calls.push(id);
    return new Promise(resolve => { finish = resolve; });
  });
  view.card.restorePage('minimal');
  view.flushFrame();
  assert.equal(view.card.getState().pageKey, 'minimal');
  assert.equal(view.card.getState().scrollY, 0);
  assert.ok(view.has('12%'));
  assert.ok(view.has('—'));
  assert.ok(!view.has('AI 用量'));
  assert.ok(!view.has('总览'));
  assert.ok(!view.has('¥25.00'));
  assert.ok(!view.has('账户余额'));
  view.event('pointerdown', 376, 47);
  view.event('pointermove', 376, 170);
  view.handlers.pointercancel({});
  view.event('pointerup', 376, 170);
  assert.deepEqual(calls, []);
  view.event('pointerdown', 376, 40);
  view.event('pointermove', 376, 180);
  view.event('pointerup', 376, 180);
  return Promise.resolve().then(() => {
    assert.deepEqual(calls, [null]);
    view.flushFrame();
    assert.ok(!view.has('刷新中…'));
    assert.ok(!view.has('下拉刷新'));
    assert.equal(view.pending(), 1);
    finish();
    return new Promise(resolve => setImmediate(resolve));
  }).then(() => {
    view.settle();
    assert.equal(view.pending(), 0);
    assert.ok(!view.has('刷新中…'));
    const changes = listen(view);
    const kimiLabel = view.text().filter(entry => entry.value === '12%')[1];
    view.event('pointerdown', kimiLabel.x, kimiLabel.y, false);
    view.event('pointerup', kimiLabel.x, kimiLabel.y, false);
    view.settle();
    assert.deepEqual(changes, ['provider:kimi']);
    assert.equal(view.card.getState().pageKey, 'provider:kimi');
    view.card.onRefresh(id => { calls.push(id); return Promise.resolve(); });
    view.event('pointerdown', 600, 120);
    view.event('pointermove', 600, 40);
    view.event('pointerup', 600, 40);
    const scrolled = view.card.getState().scrollY;
    assert.ok(scrolled > 0);
    view.event('pointerdown', 600, 120);
    view.event('pointermove', 600, 260);
    view.event('pointerup', 600, 260);
    return Promise.resolve().then(() => {
      assert.equal(calls.at(-1), null);
      assert.equal(view.card.getState().scrollY, 0);
    });
  });
});

test('detail refresh is scoped and a scrolled detail does not refresh', () => {
  const view = createCard();
  const calls = [];
  view.card.onRefresh(id => { calls.push(id); return Promise.resolve(); });
  view.card.restorePage('provider:codex');
  view.flushFrame();
  view.event('pointerdown', 600, 160);
  view.event('pointermove', 600, 80);
  view.event('pointerup', 600, 80);
  return Promise.resolve().then(() => {
    assert.deepEqual(calls, []);
    view.event('pointerdown', 600, 160);
    view.event('pointermove', 600, 260);
    view.event('pointerup', 600, 260);
    return Promise.resolve();
  }).then(() => {
    assert.deepEqual(calls, ['codex']);
    view.settle();
    view.card.restorePage('provider:kimi');
    view.flushFrame();
    view.event('pointerdown', 700, 480);
    view.event('pointermove', 700, 200);
    view.event('pointerup', 700, 200);
    const y = view.card.getState().scrollY;
    assert.ok(y > 0);
    view.event('pointerdown', 700, 200);
    view.event('pointermove', 700, 360);
    view.event('pointerup', 700, 360);
    return Promise.resolve().then(() => {
      assert.deepEqual(calls, ['codex']);
      assert.ok(view.card.getState().scrollY < y);
    });
  });
});

test('stable page keys survive provider updates and ignore invalid restores', () => {
  const view = createCard();
  const changes = listen(view);
  view.card.restorePage('provider:kimi');
  view.flushFrame();
  view.event('pointerdown', 700, 480);
  view.event('pointermove', 700, 200);
  view.event('pointerup', 700, 200);
  const scrollY = view.card.getState().scrollY;
  assert.ok(scrollY > 0);
  view.card.update({
    providers: [
      { id: 'kimi', name: 'Kimi Code', windows: [win('5 小时窗口', 18000, 40), win('本周额度', 604800, 40), win('本月额度', 2592000, 40)] },
      providers()[2],
      providers()[0],
    ],
  });
  view.flushFrame();
  assert.equal(view.card.getState().pageKey, 'provider:kimi');
  assert.equal(view.card.getState().scrollY, scrollY);
  assert.ok(view.has('本周额度'));
  assert.ok(view.has('40'));
  assert.ok(!view.has('AI 用量'));
  assert.deepEqual(changes, []);
  view.card.update({ providers: [providers()[0]] });
  view.flushFrame();
  assert.equal(view.card.getState().pageKey, 'provider:codex');
  assert.deepEqual(changes, []);
  view.card.restorePage('missing');
  view.flushFrame();
  assert.equal(view.card.getState().pageKey, 'provider:codex');
  assert.deepEqual(changes, []);
  view.card.update({ providers: providers(), pageKey: 'minimal' });
  view.flushFrame();
  assert.equal(view.card.getState().pageKey, 'minimal');
  assert.deepEqual(changes, []);
  view.card.update({ providers: providers() });
  view.flushFrame();
  assert.equal(view.card.getState().pageKey, 'minimal');
});

test('initial page and wallpaper are applied before the first frame', () => {
  const jpeg = id => ({ id, sharp: 'data:image/jpeg;base64,' + id + 'sharp', blur: 'data:image/jpeg;base64,' + id + 'blur' });
  const view = createCard({ providers: providers(), pageKey: 'provider:deepseek', wallpaper: jpeg('a') }, true);
  assert.equal(view.images.length, 2);
  assert.equal(view.card.getState().pageKey, 'provider:deepseek');
  assert.ok(view.has('账户余额'));
  const invalid = createCard({ providers: providers(), pageKey: 'nope' });
  assert.equal(invalid.card.getState().pageKey, 'overview');
  assert.ok(invalid.has('AI 用量'));
  const single = createCard({ providers: [providers()[1]] });
  assert.equal(single.card.getState().pageKey, 'provider:kimi');
  assert.ok(single.has('5 小时窗口'));

  const fresh = createCard({ providers: providers(), pageKey: 'overview', wallpaper: jpeg('a') });
  const changes = listen(fresh);
  assert.equal(fresh.images.length, 2);
  fresh.card.setWallpaper(jpeg('a'));
  assert.equal(fresh.images.length, 2);
  const previousLoad = fresh.images[0].onload;
  fresh.card.setWallpaper(jpeg('b'));
  assert.equal(fresh.images.length, 4);
  previousLoad();
  fresh.flushFrame();
  assert.ok(!fresh.drawn().includes(jpeg('a').sharp));
  fresh.images[2].onload();
  fresh.flushFrame();
  assert.ok(fresh.drawn().includes(jpeg('b').sharp));
  assert.equal(fresh.card.getState().pageKey, 'overview');
  assert.deepEqual(changes, []);
  const seen = fresh.images.length;
  fresh.card.update({ providers: providers() });
  fresh.flushFrame();
  assert.equal(fresh.images.length, seen);
  assert.ok(fresh.drawn().includes(jpeg('b').sharp));
  fresh.card.update({ providers: providers(), wallpaper: null });
  fresh.flushFrame();
  assert.ok(!fresh.drawn().includes(jpeg('b').sharp));
  assert.equal(fresh.card.getState().pageKey, 'overview');
});

test('pull release rebounds in one timed frame and refresh keeps a temporary frame loop', () => {
  const view = createCard();
  view.card.onRefresh(() => Promise.resolve());
  view.event('pointerdown', 450, 150, false);
  view.event('pointermove', 450, 200);
  view.event('pointerup', 450, 200, false);
  view.flushFrame();
  assert.ok(view.transforms().some(([, y]) => y > 5));
  assert.equal(view.pending(), 1);
  view.advance(200);
  view.flushFrame();
  assert.ok(view.transforms().every(([, y]) => Math.abs(y) < 1));
  assert.equal(view.pending(), 0);

  let finish;
  view.card.onRefresh(() => new Promise(resolve => { finish = resolve; }));
  view.event('pointerdown', 450, 150);
  view.event('pointermove', 450, 280);
  view.event('pointerup', 450, 280);
  return Promise.resolve().then(() => {
    view.flushFrame();
    assert.ok(view.has('刷新中…'));
    assert.equal(view.pending(), 1);
    view.flushFrame();
    assert.equal(view.pending(), 1);
    finish();
    return new Promise(resolve => setImmediate(resolve));
  }).then(() => {
    view.settle();
    assert.ok(!view.has('刷新中…'));
    assert.equal(view.pending(), 0);
  });
});

test('cancel does not turn a drag into a page change or refresh', () => {
  const view = createCard();
  const changes = listen(view);
  const calls = [];
  view.card.onRefresh(id => { calls.push(id); return Promise.resolve(); });
  view.event('pointerdown', 700, 300, false);
  view.event('pointermove', 500, 300);
  view.handlers.pointercancel({});
  view.event('pointerup', 500, 300);
  view.settle();
  assert.equal(view.card.getState().pageKey, 'overview');
  assert.deepEqual(changes, []);
  view.event('pointerdown', 450, 120);
  view.event('pointermove', 450, 280);
  view.handlers.pointercancel({});
  view.event('pointerup', 450, 280);
  return Promise.resolve().then(() => {
    assert.deepEqual(calls, []);
    assert.equal(view.card.getState().pageKey, 'overview');
  });
});

test('an in-flight refresh survives a data update on the same page', () => {
  const view = createCard();
  const changes = listen(view);
  let finish;
  view.card.onRefresh(() => new Promise(resolve => { finish = resolve; }));
  view.event('pointerdown', 450, 150);
  view.event('pointermove', 450, 280);
  view.event('pointerup', 450, 280);
  return Promise.resolve().then(() => {
    view.settle();
    assert.ok(view.has('刷新中…'));
    const next = providers();
    next[0] = { id: 'codex', name: 'Codex', windows: [win('5 小时限额', 18000, 61), win('本周限额', 604800, 61)] };
    let published = false;
    view.card.update({ providers: next }, () => { published = true; });
    assert.equal(published, false);
    view.flushFrame();
    assert.equal(published, true);
    assert.equal(view.card.getState().pageKey, 'overview');
    assert.ok(view.has('刷新中…'));
    assert.ok(view.has('61'));
    assert.deepEqual(changes, []);
    assert.equal(view.pending(), 1);
    finish();
    return new Promise(resolve => setImmediate(resolve));
  }).then(() => {
    view.settle();
    assert.equal(view.pending(), 0);
    assert.ok(!view.has('刷新中…'));
    assert.ok(view.has('61'));
  });
});
