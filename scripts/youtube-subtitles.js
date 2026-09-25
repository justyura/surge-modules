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
 *   budget    最多等几秒（默认 8）。到时间就先返回翻好的部分，没翻完的显示原文；
 *             翻好的会缓存，重新打开字幕会接着翻剩下的
 *   debug     true：在 Surge 日志里打印每次请求的细节
 */

var STORE_KEY = 'yt-subtitles-deepl';
var CUES_PER_TEXT = 40;          // 多少句字幕打包成一段发给 DeepL（用 <t> 标签隔开）
var CHARS_PER_TEXT = 3000;
var TEXTS_PER_REQUEST = 50;      // DeepL 一次最多 50 段
var BYTES_PER_REQUEST = 100000;  // DeepL 单次请求上限 128 KiB，留点余量
var PARALLEL = 3;                // 同时发几个请求
var CACHE_VIDEOS = 3;            // 缓存最近几个视频的翻译，拖进度条、重开字幕不重复花额度

var PAUSE = { 403: 7 * 86400, 456: 86400, 429: 60, 5: 300 };

function parseArgs(raw) {
  var args = { keys: '', target: 'ZH-HANS', position: 'top', fallback: 'google', budget: '8', debug: 'false' };
  String(raw || '').split('&').forEach(function (part) {
    var i = part.indexOf('=');
    if (i <= 0) return;
    var value = part.slice(i + 1);
    try { value = decodeURIComponent(value); } catch (e) {}
    args[part.slice(0, i).trim()] = value.replace(/^"|"$/g, '').trim();
  });
  args.keyList = args.keys.split(/[|;,\s]+/).filter(function (k) { return /^[\w-]+(:fx)?$/i.test(k) && k.length > 20; });
  args.target = args.target.toUpperCase();
  args.budget = Math.min(50, Math.max(3, Number(args.budget) || 8));
  args.debug = args.debug === 'true';
  return args;
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

function request(method, options) {
  return new Promise(function (resolve) {
    $httpClient[method](options, function (error, response, body) {
      resolve({ error: error, status: response ? (response.status || response.statusCode) : 0, body: body });
    });
  });
}

function timeout() { return Math.max(2, Math.min(10, Math.floor(remaining()))); }

// ---------- DeepL ----------

function deeplOnce(key, texts, source, xml) {
  var host = /:fx$/i.test(key) ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  var body = { text: texts, target_lang: ARGS.target, preserve_formatting: true };
  if (xml) body.tag_handling = 'xml';
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

// 按顺序试 key：先用上次成功的那个，出错就换下一个。返回译文数组，全部失败返回 null
async function deepl(texts, source, state, xml) {
  var keys = ARGS.keyList.slice();
  var start = keys.indexOf(state.current);
  if (start > 0) keys = keys.slice(start).concat(keys.slice(0, start));
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (state.paused[fingerprint(key)] > now()) continue;
    if (remaining() < 1) return null;
    var r = await deeplOnce(key, texts, source, xml);
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

function unpack(unit, translated) {
  var parts = [];
  String(translated || '').replace(/<t>([\s\S]*?)<\/t>/g, function (m, inner) { parts.push(unescapeTag(inner).trim()); return m; });
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

// 并发跑一组任务，截止时间到了就不再开始新的
async function parallel(tasks, limit, run) {
  var next = 0;
  async function worker() {
    while (next < tasks.length && remaining() > 1) await run(tasks[next++]);
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

// ---------- 翻译调度 ----------

// 翻译一组不重复的文本，返回 { 原文: 译文 }。到截止时间就把已经翻好的返回
async function translateAll(texts, source, state, cached) {
  var result = {};
  Object.keys(cached).forEach(function (k) { result[k] = cached[k]; });
  var todo = texts.filter(function (t) { return !(t in result); });
  var requests = group(pack(todo));
  log('共 ' + texts.length + ' 句，缓存命中 ' + (texts.length - todo.length) + ' 句，打包成 ' + requests.length + ' 个请求，限时 ' + ARGS.budget + ' 秒');

  var loose = [];     // 标签对不上的句子，单独再翻
  var leftover = [];  // DeepL 不可用时留给 Google 的句子
  var deeplDown = !ARGS.keyList.length;

  await parallel(requests, PARALLEL, async function (req) {
    var list = deeplDown ? null : await deepl(req.units.map(function (u) { return u.text; }), source, state, true);
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
  var seen = {};
  var unique = texts.filter(function (t) { if (!t || seen[t]) return false; seen[t] = true; return true; });
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

var finished = false;
var guard = null;
function finish(out) {
  if (finished) return;
  finished = true;
  clearTimeout(guard);
  $done(out ? { body: out } : {});
}

// 兜底：无论哪里卡住，超过限时 3 秒就原样返回字幕，保证字幕能加载出来
guard = setTimeout(function () { log('超时，原样返回'); finish(null); }, (ARGS.budget + 3) * 1000);

main().then(finish, function (error) {
  log('出错：' + (error && error.message));
  finish(null);
});
