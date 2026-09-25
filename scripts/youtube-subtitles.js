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
 * 参数（模块里的 argument，用 & 分隔）：
 *   keys      DeepL key，多个用 | 分隔
 *   target    目标语言，DeepL 的写法，比如 ZH-HANS、ZH-HANT、EN-US、JA
 *   position  top：原文在上；bottom：原文在下；only：只显示译文
 *   fallback  google：全部 key 失败时用 Google 翻译；off：不兜底
 *   debug     true：在 Surge 日志里打印每次请求的细节
 */

var STORE_KEY = 'yt-subtitles-deepl';
var BATCH = 50;            // DeepL 一次最多 50 段
var CACHE_VIDEOS = 3;      // 缓存最近几个视频的翻译，拖动进度条时不重复花额度

var PAUSE = { 403: 7 * 86400, 456: 86400, 429: 60, 5: 300 };

function parseArgs(raw) {
  var args = { keys: '', target: 'ZH-HANS', position: 'top', fallback: 'google', debug: 'false' };
  String(raw || '').split('&').forEach(function (part) {
    var i = part.indexOf('=');
    if (i <= 0) return;
    var value = part.slice(i + 1);
    try { value = decodeURIComponent(value); } catch (e) {}
    args[part.slice(0, i).trim()] = value.replace(/^"|"$/g, '').trim();
  });
  args.keyList = args.keys.split(/[|;,\s]+/).filter(function (k) { return /^[\w-]+(:fx)?$/i.test(k) && k.length > 20; });
  args.target = args.target.toUpperCase();
  args.debug = args.debug === 'true';
  return args;
}

var ARGS = parseArgs(typeof $argument === 'undefined' ? '' : $argument);

function log() {
  if (ARGS.debug) console.log('[YouTube 字幕] ' + Array.prototype.join.call(arguments, ' '));
}

// ---------- 状态：暂停中的 key、当前在用的 key、翻译缓存 ----------

