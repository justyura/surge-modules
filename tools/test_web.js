#!/usr/bin/env node
// 网页模块的端到端测试：用假的 Surge 环境跑 scripts/web/inject.js，
// 再用 Playwright 模拟 iPhone Safari 打开改过的网页，检查实际效果。
//
//   npm i -g playwright   # 或者用已装好的
//   node tools/test_web.js
//
// 网页是本地拼出来的，模仿 x.com 的结构，不访问真实网站。
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let playwright;
try {
  playwright = require('playwright');
} catch (e) {
  playwright = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright'));
}

const INJECT = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'web', 'inject.js'), 'utf8');

// 在假的 Surge 环境里跑 inject.js
function runSurge(headers, body) {
  let result;
  new Function('$response', '$done', INJECT)({ headers, body }, (r) => { result = r; });
  return result;
}

const X_PAGE = `<!DOCTYPE html>
<html dir="ltr" lang="en" style="overflow: hidden;">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="overflow: hidden;">
<div id="react-root"><main><div style="height:3000px">timeline</div></main></div>
<div id="layers">
  <div id="nag-layer"><div data-testid="mask"></div>
    <div role="dialog" aria-modal="true"><h1>Get the full app experience</h1>
      <p>Unlock more features and see what people are talking about right now.</p>
      <a href="https://apps.apple.com/app/x/id333903271" role="button">Open X</a></div></div>
</div>
<button class="fixed" id="qr"><img src="https://abs.twimg.com/x-web/x-web/assets/scan-to-get-app-qr-1.png"></button>
<script nonce="PAGE_NONCE">window.pageInlineRan = true;</script>
<script nonce="PAGE_NONCE">
  // 过一会儿再弹一个登录框，模拟 React 复用图层：不应该被藏掉
  setTimeout(function () {
    var layer = document.createElement('div');
    layer.id = 'login-layer';
    layer.innerHTML = '<div role="dialog" aria-modal="true"><h1>Log in to X</h1><input name="user"><button>Open X</button></div>';
    document.getElementById('layers').appendChild(layer);
  }, 300);
  // 典型的弹窗广告：点页面任意位置就 window.open
  document.addEventListener('click', function () { window.open('https://ads.example.com/popunder', '_blank'); }, true);
</script>
</body></html>`;

async function open(browser, url, headers, body) {
  const out = runSurge(headers, body);
  const ctx = await browser.newContext({ ...playwright.devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/*', (route) => {
    if (route.request().url() === url) {
      return route.fulfill({ status: 200, headers: out.headers || headers, body: out.body || body });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto(url);
  await page.waitForTimeout(800);
  return { ctx, page, out, errors };
}

(async () => {
  const browser = await playwright.chromium.launch();

  // 1. 有 nonce 的 CSP（x.com 的真实情况）
  {
    const csp = "default-src 'self'; script-src 'self' 'nonce-PAGE_NONCE' 'unsafe-inline' https://abs.twimg.com; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:";
    const { ctx, page, out, errors } = await open(browser, 'https://x.com/paulg/status/1',
      { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp }, X_PAGE);
    assert.ok(out.body.includes('<script nonce="PAGE_NONCE">'), '应该复用网页自己的 nonce');
    assert.strictEqual(out.headers['Content-Security-Policy'], csp, '已有 nonce 时不改 CSP');
    const state = await page.evaluate(() => ({
      ran: window.__surgeWebClean === true,
      pageInline: window.pageInlineRan === true,
      nagHidden: getComputedStyle(document.getElementById('nag-layer')).display === 'none',
      loginVisible: getComputedStyle(document.getElementById('login-layer')).display !== 'none',
      qrHidden: getComputedStyle(document.getElementById('qr')).display === 'none',
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      bodyOverflow: getComputedStyle(document.body).overflow,
    }));
    assert.ok(state.ran, '注入的脚本要跑起来');
    assert.ok(state.pageInline, '网页自己的脚本不能被影响');
    assert.ok(state.nagHidden, '「Get the full app experience」弹窗要藏掉');
    assert.ok(state.loginVisible, '登录框不能被误藏');
    assert.ok(state.qrHidden, 'AdGuard 的 x.com 规则要生效（扫码下载按钮）');
    assert.notStrictEqual(state.bodyOverflow, 'hidden', '页面要能滚动');

    // Popup Blocker：点页面触发的 window.open 要被拦
    const popups = [];
    ctx.on('page', (p) => popups.push(p.url()));
    await page.mouse.click(200, 300);
    await page.waitForTimeout(800);
    assert.strictEqual(popups.length, 0, `弹窗广告应该被拦，实际打开了 ${popups.join(', ')}`);
    assert.deepStrictEqual(errors.filter((e) => !/Failed to load resource/.test(e)), [], '不应该有脚本错误');
    console.log('ok  x.com（CSP 带 nonce）：弹窗藏掉、登录框保留、AdGuard 规则生效、window.open 被拦');
    await ctx.close();
  }

  // 2. 严格 CSP，没有 nonce：注入脚本要自己加 nonce，网页原来被禁的内联脚本仍然被禁
  {
    const csp = "script-src 'self'";
    const body = X_PAGE.replace(/ nonce="PAGE_NONCE"/g, '');
    const { ctx, page, out } = await open(browser, 'https://x.com/home', { 'content-type': 'text/html', 'content-security-policy': csp }, body);
    const nonce = /'nonce-([A-Za-z0-9]+)'/.exec(out.headers['content-security-policy']);
    assert.ok(nonce, '应该给 script-src 加 nonce');
    const state = await page.evaluate(() => ({
      ran: window.__surgeWebClean === true,
      pageInline: window.pageInlineRan === true,
      nagHidden: getComputedStyle(document.getElementById('nag-layer')).display === 'none',
    }));
    assert.ok(state.ran && state.nagHidden, '严格 CSP 下也要生效');
    assert.ok(!state.pageInline, '网页原本被 CSP 禁掉的内联脚本不能因为我们而放行');
    console.log('ok  x.com（严格 CSP）：自己加 nonce，不放行网页原本被禁的脚本');
    await ctx.close();
  }

  // 3. 其他网站、非 HTML、没有 <head>
  {
    assert.deepStrictEqual(runSurge({ 'Content-Type': 'application/json' }, '{"a":1}'), {}, 'JSON 不处理');
    const noHead = runSurge({ 'Content-Type': 'text/html' }, '<!doctype html><p>hi</p>');
    assert.ok(/^<!doctype html><script>/.test(noHead.body), '没有 <head> 时插在 doctype 后面');
    const again = runSurge({ 'Content-Type': 'text/html' }, noHead.body);
    assert.deepStrictEqual(again, {}, '已经注入过的页面不再注入');
    const { ctx, page, errors } = await open(browser, 'https://www.zhihu.com/question/1', { 'Content-Type': 'text/html' },
      '<!doctype html><html><head></head><body><div class="OpenInAppButton">打开App</div><p id="ok">正文</p></body></html>');
    const state = await page.evaluate(() => ({
      ran: window.__surgeWebClean === true,
      textVisible: getComputedStyle(document.getElementById('ok')).display !== 'none',
    }));
    assert.ok(state.ran && state.textVisible, '知乎页面正常，正文不被藏');
    assert.deepStrictEqual(errors.filter((e) => !/Failed to load resource/.test(e)), [], '不应该有脚本错误');
    console.log('ok  其他情况：JSON 跳过、无 <head> 页面、重复注入、知乎页面无报错');
    await ctx.close();
  }

  await browser.close();
  console.log('全部通过');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
