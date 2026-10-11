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
 * 填了大模型 key（OpenAI 或兼容 OpenAI 的接口）就先用大模型翻，DeepL / Google 变成兜底，做法和
 * youtube-subtitles.js 一样：几段一组同时翻，按页面顺序排，同一条帖子、评论的几段挨在一起；帖子页带上帖子标题。
 * 快到截止还没翻好的先用 DeepL / Google 顶上，兜底的译文单独缓存，下次还会交给大模型重翻。
 *
 * 参数（模块里的 argument，用 & 分隔）：
 *   keys      DeepL key，多个用 | 分隔
 *   llmkeys   大模型 key，多个用 | 分隔
 *   model     模型名，默认 gpt-6-luna
 *   effort    大模型思考档位：auto 按模型自动关掉思考，off 不带参数，或者 none、low、medium 这些
 *   api       接口地址，默认 https://api.openai.com/v1
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
var GOOGLE_CHARS = 1500;                // Google 兜底一个请求最多拼多少字（放在网址里，不能太长）
var PARALLEL = 6;                       // 同时发几个请求：评论多的帖子拆成几份一起翻，不排队
var MIN_BYTES_PER_REQUEST = 2000;       // 内容少时不拆得太碎
var PAUSE = { 403: 7 * 86400, 456: 86400, 429: 60, 5: 300 };
var AD_LISTS = ['commentsPageAds', 'commentTreeAds', 'pdpCommentsAds'];
var LLM_PARALLEL = 8;                   // 大模型同时发几个请求
var LLM_CHARS = 600;                    // 一组最多多少字，组小一点每组回得快
var LLM_ITEMS = 40;                     // 一组最多多少段
var LLM_MIN_SECONDS = 3;                // 离截止不到这么多秒（限时很短时按一半）就不再开始新的一组
var FALLBACK_SECONDS = 2;               // 离截止还剩这么多秒时，大模型没翻好的交给 DeepL / Google
var POST_KEY = 'reddit-last-post';      // 最近打开的帖子标题：评论有时单独一个响应，里面没有标题
var POST_SECONDS = 600;                 // 帖子标题多久内还算数

