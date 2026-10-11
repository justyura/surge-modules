/*
 * Stack Overflow 网页翻译：在 Safari 里看 Stack Overflow（和 Super User、Server Fault、Ask Ubuntu、
 * 各个 *.stackexchange.com 站）时，标题、问题、回答、评论按段加上 DeepL 译文。
 *
 * 一个文件，两种用法：
 *   - http-response：往问题页、列表页的 HTML 里插一段网页脚本（pageMain）和样式
 *   - http-request：拦下网页脚本发给同站 /__surge-translate 的请求，在 Surge 里调 DeepL，
 *     直接把译文返回给网页，请求不会发到 Stack Overflow
 * DeepL key 只在 Surge 里用，不会进网页。
 *
 * 网页脚本只翻快滚到屏幕里的段落，长帖子不会一打开就把整页的额度用掉；后加载的评论、
 * 被网页重新渲染掉的段落也会补上。代码块不翻，行内代码原样保留。
 *
 * DeepL 部分照搬 reddit.js：多个 key 按顺序用，出错按类型暂停，全部不行用 Google 兜底。
 * key 的暂停状态和 YouTube 字幕、Reddit、Stack Overflow App 翻译存在同一个地方。
 *
 * 参数（模块里的 argument，用 & 分隔）：
 *   keys      DeepL key，多个用 | 分隔
 *   target    目标语言，DeepL 的写法，比如 ZH-HANS、ZH-HANT、EN-US、JA
 *   translate all：标题、正文、评论；post：不翻评论；title：只翻标题；off：不翻
 *   fallback  google：全部 key 失败时用 Google 翻译；off：不兜底
 *   debug     true：在 Surge 日志里打印细节
 */

var STATE_KEY = 'yt-subtitles-deepl';   // 和 YouTube 字幕、Reddit 共用 key 的暂停状态
var CACHE_KEY = 'stackoverflow-web-translations';
var CACHE_SIZE = 800;                   // 缓存最近多少段译文
var ENDPOINT = '/__surge-translate';
var TEXTS_PER_REQUEST = 50;             // DeepL 一次最多 50 段
var BYTES_PER_REQUEST = 100000;         // DeepL 单次请求上限 128 KiB，留点余量
var MAX_CHARS = 8000;                   // 再长的一段不翻
var MAX_TEXTS = 60;                     // 网页一次最多送来多少段
var GOOGLE_CHARS = 1500;                // Google 兜底一个请求最多拼多少字（放在网址里，不能太长）
var PARALLEL = 3;
var BUDGET = 20;                        // 一次请求最多等几秒，模块里 timeout 是 30
var PAUSE = { 403: 7 * 86400, 456: 86400, 429: 60, 5: 300 };
var LLM_PARALLEL = 8;                   // 大模型同时发几个请求
var LLM_CHARS = 800;                    // 大模型一组最多多少字，组小一点每组回得快
var LLM_ITEMS = 40;                     // 大模型一组最多多少段
var LLM_MIN_SECONDS = 3;                // 离截止不到这么多秒（限时很短时按一半）就不再开始新的一组
var FALLBACK_SECONDS = 2;               // 离截止还剩这么多秒时，大模型没翻好的交给 DeepL / Google

function parseArgs(raw) {
  var args = { keys: '', target: 'ZH-HANS', translate: 'all', fallback: 'google', debug: 'false', llmkeys: '', model: '', api: '', effort: '' };
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
  args.debug = args.debug === 'true';
  return parseLlmArgs(args);
}

var ARGS = parseArgs(typeof $argument === 'undefined' ? '' : $argument);
var DEADLINE = Date.now() + BUDGET * 1000;

function log() {
  if (ARGS.debug) console.log('[StackOverflow 网页] ' + Array.prototype.join.call(arguments, ' '));
}

function remaining() { return (DEADLINE - Date.now()) / 1000; }
function now() { return Math.floor(Date.now() / 1000); }

