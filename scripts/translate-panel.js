/*
 * 翻译合集的「翻译状态」面板，显示：
 *   - 现在用的是哪个：大模型（填了大模型 key）、DeepL、Google（只开了兜底）
 *   - 最近实际用了哪个：字幕、评论、整句文稿各自最近一次，各引擎请求了几次、失败的原因
 *     （youtube-subtitles.js 每次处理完存在 translate-usage 里）
 *   - 每个 DeepL key 还剩多少额度（GET /v2/usage，不花字数）、有没有被暂停
 *
 * 填了大模型 key 时还会测试一下：用模块里填的大模型 key、模型、接口和「大模型思考」翻一小段字幕，
 * 显示每个 key 能不能用、用时、思考有没有关掉、译文。用的是和各个翻译脚本同一段大模型代码和
 * YouTube 字幕的提示词（含「YouTube译法」），面板上正常，字幕那边发出去的请求也是一样的。
 *
 * 测试的字幕是一句话被切成两行，单看第一行「rushed to the bank」分不清是银行还是河岸，
 * 要结合视频标题和前后几句才知道是银行：顺便看模型有没有用上上下文。
 *
 * 每点一次每个 key 发一个很小的请求，几百个 token。
 *
 * 参数（模块里的 argument，用 & 分隔）：
 *   keys      DeepL key，多个用 | 分隔
 *   fallback  google：DeepL 都用不了时用 Google；off：不用
 *   llmkeys   大模型 key，多个用 | 分隔
 *   model     模型名，默认 gpt-6-luna
 *   api       接口地址，默认 https://api.openai.com/v1
 *   style     YouTube 的译法：faithful 贴着原文翻，natural 可以意译
 *   effort    大模型思考档位：auto 按模型自动关掉思考，off 不带参数，或者 none、low、medium 这些
 *   target    目标语言，比如 ZH-HANS
 */

var SAMPLE = {
  video: 'Why Silicon Valley Bank collapsed in 48 hours — Economics Explained',
  before: ['by Thursday morning the depositors were getting nervous'],
  lines: ['and then everyone rushed to the bank', 'to pull their money out at the same time'],
  after: ['and no bank can survive that'],
};
var BUDGET = 25;  // 秒，模块里脚本的 timeout 是 30
var PAUSE = {};   // 面板只测试，不暂停 key

function parseArgs(raw) {
  var args = { keys: '', fallback: 'google', llmkeys: '', model: '', api: '', effort: '', style: 'faithful', target: 'ZH-HANS' };
  String(raw || '').split('&').forEach(function (part) {
    var i = part.indexOf('=');
    if (i <= 0) return;
    var value = part.slice(i + 1);
    try { value = decodeURIComponent(value); } catch (e) {}
    args[part.slice(0, i).trim()] = value.replace(/^"|"$/g, '').trim();
  });
  args.target = args.target.toUpperCase();
  args.style = args.style === 'natural' ? 'natural' : 'faithful';
  // DeepL key 单独放：测试大模型时不让它退回 DeepL
  args.deeplKeys = args.keys.split(/[|;,\s]+/).filter(function (k) { return /^[\w-]+(:fx)?$/i.test(k) && k.length > 20; });
  args.google = args.fallback !== 'off';
  args.keyList = [];
  args.fallback = 'off';
  return parseLlmArgs(args);
}

var ARGS = parseArgs(typeof $argument === 'undefined' ? '' : $argument);
var DEADLINE = Date.now() + BUDGET * 1000;

function log(message) { console.log('[翻译测试] ' + message); }
function remaining() { return (DEADLINE - Date.now()) / 1000; }
function now() { return Math.floor(Date.now() / 1000); }

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

// 出错的原因，尽量说人话
function reason(last) {
  var body = String(last.body || '');
  var message = body;
  try { message = JSON.parse(body).error.message || body; } catch (e) {}
  if (last.status === 0) return '连不上接口';
  if (last.status === 401) return 'key 无效';
  if (last.status === 404 || /model_not_found|does not exist/i.test(body)) return '模型名不对，或者这个 key 用不了这个模型';
  if (last.status === 429) return /insufficient_quota/.test(body) ? '额度用完了' : '请求太多，等一会儿';
  return '状态码 ' + last.status + (message ? '：' + String(message).slice(0, 60) : '');
}