function parseArgs(raw) {
  var args = { keys: '', target: 'ZH-HANS', translate: 'all', fallback: 'google', budget: '4', debug: 'false', llmkeys: '', model: '', api: '', effort: '' };
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
  return parseLlmArgs(args);
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
  return { texts: [node.title.trim()], title: node.title, apply: function (lookup) {
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

function deepl(texts, state) {
  return withKeys(ARGS.keyList, 'current', state, function (key) { return deeplOnce(key, texts); }, 0.5);
}

// 并发跑一组任务，离截止不到 minLeft 秒（默认 0.5）就不再开始新的
async function parallel(tasks, limit, run, minLeft) {
  var next = 0;
  async function worker() {
    while (next < tasks.length && remaining() > (minLeft || 0.5)) await run(tasks[next++]);
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
  if (!ARGS.keyList.length) return '没填 DeepL 密钥';
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

// 一段一个 text 发给 DeepL，每段单独识别语言。返回 { 原文: 译文 }
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
    log('DeepL 不可用，' + leftover.length + ' 段改用 Google');
    await google(leftover, result);
  }
  return result;
}

// ---------- 大模型：OpenAI 或兼容 OpenAI 的接口 ----------
// 这一段是 scripts/lib/llm.js 同步过来的，几个翻译脚本里都一样。要改就改 scripts/lib/llm.js，
// 再跑 python3 tools/sync_llm.py，别在脚本里直接改。
//
// 用到脚本自己定义的：ARGS（keyList、fallback、target，parseLlmArgs 加上的 llmKeyList、model、api、effort，
// 字幕用的 styleRule / subtitlePrompt 还要 style）、
// log、request、remaining、now、fingerprint、PAUSE、parallel(tasks, limit, run, minLeft)、loadState、saveState，
// 常量 LLM_PARALLEL、LLM_CHARS、LLM_ITEMS、LLM_MIN_SECONDS、FALLBACK_SECONDS。
// translateCached 默认还用 loadCache、saveCache、cacheKey 和 translate(texts, state)（DeepL + Google）。

var LLM_TAG = 'llm#';  // 缓存里大模型译文的 key 前缀，兜底的译文不带

// parseArgs 里调用：llmkeys、model、api、effort 四个参数。占位文字（中文）会被滤掉，等于没填。
// effort：auto 按模型自动关掉思考；off 不带这个参数（不支持思考的模型、别家接口）；其他照填
function parseLlmArgs(args) {
  args.llmKeyList = String(args.llmkeys || '').split(/[|,\s]+/).filter(function (k) { return /^[\x21-\x7e]{20,}$/.test(k); });
  // 脚本开头就调用，这一段的 var 还没赋值，所以默认值直接写在这里
  args.model = /^[\w.:\/-]+$/.test(args.model || '') ? args.model : 'gpt-6-luna';
  var effort = String(args.effort || '').toLowerCase();
  args.effort = /^(?:off|none|minimal|low|medium|high|xhigh|max)$/.test(effort) ? effort : 'auto';
  args.api = /^https?:\/\/[^\s"]+$/i.test(args.api || '') ? args.api.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') : 'https://api.openai.com/v1';
  return args;
}

// 按顺序试 key：先用上次成功的那个，出错就换下一个，并按错误暂停它。attempt(key) 返回 { ok, list } 或 { ok: false, status }。
// slot 是状态里记「上次成功的 key」（只存指纹）的字段。返回 list，全部失败返回 null
async function withKeys(keys, slot, state, attempt, minLeft) {
  keys = keys.slice();
  var start = keys.map(fingerprint).indexOf(state[slot]);
  if (start > 0) keys = keys.slice(start).concat(keys.slice(0, start));
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (state.paused[fingerprint(key)] > now()) continue;
    if (remaining() < minLeft) return null;
    var r = await attempt(key);
    if (r.ok) {
      state[slot] = fingerprint(key);
      return r.list;
    }
    var pause = PAUSE[r.status] || (r.status >= 500 ? PAUSE[5] : 0);
    log('key ' + fingerprint(key) + ' 失败，状态码 ' + r.status + (pause ? '，暂停 ' + pause + ' 秒' : ''));
    if (pause) state.paused[fingerprint(key)] = now() + pause;
  }
  return null;
}

var LANG_NAMES = {
  ZH: 'Simplified Chinese', 'ZH-HANS': 'Simplified Chinese', 'ZH-HANT': 'Traditional Chinese',
  EN: 'English', 'EN-US': 'American English', 'EN-GB': 'British English', JA: 'Japanese', KO: 'Korean',
  FR: 'French', DE: 'German', ES: 'Spanish', IT: 'Italian', RU: 'Russian', PT: 'Portuguese', 'PT-BR': 'Brazilian Portuguese',
};

function targetName() { return LANG_NAMES[ARGS.target] || LANG_NAMES[ARGS.target.split('-')[0]] || ARGS.target; }

// 会思考的模型默认先「思考」再回答（gpt-6-luna 默认 medium），翻译用不着，又慢又费钱，自动关到最低：
// 能填 none 的填 none，不能的填它支持的最低一档；不会思考的模型不带这个参数。
// 参数「大模型思考」不是 auto 时按它来，off 表示不带
function reasoningEffort(model) {
  if (ARGS.effort === 'off') return '';
  if (ARGS.effort !== 'auto') return ARGS.effort;
  model = String(model).replace(/^openai\//, '');  // OpenRouter 的模型名带 openai/ 前缀
  if (/^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return 'minimal';
  if (/^gpt-5\.\d/.test(model)) return 'none';
  if (/^gpt-6-(?:sol|luna)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return 'none';
  if (/^gpt-6/.test(model) || /^o\d/.test(model)) return 'low';  // GPT-6.1 Sol、Astra、o 系列没有 none
  return '';
}

// 模型不认这一档时退一步：none / minimal 换 low，再不认就不带参数
function lowerEffort(effort) {
  return effort === 'none' || effort === 'minimal' ? 'low' : '';
}

// 最近一次大模型请求：用时、实际的思考档位、思考用掉的 token。测试面板用，调试日志也打出来
var llmLast = null;

function llmOnce(key, system, payload, effort) {
  var body = {
    model: ARGS.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(payload) }],
    response_format: { type: 'json_object' },
  };
  if (effort) body.reasoning_effort = effort;
  var started = Date.now();
  return request('post', {
    url: ARGS.api + '/chat/completions',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: Math.max(2, Math.min(30, Math.ceil(remaining()))),
  }).then(function (r) {
    if (r.error) { llmLast = { ms: Date.now() - started, effort: effort || '-', status: 0, body: String(r.error) }; return { ok: false, status: 0 }; }
    // 这个模型不认这一档 reasoning_effort：退一步再试
    if (r.status === 400 && effort && /reasoning/i.test(r.body)) return llmOnce(key, system, payload, lowerEffort(effort));
    if (r.status !== 200) {
      log('大模型出错，状态码 ' + r.status + '：' + String(r.body || '').slice(0, 200));
      llmLast = { ms: Date.now() - started, effort: effort || '-', status: r.status, body: String(r.body || '').slice(0, 300) };
      // 401 key 无效按 403 暂停；429 里的额度用完（insufficient_quota）按 456 暂停
      return { ok: false, status: r.status === 401 ? 403 : r.status === 429 && /insufficient_quota/.test(r.body) ? 456 : r.status };
    }
    try {
      var reply = JSON.parse(r.body);
      var usage = reply.usage || {};
      llmLast = {
        ms: Date.now() - started, effort: effort || '-',
        reasoning: (usage.completion_tokens_details || {}).reasoning_tokens || 0,
        input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0,
      };
      log('大模型 ' + (llmLast.ms / 1000).toFixed(1) + ' 秒，思考 ' + llmLast.effort + '，思考 token ' + llmLast.reasoning
        + '，输入 ' + llmLast.input + ' / 输出 ' + llmLast.output + ' token');
      var content = reply.choices[0].message.content;
      return { ok: true, list: JSON.parse(String(content).replace(/^\s*```(?:json)?|```\s*$/g, '')) };
    } catch (e) {
      log('大模型返回的不是 JSON');
      return { ok: true, list: {} };  // key 没问题，这一组交给兜底
    }
  });
}

// 一组文字交给大模型：编号成 { "1": …, "2": … } 放进 payload[field]，payload 里其他字段是上下文。
// 返回 { 原文: 译文 }（模型漏掉的不在里面）；大模型用不了返回 null
async function llmTranslate(system, payload, field, items, state) {
  var numbered = {};
  items.forEach(function (t, i) { numbered[i + 1] = t; });
  var body = {};
  Object.keys(payload).forEach(function (k) { body[k] = payload[k]; });
  body[field] = numbered;
  var effort = reasoningEffort(ARGS.model);
  var reply = await withKeys(ARGS.llmKeyList, 'llm', state, function (key) { return llmOnce(key, system, body, effort); }, 1);
  if (!reply || typeof reply !== 'object') return reply ? {} : null;
  // 有的模型会再包一层，比如 { "translations": { "1": … } }
  var names = Object.keys(reply);
  if (names.length === 1 && reply[names[0]] && typeof reply[names[0]] === 'object') reply = reply[names[0]];
  var out = {};
  items.forEach(function (t, i) {
    var v = Array.isArray(reply) ? reply[i] : reply[i + 1];
    if (typeof v === 'string' && v.trim()) out[t] = v.trim();
  });
  return out;
}

// 按字数分组：一组不超过 chars（默认 LLM_CHARS）字、LLM_ITEMS 段。大模型一组要好几秒，组小一点、多组同时翻更快
function chunk(texts, chars) {
  var limit = chars || LLM_CHARS;
  var groups = [];
  var g = null;
  texts.forEach(function (t) {
    if (!g || g.texts.length >= LLM_ITEMS || (g.texts.length && g.size + t.length > limit)) {
      g = { texts: [], size: 0 };
      groups.push(g);
    }
    g.texts.push(t);
    g.size += t.length;
  });
  return groups;
}

function sleep(seconds) {
  return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, seconds * 1000)); });
}

