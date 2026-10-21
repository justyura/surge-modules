#!/usr/bin/env node
// scripts/translate-panel.js（翻译合集的测试面板）的测试：模拟 Surge 和大模型接口。
//
//   node tools/test_translate_panel.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const fakeLlm = require('./fake_llm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'translate-panel.js'), 'utf8');
const L1 = 'sk-test-1111111111111111111111';
const L2 = 'sk-test-2222222222222222222222';
const GOOD = JSON.stringify({ 1: '然后所有人都冲向银行', 2: '同时把钱取出来' });

const D1 = '11111111-1111-1111-1111-111111111111:fx';
const D2 = '22222222-2222-2222-2222-222222222222';

// llm[key] = fake_llm 的设置，按 key 分开；deepl[key] = { used, limit } 或状态码；store = $persistentStore 里的内容
function run(args, llm = {}, { deepl = {}, store = {}, trigger } = {}) {
  const calls = [];
  return new Promise((resolve) => {
    const env = {
      $argument: args,
      $trigger: trigger,
      $persistentStore: { read: (k) => store[k] ?? null, write: (v, k) => { store[k] = v; return true; } },
      $httpClient: {
        post(req, cb) {
          const key = req.headers.Authorization.replace('Bearer ', '');
          assert.ok(fakeLlm(req, cb, calls, llm[key] || {}));
        },
        get(req, cb) {
          const key = req.headers.Authorization.replace('DeepL-Auth-Key ', '');
          calls.push({ vendor: 'deepl-usage', key, url: req.url });
          const how = deepl[key] ?? { used: 0, limit: 500000 };
          if (typeof how === 'number') return setTimeout(() => cb(null, { status: how }, '{}'));
          setTimeout(() => cb(null, { status: 200 }, JSON.stringify({ character_count: how.used, character_limit: how.limit })));
        },
      },
      $done: (panel) => resolve({ panel, calls }),
      console: { log: () => {} },
    };
    new Function(...Object.keys(env), CODE)(...Object.values(env));
  });
}

