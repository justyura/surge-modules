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

function parseArgs(raw) {
  var args = { keys: '', target: 'ZH-HANS', translate: 'all', fallback: 'google', debug: 'false' };
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
  return args;
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
      body: JSON.stringify({ texts: texts }),
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
    return { module: 'ok', deepl: deeplProblem(loadState()) || 'ok' };
  }
  var texts = [];
  try { texts = JSON.parse($request.body).texts; } catch (e) {}
  if (!Array.isArray(texts)) texts = [];
  texts = texts.slice(0, MAX_TEXTS).map(function (t) { return typeof t === 'string' ? t : ''; });
  var map = {};
  var wanted = texts.filter(function (t) { return t && t.length <= MAX_CHARS && needsTranslation(t); });
  var cache = loadCache();
  var known = {};
  cache.forEach(function (e) { known[e[0]] = e[1]; });
  var missing = [];
  wanted.forEach(function (t) {
    var hit = known[cacheKey(t)];
    if (hit) map[t] = hit;
    else if (missing.indexOf(t) === -1) missing.push(t);
  });
  if (missing.length && (ARGS.keyList.length || ARGS.fallback === 'google')) {
    var state = loadState();
    var fresh = await translate(missing, state);
    saveState(state);
    Object.keys(fresh).forEach(function (t) {
      map[t] = fresh[t];
      cache.unshift([cacheKey(t), fresh[t]]);
    });
    if (Object.keys(fresh).length) saveCache(cache);
  }
  var done = wanted.filter(function (t) { return map[t]; }).length;
  log('收到 ' + texts.length + ' 段，要翻 ' + wanted.length + ' 段，缓存命中 ' + (wanted.length - missing.length)
    + ' 段，翻好 ' + done + ' 段' + (done < wanted.length ? '，' + (wanted.length - done) + ' 段没翻成' : ''));
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
