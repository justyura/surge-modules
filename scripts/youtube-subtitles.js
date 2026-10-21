/*
 * YouTube 双语字幕：拦截 YouTube 的字幕文件（/api/timedtext），用 DeepL 翻译后
 * 把译文加回同一条字幕里。播放器不用改，选原文字幕（比如英文）就会变成双语。
 *
 * 多个 DeepL key 按顺序用，某个 key 出错就换下一个，并按错误类型暂停它一段时间：
 *   403 key 无效          → 7 天
 *   456 当月额度用完      → 24 小时后再试
 *   429 请求太频繁        → 1 分钟
 *   5xx                   → 5 分钟
 *   网络错误              → 不暂停，直接换下一个
 * 全部 key 都不行时，按设置用 Google 翻译兜底；再不行就原样返回字幕，不影响播放。
 *
 * 填了大模型 key（OpenAI 或兼容 OpenAI 的接口）就先用大模型翻，DeepL / Google 变成兜底：
 *   - 字幕按时间顺序分组，每组带上前面几句和视频标题，大模型能看懂整句话、纠正自动字幕听错的词
 *   - 评论带上视频标题，几条一组同时翻
 *   - 快到截止时间还没翻好的先用 DeepL / Google 顶上，大模型晚到的结果照样盖上去；
 *     兜底的译文单独缓存，下次打开还会交给大模型重翻
 *
 * 参数（模块里的 argument，用 & 分隔）：
 *   keys      DeepL key，多个用 | 分隔
 *   llmkeys   大模型 key，多个用 | 分隔，出错的暂停规则和 DeepL 一样（401 当 403，额度用完当 456）
 *   model     模型名，默认 gpt-6-luna
 *   summary   true：用大模型时先读一遍整条字幕，写出视频讲什么、术语怎么翻、哪些词听错了，每组都带上；false：不做
 *   style     大模型的译法：faithful 贴着原文翻（默认，对照着学外语），natural 更口语、可以意译
 *   effort    大模型思考档位：auto 按模型自动关掉思考，off 不带参数，或者 none、low、medium 这些
 *   api       接口地址，默认 https://api.openai.com/v1，DeepSeek 之类兼容 OpenAI 的接口也行
 *   target    目标语言，DeepL 的写法，比如 ZH-HANS、ZH-HANT、EN-US、JA
 *   position  top：原文在上；bottom：原文在下；only：只显示译文
 *   fallback  google：全部 key 失败时用 Google 翻译；off：不兜底
 *   budget    最多等几秒（默认 12）。到时间就先返回翻好的部分，没翻完的显示原文；
 *             翻好的会缓存，重新打开字幕会接着翻剩下的
 *   debug     true：在 Surge 日志里打印每次请求的细节
 *   expand    评论直接展开全文，不用点「展开」（默认 true）
 *   vocab     生词服务地址（vox 的 05_vocabularyService，比如 http://192.168.1.2:8090）。
 *             英文字幕会整段发过去，生词第一次出现的那句下面标上中文释义。不填就不标
 *
 * 同一个脚本也翻译 App 里的评论：作为 http-request 脚本挂在 /youtubei/v1/next 和 /browse 上
 * （评论区走 next，点进某条评论看回复走 browse）。这两个接口的响应已经被「App 去广告合集」
 * 的脚本占了（Surge 一个响应只跑一个脚本），所以在请求阶段认出评论请求，自己去 YouTube
 * 拿评论、翻译好直接当响应返回；其他请求原样放行。key、暂停状态、Google 兜底都和字幕共用。
 *
 * 还管字幕导出：处理字幕时把每句的时间、原文、译文记下来（最近 2 个视频）。在 Safari 里打开
 * https://yt-subtitles.internal/（可以带 ?v=视频ID），这个地址由本脚本作为 http-request 脚本直接回应：
 * 一个下载页面，和双语 / 原文 / 译文的 SRT、纯文本，以及整句文稿（碎片字幕合成段落，一段英文一段中文，
 * 用 DeepL 带上下文整段翻，翻好的存下来）。不会发到网上。
 */

var STORE_KEY = 'yt-subtitles-deepl';
var CUES_PER_TEXT = 60;          // 多少句字幕打包成一段发给 DeepL（用 <t> 标签隔开），一段一个请求
var CHARS_PER_TEXT = 4500;
var DEEPL_PARALLEL = 6;          // DeepL 同时发几个请求：每段单独一个请求、各带各的上下文
var CONTEXT_BEFORE = 600;        // 给 DeepL 的上下文：前面多少字
var CONTEXT_AFTER = 200;         // 后面多少字
var DOC_CHARS = 420;             // 整句文稿一段大约多少字
var DOC_MAX_CHARS = 650;
var DOC_PACK_CHARS = 4000;       // 文稿几段打包成一次 DeepL 请求
var DOC_BUDGET = 25;             // 文稿最多翻几秒，没翻完的刷新接着翻
var TEXTS_PER_REQUEST = 50;      // DeepL 一次最多 50 段
var BYTES_PER_REQUEST = 100000;  // DeepL 单次请求上限 128 KiB，留点余量
var PARALLEL = 3;                // 同时发几个请求
var CACHE_VIDEOS = 3;            // 缓存最近几个视频的翻译，拖进度条、重开字幕不重复花额度
var NOTES_PER_CUE = 2;           // 每句字幕最多标几个生词
var NOTE_CHARS = 10;             // 释义最多几个字
var EXPORT_STORE_KEY = 'yt-subtitles-export';
var EXPORT_VIDEOS = 2;           // 记最近几个视频的字幕给导出用
var EXPORT_HOST = /^https?:\/\/yt-subtitles\.internal\//;
var SWITCH_STORE_KEY = 'yt-subtitles-switch';  // 导出页上的「字幕翻译」开关：{ translate: false } 时只记原文
var USAGE_STORE_KEY = 'translate-usage';  // 最近几次实际用了哪个翻译，「翻译状态」面板读
var USAGE_RECORDS = 10;
var COMMENT_STORE_KEY = 'yt-comments-translations';
var COMMENT_CACHE = 300;         // 缓存最近多少条评论的译文
var COMMENT_BUDGET = 4;          // 评论最多等几秒翻译，比字幕短，翻不完的先显示原文
var COMMENT_FETCH_TIMEOUT = 10;  // 替 App 去 YouTube 拿评论最多等几秒
var COMMENT_MARK = 'X-Surge-YT-Comments';  // 自己发出的请求带这个头，免得再被自己拦一次
var LLM_PARALLEL = 16;           // 大模型同时发几个请求：大模型一组翻得慢，靠多组一起翻；等概要占了时间，多发几组补回来
var LLM_CHARS = 800;             // 字幕一组最多多少字，组小一点每组回得快
var LLM_ITEMS = 40;              // 一组最多多少句（条）
var LLM_COMMENT_CHARS = 500;     // 评论一组最多多少字
var LLM_MIN_SECONDS = 3;         // 离截止不到这么多秒（限时很短时按一半）就不再开始新的一组，开始了也翻不完
var LLM_CONTEXT_LINES = 10;      // 每组字幕带上前面几句当上下文
var LLM_CONTEXT_AFTER = 6;       // 还有后面几句：一组最后一句话常常在下一组才说完
var LLM_COMMENT_BUDGET = 6;      // 用大模型时评论最多等几秒
var FALLBACK_SECONDS = 2.5;      // 离截止还剩这么多秒时，大模型没翻好的交给 DeepL / Google
var VIDEO_STORE_KEY = 'yt-videos';
var VIDEO_CACHE = 30;            // 记住最近多少个视频的标题
var SUMMARY_STORE_KEY = 'yt-video-summaries';
var SUMMARY_CACHE = 20;          // 记住最近多少个视频的概要
var SUMMARY_CHARS = 120000;      // 整条字幕最多发多少字去做概要（大约两个半小时的视频）
var SUMMARY_MIN_LINES = 40;      // 字幕少于这么多句不做概要，前后几句已经差不多是全部了
var SUMMARY_WAIT = 6;            // 第一次打开时最多等概要几秒（限时的一半以内），没好就先不带，到了存下来下次用
var SUMMARY_TERMS = 30;          // 概要里最多多少个术语，多了概要回得慢
var SUMMARY_FIXES = 20;          // 最多多少个听错的词

var PAUSE = { 403: 7 * 86400, 456: 86400, 429: 60, 5: 300 };

