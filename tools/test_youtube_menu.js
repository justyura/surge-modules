#!/usr/bin/env node
// scripts/vendor/gholts-surge/response.js 本地补丁的测试：播放器「更多」菜单里加「导出字幕」。
// 用自己拼的最小 /next 响应（protobuf），字段位置是对着 iOS 客户端的真实响应找的。
//
//   node tools/test_youtube_menu.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'vendor', 'gholts-surge', 'response.js'), 'utf8');

const varint = (n) => { const out = []; while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); return out; };
const field = (no, bytes) => Buffer.concat([Buffer.from(varint(no * 8 + 2)), Buffer.from(varint(bytes.length)), Buffer.from(bytes)]);
const num = (no, n) => Buffer.from(varint(no * 8).concat(varint(n)));
const nest = (path, bytes) => path.reduceRight((inner, no) => field(no, inner), Buffer.from(bytes));

function readPb(buf) {
  const out = [];
  let pos = 0;
  const rv = () => { let v = 0, s = 1, b; do { b = buf[pos++]; v += (b & 127) * s; s *= 128; } while (b & 128); return v; };
  while (pos < buf.length) {
    const tag = rv();
    if (tag % 8 === 0) { out.push([Math.floor(tag / 8), rv()]); continue; }
    const len = rv();
    out.push([Math.floor(tag / 8), Buffer.from(buf.subarray(pos, pos + len))]);
    pos += len;
  }
  return out;
}
const get = (buf, no) => readPb(buf).filter((f) => f[0] === no).map((f) => f[1]);
const at = (buf, path) => path.reduce((list, no) => list.flatMap((b) => get(b, no)), [buf]);

const MODEL = [153515154, 172660663, 1, 168777401, 5, 407694004];
// 一个菜单项：标识符、状态 key、按钮（图标、标题、点了执行的命令、一个日志字段）
function menuItem(id, title, icon) {
  const state = '/youtube/app/player_overflow_menu/' + id;
  const button = Buffer.concat([field(2, Buffer.from(icon)), field(3, Buffer.from(title)), field(4, nest([170382688, 1, 169495254, 423731020], [])), field(8, num(1, 51))]);
  const model = Buffer.concat([field(4, button), field(10, Buffer.from(state)), num(12, 1)]);
  const element = Buffer.concat([
    field(3, nest([396644439, 1], Buffer.from(id))),
    field(172660663, field(1, field(168777401, Buffer.concat([
      field(5, field(407694004, model)),
      field(6, nest([188490103, 1, 1], Buffer.from(state))),
    ])))),
  ]);
  return field(1, field(153515154, element));
}

// /next：currentVideoEndpoint(9).watchEndpoint(48687757).videoId(1)，playerOverlays(14).renderer(78882851).overflowMenu(2).menuRenderer(66439850).items(1)
function nextResponse(items, videoId = 'abcDEF12345') {
  return Buffer.concat([
    field(9, nest([48687757, 1], Buffer.from(videoId))),
    field(14, nest([78882851, 2, 66439850], Buffer.concat(items))),
    num(1000, 5),
  ]);
}
const STANDARD = [
  menuItem('menu_item_video_quality', '画质', 'yt_outline_gear_24pt'),
  menuItem('menu_item_captions', '字幕', 'yt_outline_closed_caption_24pt'),
  menuItem('menu_item_help_and_feedback', '帮助和反馈', 'yt_outline_question_circle_24pt'),
];

function run(body, options = { subtitleExport: true }) {
  return new Promise((resolve) => {
    const env = {
      $argument: JSON.stringify({ blockUpload: false, autoHd: false, ...options }),
      $request: { url: 'https://youtubei.googleapis.com/youtubei/v1/next?id=1', headers: {} },
      $response: { body: new Uint8Array(body), status: 200 },
      $persistentStore: { read: () => null, write: () => true },
      $done: (out) => resolve(out.body ? Buffer.from(out.body) : null),
      console: { log: () => {} },
    };
    new Function(...Object.keys(env), CODE)(...Object.values(env));
  });
}

const items = (buf) => at(buf, [14, 78882851, 2, 66439850, 1]);
const titles = (buf) => items(buf).map((it) => at(it, [...MODEL, 4, 3])[0].toString());

