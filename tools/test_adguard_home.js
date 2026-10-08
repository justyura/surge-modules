#!/usr/bin/env node
// scripts/adguard-home.js 的测试：模拟 Surge 环境和 AdGuard Home 的接口。
//
//   node tools/test_adguard_home.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'adguard-home.js'), 'utf8');
const ARGS = (extra = '') => `url=https://adguard.example.com/&user=admin&action=refresh&minutes=10${extra}&password=p@ss&word`;

const STATS = {
  time_units: 'hours', num_dns_queries: 123456, num_blocked_filtering: 23000, num_replaced_safebrowsing: 400,
  num_replaced_parental: 0, num_replaced_safesearch: 0, avg_processing_time: 0.0123,
  top_blocked_domains: [{ 'ads.example.com': 5000 }, { 'track.example.net': 1200 }, { 'x.example.org': 3 }],
};

// server: { status, stats, protection, legacy, auth } 控制假服务器的行为
function run({ args = ARGS(), trigger, server = {} }) {
  const calls = [];
  const state = { protection_enabled: true, protection_disabled_duration: 0, running: true, version: 'v0.107.60', ...server.status };
  return new Promise((resolve) => {
    const reply = (cb, status, body) => setTimeout(() => cb(null, { status }, body === undefined ? '' : JSON.stringify(body)));
    const handle = (method) => (req, cb) => {
      const p = req.url.replace('https://adguard.example.com', '');
      calls.push({ method, path: p, body: req.body ? JSON.parse(req.body) : undefined, auth: req.headers.Authorization });
      if (server.down) return setTimeout(() => cb('timeout', null, null));
      if (req.headers.Authorization !== 'Basic ' + Buffer.from('admin:p@ss&word').toString('base64')) return reply(cb, 401, {});
      if (p === '/control/status') return reply(cb, 200, state);
      if (p.startsWith('/control/stats')) {
        if (server.shortInterval && p.includes('recent=')) return reply(cb, 400);
        return reply(cb, server.statsStatus || 200, STATS);
      }
      if (p === '/control/protection') {
        if (server.legacy) return reply(cb, 404);
        const b = JSON.parse(req.body);
        state.protection_enabled = b.enabled;
        state.protection_disabled_duration = b.enabled ? 0 : b.duration || 0;
        return reply(cb, 200);
      }
      if (p === '/control/dns_config') { state.protection_enabled = JSON.parse(req.body).protection_enabled; return reply(cb, 200); }
      reply(cb, 404);
    };
    const env = {
      $argument: args,
      $trigger: trigger,
      $httpClient: { get: handle('get'), post: handle('post') },
      $done: (out) => resolve({ out, calls, state }),
    };
    new Function(...Object.keys(env), CODE)(...Object.values(env));
  });
}

(async () => {
  {
    const r = await run({});
    assert.strictEqual(r.out.title, 'AdGuard Home · 防护中');
    assert.strictEqual(r.out.content, '24 小时查询 123,456 · 拦截 23,400（19.0%）\n平均响应 12.3 ms\n拦截最多 ads.example.com 5,000、track.example.net 1,200\nv0.107.60');
    assert.strictEqual(r.out['icon-color'], '#34C759');
    assert.ok(r.calls.every((c) => c.method === 'get'), '刷新不改任何东西');
    assert.ok(r.calls.some((c) => c.path === '/control/stats?recent=86400000'));
  }
  {
    // 默认 refresh：点了也只是刷新
    const r = await run({ trigger: 'button' });
    assert.ok(r.calls.every((c) => c.method === 'get'));
  }
  {
    // pause：点一下暂停 10 分钟
    const r = await run({ args: ARGS('').replace('action=refresh', 'action=pause'), trigger: 'button' });
    const set = r.calls.find((c) => c.method === 'post');
    assert.deepStrictEqual(set.body, { enabled: false, duration: 600000 });
    assert.strictEqual(r.out.title, 'AdGuard Home · 已暂停 · 还剩 10 分钟');
    assert.ok(r.out.content.endsWith('已暂停 10 分钟 · 点一下恢复'));
    // 不是点出来的（定时刷新）不切换
    const auto = await run({ args: ARGS('').replace('action=refresh', 'action=pause') });
    assert.ok(auto.calls.every((c) => c.method === 'get'));
  }
  {
    // 暂停中再点：恢复
    const r = await run({ args: ARGS('').replace('action=refresh', 'action=pause'), trigger: 'button', server: { status: { protection_enabled: false, protection_disabled_duration: 300000 } } });
    assert.deepStrictEqual(r.calls.find((c) => c.method === 'post').body, { enabled: true });
    assert.strictEqual(r.out.title, 'AdGuard Home · 防护中');
  }
  {
    // 0 分钟：一直关着；老版本没有 /protection 用 dns_config
    const r = await run({ args: ARGS('').replace('action=refresh', 'action=pause').replace('minutes=10', 'minutes=0'), trigger: 'button', server: { legacy: true } });
    const posts = r.calls.filter((c) => c.method === 'post');
    assert.deepStrictEqual(posts.map((c) => c.path), ['/control/protection', '/control/dns_config']);
    assert.deepStrictEqual(posts[1].body, { protection_enabled: false });
    assert.strictEqual(r.out.title, 'AdGuard Home · 防护已关闭');
  }
  {
    const short = await run({ server: { shortInterval: true } });
    assert.ok(short.out.content.startsWith('统计周期内查询 123,456'), '统计周期短于 24 小时用默认周期');
  }
  {
    const bad = await run({ args: ARGS().replace('p@ss&word', 'wrong') });
    assert.strictEqual(bad.out.content, '用户名或密码不对');
    assert.strictEqual(bad.out['icon-color'], '#FF3B30');
    const down = await run({ server: { down: true } });
    assert.strictEqual(down.out.content, '连不上 adguard.example.com，检查地址和网络');
    const empty = await run({ args: 'url=填AdGuard Home网页后台地址&user=&action=refresh&minutes=10&password=' });
    assert.strictEqual(empty.out.content, '模块参数里还没填 AdGuard Home 的地址');
    const noStats = await run({ server: { statsStatus: 500 } });
    assert.strictEqual(noStats.out.title, 'AdGuard Home · 防护中');
    assert.ok(noStats.out.content.startsWith('统计数据读取失败'));
  }
  {
    // 中文密码也能正确编码
    const env = { $argument: 'url=https://a.b&user=管理员&password=密码&1', $httpClient: { get: (req) => { env.auth = req.headers.Authorization; } }, $done() {} };
    new Function(...Object.keys(env).filter((k) => k !== 'auth'), CODE)(env.$argument, env.$httpClient, env.$done);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(env.auth, 'Basic ' + Buffer.from('管理员:密码&1').toString('base64'));
  }
  console.log('adguard-home: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
