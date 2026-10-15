const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createCard(rect = {left: 10, top: 20, width: 456, height: 298}, frameOnly = true) {
  const handlers = {};
  const frames = [];
  let recording = false;
  let text = [];
  function requireRecording() {
    if (frameOnly) assert.ok(recording, 'JsCanvas drawing must happen inside a recorded animation frame');
  }
  function flushFrame() {
    const pending = frames.splice(0);
    recording = true;
    try { pending.forEach(fn => fn(100)); } finally { recording = false; }
  }
  const ctx = new Proxy({
    createLinearGradient: () => ({addColorStop() {}}),
    measureText: value => ({width: String(value).length * 12}),
    fillRect() { requireRecording(); text = []; },
    fillText(value, x, y) { requireRecording(); text.push({value: String(value), x, y}); },
  }, {get: (target, key) => target[key] ?? requireRecording});
  const cv = {
    getContext: () => ctx,
    getBoundingClientRect: () => rect,
    addEventListener: (type, fn) => handlers[type] = fn,
    setPointerCapture() {},
  };
  const win = (title, seconds) => ({title, usedPercent: 12, windowSeconds: seconds, resetAt: 2000000000});
  const sandbox = {
    window: {CARD_CONFIG: {providers: [
      {id: 'codex', name: 'Codex', windows: [win('5 小时限额',18000),win('本周限额',604800)]},
      {id: 'kimi', name: 'Kimi Code', windows: [win('5 小时窗口',18000),win('本周额度',604800),win('本月额度',2592000)]},
      {id: 'deepseek', name: 'DeepSeek', balance: {amount: 25,currency:'CNY',isAvailable:true}},
    ]}},
    document: {getElementById: () => cv, addEventListener() {}},
    Image: function() {},
    Date,
  };
  if (frameOnly) sandbox.window.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
  vm.runInNewContext(fs.readFileSync('prototype/main.js','utf8'),sandbox);
  flushFrame();
  function event(type,x,y,id=1,flush=true) {
    const rw = rect.width || 912, rh = rect.height || 596;
    handlers[type]({clientX: (rect.left||0)+x*rw/912, clientY:(rect.top||0)+y*rh/596,
      pointerId:id, isPrimary:true, preventDefault() {}});
    if (flush) flushFrame();
  }
  function tap(x,y) {event('pointerdown',x,y);event('pointerup',x,y);}
  function swipe(x,y,toX,toY) {event('pointerdown',x,y);event('pointermove',toX,toY);event('pointerup',toX,toY);}
  return {handlers,event,tap,swipe,flushFrame,pendingFrames:()=>frames.length,
    onRefresh:handler=>sandbox.window.AiUsageCard.onRefresh(handler),
    update:(config,done)=>sandbox.window.AiUsageCard.update(config,done),
    text:()=>text, has:value=>text.some(t=>t.value===value)};
}

