/*
 * X 去广告、屏蔽中文和翻译：处理 x.com 网页版的 GraphQL 响应（/i/api/graphql/<id>/<操作名>），
 * 时间线里的推广和中文推文直接从响应里删掉，网页根本拿不到；留下来的外文推文加上译文。
 * Surge 一个响应只跑一个脚本，所以去广告、屏蔽和翻译放在同一个脚本里。
 *
 * 不按固定路径找，整个响应走一遍：带 entryId 的条目（时间线条目、模块里的子条目、
 * TimelinePinEntry 之类的 entry）逐个判断，删掉要删的。模块里的子条目删光了，模块也删掉。
 * X 改了外层字段名也照样能用。
 *
 * 去广告：entryId 带 promoted，或者条目里有 promotedMetadata（推广帖、推广账号、推广趋势）。
 *
 * 屏蔽中文（推文看正文，长推文看 note_tweet，转推看被转的那条）：
 *   - X 标的语言是 zh，或者没标成 ja / ko、正文里汉字比英文单词多（至少 4 个汉字）
 *   - 有假名、谚文的算日文、韩文，不删
 *   - 趋势（「有什么新鲜事」）名字是中文的也删
 *   - strict：引用的推文是中文、作者名字或简介里有汉字也删，推荐关注里名字带汉字的账号也删
 * 这些地方不删中文：自己点开的那条推文和它上面的串（TweetDetail 里顶层的 tweet- 条目）、
 * 个人主页（UserTweets 之类）、用中文搜索的结果、白名单里的账号。
 *
 * 翻译：响应里每条推文（包括引用的、被转的）的正文后面空一行接上译文。
 *   - 普通推文改 legacy.full_text：译文插在 display_text_range 的末尾（网页只显示这一段），
 *     范围跟着变长，后面的实体（图片链接等）下标往后挪。下标按码位算，和 X 一样
 *   - 长推文改 note_tweet 的 text，接在最后，前面的下标不用动
 *   - X 标的语言已经是目标语言、没有文字（zxx、qme 之类）的不翻
 * DeepL 部分照搬 reddit.js：多个 key 按顺序用，出错按类型暂停，全部不行用 Google 兜底。
 * key 的暂停状态和 YouTube 字幕、Reddit 存在同一个地方。
 *
 * 参数（模块里的 argument，用 & 分隔）：
 *   chinese    true：屏蔽中文；false：只去广告
 *   mode       normal / strict，见上面
 *   allow      不屏蔽的账号（@ 后面的用户名），多个用 | 分隔
 *   keys       DeepL key，多个用 | 分隔
 *   target     目标语言，DeepL 的写法，比如 ZH-HANS、ZH-HANT、EN-US、JA
 *   translate  all：翻译；off：不翻译
 *   fallback   google：全部 key 失败时用 Google 翻译；off：不兜底
 *   budget     最多等几秒翻译（默认 4），到时间没翻完的显示原文
 *   debug      true：在 Surge 日志里打印删了什么、翻了几条
 */

var STATE_KEY = 'yt-subtitles-deepl';   // 和 YouTube 字幕、Reddit 共用 key 的暂停状态
var CACHE_KEY = 'x-translations';
var CACHE_SIZE = 500;                   // 缓存最近多少条译文
var TEXTS_PER_REQUEST = 50;             // DeepL 一次最多 50 段
var BYTES_PER_REQUEST = 100000;         // DeepL 单次请求上限 128 KiB，留点余量
var GOOGLE_CHARS = 1500;                // Google 兜底一个请求最多拼多少字（放在网址里，不能太长）
var PARALLEL = 6;                       // 同时发几个请求
var MIN_BYTES_PER_REQUEST = 2000;       // 内容少时不拆得太碎
var PAUSE = { 403: 7 * 86400, 456: 86400, 429: 60, 5: 300 };

