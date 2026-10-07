#!/usr/bin/env node
// scripts/youtube-subtitles.js 的测试：模拟 Surge 环境和 DeepL / Google 接口。
//
//   node tools/test_subtitles.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

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

// behavior[key] = 状态码 | 'network' | 'merge'（标签被 DeepL 合并）| 'hang'（永不返回），默认 200
// vocab: 生词服务返回的 words 数组，或 'down'（连不上）、'hang'（不返回）
function run({ url, body, args, behavior = {}, store = {}, google = true, latency = 0, vocab = [] }) {
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
          const key = req.headers.Authorization.replace('DeepL-Auth-Key ', '');
          const b = JSON.parse(req.body);
          const xml = b.tag_handling === 'xml';
          const cues = xml ? b.text.join('').split('<t>').length - 1 : b.text.length;
          calls.push({ vendor: 'deepl', host: new URL(req.url).host, key, n: b.text.length, cues, xml, target: b.target_lang, source: b.source_lang });
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
function runComments({ upstream, token = 'Eg0SC2RRdzR3OVdnWGNRGAYyJCIRIgtkUXc0dzlXZ1hjUTAAeAI', browseId, headers, behavior = {}, store = {}, extra = '', keys = K1 }) {
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
          const key = req.headers.Authorization.replace('DeepL-Auth-Key ', '');
          const b = JSON.parse(req.body);
          calls.push({ vendor: 'deepl', key, n: b.text.length, xml: b.tag_handling === 'xml', source: b.source_lang });
          const how = behavior[key] ?? 200;
          if (how === 'hang') return;
          if (how !== 200) return setTimeout(() => cb(null, { status: how }, '{}'));
          setTimeout(() => cb(null, { status: 200 }, JSON.stringify({ translations: b.text.map((t) => ({ text: '译:' + t })) })));
        },
        get(req, cb) {
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

const json3 = (lines) => JSON.stringify({ wireMagic: 'pb3', events: lines.map((l, i) => ({ tStartMs: i * 1000, dDurationMs: 1000, segs: [{ utf8: l }] })) });
const events = (out) => JSON.parse(out.body).events.map((e) => e.segs.map((s) => s.utf8).join(''));
const URL_EN = 'https://www.youtube.com/api/timedtext?v=vid1&lang=en&fmt=json3';
const ARGS = (keys, extra = '') => `keys=${keys}&target=ZH-HANS&position=top&fallback=google&debug=false${extra}`;
const state = (store) => JSON.parse(store['yt-subtitles-deepl']);
const deeplCalls = (r) => r.calls.filter((c) => c.vendor === 'deepl');

(async () => {
  // 1. 第一个 key 额度用完（456），自动换第二个
  {
    const r = await run({ url: URL_EN, body: json3(['Hello', 'World & <you>']), args: ARGS(`${K1}|${K2}`), behavior: { [K1]: 456 } });
    assert.deepStrictEqual(events(r.out), ['Hello\n译:Hello', 'World & <you>\n译:World & <you>']);
    assert.deepStrictEqual(r.calls.map((c) => c.key), [K1, K2]);
    assert.strictEqual(r.calls[0].host, 'api-free.deepl.com');
    assert.strictEqual(r.calls[0].target, 'ZH-HANS');
    assert.strictEqual(r.calls[0].source, 'EN');
    const s = state(r.store);
    assert.strictEqual(s.current, K2);
    const pausedFor = Object.values(s.paused)[0] - Math.floor(Date.now() / 1000);
    assert.ok(pausedFor > 86000 && pausedFor <= 86400, '456 暂停 24 小时');
    assert.ok(!JSON.stringify(s).includes(K1), '状态里不存明文 key');

    const r2 = await run({ url: URL_EN.replace('vid1', 'vid2'), body: json3(['Next']), args: ARGS(`${K1}|${K2}`), behavior: { [K1]: 456 }, store: r.store });
    assert.deepStrictEqual(r2.calls.map((c) => c.key), [K2]);

    const r3 = await run({ url: URL_EN, body: json3(['Hello', 'World & <you>']), args: ARGS(`${K1}|${K2}`), store: r.store });
    assert.strictEqual(r3.calls.length, 0);
    console.log('ok  额度用完自动换 key、暂停 24 小时、下次直接跳过、同一视频走缓存、特殊字符不乱');
  }

  // 2. 网络错误不暂停 key；key 无效（403）暂停 7 天；Pro key 走 api.deepl.com
  {
    const r = await run({ url: URL_EN, body: json3(['A']), args: ARGS(`${K1}|${K2}|${K3}`), behavior: { [K1]: 'network', [K2]: 403 } });
    assert.deepStrictEqual(r.calls.map((c) => c.key), [K1, K2, K3]);
    assert.strictEqual(r.calls[2].host, 'api.deepl.com');
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

  // 4. 长视频：3000 句打包成很少的请求；重复句子只翻一次
  {
    const lines = Array.from({ length: 3000 }, (_, i) => `This is line number ${i}`).concat(['This is line number 0']);
    const r = await run({ url: URL_EN, body: json3(lines), args: ARGS(K1) });
    const calls = deeplCalls(r);
    assert.ok(calls.length <= 2, `3000 句应该只要 1～2 个请求，实际 ${calls.length}`);
    assert.strictEqual(calls.reduce((n, c) => n + c.cues, 0), 3000);
    assert.ok(calls.every((c) => c.xml && c.n <= 50));
    assert.strictEqual(events(r.out)[3000], 'This is line number 0\n译:This is line number 0');
    console.log(`ok  3000 句打包成 ${calls.length} 个请求，重复句子不重复翻，用时 ${r.seconds.toFixed(2)} 秒`);
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
    const r2 = await run({ url: URL_EN, body: json3(lines), args, store: r.store, latency: 100 });
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

  console.log('全部通过');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