const card=createCard();
assert.ok(card.handlers.pointerdown && card.handlers.pointerup);
assert.equal(card.handlers.mousedown,undefined);
card.tap(450,200); assert.ok(card.has('5 小时限额')); // homepage -> Codex
card.swipe(800,200,650,200); assert.ok(card.has('5 小时窗口')); // Codex -> Kimi
const before=card.text().find(t=>t.value==='本月额度').y;
card.swipe(700,480,700,200);
assert.ok(card.text().find(t=>t.value==='本月额度').y < before); // vertical scroll
card.tap(450,50); assert.ok(card.has('AI 用量')); // title -> home
const frame=JSON.stringify(card.text());
card.handlers.wheel({deltaY:200,preventDefault() {throw Error('Home must not scroll');}});
assert.equal(JSON.stringify(card.text()),frame);
card.event('pointerdown',450,200); card.handlers.pointercancel({}); card.event('pointerup',450,200);
assert.ok(card.has('AI 用量')); // cancellation must not activate a card
card.tap(450,430); assert.ok(card.has('账户余额')); // DeepSeek balance
const fallback=createCard({left:0,top:0,width:0,height:0});
fallback.tap(450,200); assert.ok(fallback.has('5 小时限额')); // original card's zero-size fallback
const deferred = createCard();
assert.equal(deferred.pendingFrames(),0); // static card does not run an endless frame loop
const oldFrame = JSON.stringify(deferred.text());
deferred.event('pointerdown',450,200,1,false);
deferred.event('pointerup',450,200,1,false);
assert.equal(JSON.stringify(deferred.text()),oldFrame); // touch callback does not draw outside recording
assert.equal(deferred.pendingFrames(),1);
deferred.flushFrame();
assert.ok(deferred.has('5 小时限额'));
assert.equal(deferred.pendingFrames(),0);
deferred.event('pointerdown',450,50,1,false);
deferred.event('pointerup',450,50,1,false); // home
deferred.event('pointerdown',450,200,1,false);
deferred.event('pointerup',450,200,1,false); // Codex again before one frame
assert.equal(deferred.pendingFrames(),1); // multiple state changes share one repaint
deferred.flushFrame();
assert.ok(deferred.has('5 小时限额'));
assert.equal(deferred.pendingFrames(),0);
const direct = createCard(undefined,false); // fallback without a frame API
direct.tap(450,200); assert.ok(direct.has('5 小时限额'));
const live=createCard();
live.tap(450,430); // DeepSeek detail
let published=false;
live.update({providers:[{id:'deepseek',name:'DeepSeek',balance:{amount:36,currency:'CNY',isAvailable:true}}]},()=>{published=true;});
assert.equal(published,false); // snapshot callback follows the recorded draw
live.flushFrame();
assert.ok(live.has('¥36.00'));
assert.equal(published,true);
live.update({providers:[],emptyMessage:'请在模块设置中添加来源'});live.flushFrame();
assert.ok(live.has('尚未设置用量来源'));
assert.ok(live.has('请在模块设置中添加来源'));
live.update({providers:[{id:'kimi',name:'Kimi Code',windows:[{title:'5 小时窗口',usedPercent:12,windowSeconds:18000}]}]});
live.flushFrame();assert.ok(live.has('5 小时窗口')); // adding an account does not reload the script
async function testRefresh() {
  const card = createCard(), calls = [];
  let finish;
  card.onRefresh(id => { calls.push(id); return new Promise(resolve => { finish = resolve; }); });
  card.swipe(450,150,450,200); // short pull
  card.event('pointerdown',450,150); card.event('pointermove',450,280);
  card.handlers.pointercancel({}); card.event('pointerup',450,280);
  await Promise.resolve();
  assert.equal(calls.length,0);
  card.swipe(450,150,450,280);
  await Promise.resolve();
  assert.deepEqual(calls,[null]); // home refreshes all providers
  card.flushFrame(); assert.ok(card.has('刷新中…'));
  card.swipe(450,150,450,280); await Promise.resolve();
  assert.equal(calls.length,1); // no duplicate request while refreshing
  finish(); await new Promise(resolve=>setImmediate(resolve)); card.flushFrame();
  card.tap(450,200); card.swipe(450,150,450,280);
  await Promise.resolve(); assert.deepEqual(calls,[null,'codex']);
  finish(); await new Promise(resolve=>setImmediate(resolve)); card.flushFrame();
  card.swipe(800,200,650,200); // tall Kimi detail
  card.swipe(700,480,700,200); // scroll down
  card.swipe(700,200,700,480); // return to top, not a refresh
  await Promise.resolve(); assert.equal(calls.length,2);
  card.swipe(700,200,700,320); await Promise.resolve();
  assert.deepEqual(calls,[null,'codex','kimi']);
  finish(); await new Promise(resolve=>setImmediate(resolve)); card.flushFrame();
  card.update({providers:[{id:'deepseek',name:'DeepSeek',balance:{amount:5,currency:'CNY'}}]});
  card.flushFrame();
  card.onRefresh(id => { calls.push(id); return Promise.reject(Error('private detail')); });
  card.swipe(450,150,450,280); await new Promise(resolve=>setImmediate(resolve)); card.flushFrame();
  assert.equal(calls.at(-1),'deepseek');
  assert.ok(card.has('刷新失败，请重试'));
  assert.ok(!card.has('private detail'));
}
testRefresh().then(()=>console.log('PASS: Frame-only rendering, deferred touch repaint, idle frame queue, pointer gestures, cancel, coordinate scaling, live data updates, scoped pull refresh')).catch(error=>{console.error(error);process.exitCode=1;});
