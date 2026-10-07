/*
 * Reddit 去广告和翻译：处理 Reddit App 的 GraphQL 响应（gql.reddit.com、gql-fed.reddit.com），
 * 以及 oauth.reddit.com 的 REST 响应（评论的 body / body_html，帖子的 title / selftext）。
 * Surge 一个响应只跑一个脚本，所以去广告和翻译放在同一个脚本里。
 *
 * 去广告（参考 xream 的脚本和 level3tjg/RedditFilter 的数据结构）：
 *   - 信息流 edges 里的 AdPost、带 adPayload 的条目、带 AdMetadataCell 的 CellGroup
 *   - 帖子详情页的 commentsPageAds、commentTreeAds、pdpCommentsAds
 *   - 评论树里混进来的 AdPost
 *
 * 翻译：帖子标题、帖子正文、评论。正文和评论按段翻，一段原文后面紧跟它的译文。
 * content 里有 markdown、richtext、html、preview 几种写法，App 用哪个不确定，有的都改。
 * 已经是目标语言（中文）、纯表情的不翻。
 *
 * DeepL 部分照搬 youtube-subtitles.js：多个 key 按顺序用，出错按类型暂停，全部不行用
 * Google 兜底。key 的暂停状态和 YouTube 字幕存在同一个地方，同一个 key 两边都知道它暂停了。
 *
 * 参数（模块里的 argument，用 & 分隔）：
 *   keys      DeepL key，多个用 | 分隔
 *   target    目标语言，DeepL 的写法，比如 ZH-HANS、ZH-HANT、EN-US、JA
 *   translate all：标题、正文、评论都翻；title：只翻标题；off：只去广告
 *   fallback  google：全部 key 失败时用 Google 翻译；off：不兜底
 *   budget    最多等几秒翻译（默认 4），到时间没翻完的显示原文
 *   debug     true：在 Surge 日志里打印细节
 */

var STATE_KEY = 'yt-subtitles-deepl';   // 和 YouTube 字幕共用 key 的暂停状态
var CACHE_KEY = 'reddit-translations';
var CACHE_SIZE = 500;                   // 缓存最近多少段译文
var TEXTS_PER_REQUEST = 50;             // DeepL 一次最多 50 段
var BYTES_PER_REQUEST = 100000;         // DeepL 单次请求上限 128 KiB，留点余量
var MAX_CHARS = 3000;                   // 太长的正文只翻前面这么多字
var PARALLEL = 3;
var PAUSE = { 403: 7 * 86400, 456: 86400, 429: 60, 5: 300 };
var AD_LISTS = ['commentsPageAds', 'commentTreeAds', 'pdpCommentsAds'];

function parseArgs(raw) {
  var args = { keys: '', target: 'ZH-HANS', translate: 'all', fallback: 'google', budget: '4', debug: 'false' };
  String(raw || '').split('&').forEach(function (part) {
    var i = part.indexOf('=');
    if (i <= 0) return;
    var value = part.slice(i + 1);
    try { value = decodeURIComponent(value); } catch (e) {}
    args[part.slice(0, i).trim()] = value.replace(/^"|"$/g, '').trim();
  });
  args.keyList = args.keys.split(/[|;,\s]+/).filter(function (k) { return /^[\w-]+(:fx)?$/i.test(k) && k.length > 20; });
  args.target = args.target.toUpperCase();
  args.translate = /^(all|title|off)$/.test(args.translate) ? args.translate : 'all';
  args.budget = Math.min(20, Math.max(1, Number(args.budget) || 4));
  args.debug = args.debug === 'true';
  return args;
}

var ARGS = parseArgs(typeof $argument === 'undefined' ? '' : $argument);
var DEADLINE = Date.now() + ARGS.budget * 1000;

function log() {
  if (ARGS.debug) console.log('[Reddit] ' + Array.prototype.join.call(arguments, ' '));
}

function remaining() { return (DEADLINE - Date.now()) / 1000; }
function now() { return Math.floor(Date.now() / 1000); }
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// ---------- 去广告 ----------