// 大模型先翻，DeepL / Google 兜底。各组同时翻，runGroup(组) 返回 { 原文: 译文 }，大模型用不了返回 null。
// 离截止还剩 FALLBACK_SECONDS 秒时，还没翻好的（包括正在翻的）交给 fallback 先翻一版，大模型用不了就马上交。
// 大模型晚到的结果照样用，卡住的请求不等。返回 { best: 大模型的译文, rough: 兜底的译文 }
async function llmFirst(groups, runGroup, fallback) {
  var best = {};
  var rough = {};
  var down = false;
  var wake;
  var woken = new Promise(function (resolve) { wake = resolve; });
  var minLeft = Math.min(LLM_MIN_SECONDS, remaining() / 2);  // 限时很短时也至少翻第一批
  var llmDone = parallel(groups, LLM_PARALLEL, async function (g) {
    if (down) return;
    var out = await runGroup(g);
    if (!out) { down = true; wake(); return; }
    Object.keys(out).forEach(function (t) { best[t] = out[t]; });
  }, minLeft).then(wake);
  if (fallback) {
    await Promise.race([woken, sleep(remaining() - FALLBACK_SECONDS)]);
    var left = [];
    groups.forEach(function (g) { g.texts.forEach(function (t) { if (!(t in best)) left.push(t); }); });
    if (left.length) {
      log('大模型' + (down ? '用不了' : '还没翻完') + '，' + left.length + ' 段先用 DeepL / Google');
      rough = await fallback(left);
    }
  }
  await Promise.race([llmDone, sleep(remaining())]);
  log('大模型翻好 ' + Object.keys(best).length + ' 段，兜底 ' + Object.keys(rough).length + ' 段');
  var out = { best: {}, rough: rough };
  Object.keys(best).forEach(function (t) { out.best[t] = best[t]; });  // 截止后才到的不算
  return out;
}