(async () => {
  // 1. 什么 key 都没填：只有 Google 兜底；连兜底都关了就是用不了
  {
    const { panel, calls } = await run('keys=可以不填&llmkeys=填你的OpenAI密钥&model=gpt-6-luna&effort=auto&target=ZH-HANS');
    assert.strictEqual(panel.title, '翻译状态 · Google');
    assert.ok(panel.content.startsWith('在用：Google（没填 DeepL 和大模型的 key）'), panel.content);
    assert.ok(panel.content.includes('最近：还没有翻译记录'));
    assert.strictEqual(calls.length, 0, '不测大模型、不查 DeepL');
    const off = await run('llmkeys=填你的OpenAI密钥&fallback=off');
    assert.strictEqual(off.panel.title, '翻译状态 · 用不了');
    assert.strictEqual(off.panel['icon-color'], '#FF3B30');
    console.log('ok  没填 key：在用 Google；兜底也关了显示用不了');
  }

  // 1b. 只用 DeepL：每个 key 剩多少字；暂停中的写到几点；最近实际用了哪个
  {
    const until = Math.floor(Date.now() / 1000) + 3600;
    const fp = (key) => { let h = 5381; for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0; return key.slice(-6) + '#' + h.toString(36); };
    const store = {
      'yt-subtitles-deepl': JSON.stringify({ paused: { [fp(D2)]: until } }),
      'translate-usage': JSON.stringify([
        { at: Math.floor(Date.now() / 1000) - 180, what: '字幕', engines: { deepl: { ok: 2, fail: 1, last: 456 }, google: { ok: 1, fail: 0, last: 0 } } },
        { at: Math.floor(Date.now() / 1000) - 600, what: '评论', engines: { deepl: { ok: 1, fail: 0, last: 0 } } },
        { at: Math.floor(Date.now() / 1000) - 900, what: '字幕', engines: { deepl: { ok: 9, fail: 0, last: 0 } } },
      ]),
    };
    const { panel, calls } = await run(`keys=${D1}|${D2}&llmkeys=填你的OpenAI密钥`, {}, { deepl: { [D1]: { used: 123456, limit: 500000 }, [D2]: 456 }, store });
    assert.strictEqual(panel.title, '翻译状态 · DeepL');
    const lines = panel.content.split('\n');
    assert.strictEqual(lines[0], '在用：DeepL，Google 兜底');
    assert.strictEqual(lines[1], '最近字幕 · 3 分钟前 · DeepL 2 次，失败 1 次（额度用完） → Google 1 次');
    assert.strictEqual(lines[2], '最近评论 · 10 分钟前 · DeepL 1 次');
    assert.strictEqual(lines.filter((l) => l.startsWith('最近字幕')).length, 1, '每种只显示最近一次');
    assert.strictEqual(lines[3], 'DeepL key 1（…1111 免费）：剩 376,544 字，已用 25%');
    assert.ok(lines[4].startsWith('DeepL key 2（…2222 Pro）：额度用完，暂停到 '), lines[4]);
    assert.strictEqual(panel['icon-color'], '#FF9500', '有 key 用不了、最近有失败：橙色');
    assert.deepStrictEqual(calls.map((c) => c.url), ['https://api-free.deepl.com/v2/usage', 'https://api.deepl.com/v2/usage']);
    console.log('ok  只用 DeepL：每个 key 剩多少字、暂停到几点，最近字幕和评论各用了哪个');
  }

  // 1c. DeepL 都用完了：实际会用 Google；一切正常是绿色
  {
    const { panel } = await run(`keys=${D1}`, {}, { deepl: { [D1]: { used: 500000, limit: 500000 } } });
    assert.strictEqual(panel.title, '翻译状态 · Google');
    assert.ok(panel.content.includes('实际会用 Google：前面的用不了'));
    assert.ok(panel.content.includes('剩 0 字，已用 100%，额度用完'));
    const ok = await run(`keys=${D1}`, {}, { deepl: { [D1]: { used: 1000, limit: 500000 } } });
    assert.strictEqual(ok.panel.title, '翻译状态 · DeepL');
    assert.strictEqual(ok.panel['icon-color'], '#34C759');
    console.log('ok  DeepL 额度用完：提示实际会用 Google；正常时绿色');
  }

  // 1d. 字幕翻译关着：面板上写出来
  {
    const { panel } = await run(`keys=${D1}`, {}, { store: { 'yt-subtitles-switch': JSON.stringify({ translate: false }) } });
    assert.ok(panel.content.split('\n')[1].startsWith('YouTube 字幕翻译：关着'), panel.content);
    console.log('ok  字幕翻译关着时面板上显示');
  }

  // 1e. 「字幕翻译」面板：点一下（$trigger 是 button）切换；自己刷新只显示，不切换
  {
    const store = {};
    const shown = await run('mode=switch', {}, { store });
    assert.strictEqual(shown.panel.title, '字幕翻译 · 开着');
    assert.strictEqual(store['yt-subtitles-switch'], undefined, '没点不改');
    const off = await run('mode=switch', {}, { store, trigger: 'button' });
    assert.strictEqual(off.panel.title, '字幕翻译 · 关着');
    assert.deepStrictEqual(JSON.parse(store['yt-subtitles-switch']), { translate: false });
    assert.strictEqual((await run('mode=switch', {}, { store })).panel.title, '字幕翻译 · 关着');
    const status = await run(`keys=${D1}`, {}, { store });
    assert.ok(status.panel.content.includes('YouTube 字幕翻译：关着'), '翻译状态面板也看得到');
    const on = await run('mode=switch', {}, { store, trigger: 'button' });
    assert.strictEqual(on.panel.title, '字幕翻译 · 开着');
    assert.strictEqual(shown.calls.length + off.calls.length + on.calls.length, 0, '不发任何请求');
    console.log('ok  字幕翻译面板：点一下切换，自动刷新只显示，不发请求');
  }

  // 2. 正常：gpt-6-luna 自动关掉思考，带上下文，译文里是银行
  {
    const { panel, calls } = await run(`llmkeys=${L1}&model=gpt-6-luna&api=https://api.openai.com/v1&effort=auto&target=ZH-HANS`, { [L1]: { reply: GOOD } });
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual([calls[0].model, calls[0].effort, calls[0].format], ['gpt-6-luna', 'none', 'json_object']);
    assert.ok(calls[0].payload.video && calls[0].payload.before.length && calls[0].payload.after.length, '带视频标题和前后几句');
    assert.ok(calls[0].system.includes('Simplified Chinese'));
    assert.ok(calls[0].system.includes('YouTube captions') && calls[0].system.includes('translate faithfully'), '用字幕的提示词，默认贴着原文');
    assert.strictEqual(panel.title, '翻译状态 · 大模型 · 大模型正常');
    assert.ok(panel.content.startsWith('在用：大模型 gpt-6-luna，DeepL / Google 兜底'), panel.content);
    assert.ok(/^gpt-6-luna · 思考 none · \d+\.\d 秒$/m.test(panel.content), panel.content);
    assert.ok(panel.content.includes('思考 token 0'));
    assert.ok(panel.content.includes('译文：然后所有人都冲向银行'));
    assert.ok(!panel.content.includes('key 1'), '只有一个 key 时不单独列');
    console.log('ok  正常：gpt-6-luna 带 none，带上下文，显示用时和译文');
  }

  // 2b. 译法 natural 也传到面板
  {
    const { calls } = await run(`llmkeys=${L1}&style=natural`, { [L1]: { reply: GOOD } });
    assert.ok(calls[0].system.includes('Free rephrasing'));
    console.log('ok  面板按「YouTube译法」测');
  }

  // 3. 思考没关掉：提示改参数
  {
    const { panel, calls } = await run(`llmkeys=${L1}&model=gpt-6-luna&effort=medium`, { [L1]: { reply: GOOD, reasoning: 320 } });
    assert.strictEqual(calls[0].effort, 'medium');
    assert.ok(panel.title.includes('有问题'));
    assert.ok(panel.content.includes('思考用了 320 token'));
    console.log('ok  思考没关掉：显示思考 token 数，提示改「大模型思考」');
  }

  // 4. 两个 key，第一个无效
  {
    const { panel, calls } = await run(`llmkeys=${L1}|${L2}&model=gpt-6-luna`, { [L1]: { status: 401 }, [L2]: { reply: GOOD } });
    assert.deepStrictEqual(calls.map((c) => c.key), [L1, L2]);
    assert.ok(panel.content.includes('key 1：key 无效；key 2：能用'), panel.content);
    assert.ok(panel.title.includes('有问题'));
    console.log('ok  多个 key：每个都测，列出哪个不能用');
  }

  // 5. 都用不了：模型名不对、额度用完
  {
    const r = await run(`llmkeys=${L1}&model=gpt-6-lunar`, { [L1]: { status: 404, error: '{"error":{"code":"model_not_found","message":"The model `gpt-6-lunar` does not exist"}}' } });
    assert.ok(r.panel.title.includes('用不了'));
    assert.ok(r.panel.content.includes('模型名不对'), r.panel.content);
    const r2 = await run(`llmkeys=${L1}`, { [L1]: { status: 429, error: '{"error":{"code":"insufficient_quota"}}' } });
    assert.ok(r2.panel.content.includes('额度用完了'));
    console.log('ok  用不了：说清楚是模型名、额度还是 key 的问题');
  }

  // 6. 模型不认 none：退到 low 再试
  {
    const { calls } = await run(`llmkeys=${L1}&model=gpt-6-luna`, { [L1]: { status: 400, error: '{"error":{"message":"Unsupported value: reasoning_effort"}}' } });
    assert.deepStrictEqual(calls.map((c) => c.effort), ['none', 'low', undefined]);
    console.log('ok  不认这一档思考：退到 low，再不认就不带');
  }

  // 7. 没结合上下文：bank 翻成了河岸
  {
    const { panel } = await run(`llmkeys=${L1}`, { [L1]: { reply: JSON.stringify({ 1: '然后大家都冲到河岸边', 2: '同时把钱拿出来' }) } });
    assert.ok(panel.content.includes('没结合上下文'));
    assert.ok(panel.title.includes('有问题'));
    console.log('ok  没结合上下文：提示 bank 应该是银行');
  }

  console.log('translate-panel: all tests passed');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