function isAd(node) {
  if (!isObject(node)) return false;
  if (node.__typename === 'AdPost' || isObject(node.adPayload)) return true;
  return Array.isArray(node.cells) && node.cells.some(function (c) { return c && c.__typename === 'AdMetadataCell'; });
}

// 整个响应走一遍：edges、评论树、根上的列表里的广告删掉，几个广告位清空。返回删了几条
function removeAds(value) {
  var removed = 0;
  (function walk(v) {
    if (Array.isArray(v)) {
      for (var i = v.length - 1; i >= 0; i--) {
        var item = v[i];
        if (isAd(item) || (isObject(item) && isAd(item.node))) { v.splice(i, 1); removed++; }
        else walk(item);
      }
      return;
    }
    if (!isObject(v)) return;
    Object.keys(v).forEach(function (k) {
      if (AD_LISTS.indexOf(k) !== -1 && Array.isArray(v[k])) { removed += v[k].length; v[k] = []; }
      else walk(v[k]);
    });
  })(value);
  return removed;
}

// ---------- 找出要翻译的文字 ----------

// 标题：SubredditPost、ProfilePost 之类的帖子，或新版信息流里的 TitleCell
function isPost(node) { return /Post$/.test(node.__typename || '') && node.__typename !== 'AdPost'; }