// ---------- 网页里跑的代码 ----------
// 下面这个函数会被 toString() 原样插进网页，不能用外面的变量，也不能出现 script 的结束标签

function pageMain(cfg) {
  if (window.__sxTranslate) return;
  window.__sxTranslate = true;

  var BATCH_TEXTS = 30;
  var BATCH_CHARS = 12000;
  var MAX_INFLIGHT = 3;
  // 一段里这些不算正文：代码块、嵌套的列表和段落（它们自己单独翻）、按钮图标
  var SKIP = /^(PRE|UL|OL|P|BLOCKQUOTE|TABLE|IMG|SVG|BUTTON|SCRIPT|STYLE|TEXTAREA|FORM)$/;
  var memo = new Map();        // 原文 → 译文，'' 表示不用翻
  var units = new WeakMap();   // 元素 → { el, kind, text }
  var queue = [];
  var inflight = 0;
  var flushTimer = 0;
  var scanTimer = 0;

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // 一段的文字转成只有 <code>、<br> 的简单 HTML，行内代码让 DeepL 原样保留
  function textOf(el) {
    var out = '';
    (function walk(node) {
      for (var n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) { out += esc(n.nodeValue); continue; }
        if (n.nodeType !== 1 || SKIP.test(n.tagName.toUpperCase()) || n.classList.contains('sx-tr')) continue;
        if (n.tagName === 'CODE' || n.tagName === 'KBD') out += '<code>' + esc(n.textContent) + '</code>';
        else if (n.tagName === 'BR') out += '<br>';
        else walk(n);
      }
    })(el);
    return out.replace(/\s+/g, ' ').replace(/\s*<br>\s*/g, '<br>').replace(/^(\s|<br>)+|(\s|<br>)+$/g, '');
  }

  function hasWords(text) {
    var plain = text.replace(/<code>[\s\S]*?<\/code>/g, ' ').replace(/<[^>]+>/g, ' ');
    return /\p{L}[\s\S]*\p{L}/u.test(plain);
  }

  function find() {
    var found = [];
    function add(el, kind) { if (!units.has(el)) found.push({ el: el, kind: kind }); }
    document.querySelectorAll('h1 a.question-hyperlink, .s-post-summary--content-title a').forEach(function (a) { add(a, 'title'); });
    if (cfg.scope !== 'title') {
      document.querySelectorAll('.js-post-body').forEach(function (body) {
        body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, dt, dd').forEach(function (el) {
          if (el.parentElement.closest('pre, table, .snippet, .sx-tr')) return;
          if (el.tagName === 'LI' && Array.prototype.some.call(el.children, function (c) { return c.tagName === 'P'; })) return;
          add(el, 'block');
        });
      });
    }
    if (cfg.scope === 'all') {
      document.querySelectorAll('[itemprop="comment"] [itemprop="text"], .comment-copy').forEach(function (el) {
        if (!el.classList.contains('js-post-body')) add(el, 'comment');
      });
    }
    return found;
  }

  // 只留文字、<code>、<br>，别的标签都去掉，不会把任何 HTML 原样放进网页
  function build(box, html) {
    var doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    (function copy(from, to) {
      for (var n = from.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) to.appendChild(document.createTextNode(n.nodeValue));
        else if (n.nodeType !== 1) continue;
        else if (n.tagName === 'CODE') to.appendChild(document.createElement('code')).textContent = n.textContent;
        else if (n.tagName === 'BR') to.appendChild(document.createElement('br'));
        else copy(n, to);
      }
    })(doc.body.firstChild || doc.body, box);
  }

  function render(unit) {
    var tr = memo.get(unit.text);
    var el = unit.el;
    if (!tr || !el.isConnected) return;
    var box = document.createElement('div');
    box.className = 'sx-tr sx-' + unit.kind;
    build(box, tr);
    if (el.tagName === 'LI') {
      var nested = Array.prototype.find.call(el.children, function (c) { return /^(UL|OL|PRE|BLOCKQUOTE|TABLE|DIV)$/.test(c.tagName) && !c.classList.contains('sx-tr'); });
      var old = Array.prototype.find.call(el.children, function (c) { return c.classList.contains('sx-tr'); });
      if (old) old.remove();
      el.insertBefore(box, nested || null);
      return;
    }
    var next = el.nextElementSibling;
    if (next && next.classList.contains('sx-tr')) next.remove();
    el.insertAdjacentElement('afterend', box);
  }

  function schedule() {
    if (!flushTimer) flushTimer = setTimeout(flush, 120);
  }

  function enqueue(unit) {
    if (memo.has(unit.text)) { render(unit); return; }
    queue.push(unit);
    schedule();
  }

  function flush() {
    flushTimer = 0;
    while (queue.length && inflight < MAX_INFLIGHT) {
      var batch = [];
      var texts = [];
      var chars = 0;
      while (queue.length && texts.length < BATCH_TEXTS && (!texts.length || chars + queue[0].text.length <= BATCH_CHARS)) {
        var unit = queue.shift();
        if (memo.has(unit.text)) { render(unit); continue; }
        batch.push(unit);
        if (texts.indexOf(unit.text) === -1) { texts.push(unit.text); chars += unit.text.length; }
      }
      if (texts.length) send(batch, texts);
    }
  }

  function send(batch, texts) {
    inflight++;
    fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: texts, title: document.title }),
      credentials: 'omit',
    }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (data) {
      var list = data && Array.isArray(data.translations) ? data.translations : [];
      texts.forEach(function (t, i) { if (typeof list[i] === 'string') memo.set(t, list[i]); });
      batch.forEach(render);
    }).catch(function () {}).then(function () {
      inflight--;
      if (queue.length) schedule();
    });
  }

  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      enqueue(units.get(e.target));
    });
  }, { rootMargin: '1200px 0px' }) : null;

  function scan() {
    scanTimer = 0;
    find().forEach(function (unit) {
      unit.text = textOf(unit.el);
      units.set(unit.el, unit);
      if (!unit.text || unit.text.length > 8000 || !hasWords(unit.text)) return;
      if (memo.has(unit.text) || !io) enqueue(unit);
      else io.observe(unit.el);
    });
  }

  // 后加载的评论、网页重新渲染出来的段落：重新找一遍，翻过的直接从 memo 补上
  function ours(node) { return node.nodeType === 1 && node.classList.contains('sx-tr'); }
  new MutationObserver(function (records) {
    var changed = records.some(function (r) {
      return Array.prototype.some.call(r.addedNodes, function (n) { return !ours(n) && (n.nodeType === 1 || n.nodeType === 3); })
        || Array.prototype.some.call(r.removedNodes, ours);
    });
    if (changed && !scanTimer) scanTimer = setTimeout(scan, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // 右下角的「译」：点一下隐藏 / 显示译文，记在本机
  var root = document.documentElement;
  try { if (localStorage.getItem('sx-hide') === '1') root.classList.add('sx-hide'); } catch (e) {}
  function addToggle() {
    if (document.getElementById('sx-toggle')) return;
    var button = document.createElement('button');
    button.id = 'sx-toggle';
    button.type = 'button';
    button.textContent = '\u8bd1';  // 译。网页里的字符串只用 ASCII，网页编码不对也不会乱码
    button.setAttribute('aria-label', '\u663e\u793a\u6216\u9690\u85cf\u8bd1\u6587');  // 显示或隐藏译文
    button.addEventListener('click', function () {
      var hide = root.classList.toggle('sx-hide');
      try { localStorage.setItem('sx-hide', hide ? '1' : '0'); } catch (e) {}
    });
    document.body.appendChild(button);
  }

  function start() { addToggle(); scan(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}

var PAGE_STYLE = [
  '.sx-tr{margin:.3em 0 1em;padding-left:.6em;border-left:3px solid #f48225;color:var(--black-600,#3b4045)}',
  '.sx-tr code{white-space:pre-wrap}',
  'li>.sx-tr{margin:.2em 0 .4em}',
  '.sx-title{border-left:0;padding:0;margin:.25em 0 0;font-size:.82em;font-weight:400;line-height:1.35}',
  '.sx-comment{margin:.25em 0 .35em;font-size:inherit}',
  'html.sx-hide .sx-tr{display:none}',
  '#sx-toggle{position:fixed;right:12px;bottom:76px;z-index:2147483000;width:38px;height:38px;border:0;border-radius:19px;'
    + 'background:#f48225;color:#fff;font:600 16px/38px -apple-system,sans-serif;text-align:center;padding:0;opacity:.85;'
    + 'box-shadow:0 1px 4px rgba(0,0,0,.3);-webkit-tap-highlight-color:transparent}',
  'html.sx-hide #sx-toggle{background:#9199a1}',
  '@media print{.sx-tr,#sx-toggle{display:none}}',
].join('');

// ---------- http-response：往网页里插脚本 ----------

function randomNonce() {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var out = '';
  for (var i = 0; i < 24; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// 网页有 CSP 时内联脚本要带 nonce 才能跑，做法和 scripts/web/inject.js 一样：
// 有 nonce 用它的；允许 'unsafe-inline' 不用 nonce；否则给 script-src 加一个我们自己的 nonce
function patchCsp(csp) {
  var directives = csp.split(';');
  var names = ['script-src-elem', 'script-src', 'default-src'];
  var target = -1;
  for (var n = 0; n < names.length && target === -1; n++) {
    for (var i = 0; i < directives.length; i++) {
      if (directives[i].trim().split(/\s+/)[0].toLowerCase() === names[n]) { target = i; break; }
    }
  }
  if (target === -1) return { csp: csp, nonce: '' };
  var parts = directives[target].trim().split(/\s+/);
  for (var j = 1; j < parts.length; j++) {
    var match = /^'nonce-(.+)'$/.exec(parts[j]);
    if (match) return { csp: csp, nonce: match[1] };
  }
  var lower = parts.map(function (p) { return p.toLowerCase(); });
  var inlineAllowed = lower.indexOf("'unsafe-inline'") !== -1
    && !lower.some(function (p) { return /^'(sha(256|384|512)-|strict-dynamic)/.test(p); });
  if (inlineAllowed) return { csp: csp, nonce: '' };
  var nonce = randomNonce();
  directives[target] = ' ' + parts.join(' ') + " 'nonce-" + nonce + "'";
  return { csp: directives.join(';'), nonce: nonce };
}

function injectPage() {
  var headers = $response.headers || {};
  function header(name) {
    for (var key in headers) if (key.toLowerCase() === name) return { key: key, value: String(headers[key]) };
    return null;
  }
  var type = header('content-type');
  var body = $response.body;
  var status = $response.status || $response.statusCode || 200;
  // 只改完整的网页：Cloudflare 验证页、接口返回的 HTML 片段都不动
  if (ARGS.translate === 'off' || status !== 200 || !type || !/text\/html/i.test(type.value)
    || typeof body !== 'string' || !/<\/body>/i.test(body) || body.indexOf('__sxTranslate') !== -1) {
    return $done({});
  }
  var newHeaders = {};
  for (var key in headers) newHeaders[key] = headers[key];
  var nonce = '';
  var csp = header('content-security-policy');
  if (csp) {
    var patched = patchCsp(csp.value);
    newHeaders[csp.key] = patched.csp;
    nonce = patched.nonce;
  }
  var cfg = JSON.stringify({ endpoint: ENDPOINT, scope: ARGS.translate }).replace(/</g, '\\u003c');
  var tag = '<style>' + PAGE_STYLE + '</style><script' + (nonce ? ' nonce="' + nonce + '"' : '') + '>('
    + pageMain.toString() + ')(' + cfg + ');</script>';
  var at = body.search(/<\/body>(?![\s\S]*<\/body>)/i);
  log('插入翻译脚本', $request.url.replace(/\?.*/, ''));
  $done({ headers: newHeaders, body: body.slice(0, at) + tag + body.slice(at) });
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

function soPrompt() {
  return llmPrompt('Stack Overflow and Stack Exchange questions, answers and comments',
    'Input is JSON: "question" is the title of the page the texts come from (may be empty), '
    + '"texts" holds titles and paragraphs keyed by number, in page order. Keep code, identifiers, commands and error messages '
    + 'as they are and use standard technical terminology. ' + HTML_RULE);
}

// ---------- http-request：网页送来的段落翻好直接返回 ----------

function plainText(html) {
  return html.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// 没有文字（纯代码、链接）、本来就是目标语言的不翻。目标是中文时，汉字过半又没有假名、谚文就算中文
function needsTranslation(html) {
  var text = plainText(html.replace(/<code>[\s\S]*?<\/code>/g, ' '));
  var letters = text.replace(/https?:\/\/\S+/g, '').match(/\p{L}/gu);
  if (!letters || letters.length < 2) return false;
  if (/^ZH/.test(ARGS.target)) {
    var han = (text.match(/\p{Script=Han}/gu) || []).length;
    if (han * 2 >= letters.length && !/[぀-ヿ가-힯]/.test(text)) return false;
  }
  return true;
}

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

function timeout() { return Math.max(1, Math.min(15, Math.floor(remaining()))); }

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
  var batches = [];
  var batch = null;
  texts.forEach(function (t) {
    var size = utf8Length(t) + 16;
    if (!batch || batch.length >= TEXTS_PER_REQUEST || (batch.length && batch.size + size > BYTES_PER_REQUEST)) {
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

function reply(data) {
  $done({ response: {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(data),
  } });
}

async function answer() {
  // 在 Safari 里打开 https://stackoverflow.com/__surge-translate 可以看模块是不是在工作
  if (!/^POST$/i.test($request.method || 'POST') || !$request.body) {
    return { module: 'ok', llm: ARGS.llmKeyList.length ? ARGS.model : '没填', deepl: deeplProblem(loadState()) || 'ok' };
  }
  var texts = [];
  var title = '';
  try {
    var data = JSON.parse($request.body);
    texts = data.texts;
    title = typeof data.title === 'string' ? data.title.replace(/\s+-\s+[^-]+$/, '').slice(0, 300) : '';  // 去掉「 - Stack Overflow」
  } catch (e) {}
  if (!Array.isArray(texts)) texts = [];
  texts = texts.slice(0, MAX_TEXTS).map(function (t) { return typeof t === 'string' ? t : ''; });
  var map = {};
  var wanted = texts.filter(function (t) { return t && t.length <= MAX_CHARS && needsTranslation(t); });
  var unique = wanted.filter(function (t, i) { return wanted.indexOf(t) === i; });
  if (unique.length) map = await translateCached(unique, { system: soPrompt(), context: { question: title } });
  var done = wanted.filter(function (t) { return map[t]; }).length;
  log('收到 ' + texts.length + ' 段，要翻 ' + wanted.length + ' 段，翻好 ' + done + ' 段' + (done < wanted.length ? '，' + (wanted.length - done) + ' 段没翻成' : ''));
  // 不用翻的回空字符串（网页记下来不再问），没翻成的回 null（下次打开再试）
  return { translations: texts.map(function (t) {
    if (map[t]) return map[t];
    return wanted.indexOf(t) === -1 ? '' : null;
  }) };
}

if (typeof $response !== 'undefined') {
  injectPage();
} else {
  var finished = false;
  var finish = function (data) { if (!finished) { finished = true; reply(data); } };
  setTimeout(function () { log('超时'); finish({ translations: [] }); }, (BUDGET + 3) * 1000);
  answer().then(finish, function (error) {
    log('出错：' + (error && error.message));
    finish({ translations: [] });
  });
}
