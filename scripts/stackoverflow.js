/*
 * Stack Overflow App 翻译：处理第三方客户端（比如 Octostack）用的 Stack Exchange 官方接口
 * api.stackexchange.com 的响应，问题标题、问题、回答、评论加上 DeepL 译文。
 *
 * 接口返回 { items: [...] }，问题、回答、评论都带 question_id / answer_id / comment_id：
 *   - title：标题，HTML 转义过的纯文字，译文接在下一行
 *   - body：HTML。正文按段插，一段（p、h1-h6、li）原文后面紧跟它的译文；评论的 body
 *     没有段落标签，译文用 <br> 接在后面
 *   - body_markdown：markdown（也是 HTML 转义过的），空行分段，同样一段原文一段译文
 * App 用 body 还是 body_markdown 显示不确定，有的都改。代码块不翻，行内代码原样保留。
 *
 * DeepL 部分照搬 reddit.js：多个 key 按顺序用，出错按类型暂停，全部不行用 Google 兜底。
 * key 的暂停状态和 YouTube 字幕、Reddit 存在同一个地方。
 *
 * 参数（模块里的 argument，用 & 分隔）：
 *   keys      DeepL key，多个用 | 分隔
 *   target    目标语言，DeepL 的写法，比如 ZH-HANS、ZH-HANT、EN-US、JA
 *   translate all：标题、正文、评论；post：不翻评论；title：只翻标题；off：不翻
 *   fallback  google：全部 key 失败时用 Google 翻译；off：不兜底
 *   answers   一个响应里最多翻几个回答（默认 10，0 不限）。热门问题一次返回上百个回答，全翻很费额度
 *   budget    最多等几秒翻译（默认 5），到时间没翻完的显示原文
 *   debug     true：在 Surge 日志里打印细节
 */

var STATE_KEY = 'yt-subtitles-deepl';   // 和 YouTube 字幕、Reddit、Stack Overflow 网页翻译共用 key 的暂停状态
var CACHE_KEY = 'stackoverflow-translations';
var CACHE_SIZE = 800;                   // 缓存最近多少段译文
var TEXTS_PER_REQUEST = 50;             // DeepL 一次最多 50 段
var BYTES_PER_REQUEST = 100000;         // DeepL 单次请求上限 128 KiB，留点余量
var MAX_CHARS = 5000;                   // 再长的一段不翻
var GOOGLE_CHARS = 1500;                // Google 兜底一个请求最多拼多少字（放在网址里，不能太长）
var PARALLEL = 6;                       // 同时发几个请求：回答多的问题拆成几份一起翻，不排队
var MIN_BYTES_PER_REQUEST = 2000;       // 内容少时不拆得太碎
var PAUSE = { 403: 7 * 86400, 456: 86400, 429: 60, 5: 300 };

function parseArgs(raw) {
  var args = { keys: '', target: 'ZH-HANS', translate: 'all', fallback: 'google', answers: '10', budget: '5', debug: 'false' };
  String(raw || '').split('&').forEach(function (part) {
    var i = part.indexOf('=');
    if (i <= 0) return;
    var value = part.slice(i + 1);
    try { value = decodeURIComponent(value); } catch (e) {}
    args[part.slice(0, i).trim()] = value.replace(/^"|"$/g, '').trim();
  });
  args.keyList = args.keys.split(/[|;,\s]+/).filter(function (k) { return /^[\w-]+(:fx)?$/i.test(k) && k.length > 20; });
  args.target = args.target.toUpperCase();
  args.translate = /^(all|post|title|off)$/.test(args.translate) ? args.translate : 'all';
  args.answers = /^\d+$/.test(args.answers) ? Number(args.answers) : 10;
  args.budget = Math.min(20, Math.max(1, Number(args.budget) || 5));
  args.debug = args.debug === 'true';
  return args;
}

var ARGS = parseArgs(typeof $argument === 'undefined' ? '' : $argument);
var DEADLINE = Date.now() + ARGS.budget * 1000;

function log() {
  if (ARGS.debug) console.log('[StackOverflow] ' + Array.prototype.join.call(arguments, ' '));
}