// 兜底：缓存里有上次兜底的译文就直接用，剩下的交给 translate(texts) → Promise<{ 原文: 译文 }>。
// 没有 DeepL key 又关了 Google 兜底时返回 null
function fallbackWith(rough, translate) {
  if (!ARGS.keyList.length && ARGS.fallback !== 'google') return null;
  return function (left) {
    var out = {};
    var need = left.filter(function (t) { if (rough[t]) out[t] = rough[t]; return !rough[t]; });
    if (!need.length) return out;
    return translate(need).then(function (map) { Object.keys(map).forEach(function (t) { out[t] = map[t]; }); return out; });
  };
}

// 能不能翻：有大模型 key、DeepL key，或者开着 Google 兜底
function canTranslateAny() { return ARGS.llmKeyList.length > 0 || ARGS.keyList.length > 0 || ARGS.fallback === 'google'; }

// 查缓存，没有的去翻，翻好的存进缓存。返回 { 原文: 译文 }，没翻成的不在里面。
// 用大模型时：texts 按顺序几段一组发给它，opts.system 是提示词，opts.context 是一起发过去的上下文（对象），
// opts.field 是放文字的字段名（默认 texts）。大模型的译文缓存时 key 带 LLM_TAG；不带的是 DeepL / Google 的，
// 用大模型时只拿来兜底，下次还会交给大模型重翻。
// opts.load / save / key / translate 不填就用脚本里的 loadCache、saveCache、cacheKey、translate
async function translateCached(texts, opts) {
  var load = opts.load || loadCache;
  var save = opts.save || saveCache;
  var keyOf = opts.key || cacheKey;
  var fallbackTranslate = opts.translate || translate;
  var useLlm = ARGS.llmKeyList.length > 0;
  var cache = load();
  var known = {};
  cache.forEach(function (e) { known[e[0]] = e[1]; });
  var map = {};
  var missing = [];
  var rough = {};
  texts.forEach(function (t) {
    var k = keyOf(t);
    var hit = known[(useLlm ? LLM_TAG : '') + k];
    if (hit) map[t] = hit;
    else missing.push(t);
    if (!hit && useLlm && known[k]) rough[t] = known[k];
  });
  if (!missing.length) return map;
  var state = loadState();
  var fresh;
  if (useLlm) {
    log('用大模型翻 ' + missing.length + ' 段' + (opts.context ? '，上下文 ' + JSON.stringify(opts.context).slice(0, 120) : ''));
    fresh = await llmFirst(chunk(missing, opts.chars), function (g) {
      return llmTranslate(opts.system, opts.context || {}, opts.field || 'texts', g.texts, state);
    }, fallbackWith(rough, function (need) { return fallbackTranslate(need, state); }));
  } else {
    fresh = { best: {}, rough: await fallbackTranslate(missing, state) };
  }
  saveState(state);
  var added = 0;
  Object.keys(fresh.rough).forEach(function (t) {
    map[t] = fresh.rough[t];
    if (!rough[t]) { cache.unshift([keyOf(t), fresh.rough[t]]); added++; }
  });
  Object.keys(fresh.best).forEach(function (t) {
    map[t] = fresh.best[t];
    cache.unshift([LLM_TAG + keyOf(t), fresh.best[t]]);
    added++;
  });
  if (added) save(cache);
  return map;
}

// 页面的上下文（帖子、问题、Issue 的标题）：这个响应里只有一个标题就是详情页，记下来；
// 好几个是列表，不带；一个都没有（评论、回答单独一个响应）就用 seconds 秒内刚打开的那个
function pageContext(titles, storeKey, seconds) {
  titles = titles.map(function (t) { return String(t).trim(); }).filter(function (t, i, all) { return t && all.indexOf(t) === i; });
  if (titles.length === 1) {
    try { $persistentStore.write(JSON.stringify({ title: titles[0], at: now() }), storeKey); } catch (e) {}
    return titles[0];
  }
  if (titles.length) return '';
  try {
    var last = JSON.parse($persistentStore.read(storeKey) || '{}');
    return last.title && now() - last.at < (seconds || 600) ? last.title : '';
  } catch (e) {
    return '';
  }
}

