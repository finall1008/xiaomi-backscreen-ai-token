const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function api() {
  const sandbox = { window: {}, Date };
  vm.runInNewContext(fs.readFileSync('src/shared/appearance.js', 'utf8'), sandbox);
  return sandbox.window.AiUsageAppearance;
}
const plain = value => JSON.parse(JSON.stringify(value));
const picture = id => ({ id, name: id + '.jpg', sharp: 'data:image/jpeg;base64,AA==',
  blur: 'data:image/jpeg;base64,AQ==', width: 912, height: 596 });

test('AOD rotation consumes only synchronous snapshot data and preserves the page', () => {
  const appearance = api();
  let snapshot = appearance.buildSnapshot({ providers: [] }, { page: 'minimal' },
    { revision: 1, images: [picture('one'), picture('two'), picture('three')] });
  const shown = [];
  for (let i = 0; i < 5; i++) {
    const result = appearance.advance(snapshot);
    shown.push(result.wallpaper.id);
    snapshot = result.snapshot;
    assert.equal(snapshot.page, 'minimal');
  }
  assert.deepEqual(shown, ['one', 'two', 'three', 'one', 'two']);
  const updated = appearance.buildSnapshot({ providers: [{ id: 'codex' }] }, snapshot);
  assert.equal(updated.wallpaperId, 'two');
  assert.equal(updated.page, 'minimal');
  assert.deepEqual(plain(updated.appearance), plain(snapshot.appearance));
});

test('single wallpaper stays fixed and old snapshots use the default background', () => {
  const appearance = api();
  const old = appearance.advance({ schemaVersion: 1, config: { providers: [] } });
  assert.equal(old.wallpaper, null);
  let snapshot = appearance.buildSnapshot({ providers: [] }, null, { images: [picture('one')] });
  snapshot = appearance.advance(snapshot).snapshot;
  assert.equal(appearance.advance(snapshot).wallpaper.id, 'one');
  const cleared = appearance.buildSnapshot(snapshot.config, snapshot, { revision: 2, images: [] });
  assert.equal(cleared.wallpaperId, undefined);
  assert.equal(appearance.advance(cleared).wallpaper, null);
});

test('wallpaper reads and writes are sequential and the catalog contains no large values', async () => {
  const appearance = api();
  const data = new Map();
  let concurrent = 0;
  const calls = [];
  const storage = {
    async get(key) {
      concurrent++;
      assert.equal(concurrent, 1, 'large wallpaper values must not share a bridge batch');
      await Promise.resolve();
      concurrent--;
      return data.get(key) ?? null;
    },
    async set(key, value) { calls.push(['set', key]); data.set(key, value); },
    async remove(key) { calls.push(['remove', key]); data.delete(key); }
  };
  const saved = await appearance.save(storage, [picture('one'), picture('two')]);
  assert.deepEqual(plain(data.get(appearance.KEY).images), ['one', 'two']);
  assert.equal(JSON.stringify(data.get(appearance.KEY)).includes('data:image'), false);
  assert.deepEqual(plain(await appearance.read(storage)), plain(saved));
  calls.length = 0;
  await appearance.save(storage, [picture('two')]);
  assert.ok(calls.findIndex(call => call[0] === 'set' && call[1] === appearance.KEY) <
    calls.findIndex(call => call[0] === 'remove' && call[1] === 'wallpaper.one'));
});

test('the complete AOD snapshot is checked against 800K, not an arbitrary image count', () => {
  const appearance = api();
  const images = Array.from({ length: 5 }, (_, i) => ({ ...picture('photo' + i),
    sharp: 'data:image/jpeg;base64,' + 'A'.repeat(175 * 1024),
    blur: 'data:image/jpeg;base64,' + 'A'.repeat(25 * 1024) }));
  assert.throws(() => appearance.buildSnapshot({ providers: [] }, null, { images }), /800K/);
  assert.equal(appearance.normalize({ images }).images.length, 5, 'there is no separate count cap');
});
