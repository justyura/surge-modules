#!/usr/bin/env node
// scripts/github.js 的测试：模拟 Surge 环境和 DeepL / Google 接口，数据仿 api.github.com 的 GraphQL 和 REST 响应，
// HTML 照着 GitHub 真实渲染出来的写法（markdown-heading、p dir="auto"、highlight 代码块）。
//
//   node tools/test_github.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'github.js'), 'utf8');
const K1 = '11111111-1111-1111-1111-111111111111:fx';
const ARGS = (extra = '') => `keys=${K1}&target=ZH-HANS&translate=all&markdown=false&fallback=google&budget=4&debug=true${extra}`;

// 假 DeepL：<code>、标签、实体不动，其他文字转大写，前面加「译:」
const fakeDeepl = (t) => '译:' + t.split(/(<code>[\s\S]*?<\/code>|<[^>]+>|&[#\w]+;)/).map((p, k) => (k % 2 ? p : p.toUpperCase())).join('');

function run({ body, raw, url = 'https://api.github.com/graphql', headers = { 'Content-Type': 'application/json' }, args = ARGS(), deepl = 200, store = {} }) {
  const calls = [];
  const logs = [];
  return new Promise((resolve) => {
    const env = {
      $argument: args,
      $request: { url },
      $response: { headers, body: raw ?? JSON.stringify(body) },
      $persistentStore: { read: (k) => store[k] ?? null, write: (v, k) => { store[k] = v; return true; } },
      $httpClient: {
        post(req, cb) {
          const b = JSON.parse(req.body);
          calls.push(b.text);
          if (deepl !== 200) return setTimeout(() => cb(null, { status: deepl }, '{}'));
          setTimeout(() => cb(null, { status: 200 }, JSON.stringify({ translations: b.text.map((t) => ({ text: fakeDeepl(t) })) })));
        },
        get(req, cb) {
          const q = decodeURIComponent(/[?&]q=([^&]*)/.exec(req.url)[1]);
          setTimeout(() => cb(null, { status: 200 }, JSON.stringify([[[q.split('\n').map((l) => '谷:' + l).join('\n'), q]]])));
        },
      },
      $done: (out) => resolve({ out, body: out.body, json: out.body && /^\s*[{[]/.test(out.body) ? JSON.parse(out.body) : null, calls: calls.flat(), logs, store }),
      console: { log: (m) => { logs.push(m); if (process.env.DEBUG) console.error(m); } },
    };
    new Function(...Object.keys(env), CODE)(...Object.values(env));
  });
}

const heading = (level, text) => `<div class="markdown-heading" dir="auto"><h${level} class="heading-element" dir="auto">${text}</h${level}><a id="user-content-x" class="anchor" aria-label="Permalink: ${text}" href="#x"><svg class="octicon octicon-link" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m7.775 3.275"></path></svg></a></div>`;

const ISSUE_HTML = [
  '<p dir="auto">The app crashes when I open <code class="notranslate">settings.json</code> on iOS.</p>',
  heading(3, 'Steps to reproduce'),
  '<ol dir="auto">',
  '<li>Open the app</li>',
  '<li>Tap <strong>Settings</strong></li>',
  '</ol>',
  '<ul class="contains-task-list">',
  '<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled=""> I searched existing issues</li>',
  '</ul>',
  '<div class="highlight highlight-source-js notranslate position-relative overflow-auto" dir="auto"><pre><span class="pl-en">crash</span>(<span class="pl-s">"do not translate"</span>)</pre></div>',
  '<blockquote>',
  '<p dir="auto">Quoted log line from the console</p>',
  '</blockquote>',
  '<markdown-accessiblity-table><table><tr><td>Cell stays</td></tr></table></markdown-accessiblity-table>',
  '<p dir="auto">这一段本来是中文。</p>',
  '<details><summary>Logs</summary>',
  '<p dir="auto">Hidden details paragraph</p>',
  '</details>',
].join('\n');

const ISSUE_MD = [
  '<!-- Please fill in the template below.',
  '',
  'Thanks for reporting! -->',
  '',
  'The app crashes when I open `settings.json` on iOS.',
  '',
  '### Steps to reproduce',
  '',
  '1. Open the app',
  '2. Tap **Settings**',
  '',
  '- [ ] I searched existing issues',
  '',
  '```js',
  'crash("do not translate")',
  '```',
].join('\n');

const comment = (id, html, extra = {}) => ({ __typename: 'IssueComment', id, bodyHTML: html, body: html.replace(/<[^>]+>/g, ''), viewerCanUpdate: false, author: { login: 'octocat', bio: 'I write code' }, ...extra });

const issuePage = (viewerCanUpdate = false) => ({
  data: {
    repository: {
      __typename: 'Repository',
      nameWithOwner: 'acme/app',
      description: 'A small app for testing things',
      descriptionHTML: '<div>A small app for testing things</div>',
      issue: {
        __typename: 'Issue',
        number: 42,
        title: 'Crash when opening settings',
        titleHTML: 'Crash when opening settings',
        viewerCanUpdate,
        bodyHTML: ISSUE_HTML,
        body: ISSUE_MD,
        comments: { nodes: [
          comment('c1', '<p dir="auto">Same here, it also fails on <code class="notranslate">v2.1</code>.</p>'),
          comment('c2', '<p dir="auto">My own reply</p>', { viewerCanUpdate: true }),
        ] },
      },
    },
  },
});

async function main() {
  // ---- GraphQL Issue 页 ----
  {
    const r = await run({ body: issuePage() });
    const repo = r.json.data.repository;
    const issue = repo.issue;
    assert.strictEqual(issue.title, 'Crash when opening settings\n译:CRASH WHEN OPENING SETTINGS', '标题');
    assert.strictEqual(issue.titleHTML, 'Crash when opening settings<br>译:CRASH WHEN OPENING SETTINGS', 'titleHTML');
    assert.strictEqual(repo.description, 'A small app for testing things\n译:A SMALL APP FOR TESTING THINGS', '仓库简介');
    assert.strictEqual(repo.descriptionHTML, '<div>A small app for testing things</div>', '简介的 HTML 不重复翻');

    const html = issue.bodyHTML;
    const after = (orig, tr) => assert.ok(html.includes(orig + tr), `「${orig}」后面紧跟译文：\n${html}`);
    after('on iOS.</p>', '<p>译:THE APP CRASHES WHEN I OPEN <code>settings.json</code> ON IOS.</p>');
    after('Steps to reproduce</h3>', '<p>译:STEPS TO REPRODUCE</p>');
    after('<li>Open the app', '<br>译:OPEN THE APP</li>');
    after('<li>Tap <strong>Settings</strong>', '<br>译:TAP SETTINGS</li>');
    after(' I searched existing issues', '<br>译:I SEARCHED EXISTING ISSUES</li>');
    after('Quoted log line from the console</p>', '<p>译:QUOTED LOG LINE FROM THE CONSOLE</p>');
    after('Hidden details paragraph</p>', '<p>译:HIDDEN DETAILS PARAGRAPH</p>');
    assert.ok(!/译:[^<]*(DO NOT TRANSLATE|CELL STAYS|中文|PERMALINK)|中文。<\/p><p>/.test(html), '代码块、表格、中文、锚点不翻');
    assert.ok(html.includes('<pre><span class="pl-en">crash</span>(<span class="pl-s">"do not translate"</span>)</pre>'), '代码块原样');

    assert.strictEqual(issue.body, ISSUE_MD, 'markdown 原文默认不动（编辑时用的是它）');
    assert.strictEqual(issue.comments.nodes[0].bodyHTML, '<p dir="auto">Same here, it also fails on <code class="notranslate">v2.1</code>.</p><p>译:SAME HERE, IT ALSO FAILS ON <code>v2.1</code>.</p>');
    assert.strictEqual(issue.comments.nodes[1].bodyHTML, '<p dir="auto">My own reply</p><p>译:MY OWN REPLY</p>', '自己的评论 HTML 照翻，只是显示');
    assert.strictEqual(issue.comments.nodes[0].author.bio, 'I write code', '用户信息不动');
    assert.ok(r.logs.some((l) => /bodyHTML×3/.test(l) && /Issue×1/.test(l)), '调试日志列出字段');
    assert.strictEqual(new Set(r.calls).size, r.calls.length, '同一段只发一次');
  }

  // 自己能编辑的 Issue：标题不翻（改标题时编辑框里不会带译文），正文 HTML 照翻
  {
    const r = await run({ body: issuePage(true) });
    const issue = r.json.data.repository.issue;
    assert.strictEqual(issue.title, 'Crash when opening settings');
    assert.strictEqual(issue.titleHTML, 'Crash when opening settings<br>译:CRASH WHEN OPENING SETTINGS', 'titleHTML 只是显示，照翻');
    assert.ok(/译:THE APP CRASHES/.test(issue.bodyHTML));
  }

  // markdown=true：别人的 markdown 也插译文，HTML 注释整块跳过，任务列表的勾选框去掉再翻；自己能编辑的不动
  {
    const r = await run({ body: issuePage(), args: ARGS('&markdown=true') });
    const md = r.json.data.repository.issue.body;
    const lines = md.split('\n');
    assert.ok(md.startsWith('<!-- Please fill in the template below.\n\nThanks for reporting! -->\n'), 'HTML 注释原样');
    assert.ok(!/译:.*(PLEASE FILL|THANKS FOR)/.test(md), 'HTML 注释不翻');
    assert.strictEqual(lines[lines.indexOf('The app crashes when I open `settings.json` on iOS.') + 2], '译:THE APP CRASHES WHEN I OPEN `settings.json` ON IOS.');
    assert.strictEqual(lines[lines.indexOf('1. Open the app  ') + 1], '   译:OPEN THE APP');
    assert.strictEqual(lines[lines.indexOf('- [ ] I searched existing issues  ') + 1], '  译:I SEARCHED EXISTING ISSUES');
    assert.ok(md.includes('```js\ncrash("do not translate")\n```'));
    const own = await run({ body: issuePage(true), args: ARGS('&markdown=true') });
    assert.strictEqual(own.json.data.repository.issue.body, ISSUE_MD, '自己能编辑的 markdown 不动');
  }

  // ---- REST：Issue 列表（body_html 是 full 格式才有） ----
  {
    const list = [
      { number: 1, title: 'Add dark mode', html_url: 'https://github.com/acme/app/issues/1', body: 'Please add dark mode', body_html: '<p dir="auto">Please add dark mode</p>', user: { login: 'a' } },
      { number: 2, title: '支持中文', html_url: 'https://github.com/acme/app/pull/2', body: null, user: { login: 'b' } },
      { number: 3, title: 'AdGuard Home 面板加暂停按钮', html_url: 'https://github.com/acme/app/issues/3', body: null },
      { number: 4, title: 'Apple TV', html_url: 'https://github.com/acme/app/issues/4', body: null },
    ];
    const r = await run({ body: list, url: 'https://api.github.com/repos/acme/app/issues' });
    assert.strictEqual(r.json[0].title, 'Add dark mode\n译:ADD DARK MODE');
    assert.strictEqual(r.json[0].body_html, '<p dir="auto">Please add dark mode</p><p>译:PLEASE ADD DARK MODE</p>');
    assert.strictEqual(r.json[0].body, 'Please add dark mode', 'markdown 不动');
    assert.strictEqual(r.json[1].title, '支持中文', '中文标题不翻');
    assert.strictEqual(r.json[2].title, 'AdGuard Home 面板加暂停按钮', '夹着英文名字的中文不翻');
  }

  // ---- README：HTML 格式 ----
  {
    const readme = '<div id="readme" class="md" data-path="README.md"><article class="markdown-body entry-content container-lg" itemprop="text">'
      + heading(1, 'acme-app') + '\n<p dir="auto">A tiny tool that syncs your notes.</p>\n'
      + '<div class="highlight highlight-source-shell notranslate position-relative overflow-auto" dir="auto"><pre>npm install acme</pre></div>\n'
      + '</article></div>';
    const r = await run({ raw: readme, url: 'https://api.github.com/repos/acme/app/readme', headers: { 'content-type': 'application/vnd.github.html; charset=utf-8' } });
    assert.ok(r.body.includes('A tiny tool that syncs your notes.</p><p>译:A TINY TOOL THAT SYNCS YOUR NOTES.</p>'));
    assert.ok(r.body.includes('<pre>npm install acme</pre>'));
    assert.ok(r.body.includes('acme-app</h1><p>译:ACME-APP</p>'), '标题');
  }

  // ---- README：base64 的 markdown（带中文和 emoji，检查编码来回不坏） ----
  {
    const md = '# acme 🚀\n\n[![build](https://img.shields.io/badge.svg)](https://ci)\n\nSyncs notes between devices — 快速。\n\n```sh\nnpm i acme\n```\n';
    const content = Buffer.from(md, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');
    const r = await run({ body: { name: 'README.md', path: 'README.md', encoding: 'base64', content }, url: 'https://api.github.com/repos/acme/app/readme' });
    const out = Buffer.from(r.json.content, 'base64').toString('utf8');
    assert.strictEqual(out, '# acme 🚀\n\n译:ACME 🚀\n\n[![build](https://img.shields.io/badge.svg)](https://ci)\n\nSyncs notes between devices — 快速。\n\n译:SYNCS NOTES BETWEEN DEVICES — 快速。\n\n```sh\nnpm i acme\n```\n');
    assert.ok(!r.calls.some((t) => /npm i|shields/.test(t)), '代码、徽章不发');
    // 不是 markdown 的 README 不动
    const txt = await run({ body: { name: 'README.txt', encoding: 'base64', content }, url: 'https://api.github.com/repos/acme/app/readme' });
    assert.deepStrictEqual(txt.out, {});
  }

  // ---- 翻译范围、缓存、兜底、无关响应 ----
  {
    const t = await run({ body: issuePage(), args: ARGS('&translate=title') });
    assert.ok(/译:/.test(t.json.data.repository.issue.title) && !/译:/.test(t.json.data.repository.issue.bodyHTML), 'title 只翻标题和简介');
    const off = await run({ body: issuePage(), args: ARGS('&translate=off') });
    assert.deepStrictEqual(off.out, {});

    const store = {};
    await run({ body: issuePage(), store });
    const again = await run({ body: issuePage(), store });
    assert.strictEqual(again.calls.length, 0, '第二次走缓存');

    const fb = await run({ body: { data: { node: comment('c9', '<p dir="auto">Use <code>a &lt; b</code> here</p>') } }, deepl: 456 });
    assert.strictEqual(fb.json.data.node.bodyHTML, '<p dir="auto">Use <code>a &lt; b</code> here</p><p>谷:Use a &lt; b here</p>');

    for (const body of [{ data: { viewer: { login: 'me', name: 'Me Myself' } } }, { data: { repository: { __typename: 'Repository', stargazerCount: 3 } } }]) {
      const r = await run({ body });
      assert.deepStrictEqual(r.out, {}, JSON.stringify(body));
    }
    assert.deepStrictEqual((await run({ raw: 'not json', headers: { 'content-type': 'text/plain' } })).out, {});
  }

  // ---- 译文里带了别的标签，只留文字和 <code> ----
  {
    const text = 'Please add dark mode';
    let h = 5381;
    for (const ch of text) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
    const store = { 'github-translations': JSON.stringify([['ZH-HANS#' + text.length + '#' + h.toString(36), '译文<img src=x onerror=alert(1)><code>c</code>']]) };
    const r = await run({ body: { data: { node: comment('c1', '<p dir="auto">Please add dark mode</p>') } }, store });
    assert.strictEqual(r.json.data.node.bodyHTML, '<p dir="auto">Please add dark mode</p><p>译文<code>c</code></p>');
  }

  console.log('github: all tests passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
