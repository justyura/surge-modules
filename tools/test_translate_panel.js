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

// llm[key] = fake_llm 的设置，按 key 分开
function run(args, llm = {}) {
  const calls = [];
  return new Promise((resolve) => {
    const env = {
      $argument: args,
      $httpClient: {
        post(req, cb) {
          const key = req.headers.Authorization.replace('Bearer ', '');
          assert.ok(fakeLlm(req, cb, calls, llm[key] || {}));
        },
      },
      $done: (panel) => resolve({ panel, calls }),
      console: { log: () => {} },
    };
    new Function(...Object.keys(env), CODE)(...Object.values(env));
  });
}

(async () => {
  // 1. 没填 key
  {
    const { panel, calls } = await run('llmkeys=填你的OpenAI密钥&model=gpt-6-luna&effort=auto&target=ZH-HANS');
    assert.ok(panel.title.includes('没填大模型密钥'));
    assert.strictEqual(calls.length, 0);
    console.log('ok  没填 key：提示去填，不发请求');
  }

  // 2. 正常：gpt-6-luna 自动关掉思考，带上下文，译文里是银行
  {
    const { panel, calls } = await run(`llmkeys=${L1}&model=gpt-6-luna&api=https://api.openai.com/v1&effort=auto&target=ZH-HANS`, { [L1]: { reply: GOOD } });
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual([calls[0].model, calls[0].effort, calls[0].format], ['gpt-6-luna', 'none', 'json_object']);
    assert.ok(calls[0].payload.video && calls[0].payload.before.length && calls[0].payload.after.length, '带视频标题和前后几句');
    assert.ok(calls[0].system.includes('Simplified Chinese'));
    assert.ok(calls[0].system.includes('YouTube captions') && calls[0].system.includes('translate faithfully'), '用字幕的提示词，默认贴着原文');
    assert.strictEqual(panel.title, '翻译测试 · 正常');
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