function remaining() { return (DEADLINE - Date.now()) / 1000; }
function now() { return Math.floor(Date.now() / 1000); }
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// ---------- 段落 ----------
// 发给 DeepL 的一段是简单 HTML：转义过的文字、<code>、<br>，DeepL 用 tag_handling=html 翻，
// <code> 里的原样保留

// 比较段落用：只留字母和数字。HTML 和 markdown 里同一段的写法不一样，去掉格式后才对得上
function norm(text) { return String(text).replace(/<code>[\s\S]*?<\/code>/g, ' ').replace(/&[#\w]+;/g, ' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }

function squash(text) {
  return text.replace(/\s+/g, ' ').replace(/\s*<br>\s*/g, '<br>').replace(/^(\s|<br>)+|(\s|<br>)+$/g, '');
}

// 译文只留文字、<code>、<br>，别的标签都去掉
function cleanTranslation(html) {
  return html.replace(/<(?!\/?code>|br\s*\/?>)[^>]*>/gi, '').replace(/<br\s*\/?>/gi, '<br>');
}

var BLOCKS = /^(p|h[1-6]|li|dt|dd)$/;                                           // 自己有文字、单独翻的段
var CONTAINERS = /^(ul|ol|dl|pre|blockquote|div|table|hr|details|summary|figure)$/;  // 段里出现这些，段的文字到这里为止
var VOID = /^(br|hr|img|input|wbr)$/;

// HTML 正文拆成段：返回 [{ text, at: 译文插在哪 }]。pre、table 里的不翻；li 里有 p 的按 p 翻
function htmlParagraphs(html) {
  var found = [];
  var stack = [];   // 打开的标签：{ name, unit }
  var token = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|[^<]+|</g;
  var m;
  function current() {
    for (var i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name === 'pre' || stack[i].name === 'table') return null;
      if (stack[i].unit) return stack[i].unit.open ? stack[i].unit : null;
    }
    return null;
  }
  function skipping() { return stack.some(function (s) { return s.name === 'pre' || s.name === 'table' || s.name === 'code' && s.inUnit === false; }); }
  while ((m = token.exec(html))) {
    var whole = m[0];
    var name = (m[2] || '').toLowerCase();
    if (!m[2]) {   // 文字或注释
      if (whole.indexOf('<!--') === 0) continue;
      var u = current();
      if (u && !skipping()) u.text += whole;
      continue;
    }
    if (m[1]) {   // 结束标签
      for (var i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name !== name) continue;
        var closed = stack[i];
        stack.length = i;
        if (closed.unit) {
          if (closed.unit.open) closed.unit.at = name === 'li' ? m.index : m.index + whole.length;
          closed.unit.open = false;
        } else if (name === 'code') {
          var cu = current();
          if (cu && closed.inUnit) cu.text += '</code>';
        }
        break;
      }
      continue;
    }
    if (VOID.test(name)) {
      var vu = current();
      if (vu && name === 'br') vu.text += '<br>';
      if (vu && name === 'hr') vu.open = false, vu.at = m.index;
      continue;
    }
    var unitAbove = current();
    if (CONTAINERS.test(name) || BLOCKS.test(name)) {
      // 段里套了别的块：li 的文字到这里为止，译文插在嵌套的块前面
      if (unitAbove && unitAbove.tag === 'li') { unitAbove.open = false; unitAbove.at = m.index; if (name === 'p') unitAbove.hasP = true; }
    }
    if (BLOCKS.test(name) && !stack.some(function (s) { return s.name === 'pre' || s.name === 'table'; })) {
      var unit = { tag: name, text: '', open: true, at: -1 };
      found.push(unit);
      stack.push({ name: name, unit: unit });
      continue;
    }
    if (name === 'code' || name === 'kbd') {
      var inUnit = !!unitAbove && !skipping();
      if (inUnit) unitAbove.text += '<code>';
      stack.push({ name: name, inUnit: inUnit });
      continue;
    }
    stack.push({ name: name });
  }
  return found.filter(function (u) { return u.at >= 0 && !u.hasP; }).map(function (u) {
    return { text: squash(u.text.replace(/<code><\/code>/g, '')), at: u.at, li: u.tag === 'li' };
  }).filter(function (u) { return u.text; });
}

// 插好译文的 HTML。lookup(原文) 返回译文
function interleaveHtml(html, paragraphs, lookup) {
  var count = 0;
  var out = html;
  paragraphs.slice().sort(function (a, b) { return b.at - a.at; }).forEach(function (p) {
    var t = lookup(p.text);
    if (!t) return;
    count++;
    var piece = p.li ? '<br>' + cleanTranslation(t) : '<p>' + cleanTranslation(t) + '</p>';
    out = out.slice(0, p.at) + piece + out.slice(p.at);
  });
  return { html: out, count: count };
}

// markdown 的一行行内文字转成发给 DeepL 的写法：`代码` 变 <code>，链接只留文字，去掉强调符号。
// body_markdown 本来就是 HTML 转义过的，文字原样用
function markdownInline(md) {
  var codes = [];
  var text = md.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, function (m, ticks, code) { codes.push(code.trim()); return '\u0000' + (codes.length - 1) + '\u0000'; })
    .replace(/!\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]\[[^\]]*\]/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/&lt;(https?:[^&]*)&gt;/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[\s(])[*_](?=\S)([^*_]*?\S)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/ {2,}\n/g, '<br>');
  text = text.replace(/\u0000(\d+)\u0000/g, function (m, i) { return '<code>' + codes[i] + '</code>'; });
  return squash(text);
}