function parseArgs(raw) {
  var args = {
    chinese: 'true', mode: 'normal', allow: '', keys: '', target: 'ZH-HANS', translate: 'all',
    fallback: 'google', budget: '4', debug: 'false',
  };
  String(raw || '').split('&').forEach(function (part) {
    var i = part.indexOf('=');
    if (i <= 0) return;
    var value = part.slice(i + 1);
    try { value = decodeURIComponent(value); } catch (e) {}
    args[part.slice(0, i).trim()] = value.replace(/^"|"$/g, '').trim();
  });
  args.chinese = args.chinese !== 'false';
  args.strict = args.mode === 'strict';
  args.allowList = args.allow.split(/[|;,\s]+/).map(function (n) { return n.replace(/^@/, '').toLowerCase(); })
    .filter(function (n) { return /^\w{1,15}$/.test(n); });
  args.keyList = args.keys.split(/[|;,\s]+/).filter(function (k) { return /^[\w-]+(:fx)?$/i.test(k) && k.length > 20; });
  args.target = args.target.toUpperCase();
  args.translate = args.translate === 'off' ? 'off' : 'all';
  args.budget = Math.min(20, Math.max(1, Number(args.budget) || 4));
  args.debug = args.debug === 'true';
  return args;
}

var ARGS = parseArgs(typeof $argument === 'undefined' ? '' : $argument);
var DEADLINE = Date.now() + ARGS.budget * 1000;

function log() {
  if (ARGS.debug) console.log('[X] ' + Array.prototype.join.call(arguments, ' '));
}

function remaining() { return (DEADLINE - Date.now()) / 1000; }
function now() { return Math.floor(Date.now() / 1000); }
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// ---------- 中文判断 ----------

var HAN = /\p{Script=Han}/gu;
var KANA_HANGUL = /[぀-ヿㇰ-ㇿ가-힯ᄀ-ᇿ]/;

function count(text, re) { var m = text.match(re); return m ? m.length : 0; }

// 链接、@ 用户名不算
function cleanText(text) { return String(text || '').replace(/https?:\/\/\S+/g, ' ').replace(/@\w+/g, ' '); }

function isChineseText(text, lang) {
  lang = String(lang || '').toLowerCase();
  if (/^(ja|ko)\b/.test(lang)) return false;
  text = cleanText(text);
  if (KANA_HANGUL.test(text)) return false;
  var han = count(text, HAN);
  if (/^zh\b/.test(lang)) return han > 0;
  return han >= 4 && han >= count(text, /[A-Za-z]{2,}/g);
}

// 名字、简介、趋势这种短文字：有两个以上汉字、没有假名谚文就算
function isChineseName(text) {
  text = cleanText(text);
  return !KANA_HANGUL.test(text) && count(text, HAN) >= 2;
}

// ---------- 推文、用户 ----------

function isTweet(v) { return isObject(v) && (v.__typename === 'Tweet' || (isObject(v.legacy) && typeof v.legacy.full_text === 'string')); }
function isUser(v) { return isObject(v) && (v.__typename === 'User' || (isObject(v.legacy) && typeof v.legacy.screen_name === 'string')); }
function isTrend(v) { return isObject(v) && (v.__typename === 'TimelineTrend' || v.itemType === 'TimelineTrend') && typeof v.name === 'string'; }

// TweetWithVisibilityResults 之类的包装拆掉
function unwrap(result) {
  for (var i = 0; i < 3 && isObject(result) && !isTweet(result) && isObject(result.tweet); i++) result = result.tweet;
  return isTweet(result) ? result : null;
}

function tweetText(tweet) {
  var note = tweet.note_tweet && tweet.note_tweet.note_tweet_results && tweet.note_tweet.note_tweet_results.result;
  if (note && typeof note.text === 'string') return note.text;
  return tweet.legacy && tweet.legacy.full_text || '';
}

function author(tweet) {
  var user = tweet.core && tweet.core.user_results && tweet.core.user_results.result;
  return isObject(user) ? user : null;
}

