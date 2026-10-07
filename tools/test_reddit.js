#!/usr/bin/env node
// scripts/reddit.js 的测试：模拟 Surge 环境和 DeepL / Google 接口，数据仿 Reddit App 的 GraphQL 响应。
//
//   node tools/test_reddit.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'reddit.js'), 'utf8');
const K1 = '11111111-1111-1111-1111-111111111111:fx';
const ARGS = (extra = '') => `keys=${K1}&target=ZH-HANS&translate=all&fallback=google&budget=4&debug=${process.env.DEBUG ? 'true' : 'false'}${extra}`;

// behavior: 200 | 状态码 | 'hang'；google: true | false
function run({ body, args = ARGS(), behavior = 200, google = true, store = {}, latency = 0 }) {
  const calls = [];
  const started = Date.now();
  return new Promise((resolve) => {
    const env = {
      $argument: args,
      $request: { url: 'https://gql-fed.reddit.com/' },
      $response: { body: JSON.stringify(body) },
      $persistentStore: { read: (k) => store[k] ?? null, write: (v, k) => { store[k] = v; return true; } },
      $httpClient: {
        post(req, cb) {
          const b = JSON.parse(req.body);
          calls.push({ vendor: 'deepl', texts: b.text, source: b.source_lang });
          if (behavior === 'hang') return;
          if (behavior !== 200) return setTimeout(() => cb(null, { status: behavior }, '{}'));
          setTimeout(() => cb(null, { status: 200 }, JSON.stringify({ translations: b.text.map((t) => ({ text: '译:' + t })) })), latency);
        },
        get(req, cb) {
          const q = decodeURIComponent(/[?&]q=([^&]*)/.exec(req.url)[1]);
          calls.push({ vendor: 'google', q });
          if (!google) return setTimeout(() => cb('down', null, null));
          setTimeout(() => cb(null, { status: 200 }, JSON.stringify([[['谷:' + q, q]]])));
        },
      },
      $done: (out) => resolve({ out, json: out.body ? JSON.parse(out.body) : null, calls, store, seconds: (Date.now() - started) / 1000 }),
      console: { log: (m) => process.env.DEBUG && console.error(m) },
    };
    new Function(...Object.keys(env), CODE)(...Object.values(env));
  });
}

// 一段一行；markdown 空行分段，html 一段一个 <p>，richtext 一段一个 par
const content = (md) => {
  const paras = md.split('\n\n');
  return {
    markdown: md,
    preview: md,
    html: '<div class="md">' + paras.map((p) => '<p>' + p + '</p>').join('') + '</div>',
    richtext: JSON.stringify({ document: paras.map((p) => ({ e: 'par', c: [{ e: 'text', t: p }] })) }),
  };
};
const post = (id, title, extra = {}) => ({ __typename: 'SubredditPost', id, title, isNsfw: false, content: content('Body of ' + id), ...extra });

const feed = () => ({
  data: {
    home: {
      elements: {
        edges: [
          { node: post('t3_a', 'Morning walk by the lake') },
          { node: { __typename: 'AdPost', id: 't3_ad1', title: 'Buy shoes now' } },
          { node: { __typename: 'CellGroup', id: 'g1', adPayload: { impressionId: 'x' }, cells: [] } },
          { node: { __typename: 'CellGroup', id: 'g2', cells: [{ __typename: 'AdMetadataCell' }, { __typename: 'TitleCell', title: 'Sponsored pick' }] } },
          { node: { __typename: 'CellGroup', id: 'g3', cells: [{ __typename: 'TitleCell', title: 'A quiet library corner' }, { __typename: 'ActionCell', score: 5 }] } },
          { node: post('t3_b', '今天的晚饭') },
          { node: post('t3_c', 'Weekend plans', { isNsfw: true }) },
        ],
      },
    },
  },
});

const postPage = () => ({
  data: {
    postInfoById: {
      __typename: 'SubredditPost',
      id: 't3_p',
      title: 'How do I fix a squeaky door?',
      content: content('It squeaks **every** time. See [this video](https://example.com/v).'),
      commentsPageAds: [{ __typename: 'AdPost', id: 'ad1' }],
      commentTreeAds: [{ __typename: 'AdPost', id: 'ad2' }],
      pdpCommentsAds: [{ __typename: 'AdPost', id: 'ad3' }],
      commentForest: {
        trees: [
          { depth: 0, node: { __typename: 'Comment', id: 'c1', content: content('Try a little oil on the hinge.') } },
          { depth: 0, node: { __typename: 'AdPost', id: 'ad4' } },
          { depth: 1, node: { __typename: 'Comment', id: 'c2', content: content('同意楼上') } },
          { depth: 1, node: { __typename: 'Comment', id: 'c3', content: content('👍👍') } },
          { depth: 0, node: { __typename: 'Comment', id: 'c4', content: content('Try a little oil on the hinge.') } },
        ],
      },
    },
  },
});

