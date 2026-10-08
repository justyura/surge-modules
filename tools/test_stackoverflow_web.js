#!/usr/bin/env node
// scripts/stackoverflow-web.js 的测试：用假的 Surge 环境跑两个脚本（插网页脚本、翻译接口），
// 再用 Playwright 打开插过脚本的网页，网页发的翻译请求也交给假 Surge 处理，检查实际效果。
// 网页是本地拼出来的，照着 Stack Overflow 问题页的结构，不访问真实网站。
//
//   node tools/test_stackoverflow_web.js
//   node tools/test_stackoverflow_web.js page.html   # 另外拿一个存下来的真实问题页跑一遍，打印翻了多少
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let playwright;
try {
  playwright = require('playwright');
} catch (e) {
  playwright = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright'));
}

const CODE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'stackoverflow-web.js'), 'utf8');
const K1 = '11111111-1111-1111-1111-111111111111:fx';
const ARGS = (extra = '') => `keys=${K1}&target=ZH-HANS&translate=all&fallback=google&debug=true${extra}`;
const URL = 'https://stackoverflow.com/questions/1/how-to-undo';

// 跑一次脚本。response 有值就是 http-response，否则是 http-request
// deepl: 200 | 状态码；google: true | false
function surge({ args = ARGS(), response, request, deepl = 200, google = true, store = {}, calls = [] }) {
  const logs = [];
  return new Promise((resolve) => {
    const env = {
      $argument: args,
      $request: request || { url: URL, method: 'GET' },
      $persistentStore: { read: (k) => store[k] ?? null, write: (v, k) => { store[k] = v; return true; } },
      $httpClient: {
        post(req, cb) {
          const b = JSON.parse(req.body);
          calls.push({ vendor: 'deepl', texts: b.text, tags: b.tag_handling, ignore: b.ignore_tags });
          if (deepl !== 200) return setTimeout(() => cb(null, { status: deepl }, '{}'));
          // 假 DeepL：<code> 里的不动，其他文字前面加「译:」
          const tr = (t) => '译:' + t.split(/(<code>[\s\S]*?<\/code>|<[^>]+>|&\w+;)/).map((p, k) => (k % 2 ? p : p.toUpperCase())).join('');
          setTimeout(() => cb(null, { status: 200 }, JSON.stringify({ translations: b.text.map((t) => ({ text: tr(t) })) })));
        },
        get(req, cb) {
          const q = decodeURIComponent(/[?&]q=([^&]*)/.exec(req.url)[1]);
          calls.push({ vendor: 'google', q });
          if (!google) return setTimeout(() => cb('down', null, null));
          setTimeout(() => cb(null, { status: 200 }, JSON.stringify([[[q.split('\n').map((l) => '谷:' + l).join('\n'), q]]])));
        },
      },
      $done: (out) => resolve({ out, calls, logs, store }),
      console: { log: (m) => { logs.push(m); if (process.env.DEBUG) console.error(m); } },
    };
    if (response) env.$response = response;
    new Function(...Object.keys(env), CODE)(...Object.values(env));
  });
}

async function ask(texts, opts = {}) {
  const r = await surge({ ...opts, request: { url: 'https://stackoverflow.com/__surge-translate', method: 'POST', body: JSON.stringify({ texts }) } });
  assert.strictEqual(r.out.response.status, 200);
  return { ...r, data: JSON.parse(r.out.response.body) };
}

const filler = Array.from({ length: 150 }, (_, i) => `<p>Filler paragraph number ${i} about rebasing, which rewrites history and should be used with care.</p>`).join('\n');

const PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>How to undo</title></head>
<body>
<div id="question-header"><h1 itemprop="name" class="fs-headline1"><a href="/questions/1/how-to-undo" class="question-hyperlink">How do I undo the most recent local commits in Git?</a></h1></div>
<div class="question">
  <div class="s-prose js-post-body" itemprop="text">
<p>I accidentally committed the wrong files to <a href="https://git-scm.com">Git</a> with <code>git commit -a</code>.</p>
<pre class="lang-bash s-code-block"><code>git reset HEAD~1
# do not translate this</code></pre>
<ul><li>First point with <code>HEAD~</code></li><li><p>Point with a paragraph</p></li><li>Parent item<ul><li>Child item</li></ul></li></ul>
<blockquote><p>Quoted warning from the docs</p></blockquote>
<p>这一段本来就是中文的。</p>
<p><code>only_code()</code></p>
  </div>
  <ul class="comments-list">
    <li id="comment-1" itemprop="comment" class="comment js-comment"><div class="comment-text"><div class="comment-body">
      <span class="comment-copy" itemprop="text">See this guide for undoing commits</span>
      &ndash; <a class="comment-user" href="/users/1">Someone</a>
    </div></div></li>
  </ul>
