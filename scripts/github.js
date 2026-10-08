/*
 * GitHub 翻译：处理 GitHub 官方 App 用的 api.github.com（GraphQL 和 REST）的响应，
 * Issue、PR、讨论的标题、正文、评论，Release 说明，仓库简介和 README 加上 DeepL 译文。
 *
 * 只改用来显示的 HTML：GraphQL 里的 bodyHTML、descriptionHTML 这类以 HTML 结尾的字段，REST 里的
 * body_html。正文按段插，一段（p、h1-h6、li）原文后面紧跟它的译文，代码块、表格不翻，行内代码原样保留。
 * markdown 原文（body）默认不动：App 编辑评论时用的是它，改了的话编辑框里会带着译文，一保存就发出去了。
 * 标题：自己能编辑的（viewerCanUpdate 为 true）不翻，同样是怕改标题时把译文存进去。
 * README：/repos/…/readme 返回 HTML 时按段插；返回 base64 的 markdown 时解开按段插再编回去。
 *
 * DeepL 部分照搬 stackoverflow.js：多个 key 按顺序用，出错按类型暂停，全部不行用 Google 兜底。
 * key 的暂停状态和 YouTube 字幕、Reddit、Stack Overflow 存在同一个地方。
 *
 * 参数（模块里的 argument，用 & 分隔）：
 *   keys      DeepL key，多个用 | 分隔
 *   target    目标语言，DeepL 的写法，比如 ZH-HANS、ZH-HANT、EN-US、JA
 *   translate all：标题、正文、评论、README；title：只翻标题和简介；off：不翻
 *   markdown  true：markdown 原文（body）也插译文。App 只显示原文、不显示译文时再打开，打开后别在 App 里编辑评论
 *   fallback  google：全部 key 失败时用 Google 翻译；off：不兜底
 *   budget    最多等几秒翻译（默认 5），到时间没翻完的显示原文
 *   debug     true：在 Surge 日志里打印每个响应的地址、字段和翻了几段
 */

var STATE_KEY = 'yt-subtitles-deepl';   // 和 YouTube 字幕、Reddit、Stack Overflow 共用 key 的暂停状态
var CACHE_KEY = 'github-translations';
var CACHE_SIZE = 800;                   // 缓存最近多少段译文
var TEXTS_PER_REQUEST = 50;             // DeepL 一次最多 50 段
var BYTES_PER_REQUEST = 100000;         // DeepL 单次请求上限 128 KiB，留点余量
var MAX_CHARS = 5000;                   // 再长的一段不翻
var MAX_TEXTS = 400;                    // 一个响应最多翻多少段，长 README、几百条评论的 Issue 不一次翻完
var GOOGLE_CHARS = 1500;                // Google 兜底一个请求最多拼多少字（放在网址里，不能太长）
var PARALLEL = 6;                       // 同时发几个请求：评论多的 Issue 拆成几份一起翻，不排队
var MIN_BYTES_PER_REQUEST = 2000;       // 内容少时不拆得太碎
var PAUSE = { 403: 7 * 86400, 456: 86400, 429: 60, 5: 300 };

function parseArgs(raw) {
  var args = { keys: '', target: 'ZH-HANS', translate: 'all', markdown: 'false', fallback: 'google', budget: '5', debug: 'false' };
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
  args.markdown = args.markdown === 'true';
  args.budget = Math.min(20, Math.max(1, Number(args.budget) || 5));
  args.debug = args.debug === 'true';
  return args;
}

var ARGS = parseArgs(typeof $argument === 'undefined' ? '' : $argument);
var DEADLINE = Date.now() + ARGS.budget * 1000;

