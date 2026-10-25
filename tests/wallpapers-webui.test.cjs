const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const appearanceSource = read('src/shared/appearance.js');
const wallpapersSource = read('src/webui/wallpapers.js');
const mainSource = read('src/webui/main.js');

async function flush() {
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
}

function file(name, type, size = 2048) {
  return { name, type, size };
}

function makeElement(id) {
  const el = {
    id,
    hidden: false,
    disabled: false,
    textContent: '',
    className: '',
    value: '',
    src: '',
    alt: '',
    type: '',
    width: 0,
    height: 0,
    files: null,
    innerHTML: '',
    checked: false,
    style: {},
    children: [],
    listeners: {},
    attrs: {},
    parentNode: null,
    appendChild(child) {
      if (child) child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      return child;
    },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    querySelectorAll() { return []; },
    focus() {},
    select() {},
    setSelectionRange() {},
    click() { for (const fn of this.listeners.click || []) fn(); }
  };
  Object.defineProperty(el, 'firstChild', {
    get() { return this.children[0] || null; }
  });
  return el;
}

function boot(options = {}) {
  const {
    filterWorks = true,
    huge = false,
    withMain = false,
    failSnapshot = false,
    bridge = true
  } = options;
  const store = new Map([
    ['display.page', '3'],
    ['auth.deepseek', 'sk-test-secret-value']
  ]);
  const ops = [];
  const snapshots = [];
  const posted = [];
  const draws = [];
  const filters = [];
  const canvases = [];
  const readerOrder = [];
  const changes = [];
  const elements = {};
  let serial = 0;

  function decorateCanvas(canvas) {
    const ctx = {
      filterValue: 'none',
      blurred: false,
      fillStyle: '',
      imageSmoothingEnabled: false,
      fillRect() {},
      drawImage(...args) {
        draws.push({ width: canvas.width, height: canvas.height, args: args.slice() });
      }
    };
    Object.defineProperty(ctx, 'filter', {
      get() { return ctx.filterValue; },
      set(value) {
        filters.push(String(value));
        ctx.filterValue = filterWorks ? String(value) : 'none';
        if (ctx.filterValue.indexOf('blur(') === 0) ctx.blurred = true;
      }
    });
    canvas.getContext = () => ctx;
    canvas.toDataURL = () => {
      serial += 1;
      const tag = (ctx.blurred ? 'B' : 'S') + String(serial);
      const chars = huge ? (ctx.blurred ? 29000 : 182000) : 48;
      return 'data:image/jpeg;base64,' + tag + 'A'.repeat(chars);
    };
    canvases.push(canvas);
    return canvas;
  }

  function FakeImage() {
    this.naturalWidth = 1824;
    this.naturalHeight = 596;
    this.width = 1824;
    this.height = 596;
  }
  Object.defineProperty(FakeImage.prototype, 'src', {
    set(value) {
      this.currentSrc = value;
      if (typeof this.onload === 'function') this.onload();
    },
    get() { return this.currentSrc; }
  });

  function FakeReader() {}
  FakeReader.prototype.readAsDataURL = function (blob) {
    readerOrder.push('start:' + blob.name);
    const self = this;
    Promise.resolve().then(() => {
      readerOrder.push('data:' + blob.name);
      self.result = 'data:image/png;base64,AAAA';
      if (typeof self.onload === 'function') self.onload();
    });
  };

  const document = {
    getElementById(id) {
      if (!elements[id]) {
        elements[id] = makeElement(id);
        if (id === 'preview') {
          elements[id].contentDocument = { readyState: 'complete' };
          elements[id].contentWindow = {
            postMessage(message) { posted.push(message); }
          };
        }
      }
      return elements[id];
    },
    createElement(tag) {
      const el = makeElement(tag);
      if (tag === 'canvas') decorateCanvas(el);
      return el;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    activeElement: null,
    visibilityState: 'visible'
  };

  const storage = {
    async get(key) {
      ops.push('get:' + key);
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      ops.push('set:' + key);
      store.set(key, value);
    },
    async remove(key) {
      ops.push('remove:' + key);
      store.delete(key);
    }
  };
  const card = {
    async saveSnapshot(value) {
      ops.push('snapshot');
      snapshots.push(value);
      if (failSnapshot) throw new Error('offline');
    },
    requestRefresh() { ops.push('refresh'); }
  };
  const client = {
    cardConfig() {
      ops.push('cardConfig');
      return { providers: [{ id: 'deepseek' }], updatedAt: 1 };
    },
    state: async () => [],
    refresh: async () => {},
    saveSecret: async () => {},
    clear: async () => {},
    setProviderVisible: async () => {},
    requestDeviceCode: async () => ({}),
    completeDeviceLogin: async () => ({}),
    requestMimoLoginUrl: async () => 'https://account.xiaomi.com/pass/serviceLogin',
    checkMimoLogin: async () => {},
    checkCursorLogin: async () => {}
  };
  const bridgeObject = bridge ? { storage, card } : undefined;
  const sandbox = {
    console, setTimeout, clearTimeout, setImmediate, Date, Promise, Error, RegExp,
    Object, Array, Math, JSON, Number, String, isFinite,
    document,
    Image: FakeImage,
    FileReader: FakeReader,
    navigator: {},
    addEventListener() {},
    fetch() { throw new Error('wallpapers must not fetch'); }
  };
  sandbox.window = sandbox;
  if (bridgeObject) sandbox.bridge = bridgeObject;
  sandbox.AiUsageCore = {
    providers: [{ id: 'deepseek', name: 'DeepSeek' }],
    create: () => client
  };
  vm.createContext(sandbox);
  vm.runInContext(appearanceSource, sandbox, { filename: 'appearance.js' });
  vm.runInContext(wallpapersSource, sandbox, { filename: 'wallpapers.js' });
  let api = null;
  if (withMain) vm.runInContext(mainSource, sandbox, { filename: 'main.js' });
  else if (bridgeObject) {
    api = sandbox.AiUsageWallpaperSettings.mount({
      bridge: bridgeObject,
      client,
      onChange(wallpaper) { changes.push(wallpaper); }
    });
  } else {
    api = sandbox.AiUsageWallpaperSettings.mount({
      bridge: undefined,
      client,
      onChange(wallpaper) { changes.push(wallpaper); }
    });
  }
  return {
    api, ops, snapshots, posted, draws, filters, canvases, readerOrder, changes, elements, store, client
  };
}

function commitOrder(ops, { withImages }) {
  const configAt = ops.indexOf('cardConfig');
  const pageAt = ops.indexOf('get:display.page');
  const catalogAt = ops.indexOf('set:display.wallpapers');
  const snapAt = ops.indexOf('snapshot');
  const refreshAt = ops.indexOf('refresh');
  assert.ok(configAt !== -1 && configAt < pageAt, ops.join(' > '));
  assert.ok(pageAt < catalogAt, ops.join(' > '));
  assert.ok(catalogAt < snapAt, ops.join(' > '));
  assert.ok(snapAt < refreshAt, ops.join(' > '));
  assert.equal(ops.indexOf('refresh', refreshAt + 1), -1, '一次保存只通知一次刷新');
  if (withImages) {
    const imageAt = ops.findIndex(op => op.startsWith('set:wallpaper.'));
    assert.ok(imageAt !== -1 && pageAt < imageAt && imageAt < catalogAt, ops.join(' > '));
  }
}

function cropOf(draws) {
  return draws.find(draw => draw.args.length === 9);
}

function namesOf(images) {
  return Array.from(images, item => item.name);
}

test('壁纸脚本在校验通过后才保存，快照失败不刷新', () => {
  const source = wallpapersSource;
  const saveAt = source.indexOf('appearance.save');
  const snapAt = source.indexOf('saveSnapshot');
  const refreshAt = source.lastIndexOf('requestRefresh');
  assert.ok(saveAt !== -1 && saveAt < snapAt && snapAt < refreshAt);
  assert.equal(source.includes('localStorage'), false);
  assert.equal(source.includes('console.'), false);
});

test('批量按顺序解码，裁切后连同整库写入快照，坏文件不中断其余图片', async () => {
  const env = boot();
  await flush();
  assert.equal(env.elements['wallpaper-add'].disabled, false);
  assert.equal(env.elements['wallpaper-clear'].disabled, true, '空图库不能清空');
  assert.deepEqual(env.changes, [null]);

  env.ops.length = 0;
  const input = env.elements['wallpaper-file'];
  input.value = 'picked';
  input.files = [
    file('a.jpg', 'image/jpeg'),
    file('b.gif', 'image/gif'),
    file('huge.jpg', 'image/jpeg', 25 * 1024 * 1024 + 1),
    file('c.png', 'image/png'),
    file('d.webp', 'image/webp')
  ];
  input.listeners.change[0]();
  await flush();

  assert.equal(input.value, '');
  assert.deepEqual(env.readerOrder, [
    'start:a.jpg', 'data:a.jpg',
    'start:c.png', 'data:c.png',
    'start:d.webp', 'data:d.webp'
  ]);
  assert.match(env.elements['wallpaper-error'].textContent, /b\.gif/);
  assert.match(env.elements['wallpaper-error'].textContent, /huge\.jpg/);
  assert.match(env.elements['wallpaper-error'].textContent, /25MB/);
  assert.match(env.elements['wallpaper-status'].textContent, /已添加 3 张/);
  commitOrder(env.ops, { withImages: true });

  const snapshot = env.snapshots[0];
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.page, '3');
  assert.equal(snapshot.wallpaperId, undefined, '首次保存不指定轮换起点');
  assert.equal(snapshot.config.updatedAt, 1, '快照使用实际用量配置');
  assert.deepEqual(namesOf(snapshot.appearance.images), ['a.jpg', 'c.png', 'd.webp']);
  assert.equal(snapshot.appearance.images[0].width, 912);
  assert.equal(snapshot.appearance.images[0].height, 596);
  assert.ok(JSON.stringify(snapshot).length < 800 * 1024);
  assert.equal(JSON.stringify(snapshot).includes('sk-test-secret-value'), false);
  for (const item of snapshot.appearance.images) {
    assert.match(item.id, /^[A-Za-z0-9_-]{1,80}$/);
    assert.match(item.sharp, /^data:image\/jpeg;base64,/);
    assert.match(item.blur, /^data:image\/jpeg;base64,/);
  }
  const selected = env.changes.at(-1);
  assert.deepEqual(Object.keys(selected).sort(), ['blur', 'id', 'sharp']);
  assert.equal(selected.id, snapshot.appearance.images[0].id);
  assert.equal(selected.sharp, snapshot.appearance.images[0].sharp);

  const aspect = 912 / 596;
  const cropW = 596 * aspect;
  const crop = cropOf(env.draws);
  assert.ok(crop, '记录了中心裁切');
  assert.ok(Math.abs(crop.args[1] - (1824 - cropW) / 2) < 0.001);
  assert.equal(crop.args[2], 0);
  assert.ok(Math.abs(crop.args[3] - cropW) < 0.001);
  assert.equal(crop.args[4], 596);
  assert.equal(crop.args[7], 912);
  assert.equal(crop.args[8], 596);
  assert.ok(env.filters.includes('blur(16px) saturate(1.2)'));
  assert.equal(env.canvases.some(canvas => canvas.width === 91), false);

  const list = () => env.elements['wallpaper-list'];
  env.ops.length = 0;
  env.snapshots.length = 0;
  list().children[1].children[0].listeners.click[0]();
  assert.equal(list().children[1].children[0].className.includes('is-selected'), true);
  assert.equal(env.changes.at(-1).id, snapshot.appearance.images[1].id);
  assert.deepEqual(Object.keys(env.changes.at(-1)).sort(), ['blur', 'id', 'sharp']);
  assert.equal(env.ops.some(op => op.startsWith('set:') || op === 'snapshot' || op === 'refresh'), false);

  env.ops.length = 0;
  list().children[1].children[2].listeners.click[0]();
  await flush();
  commitOrder(env.ops, { withImages: true });
  assert.equal(env.ops.includes('remove:wallpaper.' + snapshot.appearance.images[1].id), true);
  assert.deepEqual(namesOf(env.snapshots.at(-1).appearance.images), ['a.jpg', 'd.webp']);
  assert.equal(env.changes.at(-1).id, snapshot.appearance.images[2].id, '删掉当前张后预览下一张');
  assert.match(env.elements['wallpaper-status'].textContent, /已删除/);

  env.ops.length = 0;
  env.elements['wallpaper-clear'].listeners.click[0]();
  await flush();
  commitOrder(env.ops, { withImages: false });
  assert.equal(env.ops.filter(op => op.startsWith('set:wallpaper.')).length, 0);
  assert.equal(env.ops.includes('remove:wallpaper.' + snapshot.appearance.images[0].id), true);
  assert.equal(env.ops.includes('remove:wallpaper.' + snapshot.appearance.images[2].id), true);
  assert.equal(env.snapshots.at(-1).appearance.images.length, 0);
  assert.equal(env.snapshots.at(-1).wallpaperId, undefined);
  assert.equal(env.changes.at(-1), null);
  assert.match(env.elements['wallpaper-status'].textContent, /已恢复默认背景/);
  assert.equal(env.elements['wallpaper-empty'].hidden, false);
  assert.equal(env.elements['wallpaper-clear'].disabled, true);
});