// markdown 转成纯文字再翻，译文不带格式符号
function markdownText(md) {
  return String(md)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:>+|#{1,6})\s?/gm, '')
    .replace(/(\*\*|__|~~|>!|!<|\^|`)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,!?])/g, '$1$2')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x200B;/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 比较段落用：只留字母和数字。markdown、html、richtext 里同一段的格式不一样，去掉格式后才对得上
function norm(text) { return String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }

function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// html 里的一段：段落、标题、列表、引用、代码、表格
var HTML_BLOCK = /<(p|h[1-6]|ul|ol|blockquote|pre|table)\b[^>]*>[\s\S]*?<\/\1>/gi;

function htmlText(html) {
  return html.replace(/<br\s*\/?>|<\/(?:p|li)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
}

// richtext 一个块里所有的文字（text、link 等节点的 t）
function richText(block) {
  var parts = [];
  (function walk(v) {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!isObject(v)) return;
    if (typeof v.t === 'string') parts.push(v.t);
    Object.keys(v).forEach(function (k) { if (k !== 't') walk(v[k]); });
  })(block);
  return parts.join(' ');
}

// 正文按段拆开：有 markdown 用 markdown（空行分段），没有就用 preview、html
function contentParagraphs(content) {
  if (typeof content.markdown === 'string') return content.markdown.split(/\n{2,}/).map(markdownText);
  if (typeof content.preview === 'string') return content.preview.split(/\n{2,}/);
  if (typeof content.html === 'string') return (content.html.match(HTML_BLOCK) || []).map(htmlText);
  return [];
}

// 每段原文后面紧跟它的译文，content 的每种写法都改。返回插了几段（按改得最多的那种写法算）
function interleave(content, lookup) {
  var counts = [0, 0, 0, 0];  // markdown、preview、html、richtext 各插了几段
  function count(i) { counts[i]++; }
  if (typeof content.markdown === 'string') {
    content.markdown = content.markdown.split(/\n{2,}/).map(function (block) {
      var t = lookup(markdownText(block));
      if (!t) return block;
      count(0);
      return block + '\n\n' + t;
    }).join('\n\n');
  }
  if (typeof content.preview === 'string') {
    content.preview = content.preview.split(/\n{2,}/).map(function (p) {
      var t = lookup(p);
      if (!t) return p;
      count(1);
      return p + '\n\n' + t;
    }).join('\n\n');
  }
  if (typeof content.html === 'string') {
    content.html = content.html.replace(HTML_BLOCK, function (block) {
      var t = lookup(htmlText(block));
      if (!t) return block;
      count(2);
      return block + t.split(/\n{2,}/).map(function (p) { return '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
    });
  }
  // richtext 是 Reddit 自己的 RTJSON：{ document: [{ e: 'par', c: [{ e: 'text', t: '…' }] }] }，有时是字符串
  if (content.richtext) {
    var isString = typeof content.richtext === 'string';
    try {
      var doc = isString ? JSON.parse(content.richtext) : content.richtext;
      if (doc && Array.isArray(doc.document)) {
        var blocks = [];
        doc.document.forEach(function (block) {
          blocks.push(block);
          var t = lookup(richText(block));
          if (!t) return;
          count(3);
          t.split(/\n{2,}/).forEach(function (p) { blocks.push({ e: 'par', c: [{ e: 'text', t: p }] }); });
        });
        doc.document = blocks;
        content.richtext = isString ? JSON.stringify(doc) : doc;
      }
    } catch (e) {}
  }
  return Math.max.apply(null, counts);
}

// 返回 [{ texts: 要翻的段落, apply(lookup) → 用上了几段 }]，lookup(原文) 返回译文
function hasBody(content) {
  return isObject(content) && ['markdown', 'html', 'richtext', 'preview'].some(function (k) { return typeof content[k] === 'string' || isObject(content[k]); });
}

// REST 接口（oauth.reddit.com）的 body_html、selftext_html 是转义过一次的 html
function unescapeEntities(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'); }

function paragraphJob(content, done) {
  var texts = contentParagraphs(content)
    .map(function (p) { return p.trim().slice(0, MAX_CHARS); })
    .filter(Boolean);
  if (!texts.length) return null;
  return { texts: texts, apply: function (lookup) { var n = interleave(content, lookup); if (done) done(); return n; } };
}

function titleJob(node) {
  return { texts: [node.title.trim()], apply: function (lookup) {
    var t = lookup(node.title);
    if (!t) return 0;
    node.title = node.title + '\n' + t;
    return 1;
  } };
}

// REST 格式的一对字段：markdown 写法（body、selftext）+ 转义过的 html（body_html、selftext_html）
function restJob(node, mdKey, htmlKey) {
  var content = { markdown: node[mdKey] };
  if (typeof node[htmlKey] === 'string') content.html = unescapeEntities(node[htmlKey]);
  return paragraphJob(content, function () {
    node[mdKey] = content.markdown;
    if (typeof node[htmlKey] === 'string') node[htmlKey] = escapeHtml(content.html);
  });
}

// 返回 [{ texts: 要翻的段落, apply(lookup) → 用上了几段 }]，lookup(原文) 返回译文。
// 不按类型名挑：GraphQL 里任何带正文的 content（帖子、评论，以及不认识的类型），REST 里的 body、selftext 都翻
function collectJobs(value) {
  var jobs = [];
  (function walk(v) {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!isObject(v) || v.__typename === 'AdPost') return;
    var rest = typeof v.selftext === 'string' || /^t3_/.test(v.name || '');
    if ((isPost(v) || v.__typename === 'TitleCell' || rest) && typeof v.title === 'string' && v.title.trim()) jobs.push(titleJob(v));
    if (ARGS.translate === 'all') {
      if (hasBody(v.content)) jobs.push(paragraphJob(v.content));
      if (typeof v.body === 'string' && typeof v.body_html === 'string') jobs.push(restJob(v, 'body', 'body_html'));
      if (typeof v.selftext === 'string' && v.selftext) jobs.push(restJob(v, 'selftext', 'selftext_html'));
    }
    Object.keys(v).forEach(function (k) { walk(v[k]); });
  })(value);
  return jobs.filter(Boolean);
}

// 调试用：响应里有哪些 __typename、各几个
function typenames(value) {
  var counts = {};
  (function walk(v) {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!isObject(v)) return;
    if (v.__typename) counts[v.__typename] = (counts[v.__typename] || 0) + 1;
    Object.keys(v).forEach(function (k) { walk(v[k]); });
  })(value);
  return Object.keys(counts).map(function (k) { return k + '×' + counts[k]; }).join(' ');
}

// 没有文字（纯表情、链接）、本来就是目标语言的不翻。目标是中文时，汉字过半又没有假名、谚文就算中文
function needsTranslation(text) {
  var letters = text.replace(/https?:\/\/\S+/g, '').match(/\p{L}/gu);
  if (!letters || letters.length < 2) return false;
  if (/^ZH/.test(ARGS.target)) {
    var han = (text.match(/\p{Script=Han}/gu) || []).length;
    if (han * 2 >= letters.length && !/[぀-ヿ가-힯]/.test(text)) return false;
  }
  return true;
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

// ---------- DeepL（照搬 youtube-subtitles.js） ----------

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

// Google 一段一个请求：帖子、评论里有换行，拼在一起拆不回来
async function google(texts, result) {
  await parallel(texts, 4, async function (text) {
    var r = await request('get', {
      url: 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=' + googleTarget() + '&q=' + encodeURIComponent(text),
      timeout: timeout(),
    });
    try {
      var out = JSON.parse(r.body)[0].map(function (seg) { return seg[0]; }).join('').trim();
      if (out) result[text] = out;
    } catch (e) {}
  });
}

function utf8Length(text) {
  var n = 0;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c <= 0xdbff) ? (i++, 4) : 3;
  }
  return n;
}

// 一段一个 text 发给 DeepL，每段单独识别语言。返回 { 原文: 译文 }
async function translate(texts, state) {
  var result = {};
  var batches = [];
  var batch = null;
  texts.forEach(function (t) {
    var size = utf8Length(t) + 16;
    if (!batch || batch.length >= TEXTS_PER_REQUEST || batch.size + size > BYTES_PER_REQUEST) {
      batch = [];
      batch.size = 0;
      batches.push(batch);
    }
    batch.push(t);
    batch.size += size;
  });
  var leftover = [];
  var deeplDown = !ARGS.keyList.length;
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
    log('DeepL 不可用，' + leftover.length + ' 段改用 Google');
    await google(leftover, result);
  }
  return result;
}

// ---------- 主流程 ----------

async function main() {
  var body = $response.body;
  if (!body || typeof body !== 'string' || !/^\s*[{[]/.test(body)) return null;
  var json = JSON.parse(body);
  if (ARGS.debug) {
    var root = isObject(json.data) ? 'data.' + Object.keys(json.data).join(',') : Array.isArray(json) ? 'array' : Object.keys(json).slice(0, 5).join(',');
    log($request.url.replace(/\?.*/, ''), root, typenames(json).slice(0, 300));
  }
  var removed = removeAds(json);
  if (removed) log('删掉广告 ' + removed + ' 条');
  if (removed) adsRemoved = JSON.stringify(json);

  var canTranslate = ARGS.translate !== 'off' && (ARGS.keyList.length || ARGS.fallback === 'google');
  var jobs = canTranslate ? collectJobs(json) : [];
  if (jobs.length) log('找到 ' + jobs.length + ' 处要看的文字');
  var texts = [];
  jobs.forEach(function (j) {
    j.texts.forEach(function (t) { if (texts.indexOf(t) === -1 && needsTranslation(t)) texts.push(t); });
  });
  var translated = 0;
  if (texts.length) {
    var cache = loadCache();
    var known = {};
    cache.forEach(function (e) { known[e[0]] = e[1]; });
    var map = {};
    var missing = [];
    texts.forEach(function (t) {
      var hit = known[cacheKey(t)];
      if (hit) map[t] = hit;
      else missing.push(t);
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
    var byNorm = {};
    texts.forEach(function (t) {
      if (map[t] && map[t] !== t && norm(t)) byNorm[norm(t)] = map[t];
    });
    var lookup = function (text) { var k = norm(text); return k ? byNorm[k] : undefined; };
    jobs.forEach(function (j) { translated += j.apply(lookup); });
    log('要翻 ' + texts.length + ' 段，缓存命中 ' + (texts.length - missing.length) + ' 段，用上 ' + translated + ' 段');
  }
  return removed || translated ? JSON.stringify(json) : null;
}

var adsRemoved = null;  // 广告删掉、还没翻译的版本，翻译超时就返回它
var finished = false;
function finish(out) {
  if (finished) return;
  finished = true;
  $done(out ? { body: out } : {});
}

// 兜底：卡住了就返回没翻译的版本（广告照样去掉），不影响 App 加载
setTimeout(function () { log('超时，返回没翻译的版本'); finish(adsRemoved); }, (ARGS.budget + 2) * 1000);

main().then(finish, function (error) {
  log('出错：' + (error && error.message));
  finish(adsRemoved);
});