async function testKey(key) {
  var payload = { video: SAMPLE.video, before: SAMPLE.before, after: SAMPLE.after, lines: { 1: SAMPLE.lines[0], 2: SAMPLE.lines[1] } };
  llmLast = null;
  var r = await llmOnce(key, subtitlePrompt(), payload, reasoningEffort(ARGS.model));
  var last = llmLast || { ms: 0, effort: '-', status: 0, body: '没有返回' };
  if (!r.ok) return { ok: false, last: last, why: reason(last) };
  var list = r.list || {};
  var names = Object.keys(list);
  if (names.length === 1 && list[names[0]] && typeof list[names[0]] === 'object') list = list[names[0]];
  var text = Array.isArray(list) ? list[0] : list[1] || list['1'];
  return { ok: !!text, last: last, text: typeof text === 'string' ? text.trim() : '', why: text ? '' : '返回的格式不对' };
}

function finish(panel) { $done(panel); }

var STATE_KEY = 'yt-subtitles-deepl';  // 和翻译脚本共用：哪个 DeepL key 在暂停
var USAGE_KEY = 'translate-usage';
var NAMES = { llm: '大模型', deepl: 'DeepL', google: 'Google' };

function read(key, fallback) {
  try { return JSON.parse($persistentStore.read(key) || '') || fallback; } catch (e) { return fallback; }
}