// 译文转回 markdown：<code> 变回 `代码`，<br> 变成行尾两个空格的换行
function toMarkdown(t) {
  return cleanTranslation(t).replace(/<code>([\s\S]*?)<\/code>/g, function (m, c) { return /`/.test(c) ? '`` ' + c + ' ``' : '`' + c + '`'; })
    .replace(/<br>/g, '  \n');
}

var LIST_ITEM = /^(\s{0,3})([-*+]|\d+[.)])\s+/;

// markdown 拆成块：围栏代码块整块跳过，其余按空行分。返回 [{ lines, code }]
function markdownBlocks(lines) {
  var blocks = [];
  var block = null;
  var fence = null;
  lines.forEach(function (line) {
    if (fence) {
      block.lines.push(line);
      if (new RegExp('^\\s*' + fence + '\\s*$').test(line)) { fence = null; block = null; }
      return;
    }
    var f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      fence = f[1][0] === '`' ? '`{' + f[1].length + ',}' : '~{' + f[1].length + ',}';
      block = { lines: [line], code: true };
      blocks.push(block);
      return;
    }
    if (!line.trim()) { block = null; blocks.push({ lines: [line], blank: true }); return; }
    if (!block || block.code) { block = { lines: [] }; blocks.push(block); }
    block.lines.push(line);
  });
  return blocks;
}

// 一块里要翻的单位：列表块按项，其他整块一段。返回 [{ text, after: 插在第几行后面, indent }]
function markdownUnits(block) {
  var lines = block.lines;
  if (block.code || block.blank) return [];
  if (lines.every(function (l) { return /^( {4}|\t)/.test(l); })) return [];                 // 缩进代码块
  if (lines.every(function (l) { return /^\s*(\[[^\]]+\]:\s*\S+|<!--.*-->|&lt;!--.*--&gt;|([-*_]\s*){3,}|\|.*)\s*$/.test(l); })) return [];
  var units = [];
  var unit = null;
  lines.forEach(function (line, i) {
    var item = LIST_ITEM.exec(line);
    if (item || !unit) {
      unit = { parts: [], after: i, indent: item ? item[0].replace(/[^\t]/g, ' ') : '', list: !!item };
      units.push(unit);
    }
    unit.parts.push(line.replace(LIST_ITEM, '').replace(/^\s*(#{1,6}\s+|>\s?)+/, '').replace(/\s+#+\s*$/, ''));
    unit.after = i;
  });
  return units.map(function (u) {
    return { text: markdownInline(u.parts.join('\n').replace(/\s+$/, '')), after: u.after, list: u.list, indent: u.indent };
  }).filter(function (u) { return u.text; });
}

function markdownParagraphs(md) {
  var units = [];
  markdownBlocks(md.split(/\r?\n/)).forEach(function (b) { units.push.apply(units, markdownUnits(b)); });
  return units;
}

// 每段原文后面紧跟它的译文：普通段落插一个新段落，列表项在项里换行接上，引用里的接在引用里
function interleaveMarkdown(md, lookup) {
  var eol = /\r\n/.test(md) ? '\r\n' : '\n';
  var count = 0;
  var out = [];
  markdownBlocks(md.split(/\r?\n/)).forEach(function (block) {
    var units = markdownUnits(block);
    var quote = /^\s{0,3}>/.test(block.lines[0] || '') ? '> ' : '';
    block.lines.forEach(function (line, i) {
      out.push(line);
      units.forEach(function (u) {
        if (u.after !== i) return;
        var t = lookup(u.text);
        if (!t) return;
        count++;
        var md2 = toMarkdown(t);
        if (u.list) {
          out[out.length - 1] = line.replace(/\s*$/, '') + '  ';
          out.push(u.indent + md2.replace(/\n/g, '\n' + u.indent));
        } else {
          out.push(quote);
          out.push(quote + md2.replace(/\n/g, '\n' + quote));
        }
      });
    });
  });
  return { markdown: out.join(eol).replace(/\r?\n/g, eol), count: count };
}

// 评论这种没有段落标签的 body：整段一段，译文用 <br> 接在后面
function inlineHtml(html) { return /<(p|h[1-6]|ul|ol|pre|blockquote|table|div)\b/i.test(html) ? null : squash(html.replace(/<(?!\/?code\b)[^>]*>/gi, ' ')); }

// ---------- 找出要翻译的文字 ----------

function isPost(node) {
  return ['question_id', 'answer_id', 'comment_id'].some(function (k) { return k in node; });
}

// 返回 [{ texts: 要翻的段落, apply(lookup) → 用上了几段 }]。
// 回答按 App 给的顺序数，超过 ARGS.answers 个的回答和它下面的评论不翻，标题照翻
function collectJobs(value) {
  var jobs = [];
  var answers = 0;
  (function walk(v, skipped) {
    if (Array.isArray(v)) { v.forEach(function (x) { walk(x, skipped); }); return; }
    if (!isObject(v)) return;
    if (isPost(v)) {
      var comment = 'comment_id' in v;
      if (!comment && 'answer_id' in v && ARGS.answers && ++answers > ARGS.answers) skipped = true;
      if (typeof v.title === 'string' && v.title.trim() && !comment) jobs.push(titleJob(v));
      var wantBody = !skipped && (ARGS.translate === 'all' || (ARGS.translate === 'post' && !comment));
      if (wantBody && typeof v.body === 'string' && v.body) jobs.push(htmlJob(v));
      if (wantBody && typeof v.body_markdown === 'string' && v.body_markdown) jobs.push(markdownJob(v, comment));
    }
    Object.keys(v).forEach(function (k) { if (k !== 'owner' && k !== 'reply_to_user') walk(v[k], skipped); });
  })(value, false);
  if (answers > ARGS.answers && ARGS.answers) log('回答有 ' + answers + ' 个，只翻前 ' + ARGS.answers + ' 个');
  return jobs.filter(Boolean);
}

function titleJob(node) {
  var title = node.title.trim();
  return { texts: [title], apply: function (lookup) {
    var t = lookup(title);
    if (!t) return 0;
    node.title = node.title + '\n' + cleanTranslation(t).replace(/<\/?code>/g, '').replace(/<br>/g, ' ');
    return 1;
  } };
}

function htmlJob(node) {
  var inline = inlineHtml(node.body);
  if (inline !== null) {
    if (!inline) return null;
    return { texts: [inline], apply: function (lookup) {
      var t = lookup(inline);
      if (!t) return 0;
      node.body = node.body + '<br>' + cleanTranslation(t);
      return 1;
    } };
  }
  var paragraphs = htmlParagraphs(node.body);
  if (!paragraphs.length) return null;
  return { texts: paragraphs.map(function (p) { return p.text; }), apply: function (lookup) {
    var r = interleaveHtml(node.body, paragraphs, lookup);
    node.body = r.html;
    return r.count;
  } };
}

function markdownJob(node, comment) {
  if (comment) {
    var text = markdownInline(node.body_markdown);
    if (!text) return null;
    return { texts: [text], apply: function (lookup) {
      var t = lookup(text);
      if (!t) return 0;
      node.body_markdown = node.body_markdown + '\n\n' + toMarkdown(t);
      return 1;
    } };
  }
  var units = markdownParagraphs(node.body_markdown);
  if (!units.length) return null;
  return { texts: units.map(function (u) { return u.text; }), apply: function (lookup) {
    var r = interleaveMarkdown(node.body_markdown, lookup);
    node.body_markdown = r.markdown;
    return r.count;
  } };
}

// 没有文字（纯代码、链接）、本来就是目标语言的不翻。目标是中文时，汉字过半又没有假名、谚文就算中文
function needsTranslation(html) {
  var text = html.replace(/<code>[\s\S]*?<\/code>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[#\w]+;/g, ' ');
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

// ---------- DeepL（照搬 reddit.js，多了 tag_handling：行内代码不翻） ----------

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
    body: JSON.stringify({ text: texts, target_lang: ARGS.target, tag_handling: 'html', ignore_tags: ['code'] }),
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

function plainText(html) {
  return html.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Google 只认纯文字：去掉标签后多段用换行拼成一个请求，按换行拆回来；行数对不上的那一组再一段一段翻
async function google(texts, result) {
  var chunks = [];
  var chunk = [];
  var length = 0;
  function line(t) { return plainText(t).replace(/\s*\n\s*/g, ' '); }
  texts.forEach(function (t) {
    var l = line(t);
    if (chunk.length && length + l.length > GOOGLE_CHARS) { chunks.push(chunk); chunk = []; length = 0; }
    chunk.push(t);
    length += l.length + 1;
  });
  if (chunk.length) chunks.push(chunk);
  var single = [];
  await parallel(chunks, 4, async function (group) {
    var out = await googleOnce(group.map(line).join('\n'));
    var parts = out ? out.split('\n') : [];
    if (parts.length !== group.length) { single.push.apply(single, group); return; }
    group.forEach(function (t, i) { if (parts[i].trim()) result[t] = escapeHtml(parts[i].trim()); });
  });
  await parallel(single, 4, async function (t) {
    var out = await googleOnce(line(t));
    if (out && out.trim()) result[t] = escapeHtml(out.trim());
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

// ---------- 主流程 ----------

async function main() {
  var body = $response.body;
  if (ARGS.translate === 'off' || !body || typeof body !== 'string' || !/^\s*\{/.test(body)) return null;
  var json = JSON.parse(body);
  if (!Array.isArray(json.items)) return null;
  if (ARGS.debug) log($request.url.replace(/\?.*/, ''), json.items.length + ' 条');

  var canTranslate = ARGS.keyList.length || ARGS.fallback === 'google';
  var jobs = canTranslate ? collectJobs(json.items) : [];
  var texts = [];
  var seen = {};
  jobs.forEach(function (j) {
    j.texts.forEach(function (t) {
      var k = norm(t);
      if (!k || seen[k] || t.length > MAX_CHARS || !needsTranslation(t)) return;
      seen[k] = true;
      texts.push(t);
    });
  });
  if (!texts.length) return null;
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
  // 同一段在 body 和 body_markdown 里写法不一样，按去掉格式后的文字对上
  var byNorm = {};
  texts.forEach(function (t) { if (map[t]) byNorm[norm(t)] = map[t]; });
  var lookup = function (text) { var k = norm(text); return k ? byNorm[k] : undefined; };
  var translated = 0;
  jobs.forEach(function (j) { translated += j.apply(lookup); });
  var left = texts.filter(function (t) { return !map[t]; }).length;
  log('要翻 ' + texts.length + ' 段，缓存命中 ' + (texts.length - missing.length) + ' 段，用上 ' + translated + ' 处'
    + (left ? '，' + left + ' 段没翻完（超时或出错），重新打开会接着翻' : ''));
  return translated ? JSON.stringify(json) : null;
}

var finished = false;
var timer = 0;
function finish(out) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  $done(out ? { body: out } : {});
}

// 兜底：卡住了就原样返回，不影响 App 加载
timer = setTimeout(function () { log('超时，返回原文'); finish(null); }, (ARGS.budget + 2) * 1000);

main().then(finish, function (error) {
  log('出错：' + (error && error.message));
  finish(null);
});