function log() {
  if (ARGS.debug) console.log('[GitHub] ' + Array.prototype.join.call(arguments, ' '));
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

// ---------- markdown（GitHub 的 markdown 是原文，没有转义过） ----------

// 一段 markdown 转成发给 DeepL 的写法：`代码` 变 <code>，链接只留文字，去掉强调符号和 HTML 标签，文字转义
function markdownInline(md) {
  var codes = [];
  var text = md.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, function (m, ticks, code) { codes.push(code.trim()); return '\u0000' + (codes.length - 1) + '\u0000'; })
    .replace(/!\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]\[[^\]]*\]/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/^\s*\[[ xX]\]\s+/, '')
    .replace(/<(https?:[^>]*)>/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[\s(])[*_](?=\S)([^*_]*?\S)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/ {2,}\n/g, '\u0001');
  text = escapeHtml(text).replace(/\u0001/g, '<br>');
  text = text.replace(/\u0000(\d+)\u0000/g, function (m, i) { return '<code>' + escapeHtml(codes[i]) + '</code>'; });
  return squash(text);
}

// 译文转回 markdown：<code> 变回 `代码`，<br> 变成行尾两个空格的换行，实体转回文字
function toMarkdown(t) {
  return cleanTranslation(t).replace(/<code>([\s\S]*?)<\/code>/g, function (m, c) { c = plainText(c); return /`/.test(c) ? '`` ' + c + ' ``' : '`' + c + '`'; })
    .split('<br>').map(plainText).join('  \n');
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
      if (new RegExp(fence === '.*-->' ? '-->' : '^\\s*' + fence + '\\s*$').test(line)) { fence = null; block = null; }
      return;
    }
    if (/^\s{0,3}<!--/.test(line) && !/-->/.test(line)) {
      fence = '.*-->';
      block = { lines: [line], code: true };
      blocks.push(block);
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
  if (lines.every(function (l) { return /^\s*(\[[^\]]+\]:\s*\S+|<!--.*-->|([-*_]\s*){3,}|\|.*|(<\/?[a-zA-Z][^>]*>\s*)+)\s*$/.test(l); })) return [];
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

function inlineHtml(html) { return /<(p|h[1-6]|ul|ol|pre|blockquote|table|div)\b/i.test(html) ? null : squash(html.replace(/<(?!\/?code\b)[^>]*>/gi, ' ')); }

// ---------- 找出要翻译的文字 ----------

// 显示用的 HTML 字段：GraphQL 的 bodyHTML、descriptionHTML 等，REST 的 body_html
function isHtmlKey(key) { return /HTML$|_html$/.test(key); }

// 有标题的东西：Issue、PR、讨论、Release（GraphQL 看 __typename，REST 看网址）
function hasTitle(node) {
  if (/^(Issue|PullRequest|Discussion|Release)$/.test(node.__typename || '')) return true;
  return typeof node.html_url === 'string' && /\/(issues|pull|discussions|releases\/tag)\//.test(node.html_url);
}

function isRepository(node) { return node.__typename === 'Repository' || typeof node.full_name === 'string' && 'stargazers_count' in node; }

// 返回 [{ texts: 要翻的段落, apply(lookup) → 用上了几段 }]
function collectJobs(value, stats) {
  var jobs = [];
  (function walk(v) {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!isObject(v)) return;
    if (typeof v.title === 'string' && v.title.trim() && hasTitle(v) && v.viewerCanUpdate !== true) jobs.push(lineJob(v, 'title'));
    if (isRepository(v) && typeof v.description === 'string' && v.description.trim()) jobs.push(lineJob(v, 'description'));
    if (ARGS.translate === 'all') {
      Object.keys(v).forEach(function (k) {
        if (typeof v[k] !== 'string' || !v[k] || !isHtmlKey(k)) return;
        if (isRepository(v) && /^(short)?descriptionHTML$/i.test(k)) return;   // 仓库简介上面翻过了
        stats[k] = (stats[k] || 0) + 1;
        jobs.push(htmlJob(v, k));
      });
      if (ARGS.markdown && typeof v.body === 'string' && v.body && v.viewerCanUpdate !== true) jobs.push(markdownJob(v, 'body'));
    }
    Object.keys(v).forEach(function (k) { if (k !== 'author' && k !== 'user' && k !== 'owner') walk(v[k]); });
  })(value);
  return jobs.filter(Boolean);
}

function lineJob(node, key) {
  var text = squash(escapeHtml(node[key]));
  return { texts: [text], apply: function (lookup) {
    var t = lookup(text);
    if (!t) return 0;
    node[key] = node[key] + '\n' + plainText(cleanTranslation(t).replace(/<br>/g, ' '));
    return 1;
  } };
}

function htmlJob(node, key) {
  var inline = inlineHtml(node[key]);
  if (inline !== null) {
    if (!inline) return null;
    return { texts: [inline], apply: function (lookup) {
      var t = lookup(inline);
      if (!t) return 0;
      node[key] = node[key] + '<br>' + cleanTranslation(t);
      return 1;
    } };
  }
  var paragraphs = htmlParagraphs(node[key]);
  if (!paragraphs.length) return null;
  return { texts: paragraphs.map(function (p) { return p.text; }), apply: function (lookup) {
    var r = interleaveHtml(node[key], paragraphs, lookup);
    node[key] = r.html;
    return r.count;
  } };
}

function markdownJob(node, key) {
  var units = markdownParagraphs(node[key]);
  if (!units.length) return null;
  return { texts: units.map(function (u) { return u.text; }), apply: function (lookup) {
    var r = interleaveMarkdown(node[key], lookup);
    node[key] = r.markdown;
    return r.count;
  } };
}

// 整个是 HTML 的响应（README 用 html 格式拿的时候）
function documentJob(holder) {
  var paragraphs = htmlParagraphs(holder.html);
  if (!paragraphs.length) return [];
  return [{ texts: paragraphs.map(function (p) { return p.text; }), apply: function (lookup) {
    var r = interleaveHtml(holder.html, paragraphs, lookup);
    holder.html = r.html;
    return r.count;
  } }];
}

// ---------- base64（README 的 content），先转 UTF-8 ----------

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function fromBase64(text) {
  var clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  var bytes = [];
  for (var i = 0; i < clean.length; i += 4) {
    var n = B64.indexOf(clean[i]) << 18 | B64.indexOf(clean[i + 1]) << 12 | (B64.indexOf(clean[i + 2]) & 63) << 6 | B64.indexOf(clean[i + 3]) & 63;
    bytes.push(n >> 16 & 255);
    if (i + 2 < clean.length) bytes.push(n >> 8 & 255);
    if (i + 3 < clean.length) bytes.push(n & 255);
  }
  var out = '';
  for (var j = 0; j < bytes.length; j++) {
    var b = bytes[j];
    var c = b < 0x80 ? b
      : b < 0xe0 ? (b & 31) << 6 | bytes[++j] & 63
      : b < 0xf0 ? (b & 15) << 12 | (bytes[++j] & 63) << 6 | bytes[++j] & 63
      : (b & 7) << 18 | (bytes[++j] & 63) << 12 | (bytes[++j] & 63) << 6 | bytes[++j] & 63;
    out += String.fromCodePoint(c);
  }
  return out;
}

function toBase64(text) {
  var bytes = [];
  for (var i = 0; i < text.length; i++) {
    var c = text.codePointAt(i);
    if (c > 0xffff) i++;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | c >> 6, 0x80 | c & 63);
    else if (c < 0x10000) bytes.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    else bytes.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
  }
  var out = '';
  for (var j = 0; j < bytes.length; j += 3) {
    var n = bytes[j] << 16 | (bytes[j + 1] || 0) << 8 | (bytes[j + 2] || 0);
    out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + (j + 1 < bytes.length ? B64[n >> 6 & 63] : '=') + (j + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}

// README 的 JSON：{ name: 'README.md', encoding: 'base64', content: '…' }。只处理 markdown 文件
function readmeJob(node) {
  if (node.encoding !== 'base64' || typeof node.content !== 'string' || !/\.(md|markdown|mdown)$/i.test(node.name || node.path || '')) return [];
  var holder = { markdown: fromBase64(node.content) };
  var units = markdownParagraphs(holder.markdown);
  if (!units.length) return [];
  return [{ texts: units.map(function (u) { return u.text; }), apply: function (lookup) {
    var r = interleaveMarkdown(holder.markdown, lookup);
    if (r.count) node.content = toBase64(r.markdown);
    return r.count;
  } }];
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

function needsTranslation(html) {
  var text = html.replace(/<code>[\s\S]*?<\/code>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[#\w]+;/g, ' ');
  var letters = text.replace(/https?:\/\/\S+/g, '').match(/\p{L}/gu);
  if (!letters || letters.length < 2) return false;
  if (/^ZH/.test(ARGS.target)) {
    var han = (text.match(/\p{Script=Han}/gu) || []).length;
    // 一个英文单词大致顶一个汉字：「AdGuard Home 面板」这种夹着英文名字的中文不翻
    var words = (text.match(/[A-Za-z\u00c0-\u024f]+(?:['’-][A-Za-z]+)*/g) || []).length;
    if (han && han >= words && !/[぀-ヿ가-힯]/.test(text)) return false;
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

// ---------- DeepL（照搬 stackoverflow.js） ----------

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

function header(name) {
  var headers = $response.headers || {};
  for (var key in headers) if (key.toLowerCase() === name) return String(headers[key]);
  return '';
}

async function main() {
  var body = $response.body;
  if (ARGS.translate === 'off' || !body || typeof body !== 'string') return null;
  var url = $request.url.replace(/\?.*/, '');
  var jobs = [];
  var json = null;
  var doc = null;
  var stats = {};
  if (/^\s*[{[]/.test(body)) {
    json = JSON.parse(body);
    if (ARGS.translate === 'all' && /\/readme(\/[^/]*)?$/.test(url) && isObject(json)) jobs = readmeJob(json);
    else jobs = collectJobs(json, stats);
    if (ARGS.debug) {
      var root = isObject(json) && isObject(json.data) ? 'data.' + Object.keys(json.data).join(',') : Array.isArray(json) ? 'array×' + json.length : Object.keys(json).slice(0, 6).join(',');
      log(url, root, typenames(json).slice(0, 200), Object.keys(stats).map(function (k) { return k + '×' + stats[k]; }).join(' '));
    }
  } else if (ARGS.translate === 'all' && /html/i.test(header('content-type')) && /\/readme(\/[^/]*)?$/.test(url)) {
    doc = { html: body };
    jobs = documentJob(doc);
    log(url, 'README HTML');
  }
  if (!jobs.length) return null;

  var canTranslate = ARGS.keyList.length || ARGS.fallback === 'google';
  if (!canTranslate) return null;
  var texts = [];
  var seen = {};
  jobs.forEach(function (j) {
    j.texts.forEach(function (t) {
      var k = norm(t);
      if (!k || seen[k] || texts.length >= MAX_TEXTS || t.length > MAX_CHARS || !needsTranslation(t)) return;
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
  // 同一段在 HTML 和 markdown 里写法不一样，按去掉格式后的文字对上
  var byNorm = {};
  texts.forEach(function (t) { if (map[t] && norm(map[t]) !== norm(t)) byNorm[norm(t)] = map[t]; });   // 译出来和原文一样的（人名、产品名）不插
  var lookup = function (text) { var k = norm(text); return k ? byNorm[k] : undefined; };
  var translated = 0;
  jobs.forEach(function (j) { translated += j.apply(lookup); });
  var left = texts.filter(function (t) { return !map[t]; }).length;
  log('要翻 ' + texts.length + ' 段，缓存命中 ' + (texts.length - missing.length) + ' 段，用上 ' + translated + ' 处'
    + (left ? '，' + left + ' 段没翻完（超时或出错），重新打开会接着翻' : ''));
  if (!translated) return null;
  return doc ? doc.html : JSON.stringify(json);
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
