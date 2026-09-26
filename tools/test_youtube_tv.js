#!/usr/bin/env node
// YouTube 去广告脚本在 Apple TV 环境下能不能跑：模拟 tvOS 上 Surge 的 JavaScriptCore，
// 没有 TextEncoder / TextDecoder、没有 Node 的 process / require。
//
//   node tools/test_youtube_tv.js
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const ARG = '{"blockUpload":false,"blockShorts":false,"blockGames":false,"blockVerticalLive":false,"jumpAhead":false,"autoHd":false}';
const UA = 'com.google.ios.youtube/20.10.4 (AppleTV14,1; U; CPU tvOS 18_0 like Mac OS X)';
const H = { 'content-type': 'application/x-protobuf', 'user-agent': UA };
const PB = new Uint8Array([0x08, 0x96, 0x01]);  // 一个最小的 protobuf 消息

function run(file, env) {
  return new Promise((resolve) => {
    const store = {};
    const ctx = vm.createContext({
      console: { log: () => {} },
      setTimeout, clearTimeout, Uint8Array, ArrayBuffer, DataView,
      $argument: ARG,
      $persistentStore: { read: (k) => store[k] ?? null, write: (v, k) => { store[k] = v; return true; } },
      $environment: { system: 'tvOS' },
      $done: (o) => resolve({ o }),
      ...env,
    });
    assert.strictEqual(vm.runInContext('typeof TextEncoder + typeof TextDecoder + typeof process', ctx), 'undefinedundefinedundefined');
    try { vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx); } catch (e) { resolve({ error: e.message }); }
    setTimeout(() => resolve({ timeout: true }), 3000);
  });
}

(async () => {
  const REQ = 'scripts/vendor/gholts-surge/request.js';
  const RES = 'scripts/youtube-ads/response.js';

  let r = await run(REQ, { $request: { url: 'https://youtubei.googleapis.com/youtubei/v1/player/ad_break?key=x', headers: H } });
  assert.strictEqual(r.o.response.status, 200);
  assert.strictEqual(r.o.response.body.length, 0);
  console.log('ok  插播广告请求回空响应');

  r = await run(REQ, { $request: { url: 'https://rr1---sn-abc.googlevideo.com/initplayback?source=youtube', headers: H, body: PB } });
  assert.strictEqual(r.o.response.body.length, 0);
  console.log('ok  加密播放请求在本地回空，逼 App 退回普通接口');

  r = await run(REQ, { $request: { url: 'https://youtubei.googleapis.com/youtubei/v1/log_event', headers: { ...H, 'X-YouTube-Hot-Hash-Data': 'abc' }, body: PB } });
  assert.ok(!Object.keys(r.o.headers).some((k) => k.toLowerCase() === 'x-youtube-hot-hash-data'));
  console.log('ok  日志请求去掉协商密钥的请求头');

  for (const api of ['browse', 'next', 'player', 'search', 'guide']) {
    r = await run(RES, { $request: { url: `https://youtubei.googleapis.com/youtubei/v1/${api}?key=x`, headers: H }, $response: { status: 200, headers: H, body: PB } });
    assert.ok(!r.error && !r.timeout, `${api}: ${r.error || '没有调用 $done'}`);
  }
  console.log('ok  首页、播放页、搜索等接口在没有 TextEncoder 的环境下正常执行');

  r = await run('scripts/vendor/gholts-surge/response.js', { $request: { url: 'https://youtubei.googleapis.com/youtubei/v1/browse', headers: H }, $response: { status: 200, headers: H, body: PB } });
  assert.ok(/TextEncoder/.test(r.error || ''), '对照：原版脚本在 Apple TV 上应该报错');
  console.log('ok  对照：不加补丁的原版脚本会报 TextEncoder is not defined');
  console.log('全部通过');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
