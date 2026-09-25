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
function run({ url, body, args, behavior = {}, store = {}, google = true, latency = 0 }) {
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

  console.log('全部通过');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
