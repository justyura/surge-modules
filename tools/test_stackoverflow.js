#!/usr/bin/env node
// scripts/stackoverflow.js 的测试：模拟 Surge 环境和 DeepL / Google 接口，数据仿 api.stackexchange.com 的响应。
//
//   node tools/test_stackoverflow.js
//   node tools/test_stackoverflow.js resp.json   # 另外拿一个存下来的真实接口响应跑一遍，打印翻了多少
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'stackoverflow.js'), 'utf8');
const K1 = '11111111-1111-1111-1111-111111111111:fx';
const ARGS = (extra = '') => `keys=${K1}&target=ZH-HANS&translate=all&fallback=google&answers=10&budget=4&debug=true${extra}`;

// 假 DeepL：<code> 和标签不动，其他文字转大写，前面加「译:」
const fakeDeepl = (t) => '译:' + t.split(/(<code>[\s\S]*?<\/code>|<[^>]+>|&[#\w]+;)/).map((p, k) => (k % 2 ? p : p.toUpperCase())).join('');

// deepl: 200 | 状态码 | 'hang'；google: true | false
function run({ body, args = ARGS(), deepl = 200, google = true, store = {}, raw }) {
  const calls = [];
  const logs = [];
  return new Promise((resolve) => {
    const env = {
      $argument: args,
      $request: { url: 'https://api.stackexchange.com/2.3/questions/1' },
      $response: { body: raw ?? JSON.stringify(body) },
      $persistentStore: { read: (k) => store[k] ?? null, write: (v, k) => { store[k] = v; return true; } },
      $httpClient: {
        post(req, cb) {
          const b = JSON.parse(req.body);
          calls.push({ vendor: 'deepl', texts: b.text, tags: b.tag_handling, ignore: b.ignore_tags });
          if (deepl === 'hang') return;
          if (deepl !== 200) return setTimeout(() => cb(null, { status: deepl }, '{}'));
          setTimeout(() => cb(null, { status: 200 }, JSON.stringify({ translations: b.text.map((t) => ({ text: fakeDeepl(t) })) })));
        },
        get(req, cb) {
          const q = decodeURIComponent(/[?&]q=([^&]*)/.exec(req.url)[1]);
          calls.push({ vendor: 'google', q });
          if (!google) return setTimeout(() => cb('down', null, null));
          setTimeout(() => cb(null, { status: 200 }, JSON.stringify([[[q.split('\n').map((l) => '谷:' + l).join('\n'), q]]])));
        },
      },
      $done: (out) => resolve({ out, json: out.body ? JSON.parse(out.body) : null, calls, logs, store }),
      console: { log: (m) => { logs.push(m); if (process.env.DEBUG) console.error(m); } },
    };
    new Function(...Object.keys(env), CODE)(...Object.values(env));
  });
}

const QUESTION_HTML = [
  '<p>I committed the wrong files to <a href="https://git-scm.com">Git</a> with <code>git commit -a</code>.</p>',
  '<pre class="lang-bash prettyprint-override"><code>git reset HEAD~1',
  '# do not translate this',
  '</code></pre>',
  '<h2>What I tried &amp; failed</h2>',
  '<ul>',
  '<li>First point with <code>HEAD~</code></li>',
  '<li><p>Point with a paragraph</p></li>',
  '<li>Parent item',
  '<ul>',
  '<li>Child item</li>',
  '</ul>',
  '</li>',
  '</ul>',
  '<blockquote>',
  '<p>Quoted warning from the docs</p>',
  '</blockquote>',
  '<table><tr><td>Cell text stays</td></tr></table>',
  '<p>这一段本来就是中文的。</p>',
  '<p><code>only_code()</code></p>',
  '<hr />',
  '<p>Use the reset command.<br />',
  'Then commit again.</p>',
  '',
].join('\n');

const QUESTION_MD = [
  'I committed the wrong files to [Git][1] with `git commit -a`.',
  '',
  '&lt;!-- language: lang-bash --&gt;',
  '',
  '    git reset HEAD~1',
  '    # do not translate this',
  '',
  '```',
  'fenced code',
  '',
  'still fenced',
  '```',
  '',
  '## What I tried &amp; failed',
  '',
  ' - First point with `HEAD~`',
  ' - Second **bold** point',
  '',
  '> Quoted warning from the docs',
  '',
  '---',
  '',
  '  [1]: https://git-scm.com',
].join('\r\n');

const comment = (id, body, md) => ({ comment_id: id, post_id: 1, score: 1, body, body_markdown: md });
const answer = (id, text, extra = {}) => ({
  answer_id: id, question_id: 1, score: 10 - id, body: `<p>${text}</p>\n`, body_markdown: text, comments: [], ...extra,
});

const questionPage = (answers = 2) => ({
  items: [{
    question_id: 1,
    title: 'How do I undo the &quot;most recent&quot; commits?',
    tags: ['git', 'undo'],
    owner: { display_name: 'Someone Else', user_id: 9 },
    body: QUESTION_HTML,
    body_markdown: QUESTION_MD,
    comments: [comment(11, 'See <a href="https://x.dev">this guide</a> and <code>git reflog</code>', 'See [this guide](https://x.dev) and `git reflog`')],
    answers: Array.from({ length: answers }, (_, i) => answer(i + 1, `Answer number ${i + 1} explains the fix`, i === 0 ? {
      comments: [comment(21, 'Thanks, this worked for me', 'Thanks, this worked for me')],
    } : {})),
  }],
  has_more: false,
  quota_max: 10000,
  quota_remaining: 9990,
});

async function main() {
  // ---- 问题页：HTML 正文 ----
  {
    const r = await run({ body: questionPage() });
    const q = r.json.items[0];
    assert.strictEqual(q.title, 'How do I undo the &quot;most recent&quot; commits?\n译:HOW DO I UNDO THE &quot;MOST RECENT&quot; COMMITS?', '标题下一行');
    const html = q.body;
    const after = (orig, tr) => assert.ok(html.includes(orig + tr), `「${orig}」后面紧跟译文：\n${html}`);
    after('with <code>git commit -a</code>.</p>', '<p>译:I COMMITTED THE WRONG FILES TO GIT WITH <code>git commit -a</code>.</p>');
    after('<h2>What I tried &amp; failed</h2>', '<p>译:WHAT I TRIED &amp; FAILED</p>');
    after('<li>First point with <code>HEAD~</code>', '<br>译:FIRST POINT WITH <code>HEAD~</code></li>');
    after('<li><p>Point with a paragraph</p>', '<p>译:POINT WITH A PARAGRAPH</p></li>');
    after('<li>Parent item\n', '<br>译:PARENT ITEM<ul>');
    after('<li>Child item', '<br>译:CHILD ITEM</li>');
    after('<p>Quoted warning from the docs</p>', '<p>译:QUOTED WARNING FROM THE DOCS</p>\n</blockquote>');
    after('Then commit again.</p>', '<p>译:USE THE RESET COMMAND.<br>THEN COMMIT AGAIN.</p>');
    assert.ok(!/译:[^<]*(DO NOT TRANSLATE|CELL TEXT|中文)|中文的。<\/p><p>|only_code\(\)<\/code><\/p><p>/.test(html), '代码块、表格、中文、纯代码不翻');
    assert.ok(html.includes('<pre class="lang-bash prettyprint-override"><code>git reset HEAD~1\n# do not translate this\n</code></pre>'), '代码块原样');

    // 评论：没有段落标签，<br> 接在后面
    assert.strictEqual(q.comments[0].body, 'See <a href="https://x.dev">this guide</a> and <code>git reflog</code><br>译:SEE THIS GUIDE AND <code>git reflog</code>');
    assert.strictEqual(q.comments[0].body_markdown, 'See [this guide](https://x.dev) and `git reflog`\n\n译:SEE THIS GUIDE AND `git reflog`');
    assert.strictEqual(q.answers[0].body, '<p>Answer number 1 explains the fix</p><p>译:ANSWER NUMBER 1 EXPLAINS THE FIX</p>\n');
    assert.strictEqual(q.answers[0].comments[0].body, 'Thanks, this worked for me<br>译:THANKS, THIS WORKED FOR ME');
    assert.deepStrictEqual(q.tags, ['git', 'undo'], '标签不动');
    assert.strictEqual(q.owner.display_name, 'Someone Else', '用户名不动');

    // markdown：一段原文一段译文，代码块、注释、链接定义不动，换行保持 \r\n
    const md = q.body_markdown;
    const lines = md.split('\r\n');
    assert.ok(!md.replace(/\r\n/g, '').includes('\n'), '换行都是 \\r\\n');
    const at = (line) => lines.indexOf(line);
    assert.strictEqual(lines[at('I committed the wrong files to [Git][1] with `git commit -a`.') + 2], '译:I COMMITTED THE WRONG FILES TO GIT WITH `git commit -a`.');
    assert.strictEqual(lines[at('## What I tried &amp; failed') + 2], '译:WHAT I TRIED &amp; FAILED');
    assert.strictEqual(lines[at(' - First point with `HEAD~`  ') + 1], '   译:FIRST POINT WITH `HEAD~`', '列表项里换行接译文，缩进对齐到内容');
    assert.strictEqual(lines[at(' - Second **bold** point  ') + 1], '   译:SECOND BOLD POINT');
    assert.strictEqual(lines[at('> Quoted warning from the docs') + 2], '> 译:QUOTED WARNING FROM THE DOCS', '引用里的译文还在引用里');
    assert.ok(md.includes('```\r\nfenced code\r\n\r\nstill fenced\r\n```'), '围栏代码块原样');
    assert.ok(md.includes('    git reset HEAD~1\r\n    # do not translate this'), '缩进代码块原样');
    assert.ok(!/译:.*(LANGUAGE|FENCED|HTTPS)/.test(md), '注释、代码、链接定义不翻');

    // 同一段在 body 和 body_markdown 里只翻一次
    const sent = r.calls.flatMap((c) => c.texts);
    assert.strictEqual(new Set(sent).size, sent.length);
    assert.strictEqual(sent.filter((t) => /Quoted warning/.test(t)).length, 1);
    assert.strictEqual(r.calls[0].tags, 'html');
    assert.deepStrictEqual(r.calls[0].ignore, ['code']);
    assert.ok(!sent.some((t) => /中文|only_code|do not translate|Cell text/.test(t)), '不该翻的没发出去');
  }

  // ---- 回答太多只翻前几个，标题照翻 ----
  {
    const r = await run({ body: questionPage(15), args: ARGS('&answers=3') });
    const answers = r.json.items[0].answers;
    assert.ok(answers.slice(0, 3).every((a) => /译:/.test(a.body)));
    assert.ok(answers.slice(3).every((a) => !/译:/.test(a.body) && !/译:/.test(a.body_markdown)));
    assert.ok(r.logs.some((l) => /回答有 15 个，只翻前 3 个/.test(l)));
    const all = await run({ body: questionPage(15), args: ARGS('&answers=0') });
    assert.ok(all.json.items[0].answers.every((a) => /译:/.test(a.body)), '0 不限');
  }

  // ---- 翻译范围 ----
  {
    const post = await run({ body: questionPage(), args: ARGS('&translate=post') });
    const q = post.json.items[0];
    assert.ok(/译:/.test(q.body) && /译:/.test(q.answers[0].body));
    assert.ok(!/译:/.test(q.comments[0].body) && !/译:/.test(q.answers[0].comments[0].body), 'post 不翻评论');

    const title = await run({ body: questionPage(), args: ARGS('&translate=title') });
    assert.ok(/译:/.test(title.json.items[0].title) && !/译:/.test(title.json.items[0].body), 'title 只翻标题');

    const off = await run({ body: questionPage(), args: ARGS('&translate=off') });
    assert.deepStrictEqual(off.out, {}, 'off 原样放行');
    assert.strictEqual(off.calls.length, 0);
  }

  // ---- 列表页：只有标题 ----
  {
    const list = { items: [
      { question_id: 5, title: 'Why is my loop slow?', tags: ['c'] },
      { question_id: 6, title: '为什么我的循环很慢？', tags: ['c'] },
    ], has_more: true };
    const r = await run({ body: list });
    assert.strictEqual(r.json.items[0].title, 'Why is my loop slow?\n译:WHY IS MY LOOP SLOW?');
    assert.strictEqual(r.json.items[1].title, '为什么我的循环很慢？', '中文标题不翻');
    assert.strictEqual(r.json.has_more, true, '其他字段不动');
  }

  // ---- 缓存、DeepL 出错换 Google、超时 ----
  {
    const store = {};
    await run({ body: questionPage(), store });
    const again = await run({ body: questionPage(), store });
    assert.strictEqual(again.calls.length, 0, '第二次全走缓存');
    assert.ok(/译:/.test(again.json.items[0].answers[0].body));

    const fb = await run({ body: { items: [answer(1, 'Use <code>a &lt; b</code> here')] }, deepl: 456 });
    assert.strictEqual(fb.json.items[0].body, '<p>Use <code>a &lt; b</code> here</p><p>谷:Use a &lt; b here</p>\n', 'Google 译文转义过');
    assert.ok(fb.logs.some((l) => /暂停 86400 秒/.test(l)), '额度用完的 key 暂停一天');

    const none = await run({ body: questionPage(), deepl: 403, google: false });
    assert.deepStrictEqual(none.out, {}, '都翻不了原样放行');

    const started = Date.now();
    const hang = await run({ body: questionPage(), deepl: 'hang', google: false, args: ARGS('&budget=1') });
    assert.deepStrictEqual(hang.out, {}, 'DeepL 卡住到时间原样放行');
    assert.ok(Date.now() - started < 4000);
  }

  // ---- 不是问题数据的响应原样放行 ----
  {
    for (const raw of ['', 'not json', '{"error_id":502,"error_name":"throttle_violation"}', JSON.stringify({ items: [{ user_id: 1, display_name: 'Ann', about_me: '<p>Hello there friends</p>' }] })]) {
      const r = await run({ raw });
      assert.deepStrictEqual(r.out, {}, raw);
      assert.strictEqual(r.calls.length, 0);
    }
  }

  // ---- 译文里带了别的标签，只留文字和 <code> ----
  {
    const store = {};
    const text = 'Answer number 1 explains the fix';
    let h = 5381;
    for (const ch of text) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
    store['stackoverflow-translations'] = JSON.stringify([['ZH-HANS#' + text.length + '#' + h.toString(36), '译文<img src=x onerror=alert(1)><code>c</code>']]);
    const r = await run({ body: { items: [answer(1, text)] }, store });
    assert.strictEqual(r.json.items[0].body, '<p>Answer number 1 explains the fix</p><p>译文<code>c</code></p>\n');
  }

  if (process.argv[2]) {
    const raw = fs.readFileSync(process.argv[2], 'utf8');
    const r = await run({ raw, args: ARGS('&budget=10') });
    console.log('真实响应：', r.logs.filter((l) => /要翻|只翻/.test(l)).join(' / '));
    assert.ok(r.json, '真实响应翻译了');
  }

  console.log('stackoverflow: all tests passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