test('整库超过 800K 时保留原图库，不写存储、不发快照', async () => {
  const env = boot({ huge: true });
  await flush();
  env.ops.length = 0;
  const input = env.elements['wallpaper-file'];
  input.files = [1, 2, 3, 4].map(n => file('p' + n + '.jpg', 'image/jpeg'));
  input.listeners.change[0]();
  await flush();

  assert.match(env.elements['wallpaper-error'].textContent, /800K/);
  assert.match(env.elements['wallpaper-error'].textContent, /减少图片|更易压缩/);
  assert.equal(env.elements['wallpaper-status'].textContent, '');
  assert.equal(env.elements['wallpaper-list'].children.length, 0);
  assert.equal(env.ops.some(op => op.startsWith('set:') || op === 'snapshot' || op === 'refresh'), false);
  assert.equal(env.store.has('display.wallpapers'), false);
  assert.equal(env.ops[0], 'cardConfig');
  assert.ok(env.ops.indexOf('cardConfig') < env.ops.indexOf('get:display.page'));
  assert.deepEqual(env.changes, [null]);
});

test('常显快照写入失败时不调用 requestRefresh', async () => {
  const env = boot({ failSnapshot: true });
  await flush();
  env.ops.length = 0;
  const input = env.elements['wallpaper-file'];
  input.files = [file('a.jpg', 'image/jpeg')];
  input.listeners.change[0]();
  await flush();
  assert.equal(env.ops.includes('snapshot'), true);
  assert.equal(env.ops.includes('refresh'), false);
  assert.match(env.elements['wallpaper-error'].textContent, /常显快照未能写入/);
  assert.equal(env.elements['wallpaper-list'].children.length, 1);
  assert.equal(env.store.has('display.wallpapers'), true);
});

