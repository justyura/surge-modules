/*
 * X 去广告和屏蔽中文：处理 x.com 网页版的 GraphQL 响应（/i/api/graphql/<id>/<操作名>），
 * 时间线里的推广和中文推文直接从响应里删掉，网页根本拿不到。
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
 * 参数（模块里的 argument，用 & 分隔）：
 *   chinese    true：屏蔽中文；false：只去广告
 *   mode       normal / strict，见上面
 *   allow      不屏蔽的账号（@ 后面的用户名），多个用 | 分隔
 *   debug      true：在 Surge 日志里打印删了什么
 */

function parseArgs(raw) {
  var args = { chinese: 'true', mode: 'normal', allow: '', debug: 'false' };
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
  args.debug = args.debug === 'true';
  return args;
}

var ARGS = parseArgs(typeof $argument === 'undefined' ? '' : $argument);

function log() {
  if (ARGS.debug) console.log('[X] ' + Array.prototype.join.call(arguments, ' '));
}

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

function main() {
  var body = $response.body;
  if (!body || typeof body !== 'string' || !/^\s*[{[]/.test(body)) return null;
  var json = JSON.parse(body);
  var ctx = context($request.url, $request.body);
  var stats = {};
  walk(json, ctx, stats, 0);
  var total = Object.keys(stats).reduce(function (n, k) { return n + stats[k]; }, 0);
  log(ctx.op || $request.url.replace(/\?.*/, ''), total ? JSON.stringify(stats) : '没删东西', ctx.chinese ? '' : '（这里不屏蔽中文）');
  return total ? JSON.stringify(json) : null;
}

try {
  var out = main();
  $done(out ? { body: out } : {});
} catch (e) {
  console.log('[X] 出错：' + (e && e.message || e));
  $done({});
}