</div>
<div id="answer-2" class="answer js-answer">
  <div class="s-prose js-post-body" itemprop="text">
<h2>Undo a commit &amp; redo</h2>
<p>Use the reset command.<br>Then commit again.</p>
${filler}
<p id="far">The last paragraph far below.</p>
  </div>
  <div role="list" id="follow-ups-list-2">
    <div id="follow-up-3" itemprop="comment" role="listitem"><div class="d-flex fd-column">
      <div itemprop="text" class="flex--item fw-normal fs-body1"><!--[-->And if the commit was to the wrong branch, use <code>git checkout</code>.<!--]--></div>
      <time class="d-none" itemprop="datePublished">2010-10-05</time>
    </div></div>
  </div>
</div>
</body></html>`;

// 用 Playwright 打开网页：页面本身走 http-response 脚本，/__surge-translate 走 http-request 脚本
async function open(browser, html, { args = ARGS(), headers = {}, store = {}, calls = [] } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const requests = [];
  await page.route('https://stackoverflow.com/**', async (route) => {
    const req = route.request();
    if (req.url().includes('/__surge-translate')) {
      requests.push(JSON.parse(req.postData()).texts);
      const r = await surge({ args, store, calls, request: { url: req.url(), method: req.method(), body: req.postData() } });
      return route.fulfill({ status: r.out.response.status, headers: r.out.response.headers, body: r.out.response.body });
    }
    if (req.url() !== URL) return route.fulfill({ status: 404, body: '' });
    const respHeaders = { 'Content-Type': 'text/html; charset=utf-8', ...headers };
    const r = await surge({ args, response: { status: 200, headers: respHeaders, body: html } });
    route.fulfill({ status: 200, headers: r.out.headers || respHeaders, body: r.out.body || html });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  return { page, requests, errors };
}

const translations = (page) => page.$$eval('.sx-tr', (els) => els.map((e) => ({ kind: e.className, text: e.textContent, html: e.innerHTML, after: (e.previousElementSibling || e.parentElement).textContent.slice(0, 30) })));

async function main() {
  // ---- http-response：插脚本 ----
  {
    const r = await surge({ response: { status: 200, headers: { 'Content-Type': 'text/html' }, body: PAGE } });
    assert.ok(r.out.body.includes('__sxTranslate'), '问题页插了脚本');
    assert.ok(/<\/script><\/body>/.test(r.out.body), '脚本在 </body> 前面');
    assert.ok(!r.out.body.includes(K1), 'DeepL key 不进网页');

    const fragment = await surge({ response: { status: 200, headers: { 'Content-Type': 'text/html' }, body: '<li class="comment">hi</li>' } });
    assert.deepStrictEqual(fragment.out, {}, 'HTML 片段不动');
    const challenge = await surge({ response: { status: 403, headers: { 'Content-Type': 'text/html' }, body: PAGE } });
    assert.deepStrictEqual(challenge.out, {}, 'Cloudflare 验证页不动');
    const json = await surge({ response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' } });
    assert.deepStrictEqual(json.out, {}, '不是 HTML 不动');
    const off = await surge({ args: ARGS('&translate=off'), response: { status: 200, headers: { 'Content-Type': 'text/html' }, body: PAGE } });
    assert.deepStrictEqual(off.out, {}, '翻译范围 off 不插');

    const csp = await surge({ response: { status: 200, headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "script-src 'self' 'sha256-abc'" }, body: PAGE } });
    const nonce = /'nonce-([^']+)'/.exec(csp.out.headers['Content-Security-Policy'])[1];
    assert.ok(csp.out.body.includes(`<script nonce="${nonce}">`), 'CSP 加了 nonce，脚本带上');
  }

  // ---- http-request：翻译接口 ----
  {
    const store = {};
    const texts = ['Use <code>git reset</code> &amp; commit', '这一段本来就是中文的。', '<code>only_code()</code>', 'Hello world'];
    const r = await ask(texts, { store });
    assert.deepStrictEqual(r.data.translations, ['译:USE <code>git reset</code> &amp; COMMIT', '', '', '译:HELLO WORLD']);
    assert.strictEqual(r.calls.length, 1, '一个 DeepL 请求');
    assert.deepStrictEqual(r.calls[0].texts, [texts[0], texts[3]], '中文和纯代码不发');
    assert.strictEqual(r.calls[0].tags, 'html');
    assert.deepStrictEqual(r.calls[0].ignore, ['code'], '行内代码让 DeepL 跳过');

    const again = await ask(texts, { store });
    assert.strictEqual(again.calls.length, 0, '第二次走缓存');
    assert.deepStrictEqual(again.data.translations, r.data.translations);

    const fb = await ask(['Use <code>a &lt; b</code> here', 'Second line'], { deepl: 456 });
    assert.deepStrictEqual(fb.data.translations, ['谷:Use a &lt; b here', '谷:Second line'], 'DeepL 不行用 Google，结果转义过');
    assert.ok(fb.logs.some((l) => /暂停 86400 秒/.test(l)), '额度用完的 key 暂停一天');

    const none = await ask(['Hello'], { deepl: 403, google: false });
    assert.deepStrictEqual(none.data.translations, [null], '都翻不了回 null');

    const status = await surge({ request: { url: 'https://stackoverflow.com/__surge-translate', method: 'GET' } });
    assert.deepStrictEqual(JSON.parse(status.out.response.body), { module: 'ok', deepl: 'ok' }, 'GET 看状态');
  }

  // ---- 网页 ----
  const browser = await playwright.chromium.launch();
  try {
    {
      const calls = [];
      const { page, requests, errors } = await open(browser, PAGE, { calls });
      await page.waitForSelector('.sx-comment');
      await page.waitForTimeout(500);
      const tr = await translations(page);
      const has = (t) => tr.some((x) => x.text === t);
      assert.ok(has('译:HOW DO I UNDO THE MOST RECENT LOCAL COMMITS IN GIT?'), '标题');
      assert.ok(tr.some((x) => x.html === '译:I ACCIDENTALLY COMMITTED THE WRONG FILES TO GIT WITH <code>git commit -a</code>.'), '行内代码保留成 <code>');
      assert.ok(has('译:FIRST POINT WITH HEAD~') && has('译:POINT WITH A PARAGRAPH') && has('译:PARENT ITEM') && has('译:CHILD ITEM'), '列表每项');
      assert.ok(has('译:QUOTED WARNING FROM THE DOCS'), '引用');
      assert.ok(has('译:UNDO A COMMIT & REDO'), '小标题');
      assert.ok(tr.some((x) => x.html === '译:USE THE RESET COMMAND.<br>THEN COMMIT AGAIN.'), '换行保留');
      assert.ok(has('译:SEE THIS GUIDE FOR UNDOING COMMITS'), '旧版评论');
      assert.ok(!tr.some((x) => /DO NOT TRANSLATE|中文|ONLY_CODE/.test(x.text)), '代码块、中文、纯代码不翻');
      assert.ok(!has('译:THE LAST PARAGRAPH FAR BELOW.'), '离屏幕远的还没翻');
      const sent = requests.flat();
      assert.ok(!sent.some((t) => /do not translate/.test(t)), '代码块没发出去');
      assert.strictEqual(new Set(sent).size, sent.length, '同一段不重复发');

      // 列表项的位置：译文在嵌套列表前面，带 <p> 的列表项译文跟在 <p> 后面
      const parent = await page.$eval('li:has(> ul)', (li) => Array.from(li.children).map((c) => c.tagName + '.' + c.className).join(' '));
      assert.strictEqual(parent, 'DIV.sx-tr sx-block UL.');

      // 滚到底，远处的段落也翻
      await page.$eval('#far', (el) => el.scrollIntoView());
      await page.waitForFunction(() => document.querySelector('#far').nextElementSibling?.classList.contains('sx-tr'));
      await page.waitForFunction(() => document.querySelector('#follow-up-3 [itemprop="text"]').nextElementSibling?.classList.contains('sx-tr'));
      assert.ok((await translations(page)).some((x) => x.html === '译:AND IF THE COMMIT WAS TO THE WRONG BRANCH, USE <code>git checkout</code>.'), '新版评论');

      // 网页把评论重新渲染了（Svelte 补水、加载更多评论）：从网页里记着的译文补上，不再发请求
      const before = requests.length;
      await page.$eval('#follow-up-3 [itemprop="text"]', (el) => {
        const fresh = el.cloneNode(true);
        el.nextElementSibling.remove();
        el.replaceWith(fresh);
      });
      await page.waitForFunction(() => document.querySelector('#follow-up-3 [itemprop="text"]').nextElementSibling?.classList.contains('sx-tr'));
      await page.$eval('.comments-list', (ul) => {
        ul.insertAdjacentHTML('beforeend', '<li itemprop="comment" class="comment"><span class="comment-copy" itemprop="text">A newly loaded comment</span></li>');
        ul.scrollIntoView();
      });
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.sx-comment')).some((e) => e.textContent === '译:A NEWLY LOADED COMMENT'));
      assert.strictEqual(requests.length, before + 1, '重新渲染的不再请求，新评论请求一次');
      assert.strictEqual(await page.$$eval('#follow-up-3 .sx-tr', (e) => e.length), 1, '没有重复的译文');

      // 「译」按钮隐藏译文
      await page.click('#sx-toggle');
      assert.strictEqual(await page.$eval('.sx-title', (e) => getComputedStyle(e).display), 'none');
      await page.click('#sx-toggle');
      assert.notStrictEqual(await page.$eval('.sx-title', (e) => getComputedStyle(e).display), 'none');
      assert.deepStrictEqual(errors, [], '网页没报错');
      await page.close();
    }

    {
      // 不翻评论
      const { page } = await open(browser, PAGE, { args: ARGS('&translate=post') });
      await page.waitForSelector('.sx-block');
      await page.waitForTimeout(500);
      assert.strictEqual(await page.$$eval('.sx-comment', (e) => e.length), 0, 'post 不翻评论');
      assert.ok(await page.$('.sx-title'));
      await page.close();
    }

    {
      // 只翻标题，列表页
      const list = '<!DOCTYPE html><html><body><div class="s-post-summary"><h3 class="s-post-summary--content-title"><a href="/questions/9">Why is my loop slow?</a></h3>'
        + '<div class="s-prose js-post-body"><p>Not on list pages</p></div></div></body></html>';
      const { page } = await open(browser, list, { args: ARGS('&translate=title') });
      await page.waitForSelector('.sx-title');
      await page.waitForTimeout(300);
      assert.deepStrictEqual((await translations(page)).map((x) => x.text), ['译:WHY IS MY LOOP SLOW?']);
      await page.close();
    }

    {
      // 译文里带了别的标签（DeepL 出错、缓存被改），也只按文字放进网页
      const title = 'How do I undo the most recent local commits in Git?';
      let h = 5381;
      for (const ch of title) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
      const key = 'ZH-HANS#' + title.length + '#' + h.toString(36);
      const evil = '标题<img src=x onerror="window.pwned=1"><b>粗</b><code>c</code>';
      const { page } = await open(browser, PAGE, { store: { 'stackoverflow-web-translations': JSON.stringify([[key, evil]]) } });
      await page.waitForSelector('.sx-title');
      await page.waitForTimeout(300);
      assert.strictEqual(await page.$eval('.sx-title', (e) => e.innerHTML), '标题粗<code>c</code>');
      assert.strictEqual(await page.evaluate(() => window.pwned), undefined);
      await page.close();
    }

    if (process.argv[2]) {
      // 存下来的真实页面：看能找到多少段、翻了多少
      const html = fs.readFileSync(process.argv[2], 'utf8');
      const { page, requests, errors } = await open(browser, html);
      await page.waitForTimeout(2000);
      for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, 3000); await page.waitForTimeout(150); }
      await page.waitForTimeout(1500);
      const tr = await translations(page);
      const kinds = {};
      tr.forEach((x) => { kinds[x.kind] = (kinds[x.kind] || 0) + 1; });
      console.log('真实页面：', JSON.stringify(kinds), '请求', requests.length, '次，共', requests.flat().length, '段', errors.length ? '报错 ' + errors.join('; ') : '');
      tr.slice(0, 6).forEach((x) => console.log('  ', x.kind, '|', x.text.slice(0, 80)));
      if (process.env.SHOT) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: process.env.SHOT }); }
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log('stackoverflow-web: all tests passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