function loadState() {
  try {
    var state = JSON.parse($persistentStore.read(STORE_KEY) || '{}');
    return { paused: state.paused || {}, current: state.current || '', cache: state.cache || [] };
  } catch (e) {
    return { paused: {}, current: '', cache: [] };
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

function post(options) {
  return new Promise(function (resolve) {
    $httpClient.post(options, function (error, response, body) {
      resolve({ error: error, status: response ? (response.status || response.statusCode) : 0, body: body });
    });
  });
}

function get(options) {
  return new Promise(function (resolve) {
    $httpClient.get(options, function (error, response, body) {
      resolve({ error: error, status: response ? (response.status || response.statusCode) : 0, body: body });
    });
  });
}

// ---------- 翻译 ----------

function deeplOnce(key, texts, source) {
  var host = /:fx$/i.test(key) ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  var body = { text: texts, target_lang: ARGS.target, preserve_formatting: true };
  if (source) body.source_lang = source;
  return post({
    url: host + '/v2/translate',
    headers: { Authorization: 'DeepL-Auth-Key ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: 15,
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

// 按顺序试 key：先用上次成功的那个，出错就换下一个
function deepl(texts, source, state) {
  var keys = ARGS.keyList.slice();
  var start = keys.indexOf(state.current);
  if (start > 0) keys = keys.slice(start).concat(keys.slice(0, start));
  var t = now();
  keys = keys.filter(function (k) { return !(state.paused[fingerprint(k)] > t); });

  function attempt(i) {
    if (i >= keys.length) return Promise.resolve(null);
    var key = keys[i];
    return deeplOnce(key, texts, source).then(function (r) {
      if (r.ok) {
        state.current = key;
        return r.list;
      }
      var pause = PAUSE[r.status] || (r.status >= 500 ? PAUSE[5] : 0);
      log('key ' + fingerprint(key) + ' 失败，状态码 ' + r.status + (pause ? '，暂停 ' + pause + ' 秒' : ''));
      if (pause) state.paused[fingerprint(key)] = now() + pause;
      return attempt(i + 1);
    });
  }
  return attempt(0);
}

function googleTarget() {
  var t = ARGS.target;
  if (t === 'ZH' || t === 'ZH-HANS') return 'zh-CN';
  if (t === 'ZH-HANT') return 'zh-TW';
  return t.split('-')[0].toLowerCase();
}

// Google 兜底：一段一段翻，并发 5 个
function google(texts) {
  var out = new Array(texts.length);
  var next = 0;
  function worker() {
    if (next >= texts.length) return Promise.resolve();
    var i = next++;
    return get({
      url: 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=' + googleTarget() + '&q=' + encodeURIComponent(texts[i]),
      timeout: 10,
    }).then(function (r) {
      try {
        out[i] = JSON.parse(r.body)[0].map(function (seg) { return seg[0]; }).join('');
      } catch (e) {
        out[i] = '';
      }
      return worker();
    });
  }
  var workers = [];
  for (var w = 0; w < 5; w++) workers.push(worker());
  return Promise.all(workers).then(function () { return out; });
}

// 翻译一组不重复的文本，返回 { 原文: 译文 }
function translateAll(texts, source, state, cached) {
  var todo = texts.filter(function (t) { return !(t in cached); });
  var result = {};
  Object.keys(cached).forEach(function (k) { result[k] = cached[k]; });
  var batches = [];
  for (var i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  log('共 ' + texts.length + ' 段，缓存命中 ' + (texts.length - todo.length) + ' 段，分 ' + batches.length + ' 批翻译');

  var deeplDown = false;
  return batches.reduce(function (chain, batch) {
    return chain.then(function () {
      var viaDeepl = deeplDown ? Promise.resolve(null) : deepl(batch, source, state);
      return viaDeepl.then(function (list) {
        if (list) return list;
        deeplDown = true;
        if (ARGS.fallback !== 'google') return null;
        log('DeepL 全部不可用，改用 Google');
        return google(batch);
      }).then(function (list) {
        if (!list) return;
        batch.forEach(function (text, j) { if (list[j]) result[text] = list[j]; });
      });
    });
  }, Promise.resolve()).then(function () { return result; });
}

// ---------- 字幕格式 ----------

function combine(original, translation) {
  if (!translation || translation === original) return original;
  if (ARGS.position === 'only') return translation;
  if (ARGS.position === 'bottom') return translation + '\n' + original;
  return original + '\n' + translation;
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
      return doc.events.map(function (e) {
        return e.segs ? e.segs.map(function (s) { return s.utf8 || ''; }).join('').trim() : '';
      });
    },
    apply: function (doc, texts, map) {
      doc.events.forEach(function (e, i) {
        if (!texts[i]) return;
        e.segs = [{ utf8: combine(texts[i], map[texts[i]]) }];
        delete e.wWinId; // 自动字幕的滚动窗口，去掉后按普通字幕显示
      });
      return doc;
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
    apply: function (body, texts, map) {
      var i = 0;
      return body.replace(this.RE, function (m, open, tag, inner, close) {
        var text = texts[i++];
        if (!text || !map[text]) return m;
        return open + encodeXml(combine(text, map[text])) + close;
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
    apply: function (body, texts, map) {
      return this.blocks(body).map(function (block, i) {
        if (!texts[i] || !map[texts[i]]) return block;
        var lines = block.split('\n');
        var at = lines.findIndex(function (l) { return l.indexOf('-->') !== -1; });
        return lines.slice(0, at + 1).concat(combine(texts[i], map[texts[i]])).join('\n');
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

// ---------- 主流程 ----------

function main() {
  var url = $request.url;
  var body = $response.body;
  var lang = param(url, 'lang').toLowerCase();
  log(url);

  if (!body || typeof body !== 'string') return Promise.resolve(null);
  if (param(url, 'tlang')) { log('YouTube 自带翻译字幕，跳过'); return Promise.resolve(null); }
  if (lang && lang.split('-')[0] === ARGS.target.split('-')[0].toLowerCase()) { log('已经是目标语言，跳过'); return Promise.resolve(null); }
  if (!ARGS.keyList.length && ARGS.fallback !== 'google') { log('没有可用的 DeepL key'); return Promise.resolve(null); }

  var format = detect(url, body);
  if (!format) { log('不认识的字幕格式'); return Promise.resolve(null); }
  var handler = FORMATS[format];
  var doc = handler.parse(body);
  var texts = handler.texts(doc);
  var unique = texts.filter(function (t, i) { return t && texts.indexOf(t) === i; });
  if (!unique.length) return Promise.resolve(null);

  var state = loadState();
  var cacheId = [param(url, 'v'), lang, param(url, 'kind'), ARGS.target].join('|');
  var entry = state.cache.filter(function (c) { return c.id === cacheId; })[0];
  var cached = entry ? entry.map : {};
  // DeepL 的源语言写法：en、ja → EN、JA；自动生成字幕的语言也能用
  var source = lang ? lang.split('-')[0].toUpperCase() : '';

  return translateAll(unique, source, state, cached).then(function (map) {
    state.cache = state.cache.filter(function (c) { return c.id !== cacheId; });
    state.cache.unshift({ id: cacheId, map: map });
    state.cache = state.cache.slice(0, CACHE_VIDEOS);
    saveState(state);
    if (!Object.keys(map).length) { log('没有拿到任何翻译，保持原字幕'); return null; }
    return handler.stringify(handler.apply(doc, texts, map));
  });
}

main().then(function (out) {
  $done(out ? { body: out } : {});
}, function (error) {
  log('出错：' + (error && error.message));
  $done({});
});