// 提示词：what 说明翻的是什么、上下文字段是什么意思；extra 是额外要求
function llmPrompt(what, extra) {
  var lang = targetName();
  return 'You translate ' + what + ' into ' + lang + '.\n'
    + (extra ? extra + '\n' : '')
    + 'Translate each text into natural ' + lang + ', the way a native speaker would write it. Keep the tone, emoji, '
    + 'names, @mentions, links and line breaks. Translate every text separately: do not merge, split or skip any, '
    + 'and do not add explanations.\n'
    + 'Reply with a JSON object mapping each text number to its translation, with exactly the same keys and nothing else.';
}

// YouTube 字幕和评论的译法（参数 style）：faithful 贴着原文翻，对照着学外语；natural 更口语，可以意译
function styleRule() {
  var lang = targetName();
  if (ARGS.style === 'natural') {
    return 'Write natural, idiomatic ' + lang + ', the way a native speaker would say it. Free rephrasing is fine as long as the meaning is kept.';
  }
  return 'The viewer is learning the original language by reading it next to your translation, so translate faithfully, not freely: '
    + 'follow the original\'s logic and order of ideas so each part can be matched to its words; keep the speaker\'s tone, register '
    + 'and strength (casual, formal, joking, hedging, emphatic) without smoothing it over or embellishing; translate technical terms '
    + 'and key phrases with their standard ' + lang + ' equivalents, the same way every time; do not add, drop, summarize or explain '
    + 'anything. Still write grammatical, readable ' + lang + ': faithful, not word-for-word.';
}

// YouTube 字幕的提示词，测试面板也用它，面板测的就是字幕实际发出去的
function subtitlePrompt() {
  var lang = targetName();
  return 'You translate YouTube captions into ' + lang + '.\n'
    + 'Input is JSON: "video" is the video title and channel (may be empty), "before" and "after" hold the captions right '
    + 'before and after these (context only, do not translate them), "lines" holds the captions to translate, keyed by number.\n'
    + 'Captions are consecutive fragments of speech: one sentence often runs across several lines, and auto-generated captions '
    + 'have no punctuation and may mishear words. Read all lines together to understand what is being said, fix obvious mishearings, '
    + 'and keep names and terms consistent.\n'
    + 'Translate every line into ' + lang + '. ' + styleRule() + '\n'
    + 'Keep each translation aligned with its own line: do not move words to another line, merge lines or leave any out. '
    + 'Keep names, brands and technical terms that are usually not translated.\n'
    + 'Reply with a JSON object mapping each line number to its translation, with exactly the same keys and nothing else.';
}

// 发过去的是简单 HTML（GitHub、Stack Overflow）时加上这句
var HTML_RULE = 'Texts are small HTML snippets made of escaped text, <code>…</code> and <br>. Keep every <code> element '
  + 'with its content unchanged, keep <br> where it is, keep HTML entities such as &lt; and &amp; escaped, '
  + 'and translate only the text around them.';
// ---------- 大模型结束 ----------

function redditPrompt() {
  return llmPrompt('Reddit posts and comments',
    'Input is JSON: "post" is the title of the post this content belongs to (may be empty, e.g. on a feed), '
    + '"texts" holds titles and paragraphs keyed by number, in page order. Consecutive paragraphs usually come from the same post or comment. '
    + 'Use the post title and neighbouring paragraphs to understand the context, Reddit slang, abbreviations and jokes. Keep u/ and r/ names.');
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

  var canTranslate = ARGS.translate !== 'off' && canTranslateAny();
  var jobs = canTranslate ? collectJobs(json) : [];
  if (jobs.length) log('找到 ' + jobs.length + ' 处要看的文字');
  var post = ARGS.llmKeyList.length && jobs.length ? pageContext(jobs.map(function (j) { return j.title || ''; }), POST_KEY, POST_SECONDS) : '';
  var texts = [];
  jobs.forEach(function (j) {
    j.texts.forEach(function (t) { if (texts.indexOf(t) === -1 && needsTranslation(t)) texts.push(t); });
  });
  var translated = 0;
  if (texts.length) {
    var map = await translateCached(texts, { system: redditPrompt(), context: { post: post } });
    var byNorm = {};
    texts.forEach(function (t) {
      if (map[t] && map[t] !== t && norm(t)) byNorm[norm(t)] = map[t];
    });
    var lookup = function (text) { var k = norm(text); return k ? byNorm[k] : undefined; };
    jobs.forEach(function (j) { translated += j.apply(lookup); });
    var left = texts.filter(function (t) { return !map[t]; }).length;
    log('要翻 ' + texts.length + ' 段，用上 ' + translated + ' 段'
      + (left ? '，' + left + ' 段没翻完（超时或出错），重新打开会接着翻' : ''));
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
