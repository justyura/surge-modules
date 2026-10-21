#!/usr/bin/env node
// scripts/youtube-subtitles.js 的测试：模拟 Surge 环境和 DeepL / Google 接口。
//
//   node tools/test_subtitles.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const fakeLlm = require('./fake_llm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'youtube-subtitles.js'), 'utf8');
const K1 = '11111111-1111-1111-1111-111111111111:fx';
const K2 = '22222222-2222-2222-2222-222222222222:fx';
const K3 = '33333333-3333-3333-3333-333333333333';  // Pro key，走 api.deepl.com

// 假的 DeepL：XML 模式下把每个 <t>…</t> 里的内容加上「译:」
function fakeDeepl(text, xml, mode) {
  if (!xml) return '译:' + text;
  if (mode === 'merge') return text.replace('</t><t>', ' ').replace(/<t>([\s\S]*?)<\/t>/g, '<t>译:$1</t>');
  return text.replace(/<t>([\s\S]*?)<\/t>/g, '<t>译:$1</t>');
}

const OEMBED = { vid1: 'Fixing a squeaky door — Handy Dan', dQw4w9WgXcQ: 'Never Gonna Give You Up — Rick Astley' };
function fakeOembed(req, cb, calls) {
  const id = /watch%3Fv%3D([\w-]+)/.exec(req.url)[1];
  calls.push({ vendor: 'oembed', id });
  const [title, author] = (OEMBED[id] || '').split(' — ');
  setTimeout(() => (title ? cb(null, { status: 200 }, JSON.stringify({ title, author_name: author })) : cb(null, { status: 404 }, 'Not Found')));
}

// behavior[key] = 状态码 | 'network' | 'merge'（标签被 DeepL 合并）| 'hang'（永不返回），默认 200
// vocab: 生词服务返回的 words 数组，或 'down'（连不上）、'hang'（不返回）
function run({ url, body, args, behavior = {}, store = {}, google = true, latency = 0, vocab = [], llm }) {
  const calls = [];
  const started = Date.now();
  return new Promise((resolve) => {
    const env = {
      $argument: args,
      $request: { url },
      $response: { body },
      $persistentStore: { read: (k) => store[k] ?? null, write: (v, k) => { store[k] = v; return true; } },
      $httpClient: {
        post(req, cb) {
          if (req.url.endsWith('/v1/extract')) {
            calls.push({ vendor: 'vocab', url: req.url, text: JSON.parse(req.body).text, timeout: req.timeout });
            if (vocab === 'hang') return;
            if (vocab === 'down') return setTimeout(() => cb('connection refused', null, null));
            return setTimeout(() => cb(null, { status: 200 }, JSON.stringify({ words: vocab })));
          }
          if (fakeLlm(req, cb, calls, llm)) return;
          const key = req.headers.Authorization.replace('DeepL-Auth-Key ', '');
          const b = JSON.parse(req.body);
          const xml = b.tag_handling === 'xml';
          const cues = xml ? b.text.join('').split('<t>').length - 1 : b.text.length;
          calls.push({ vendor: 'deepl', host: new URL(req.url).host, key, n: b.text.length, cues, xml, target: b.target_lang, source: b.source_lang, context: b.context });
          const how = behavior[key] ?? 200;
          if (how === 'hang') return;
          const reply = () => {
            if (how === 'network') return cb('timeout', null, null);
            if (typeof how === 'number' && how !== 200) return cb(null, { status: how }, '{"message":"err"}');
            cb(null, { status: 200 }, JSON.stringify({ translations: b.text.map((t) => ({ text: fakeDeepl(t, xml, how) })) }));
          };
          setTimeout(reply, latency);
        },
        get(req, cb) {
          if (req.url.includes('/oembed?')) return fakeOembed(req, cb, calls);
          const q = decodeURIComponent(/[?&]q=([^&]*)/.exec(req.url)[1]);
          calls.push({ vendor: 'google', lines: q.split('\n').length });
          if (!google) return setTimeout(() => cb('down', null, null));
          setTimeout(() => cb(null, { status: 200 }, JSON.stringify([[[q.split('\n').map((l) => '谷:' + l).join('\n'), q]]])));
        },
      },
      $done: (out) => resolve({ out, calls, store, seconds: (Date.now() - started) / 1000 }),
      console: { log: () => {} },
    };
    new Function(...Object.keys(env), CODE)(...Object.values(env));
  });
}

// ---------- 评论用的 protobuf ----------

const varint = (n) => { const out = []; while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); return out; };
const field = (no, bytes) => Buffer.concat([Buffer.from(varint(no * 8 + 2)), Buffer.from(varint(bytes.length)), Buffer.from(bytes)]);
const num = (no, n) => Buffer.from(varint(no * 8).concat(varint(n)));
const COMMENTS = ['Great video, thanks!', '这个视频太棒了', '😂😂😂', 'Watch the Eclipse⁠关联 tonight', 'すごい動画です', 'Great video, thanks!'];

// 仿 /next 的评论响应：frameworkUpdates(777).entityBatchUpdate(1).mutations(1).payload(3)
// .commentEntityPayload(40).properties(2).content(3).content(1)，再夹一些别的字段。
// 每条评论还带一个 commentSurfaceEntityPayload(79)，里面 inlineReadMoreButton(10).isExpanded(2) 是「展开」状态。
// 传 replaceIn 时把里面的评论正文换成 texts，用来比较「除正文外是否一样」
function commentsPb(texts, replaceIn, expanded = 0) {
  if (replaceIn) {
    const out = [];
    let i = 0;
    walkComments(replaceIn, () => out.push(texts[i++]));
    return commentsPb(out, null, expanded);
  }
  const mutations = texts.flatMap((t, i) => [field(1, Buffer.concat([
    field(1, Buffer.from('key' + i)),
    num(2, 1),
    field(3, field(40, Buffer.concat([
      field(1, Buffer.from('entity' + i)),
      field(2, Buffer.concat([field(1, Buffer.from('id' + i)), field(3, Buffer.concat([field(1, Buffer.from(t)), field(5, num(1, 17))])), num(10, 0)])),
    ]))),
  ])), field(1, Buffer.concat([
    field(1, Buffer.from('surface' + i)),
    field(3, field(79, Buffer.concat([field(1, Buffer.from('surface' + i)), field(4, Buffer.from('3 replies')), field(10, num(2, expanded)), num(21, 1)]))),
  ]))]);
  mutations.splice(2, 0, field(1, Buffer.concat([field(1, Buffer.from('toolbar')), field(3, field(41, Buffer.from('other')))])));
  return Buffer.concat([num(1, 7), field(9, Buffer.from('continuation contents')), field(777, field(1, Buffer.concat(mutations))), num(1000, 3)]);
}

function readPb(buf) {
  const out = [];
  let pos = 0;
  const rv = () => { let v = 0, s = 1, b; do { b = buf[pos++]; v += (b & 127) * s; s *= 128; } while (b & 128); return v; };
  while (pos < buf.length) {
    const tag = rv();
    if (tag % 8 === 0) { out.push([Math.floor(tag / 8), rv()]); continue; }
    const len = rv();
    out.push([Math.floor(tag / 8), buf.subarray(pos, pos + len)]);
    pos += len;
  }
  return out;
}

function walkComments(buf, visit) {
  const get = (b, no) => readPb(Buffer.from(b)).filter((f) => f[0] === no).map((f) => f[1]);
  for (const fu of get(buf, 777)) for (const ebu of get(fu, 1)) for (const m of get(ebu, 1)) for (const p of get(m, 3))
    for (const c of get(p, 40)) for (const props of get(c, 2)) for (const content of get(props, 3)) for (const t of get(content, 1)) visit(Buffer.from(t).toString());
}

function expandStates(buf) {
  const get = (b, no) => readPb(Buffer.from(b)).filter((f) => f[0] === no).map((f) => f[1]);
  const out = [];
  for (const fu of get(buf, 777)) for (const ebu of get(fu, 1)) for (const m of get(ebu, 1)) for (const p of get(m, 3))
    for (const c of get(p, 79)) for (const b of get(c, 10)) out.push(get(b, 2)[0]);
  return out;
}

function commentTexts(buf) {
  const out = [];
  walkComments(buf, (t) => out.push(t));
  return out;
}