function parseArgs(raw) {
  var args = { keys: '', target: 'ZH-HANS', position: 'top', fallback: 'google', budget: '12', debug: 'false', vocab: '', expand: 'true', llmkeys: '', model: '', api: '', effort: '', style: 'faithful', summary: 'true' };
  String(raw || '').split('&').forEach(function (part) {
    var i = part.indexOf('=');
    if (i <= 0) return;
    var value = part.slice(i + 1);
    try { value = decodeURIComponent(value); } catch (e) {}
    args[part.slice(0, i).trim()] = value.replace(/^"|"$/g, '').trim();
  });
  args.keyList = args.keys.split(/[|;,\s]+/).filter(function (k) { return /^[\w-]+(:fx)?$/i.test(k) && k.length > 20; });
  args.target = args.target.toUpperCase();
  args.budget = Math.min(50, Math.max(3, Number(args.budget) || 12));
  args.debug = args.debug === 'true';
  args.expand = args.expand !== 'false';
  args.style = args.style === 'natural' ? 'natural' : 'faithful';
  args.summary = args.summary !== 'false';
  args.vocab = /^https?:\/\/[^\s"]+$/i.test(args.vocab) ? args.vocab.replace(/\/+$/, '') : '';
  return parseLlmArgs(args);
}

var ARGS = parseArgs(typeof $argument === 'undefined' ? '' : $argument);
var DEADLINE = Date.now() + ARGS.budget * 1000;

function log() {
  if (ARGS.debug) console.log('[YouTube 字幕] ' + Array.prototype.join.call(arguments, ' '));
}

// 离截止时间还剩几秒
function remaining() { return (DEADLINE - Date.now()) / 1000; }

// ---------- 状态：暂停中的 key、当前在用的 key、翻译缓存 ----------

function loadState() {
  try {
    var state = JSON.parse($persistentStore.read(STORE_KEY) || '{}');
    return { paused: state.paused || {}, current: state.current || '', llm: state.llm || '', cache: state.cache || [] };
  } catch (e) {
    return { paused: {}, current: '', llm: '', cache: [] };
  }
}

function saveState(state) {
  try { $persistentStore.write(JSON.stringify(state), STORE_KEY); } catch (e) {}
}

// 状态里只存 key 的指纹，不存明文
function fingerprint(key) {
  var h = 5381;
  for (var i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return key.slice(-6) + '#' + h.toString(36);
}

function now() { return Math.floor(Date.now() / 1000); }

// ---------- HTTP ----------

function request(method, options) {
  return new Promise(function (resolve) {
    $httpClient[method](options, function (error, response, body) {
      var status = response ? (response.status || response.statusCode) : 0;
      noteUsage(options.url, error ? 0 : status);
      resolve({ error: error, status: status, body: body });
    });
  });
}

// 导出页上关掉「字幕翻译」时，字幕照样记下来（导出、发 Claude 用），只是不翻译、不花额度
function subtitleTranslateOn() {
  try { return JSON.parse($persistentStore.read(SWITCH_STORE_KEY) || '{}').translate !== false; } catch (e) { return true; }
}

// ---------- 记下这次实际用了哪个翻译（大模型 / DeepL / Google），给「翻译状态」面板看 ----------

var usage = {};  // 引擎 → { ok: 成功几次, fail: 失败几次, last: 最后一次失败的状态码 }

function engineOf(url) {
  url = String(url || '');
  if (/^https:\/\/api(-free)?\.deepl\.com\//.test(url)) return 'deepl';
  if (/^https:\/\/translate\.googleapis\.com\//.test(url)) return 'google';
  if (/\/chat\/completions$/.test(url)) return 'llm';
  return '';
}

function noteUsage(url, status) {
  var engine = engineOf(url);
  if (!engine) return;
  var u = usage[engine] || (usage[engine] = { ok: 0, fail: 0, last: 0 });
  if (status === 200) u.ok++;
  else { u.fail++; u.last = status; }
}

function saveUsage(what) {
  if (!Object.keys(usage).length) return;
  try {
    var list = JSON.parse($persistentStore.read(USAGE_STORE_KEY) || '[]');
    list.unshift({ at: now(), what: what, model: ARGS.llmKeyList.length ? ARGS.model : '', engines: usage });
    $persistentStore.write(JSON.stringify(list.slice(0, USAGE_RECORDS)), USAGE_STORE_KEY);
  } catch (e) {}
}

function timeout() { return Math.max(2, Math.min(10, Math.floor(remaining()))); }

// ---------- DeepL ----------

// context：DeepL 的上下文参数，只作参考、不翻译、不计费，对这个请求里所有段落都生效
function deeplOnce(key, texts, source, xml, context) {
  var host = /:fx$/i.test(key) ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  var body = { text: texts, target_lang: ARGS.target, preserve_formatting: true };
  if (xml) body.tag_handling = 'xml';
  if (context) body.context = context;
  if (source) body.source_lang = source;
  return request('post', {
    url: host + '/v2/translate',
    headers: { Authorization: 'DeepL-Auth-Key ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

function deepl(texts, source, state, xml, context) {
  return withKeys(ARGS.keyList, 'current', state, function (key) { return deeplOnce(key, texts, source, xml, context); }, 1);
}

// 上下文：视频标题，加上这一段前后的字幕（或段落）
function deeplContext(about, before, after) {
  var parts = [];
  if (about) parts.push('Video: ' + about);
  if (before) parts.push('Before: ' + before.slice(-CONTEXT_BEFORE));
  if (after) parts.push('After: ' + after.slice(0, CONTEXT_AFTER));
  return parts.join('\n');
}

// 几十句字幕打包成一段：<t>句1</t><t>句2</t>…，DeepL 按 XML 处理会保留标签，
// 一次请求能翻上千句，而且能看到上下文
function escapeTag(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function unescapeTag(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function pack(cues) {
  var units = [];
  var unit = null;
  cues.forEach(function (cue) {
    var piece = '<t>' + escapeTag(cue) + '</t>';
    if (!unit || unit.cues.length >= CUES_PER_TEXT || unit.text.length + piece.length > CHARS_PER_TEXT) {
      unit = { cues: [], text: '' };
      units.push(unit);
    }
    unit.cues.push(cue);
    unit.text += piece;
  });
  return units;
}

// DeepL 按整段翻译时，偶尔会把上一句末尾的标点挪到下一句开头，去掉
function cleanup(text) {
  return text.trim().replace(/^[，,、；;。]+\s*/, '');
}

function unpack(unit, translated) {
  var parts = [];
  String(translated || '').replace(/<t>([\s\S]*?)<\/t>/g, function (m, inner) { parts.push(cleanup(unescapeTag(inner))); return m; });
  return parts.length === unit.cues.length ? parts : null;
}

function utf8Length(text) {
  var n = 0;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c <= 0xdbff) ? (i++, 4) : 3;
  }
  return n;
}

// 把打包好的段落再分成请求：每个请求最多 50 段、不超过 100 KB
function group(units) {
  var requests = [];
  var current = null;
  units.forEach(function (unit) {
    var size = utf8Length(unit.text) + 16;  // 加上 JSON 引号、逗号和转义的余量
    if (!current || current.units.length >= TEXTS_PER_REQUEST || current.size + size > BYTES_PER_REQUEST) {
      current = { units: [], size: 0 };
      requests.push(current);
    }
    current.units.push(unit);
    current.size += size;
  });
  return requests;
}

// 并发跑一组任务，离截止不到 minLeft 秒（默认 1）就不再开始新的
async function parallel(tasks, limit, run, minLeft) {
  var next = 0;
  async function worker() {
    while (next < tasks.length && remaining() > (minLeft || 1)) await run(tasks[next++]);
  }
  var workers = [];
  for (var i = 0; i < Math.min(limit, tasks.length); i++) workers.push(worker());
  await Promise.all(workers);
}

// ---------- Google 兜底 ----------

function googleTarget() {
  var t = ARGS.target;
  if (t === 'ZH' || t === 'ZH-HANS') return 'zh-CN';
  if (t === 'ZH-HANT') return 'zh-TW';
  return t.split('-')[0].toLowerCase();
}

// 多句用换行拼成一段发过去，按换行拆回来；数量对不上的这一段就放弃
async function google(cues, result) {
  var chunks = [];
  var chunk = [];
  var length = 0;
  cues.forEach(function (cue) {
    var line = cue.replace(/\n/g, ' ');
    if (chunk.length && length + line.length > 3500) { chunks.push(chunk); chunk = []; length = 0; }
    chunk.push(cue);
    length += line.length + 1;
  });
  if (chunk.length) chunks.push(chunk);
  await parallel(chunks, 4, async function (lines) {
    var q = lines.map(function (l) { return l.replace(/\n/g, ' '); }).join('\n');
    var r = await request('get', {
      url: 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=' + googleTarget() + '&q=' + encodeURIComponent(q),
      timeout: timeout(),
    });
    try {
      var out = JSON.parse(r.body)[0].map(function (seg) { return seg[0]; }).join('').split('\n');
      if (out.length !== lines.length) return;
      lines.forEach(function (line, i) { if (out[i].trim()) result[line] = out[i].trim(); });
    } catch (e) {}
  });
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
    + 'Input is JSON: "video" is the video title and channel (may be empty), "summary" (may be missing) has notes on the whole '
    + 'video: "topic" says what it is about, "terms" gives the translation to use for names and terms, "fixes" maps words the '
    + 'captions misheard to what was actually said. "before" and "after" hold the captions right before and after these '
    + '(context only, do not translate them), "lines" holds the captions to translate, keyed by number.\n'
    + 'Captions are consecutive fragments of speech: one sentence often runs across several lines, and auto-generated captions '
    + 'have no punctuation and may mishear words. Read all lines together to understand what is being said, fix obvious mishearings, '
    + 'and keep names and terms consistent, using the translations in "terms".\n'
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

function commentPrompt() {
  var lang = targetName();
  return 'You translate YouTube comments into ' + lang + '.\n'
    + 'Input is JSON: "video" is the title and channel of the video they were posted under (may be empty), '
    + '"topic" (may be missing) says what the video is about, "comments" holds the comments keyed by number. Each comment stands on its own, but they share the video\'s topic: '
    + 'use it to understand references, names, slang and jokes.\n'
    + 'Translate each comment completely into ' + lang + '. ' + styleRule() + '\n'
    + 'Keep the emoji, @mentions, timestamps, links and line breaks.\n'
    + 'Reply with a JSON object mapping each comment number to its translation, with exactly the same keys and nothing else.';
}

// 视频标题和频道名，给大模型当上下文。用 oEmbed 拿，不用登录；最近看过的存起来。
// 回复（/browse）的请求里没有视频 ID，用最近的那个
function loadVideos() {
  try { return JSON.parse($persistentStore.read(VIDEO_STORE_KEY) || '[]'); } catch (e) { return []; }
}

async function videoInfo(id) {
  var list = loadVideos();
  if (!id) return list.length ? list[0][1] : '';
  var hit = list.filter(function (v) { return v[0] === id; })[0];
  var text = hit ? hit[1] : await request('get', {
    url: 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id),
    timeout: 2,
  }).then(function (r) {
    try { var j = JSON.parse(r.body); return [j.title, j.author_name].filter(Boolean).join(' — '); } catch (e) { return ''; }
  });
  if (!text) return '';
  list = [[id, text]].concat(list.filter(function (v) { return v[0] !== id; })).slice(0, VIDEO_CACHE);
  try { $persistentStore.write(JSON.stringify(list), VIDEO_STORE_KEY); } catch (e) {}
  return text;
}

// ---------- 视频概要：整条字幕先让大模型读一遍 ----------
// 分组翻的时候每组只看得到前后十几句，不知道整个视频在讲什么、前面定下的术语怎么翻。
// 所以第一次打开时先把整条字幕发过去，要回来视频讲什么、术语表、自动字幕听错的词，存起来；
// 之后每组都带上概要和这一组用得上的术语。评论也带上视频讲什么

function loadSummaries() {
  try { return JSON.parse($persistentStore.read(SUMMARY_STORE_KEY) || '[]'); } catch (e) { return []; }
}

function saveSummary(id, summary) {
  var list = [[id, summary]].concat(loadSummaries().filter(function (e) { return e[0] !== id; })).slice(0, SUMMARY_CACHE);
  try { $persistentStore.write(JSON.stringify(list), SUMMARY_STORE_KEY); } catch (e) {}
}

// 存下来的概要：没有视频 ID（评论的回复）就用最近的那个
function findSummary(videoId) {
  var list = loadSummaries();
  if (!videoId) return list.length ? list[0][1] : null;
  var hit = list.filter(function (e) { return e[0] === videoId + '|' + ARGS.target; })[0];
  return hit ? hit[1] : null;
}

function summaryPrompt() {
  var lang = targetName();
  return 'You prepare notes for translating the captions of a YouTube video into ' + lang + '.\n'
    + 'Input is JSON: "video" is the video title and channel (may be empty), "transcript" is the whole caption track, one caption '
    + 'per line. Auto-generated captions have no punctuation and may mishear words.\n'
    + 'Reply with a JSON object with exactly these keys:\n'
    + '"topic": 2 to 3 sentences in English: what the video is about, its field, who is speaking to whom, and the tone.\n'
    + '"terms": an object mapping up to ' + SUMMARY_TERMS + ' names, technical terms and recurring key phrases, written exactly as '
    + 'they appear in the transcript, to the ' + lang + ' translation to use every time: the standard established one, '
    + 'or the original for names and terms usually left untranslated.\n'
    + '"fixes": an object mapping words or phrases the captions clearly misheard, written exactly as they appear, '
    + 'to what was actually said. Empty if there are none.';
}

// 只留字符串对字符串，最多 limit 个
function stringMap(value, limit) {
  var out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  Object.keys(value).slice(0, limit).forEach(function (k) {
    if (k.trim() && typeof value[k] === 'string' && value[k].trim()) out[k.trim()] = value[k].trim();
  });
  return out;
}

function cleanSummary(reply) {
  if (!reply || typeof reply !== 'object' || typeof reply.topic !== 'string' || !reply.topic.trim()) return null;
  return { topic: reply.topic.trim().slice(0, 600), terms: stringMap(reply.terms, SUMMARY_TERMS), fixes: stringMap(reply.fixes, SUMMARY_FIXES) };
}

// 这个视频的概要：存过就直接用；没有就去要，最多等 SUMMARY_WAIT 秒（限时短时按一半），
// 没等到先返回 null，请求回来后照样存下来，下次打开用
function videoSummary(videoId, unique, video, state) {
  if (!ARGS.summary || !videoId || unique.length < SUMMARY_MIN_LINES) return Promise.resolve(null);
  var id = videoId + '|' + ARGS.target;
  var saved = findSummary(videoId);
  if (saved) { log('视频概要用存下来的'); return Promise.resolve(saved); }
  var transcript = unique.join('\n').slice(0, SUMMARY_CHARS);
  var effort = reasoningEffort(ARGS.model);
  var started = Date.now();
  var asking = withKeys(ARGS.llmKeyList, 'llm', state, function (key) {
    return llmOnce(key, summaryPrompt(), { video: video, transcript: transcript }, effort);
  }, 1).then(function (reply) {
    var summary = cleanSummary(reply);
    log(summary ? '视频概要 ' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒，术语 ' + Object.keys(summary.terms).length
      + ' 个，听错的词 ' + Object.keys(summary.fixes).length + ' 个：' + summary.topic : '没拿到视频概要');
    if (summary) saveSummary(id, summary);
    return summary;
  });
  return Promise.race([asking, sleep(Math.min(SUMMARY_WAIT, remaining() / 2)).then(function () { return null; })]);
}

// 一组字幕带的概要：视频讲什么，加上这一组（连同前后几句）里出现的术语和听错的词
function summaryFor(summary, texts) {
  if (!summary) return null;
  var text = texts.join('\n').toLowerCase();
  function pick(map) {
    var out = {};
    Object.keys(map).forEach(function (k) { if (text.indexOf(k.toLowerCase()) !== -1) out[k] = map[k]; });
    return out;
  }
  var out = { topic: summary.topic };
  var terms = pick(summary.terms);
  var fixes = pick(summary.fixes);
  if (Object.keys(terms).length) out.terms = terms;
  if (Object.keys(fixes).length) out.fixes = fixes;
  return out;
}

// ---------- 翻译调度 ----------

// 翻译一组不重复的文本，返回 { 原文: 译文 }。到截止时间就把已经翻好的返回
// videoId 用来查视频标题，给 DeepL 当上下文
async function translateAll(texts, source, state, cached, videoId) {
  var result = {};
  Object.keys(cached).forEach(function (k) { result[k] = cached[k]; });
  var todo = texts.filter(function (t) { return !(t in result); });
  // 一段一个请求：DeepL 的上下文对整个请求生效，每段要带自己前后的字幕
  var about = todo.length && ARGS.keyList.length ? await videoInfo(videoId) : '';
  var position = {};
  texts.forEach(function (t, i) { if (!(t in position)) position[t] = i; });
  var requests = pack(todo).map(function (unit) {
    var first = position[unit.cues[0]];
    var last = position[unit.cues[unit.cues.length - 1]];
    var before = texts.slice(Math.max(0, first - 30), first).join(' ');
    var after = texts.slice(last + 1, last + 8).join(' ');
    return { units: [unit], context: deeplContext(about, before, after) };
  });
  log('共 ' + texts.length + ' 句，缓存命中 ' + (texts.length - todo.length) + ' 句，分成 ' + requests.length + ' 个请求（带上下文' + (about ? '和视频标题' : '') + '），限时 ' + ARGS.budget + ' 秒');

  var loose = [];     // 标签对不上的句子，单独再翻
  var leftover = [];  // DeepL 不可用时留给 Google 的句子
  var deeplDown = !ARGS.keyList.length;

  await parallel(requests, DEEPL_PARALLEL, async function (req) {
    var list = deeplDown ? null : await deepl(req.units.map(function (u) { return u.text; }), source, state, true, req.context);
    if (!list) {
      if (remaining() > 1) deeplDown = true;
      req.units.forEach(function (u) { leftover.push.apply(leftover, u.cues); });
      return;
    }
    req.units.forEach(function (unit, i) {
      var parts = unpack(unit, list[i]);
      if (parts) unit.cues.forEach(function (cue, j) { if (parts[j]) result[cue] = parts[j]; });
      else loose.push.apply(loose, unit.cues);
    });
  });

  if (loose.length && !deeplDown) {
    log(loose.length + ' 句标签没对上，逐句重翻');
    var batches = [];
    for (var i = 0; i < loose.length; i += TEXTS_PER_REQUEST) batches.push(loose.slice(i, i + TEXTS_PER_REQUEST));
    await parallel(batches, PARALLEL, async function (batch) {
      var list = await deepl(batch, source, state, false);
      if (list) batch.forEach(function (cue, j) { if (list[j]) result[cue] = list[j]; });
      else leftover.push.apply(leftover, batch);
    });
  } else {
    leftover.push.apply(leftover, loose);
  }

  leftover = leftover.filter(function (t) { return !(t in result); });
  if (leftover.length && ARGS.fallback === 'google' && remaining() > 1) {
    log('DeepL 不可用，' + leftover.length + ' 句改用 Google');
    await google(leftover, result);
  }
  log('翻好 ' + Object.keys(result).length + ' / ' + texts.length + ' 句，剩余时间 ' + remaining().toFixed(1) + ' 秒');
  return result;
}

// 用大模型翻字幕：按时间顺序分组，开头的先翻好；每组带上前后几句和视频标题当上下文。
// 返回 { map: 显示用的译文, save: 存进缓存的 }。缓存里 map 是大模型的译文，
// rough 是兜底的译文，下次打开还会交给大模型重翻，大模型没翻到之前先用它
async function subtitlesWithLlm(unique, source, state, entry, videoId) {
  var best = {};
  Object.keys(entry ? entry.map : {}).forEach(function (t) { best[t] = entry.map[t]; });
  var rough = (entry && entry.rough) || {};
  var todo = unique.filter(function (t) { return !(t in best); });
  log('共 ' + unique.length + ' 句，大模型缓存命中 ' + (unique.length - todo.length) + ' 句，限时 ' + ARGS.budget + ' 秒');
  if (todo.length) {
    var video = await videoInfo(videoId);
    var summary = await videoSummary(videoId, unique, video, state);
    var position = {};
    unique.forEach(function (t, i) { position[t] = i; });
    var system = subtitlePrompt();
    var r = await llmFirst(chunk(todo, LLM_CHARS), function (g) {
      var at = position[g.texts[0]];
      var end = position[g.texts[g.texts.length - 1]] + 1;
      var before = unique.slice(Math.max(0, at - LLM_CONTEXT_LINES), at);
      var after = unique.slice(end, end + LLM_CONTEXT_AFTER);
      var context = { video: video };
      var notes = summaryFor(summary, before.concat(g.texts, after));
      if (notes) context.summary = notes;
      context.before = before;
      context.after = after;
      return llmTranslate(system, context, 'lines', g.texts, state);
    }, fallbackWith(rough, function (need) { return translateAll(need, source, state, {}); }));
    Object.keys(r.best).forEach(function (t) { best[t] = cleanup(r.best[t]); });
  }
  var keep = {};
  [rough, r ? r.rough : {}].forEach(function (m) { Object.keys(m).forEach(function (t) { if (!(t in best)) keep[t] = m[t]; }); });
  var map = {};
  [keep, best].forEach(function (m) { Object.keys(m).forEach(function (t) { map[t] = m[t]; }); });
  return { map: map, save: { map: best, rough: keep } };
}

// ---------- 字幕格式 ----------

function combine(original, translation, note) {
  var text = original;
  if (translation && translation !== original) {
    if (ARGS.position === 'only') text = translation;
    else if (ARGS.position === 'bottom') text = translation + '\n' + original;
    else text = original + '\n' + translation;
  }
  return note ? text + '\n' + note : text;
}

// ---------- 生词：调用自己的 vocabularyService ----------

// 整段字幕发过去，返回 [{ word, count, rank, translation }]，已经去掉了基础词和常用词
function fetchWords(texts) {
  var wait = Math.max(1, Math.min(4, Math.floor(remaining())));
  return request('post', {
    url: ARGS.vocab + '/v1/extract',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texts.join('\n') }),
    timeout: wait,
  }).then(function (r) {
    if (r.error || r.status !== 200) { log('生词服务出错：' + (r.error || r.status)); return null; }
    try { return JSON.parse(r.body).words || []; } catch (e) { log('生词服务返回的不是 JSON'); return null; }
  });
}

// ECDICT 的释义像「a. 普遍存在的, 无所不在的」「n. [医] 痉挛」，只留第一个意思
function shortMeaning(translation) {
  var text = String(translation || '').split(/\\n|\n/)[0]
    .replace(/^(?:[a-z]+\.\s*)+/i, '')
    .replace(/\[[^\]]*\]|（[^）]*）|\([^)]*\)/g, '')
    .split(/[,，;；、]/)[0]
    .trim();
  return text.length > NOTE_CHARS ? text.slice(0, NOTE_CHARS) + '…' : text;
}

// 每个生词只在第一次出现的那句下面标一次，返回 { 字幕序号: '词 释义 · 词 释义' }
function placeNotes(texts, words) {
  var notes = {};
  var counts = {};
  (words || []).forEach(function (w) {
    var meaning = shortMeaning(w.translation);
    if (!w.word || !meaning) return;
    var re = new RegExp("(^|[^A-Za-z'’])" + w.word.replace(/'/g, "['’]") + "(?![A-Za-z'’])", 'i');
    for (var i = 0; i < texts.length; i++) {
      if (!texts[i] || !re.test(texts[i])) continue;
      if ((counts[i] || 0) >= NOTES_PER_CUE) continue;
      counts[i] = (counts[i] || 0) + 1;
      notes[i] = (notes[i] ? notes[i] + ' · ' : '') + w.word + ' ' + meaning;
      break;
    }
  });
  return notes;
}

function decodeXml(s) {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|#39);/gi, function (m, e) {
    var map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (map[e.toLowerCase()]) return map[e.toLowerCase()];
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return m;
  });
}

function encodeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

var FORMATS = {
  // json3：{ events: [{ segs: [{ utf8 }] }] }，自动生成字幕是一个词一个 seg
  json3: {
    texts: function (doc) {
      return (doc.events || []).map(function (e) {
        return e.segs ? e.segs.map(function (s) { return s.utf8 || ''; }).join('').trim() : '';
      });
    },
    apply: function (doc, texts, map, notes) {
      (doc.events || []).forEach(function (e, i) {
        if (!texts[i]) return;
        e.segs = [{ utf8: combine(texts[i], map[texts[i]], notes[i]) }];
        delete e.wWinId; // 自动字幕的滚动窗口，去掉后按普通字幕显示
      });
      return doc;
    },
    times: function (doc) {
      return (doc.events || []).map(function (e) { return [e.tStartMs || 0, e.dDurationMs || 0]; });
    },
    parse: function (body) { return JSON.parse(body); },
    stringify: function (doc) { return JSON.stringify(doc); },
  },
  // srv3 / srv1 XML：<p t d>…</p> 或 <text start dur>…</text>
  xml: {
    RE: /(<(p|text)\b[^>]*>)([\s\S]*?)(<\/\2>)/g,
    texts: function (body) {
      var out = [];
      body.replace(this.RE, function (m, open, tag, inner) {
        out.push(decodeXml(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim());
        return m;
      });
      return out;
    },
    // srv3 是 <p t="毫秒" d="毫秒">，srv1 是 <text start="秒" dur="秒">
    times: function (body) {
      var out = [];
      body.replace(this.RE, function (m, open, tag) {
        var attr = function (name) { var a = new RegExp('\\b' + name + '="([\\d.]+)"').exec(open); return a ? Number(a[1]) : 0; };
        out.push(tag === 'p' ? [attr('t'), attr('d')] : [Math.round(attr('start') * 1000), Math.round(attr('dur') * 1000)]);
        return m;
      });
      return out;
    },
    apply: function (body, texts, map, notes) {
      var i = 0;
      return body.replace(this.RE, function (m, open, tag, inner, close) {
        var note = notes[i];
        var text = texts[i++];
        if (!text || (!map[text] && !note)) return m;
        return open + encodeXml(combine(text, map[text], note)) + close;
      });
    },
    parse: function (body) { return body; },
    stringify: function (body) { return body; },
  },
  // WebVTT：空行分隔的块，时间轴下面是字幕文本
  vtt: {
    blocks: function (body) { return body.replace(/\r\n?/g, '\n').split(/\n{2,}/); },
    texts: function (body) {
      return this.blocks(body).map(function (block) {
        var lines = block.split('\n');
        var at = lines.findIndex(function (l) { return l.indexOf('-->') !== -1; });
        return at === -1 ? '' : lines.slice(at + 1).join('\n').replace(/<[^>]+>/g, '').trim();
      });
    },
    times: function (body) {
      var ms = function (t) {
        var p = t.trim().split(':');
        return Math.round(p.reduce(function (n, x) { return n * 60 + Number(x); }, 0) * 1000);
      };
      return this.blocks(body).map(function (block) {
        var line = block.split('\n').filter(function (l) { return l.indexOf('-->') !== -1; })[0];
        if (!line) return null;
        var parts = line.split('-->');
        var start = ms(parts[0]);
        return [start, ms(parts[1].trim().split(/\s+/)[0]) - start];
      });
    },
    apply: function (body, texts, map, notes) {
      return this.blocks(body).map(function (block, i) {
        if (!texts[i] || (!map[texts[i]] && !notes[i])) return block;
        var lines = block.split('\n');
        var at = lines.findIndex(function (l) { return l.indexOf('-->') !== -1; });
        return lines.slice(0, at + 1).concat(combine(texts[i], map[texts[i]], notes[i])).join('\n');
      }).join('\n\n');
    },
    parse: function (body) { return body; },
    stringify: function (body) { return body; },
  },
};

function detect(url, body) {
  var fmt = (/[?&]fmt=([^&]+)/.exec(url) || [])[1];
  if (fmt === 'json3' || /^\s*\{/.test(body)) return 'json3';
  if (fmt === 'vtt' || /^\s*WEBVTT/.test(body)) return 'vtt';
  if (/^\s*</.test(body)) return 'xml';
  return null;
}

function param(url, name) {
  var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(url);
  return m ? decodeURIComponent(m[1]) : '';
}

// ---------- 评论：App 收到的是 protobuf ----------

// 评论正文的位置：frameworkUpdates(777) → entityBatchUpdate(1) → mutations(1) → payload(3)
// → commentEntityPayload(40) → properties(2) → content(3) → content(1)。
// 链接、加粗之类的范围（commandRuns / styleRuns）从开头算，译文接在末尾不影响它们
var COMMENT_TEXT_PATH = [777, 1, 1, 3, 40, 2, 3, 1];
// 「展开」按钮的状态：commentSurfaceEntityPayload(79) → inlineReadMoreButton(10) → isExpanded(2)
var COMMENT_EXPAND_PATH = [777, 1, 1, 3, 79, 10];

function readVarint(bytes, pos) {
  var value = 0;
  var scale = 1;
  var b;
  do {
    if (pos >= bytes.length) return null;
    b = bytes[pos++];
    value += (b & 0x7f) * scale;
    scale *= 128;
  } while (b & 0x80);
  return [value, pos];
}

function writeVarint(n) {
  var out = [];
  while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}

// 拆出一层字段，拆不开（不是合法的 protobuf）返回 null
function pbFields(bytes) {
  var out = [];
  var pos = 0;
  while (pos < bytes.length) {
    var start = pos;
    var tag = readVarint(bytes, pos);
    if (!tag || tag[0] < 8) return null;
    pos = tag[1];
    var wire = tag[0] % 8;
    var dataStart = pos;
    if (wire === 0) { var v = readVarint(bytes, pos); if (!v) return null; pos = v[1]; }
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) { var n = readVarint(bytes, pos); if (!n) return null; dataStart = n[1]; pos = n[1] + n[0]; }
    else return null;
    if (pos > bytes.length) return null;
    out.push({ field: Math.floor(tag[0] / 8), wire: wire, start: start, dataStart: dataStart, end: pos });
  }
  return out;
}

// 沿字段路径找到每一个叶子交给 edit，edit 返回新内容（Uint8Array）就替换，返回 null 不改。
// 改了返回整段新的 bytes（沿途的长度都重新算），没改返回 null
function pbRewrite(bytes, path, edit) {
  var fields = pbFields(bytes);
  if (!fields) return null;
  var parts = [];
  var last = 0;
  fields.forEach(function (f) {
    if (f.field !== path[0] || f.wire !== 2) return;
    var inner = bytes.subarray(f.dataStart, f.end);
    var replaced = path.length === 1 ? edit(inner) : pbRewrite(inner, path.slice(1), edit);
    if (!replaced) return;
    parts.push(bytes.subarray(last, f.start), new Uint8Array(writeVarint(f.field * 8 + 2).concat(writeVarint(replaced.length))), replaced);
    last = f.end;
  });
  if (!parts.length) return null;
  parts.push(bytes.subarray(last));
  var out = new Uint8Array(parts.reduce(function (n, p) { return n + p.length; }, 0));
  var at = 0;
  parts.forEach(function (p) { out.set(p, at); at += p.length; });
  return out;
}

// 评论区（/next）：continuation token 解开是 12 0d 12 0b <视频 ID> 18 06 …，base64 就是 Eg0SC…GAY，
// 打开评论区、往下翻都是这种 token；推荐视频翻页等其他 /next 请求不是。
// 回复（/browse）：browseId 是 FEcomment_watch_replies_panel，往下翻回复时它在 base64 的
// continuation token 里，按三种对齐方式分别是 RkVjb21tZW50、ZFY29tbWVu、GRWNvbW1lbnRf
function bodyText(body) {
  var text = '';
  for (var i = 0; i < body.length; i += 8192) text += String.fromCharCode.apply(null, body.subarray(i, i + 8192));
  return text;
}

function isCommentsRequest(body) {
  if (!body || !body.length) return false;
  return /Eg0SC[\w-]{15}GAY|FEcomment_|RkVjb21tZW50|ZFY29tbWVu|GRWNvbW1lbnRf/.test(bodyText(body));
}

// 评论区 token 的前 20 个字符解开是 12 0d 12 0b + 11 位视频 ID。回复的 token 里没有，返回空
function commentsVideoId(body) {
  var m = /Eg0SC[\w-]{15}/.exec(bodyText(body));
  if (!m) return '';
  var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var bytes = [];
  var bits = 0;
  var value = 0;
  for (var i = 0; i < m[0].length; i++) {
    value = ((value << 6) | alphabet.indexOf(m[0][i])) & 0xffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 255); }
  }
  var id = String.fromCharCode.apply(null, bytes.slice(4, 15));
  return /^[\w-]{11}$/.test(id) ? id : '';
}

// isExpanded 设成 true，其他字段不动
function expandButton(bytes) {
  var fields = pbFields(bytes);
  if (!fields) return null;
  var parts = [];
  fields.forEach(function (f) { if (f.field !== 2) parts.push.apply(parts, Array.prototype.slice.call(bytes.subarray(f.start, f.end))); });
  parts.push(0x10, 0x01);
  return new Uint8Array(parts);
}

// YouTube 在评论里给关键词加的搜索链接，显示成「词⁠关联」，翻译前去掉后面的标签
function commentSource(text) {
  return text.replace(/⁠\S*/g, '').trim();
}

// 没有文字（纯表情、链接）、本来就是目标语言的不翻。目标是中文时，汉字过半又没有假名就算中文
function needsTranslation(text) {
  var letters = text.match(/\p{L}/gu);
  if (!letters || letters.length < 2) return false;
  if (/^ZH/.test(ARGS.target)) {
    var han = (text.match(/\p{Script=Han}/gu) || []).length;
    if (han * 2 >= letters.length && !/[぀-ヿ가-힯]/.test(text)) return false;
  }
  return true;
}

function commentCacheKey(text) {
  var h = 5381;
  for (var i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return ARGS.target + '#' + text.length + '#' + h.toString(36);
}

function loadCommentCache() {
  try { return JSON.parse($persistentStore.read(COMMENT_STORE_KEY) || '[]'); } catch (e) { return []; }
}

function saveCommentCache(entries) {
  try { $persistentStore.write(JSON.stringify(entries.slice(0, COMMENT_CACHE)), COMMENT_STORE_KEY); } catch (e) {}
}

// 评论一条一段发给 DeepL，不打包：每条评论语言可能不一样，DeepL 按段识别语言
async function translateComments(texts, state, context) {
  var result = {};
  var batches = [];
  var batch = null;
  texts.forEach(function (t) {
    var size = utf8Length(t) + 16;
    if (!batch || batch.texts.length >= TEXTS_PER_REQUEST || batch.size + size > BYTES_PER_REQUEST) {
      batch = { texts: [], size: 0 };
      batches.push(batch);
    }
    batch.texts.push(t);
    batch.size += size;
  });
  var leftover = [];
  var deeplDown = !ARGS.keyList.length;
  await parallel(batches, PARALLEL, async function (b) {
    var list = deeplDown ? null : await deepl(b.texts, '', state, false, context);
    if (!list) {
      if (remaining() > 1) deeplDown = true;
      leftover.push.apply(leftover, b.texts);
      return;
    }
    b.texts.forEach(function (t, i) { if (list[i]) result[t] = list[i].trim(); });
  });
  if (leftover.length && ARGS.fallback === 'google' && remaining() > 1) {
    log('DeepL 不可用，' + leftover.length + ' 条评论改用 Google');
    await google(leftover, result);
  }
  return result;
}

// 替 App 把请求发出去，拿到原始响应（binary）
function fetchUpstream() {
  var headers = {};
  Object.keys($request.headers || {}).forEach(function (name) {
    if (/^(?::|content-length$|accept-encoding$|connection$|host$)/i.test(name)) return;
    headers[name] = $request.headers[name];
  });
  headers[COMMENT_MARK] = '1';
  return new Promise(function (resolve) {
    $httpClient.post({ url: $request.url, headers: headers, body: $request.body, timeout: COMMENT_FETCH_TIMEOUT, 'binary-mode': true }, function (error, response, body) {
      if (error || !response) { log('拿评论失败：' + error); return resolve(null); }
      var out = {};
      Object.keys(response.headers || {}).forEach(function (name) {
        if (!/^(?::|content-length$|content-encoding$|transfer-encoding$|connection$)/i.test(name)) out[name] = response.headers[name];
      });
      resolve({ status: response.status || response.statusCode, headers: out, body: body });
    });
  });
}

var commentFallback = null;  // 拿到原始评论后，超时就返回它

async function commentsMain() {
  var headers = $request.headers || {};
  var marked = Object.keys(headers).filter(function (name) { return name.toLowerCase() === COMMENT_MARK.toLowerCase(); });
  if (marked.length) {
    // 自己发出去的请求又经过了这里：去掉标记放行
    var clean = {};
    Object.keys(headers).forEach(function (name) { if (marked.indexOf(name) === -1) clean[name] = headers[name]; });
    return { headers: clean };
  }
  if (!(($request.body || {}) instanceof Uint8Array) || !isCommentsRequest($request.body)) return null;
  var canTranslate = canTranslateAny();
  if (!canTranslate && !ARGS.expand) { log('没有可用的 DeepL key'); return null; }

  // 视频标题给大模型当上下文，和拿评论同时进行
  var videoId = commentsVideoId($request.body);
  var video = ARGS.llmKeyList.length || ARGS.keyList.length ? videoInfo(videoId) : Promise.resolve('');
  var upstream = await fetchUpstream();
  if (!upstream) return null;  // 没拿到就让 App 自己的请求照常发出去
  var response = { status: upstream.status, headers: upstream.headers, body: upstream.body };
  commentFallback = { response: response };
  var body = upstream.body;
  if (upstream.status !== 200 || !(body instanceof Uint8Array)) return commentFallback;

  var map = canTranslate ? await translateCommentTexts(body, video, videoId) : {};
  var patched = Object.keys(map).length ? pbRewrite(body, COMMENT_TEXT_PATH, function (bytes) {
    var text = new TextDecoder().decode(bytes);
    var translation = map[text];
    return translation ? new TextEncoder().encode(text + '\n' + translation) : null;
  }) : null;
  body = patched || body;
  if (ARGS.expand) body = pbRewrite(body, COMMENT_EXPAND_PATH, expandButton) || body;
  response.body = body;
  return commentFallback;
}

// 评论的上下文：视频标题，看过字幕、有概要的话再加上视频讲什么
async function commentContext(video, videoId) {
  var context = { video: await video };
  var summary = findSummary(videoId);
  if (summary) context.topic = summary.topic;
  return context;
}

// 找出要翻的评论去翻译，返回 { 评论原文: 译文 }。video 是视频标题（Promise），videoId 可能是空的（回复），给大模型当上下文
async function translateCommentTexts(body, video, videoId) {
  var decoder = new TextDecoder();
  var originals = [];
  pbRewrite(body, COMMENT_TEXT_PATH, function (bytes) { originals.push(decoder.decode(bytes)); return null; });
  var sources = {};
  originals.forEach(function (text) {
    var source = commentSource(text);
    if (needsTranslation(source)) sources[text] = source;
  });
  var todo = Object.keys(sources).map(function (t) { return sources[t]; })
    .filter(function (t, i, all) { return all.indexOf(t) === i; });
  log('评论 ' + originals.length + ' 条，要翻 ' + todo.length + ' 条');
  if (!todo.length) return {};

  var budget = Math.min(ARGS.budget, ARGS.llmKeyList.length ? LLM_COMMENT_BUDGET : COMMENT_BUDGET);
  DEADLINE = Date.now() + budget * 1000;
  arm(budget + 2);
  var context = await commentContext(video, videoId);
  // DeepL 的上下文：评论是哪个视频下面的、视频讲什么
  var deeplAbout = context.video ? 'YouTube comments under the video: ' + context.video + (context.topic ? '\nThe video is about: ' + context.topic : '') : '';
  var map = await translateCached(todo, {
    system: commentPrompt(), context: context, field: 'comments', chars: LLM_COMMENT_CHARS,
    load: loadCommentCache, save: saveCommentCache, key: function (t) { return ARGS.style + '#' + commentCacheKey(t); },
    translate: function (texts, state) { return translateComments(texts, state, deeplAbout); },
  });
  log('翻好 ' + Object.keys(map).length + ' / ' + todo.length + ' 条');

  var result = {};
  Object.keys(sources).forEach(function (text) {
    var translation = map[sources[text]];
    if (translation && translation !== sources[text]) result[text] = translation;
  });
  return result;
}

// ---------- 字幕导出 ----------

function loadExports() {
  try { return JSON.parse($persistentStore.read(EXPORT_STORE_KEY) || '[]'); } catch (e) { return []; }
}

// 每句存成 [开始毫秒, 时长毫秒, 原文, 译文]
function remember(url, handler, doc, texts, map) {
  try { rememberCues(url, handler, doc, texts, map); } catch (e) { log('记录导出用的字幕出错：' + e.message); }
}

function rememberCues(url, handler, doc, texts, map) {
  // 地址里没有视频 ID 也照样记：导出页不带 ID 时显示最近的那个
  var v = param(url, 'v') || param(url, 'video_id') || 'latest';
  if (!handler.times) return;
  var times = handler.times(doc);
  var cues = [];
  texts.forEach(function (t, i) { if (t && times[i]) cues.push([times[i][0], times[i][1], t, map[t] || '']); });
  if (!cues.length) return;
  var list = loadExports().filter(function (e) { return e.v !== v; });
  var entry = { v: v, lang: param(url, 'lang') || param(url, 'tlang'), target: ARGS.target, cues: cues };
  // 翻好的整句文稿留着：同一份字幕重新处理一遍不用再翻
  var old = loadExports().filter(function (e) { return e.v === v; })[0];
  if (old && old.doc && old.cues.length === cues.length) entry.doc = old.doc;
  list.unshift(entry);
  var ok = false;
  try { ok = $persistentStore.write(JSON.stringify(list.slice(0, EXPORT_VIDEOS)), EXPORT_STORE_KEY); } catch (e) {}
  // 写不进去（多半是太大）就只留这一个视频
  if (ok === false) {
    try { ok = $persistentStore.write(JSON.stringify([entry]), EXPORT_STORE_KEY); } catch (e) {}
  }
  var translated = cues.filter(function (c) { return c[3]; }).length;
  log('记下 ' + cues.length + ' 句字幕（译文 ' + translated + ' 句）给导出用' + (ok === false ? '，但写入失败' : ''));
}

function srtTime(ms) {
  var pad = function (n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; };
  return pad(Math.floor(ms / 3600000), 2) + ':' + pad(Math.floor(ms / 60000) % 60, 2) + ':' + pad(Math.floor(ms / 1000) % 60, 2) + ',' + pad(ms % 1000, 3);
}

// mode：both 双语、original 原文、translation 译文（没翻好的句子用原文）
function cueText(cue, mode) {
  if (mode === 'original' || !cue[3]) return cue[2];
  return mode === 'translation' ? cue[3] : cue[2] + '\n' + cue[3];
}

// 自动生成字幕的每句会和下一句重叠，结束时间截到下一句开始
function toSrt(cues, mode) {
  return cues.map(function (cue, i) {
    var next = cues[i + 1];
    var end = cue[0] + (cue[1] || 2000);
    if (next && next[0] > cue[0] && end > next[0]) end = next[0];
    return (i + 1) + '\n' + srtTime(cue[0]) + ' --> ' + srtTime(end) + '\n' + cueText(cue, mode);
  }).join('\n\n') + '\n';
}

function toText(cues, mode) {
  return cues.map(function (cue) { return cueText(cue, mode); }).join(mode === 'both' ? '\n\n' : '\n') + '\n';
}

function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function page(title, inner) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + escapeHtml(title) + '</title><style>'
    + ':root{color-scheme:light dark;--bg:#fff;--fg:#111;--muted:#666;--card:#f2f2f2;--accent:#c00}'
    + '@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--muted:#999;--card:#222;--accent:#f55}}'
    + 'body{margin:0;padding:20px 16px;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,system-ui,sans-serif}'
    + 'h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 16px}'
    + 'a.b,button{display:block;width:100%;box-sizing:border-box;margin:0 0 10px;padding:12px;border:0;border-radius:10px;background:var(--card);color:var(--fg);font:inherit;text-align:center;text-decoration:none}'
    + '.doc{margin-top:16px}.doc p{color:var(--fg);margin:0 0 6px}.doc p.zh{margin:0 0 22px;color:var(--muted)}'
    + 'a.b.main,button.main{background:var(--accent);color:#fff}pre{white-space:pre-wrap;background:var(--card);padding:12px;border-radius:10px;font-size:14px}'
    + '</style></head><body>' + inner + '</body></html>';
}

// ---------- 整句文稿 ----------

// 自动字幕没有标点：攒到 DOC_CHARS 左右，在之后停顿最长的地方断开；人工字幕有标点：按句子合段
function buildParagraphs(cues) {
  var items = cues.map(function (c) { return { text: c[2].replace(/\s*\n\s*/g, ' ').trim(), start: c[0] }; })
    .filter(function (it) { return it.text; });
  var all = items.map(function (it) { return it.text; }).join(' ');
  var stops = (all.match(/[.!?。！？](?=\s|$)/g) || []).length;
  var paras = [];
  if (stops >= items.length * 0.3) {
    var sentences = all.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*|$)/g) || [all];
    var para = '';
    sentences.forEach(function (sentence) {
      para += (para ? ' ' : '') + sentence.trim();
      if (para.length >= DOC_CHARS) { paras.push(para); para = ''; }
    });
    if (para) paras.push(para);
  } else {
    var i = 0;
    while (i < items.length) {
      var length = 0;
      var j = i;
      while (j < items.length && length < DOC_CHARS * 0.7) { length += items[j].text.length + 1; j++; }
      var best = j;
      var bestGap = -1;
      for (var k = j; k < items.length && length < DOC_MAX_CHARS; k++) {
        var gap = items[k].start - items[k - 1].start;
        if (gap > bestGap) { bestGap = gap; best = k; }
        length += items[k].text.length + 1;
        if (k === items.length - 1 && length < DOC_MAX_CHARS) best = items.length;
      }
      paras.push(items.slice(i, best).map(function (it) { return it.text; }).join(' '));
      i = best;
    }
  }
  return paras.map(function (p) { return p.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
}

// 几段打包成一次请求（<p> 隔开），段落之间互为上下文，再带上包前后各一段。返回 { 段号: 译文 }
async function translateParagraphs(paras, todo, state, about) {
  var result = {};
  var packs = [];
  var current = null;
  todo.forEach(function (i) {
    var piece = '<p>' + escapeTag(paras[i]) + '</p>';
    if (!current || current.text.length + piece.length > DOC_PACK_CHARS || i !== current.index[current.index.length - 1] + 1) {
      current = { index: [], text: '' };
      packs.push(current);
    }
    current.index.push(i);
    current.text += piece;
  });
  var leftover = [];
  var deeplDown = !!deeplProblemText(state);
  await parallel(packs, DEEPL_PARALLEL, async function (pk) {
    var first = pk.index[0];
    var last = pk.index[pk.index.length - 1];
    var context = deeplContext(about, first > 0 ? paras[first - 1] : '', last + 1 < paras.length ? paras[last + 1] : '');
    var list = deeplDown ? null : await deepl([pk.text], '', state, true, context);
    var parts = [];
    if (list) String(list[0]).replace(/<p>([\s\S]*?)<\/p>/g, function (m, inner) { parts.push(unescapeTag(inner).trim()); return m; });
    if (list && parts.length === pk.index.length) {
      pk.index.forEach(function (i, j) { if (parts[j]) result[i] = parts[j]; });
      return;
    }
    if (!list && remaining() > 1) deeplDown = true;
    // 标签对不上：这一包逐段再翻一次
    var again = list ? await deepl(pk.index.map(function (i) { return paras[i]; }), '', state, false, context) : null;
    if (again) pk.index.forEach(function (i, j) { if (again[j]) result[i] = again[j].trim(); });
    else leftover.push.apply(leftover, pk.index);
  });
  if (leftover.length && ARGS.fallback === 'google' && remaining() > 1) {
    var byText = {};
    await google(leftover.map(function (i) { return paras[i]; }), byText);
    leftover.forEach(function (i) { if (byText[paras[i]]) result[i] = byText[paras[i]]; });
  }
  return result;
}

function deeplProblemText(state) {
  if (!ARGS.keyList.length) return 'no key';
  var usable = ARGS.keyList.some(function (k) { return !(state.paused[fingerprint(k)] > now()); });
  return usable ? '' : 'paused';
}

// 拿到这个视频的整句文稿：分好的段落和译文，翻过的存在导出记录里
async function transcript(entry) {
  var doc = entry.doc && entry.doc.target === ARGS.target ? entry.doc : { target: ARGS.target, paras: buildParagraphs(entry.cues), zh: [] };
  var todo = [];
  doc.paras.forEach(function (p, i) { if (!doc.zh[i] && needsTranslation(p)) todo.push(i); });
  if (todo.length && (ARGS.keyList.length || ARGS.fallback === 'google')) {
    DEADLINE = Date.now() + DOC_BUDGET * 1000;
    arm(DOC_BUDGET + 3);
    var state = loadState();
    var about = entry.v === 'latest' ? '' : await videoInfo(entry.v);
    var fresh = await translateParagraphs(doc.paras, todo, state, about);
    saveState(state);
    Object.keys(fresh).forEach(function (i) { doc.zh[i] = fresh[i]; });
    log('整句文稿 ' + doc.paras.length + ' 段，这次翻了 ' + Object.keys(fresh).length + ' 段');
    var list = loadExports();
    list.forEach(function (e) { if (e.v === entry.v) e.doc = doc; });
    try { $persistentStore.write(JSON.stringify(list), EXPORT_STORE_KEY); } catch (e) {}
  }
  var left = doc.paras.filter(function (p, i) { return !doc.zh[i] && needsTranslation(p); }).length;
  return { paras: doc.paras, zh: doc.zh, left: left };
}

function docText(doc) {
  return doc.paras.map(function (p, i) { return doc.zh[i] ? p + '\n' + doc.zh[i] : p; }).join('\n\n') + '\n';
}

// 原文：碎片字幕合成的段落，只有英文（或原来的语言），不用翻译
function originalText(entry) {
  return buildParagraphs(entry.cues).join('\n\n') + '\n';
}

// 发给 Claude 的提示词，字幕原文放在 [paste here]
var CLAUDE_PROMPT = [
  'Below is a full transcript of a video. Give me a detailed summary in Chinese that captures the key points — not a short overview.',
  '',
  'Structure it like this:',
  '1. One-paragraph gist: what the video is about and its central argument or takeaway.',
  '2. Key points, in the order they appear: for each, a short heading plus 2–4 sentences explaining the idea, the reasoning or evidence given, and any concrete examples, numbers, or names mentioned.',
  '3. Notable claims or recommendations the speaker makes explicitly.',
  '4. Terms or concepts worth knowing, each with a one-line explanation.',
  "5. Anything the speaker says is important but doesn't fully explain, or open questions left unresolved.",
  '',
  "Rules: write everything in Chinese, but keep technical terms and proper nouns in their original English alongside the Chinese. Stay faithful to what's actually said — don't add outside knowledge or interpretation. Skip filler, sponsor reads, and repetition. Length can be long; completeness matters more than brevity.",
  '',
  'Transcript:',
  '[paste here]',
].join('\n');

// Claude App 只收链接里 q 的前 120 个字左右（实测在第 119 个字截断），提示词放不进去。
// 所以链接里只带一句短话，完整内容（提示词 + 视频标题 + 原文）放剪贴板，粘贴后长的会变成附件，提示词在附件开头
var CLAUDE_HINT = 'Follow the instructions at the top of the text I paste below.';

function claudePrompt(title, text) {
  var body = (title ? 'Video title: ' + title + '\n\n' : '') + text.trim();
  return CLAUDE_PROMPT.replace('[paste here]', function () { return body; });
}

// 在 Claude App 里开一个新对话，输入框里填好那句短话（claude://claude.ai/new?q=，非官方但能用）
function claudeUrl() {
  return 'claude://claude.ai/new?q=' + encodeURIComponent(CLAUDE_HINT);
}

async function exportMain() {
  var url = $request.url;
  var v = param(url, 'v');
  // 「字幕翻译」开关：?translate=off / on，存下来再回到导出页
  var set = param(url, 'translate');
  // 给快捷指令（控制中心）用：切换一下，直接返回一句现在的状态，不跳网页
  if (set === 'toggle') {
    var nowOn = !subtitleTranslateOn();
    try { $persistentStore.write(JSON.stringify({ translate: nowOn }), SWITCH_STORE_KEY); } catch (e) {}
    return { response: { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      body: nowOn ? '字幕翻译：已打开' : '字幕翻译：已关掉（只记原文，不花额度）' } };
  }
  if (set === 'on' || set === 'off') {
    try { $persistentStore.write(JSON.stringify({ translate: set === 'on' }), SWITCH_STORE_KEY); } catch (e) {}
    return { response: { status: 302, headers: { Location: '/' + (v ? '?v=' + encodeURIComponent(v) : ''), 'Cache-Control': 'no-store' } } };
  }
  var translateOn = subtitleTranslateOn();
  var toggle = '<a class="b" href="/?' + (v ? 'v=' + encodeURIComponent(v) + '&' : '') + 'translate=' + (translateOn ? 'off' : 'on') + '">'
    + (translateOn ? '字幕翻译：开着 · 点这里关掉（只发 Claude 时不花 DeepL 额度）' : '字幕翻译：关着 · 点这里打开') + '</a>';
  var exports = loadExports();
  // 不带视频 ID（按钮拿不到 ID 时）：用最近打开过字幕的那个视频
  var entry = v ? exports.filter(function (e) { return e.v === v; })[0] : exports[0];
  var html = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
  if (!entry) {
    return { response: { status: 200, headers: html, body: page('导出字幕', '<h1>还没有这个视频的字幕</h1>'
      + '<p>先在 YouTube 里打开字幕，等字幕显示出来（双语的话等译文出来），再打开这个页面。最近 ' + EXPORT_VIDEOS + ' 个打开过字幕的视频可以导出。</p>'
      + toggle) } };
  }
  var mode = /^(both|original|translation)$/.test(param(url, 'mode')) ? param(url, 'mode') : 'both';
  var fmt = param(url, 'fmt');
  var name = entry.v + '.' + (entry.lang || 'sub') + (mode === 'both' ? '.' + entry.target.toLowerCase() : mode === 'translation' ? '.' + entry.target.toLowerCase() + '-only' : '');
  var plain = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
  // 给快捷指令用：原文纯文本、打开 Claude 的链接
  if (fmt === 'original') return { response: { status: 200, headers: plain, body: originalText(entry) } };
  // 给快捷指令：剪贴板里放完整内容（提示词 + 标题 + 原文；paste 和 prompt 一样），再打开 Claude
  if (fmt === 'paste' || fmt === 'prompt') {
    return { response: { status: 200, headers: plain, body: claudePrompt(entry.v === 'latest' ? '' : await videoInfo(entry.v), originalText(entry)) } };
  }
  if (fmt === 'claudeurl') return { response: { status: 200, headers: plain, body: claudeUrl() } };
  if (fmt === 'srt') {
    return { response: { status: 200, headers: {
      'Content-Type': 'application/x-subrip; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + name + '.srt"',
      'Cache-Control': 'no-store',
    }, body: toSrt(entry.cues, mode) } };
  }
  if (fmt === 'doc' || fmt === 'doctxt') {
    var doc = await transcript(entry);
    if (fmt === 'doctxt') {
      return { response: { status: 200, headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + entry.v + '.transcript.txt"',
        'Cache-Control': 'no-store',
      }, body: docText(doc) } };
    }
    var body = doc.paras.map(function (p, i) {
      return '<div class="para"><p class="en">' + escapeHtml(p) + '</p>' + (doc.zh[i] ? '<p class="zh">' + escapeHtml(doc.zh[i]) + '</p>' : '') + '</div>';
    }).join('');
    var allText = JSON.stringify(docText(doc)).replace(/</g, '\\u003c');
    return { response: { status: 200, headers: html, body: page('整句文稿', '<h1>整句文稿</h1>'
      + '<p>视频 ' + escapeHtml(entry.v) + ' · ' + doc.paras.length + ' 段'
      + (doc.left ? '，还有 ' + doc.left + ' 段没翻完，刷新接着翻' : '') + '</p>'
      + '<a class="b main" href="/?v=' + encodeURIComponent(entry.v) + '&fmt=doctxt">下载文稿 TXT</a>'
      + '<button id="copy">复制全部文字</button>'
      + '<div class="doc">' + body + '</div>'
      + '<script>var all=' + allText + ';document.getElementById("copy").onclick=function(){var b=this;'
      + 'navigator.clipboard.writeText(all).then(function(){b.textContent="已复制"},function(){b.textContent="复制失败，用「下载文稿 TXT」"})}</script>') } };
  }
  if (fmt === 'txt') {
    return { response: { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, body: toText(entry.cues, mode) } };
  }
  var translated = entry.cues.filter(function (c) { return c[3]; }).length;
  var link = function (m, f, label, cls) {
    return '<a class="b' + (cls ? ' ' + cls : '') + '" href="/?v=' + encodeURIComponent(entry.v) + '&mode=' + m + '&fmt=' + f + '">' + label + '</a>';
  };
  var buttons = link('both', 'doc', '整句文稿（一段英文一段中文）', 'main') + (translated
    ? link('both', 'srt', '下载双语 SRT') + link('original', 'srt', '下载原文 SRT') + link('translation', 'srt', '下载译文 SRT')
      + link('both', 'txt', '查看双语纯文本') + link('original', 'txt', '查看原文纯文本')
    : link('original', 'srt', '下载 SRT') + link('original', 'txt', '查看纯文本'));
  var preview = entry.cues.slice(0, 6).map(function (c) { return escapeHtml(cueText(c, 'both')); }).join('\n\n');
  var json = function (value) { return JSON.stringify(value).replace(/</g, '\\u003c'); };
  var original = originalText(entry);
  var claude = claudeUrl();
  var prompt = claudePrompt(entry.v === 'latest' ? '' : await videoInfo(entry.v), original);
  return { response: { status: 200, headers: html, body: page('导出字幕', '<h1>导出字幕</h1>'
    + '<p>视频 ' + escapeHtml(entry.v) + ' · ' + escapeHtml(entry.lang || '未知语言') + ' · ' + entry.cues.length + ' 句'
    + (translated ? '，译文 ' + translated + ' 句' : '，没有译文') + '</p>'
    + '<button id="claude" class="main">在 Claude 中打开原文</button>'
    + toggle
    + '<button id="orig">复制原文</button>'
    + buttons
    + '<button id="copy">复制双语文字</button>'
    + '<pre>' + preview + (entry.cues.length > 6 ? '\n\n…' : '') + '</pre>'
    + '<script>var original=' + json(original) + ',all=' + json(toText(entry.cues, translated ? 'both' : 'original')) + ',claude=' + json(claude) + ',prompt=' + json(prompt) + ';'
    + 'function copy(id,text,done){document.getElementById(id).onclick=function(){var b=this;'
    + 'navigator.clipboard.writeText(text).then(function(){done?done():b.textContent="已复制"},function(){done?done():b.textContent="复制失败，用「查看纯文本」"})}}'
    // 先把提示词 + 原文放进剪贴板，再打开 Claude，长按粘贴（长的会变成附件）
    + 'copy("claude",prompt,function(){location.href=claude});copy("orig",original);copy("copy",all);</script>') } };
}

// ---------- 主流程 ----------

function main() {
  var url = $request.url;
  var body = $response.body;
  var lang = param(url, 'lang').toLowerCase();
  log(url);

  if (!body || typeof body !== 'string') return Promise.resolve(null);
  var format = detect(url, body);
  if (!format) { log('不认识的字幕格式'); return Promise.resolve(null); }
  var handler = FORMATS[format];
  var doc = handler.parse(body);
  var texts = handler.texts(doc);
  // 不翻译的字幕也记下来，导出时用
  function skip(reason) { log(reason); remember(url, handler, doc, texts, {}); return Promise.resolve(null); }

  if (param(url, 'tlang')) return skip('YouTube 自带翻译字幕，跳过');
  if (lang && lang.split('-')[0] === ARGS.target.split('-')[0].toLowerCase()) return skip('已经是目标语言，跳过');
  var wantVocab = !!ARGS.vocab && (!lang || lang.split('-')[0] === 'en');
  var useLlm = ARGS.llmKeyList.length > 0;
  var translateOn = subtitleTranslateOn();
  var canTranslate = translateOn && canTranslateAny();
  if (!canTranslate && !wantVocab) return skip(translateOn ? '没有可用的 DeepL key' : '字幕翻译关着，只记原文给导出用');

  var seen = {};
  var unique = texts.filter(function (t) { if (!t || seen[t]) return false; seen[t] = true; return true; });
  if (!unique.length) return Promise.resolve(null);

  var state = loadState();
  // 大模型和 DeepL 的译文分开缓存，换了模型也重翻
  var cacheId = [param(url, 'v'), lang, param(url, 'kind'), ARGS.target].concat(useLlm ? [ARGS.model, ARGS.style] : []).join('|');
  var entry = state.cache.filter(function (c) { return c.id === cacheId; })[0];
  var cached = entry ? entry.map : {};
  // 先记一份（原文 + 缓存里的译文）：翻译超时被兜底提前返回时，后面那次记录可能来不及跑
  remember(url, handler, doc, texts, cached);
  // DeepL 的源语言写法：en、ja → EN、JA；自动生成字幕的语言也能用
  var source = lang ? lang.split('-')[0].toUpperCase() : '';

  var words = !wantVocab ? Promise.resolve(null)
    : entry && entry.words ? Promise.resolve(entry.words)
    : fetchWords(unique);

  var translating = !canTranslate ? Promise.resolve({ map: cached, save: { map: cached } })
    : useLlm ? subtitlesWithLlm(unique, source, state, entry, param(url, 'v'))
    : translateAll(unique, source, state, cached, param(url, 'v')).then(function (map) { return { map: map, save: { map: map } }; });

  return Promise.all([translating, words]).then(function (results) {
    var map = results[0].map;
    var list = results[1];
    var saved = results[0].save;
    saved.id = cacheId;
    if (list) saved.words = list;
    state.cache = state.cache.filter(function (c) { return c.id !== cacheId; });
    state.cache.unshift(saved);
    state.cache = state.cache.slice(0, CACHE_VIDEOS);
    saveState(state);
    remember(url, handler, doc, texts, map);
    var notes = placeNotes(texts, list);
    log('生词 ' + (list ? list.length : '-') + ' 个，标在 ' + Object.keys(notes).length + ' 句下面');
    if (!Object.keys(map).length && !Object.keys(notes).length) { log('没有拿到任何翻译，保持原字幕'); return null; }
    return { body: handler.stringify(handler.apply(doc, texts, map, notes)) };
  });
}

// 三种用法：字幕响应、导出页面（请求 yt-subtitles.internal）、评论请求
var EXPORT = typeof $response === 'undefined' && EXPORT_HOST.test($request.url);
var COMMENTS = typeof $response === 'undefined' && !EXPORT;
var finished = false;
var guard = null;
function finish(out) {
  if (finished) return;
  finished = true;
  clearTimeout(guard);
  saveUsage(EXPORT ? '整句文稿' : COMMENTS ? '评论' : '字幕');
  $done(out || {});
}

// 兜底：无论哪里卡住，到时间就原样返回，保证字幕、评论能加载出来
function arm(seconds) {
  clearTimeout(guard);
  guard = setTimeout(function () { log('超时，原样返回'); finish(COMMENTS ? commentFallback : null); }, seconds * 1000);
}
arm(COMMENTS ? COMMENT_FETCH_TIMEOUT + 2 : ARGS.budget + 3);

// 同步抛出的异常也要接住：不接的话 $done 永远不调，App 等到超时报「加载字幕时出错」
Promise.resolve().then(function () { return EXPORT ? exportMain() : COMMENTS ? commentsMain() : main(); }).then(finish, function (error) {
  log('出错：' + (error && error.message));
  finish(COMMENTS ? commentFallback : null);
});