(async () => {
  // 1. 信息流：各种广告删掉，标题加译文，中文标题不翻，NSFW 标记不动
  {
    const r = await run({ body: feed() });
    const edges = r.json.data.home.elements.edges;
    assert.deepStrictEqual(edges.map((e) => e.node.id), ['t3_a', 'g3', 't3_b', 't3_c']);
    assert.strictEqual(edges[0].node.title, 'Morning walk by the lake\n译:Morning walk by the lake');
    assert.strictEqual(edges[1].node.cells[0].title, 'A quiet library corner\n译:A quiet library corner');
    assert.strictEqual(edges[2].node.title, '今天的晚饭');
    assert.strictEqual(edges[3].node.isNsfw, true);
    assert.strictEqual(edges[0].node.content.markdown, 'Body of t3_a\n\n译:Body of t3_a', '信息流里的帖子正文也翻');
    const d = r.calls.filter((c) => c.vendor === 'deepl');
    assert.strictEqual(d.length, 1, '一个响应一个请求');
    assert.strictEqual(d[0].source, undefined, '自动识别语言');
    console.log('ok  信息流：AdPost、adPayload、AdMetadataCell 都删掉，标题和 TitleCell 加译文，中文不翻，NSFW 不动');
  }

  // 2. 帖子页：广告位清空，评论树里的广告删掉，正文和评论的四种写法都加译文，重复的只翻一次
  {
    const r = await run({ body: postPage() });
    const p = r.json.data.postInfoById;
    assert.deepStrictEqual([p.commentsPageAds, p.commentTreeAds, p.pdpCommentsAds], [[], [], []]);
    assert.deepStrictEqual(p.commentForest.trees.map((t) => t.node.id), ['c1', 'c2', 'c3', 'c4']);
    const c1 = p.commentForest.trees[0].node.content;
    assert.strictEqual(c1.markdown, 'Try a little oil on the hinge.\n\n译:Try a little oil on the hinge.');
    assert.strictEqual(c1.preview, 'Try a little oil on the hinge.\n\n译:Try a little oil on the hinge.');
    assert.strictEqual(c1.html, '<div class="md"><p>Try a little oil on the hinge.</p><p>译:Try a little oil on the hinge.</p></div>');
    assert.deepStrictEqual(JSON.parse(c1.richtext).document[1], { e: 'par', c: [{ e: 'text', t: '译:Try a little oil on the hinge.' }] });
    assert.strictEqual(p.commentForest.trees[1].node.content.markdown, '同意楼上');
    assert.strictEqual(p.commentForest.trees[2].node.content.markdown, '👍👍');
    // markdown 去掉格式和链接地址再翻
    const texts = r.calls.filter((c) => c.vendor === 'deepl').flatMap((c) => c.texts);
    assert.ok(texts.includes('It squeaks every time. See this video.'), JSON.stringify(texts));
    assert.strictEqual(texts.filter((t) => t === 'Try a little oil on the hinge.').length, 1);
    assert.strictEqual(p.title, 'How do I fix a squeaky door?\n译:How do I fix a squeaky door?');
    console.log('ok  帖子页：三个广告位清空、评论树广告删掉，正文和评论的 markdown / preview / html / richtext 都加译文');
  }

  // 2b. 多段：一段原文一段译文交替，中文段落、空段不插译文；markdown 带格式也对得上 html、richtext
  {
    const md = 'First I sanded the **old** paint.\n\n然后上了底漆。\n\nFinally, see [my photos](https://example.com/p).';
    const c = content(md);
    c.html = '<div class="md"><p>First I sanded the <strong>old</strong> paint.</p><p>然后上了底漆。</p><p>Finally, see <a href="https://example.com/p">my photos</a>.</p></div>';
    c.richtext = JSON.stringify({ document: [
      { e: 'par', c: [{ e: 'text', t: 'First I sanded the ' }, { e: 'text', t: 'old', f: [[1, 0, 3]] }, { e: 'text', t: ' paint.' }] },
      { e: 'par', c: [{ e: 'text', t: '然后上了底漆。' }] },
      { e: 'par', c: [{ e: 'text', t: 'Finally, see ' }, { e: 'link', u: 'https://example.com/p', t: 'my photos' }, { e: 'text', t: '.' }] },
    ] });
    const body = { data: { postInfoById: { __typename: 'SubredditPost', id: 't3_m', title: 'Repainting a chair', content: c } } };
    const r = await run({ body });
    const out = r.json.data.postInfoById.content;
    assert.strictEqual(out.markdown, [
      'First I sanded the **old** paint.', '译:First I sanded the old paint.',
      '然后上了底漆。',
      'Finally, see [my photos](https://example.com/p).', '译:Finally, see my photos.',
    ].join('\n\n'));
    assert.strictEqual(out.html, '<div class="md"><p>First I sanded the <strong>old</strong> paint.</p><p>译:First I sanded the old paint.</p>'
      + '<p>然后上了底漆。</p><p>Finally, see <a href="https://example.com/p">my photos</a>.</p><p>译:Finally, see my photos.</p></div>');
    const doc = JSON.parse(out.richtext).document;
    assert.deepStrictEqual(doc.map((b) => b.c.map((n) => n.t).join('')), [
      'First I sanded the old paint.', '译:First I sanded the old paint.', '然后上了底漆。', 'Finally, see my photos.', '译:Finally, see my photos.',
    ]);
    const texts = r.calls.filter((x) => x.vendor === 'deepl').flatMap((x) => x.texts);
    assert.deepStrictEqual(texts, ['Repainting a chair', 'First I sanded the old paint.', 'Finally, see my photos.'], '一段一个 text，中文段落不发');
    console.log('ok  多段：一段原文一段译文交替，markdown / html / richtext 对得上，中文段落不翻');
  }

  // 2c. 类型名不认识也翻：只要 content 里有正文
  {
    const body = { data: { postInfoById: { __typename: 'SubredditPost', id: 't3_u', title: '你好', commentForest: { trees: [
      { node: { __typename: 'CommentTreeNodeV2', id: 'c9', content: content('Nice work on this.') } },
    ] } } } };
    const r = await run({ body });
    assert.strictEqual(r.json.data.postInfoById.commentForest.trees[0].node.content.markdown, 'Nice work on this.\n\n译:Nice work on this.');
    console.log('ok  类型名不认识的评论，只要带正文也翻');
  }

  // 2d. oauth.reddit.com 的 REST 格式：帖子 title / selftext / selftext_html，评论 body / body_html（html 转义过一次）
  {
    const esc = (h) => h.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const listing = [
      { kind: 'Listing', data: { children: [{ kind: 't3', data: {
        name: 't3_r', title: 'Best hiking boots?', selftext: 'Looking for advice.\n\nBudget is small.',
        selftext_html: esc('<div class="md"><p>Looking for advice.</p>\n\n<p>Budget is small.</p>\n</div>'),
      } }] } },
      { kind: 'Listing', data: { children: [{ kind: 't1', data: {
        name: 't1_a', body: 'Check the outlet store.', body_html: esc('<div class="md"><p>Check the outlet store.</p>\n</div>'),
        replies: { kind: 'Listing', data: { children: [{ kind: 't1', data: { name: 't1_b', body: '谢谢', body_html: esc('<div class="md"><p>谢谢</p>\n</div>') } }] } },
      } }] } },
    ];
    const r = await run({ body: listing });
    const p = r.json[0].data.children[0].data;
    assert.strictEqual(p.title, 'Best hiking boots?\n译:Best hiking boots?');
    assert.strictEqual(p.selftext, 'Looking for advice.\n\n译:Looking for advice.\n\nBudget is small.\n\n译:Budget is small.');
    const unesc = (h) => h.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    assert.strictEqual(unesc(p.selftext_html), '<div class="md"><p>Looking for advice.</p><p>译:Looking for advice.</p>\n\n<p>Budget is small.</p><p>译:Budget is small.</p>\n</div>');
    const c = r.json[1].data.children[0].data;
    assert.strictEqual(c.body, 'Check the outlet store.\n\n译:Check the outlet store.');
    assert.ok(unesc(c.body_html).includes('<p>Check the outlet store.</p><p>译:Check the outlet store.</p>'));
    assert.strictEqual(c.replies.data.children[0].data.body, '谢谢', '中文回复不翻');
    console.log('ok  REST 格式：帖子标题、正文和评论（含回复）按段翻译，转义的 html 也对得上');
  }

  // 2e. 评论多的帖子：拆成几份同时发，DeepL 每个请求 1.5 秒、限时 4 秒也能整页翻完
  {
    const trees = Array.from({ length: 300 }, (_, i) => ({ node: { __typename: 'Comment', id: 'c' + i, content: content(`Comment number ${i} says something useful.\n\nAnd a second paragraph ${i}.`) } }));
    const body = { data: { postInfoById: { __typename: 'SubredditPost', id: 't3_big', title: '大帖子', commentForest: { trees } } } };
    const r = await run({ body, latency: 1500 });
    const out = r.json.data.postInfoById.commentForest.trees;
    assert.ok(out.every((t) => t.node.content.markdown.includes('译:')), '最后一条也要翻到');
    const d = r.calls.filter((c) => c.vendor === 'deepl');
    assert.ok(d.length <= 12 && d.length >= 6, `600 段应该拆成 6～12 个请求，实际 ${d.length}`);
    assert.ok(r.seconds < 3.5, `应该两轮内翻完，实际 ${r.seconds} 秒`);
    console.log(`ok  评论多的帖子：600 段拆成 ${d.length} 个请求同时发，${r.seconds.toFixed(1)} 秒整页翻完`);
  }

  // 3. 缓存：同样的内容第二次不再请求
  {
    const r = await run({ body: postPage() });
    const r2 = await run({ body: postPage(), store: r.store });
    assert.strictEqual(r2.calls.length, 0);
    assert.strictEqual(r2.json.data.postInfoById.title, 'How do I fix a squeaky door?\n译:How do I fix a squeaky door?');
    console.log('ok  缓存：同样的内容第二次不花额度');
  }

  // 4. 翻译范围：title 只翻标题；off 只去广告
  {
    const r = await run({ body: postPage(), args: ARGS('&translate=title') });
    const p = r.json.data.postInfoById;
    assert.ok(p.title.includes('译:'));
    assert.strictEqual(p.commentForest.trees[0].node.content.markdown, 'Try a little oil on the hinge.');
    const r2 = await run({ body: feed(), args: ARGS('&translate=off') });
    assert.strictEqual(r2.calls.length, 0);
    assert.strictEqual(r2.json.data.home.elements.edges.length, 4);
    assert.strictEqual(r2.json.data.home.elements.edges[0].node.title, 'Morning walk by the lake');
    console.log('ok  翻译范围：title 只翻标题，off 只去广告');
  }

  // 5. DeepL 不行用 Google（一段一个请求）；都不行只去广告；DeepL 卡死按时返回去掉广告的版本
  {
    const r = await run({ body: feed(), behavior: 456 });
    assert.strictEqual(r.json.data.home.elements.edges[0].node.title, 'Morning walk by the lake\n谷:Morning walk by the lake');
    assert.ok(r.calls.filter((c) => c.vendor === 'google').every((c) => !c.q.includes('\n') || c.q.startsWith('Body')));
    const r2 = await run({ body: feed(), behavior: 403, google: false });
    assert.strictEqual(r2.json.data.home.elements.edges.length, 4);
    assert.strictEqual(r2.json.data.home.elements.edges[0].node.title, 'Morning walk by the lake');
    const r3 = await run({ body: feed(), behavior: 'hang', args: ARGS('&budget=2') });
    assert.strictEqual(r3.json.data.home.elements.edges.length, 4, '超时也要去广告');
    assert.ok(r3.seconds >= 3.9 && r3.seconds < 5, `应该 4 秒左右返回，实际 ${r3.seconds}`);
    console.log(`ok  DeepL 失败用 Google，都失败只去广告，卡死时 ${r3.seconds.toFixed(1)} 秒返回去掉广告的版本`);
  }

  // 6. 没广告、不用翻译：原样放行；不是 JSON：放行
  {
    const r = await run({ body: { data: { user: { name: '同一个名字' } } } });
    assert.deepStrictEqual(r.out, {});
    console.log('ok  没有要改的就原样放行');
  }

  console.log('全部通过');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
