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
