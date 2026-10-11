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
 *   model     模型名，默认 gpt-4.1-mini
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
var LLM_TAG = 'llm#';                   // 缓存里大模型译文的前缀，兜底的译文不带
var POST_KEY = 'reddit-last-post';      // 最近打开的帖子标题：评论有时单独一个响应，里面没有标题
var POST_SECONDS = 600;                 // 帖子标题多久内还算数

function parseArgs(raw) {
  var args = { keys: '', target: 'ZH-HANS', translate: 'all', fallback: 'google', budget: '4', debug: 'false', llmkeys: '', model: '', api: '' };
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
  // 占位文字（中文）会被滤掉，等于没填
  args.llmKeyList = args.llmkeys.split(/[|,\s]+/).filter(function (k) { return /^[\x21-\x7e]{20,}$/.test(k); });
  args.model = /^[\w.:\/-]+$/.test(args.model) ? args.model : 'gpt-4.1-mini';
  args.api = /^https?:\/\/[^\s"]+$/i.test(args.api) ? args.api.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') : 'https://api.openai.com/v1';
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

// 按顺序试 key：先用上次成功的那个，出错就换下一个。attempt(key) 返回 { ok, list } 或 { ok: false, status }。
// slot 是状态里记「上次成功的 key」（指纹）的字段。返回 list，全部失败返回 null
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

var LANG_NAMES = {
  ZH: 'Simplified Chinese', 'ZH-HANS': 'Simplified Chinese', 'ZH-HANT': 'Traditional Chinese',
  EN: 'English', 'EN-US': 'American English', 'EN-GB': 'British English', JA: 'Japanese', KO: 'Korean',
  FR: 'French', DE: 'German', ES: 'Spanish', IT: 'Italian', RU: 'Russian', PT: 'Portuguese', 'PT-BR': 'Brazilian Portuguese',
};

function targetName() { return LANG_NAMES[ARGS.target] || LANG_NAMES[ARGS.target.split('-')[0]] || ARGS.target; }

// gpt-5 系列默认先「思考」再回答，翻译用不着，关掉省时间；其他模型不带这个参数
function reasoningEffort(model) {
  if (/^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return 'minimal';
  if (/^gpt-5\.\d/.test(model)) return 'none';
  return '';
}

function llmOnce(key, system, payload, effort) {
  var body = {
    model: ARGS.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(payload) }],
    response_format: { type: 'json_object' },
  };
  if (effort) body.reasoning_effort = effort;
  return request('post', {
    url: ARGS.api + '/chat/completions',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: Math.max(2, Math.min(30, Math.ceil(remaining()))),
  }).then(function (r) {
    if (r.error) return { ok: false, status: 0 };
    // 这个模型不认 reasoning_effort：去掉再试一次
    if (r.status === 400 && effort && /reasoning/i.test(r.body)) return llmOnce(key, system, payload, '');
    if (r.status !== 200) {
      log('大模型出错，状态码 ' + r.status + '：' + String(r.body || '').slice(0, 200));
      // 401 key 无效按 403 暂停；429 里的额度用完（insufficient_quota）按 456 暂停
      return { ok: false, status: r.status === 401 ? 403 : r.status === 429 && /insufficient_quota/.test(r.body) ? 456 : r.status };
    }
    try {
      var content = JSON.parse(r.body).choices[0].message.content;
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
  payload[field] = numbered;
  var effort = reasoningEffort(ARGS.model);
  var reply = await withKeys(ARGS.llmKeyList, 'llm', state, function (key) { return llmOnce(key, system, payload, effort); }, 1);
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

// 按字数分组：一组不超过 LLM_CHARS 字、LLM_ITEMS 条。大模型一组要好几秒，组小一点、多组同时翻更快
function chunk(texts) {
  var groups = [];
  var g = null;
  texts.forEach(function (t) {
    if (!g || g.texts.length >= LLM_ITEMS || (g.texts.length && g.size + t.length > LLM_CHARS)) {
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
// 大模型晚到的结果照样用。返回 { best: 大模型的译文, rough: 兜底的译文 }
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
  await Promise.race([llmDone, sleep(remaining())]);  // 卡住的请求不等，到截止就用手上有的
  log('大模型翻好 ' + Object.keys(best).length + ' 段，兜底 ' + Object.keys(rough).length + ' 段');
  return { best: best, rough: rough };
}

// 兜底：缓存里有上次兜底的译文就直接用，剩下的交给 translate(texts) → Promise<{ 原文: 译文 }>
function fallbackWith(rough, translate) {
  if (!ARGS.keyList.length && ARGS.fallback !== 'google') return null;
  return function (left) {
    var out = {};
    var need = left.filter(function (t) { if (rough[t]) out[t] = rough[t]; return !rough[t]; });
    if (!need.length) return out;
    return translate(need).then(function (map) { Object.keys(map).forEach(function (t) { out[t] = map[t]; }); return out; });
  };
}

function redditPrompt() {
  var lang = targetName();
  return 'You translate Reddit posts and comments into ' + lang + '.\n'
    + 'Input is JSON: "post" is the title of the post this content belongs to (may be empty, e.g. on a feed), '
    + '"texts" holds titles and paragraphs keyed by number, in page order. Consecutive paragraphs usually come from the same post or comment.\n'
    + 'Use the post title and neighbouring paragraphs to understand the context, Reddit slang, abbreviations and jokes. '
    + 'Translate each text into natural ' + lang + ', the way a native speaker would write it. Keep the tone, emoji, '
    + 'u/ and r/ names, links and line breaks. Translate every text separately: do not merge, split or skip any, and do not add explanations.\n'
    + 'Reply with a JSON object mapping each text number to its translation, with exactly the same keys and nothing else.';
}

// 大模型的上下文：响应里只有一个帖子标题就是帖子页，记下来；好几个是信息流，不带；
// 一个都没有（评论单独一个响应）就用刚才打开的帖子
function postContext(jobs) {
  var titles = jobs.filter(function (j) { return j.title; }).map(function (j) { return j.title.trim(); })
    .filter(function (t, i, all) { return all.indexOf(t) === i; });
  if (titles.length === 1) {
    try { $persistentStore.write(JSON.stringify({ title: titles[0], at: now() }), POST_KEY); } catch (e) {}
    return titles[0];
  }
  if (titles.length) return '';
  try {
    var last = JSON.parse($persistentStore.read(POST_KEY) || '{}');
    return last.title && now() - last.at < POST_SECONDS ? last.title : '';
  } catch (e) {
    return '';
  }
}

// 用大模型翻：几段一组同时翻，带上帖子标题。返回 { best: 大模型的译文, rough: 兜底的译文 }
function translateWithLlm(texts, state, rough, post) {
  var system = redditPrompt();
  log('用大模型翻 ' + texts.length + ' 段，帖子：' + (post || '无'));
  return llmFirst(chunk(texts), function (g) {
    return llmTranslate(system, { post: post }, 'texts', g.texts, state);
  }, fallbackWith(rough, function (need) { return translate(need, state); }));
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

  var useLlm = ARGS.llmKeyList.length > 0;
  var canTranslate = ARGS.translate !== 'off' && (useLlm || ARGS.keyList.length || ARGS.fallback === 'google');
  var jobs = canTranslate ? collectJobs(json) : [];
  if (jobs.length) log('找到 ' + jobs.length + ' 处要看的文字');
  var post = useLlm && jobs.length ? postContext(jobs) : '';
  var texts = [];
  jobs.forEach(function (j) {
    j.texts.forEach(function (t) { if (texts.indexOf(t) === -1 && needsTranslation(t)) texts.push(t); });
  });
  var translated = 0;
  if (texts.length) {
    var cache = loadCache();
    var known = {};
    cache.forEach(function (e) { known[e[0]] = e[1]; });
    // 大模型的译文缓存时 key 前面加 LLM_TAG；不带的是 DeepL / Google 的，用大模型时只拿来兜底
    var map = {};
    var missing = [];
    var rough = {};
    texts.forEach(function (t) {
      var k = cacheKey(t);
      var hit = known[(useLlm ? LLM_TAG : '') + k];
      if (hit) map[t] = hit;
      else missing.push(t);
      if (!hit && useLlm && known[k]) rough[t] = known[k];
    });
    if (missing.length) {
      var state = loadState();
      var fresh = useLlm ? await translateWithLlm(missing, state, rough, post) : { best: {}, rough: await translate(missing, state) };
      saveState(state);
      var added = 0;
      Object.keys(fresh.rough).forEach(function (t) {
        map[t] = fresh.rough[t];
        if (!rough[t]) { cache.unshift([cacheKey(t), fresh.rough[t]]); added++; }
      });
      Object.keys(fresh.best).forEach(function (t) {
        map[t] = fresh.best[t];
        cache.unshift([LLM_TAG + cacheKey(t), fresh.best[t]]);
        added++;
      });
      if (added) saveCache(cache);
    }
    var byNorm = {};
    texts.forEach(function (t) {
      if (map[t] && map[t] !== t && norm(t)) byNorm[norm(t)] = map[t];
    });
    var lookup = function (text) { var k = norm(text); return k ? byNorm[k] : undefined; };
    jobs.forEach(function (j) { translated += j.apply(lookup); });
    var left = texts.filter(function (t) { return !map[t]; }).length;
    log('要翻 ' + texts.length + ' 段，缓存命中 ' + (texts.length - missing.length) + ' 段，用上 ' + translated + ' 段'
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