// upstream: Buffer（YouTube 返回的评论）| 'network' | 状态码
function runComments({ upstream, token = 'Eg0SC2RRdzR3OVdnWGNRGAYyJCIRIgtkUXc0dzlXZ1hjUTAAeAI', browseId, headers, behavior = {}, store = {}, extra = '', keys = K1, llm }) {
  const calls = [];
  const started = Date.now();
  const body = new Uint8Array(Buffer.concat([field(1, Buffer.from('context')), browseId ? field(2, Buffer.from(browseId)) : field(3, Buffer.from(token))]));
  return new Promise((resolve) => {
    const env = {
      $argument: ARGS(keys, extra),
      $request: {
        url: 'https://youtubei.googleapis.com/youtubei/v1/next?id=1',
        headers: headers || { 'Content-Type': 'application/x-protobuf', Authorization: 'Bearer token', 'Content-Length': String(body.length), 'Accept-Encoding': 'gzip' },
        body,
      },
      $persistentStore: { read: (k) => store[k] ?? null, write: (v, k) => { store[k] = v; return true; } },
      $httpClient: {
        post(req, cb) {
          if (req.url.startsWith('https://youtubei')) {
            calls.push({ vendor: 'upstream', headers: req.headers, binary: req['binary-mode'] === true && req.body === body });
            if (upstream === 'network') return setTimeout(() => cb('timeout', null, null));
            const reply = typeof upstream === 'number' ? new Uint8Array(0) : new Uint8Array(upstream);
            return setTimeout(() => cb(null, { status: typeof upstream === 'number' ? upstream : 200, headers: { 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'gzip', 'Content-Length': '1' } }, reply));
          }
          if (fakeLlm(req, cb, calls, llm)) return;
          const key = req.headers.Authorization.replace('DeepL-Auth-Key ', '');
          const b = JSON.parse(req.body);
          calls.push({ vendor: 'deepl', key, n: b.text.length, xml: b.tag_handling === 'xml', source: b.source_lang, context: b.context });
          const how = behavior[key] ?? 200;
          if (how === 'hang') return;
          if (how !== 200) return setTimeout(() => cb(null, { status: how }, '{}'));
          setTimeout(() => cb(null, { status: 200 }, JSON.stringify({ translations: b.text.map((t) => ({ text: '译:' + t })) })));
        },
        get(req, cb) {
          if (req.url.includes('/oembed?')) return fakeOembed(req, cb, calls);
          const q = decodeURIComponent(/[?&]q=([^&]*)/.exec(req.url)[1]);
          calls.push({ vendor: 'google' });
          setTimeout(() => cb(null, { status: 200 }, JSON.stringify([[[q.split('\n').map((l) => '谷:' + l).join('\n'), q]]])));
        },
      },
      $done: (out) => resolve({ out, calls, store, seconds: (Date.now() - started) / 1000 }),
      console: { log: () => {} },
    };
    new Function(...Object.keys(env), CODE)(...Object.values(env));
  });
}

// 导出页面：http-request 脚本，没有 $response
function runExport(url, store, { behavior = 200, google = true } = {}) {
  const calls = [];
  return new Promise((resolve) => {
    const env = {
      $argument: ARGS(K1),
      $request: { url, headers: {} },
      $persistentStore: { read: (k) => store[k] ?? null, write: (v, k) => { store[k] = v; return true; } },
      $httpClient: {
        post(req, cb) {
          const b = JSON.parse(req.body);
          calls.push({ vendor: 'deepl', n: b.text.length, xml: b.tag_handling === 'xml', context: b.context, text: b.text });
          if (behavior !== 200) return setTimeout(() => cb(null, { status: behavior }, '{}'));
          const tr = (t) => (b.tag_handling === 'xml' ? t.replace(/<(p|t)>([\s\S]*?)<\/\1>/g, '<$1>译:$2</$1>') : '译:' + t);
          setTimeout(() => cb(null, { status: 200 }, JSON.stringify({ translations: b.text.map((t) => ({ text: tr(t) })) })));
        },
        get(req, cb) {
          if (req.url.includes('/oembed?')) return fakeOembed(req, cb, calls);
          const q = decodeURIComponent(/[?&]q=([^&]*)/.exec(req.url)[1]);
          calls.push({ vendor: 'google', q });
          if (!google) return setTimeout(() => cb('down', null, null));
          setTimeout(() => cb(null, { status: 200 }, JSON.stringify([[[q.split('\n').map((l) => '谷:' + l).join('\n'), q]]])));
        },
      },
      $done: (out) => { const r = out.response; r.calls = calls; resolve(r); },
      console: { log: () => {} },
    };
    new Function(...Object.keys(env), CODE)(...Object.values(env));
  });
}

const json3 = (lines) => JSON.stringify({ wireMagic: 'pb3', events: lines.map((l, i) => ({ tStartMs: i * 1000, dDurationMs: 1000, segs: [{ utf8: l }] })) });
const events = (out) => JSON.parse(out.body).events.map((e) => e.segs.map((s) => s.utf8).join(''));
const URL_EN = 'https://www.youtube.com/api/timedtext?v=vid1&lang=en&fmt=json3';
const ARGS = (keys, extra = '') => `keys=${keys}&target=ZH-HANS&position=top&fallback=google&debug=false${extra}`;
const state = (store) => JSON.parse(store['yt-subtitles-deepl']);
const deeplCalls = (r) => r.calls.filter((c) => c.vendor === 'deepl');
const llmCalls = (r) => r.calls.filter((c) => c.vendor === 'llm');
const L1 = 'sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const L2 = 'sk-proj-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const LLM = (keys = L1) => `&llmkeys=${keys}`;

