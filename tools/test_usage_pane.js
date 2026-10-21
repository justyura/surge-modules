#!/usr/bin/env node
// usage-pane.js 的测试：流量查询接口（JSON）和机场订阅链接（subscription-userinfo 响应头）两种来源。
//
//   node tools/test_usage_pane.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'usage-pane.js'), 'utf8');
const GiB = 1073741824;

// reply: { headers, body } 或 'error'
function run(argument, reply) {
  const requests = [];
  return new Promise((resolve) => {
    const env = {
      $argument: argument,
      $httpClient: {
        get(req, cb) {
          requests.push(req);
          if (reply === 'error') return setTimeout(() => cb('timeout', null, null));
          setTimeout(() => cb(null, { status: 200, headers: reply.headers || {} }, reply.body || ''));
        },
      },
      $done: (panel) => resolve({ panel, requests }),
    };
    new Function(...Object.keys(env), CODE)(...Object.values(env));
  });
}

const daysFromNow = (n) => Math.floor(Date.now() / 1000) + n * 86400;

(async () => {
  // 1. 订阅链接：按 subscription-userinfo 显示；链接里自带 ? 和 & 也完整传过去；带代理客户端的 UA
  {
    const info = `upload=${10 * GiB}; download=${30 * GiB}; total=${100 * GiB}; expire=${daysFromNow(20)}`;
    const url = 'https://sub.example.com/api/sub?token=abc&flag=surge';
    const { panel, requests } = await run(`name=我的机场&url=${url}`, { headers: { 'Subscription-Userinfo': info }, body: 'proxy list, not read' });
    assert.strictEqual(requests[0].url, url);
    assert.strictEqual(requests[0].headers['User-Agent'], 'Surge iOS');
    assert.strictEqual(panel.title, '我的机场 · 剩余 60.00 GiB');
    const lines = panel.content.split('\n');
    assert.strictEqual(lines[0], '剩余 60.00 GiB / 100.00 GiB');
    assert.strictEqual(lines[1], '已用 40.00 GiB · 40.0%（上传 10.00 · 下载 30.00）');
    assert.ok(/^到期 \d{4}-\d{2}-\d{2} · 2[01] 天$/.test(lines[2]), lines[2]);
    assert.ok(/^更新 \d{2}:\d{2}$/.test(lines[3]));
    assert.strictEqual(panel['icon-color'], '#34C759');
    console.log('ok  订阅链接：剩余、已用（上传 + 下载）、到期天数，链接原样请求');
  }

  // 2. 订阅自带名字（base64），快到期、快用完变色，没给总量、长期有效
  {
    const title = Buffer.from('好用机场').toString('base64');
    const r = await run('name=订阅流量&url=https://sub.example.com/s', { headers: { 'profile-title': 'base64:' + title, 'subscription-userinfo': `upload=0; download=${95 * GiB}; total=${100 * GiB}; expire=0` } });
    assert.strictEqual(r.panel.title, '好用机场 · 剩余 5.00 GiB');
    assert.ok(r.panel.content.includes('到期 长期有效'));
    assert.strictEqual(r.panel['icon-color'], '#FF3B30', '用了 90% 以上红色');
    const soon = await run('url=https://sub.example.com/s', { headers: { 'subscription-userinfo': `upload=0; download=${GiB}; total=${100 * GiB}; expire=${daysFromNow(3)}` } });
    assert.strictEqual(soon.panel['icon-color'], '#FF9500', '一周内到期橙色');
    assert.ok(soon.panel.title.startsWith('订阅流量 · '), '没填名字用默认');
    const noTotal = await run('url=https://sub.example.com/s', { headers: { 'subscription-userinfo': `upload=${GiB}; download=${GiB}` } });
    assert.ok(noTotal.panel.content.startsWith('已用 2.00 GiB（订阅没给总量）'));
    console.log('ok  订阅名字 base64 能解，快用完红色、快到期橙色，没给总量和长期有效也能显示');
  }

  // 3. 原来的流量查询接口（JSON）照旧
  {
    const body = JSON.stringify({ ok: true, data: { name: 'My Proxy', limit_gib: 100, bill_gib: 42.5, expires_at: '2099-12-01 00:00:00', next_reset_at: '2099-10-01', reset_days_left: 7, status: 'enabled', updated_at: '2026-09-24 12:00' } });
    const { panel } = await run('url=https://example.com/api/public/usage/token', { body });
    assert.strictEqual(panel.title, 'My Proxy · 剩余 57.50 GiB');
    assert.ok(panel.content.includes('本月已用 42.50 GiB · 42.5%'));
    console.log('ok  流量查询接口（JSON）照旧');
  }

  // 4. 出错：连不上、不是用量数据、没填地址
  {
    assert.strictEqual((await run('name=我的机场&url=https://sub.example.com/s', 'error')).panel.title, '我的机场 · 更新失败');
    assert.ok((await run('url=https://sub.example.com/s', { body: 'vmess://...' })).panel.content.includes('不是预期的用量数据'));
    const none = await run('url=填你的机场订阅链接', { body: '' });
    assert.ok(none.panel.title.includes('更新失败'));
    assert.strictEqual(none.requests.length, 0);
    console.log('ok  连不上、返回的不是用量、没填链接都提示，不乱显示');
  }

  console.log('全部通过');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