test('不支持 canvas.filter 时用缩小再放大生成模糊层', async () => {
  const env = boot({ filterWorks: false });
  await flush();
  env.ops.length = 0;
  const input = env.elements['wallpaper-file'];
  input.files = [file('a.jpg', 'image/jpeg')];
  input.listeners.change[0]();
  await flush();
  assert.equal(env.filters.includes('blur(16px) saturate(1.2)'), false);
  assert.ok(env.canvases.some(canvas => canvas.width === 91 && canvas.height === 60));
  assert.equal(env.snapshots[0].appearance.images.length, 1);
  assert.equal(env.snapshots[0].appearance.images[0].width, 912);
  commitOrder(env.ops, { withImages: true });
});

test('没有 bridge 时挂载不读不写', async () => {
  const env = boot({ bridge: false });
  await flush();
  assert.equal(env.elements['wallpaper-add'].disabled, true);
  assert.equal(env.elements['wallpaper-clear'].disabled, true);
  assert.equal(env.elements['wallpaper-file'].disabled, true);
  env.elements['wallpaper-file'].files = [file('a.jpg', 'image/jpeg')];
  env.elements['wallpaper-file'].listeners.change[0]();
  await flush();
  assert.equal(env.ops.length, 0);
  assert.equal(env.changes.length, 0);
  assert.equal(env.readerOrder.length, 0);
});