function userInfo(user) {
  var core = isObject(user.core) ? user.core : {};
  var legacy = isObject(user.legacy) ? user.legacy : {};
  return {
    name: core.name || legacy.name || '',
    screenName: String(core.screen_name || legacy.screen_name || '').toLowerCase(),
    bio: legacy.description || (user.profile_bio && user.profile_bio.description) || '',
  };
}

function allowed(user) { return !!user && ARGS.allowList.indexOf(userInfo(user).screenName) !== -1; }

// 转推看被转的那条
function original(tweet) {
  var rt = tweet.legacy && tweet.legacy.retweeted_status_result && unwrap(tweet.legacy.retweeted_status_result.result);
  return rt || tweet;
}

function isChineseTweet(tweet) {
  if (allowed(author(tweet))) return false;
  var main = original(tweet);
  if (main !== tweet && allowed(author(main))) return false;
  if (isChineseText(tweetText(main), main.legacy && main.legacy.lang)) return true;
  if (!ARGS.strict) return false;
  var quoted = main.quoted_status_result && unwrap(main.quoted_status_result.result);
  if (quoted && !allowed(author(quoted)) && isChineseText(tweetText(quoted), quoted.legacy && quoted.legacy.lang)) return true;
  return [tweet, main].some(function (t) {
    var user = author(t);
    if (!user) return false;
    var info = userInfo(user);
    return isChineseName(info.name) || isChineseName(info.bio);
  });
}

// 条目里最先遇到的推文、用户或趋势（不往推文、用户里面钻，引用的推文不算）
function primary(entry) {
  var queue = [entry];
  while (queue.length) {
    var v = queue.shift();
    if (Array.isArray(v)) { queue.push.apply(queue, v); continue; }
    if (!isObject(v)) continue;
    if (isTweet(v)) return { tweet: v };
    if (isUser(v)) return { user: v };
    if (isTrend(v)) return { trend: v };
    for (var k in v) if (typeof v[k] === 'object') queue.push(v[k]);
  }
  return null;
}

// ---------- 广告 ----------

var PROMOTED_KEY = /^(promotedMetadata|promoted_metadata|promotedContent|promoted_content|tweetPromotedMetadata)$/;

function hasPromoted(v) {
  if (Array.isArray(v)) return v.some(hasPromoted);
  if (!isObject(v) || isTweet(v) || isUser(v)) return false;
  for (var k in v) {
    if (PROMOTED_KEY.test(k) && v[k]) return true;
    if (typeof v[k] === 'object' && hasPromoted(v[k])) return true;
  }
  return false;
}

// ---------- 主流程 ----------

// 请求的操作名，决定哪些地方不删中文
function context(url, body) {
  var op = (/\/graphql\/[^\/]+\/(\w+)/.exec(url) || [])[1] || '';
  var query = '';
  var m = /[?&]variables=([^&]*)/.exec(url);
  try {
    var vars = m ? JSON.parse(decodeURIComponent(m[1])) : body ? JSON.parse(body).variables : null;
    if (isObject(vars) && typeof vars.rawQuery === 'string') query = vars.rawQuery;
  } catch (e) {}
  return {
    op: op,
    chinese: ARGS.chinese && !/^(User|Profile|Likes$|Bookmarks$)/.test(op) && !(/Search/.test(op) && count(query, HAN) > 0),
    detail: /TweetDetail|ConversationTimeline/.test(op),
  };
}

function entryOf(v) {
  if (!isObject(v)) return null;
  if (typeof v.entryId === 'string') return v;
  if (isObject(v.entry) && typeof v.entry.entryId === 'string') return v.entry;
  return null;
}