(async () => {
  // 1. 第一个 key 额度用完（456），自动换第二个
  {
    const r = await run({ url: URL_EN, body: json3(['Hello', 'World & <you>']), args: ARGS(`${K1}|${K2}`), behavior: { [K1]: 456 } });
    assert.deepStrictEqual(events(r.out), ['Hello\n译:Hello', 'World & <you>\n译:World & <you>']);
    assert.deepStrictEqual(deeplCalls(r).map((c) => c.key), [K1, K2]);
    assert.strictEqual(deeplCalls(r)[0].host, 'api-free.deepl.com');
    assert.strictEqual(deeplCalls(r)[0].target, 'ZH-HANS');
    assert.strictEqual(deeplCalls(r)[0].source, 'EN');
    const s = state(r.store);
    assert.strictEqual(s.current, K2.slice(-6) + '#1qfyqcx', '记住的是第二个 key 的指纹');
    const pausedFor = Object.values(s.paused)[0] - Math.floor(Date.now() / 1000);
    assert.ok(pausedFor > 86000 && pausedFor <= 86400, '456 暂停 24 小时');
    assert.ok(!JSON.stringify(s).includes(K1) && !JSON.stringify(s).includes(K2), '状态里不存明文 key');

    const r2 = await run({ url: URL_EN.replace('vid1', 'vid2'), body: json3(['Next']), args: ARGS(`${K1}|${K2}`), behavior: { [K1]: 456 }, store: r.store });
    assert.deepStrictEqual(deeplCalls(r2).map((c) => c.key), [K2]);

    const r3 = await run({ url: URL_EN, body: json3(['Hello', 'World & <you>']), args: ARGS(`${K1}|${K2}`), store: r.store });
    assert.strictEqual(r3.calls.length, 0);
    console.log('ok  额度用完自动换 key、暂停 24 小时、下次直接跳过、同一视频走缓存、特殊字符不乱');
  }

  // 2. 网络错误不暂停 key；key 无效（403）暂停 7 天；Pro key 走 api.deepl.com
  {
    const r = await run({ url: URL_EN, body: json3(['A']), args: ARGS(`${K1}|${K2}|${K3}`), behavior: { [K1]: 'network', [K2]: 403 } });
    assert.deepStrictEqual(deeplCalls(r).map((c) => c.key), [K1, K2, K3]);
    assert.strictEqual(deeplCalls(r)[2].host, 'api.deepl.com');
    const paused = Object.values(state(r.store).paused).map((t) => t - Math.floor(Date.now() / 1000));
    assert.strictEqual(paused.length, 1, '网络错误不暂停');
    assert.ok(paused[0] > 7 * 86400 - 100, '403 暂停 7 天');
    console.log('ok  网络错误直接换下一个不暂停，无效 key 暂停 7 天，Pro key 用 api.deepl.com');
  }

  // 3. 所有 key 都不行 → Google 兜底（多句一起发）；Google 也不行 → 原样返回
  {
    const r = await run({ url: URL_EN, body: json3(['Hi', 'There']), args: ARGS(`${K1}|${K2}`), behavior: { [K1]: 403, [K2]: 500 } });
    assert.deepStrictEqual(events(r.out), ['Hi\n谷:Hi', 'There\n谷:There']);
    assert.deepStrictEqual(r.calls.filter((c) => c.vendor === 'google').map((c) => c.lines), [2], 'Google 多句合成一个请求');
    const r2 = await run({ url: URL_EN, body: json3(['Hi']), args: ARGS(K1), behavior: { [K1]: 403 }, google: false });
    assert.deepStrictEqual(r2.out, {});
    const r3 = await run({ url: URL_EN, body: json3(['Hi']), args: ARGS(K1, '&fallback=off'), behavior: { [K1]: 403 } });
    assert.deepStrictEqual(r3.out, {});
    assert.ok(!r3.calls.some((c) => c.vendor === 'google'));
    console.log('ok  全部 key 失败用 Google 兜底，再失败或关掉兜底就原样返回');
  }

  // 4. 长视频：60 句一段、一段一个请求，各带上下文（视频标题、前后的字幕）；重复句子只翻一次
  {
    const lines = Array.from({ length: 3000 }, (_, i) => `This is line number ${i}`).concat(['This is line number 0']);
    const r = await run({ url: URL_EN, body: json3(lines), args: ARGS(K1) });
    const calls = deeplCalls(r);
    assert.strictEqual(calls.length, 50, `3000 句应该分成 50 个请求，实际 ${calls.length}`);
    assert.strictEqual(calls.reduce((n, c) => n + c.cues, 0), 3000);
    assert.ok(calls.every((c) => c.xml && c.n === 1));
    assert.strictEqual(calls[0].context, 'Video: Fixing a squeaky door — Handy Dan\nAfter: ' + lines.slice(60, 67).join(' '), '第一段：视频标题和后面 7 句');
    assert.ok(calls.every((c) => c.context.startsWith('Video: Fixing a squeaky door')), '每段都带视频标题');
    assert.ok(calls.some((c) => c.context.includes('This is line number 59\nAfter: This is line number 120')), '前面的字幕接到这一段之前，后面的接在之后');
    assert.strictEqual(r.calls.filter((c) => c.vendor === 'oembed').length, 1, '标题只查一次');
    assert.strictEqual(events(r.out)[3000], 'This is line number 0\n译:This is line number 0');
    console.log(`ok  3000 句分成 ${calls.length} 个请求、各带上下文和视频标题，重复句子不重复翻，用时 ${r.seconds.toFixed(2)} 秒`);
  }

  // 5. DeepL 把标签合并了（对不上）→ 这一组逐句重翻
  {
    const r = await run({ url: URL_EN, body: json3(['One', 'Two', 'Three']), args: ARGS(K1), behavior: { [K1]: 'merge' } });
    assert.deepStrictEqual(events(r.out), ['One\n译:One', 'Two\n译:Two', 'Three\n译:Three']);
    assert.deepStrictEqual(deeplCalls(r).map((c) => c.xml), [true, false]);
    console.log('ok  标签对不上时逐句重翻');
  }

  // 6. 超时：先返回翻好的部分，没翻完的显示原文；下次打开接着翻
  {
    const lines = Array.from({ length: 12000 }, (_, i) => `Cue ${i}`);
    const args = ARGS(K1, '&budget=3');
    const r = await run({ url: URL_EN, body: json3(lines), args, latency: 2500 });
    const out = events(r.out);
    const done = out.filter((l) => l.includes('译:')).length;
    assert.ok(done > 0 && done < 12000, `应该只翻了一部分，实际 ${done}`);
    assert.strictEqual(out[11999], 'Cue 11999', '没翻完的保持原文');
    assert.ok(r.seconds < 4, `应该在限时附近返回，实际 ${r.seconds} 秒`);
    const r2 = await run({ url: URL_EN, body: json3(lines), args, store: r.store, latency: 30 });
    assert.strictEqual(events(r2.out).filter((l) => l.includes('译:')).length, 12000, '第二次把剩下的翻完');
    assert.strictEqual(deeplCalls(r2).reduce((n, c) => n + c.cues, 0), 12000 - done, '第二次只翻剩下的');
    console.log(`ok  限时 3 秒：第一次 ${r.seconds.toFixed(1)} 秒返回 ${done} 句，第二次接着翻完剩下的`);
  }

  // 7. 接口完全卡死：超过限时 3 秒原样返回，字幕照样能加载
  {
    const r = await run({ url: URL_EN, body: json3(['Stuck']), args: ARGS(K1, '&budget=3'), behavior: { [K1]: 'hang' } });
    assert.deepStrictEqual(r.out, {});
    assert.ok(r.seconds >= 5.9 && r.seconds < 7, `应该 6 秒左右返回，实际 ${r.seconds}`);
    console.log(`ok  接口卡死时 ${r.seconds.toFixed(1)} 秒后原样返回`);
  }

  // 8. 自动生成字幕（json3，一个词一个 seg，带滚动窗口和换行事件）
  {
    const body = JSON.stringify({ events: [
      { tStartMs: 0, dDurationMs: 5000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
      { tStartMs: 0, dDurationMs: 3000, wWinId: 1, segs: [{ utf8: 'this' }, { utf8: ' is', tOffsetMs: 200 }, { utf8: ' auto', tOffsetMs: 400 }] },
      { tStartMs: 2000, dDurationMs: 1000, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
    ] });
    const r = await run({ url: URL_EN + '&kind=asr', body, args: ARGS(K1) });
    const ev = JSON.parse(r.out.body).events;
    assert.deepStrictEqual(ev[1].segs, [{ utf8: 'this is auto\n译:this is auto' }]);
    assert.strictEqual(ev[1].wWinId, undefined);
    assert.deepStrictEqual(ev[2].segs, [{ utf8: '\n' }]);
    assert.ok(!ev[0].segs);
    console.log('ok  自动生成字幕：合并逐词片段，换行事件和窗口定义不动');
  }

  // 9. srv3 XML、srv1、WebVTT
  {
    const srv3 = '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>'
      + '<p t="0" d="1000"><s>Tom</s><s t="200"> &amp; Jerry</s></p>'
      + '<p t="1000" d="1000">Say &quot;hi&quot;</p><p t="2000" d="500"></p></body></timedtext>';
    const r = await run({ url: URL_EN.replace('json3', 'srv3'), body: srv3, args: ARGS(K1) });
    assert.ok(r.out.body.includes('<p t="0" d="1000">Tom &amp; Jerry\n译:Tom &amp; Jerry</p>'), r.out.body);
    assert.ok(r.out.body.includes('<p t="1000" d="1000">Say &quot;hi&quot;\n译:Say &quot;hi&quot;</p>'));
    assert.ok(r.out.body.includes('<p t="2000" d="500"></p>'));

    const srv1 = '<?xml version="1.0" encoding="utf-8" ?><transcript><text start="0" dur="1">It&#39;s fine</text></transcript>';
    const r2 = await run({ url: 'https://www.youtube.com/api/timedtext?v=v9&lang=en', body: srv1, args: ARGS(K1) });
    assert.ok(r2.out.body.includes("<text start=\"0\" dur=\"1\">It's fine\n译:It's fine</text>"), r2.out.body);

    const vtt = 'WEBVTT\nKind: captions\n\n00:00:00.000 --> 00:00:01.000\nFirst line\n\n00:00:01.000 --> 00:00:02.000 align:start\n<c>Second</c>';
    const r3 = await run({ url: URL_EN.replace('json3', 'vtt'), body: vtt, args: ARGS(K1, '&position=bottom') });
    assert.strictEqual(r3.out.body, 'WEBVTT\nKind: captions\n\n00:00:00.000 --> 00:00:01.000\n译:First line\nFirst line\n\n00:00:01.000 --> 00:00:02.000 align:start\n译:Second\nSecond');
    console.log('ok  srv3、srv1、WebVTT 三种格式，转义字符正确，position=bottom 生效');
  }

  // 10. 不该翻的
  {
    const r1 = await run({ url: URL_EN + '&tlang=zh-Hans', body: json3(['x']), args: ARGS(K1) });
    const r2 = await run({ url: URL_EN.replace('lang=en', 'lang=zh-Hans'), body: json3(['中文']), args: ARGS(K1) });
    const r3 = await run({ url: URL_EN, body: json3(['x']), args: ARGS('填你的DeepL密钥，多个用竖线分隔', '&fallback=off') });
    for (const r of [r1, r2, r3]) {
      assert.deepStrictEqual(r.out, {});
      assert.strictEqual(r.calls.length, 0);
    }
    const r4 = await run({ url: URL_EN, body: json3(['only']), args: ARGS(K1, '&position=only') });
    assert.deepStrictEqual(events(r4.out), ['译:only']);
    console.log('ok  跳过 YouTube 自带翻译、中文字幕、没配置 key；position=only 只显示译文');
  }

  // 11. 生词：第一次出现的那句下面标释义，每句最多 2 个；服务挂了不影响翻译
  {
    const VOCAB = '&vocab=http://192.168.1.2:8090/';
    const words = [
      { word: 'ubiquitous', count: 2, rank: 9000, translation: 'a. 普遍存在的, 无所不在的' },
      { word: 'ephemeral', count: 1, rank: 12000, translation: 'a. 短暂的\\n n. 短命植物' },
      { word: 'spasm', count: 1, rank: 15000, translation: 'n. [医] 痉挛, 抽搐' },
      { word: "o'clock", count: 1, rank: 6000, translation: 'adv. 点钟' },
      { word: 'extraordinarily', count: 1, rank: 8000, translation: 'adv. 非常地；特别地；格外地；奇特地；非同寻常地' },
    ];
    const lines = ['Phones are ubiquitous now', 'Ephemeral, ubiquitous and a spasm', 'Ubiquitous again', 'At five o’clock it was extraordinarily hot'];
    const r = await run({ url: URL_EN, body: json3(lines), args: ARGS(K1, VOCAB), vocab: words });
    const call = r.calls.find((c) => c.vendor === 'vocab');
    assert.strictEqual(call.url, 'http://192.168.1.2:8090/v1/extract');
    assert.strictEqual(call.text, lines.join('\n'));
    assert.deepStrictEqual(events(r.out), [
      'Phones are ubiquitous now\n译:Phones are ubiquitous now\nubiquitous 普遍存在的',
      'Ephemeral, ubiquitous and a spasm\n译:Ephemeral, ubiquitous and a spasm\nephemeral 短暂的 · spasm 痉挛',
      'Ubiquitous again\n译:Ubiquitous again',
      'At five o’clock it was extraordinarily hot\n译:At five o’clock it was extraordinarily hot\no\'clock 点钟 · extraordinarily 非常地',
    ]);
    // 同一个视频再打开：生词从缓存拿，不再请求
    const r2 = await run({ url: URL_EN, body: json3(lines), args: ARGS(K1, VOCAB), store: r.store, vocab: 'down' });
    assert.strictEqual(r2.calls.length, 0);
    assert.strictEqual(events(r2.out)[0], events(r.out)[0]);
    // 服务连不上 / 卡住：照常翻译，不标生词，也不超时
    const r3 = await run({ url: URL_EN.replace('vid1', 'vid3'), body: json3(lines), args: ARGS(K1, VOCAB), vocab: 'down' });
    assert.strictEqual(events(r3.out)[0], 'Phones are ubiquitous now\n译:Phones are ubiquitous now');
    const r4 = await run({ url: URL_EN.replace('vid1', 'vid4'), body: json3(lines), args: ARGS(K1, VOCAB + '&budget=3'), vocab: 'hang' });
    assert.ok(r4.seconds < 7, '卡住的生词服务拖慢了字幕：' + r4.seconds);
    // 没有 DeepL key、也不用 Google：只标生词
    const r5 = await run({ url: URL_EN.replace('vid1', 'vid5'), body: json3(lines), args: ARGS('', VOCAB + '&fallback=off'), vocab: words });
    assert.deepStrictEqual(events(r5.out).slice(0, 3), ['Phones are ubiquitous now\nubiquitous 普遍存在的', 'Ephemeral, ubiquitous and a spasm\nephemeral 短暂的 · spasm 痉挛', 'Ubiquitous again']);
    // 非英文字幕、没填地址（占位文字）：不请求生词服务
    const r6 = await run({ url: URL_EN.replace('lang=en', 'lang=ja'), body: json3(['こんにちは']), args: ARGS(K1, VOCAB) });
    const r7 = await run({ url: URL_EN, body: json3(['Hi']), args: ARGS(K1, '&vocab=不用就留着') });
    for (const x of [r6, r7]) assert.ok(!x.calls.some((c) => c.vendor === 'vocab'));
    console.log('ok  生词：只在第一次出现时标，每句最多 2 个，缓存、服务挂了不影响字幕');
  }

  // 12. 评论：认出评论请求，替 App 拿响应，翻译后接在原文下面，其他字节不动
  {
    const r = await runComments({ upstream: commentsPb(COMMENTS) });
    assert.deepStrictEqual(commentTexts(r.out.response.body), [
      'Great video, thanks!\n译:Great video, thanks!',
      '这个视频太棒了',
      '😂😂😂',
      'Watch the Eclipse⁠关联 tonight\n译:Watch the Eclipse tonight',
      'すごい動画です\n译:すごい動画です',
      'Great video, thanks!\n译:Great video, thanks!',
    ]);
    const d = deeplCalls(r);
    assert.strictEqual(d.length, 1, '一页评论一个请求');
    assert.deepStrictEqual([d[0].n, d[0].xml, d[0].source], [3, false, undefined], '一条一段、不打包、自动识别语言、重复的只翻一次');
    const up = r.calls.find((c) => c.vendor === 'upstream');
    assert.strictEqual(up.headers['X-Surge-YT-Comments'], '1');
    assert.strictEqual(up.headers.Authorization, 'Bearer token', '带上登录状态');
    assert.ok(!('Content-Length' in up.headers) && !('Accept-Encoding' in up.headers) && up.binary);
    assert.deepStrictEqual(r.out.response.headers, { 'Content-Type': 'application/x-protobuf' });
    assert.strictEqual(r.out.response.status, 200);
    // 评论正文以外的字段原样保留，只有「展开」状态改成 true
    assert.deepStrictEqual(expandStates(r.out.response.body), Array(COMMENTS.length).fill(1));
    const strip = (buf) => commentsPb(COMMENTS.map(() => 'x'), buf, 1);
    assert.deepStrictEqual(strip(r.out.response.body), strip(commentsPb(COMMENTS)));

    // 同一条评论第二次看：走缓存不花额度
    const r2 = await runComments({ upstream: commentsPb(COMMENTS), store: r.store });
    assert.strictEqual(deeplCalls(r2).length, 0);
    assert.strictEqual(commentTexts(r2.out.response.body)[0], 'Great video, thanks!\n译:Great video, thanks!');
    console.log('ok  评论：英文、日文翻译，中文和纯表情不翻，链接标签不送去翻，其他字段不动，缓存生效');
  }

  // 13. 评论：非评论的 /next 放行；自己发出的请求放行并去掉标记；拿不到响应让 App 自己发
  {
    const r = await runComments({ upstream: commentsPb(COMMENTS), token: 'CBQSDRILZFF3NHc5V2dYY1EYACoA' });
    assert.deepStrictEqual(r.out, {});
    assert.strictEqual(r.calls.length, 0);
    const r2 = await runComments({ upstream: commentsPb(COMMENTS), headers: { 'X-Surge-YT-Comments': '1', Accept: '*/*' } });
    assert.deepStrictEqual(r2.out, { headers: { Accept: '*/*' } });
    assert.strictEqual(r2.calls.length, 0);
    const r3 = await runComments({ upstream: 'network' });
    assert.deepStrictEqual(r3.out, {});
    const r4 = await runComments({ upstream: 403 });
    assert.strictEqual(r4.out.response.status, 403, '出错的响应原样交给 App，不重复请求');
    console.log('ok  评论：其他 /next 请求、自己发的请求放行，拿不到评论时不影响 App');
  }

  // 14. 评论：DeepL 不行用 Google；DeepL 卡死时按时返回原评论
  {
    const r = await runComments({ upstream: commentsPb(COMMENTS), behavior: { [K1]: 403 } });
    assert.strictEqual(commentTexts(r.out.response.body)[0], 'Great video, thanks!\n谷:Great video, thanks!');
    const r2 = await runComments({ upstream: commentsPb(COMMENTS), behavior: { [K1]: 'hang' }, extra: '&budget=3' });
    assert.deepStrictEqual(commentTexts(r2.out.response.body), COMMENTS);
    assert.ok(r2.seconds >= 4.9 && r2.seconds < 6, `应该 5 秒左右返回原评论，实际 ${r2.seconds}`);
    console.log(`ok  评论：DeepL 失败用 Google，卡死时 ${r2.seconds.toFixed(1)} 秒返回原评论`);
  }

  // 15. 回复（/browse）：打开回复、往下翻回复都认得出；首页等其他 browse 放行
  {
    const r = await runComments({ upstream: commentsPb(COMMENTS), browseId: 'FEcomment_watch_replies_panel' });
    assert.strictEqual(commentTexts(r.out.response.body)[0], 'Great video, thanks!\n译:Great video, thanks!');
    for (const token of ['4qmFsgKFARIdRkVjb21tZW50X3dhdGNoX3JlcGxpZXNfcGFuZWw', Buffer.from('\0FEcomment_watch_replies_panel').toString('base64url'), Buffer.from('\0\0FEcomment_watch_replies_panel').toString('base64url')]) {
      const r2 = await runComments({ upstream: commentsPb(COMMENTS), token });
      assert.ok(r2.out.response, '没认出回复的 token：' + token);
    }
    const r3 = await runComments({ upstream: commentsPb(COMMENTS), browseId: 'FEwhat_to_watch' });
    assert.deepStrictEqual(r3.out, {});
    assert.strictEqual(r3.calls.length, 0);
    console.log('ok  回复：打开回复、往下翻回复都翻译，首页等其他 browse 请求放行');
  }

  // 16. 展开：expand=false 保持原样；没有 key 也不用 Google 时只展开
  {
    const r = await runComments({ upstream: commentsPb(COMMENTS), extra: '&expand=false' });
    assert.deepStrictEqual(expandStates(r.out.response.body), Array(COMMENTS.length).fill(0));
    const r2 = await runComments({ upstream: commentsPb(COMMENTS), keys: '', extra: '&fallback=off' });
    assert.deepStrictEqual(expandStates(r2.out.response.body), Array(COMMENTS.length).fill(1));
    assert.deepStrictEqual(commentTexts(r2.out.response.body), COMMENTS);
    assert.ok(!r2.calls.some((c) => c.vendor !== 'upstream'));
    const r3 = await runComments({ upstream: commentsPb(COMMENTS), keys: '', extra: '&fallback=off&expand=false' });
    assert.deepStrictEqual(r3.out, {});
    assert.strictEqual(r3.calls.length, 0);
    console.log('ok  展开：默认展开全文，可以关掉；不翻译时也能单独展开');
  }

  // 17. 大模型：字幕分组翻，带视频标题和前面几句当上下文；不再用 DeepL；同一视频走缓存
  {
    const lines = Array.from({ length: 60 }, (_, i) => `so this is caption number ${i} of the talk`);
    const r = await run({ url: URL_EN, body: json3(lines), args: ARGS(K1, LLM()) });
    const out = events(r.out);
    assert.strictEqual(out[0], lines[0] + '\n模:' + lines[0]);
    assert.ok(out.every((l, i) => l === lines[i] + '\n模:' + lines[i]), '每句都是大模型的译文');
    assert.strictEqual(deeplCalls(r).length, 0, '大模型翻完了就不用 DeepL');
    const calls = llmCalls(r);
    assert.ok(calls.length >= 2, '分成几组同时翻');
    assert.strictEqual(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.deepStrictEqual([calls[0].key, calls[0].model, calls[0].effort, calls[0].format], [L1, 'gpt-6-luna', 'none', 'json_object'], '默认 gpt-6-luna，关掉思考');
    assert.ok(calls[0].system.includes('Simplified Chinese'));
    assert.strictEqual(calls[0].payload.video, 'Fixing a squeaky door — Handy Dan', '视频标题当上下文');
    assert.deepStrictEqual(calls[0].payload.before, []);
    const firstEnd = lines.indexOf(calls[0].payload.lines[String(calls[0].n)]) + 1;
    assert.deepStrictEqual(calls[0].payload.after, lines.slice(firstEnd, firstEnd + 6), '带上后面 6 句');
    assert.ok(calls[0].system.includes('"after"'));
    const second = calls.find((c) => c.payload.lines['1'] !== lines[0]);
    const at = lines.indexOf(second.payload.lines['1']);
    assert.deepStrictEqual(second.payload.before, lines.slice(at - 10, at), '后面的组带上前 10 句');
    const last = calls.find((c) => lines.indexOf(c.payload.lines[String(c.n)]) === lines.length - 1);
    assert.deepStrictEqual(last.payload.after, [], '最后一组后面没有了');
    assert.ok(!JSON.stringify(r.store).includes(L1), '状态里不存大模型 key 明文');

    const r2 = await run({ url: URL_EN, body: json3(lines), args: ARGS(K1, LLM()), store: r.store });
    assert.strictEqual(r2.calls.length, 0, '同一个视频再打开走缓存，标题也不再查');
    assert.strictEqual(events(r2.out)[5], out[5]);
    // 关掉大模型：大模型的缓存不当 DeepL 的用
    const r3 = await run({ url: URL_EN, body: json3(lines), args: ARGS(K1), store: r.store });
    assert.ok(deeplCalls(r3).length > 0 && events(r3.out)[0] === lines[0] + '\n译:' + lines[0]);
    console.log(`ok  大模型：字幕分 ${calls.length} 组同时翻，带视频标题、前 10 句和后 6 句，DeepL 不用，缓存分开`);
  }

  // 18. 大模型 key 无效（401）：暂停 7 天、换下一个；都不行马上用 DeepL，不等到截止
  {
    const r = await run({ url: URL_EN, body: json3(['Hi there']), args: ARGS(K1, LLM(L1) + '&budget=8'), llm: { status: 401 } });
    assert.deepStrictEqual(events(r.out), ['Hi there\n译:Hi there']);
    assert.ok(r.seconds < 1, `大模型用不了应该马上兜底，实际 ${r.seconds} 秒`);
    const paused = Object.values(state(r.store).paused).map((t) => t - Math.floor(Date.now() / 1000));
    assert.ok(paused.length === 1 && paused[0] > 7 * 86400 - 100, '401 暂停 7 天');
    const r2 = await run({ url: URL_EN.replace('vid1', 'vid2'), body: json3(['Bye']), args: ARGS(K1, LLM(`${L1}|${L2}`)), store: r.store });
    assert.deepStrictEqual(llmCalls(r2).map((c) => c.key), [L2], '暂停中的 key 跳过');
    // 额度用完（429 insufficient_quota）按 24 小时暂停；普通 429 一分钟
    const r3 = await run({ url: URL_EN, body: json3(['A b']), args: ARGS(K1, LLM()), llm: { status: 429, error: '{"error":{"code":"insufficient_quota"}}' } });
    const p3 = Object.values(state(r3.store).paused)[0] - Math.floor(Date.now() / 1000);
    assert.ok(p3 > 86000 && p3 <= 86400, '额度用完暂停 24 小时');
    console.log('ok  大模型 key 无效暂停 7 天、额度用完暂停 24 小时，都用不了马上换 DeepL');
  }

  // 19. 大模型慢：快到截止先用 DeepL 顶上，大模型在截止前回来就换成大模型的
  {
    const r = await run({ url: URL_EN, body: json3(['Slow one', 'Slow two']), args: ARGS(K1, LLM() + '&budget=4'), llm: { latency: 2000 } });
    assert.deepStrictEqual(events(r.out), ['Slow one\n模:Slow one', 'Slow two\n模:Slow two']);
    assert.strictEqual(deeplCalls(r).length, 1, '截止前 2.5 秒先请求了 DeepL');
    assert.ok(r.seconds >= 1.9 && r.seconds < 3, `等大模型回来，实际 ${r.seconds} 秒`);
    console.log(`ok  大模型慢：先请求 DeepL 兜底，大模型 ${r.seconds.toFixed(1)} 秒回来后用大模型的`);
  }

  // 20. 大模型卡死：到截止返回 DeepL 的；下次打开交给大模型重翻，DeepL 的缓存只当兜底不再请求
  {
    const r = await run({ url: URL_EN, body: json3(['Stuck one', 'Stuck two']), args: ARGS(K1, LLM() + '&budget=4'), llm: { status: 'hang' } });
    assert.deepStrictEqual(events(r.out), ['Stuck one\n译:Stuck one', 'Stuck two\n译:Stuck two']);
    assert.ok(r.seconds >= 3.9 && r.seconds < 4.6, `应该在截止时返回，实际 ${r.seconds} 秒`);
    const r2 = await run({ url: URL_EN, body: json3(['Stuck one', 'Stuck two']), args: ARGS(K1, LLM() + '&budget=4'), store: r.store });
    assert.deepStrictEqual(events(r2.out), ['Stuck one\n模:Stuck one', 'Stuck two\n模:Stuck two']);
    assert.strictEqual(deeplCalls(r2).length, 0);
    const r3 = await run({ url: URL_EN, body: json3(['Stuck one', 'Stuck two']), args: ARGS(K1, LLM()), store: r2.store });
    assert.strictEqual(r3.calls.length, 0, '大模型翻好后走缓存');
    console.log(`ok  大模型卡死：${r.seconds.toFixed(1)} 秒返回 DeepL 的，下次换成大模型的，之后走缓存`);
  }

  // 21. 大模型漏了一句：这一句用 DeepL；多包一层也认得；gpt-5 关掉思考，模型不认就去掉参数重试；自定义接口
  {
    const r = await run({ url: URL_EN, body: json3(['One', 'Two', 'Three']), args: ARGS(K1, LLM() + '&budget=3'), llm: { drop: 2, wrap: true } });
    assert.deepStrictEqual(events(r.out), ['One\n模:One', 'Two\n译:Two', 'Three\n模:Three']);
    assert.deepStrictEqual(deeplCalls(r).map((c) => c.cues), [1], '只有漏掉的那句交给 DeepL');

    const r2 = await run({ url: URL_EN, body: json3(['Hey']), args: ARGS(K1, LLM() + '&model=gpt-5-mini&api=https://llm.example.com/v1/') });
    assert.deepStrictEqual([llmCalls(r2)[0].url, llmCalls(r2)[0].model, llmCalls(r2)[0].effort], ['https://llm.example.com/v1/chat/completions', 'gpt-5-mini', 'minimal']);
    const r3 = await run({ url: URL_EN, body: json3(['Hey']), args: ARGS(K1, LLM() + '&model=gpt-5.4-nano'), llm: { status: 400, error: '{"error":{"message":"Unsupported value: reasoning_effort"}}' } });
    assert.deepStrictEqual(llmCalls(r3).map((c) => c.effort), ['none', 'low', undefined], '不认这一档就退到 low，再不认就去掉');
    // 按模型自动选思考档位；参数「大模型思考」可以指定或者不带
    const effortOf = async (extra) => llmCalls(await run({ url: URL_EN, body: json3(['Hey']), args: ARGS(K1, LLM() + extra) }))[0].effort;
    assert.strictEqual(await effortOf('&model=gpt-6-sol'), 'none');
    assert.strictEqual(await effortOf('&model=openai/gpt-6-luna'), 'none', 'OpenRouter 的写法');
    assert.strictEqual(await effortOf('&model=gpt-6.1-sol'), 'low', 'GPT-6.1 Sol 没有 none');
    assert.strictEqual(await effortOf('&model=gpt-6-astra'), 'low');
    assert.strictEqual(await effortOf('&model=gpt-4.1-mini'), undefined, '不会思考的模型不带');
    assert.strictEqual(await effortOf('&model=deepseek-chat'), undefined);
    assert.strictEqual(await effortOf('&effort=off'), undefined, 'off 不带参数');
    assert.strictEqual(await effortOf('&effort=LOW'), 'low', '照填');
    assert.strictEqual(await effortOf('&effort=填错了'), 'none', '填错按 auto');
    // 占位文字当没填
    const r4 = await run({ url: URL_EN, body: json3(['Hey']), args: ARGS(K1, '&llmkeys=不用大模型就留着') });
    assert.strictEqual(llmCalls(r4).length, 0);
    console.log('ok  大模型漏句用 DeepL 补、多包一层也认，按模型关思考、可以指定，不认就退一档重试，占位文字当没填');
  }

  // 22. 大模型翻评论：带视频标题（从 token 解出视频 ID），缓存带前缀；回复用最近的视频标题
  {
    const r = await runComments({ upstream: commentsPb(COMMENTS), extra: LLM() });
    assert.deepStrictEqual(commentTexts(r.out.response.body), [
      'Great video, thanks!\n模:Great video, thanks!', '这个视频太棒了', '😂😂😂',
      'Watch the Eclipse⁠关联 tonight\n模:Watch the Eclipse tonight', 'すごい動画です\n模:すごい動画です', 'Great video, thanks!\n模:Great video, thanks!',
    ]);
    const calls = llmCalls(r);
    assert.strictEqual(deeplCalls(r).length, 0);
    assert.deepStrictEqual(r.calls.filter((c) => c.vendor === 'oembed').map((c) => c.id), ['dQw4w9WgXcQ']);
    assert.strictEqual(calls[0].payload.video, 'Never Gonna Give You Up — Rick Astley');
    assert.ok(calls[0].system.includes('YouTube comments'));
    assert.strictEqual(calls.reduce((n, c) => n + c.n, 0), 3, '重复的只翻一次');
    const r2 = await runComments({ upstream: commentsPb(COMMENTS), store: r.store, extra: LLM() });
    assert.strictEqual(r2.calls.filter((c) => c.vendor !== 'upstream').length, 0, '第二次全走缓存');
    const r3 = await runComments({ upstream: commentsPb(['Nice reply']), browseId: 'FEcomment_watch_replies_panel', store: r.store, extra: LLM() });
    assert.strictEqual(llmCalls(r3)[0].payload.video, 'Never Gonna Give You Up — Rick Astley', '回复用最近的视频');
    console.log('ok  大模型翻评论：带视频标题，缓存生效，回复里也知道是哪个视频');
  }

  // 23. 评论：大模型用不了时，以前 DeepL 翻过的直接用，不重复请求
  {
    const r = await runComments({ upstream: commentsPb(COMMENTS) });
    const r2 = await runComments({ upstream: commentsPb(COMMENTS), store: r.store, extra: LLM(), llm: { status: 401 } });
    assert.strictEqual(commentTexts(r2.out.response.body)[0], 'Great video, thanks!\n译:Great video, thanks!');
    assert.strictEqual(deeplCalls(r2).length, 0);
    assert.strictEqual(llmCalls(r2).length, 1);
    console.log('ok  评论：大模型用不了时用以前 DeepL 的缓存，不再花 DeepL 额度');
  }

  // 24. 译法：默认贴着原文翻（学英语对照），natural 可以意译；字幕和评论都按它，换了译法不用旧缓存
  {
    const r = await run({ url: URL_EN, body: json3(['so basically']), args: ARGS(K1, LLM()) });
    const sys = llmCalls(r)[0].system;
    assert.ok(sys.includes('translate faithfully, not freely') && sys.includes('tone') && sys.includes('technical terms'), '默认贴着原文');
    assert.ok(!sys.includes('Free rephrasing'));
    const r2 = await run({ url: URL_EN, body: json3(['so basically']), args: ARGS(K1, LLM() + '&style=natural'), store: r.store });
    assert.strictEqual(llmCalls(r2).length, 1, '换了译法重新翻，不用旧缓存');
    assert.ok(llmCalls(r2)[0].system.includes('Free rephrasing') && !llmCalls(r2)[0].system.includes('faithfully'));
    const c = await runComments({ upstream: commentsPb(['Nice one']), extra: LLM() });
    assert.ok(llmCalls(c)[0].system.includes('translate faithfully'), '评论也贴着原文');
    const c2 = await runComments({ upstream: commentsPb(['Nice one']), store: c.store, extra: LLM() + '&style=natural' });
    assert.ok(llmCalls(c2).length === 1 && llmCalls(c2)[0].system.includes('Free rephrasing'), '评论换了译法也重新翻');
    console.log('ok  译法：默认贴着原文翻，natural 可以意译，字幕和评论都按它，缓存分开');
  }

  // 25. 视频概要：整条字幕先读一遍，每组带上视频讲什么和用得上的术语；存下来只做一次；评论也带上
  {
    const lines = Array.from({ length: 60 }, (_, i) => i === 30 ? 'and that is the end of the talk' : `so this is caption number ${i}`);
    const r = await run({ url: URL_EN, body: json3(lines), args: ARGS(K1, LLM()) });
    const sums = r.calls.filter((c) => c.vendor === 'llm-summary');
    assert.strictEqual(sums.length, 1, '做一次概要');
    assert.strictEqual(sums[0].payload.transcript, lines.join('\n'), '整条字幕都发过去');
    assert.strictEqual(sums[0].payload.video, 'Fixing a squeaky door — Handy Dan');
    assert.strictEqual(sums[0].effort, 'none');
    assert.ok(sums[0].system.includes('"terms"') && sums[0].system.includes('"fixes"'));
    const calls = llmCalls(r);
    assert.ok(calls.every((c) => c.payload.summary && c.payload.summary.topic === 'A talk about captions.'), '每组都带视频讲什么');
    assert.ok(calls.every((c) => c.payload.summary.terms.caption === '字幕' && !('unused' in c.payload.summary.terms)), '只带这一组用得上的术语');
    const withTalk = calls.filter((c) => c.payload.summary.fixes);
    assert.ok(withTalk.length >= 1 && withTalk.every((c) => JSON.stringify(c.payload).includes('the talk')), '听错的词只给出现它的组');
    assert.deepStrictEqual(Object.keys(calls[0].payload).slice(0, 2), ['video', 'summary']);
    assert.ok(calls[0].system.includes('"summary"'));

    // 换了译法要重翻字幕，概要不再做
    const r2 = await run({ url: URL_EN, body: json3(lines), args: ARGS(K1, LLM() + '&style=natural'), store: r.store });
    assert.strictEqual(r2.calls.filter((c) => c.vendor === 'llm-summary').length, 0, '概要存下来了');
    assert.ok(llmCalls(r2).length > 0 && llmCalls(r2).every((c) => c.payload.summary.topic === 'A talk about captions.'));

    // 字幕太短、关掉概要：不做
    const r3 = await run({ url: URL_EN.replace('vid1', 'short'), body: json3(lines.slice(0, 20)), args: ARGS(K1, LLM()) });
    assert.strictEqual(r3.calls.filter((c) => c.vendor === 'llm-summary').length, 0, '短字幕不做概要');
    const r4 = await run({ url: URL_EN.replace('vid1', 'off'), body: json3(lines), args: ARGS(K1, LLM() + '&summary=false') });
    assert.strictEqual(r4.calls.filter((c) => c.vendor === 'llm-summary').length, 0, 'summary=false 不做');
    assert.ok(llmCalls(r4).every((c) => !c.payload.summary));

    // 概要卡住：最多等限时的一半，不带概要接着翻
    const r5 = await run({ url: URL_EN.replace('vid1', 'slow'), body: json3(lines), args: ARGS(K1, LLM() + '&budget=6'), llm: { summary: 'hang' } });
    assert.ok(r5.seconds >= 2.9 && r5.seconds < 6.5, `等了 ${r5.seconds} 秒`);
    assert.ok(llmCalls(r5).length > 0 && llmCalls(r5).every((c) => !c.payload.summary));
    assert.ok(events(r5.out).every((l, i) => l === lines[i] + '\n模:' + lines[i]), '没等到概要也照样用大模型翻');

    // 评论：有这个视频的概要就带上视频讲什么；回复用最近的
    const store = { 'yt-video-summaries': JSON.stringify([['dQw4w9WgXcQ|ZH-HANS', { topic: 'A music video.', terms: {}, fixes: {} }]]) };
    const c = await runComments({ upstream: commentsPb(['Classic song']), store, extra: LLM() });
    assert.strictEqual(llmCalls(c)[0].payload.topic, 'A music video.');
    assert.ok(llmCalls(c)[0].system.includes('"topic"'));
    const c2 = await runComments({ upstream: commentsPb(['Nice reply here']), browseId: 'FEcomment_watch_replies_panel', store: c.store, extra: LLM() });
    assert.strictEqual(llmCalls(c2)[0].payload.topic, 'A music video.', '回复用最近的概要');
    const c3 = await runComments({ upstream: commentsPb(['Classic tune']), extra: LLM() });
    assert.ok(!('topic' in llmCalls(c3)[0].payload), '没有概要就不带');
    console.log(`ok  视频概要：整条字幕读一遍，${calls.length} 组都带上概要和用得上的术语，只做一次；卡住不等；评论也带视频讲什么`);
  }

  // 17. 字幕导出：处理字幕时记下时间和译文，导出页面给双语 / 原文 / 译文的 SRT 和纯文本
  {
    const r = await run({ url: URL_EN.replace('vid1', 'exp1'), body: json3(['Hello there', 'How are you', 'Hello there']), args: ARGS(K1) });
    const page = await runExport('https://yt-subtitles.internal/?v=exp1', r.store);
    assert.strictEqual(page.status, 200);
    assert.ok(page.headers['Content-Type'].startsWith('text/html'));
    assert.ok(page.body.includes('3 句，译文 3 句') && page.body.includes('下载双语 SRT') && page.body.includes('mode=original&fmt=srt'), page.body);
    const srt = await runExport('https://yt-subtitles.internal/?v=exp1&mode=both&fmt=srt', r.store);
    assert.strictEqual(srt.headers['Content-Disposition'], 'attachment; filename="exp1.en.zh-hans.srt"');
    assert.strictEqual(srt.body, '1\n00:00:00,000 --> 00:00:01,000\nHello there\n译:Hello there\n\n2\n00:00:01,000 --> 00:00:02,000\nHow are you\n译:How are you\n\n3\n00:00:02,000 --> 00:00:03,000\nHello there\n译:Hello there\n');
    const orig = await runExport('https://yt-subtitles.internal/?v=exp1&mode=original&fmt=srt', r.store);
    assert.ok(orig.body.startsWith('1\n00:00:00,000 --> 00:00:01,000\nHello there\n\n2'));
    const tr = await runExport('https://yt-subtitles.internal/?v=exp1&mode=translation&fmt=txt', r.store);
    assert.strictEqual(tr.body, '译:Hello there\n译:How are you\n译:Hello there\n');
    assert.ok(tr.headers['Content-Type'].startsWith('text/plain'));

    // 没打开过字幕的视频：提示先打开字幕
    const none = await runExport('https://yt-subtitles.internal/?v=nope', r.store);
    assert.ok(none.body.includes('还没有这个视频的字幕'));

    // 只记最近 2 个视频；中文字幕（跳过翻译）也能导出原文
    const r2 = await run({ url: URL_EN.replace('vid1', 'exp2').replace('lang=en', 'lang=zh-Hans'), body: json3(['你好']), args: ARGS(K1), store: r.store });
    const r3 = await run({ url: URL_EN.replace('vid1', 'exp3'), body: json3(['Third']), args: ARGS(K1), store: r2.store });
    assert.ok((await runExport('https://yt-subtitles.internal/?v=exp1', r3.store)).body.includes('还没有'));
    const zh = await runExport('https://yt-subtitles.internal/?v=exp2', r3.store);
    assert.ok(zh.body.includes('没有译文') && zh.body.includes('下载 SRT'));
    assert.strictEqual((await runExport('https://yt-subtitles.internal/?v=exp2&mode=original&fmt=txt', r3.store)).body, '你好\n');
    console.log('ok  字幕导出：双语 / 原文 / 译文 SRT 和纯文本，没打开过字幕有提示，只记最近 2 个视频，中文字幕也能导出');
  }

  // 17b. 导出页不带视频 ID（菜单拿不到 ID 时）：显示最近打开过字幕的视频
  {
    const store = {};
    await run({ url: URL_EN.replace('vid1', 'old1'), body: json3(['Old one']), args: ARGS(K1), store });
    await run({ url: URL_EN.replace('vid1', 'new1'), body: json3(['New one']), args: ARGS(K1), store });
    const latest = await runExport('https://yt-subtitles.internal/', store);
    assert.ok(latest.body.includes('视频 new1') && latest.body.includes('v=new1&mode=both&fmt=srt'), latest.body);
    assert.ok((await runExport('https://yt-subtitles.internal/', {})).body.includes('还没有这个视频的字幕'));
    console.log('ok  导出页不带视频 ID 时显示最近打开过字幕的视频');
  }

  // 17c. 字幕数据不对（json3 没有 events，含 YouTube 自带翻译的轨道）：马上原样放行，不能卡到 App 报「加载字幕时出错」
  {
    for (const url of [URL_EN, URL_EN + '&tlang=zh-Hans']) {
      const r = await run({ url, body: '{"wireMagic":"pb3"}', args: ARGS(K1) });
      assert.deepStrictEqual(r.out, {});
      assert.ok(r.seconds < 1, `应该马上放行，实际 ${r.seconds} 秒`);
    }
    const r2 = await run({ url: URL_EN, body: '{not json', args: ARGS(K1) });
    assert.deepStrictEqual(r2.out, {});
    assert.ok(r2.seconds < 1);
    console.log('ok  字幕数据不对时马上原样放行，不会卡住');
  }

  // 17d. 翻译超时、脚本被兜底提前返回：字幕照样已经记下，可以导出原文
  {
    const store = {};
    const r = await run({ url: URL_EN.replace('vid1', 'slow1'), body: json3(['First line', 'Second line']), args: ARGS(K1, '&budget=3'), behavior: { [K1]: 'hang' }, store });
    assert.deepStrictEqual(r.out, {}, '超时原样返回');
    const page = await runExport('https://yt-subtitles.internal/', store);
    assert.ok(page.body.includes('视频 slow1') && page.body.includes('2 句，没有译文'), page.body);
    // 地址里没有 v=：照样记下，导出页显示最近的
    const store2 = {};
    await run({ url: 'https://www.youtube.com/api/timedtext?lang=en&fmt=json3', body: json3(['No id here']), args: ARGS(K1), store: store2 });
    assert.ok((await runExport('https://yt-subtitles.internal/', store2)).body.includes('1 句，译文 1 句'));
    console.log('ok  翻译超时也能导出原文；地址里没有视频 ID 也照样记下');
  }

  // 17e. 整句文稿：自动字幕没有标点，攒到 400 字左右、在停顿最长的地方分段；一段英文一段中文，几段打包、带上下文翻
  {
    const store = {};
    // 每句 3 秒；每 12 句后停顿 6 秒，分段应该落在这些停顿上
    const events = [];
    let t = 0;
    for (let i = 0; i < 120; i++) {
      events.push({ tStartMs: t, dDurationMs: 3000, segs: [{ utf8: `piece ${i} of the long talk` }] });
      t += i % 12 === 11 ? 9000 : 3000;
    }
    await run({ url: URL_EN, body: JSON.stringify({ events }), args: ARGS(K1), store });
    const r = await runExport('https://yt-subtitles.internal/?v=vid1&fmt=doc', store);
    const en = [...r.body.matchAll(/<p class="en">([^<]*)<\/p>/g)].map((m) => m[1]);
    const zh = [...r.body.matchAll(/<p class="zh">([^<]*)<\/p>/g)].map((m) => m[1]);
    assert.ok(en.length >= 5 && en.length <= 12, `段数 ${en.length}`);
    assert.ok(en.slice(0, -1).every((p) => p.length >= 280 && p.length <= 650), en.map((p) => p.length).join(','));
    assert.ok(en.slice(0, -1).every((p) => Number(/piece (\d+) of the long talk$/.exec(p)[1]) % 12 === 11), '分段落在停顿上：' + en.map((p) => p.slice(-24)).join(' | '));
    assert.strictEqual(en.join(' '), events.map((e) => e.segs[0].utf8).join(' '), '合起来就是全部字幕，一句不丢');
    assert.deepStrictEqual(zh, en.map((p) => '译:' + p), '每段英文下面跟着它的中文');
    const d = r.calls.filter((c) => c.vendor === 'deepl');
    assert.ok(d.every((c) => c.xml && c.n === 1 && c.context.startsWith('Video: Fixing a squeaky door — Handy Dan')), '几段打包成一次、带视频标题');
    assert.ok(d.length >= 1 && d.length <= 3);
    // 再打开：走存好的文稿，不再请求
    const again = await runExport('https://yt-subtitles.internal/?v=vid1&fmt=doc', store);
    assert.ok(!again.calls.some((c) => c.vendor === 'deepl'));
    const txt = await runExport('https://yt-subtitles.internal/?v=vid1&fmt=doctxt', store);
    assert.strictEqual(txt.headers['Content-Disposition'], 'attachment; filename="vid1.transcript.txt"');
    assert.strictEqual(txt.body, en.map((p) => p + '\n译:' + p).join('\n\n') + '\n');
    // 首页有入口
    assert.ok((await runExport('https://yt-subtitles.internal/?v=vid1', store)).body.includes('fmt=doc'));
    console.log(`ok  整句文稿：自动字幕 120 句分成 ${en.length} 段、落在停顿上，一段英文一段中文，${d.length} 个请求带上下文，再打开走存好的`);
  }

  // 17f. 整句文稿：人工字幕有标点就按句子合段；中文字幕不翻；DeepL 用不了用 Google；上下文里有前后段
  {
    const store = {};
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} explains one small idea.`);
    // 句子跨字幕切开：每句拆成两半
    const halves = sentences.flatMap((x) => { const w = x.split(' '); return [w.slice(0, 3).join(' '), w.slice(3).join(' ')]; });
    await run({ url: URL_EN.replace('vid1', 'doc2'), body: json3(halves), args: ARGS(K1), store });
    const r = await runExport('https://yt-subtitles.internal/?v=doc2&fmt=doc', store);
    const en = [...r.body.matchAll(/<p class="en">([^<]*)<\/p>/g)].map((m) => m[1]);
    assert.ok(en.every((p) => p.endsWith('idea.')), '按句子分段，不在句子中间断开');
    assert.ok(en.slice(0, -1).every((p) => p.length >= 420));
    assert.strictEqual(en.join(' '), sentences.join(' '));

    const r2 = await runExport('https://yt-subtitles.internal/?v=doc3&fmt=doc', {
      'yt-subtitles-export': JSON.stringify([{ v: 'doc3', lang: 'en', target: 'ZH-HANS', cues: halves.map((h, i) => [i * 1000, 1000, h, '']) }]),
    }, { behavior: 456 });
    assert.ok(r2.body.includes('<p class="zh">谷:'), 'DeepL 额度用完用 Google');

    const zhStore = {};
    await run({ url: URL_EN.replace('vid1', 'doc4').replace('lang=en', 'lang=zh-Hans'), body: json3(['第一句话。', '第二句话。']), args: ARGS(K1), store: zhStore });
    const r3 = await runExport('https://yt-subtitles.internal/?v=doc4&fmt=doc', zhStore);
    assert.ok(r3.body.includes('第一句话。') && !r3.body.includes('class="zh"'));
    assert.strictEqual(r3.calls.length, 0, '中文字幕不翻');
    console.log('ok  整句文稿：人工字幕按句子分段，中文字幕不翻，DeepL 用不了用 Google');
  }

  // 17g. 评论只用 DeepL 时也带上下文：哪个视频下面的评论
  {
    const r = await runComments({ upstream: commentsPb(COMMENTS) });
    const d = r.calls.filter((c) => c.vendor === 'deepl');
    assert.ok(d.length && d.every((c) => c.context && c.context.startsWith('YouTube comments under the video: ')), JSON.stringify(d.map((c) => c.context)));
    console.log('ok  评论只用 DeepL 时也带视频标题当上下文');
  }

  // 18. 导出的时间轴：srv3（毫秒）、srv1（秒）、WebVTT；自动字幕重叠的结束时间截到下一句
  {
    const store = {};
    const srv3 = '<timedtext format="3"><body><p t="1500" d="2000">One</p><p t="3000" d="1000">Two</p></body></timedtext>';
    await run({ url: 'https://www.youtube.com/api/timedtext?v=t1&lang=en&fmt=srv3', body: srv3, args: ARGS(K1), store });
    assert.ok((await runExport('https://yt-subtitles.internal/?v=t1&mode=original&fmt=srt', store)).body.startsWith('1\n00:00:01,500 --> 00:00:03,000\nOne\n\n2\n00:00:03,000 --> 00:00:04,000\nTwo'), '重叠截到下一句开始');
    const srv1 = '<transcript><text start="3661.25" dur="1.5">Late line</text></transcript>';
    await run({ url: 'https://www.youtube.com/api/timedtext?v=t2&lang=en', body: srv1, args: ARGS(K1), store });
    assert.ok((await runExport('https://yt-subtitles.internal/?v=t2&mode=original&fmt=srt', store)).body.startsWith('1\n01:01:01,250 --> 01:01:02,750\nLate line'));
    const vtt = 'WEBVTT\n\n00:00:05.000 --> 00:00:06.500 align:start\nFive';
    await run({ url: 'https://www.youtube.com/api/timedtext?v=t3&lang=en&fmt=vtt', body: vtt, args: ARGS(K1), store });
    assert.ok((await runExport('https://yt-subtitles.internal/?v=t3&mode=original&fmt=srt', store)).body.startsWith('1\n00:00:05,000 --> 00:00:06,500\nFive'));
    console.log('ok  导出的时间轴：srv3、srv1、WebVTT 都对，重叠的截到下一句');
  }

  console.log('全部通过');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