test('main 预览只收到当前一张，pageKey 只在首帧出现', async () => {
  const env = boot({ withMain: true });
  await flush();
  assert.equal(env.posted[0].type, 'ai-usage-preview');
  assert.equal(env.posted[0].config.pageKey, '3');
  assert.equal(env.posted[0].config.wallpaper, null);
  assert.equal(env.posted[0].config.appearance, undefined);

  env.ops.length = 0;
  env.snapshots.length = 0;
  const input = env.elements['wallpaper-file'];
  input.files = [file('a.jpg', 'image/jpeg'), file('c.png', 'image/png')];
  input.listeners.change[0]();
  await flush();

  commitOrder(env.ops, { withImages: true });
  const pool = env.snapshots[0].appearance.images;
  assert.deepEqual(namesOf(pool), ['a.jpg', 'c.png']);
  const last = env.posted[env.posted.length - 1].config;
  assert.equal(Object.prototype.hasOwnProperty.call(last, 'pageKey'), false);
  assert.deepEqual(Object.keys(last.wallpaper).sort(), ['blur', 'id', 'sharp']);
  assert.equal(last.wallpaper.id, pool[0].id);
  assert.equal(last.wallpaper.sharp, pool[0].sharp);
  assert.equal(last.wallpaper.blur, pool[0].blur);
  assert.equal(JSON.stringify(last).includes(pool[1].sharp), false);
  assert.equal(JSON.stringify(last).includes('sk-test-secret-value'), false);
  assert.equal(last.appearance, undefined);
});
