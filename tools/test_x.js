#!/usr/bin/env node
// scripts/x.js 的测试：模拟 Surge 环境，数据仿 x.com 网页版的 GraphQL 响应。
//
//   node tools/test_x.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'x.js'), 'utf8');
const K1 = '11111111-1111-1111-1111-111111111111:fx';
const ARGS = (extra = '') => 'chinese=true&mode=normal&allow=&translate=off&debug=false' + extra;
const TR = (extra = '') => ARGS('&translate=all&keys=' + K1 + '&target=ZH-HANS&fallback=google&budget=4' + extra);
const URL = (op, vars) => `https://x.com/i/api/graphql/abc123/${op}` + (vars ? '?variables=' + encodeURIComponent(JSON.stringify(vars)) : '');

// deepl: 200 | 状态码 | 'hang'；google: true | false
function run({ body, url = URL('HomeTimeline'), args = ARGS(), deepl = 200, google = true, store = {} }) {
  const calls = [];
  const logs = [];
  return new Promise((resolve) => {
    const env = {
      $argument: args,
      $request: { url },
      $response: { body: typeof body === 'string' ? body : JSON.stringify(body) },
      $persistentStore: { read: (k) => store[k] ?? null, write: (v, k) => { store[k] = v; return true; } },
      $httpClient: {
        post(req, cb) {
          const b = JSON.parse(req.body);
          calls.push({ vendor: 'deepl', texts: b.text });
          if (deepl === 'hang') return;
          if (deepl !== 200) return setTimeout(() => cb(null, { status: deepl }, '{}'));
          setTimeout(() => cb(null, { status: 200 }, JSON.stringify({ translations: b.text.map((t) => ({ text: '译:' + t })) })));
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

const user = (screen, name, bio = '') => ({
  __typename: 'User', rest_id: 'u-' + screen,
  core: { name, screen_name: screen },
  legacy: { description: bio },
});
const tweet = (id, text, { lang = 'en', by = user('alice', 'Alice'), quoted, retweeted, note, legacy = {} } = {}) => ({
  __typename: 'Tweet', rest_id: id,
  core: { user_results: { result: by } },
  legacy: {
    full_text: text, lang, ...legacy,
    ...(retweeted ? { retweeted_status_result: { result: retweeted } } : {}),
  },
  ...(quoted ? { quoted_status_result: { result: quoted } } : {}),
  ...(note ? { note_tweet: { note_tweet_results: { result: { text: note } } } } : {}),
});
const itemContent = (t, extra = {}) => ({ itemType: 'TimelineTweet', __typename: 'TimelineTweet', tweet_results: { result: t }, ...extra });
const entry = (entryId, t, extra) => ({ entryId, sortIndex: '1', content: { entryType: 'TimelineTimelineItem', itemContent: itemContent(t, extra) } });
const cursor = (entryId) => ({ entryId, content: { entryType: 'TimelineTimelineCursor', value: 'x', cursorType: 'Bottom' } });
const moduleEntry = (entryId, items) => ({
  entryId, content: { entryType: 'TimelineTimelineModule', items: items.map(([id, content]) => ({ entryId: id, item: { itemContent: content } })) },
});
const home = (entries, extra = []) => ({ data: { home: { home_timeline_urt: { instructions: [{ type: 'TimelineAddEntries', entries }, ...extra] } } } });
const ids = (json) => json.data.home.home_timeline_urt.instructions[0].entries.map((e) => e.entryId);
const AD = { impressionId: '1', advertiser_results: { result: user('brand', 'Brand') } };

(async () => {

// 1. 首页：推广帖、中文推文删掉，英文、日文、韩文、游标留着
{
  const { json } = await run({
    body: home([
      entry('tweet-1', tweet('1', 'Hello world, this is a normal tweet')),
      entry('promoted-tweet-2-abc', tweet('2', 'Buy our stuff')),
      entry('tweet-3', tweet('3', 'Buy our stuff'), { promotedMetadata: AD }),
      entry('tweet-4', tweet('4', '今天天气不错，出去走走', { lang: 'zh' })),
      entry('tweet-5', tweet('5', '今日はいい天気ですね', { lang: 'ja' })),
      entry('tweet-6', tweet('6', '오늘 날씨가 좋네요', { lang: 'ko' })),
      entry('tweet-7', tweet('7', '这个新功能太好用了 https://t.co/abc', { lang: 'und' })),
      entry('tweet-8', tweet('8', 'I visited 北京 last year and loved it', { lang: 'en' })),
      entry('tweet-9', tweet('9', '東京', { lang: 'zh' })),  // X 标 zh 就信
      cursor('cursor-top-1'), cursor('cursor-bottom-2'),
    ]),
  });
  assert.deepStrictEqual(ids(json), ['tweet-1', 'tweet-5', 'tweet-6', 'tweet-8', 'cursor-top-1', 'cursor-bottom-2']);
}

// 2. 只去广告
{
  const { json } = await run({
    args: ARGS().replace('chinese=true', 'chinese=false'),
    body: home([
      entry('tweet-1', tweet('1', '中文推文内容在这里', { lang: 'zh' })),
      entry('promoted-tweet-2', tweet('2', 'ad')),
    ]),
  });
  assert.deepStrictEqual(ids(json), ['tweet-1']);
}

// 3. 什么都不删时不改响应
{
  const { out } = await run({ body: home([entry('tweet-1', tweet('1', 'hello there'))]) });
  assert.deepStrictEqual(out, {});
}

// 4. 转推看被转的那条；长推文看 note_tweet；TweetWithVisibilityResults 包装
{
  const zh = tweet('10', '这是被转发的中文内容', { lang: 'zh', by: user('cn', 'cn') });
  const { json } = await run({
    body: home([
      entry('tweet-11', tweet('11', 'RT @cn: 这是被转发的中文内容', { lang: 'zh', retweeted: zh })),
      entry('tweet-12', tweet('12', 'RT @en: hi', { lang: 'en', retweeted: { __typename: 'TweetWithVisibilityResults', tweet: zh } })),
      entry('tweet-13', tweet('13', 'Short preview…', { lang: 'en', note: '很长很长的一段中文内容，只有展开后才看得到' })),
      entry('tweet-14', { __typename: 'TweetWithVisibilityResults', tweet: tweet('14', '包装过的中文推文内容', { lang: 'zh' }) }),
    ]),
  });
  assert.deepStrictEqual(ids(json), []);
}

// 5. 对话模块：子条目删掉；删光了模块也删，「显示更多」不算
{
  const { json } = await run({
    body: home([
      moduleEntry('home-conversation-1', [
        ['home-conversation-1-tweet-20', itemContent(tweet('20', 'English parent tweet'))],
        ['home-conversation-1-tweet-21', itemContent(tweet('21', '中文回复内容在这里', { lang: 'zh' }))],
      ]),
      moduleEntry('home-conversation-2', [
        ['home-conversation-2-tweet-22', itemContent(tweet('22', '全是中文的对话串', { lang: 'zh' }))],
        ['home-conversation-2-cursor-showmore-1', { itemType: 'TimelineTimelineCursor', value: 'x' }],
      ]),
      moduleEntry('who-to-follow-1', [
        ['who-to-follow-1-user-1', { itemType: 'TimelineUser', user_results: { result: user('bob', 'Bob') } }],
        ['who-to-follow-1-user-2', { itemType: 'TimelineUser', user_results: { result: user('ad', 'Ad') }, promotedMetadata: AD }],
      ]),
    ]),
  });
  const entries = json.data.home.home_timeline_urt.instructions[0].entries;
  assert.deepStrictEqual(entries.map((e) => e.entryId), ['home-conversation-1', 'who-to-follow-1']);
  assert.deepStrictEqual(entries[0].content.items.map((i) => i.entryId), ['home-conversation-1-tweet-20']);
  assert.deepStrictEqual(entries[1].content.items.map((i) => i.entryId), ['who-to-follow-1-user-1']);
}

// 6. 推文详情：点开的推文和上面的串留着，回复里的中文和广告删掉；TimelineAddToModule 也管
{
  const body = {
    data: {
      threaded_conversation_with_injections_v2: {
        instructions: [
          { type: 'TimelineAddEntries', entries: [
            entry('tweet-30', tweet('30', '上面的中文串', { lang: 'zh' })),
            entry('tweet-31', tweet('31', '点开的这条是中文', { lang: 'zh' })),
            moduleEntry('conversationthread-32', [['conversationthread-32-tweet-32', itemContent(tweet('32', '中文的回复机器人', { lang: 'zh' }))]]),
            moduleEntry('conversationthread-33', [['conversationthread-33-tweet-33', itemContent(tweet('33', 'Nice post!'))]]),
            moduleEntry('conversationthread-34', [['conversationthread-34-tweet-34', itemContent(tweet('34', 'Ad reply'), { promotedMetadata: AD })]]),
          ] },
          { type: 'TimelineAddToModule', moduleEntryId: 'conversationthread-33', moduleItems: [
            { entryId: 'conversationthread-33-tweet-35', item: { itemContent: itemContent(tweet('35', '更多中文回复', { lang: 'zh' })) } },
            { entryId: 'conversationthread-33-tweet-36', item: { itemContent: itemContent(tweet('36', 'More replies')) } },
          ] },
        ],
      },
    },
  };
  const { json } = await run({ body, url: URL('TweetDetail', { focalTweetId: '31' }) });
  const [add, toModule] = json.data.threaded_conversation_with_injections_v2.instructions;
  assert.deepStrictEqual(add.entries.map((e) => e.entryId), ['tweet-30', 'tweet-31', 'conversationthread-33']);
  assert.deepStrictEqual(toModule.moduleItems.map((e) => e.entryId), ['conversationthread-33-tweet-36']);
}

// 7. 个人主页不删中文（广告照删）；中文搜索不删中文，英文搜索删
{
  const body = () => home([
    entry('tweet-40', tweet('40', '个人主页上的中文推文', { lang: 'zh' })),
    entry('promoted-tweet-41', tweet('41', 'ad')),
  ]);
  assert.deepStrictEqual(ids((await run({ body: body(), url: URL('UserTweets', { userId: '1' }) })).json), ['tweet-40']);
  assert.deepStrictEqual(ids((await run({ body: body(), url: URL('SearchTimeline', { rawQuery: '天气' }) })).json), ['tweet-40']);
  assert.deepStrictEqual(ids((await run({ body: body(), url: URL('SearchTimeline', { rawQuery: 'weather' }) })).json), []);
}

// 8. 置顶（TimelinePinEntry）：整条指令删掉
{
  const { json } = await run({
    body: home([entry('tweet-1', tweet('1', 'hello there'))], [{ type: 'TimelinePinEntry', entry: entry('tweet-50', tweet('50', '置顶的中文推文', { lang: 'zh' })) }]),
  });
  assert.strictEqual(json.data.home.home_timeline_urt.instructions.length, 1);
}

// 9. strict：引用中文、作者名字或简介有汉字、推荐关注里中文名字的账号也删；normal 不删
{
  const body = () => home([
    entry('tweet-60', tweet('60', 'Look at this', { quoted: tweet('61', '被引用的中文推文', { lang: 'zh' }) })),
    entry('tweet-62', tweet('62', 'Good morning everyone', { by: user('cnbot', '小美') })),
    entry('tweet-63', tweet('63', 'Good morning everyone', { by: user('bot2', 'Amy', '欢迎私信合作') })),
    entry('tweet-64', tweet('64', 'Good morning', { by: user('jp', 'やまだ 山田') })),
    entry('tweet-65', tweet('65', 'Hello', { by: user('tom', 'Tom') })),
    moduleEntry('who-to-follow-2', [
      ['who-to-follow-2-user-1', { itemType: 'TimelineUser', user_results: { result: user('cn2', '张三') } }],
      ['who-to-follow-2-user-2', { itemType: 'TimelineUser', user_results: { result: user('en2', 'John') } }],
    ]),
  ]);
  assert.deepStrictEqual((await run({ body: body() })).out, {});  // normal：都留着，不改响应
}
{
  const body = home([
    entry('tweet-60', tweet('60', 'Look at this', { quoted: tweet('61', '被引用的中文推文', { lang: 'zh' }) })),
    entry('tweet-62', tweet('62', 'Good morning everyone', { by: user('cnbot', '小美') })),
    entry('tweet-63', tweet('63', 'Good morning everyone', { by: user('bot2', 'Amy', '欢迎私信合作') })),
    entry('tweet-64', tweet('64', 'Good morning', { by: user('jp', 'やまだ 山田') })),
    entry('tweet-65', tweet('65', 'Hello', { by: user('tom', 'Tom') })),
    moduleEntry('who-to-follow-2', [
      ['who-to-follow-2-user-1', { itemType: 'TimelineUser', user_results: { result: user('cn2', '张三') } }],
      ['who-to-follow-2-user-2', { itemType: 'TimelineUser', user_results: { result: user('en2', 'John') } }],
    ]),
  ]);
  const { json } = await run({ body, args: ARGS('&mode=strict') });
  const entries = json.data.home.home_timeline_urt.instructions[0].entries;
  assert.deepStrictEqual(entries.map((e) => e.entryId), ['tweet-64', 'tweet-65', 'who-to-follow-2']);
  assert.deepStrictEqual(entries[2].content.items.map((i) => i.entryId), ['who-to-follow-2-user-2']);
}

// 10. 白名单：大小写、带不带 @ 都行；转推白名单里的人也留着
{
  const { json } = await run({
    args: ARGS().replace('allow=', 'allow=' + encodeURIComponent('@CnFriend|other')),
    body: home([
      entry('tweet-70', tweet('70', '白名单里的中文推文', { lang: 'zh', by: user('cnfriend', '朋友') })),
      entry('tweet-71', tweet('71', 'RT', { retweeted: tweet('72', '白名单的人发的中文', { lang: 'zh', by: user('other', 'O') }) })),
      entry('tweet-73', tweet('73', '不在白名单的中文', { lang: 'zh' })),
    ]),
  });
  assert.deepStrictEqual(ids(json), ['tweet-70', 'tweet-71']);
}

// 11. 趋势：中文趋势、推广趋势删掉
{
  const trend = (name, extra = {}) => ({ itemType: 'TimelineTrend', __typename: 'TimelineTrend', name, ...extra });
  const { json } = await run({
    url: URL('GenericTimelineById'),
    body: { data: { timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [
      { entryId: 'trend-1', content: { itemContent: trend('#WorldCup') } },
      { entryId: 'trend-2', content: { itemContent: trend('#春节快乐') } },
      { entryId: 'trend-3', content: { itemContent: trend('#BuyNow', { promotedMetadata: AD }) } },
    ] }] } } } },
  });
  assert.deepStrictEqual(json.data.timeline.timeline.instructions[0].entries.map((e) => e.entryId), ['trend-1']);
}

// 12. 不是 JSON、解析出错都原样放过
{
  assert.deepStrictEqual((await run({ body: 'not json' })).out, {});
  assert.deepStrictEqual((await run({ body: '{"broken": ' })).out, {});
}

// 13. 调试日志
{
  const { logs } = await run({ args: ARGS('&debug=true'), body: home([entry('promoted-tweet-1', tweet('1', 'ad'))]) });
  assert.ok(logs.some((l) => l.includes('删掉 广告：promoted-tweet-1')), logs.join('\n'));
  assert.ok(logs.some((l) => l.includes('HomeTimeline') && l.includes('"广告":1')), logs.join('\n'));
}

// ---------- 翻译 ----------

const legacyOf = (json, i) => {
  const r = json.data.home.home_timeline_urt.instructions[0].entries[i].content.itemContent.tweet_results.result;
  return r.legacy;
};

// 14. 外文推文加译文，中文的删掉不翻，zxx 不翻；同样的文字只翻一次
{
  const { json, calls } = await run({
    args: TR(),
    body: home([
      entry('tweet-1', tweet('1', 'Hello world, this is great')),
      entry('tweet-2', tweet('2', '中文推文不用翻译', { lang: 'zh' })),
      entry('tweet-3', tweet('3', '今日はいい天気ですね', { lang: 'ja' })),
      entry('tweet-4', tweet('4', 'https://t.co/abc', { lang: 'zxx' })),
      entry('tweet-5', tweet('5', 'Hello world, this is great')),
    ]),
  });
  assert.deepStrictEqual(ids(json), ['tweet-1', 'tweet-3', 'tweet-4', 'tweet-5']);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].texts.sort(), ['Hello world, this is great', '今日はいい天気ですね'].sort());
  assert.strictEqual(legacyOf(json, 0).full_text, 'Hello world, this is great\n\n译:Hello world, this is great');
  assert.deepStrictEqual(legacyOf(json, 0).display_text_range, [0, 56]);
  assert.strictEqual(legacyOf(json, 1).full_text, '今日はいい天気ですね\n\n译:今日はいい天気ですね');
  assert.strictEqual(legacyOf(json, 2).full_text, 'https://t.co/abc');
  assert.strictEqual(legacyOf(json, 3).full_text, 'Hello world, this is great\n\n译:Hello world, this is great');
}

// 15. 显示范围和实体下标：回复开头的 @、末尾的图片链接、表情（码位）、转义的 &
{
  const t1 = tweet('1', '@bob Thanks a lot', { legacy: {
    display_text_range: [5, 17], entities: { user_mentions: [{ screen_name: 'bob', indices: [0, 4] }] },
  } });
  const t2 = tweet('2', 'Nice 😀 day https://t.co/x', { legacy: {
    display_text_range: [0, 10],
    entities: { media: [{ url: 'https://t.co/x', indices: [11, 25] }], urls: [] },
    extended_entities: { media: [{ url: 'https://t.co/x', indices: [11, 25] }] },
  } });
  const t3 = tweet('3', 'Tom &amp; Jerry');
  const { json, calls } = await run({ args: TR(), body: home([entry('tweet-1', t1), entry('tweet-2', t2), entry('tweet-3', t3)]) });
  assert.deepStrictEqual(calls[0].texts, ['Thanks a lot', 'Nice 😀 day', 'Tom & Jerry']);

  const l1 = legacyOf(json, 0);
  assert.strictEqual(l1.full_text, '@bob Thanks a lot\n\n译:Thanks a lot');
  assert.deepStrictEqual(l1.display_text_range, [5, 33]);
  assert.deepStrictEqual(l1.entities.user_mentions[0].indices, [0, 4]);

  const l2 = legacyOf(json, 1);
  const chars = Array.from(l2.full_text);
  assert.strictEqual(chars.slice(0, l2.display_text_range[1]).join(''), 'Nice 😀 day\n\n译:Nice 😀 day');
  assert.deepStrictEqual(l2.display_text_range, [0, 24]);
  assert.deepStrictEqual(l2.entities.media[0].indices, [25, 39]);
  assert.deepStrictEqual(l2.extended_entities.media[0].indices, [25, 39]);
  assert.strictEqual(chars.slice(25, 39).join(''), 'https://t.co/x');

  assert.strictEqual(legacyOf(json, 2).full_text, 'Tom &amp; Jerry\n\n译:Tom &amp; Jerry');
}

// 16. 长推文翻 note_tweet；转推翻被转的那条；引用的推文也翻
{
  const inner = tweet('10', 'Original words', { by: user('en', 'En') });
  const { json, calls } = await run({
    args: TR(),
    body: home([
      entry('tweet-1', tweet('1', 'Short preview', { note: 'A very long note that is only visible when expanded' })),
      entry('tweet-2', tweet('2', 'RT @en: Original words', { retweeted: inner })),
      entry('tweet-3', tweet('3', 'Look at this', { quoted: tweet('4', 'Quoted words here') })),
    ]),
  });
  assert.deepStrictEqual(calls[0].texts.sort(), ['A very long note that is only visible when expanded', 'Look at this', 'Original words', 'Quoted words here'].sort());
  const t1 = json.data.home.home_timeline_urt.instructions[0].entries[0].content.itemContent.tweet_results.result;
  assert.strictEqual(t1.note_tweet.note_tweet_results.result.text, 'A very long note that is only visible when expanded\n\n译:A very long note that is only visible when expanded');
  assert.strictEqual(t1.legacy.full_text, 'Short preview');
  assert.strictEqual(legacyOf(json, 1).full_text, 'RT @en: Original words');
  assert.strictEqual(legacyOf(json, 1).retweeted_status_result.result.legacy.full_text, 'Original words\n\n译:Original words');
  const t3 = json.data.home.home_timeline_urt.instructions[0].entries[2].content.itemContent.tweet_results.result;
  assert.strictEqual(t3.quoted_status_result.result.legacy.full_text, 'Quoted words here\n\n译:Quoted words here');
}

// 17. 缓存：第二次不发请求
{
  const store = {};
  const body = () => home([entry('tweet-1', tweet('1', 'Cache me please'))]);
  await run({ args: TR(), body: body(), store });
  const second = await run({ args: TR(), body: body(), store });
  assert.strictEqual(second.calls.length, 0);
  assert.strictEqual(legacyOf(second.json, 0).full_text, 'Cache me please\n\n译:Cache me please');
}

// 18. DeepL 额度用完：key 暂停，改用 Google；Google 也不行就原样
{
  const store = {};
  const { json, calls } = await run({ args: TR(), deepl: 456, store, body: home([entry('tweet-1', tweet('1', 'Fallback text'))]) });
  assert.deepStrictEqual(calls.map((c) => c.vendor), ['deepl', 'google']);
  assert.strictEqual(legacyOf(json, 0).full_text, 'Fallback text\n\n谷:Fallback text');
  assert.ok(Object.keys(JSON.parse(store['yt-subtitles-deepl']).paused).length === 1);
  const again = await run({ args: TR(), store, body: home([entry('tweet-1', tweet('1', 'Other text'))]) });
  assert.deepStrictEqual(again.calls.map((c) => c.vendor), ['google']);  // 暂停中的 key 不再试
  const none = await run({ args: TR('&fallback=off'), deepl: 500, body: home([entry('tweet-1', tweet('1', 'No luck'))]) });
  assert.deepStrictEqual(none.out, {});
}

// 19. 翻译卡住：到时间返回删过广告、没翻译的版本
{
  const started = Date.now();
  const { json } = await run({
    args: TR('&budget=1'), deepl: 'hang',
    body: home([entry('tweet-1', tweet('1', 'Slow network')), entry('promoted-tweet-2', tweet('2', 'ad'))]),
  });
  assert.ok(Date.now() - started < 4500);
  assert.deepStrictEqual(ids(json), ['tweet-1']);
  assert.strictEqual(legacyOf(json, 0).full_text, 'Slow network');
}

// 20. 目标语言是英文：英文推文不翻，中文推文删掉
{
  const { out, calls } = await run({ args: TR('&target=EN-US&chinese=false'), body: home([entry('tweet-1', tweet('1', 'Already English'))]) });
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(out, {});
}

console.log('x.js: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