function number(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

function clock(seconds) {
  var d = new Date(seconds * 1000);
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function ago(seconds) {
  var s = now() - seconds;
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}

function failure(engine, status) {
  if (status === 0) return '连不上';
  if (engine === 'deepl') return { 403: 'key 无效', 456: '额度用完', 429: '请求太多' }[status] || (status >= 500 ? '服务器出错' : '状态码 ' + status);
  if (engine === 'llm') return { 401: 'key 无效', 429: '额度用完或请求太多' }[status] || '状态码 ' + status;
  return '状态码 ' + status;
}

// 现在按配置会先用哪个
function primary() {
  if (ARGS.llmKeyList.length) return '大模型 ' + ARGS.model + '，DeepL' + (ARGS.google ? ' / Google' : '') + ' 兜底';
  if (ARGS.deeplKeys.length) return 'DeepL' + (ARGS.google ? '，Google 兜底' : '');
  if (ARGS.google) return 'Google（没填 DeepL 和大模型的 key）';
  return '';
}

// 最近一次：字幕、评论、整句文稿各一行
function recentLines() {
  var seen = {};
  var lines = [];
  var warn = false;
  read(USAGE_KEY, []).forEach(function (rec) {
    if (seen[rec.what] || lines.length >= 3) return;
    seen[rec.what] = true;
    var parts = ['llm', 'deepl', 'google'].filter(function (e) { return rec.engines[e]; }).map(function (e) {
      var u = rec.engines[e];
      var name = e === 'llm' && rec.model ? rec.model : NAMES[e];
      if (u.fail) warn = true;
      return name + (u.ok ? ' ' + u.ok + ' 次' : '') + (u.fail ? (u.ok ? '，' : ' ') + '失败 ' + u.fail + ' 次（' + failure(e, u.last) + '）' : '');
    });
    lines.push('最近' + rec.what + ' · ' + ago(rec.at) + ' · ' + parts.join(' → '));
  });
  return { lines: lines.length ? lines : ['最近：还没有翻译记录'], warn: warn };
}

function deeplUsage(key) {
  var host = /:fx$/i.test(key) ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  return request('get', { url: host + '/v2/usage', headers: { Authorization: 'DeepL-Auth-Key ' + key }, timeout: 8 }).then(function (r) {
    if (r.error || r.status !== 200) return { ok: false, status: r.error ? 0 : r.status };
    try {
      var j = JSON.parse(r.body);
      return { ok: true, used: j.character_count || 0, limit: j.character_limit || 0 };
    } catch (e) {
      return { ok: false, status: 0 };
    }
  });
}

// 每个 DeepL key：剩多少字、用了百分之几，暂停中的写到几点
async function deeplLines() {
  var paused = read(STATE_KEY, {}).paused || {};
  var results = await Promise.all(ARGS.deeplKeys.map(deeplUsage));
  var level = 'good';
  var lines = results.map(function (r, i) {
    var key = ARGS.deeplKeys[i];
    var name = 'DeepL' + (ARGS.deeplKeys.length > 1 ? ' key ' + (i + 1) : '') + '（…' + key.replace(/:fx$/i, '').slice(-4) + (/:fx$/i.test(key) ? ' 免费' : ' Pro') + '）';
    var until = paused[fingerprint(key)];
    var pause = until > now() ? '，暂停到 ' + clock(until) : '';
    if (!r.ok) { level = 'bad'; return name + '：' + failure('deepl', r.status) + pause; }
    var left = Math.max(0, r.limit - r.used);
    var pct = r.limit ? Math.round(r.used * 100 / r.limit) : 0;
    if (!left || pause) level = level === 'bad' ? 'bad' : 'warn';
    else if (pct >= 90 && level === 'good') level = 'warn';
    return name + '：剩 ' + number(left) + ' 字，已用 ' + pct + '%' + (left ? '' : '，额度用完') + pause;
  });
  var usable = results.filter(function (r, i) {
    var until = paused[fingerprint(ARGS.deeplKeys[i])];
    return r.ok && r.limit > r.used && !(until > now());
  }).length;
  return { lines: lines, level: level, usable: usable };
}

// 填了大模型 key 才测：返回几行和结论
async function llmLines() {
  var results = [];
  for (var i = 0; i < ARGS.llmKeyList.length && remaining() > 3; i++) results.push(await testKey(ARGS.llmKeyList[i]));
  var good = results.filter(function (r) { return r.ok; });
  var first = good[0];
  var lines = [];
  var keyLines = results.map(function (r, i) { return 'key ' + (i + 1) + '：' + (r.ok ? '能用' : r.why); });
  if (ARGS.llmKeyList.length > 1 || !first) lines.push(keyLines.join('；'));
  if (!first) {
    lines.unshift(ARGS.model + ' · 思考 ' + results[0].last.effort);
    log(results.map(function (r) { return r.last.status + ' ' + r.last.body; }).join('\n'));
    return { lines: lines, verdict: '大模型用不了', level: 'bad' };
  }
  var last = first.last;
  lines.unshift(ARGS.model + ' · 思考 ' + last.effort + ' · ' + (last.ms / 1000).toFixed(1) + ' 秒');
  lines.splice(1, 0, last.reasoning ? '思考用了 ' + last.reasoning + ' token，没关掉：把「大模型思考」改成 none 或 low' : '思考 token 0，思考已关掉');
  lines.push('原文：' + SAMPLE.lines[0]);
  lines.push('译文：' + first.text);
  var zh = /^ZH/.test(ARGS.target);
  var contextOk = !zh || /银行|銀行/.test(first.text);
  if (!contextOk) lines.push('没结合上下文：bank 应该是银行');
  var perfect = !last.reasoning && good.length === results.length && contextOk;
  return { lines: lines, verdict: perfect ? '大模型正常' : '大模型能用，有问题', level: perfect ? 'good' : 'warn' };
}

var STYLES = {
  good: { icon: 'checkmark.seal.fill', 'icon-color': '#34C759' },
  warn: { icon: 'exclamationmark.triangle.fill', 'icon-color': '#FF9500' },
  bad: { icon: 'xmark.octagon.fill', 'icon-color': '#FF3B30' },
};

async function main() {
  var using = primary();
  var recent = recentLines();
  var deepl = ARGS.deeplKeys.length ? await deeplLines() : null;
  var llm = ARGS.llmKeyList.length ? await llmLines() : null;
  var lines = ['在用：' + (using || '没有可用的翻译：填 DeepL 或大模型的 key，或者把「备用翻译」改成 google')];
  if ((read('yt-subtitles-switch', {}) || {}).translate === false) lines.push('YouTube 字幕翻译：关着（只记原文给导出、发 Claude，不花额度）');
  lines = lines.concat(recent.lines);
  if (deepl) lines = lines.concat(deepl.lines);
  if (llm) lines = lines.concat(llm.lines);

  // 实际会用到的：大模型能用就是大模型；否则有能用的 DeepL key 就是 DeepL；否则 Google
  var effective = llm && llm.level !== 'bad' ? '大模型'
    : deepl && deepl.usable ? 'DeepL'
    : ARGS.google ? 'Google'
    : '';
  var level = !effective ? 'bad'
    : (llm && llm.level !== 'good') || (deepl && deepl.level !== 'good') || recent.warn ? 'warn'
    : 'good';
  if (effective && effective !== (using.split(/[ ，（]/)[0])) lines.splice(1, 0, '实际会用 ' + effective + '：前面的用不了');
  var title = '翻译状态 · ' + (effective || '用不了') + (llm ? ' · ' + llm.verdict : '');
  finish(Object.assign({ title: title, content: lines.join('\n') }, STYLES[level]));
}

main().catch(function (error) {
  finish({ title: '翻译状态 · 出错了', content: String(error && error.message || error), icon: 'xmark.octagon.fill', 'icon-color': '#FF3B30' });
});