(async () => {
  // 1. 插在「字幕」后面，照「帮助和反馈」复制：标题、图标、点了打开导出地址，标识符和状态 key 换成自己的
  {
    const out = await run(nextResponse(STANDARD));
    assert.deepStrictEqual(titles(out), ['画质', '字幕', '导出字幕', '帮助和反馈']);
    const item = items(out)[2];
    assert.strictEqual(at(item, [...MODEL, 4, 2])[0].toString(), 'yt_outline_share_24pt');
    const url = at(item, [...MODEL, 4, 4, 169495254, 49679253]);
    assert.strictEqual(get(url[0], 1)[0].toString(), 'https://yt-subtitles.internal/?v=abcDEF12345');
    assert.strictEqual(get(url[0], 2)[0], 1, '新窗口打开');
    assert.strictEqual(at(item, [...MODEL, 10])[0].toString(), '/youtube/app/player_overflow_menu/menu_item_export_subtitles');
    assert.strictEqual(at(item, [153515154, 3, 396644439, 1])[0].toString(), 'menu_item_export_subtitles');
    assert.strictEqual(at(item, [153515154, 172660663, 1, 168777401, 6, 188490103, 1, 1])[0].toString(), '/youtube/app/player_overflow_menu/menu_item_export_subtitles');
    assert.deepStrictEqual(at(item, [...MODEL, 4, 8]), at(items(out)[3], [...MODEL, 4, 8]), '按钮的其他字段照搬');
    // 原来的几项和菜单以外的字段不动
    assert.deepStrictEqual(items(out).filter((_, i) => i !== 2), items(nextResponse(STANDARD)));
    assert.deepStrictEqual(readPb(out).filter((f) => f[0] !== 14), readPb(nextResponse(STANDARD)).filter((f) => f[0] !== 14));
    console.log('ok  「导出字幕」插在「字幕」后面，点了打开导出地址，原来的菜单项和其他字段不动');
  }

  // 2. 已经有了不再加；关掉开关不加；没有「帮助和反馈」可以照着复制就不加；没有「字幕」就加在最后
  {
    const once = await run(nextResponse(STANDARD));
    assert.strictEqual(await run(once), null, '已经有了，响应原样放行');
    assert.strictEqual(await run(nextResponse(STANDARD), { subtitleExport: false }), null);
    assert.strictEqual(await run(nextResponse(STANDARD.slice(0, 2))), null);
    const noCaptions = await run(nextResponse([STANDARD[0], STANDARD[2]]));
    assert.deepStrictEqual(titles(noCaptions), ['画质', '帮助和反馈', '导出字幕']);
    console.log('ok  不重复加，开关能关，没有模板不加，没有「字幕」加在最后');
  }

  // 3. next 里没有视频 ID（get_watch / Onesie）：照样加，打开不带 ID 的导出页；参数里没有这个开关也当开着
  {
    const noId = Buffer.concat([field(14, nest([78882851, 2, 66439850], Buffer.concat(STANDARD)))]);
    const out = await run(noId, {});
    assert.deepStrictEqual(titles(out), ['画质', '字幕', '导出字幕', '帮助和反馈']);
    const url = at(items(out)[2], [...MODEL, 4, 4, 169495254, 49679253, 1])[0].toString();
    assert.strictEqual(url, 'https://yt-subtitles.internal/');
    console.log('ok  没有视频 ID 也加，打开最近的字幕；参数里没有开关默认开');
  }

  // 4. 模块里参数是字符串："true" 新加一项，"false" 关，"replace" 把「帮助和反馈」换成「导出字幕」（标识符、状态 key 不动）
  {
    assert.deepStrictEqual(titles(await run(nextResponse(STANDARD), { subtitleExport: 'true' })), ['画质', '字幕', '导出字幕', '帮助和反馈']);
    assert.strictEqual(await run(nextResponse(STANDARD), { subtitleExport: 'false' }), null);
    const out = await run(nextResponse(STANDARD), { subtitleExport: 'replace' });
    assert.deepStrictEqual(titles(out), ['画质', '字幕', '导出字幕']);
    const item = items(out)[2];
    assert.strictEqual(at(item, [...MODEL, 4, 4, 169495254, 49679253, 1])[0].toString(), 'https://yt-subtitles.internal/?v=abcDEF12345');
    assert.strictEqual(at(item, [153515154, 3, 396644439, 1])[0].toString(), 'menu_item_help_and_feedback', '标识符留着 App 认识的');
    assert.strictEqual(at(item, [...MODEL, 10])[0].toString(), '/youtube/app/player_overflow_menu/menu_item_help_and_feedback');
    assert.strictEqual(await run(out, { subtitleExport: 'replace' }), null, '换过了不再换');
    console.log('ok  参数是字符串：true 新加，false 关，replace 把「帮助和反馈」换成「导出字幕」');
  }

  console.log('全部通过');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