function reason(entry, ctx, top) {
  var id = entry.entryId;
  if (/cursor/.test(id)) return null;
  if (/promoted/i.test(id) || hasPromoted(entry)) return '广告';
  if (!ctx.chinese) return null;
  // 点开的那条推文和它上面的串留着
  if (ctx.detail && top && /^tweet-\d+$/.test(id)) return null;
  var p = primary(entry);
  if (!p) return null;
  if (p.tweet && isChineseTweet(p.tweet)) return '中文';
  if (p.trend && isChineseName(p.trend.name)) return '中文';
  if (p.user && ARGS.strict && !allowed(p.user) && isChineseName(userInfo(p.user).name)) return '中文';
  return null;
}

// 整个响应走一遍。返回这一层下面（不跨过条目）剩下几个、删了几个条目，用来判断模块是不是删光了
function walk(v, ctx, stats, depth) {
  var result = { kept: 0, removed: 0 };
  if (Array.isArray(v)) {
    for (var i = v.length - 1; i >= 0; i--) {
      var entry = entryOf(v[i]);
      var inner = walk(v[i], ctx, stats, entry ? depth + 1 : depth);
      if (!entry) { result.kept += inner.kept; result.removed += inner.removed; continue; }
      var why = inner.removed && !inner.kept ? '模块删光' : reason(entry, ctx, depth === 0);
      if (why) {
        log('删掉 ' + why + '：' + entry.entryId);
        stats[why] = (stats[why] || 0) + 1;
        v.splice(i, 1);
        result.removed++;
      } else if (!/cursor/.test(entry.entryId)) {
        result.kept++;  // 「显示更多」这种翻页条目不算，模块里只剩它也删
      }
    }
    return result;
  }
  if (!isObject(v) || isTweet(v) || isUser(v)) return result;
  for (var k in v) {
    if (typeof v[k] !== 'object') continue;
    var r = walk(v[k], ctx, stats, depth);
    result.kept += r.kept;
    result.removed += r.removed;
  }
  return result;
}

// ---------- 翻译：找出要翻的推文 ----------

// X 标的语言：zxx 没有文字，qme 只有媒体，qam 只有 @，qht 只有话题，qct 只有 $，qst 太短
function skipLang(lang) {
  lang = String(lang || '').toLowerCase();
  if (lang === 'zxx' || /^q[a-z]{2}$/.test(lang)) return true;
  return !!lang && lang !== 'und' && lang.split('-')[0] === ARGS.target.split('-')[0].toLowerCase();
}

// 没有文字（纯表情、链接）、本来就是目标语言的不翻。目标是中文时，汉字过半又没有假名、谚文就算中文
function needsTranslation(text) {
  var letters = text.match(/\p{L}/gu);
  if (!letters || letters.length < 2) return false;
  if (/^ZH/.test(ARGS.target)) {
    var han = count(text, HAN);
    if (han * 2 >= letters.length && !KANA_HANGUL.test(text)) return false;
  }
  return true;
}

// X 的 full_text 里 & < > 是转义过的
function unescapeHtml(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// 送去翻的文字：去掉 t.co 链接，多余的空行收一收
function sourceText(text) {
  return text.replace(/https?:\/\/t\.co\/\w+/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 实体下标在 at 之后的往后挪 by 个码位
function shiftEntities(group, at, by) {
  if (!isObject(group)) return;
  Object.keys(group).forEach(function (k) {
    if (!Array.isArray(group[k])) return;
    group[k].forEach(function (e) {
      if (e && Array.isArray(e.indices) && e.indices[0] >= at) e.indices = [e.indices[0] + by, e.indices[1] + by];
    });
  });
}

// 返回 [{ text: 要翻的文字, apply(译文) }]
function collectJobs(json) {
  var jobs = [];
  var seen = [];
  (function walk(v) {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!isObject(v)) return;
    if (isUser(v)) return;
    Object.keys(v).forEach(function (k) { if (typeof v[k] === 'object') walk(v[k]); });
    if (!isTweet(v) || seen.indexOf(v) !== -1) return;
    seen.push(v);
    var legacy = isObject(v.legacy) ? v.legacy : null;
    if (!legacy || legacy.retweeted_status_result || skipLang(legacy.lang)) return;  // 转推翻被转的那条
    var note = v.note_tweet && v.note_tweet.note_tweet_results && v.note_tweet.note_tweet_results.result;
    if (note && typeof note.text === 'string') {
      var noteSource = sourceText(note.text);
      if (needsTranslation(noteSource)) {
        jobs.push({ text: noteSource, apply: function (t) { note.text = note.text.replace(/\s+$/, '') + '\n\n' + t; } });
      }
      return;
    }
    if (typeof legacy.full_text !== 'string') return;
    var chars = Array.from(legacy.full_text);
    var range = Array.isArray(legacy.display_text_range) ? legacy.display_text_range : [0, chars.length];
    var start = Math.max(0, Math.min(chars.length, range[0] | 0));
    var end = Math.max(start, Math.min(chars.length, range[1] | 0));
    var source = sourceText(unescapeHtml(chars.slice(start, end).join('')));
    if (!needsTranslation(source)) return;
    jobs.push({
      text: source,
      apply: function (t) {
        // 显示范围末尾的空白（比如图片链接前的空格）留在译文后面
        var cut = end;
        while (cut > start && /\s/.test(chars[cut - 1])) cut--;
        var insert = Array.from('\n\n' + escapeHtml(t));
        legacy.full_text = chars.slice(0, cut).concat(insert, chars.slice(cut)).join('');
        legacy.display_text_range = [start, end + insert.length];
        shiftEntities(legacy.entities, cut, insert.length);
        shiftEntities(legacy.extended_entities, cut, insert.length);
      },
    });
  })(json);
  return jobs;
}

// ---------- 缓存 ----------

function cacheKey(text) {
  var h = 5381;
  for (var i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return ARGS.target + '#' + text.length + '#' + h.toString(36);
}

function loadCache() {
  try { return JSON.parse($persistentStore.read(CACHE_KEY) || '[]'); } catch (e) { return []; }
}

function saveCache(entries) {
  try { $persistentStore.write(JSON.stringify(entries.slice(0, CACHE_SIZE)), CACHE_KEY); } catch (e) {}
}

// ---------- DeepL（照搬 reddit.js） ----------

// YouTube 字幕的缓存也存在这个 key 里，读写时原样保留
function loadState() {
  try {
    var state = JSON.parse($persistentStore.read(STATE_KEY) || '{}');
    state.paused = state.paused || {};
    state.current = state.current || '';
    return state;
  } catch (e) {
    return { paused: {}, current: '' };
  }
}

function saveState(state) {
  try { $persistentStore.write(JSON.stringify(state), STATE_KEY); } catch (e) {}
}

function fingerprint(key) {
  var h = 5381;
  for (var i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return key.slice(-6) + '#' + h.toString(36);
}

function request(method, options) {
  return new Promise(function (resolve) {
    $httpClient[method](options, function (error, response, body) {
      resolve({ error: error, status: response ? (response.status || response.statusCode) : 0, body: body });
    });
  });
}

function timeout() { return Math.max(1, Math.min(10, Math.floor(remaining()))); }

function deeplOnce(key, texts) {
  var host = /:fx$/i.test(key) ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  return request('post', {
    url: host + '/v2/translate',
    headers: { Authorization: 'DeepL-Auth-Key ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texts, target_lang: ARGS.target, preserve_formatting: true }),
    timeout: timeout(),
  }).then(function (r) {
    if (r.error || r.status !== 200) return { ok: false, status: r.error ? 0 : r.status };
    try {
      var list = JSON.parse(r.body).translations.map(function (t) { return t.text; });
      return list.length === texts.length ? { ok: true, list: list } : { ok: false, status: 0 };
    } catch (e) {
      return { ok: false, status: 0 };
    }
  });
}

async function deepl(texts, state) {
  var keys = ARGS.keyList.slice();
  var start = keys.indexOf(state.current);
  if (start > 0) keys = keys.slice(start).concat(keys.slice(0, start));
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (state.paused[fingerprint(key)] > now()) continue;
    if (remaining() < 0.5) return null;
    var r = await deeplOnce(key, texts);
    if (r.ok) {
      state.current = key;
      return r.list;
    }
    var pause = PAUSE[r.status] || (r.status >= 500 ? PAUSE[5] : 0);
    log('key ' + fingerprint(key) + ' 失败，状态码 ' + r.status + (pause ? '，暂停 ' + pause + ' 秒' : ''));
    if (pause) state.paused[fingerprint(key)] = now() + pause;
  }
  return null;
}

async function parallel(tasks, limit, run) {
  var next = 0;
  async function worker() {
    while (next < tasks.length && remaining() > 0.5) await run(tasks[next++]);
  }
  var workers = [];
  for (var i = 0; i < Math.min(limit, tasks.length); i++) workers.push(worker());
  await Promise.all(workers);
}

function googleTarget() {
  var t = ARGS.target;
  if (t === 'ZH' || t === 'ZH-HANS') return 'zh-CN';
  if (t === 'ZH-HANT') return 'zh-TW';
  return t.split('-')[0].toLowerCase();
}

function googleOnce(q) {
  return request('get', {
    url: 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=' + googleTarget() + '&q=' + encodeURIComponent(q),
    timeout: timeout(),
  }).then(function (r) {
    try { return JSON.parse(r.body)[0].map(function (seg) { return seg[0]; }).join(''); } catch (e) { return null; }
  });
}

// 多段用换行拼成一个请求（段内的换行先换成空格），按换行拆回来；行数对不上的那一组再一段一段翻
async function google(texts, result) {
  var chunks = [];
  var chunk = [];
  var length = 0;
  texts.forEach(function (t) {
    var line = t.replace(/\s*\n\s*/g, ' ');
    if (chunk.length && length + line.length > GOOGLE_CHARS) { chunks.push(chunk); chunk = []; length = 0; }
    chunk.push(t);
    length += line.length + 1;
  });
  if (chunk.length) chunks.push(chunk);
  var single = [];
  await parallel(chunks, 4, async function (lines) {
    var out = await googleOnce(lines.map(function (t) { return t.replace(/\s*\n\s*/g, ' '); }).join('\n'));
    var parts = out ? out.split('\n') : [];
    if (parts.length !== lines.length) { single.push.apply(single, lines); return; }
    lines.forEach(function (t, i) { if (parts[i].trim()) result[t] = parts[i].trim(); });
  });
  await parallel(single, 4, async function (t) {
    var out = await googleOnce(t);
    if (out && out.trim()) result[t] = out.trim();
  });
}

// DeepL 用不了的原因，写进日志
function deeplProblem(state) {
  if (!ARGS.keyList.length) return '没填 DeepL 密钥（每个模块的参数是分开的，这个模块里也要填）';
  var until = ARGS.keyList.map(function (k) { return state.paused[fingerprint(k)] || 0; });
  if (until.some(function (t) { return t <= now(); })) return '';
  var first = new Date(Math.min.apply(null, until) * 1000);
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return ARGS.keyList.length + ' 个 key 都在暂停中（额度用完、key 无效或请求太多），最早 '
    + (first.getMonth() + 1) + '-' + pad(first.getDate()) + ' ' + pad(first.getHours()) + ':' + pad(first.getMinutes()) + ' 恢复';
}

function utf8Length(text) {
  var n = 0;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c <= 0xdbff) ? (i++, 4) : 3;
  }
  return n;
}

// 一条推文一个 text 发给 DeepL，每条单独识别语言。返回 { 原文: 译文 }
async function translate(texts, state) {
  var result = {};
  // 按总量平均分成最多 PARALLEL 份同时发，DeepL 的耗时跟字数走，分开翻比排队快
  var total = texts.reduce(function (n, t) { return n + utf8Length(t) + 16; }, 0);
  var limit = Math.min(BYTES_PER_REQUEST, Math.max(MIN_BYTES_PER_REQUEST, Math.ceil(total / PARALLEL)));
  var batches = [];
  var batch = null;
  texts.forEach(function (t) {
    var size = utf8Length(t) + 16;
    if (!batch || batch.length >= TEXTS_PER_REQUEST || (batch.length && batch.size + size > limit)) {
      batch = [];
      batch.size = 0;
      batches.push(batch);
    }
    batch.push(t);
    batch.size += size;
  });
  var leftover = [];
  var problem = deeplProblem(state);
  if (problem) log('DeepL 用不了：' + problem);
  var deeplDown = !!problem;
  await parallel(batches, PARALLEL, async function (b) {
    var list = deeplDown ? null : await deepl(b, state);
    if (!list) {
      if (remaining() > 0.5) deeplDown = true;
      leftover.push.apply(leftover, b);
      return;
    }
    b.forEach(function (t, i) { if (list[i] && list[i].trim()) result[t] = list[i].trim(); });
  });
  if (leftover.length && ARGS.fallback === 'google' && remaining() > 0.5) {
    log('DeepL 不可用，' + leftover.length + ' 条改用 Google');
    await google(leftover, result);
  }
  return result;
}

// ---------- 主流程 ----------

async function main() {
  var body = $response.body;
  if (!body || typeof body !== 'string' || !/^\s*[{[]/.test(body)) return null;
  var json = JSON.parse(body);
  var ctx = context($request.url, $request.body);
  var stats = {};
  walk(json, ctx, stats, 0);
  var total = Object.keys(stats).reduce(function (n, k) { return n + stats[k]; }, 0);
  log(ctx.op || $request.url.replace(/\?.*/, ''), total ? JSON.stringify(stats) : '没删东西', ctx.chinese ? '' : '（这里不屏蔽中文）');
  if (total) filtered = JSON.stringify(json);

  var canTranslate = ARGS.translate !== 'off' && (ARGS.keyList.length || ARGS.fallback === 'google');
  var jobs = canTranslate ? collectJobs(json) : [];
  var translated = 0;
  if (jobs.length) {
    var texts = [];
    jobs.forEach(function (j) { if (texts.indexOf(j.text) === -1) texts.push(j.text); });
    var cache = loadCache();
    var map = {};
    var known = {};
    cache.forEach(function (e) { known[e[0]] = e[1]; });
    var missing = texts.filter(function (t) {
      var hit = known[cacheKey(t)];
      if (hit) map[t] = hit;
      return !hit;
    });
    if (missing.length) {
      var state = loadState();
      var fresh = await translate(missing, state);
      saveState(state);
      Object.keys(fresh).forEach(function (t) {
        map[t] = fresh[t];
        cache.unshift([cacheKey(t), fresh[t]]);
      });
      if (Object.keys(fresh).length) saveCache(cache);
    }
    jobs.forEach(function (j) {
      var t = map[j.text];
      if (!t || t === j.text) return;
      j.apply(t);
      translated++;
    });
    var left = texts.filter(function (t) { return !map[t]; }).length;
    log('要翻 ' + texts.length + ' 条，缓存命中 ' + (texts.length - missing.length) + ' 条，用上 ' + translated + ' 处'
      + (left ? '，' + left + ' 条没翻完（超时或出错），刷新会接着翻' : ''));
  }
  return total || translated ? JSON.stringify(json) : null;
}

var filtered = null;  // 删完广告和中文、还没翻译的版本，翻译超时就返回它
var finished = false;
function finish(out) {
  if (finished) return;
  finished = true;
  $done(out ? { body: out } : {});
}

// 兜底：卡住了就返回没翻译的版本（广告和中文照样删掉），不影响网页加载
setTimeout(function () { log('超时，返回没翻译的版本'); finish(filtered); }, (ARGS.budget + 2) * 1000);

main().then(finish, function (error) {
  console.log('[X] 出错：' + (error && error.message || error));
  finish(filtered);
});
