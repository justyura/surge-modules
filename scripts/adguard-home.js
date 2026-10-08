/*
 * AdGuard Home 面板：在 Surge 首页显示自建 AdGuard Home 的防护状态、过去 24 小时的查询数、
 * 拦截数和比例、平均响应时间、拦截最多的域名。点面板可以刷新，也可以设成暂停 / 恢复防护。
 *
 * 用的是 AdGuard Home 自己的接口（/control/status、/control/stats、/control/protection），
 * Basic 认证，账号就是网页后台的登录账号。
 *
 * 参数（模块里的 argument，用 & 分隔，password 放最后，密码里有 & 也没关系）：
 *   url       AdGuard Home 网页后台的地址，比如 https://adguard.example.com
 *   user      登录用户名
 *   action    点面板做什么：refresh 刷新；pause 防护开着就暂停，暂停或关着就恢复
 *   minutes   暂停几分钟（默认 10，0 表示一直关着，直到再点一下）
 *   password  登录密码
 */

function parseArgs(raw) {
  var args = { url: '', user: '', action: 'refresh', minutes: '10', password: '' };
  raw = String(raw || '');
  // 密码放在最后，可能带 &，取 password= 后面的全部
  var at = raw.search(/(?:^|&)password=/);
  if (at !== -1) {
    args.password = raw.slice(raw.indexOf('password=', at) + 'password='.length);
    raw = raw.slice(0, at);
  }
  raw.split('&').forEach(function (part) {
    var i = part.indexOf('=');
    if (i <= 0) return;
    var value = part.slice(i + 1);
    try { value = decodeURIComponent(value); } catch (e) {}
    args[part.slice(0, i).trim()] = value.trim();
  });
  args.url = args.url.replace(/\/+$/, '').replace(/\/control$/, '');
  args.action = args.action === 'pause' ? 'pause' : 'refresh';
  args.minutes = /^\d+$/.test(args.minutes) ? Number(args.minutes) : 10;
  return args;
}

var ARGS = parseArgs(typeof $argument === 'undefined' ? '' : $argument);
var TAPPED = typeof $trigger !== 'undefined' && $trigger === 'button';

// Surge 里不一定有 btoa，自己转 base64（先转 UTF-8，用户名密码可能有中文）
function base64(text) {
  var bytes = [];
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) c = 0x10000 + ((c - 0xd800) << 10) + (text.charCodeAt(++i) - 0xdc00);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | c >> 6, 0x80 | c & 63);
    else if (c < 0x10000) bytes.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    else bytes.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
  }
  var table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var out = '';
  for (var j = 0; j < bytes.length; j += 3) {
    var n = bytes[j] << 16 | (bytes[j + 1] || 0) << 8 | (bytes[j + 2] || 0);
    out += table[n >> 18 & 63] + table[n >> 12 & 63]
      + (j + 1 < bytes.length ? table[n >> 6 & 63] : '=') + (j + 2 < bytes.length ? table[n & 63] : '=');
  }
  return out;
}

function api(method, path, body) {
  return new Promise(function (resolve) {
    var options = {
      url: ARGS.url + '/control' + path,
      headers: { Authorization: 'Basic ' + base64(ARGS.user + ':' + ARGS.password), Accept: 'application/json' },
      timeout: 8,
    };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    $httpClient[method](options, function (error, response, data) {
      var status = response ? (response.status || response.statusCode) : 0;
      var json = null;
      try { json = data ? JSON.parse(data) : null; } catch (e) {}
      resolve({ error: error, status: status, json: json });
    });
  });
}

function problem(r) {
  if (r.error) return '连不上 ' + ARGS.url.replace(/^https?:\/\//, '') + '，检查地址和网络';
  if (r.status === 401) return '用户名或密码不对';
  if (r.status === 403) return '被 AdGuard Home 拒绝了（403），看看是不是登录失败次数太多被暂时封了';
  if (r.status === 404) return '地址不对：这里要填网页后台的地址，不是 DNS 地址';
  return 'AdGuard Home 返回了 ' + r.status;
}

// 1234567 → 1,234,567
function count(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

// 拦截最多的几个：[{ "a.com": 12 }, …] → "a.com 12、b.com 8"
function top(list, n) {
  return (Array.isArray(list) ? list : []).slice(0, n).map(function (entry) {
    var name = Object.keys(entry || {})[0];
    return name ? name + ' ' + count(entry[name]) : '';
  }).filter(Boolean).join('、');
}

function minutesLeft(ms) { return Math.max(1, Math.ceil(ms / 60000)); }

function finish(panel) { $done(panel); }

function fail(message) {
  finish({ title: 'AdGuard Home · 出错了', content: message, icon: 'exclamationmark.triangle.fill', 'icon-color': '#FF3B30' });
}

async function main() {
  if (!/^https?:\/\/[^/]/.test(ARGS.url)) return fail('模块参数里还没填 AdGuard Home 的地址');
  if (!ARGS.user || !ARGS.password) return fail('模块参数里还没填用户名和密码');

  var status = await api('get', '/status');
  if (status.status !== 200 || !status.json) return fail(problem(status));
  var s = status.json;
  var note = '';

  if (TAPPED && ARGS.action === 'pause') {
    var body = s.protection_enabled
      ? (ARGS.minutes ? { enabled: false, duration: ARGS.minutes * 60000 } : { enabled: false })
      : { enabled: true };
    var set = await api('post', '/protection', body);
    // 老版本（0.107.27 以前）没有 /protection，改用 dns_config
    if (set.status === 404 || set.status === 405) set = await api('post', '/dns_config', { protection_enabled: body.enabled });
    if (set.status !== 200) return fail('切换防护失败：' + problem(set));
    status = await api('get', '/status');
    if (status.status === 200 && status.json) s = status.json;
    note = body.enabled ? '已恢复防护' : (ARGS.minutes ? '已暂停 ' + ARGS.minutes + ' 分钟' : '已关闭防护');
  }

  // 过去 24 小时；统计周期设得比 24 小时短时接口报 400，改用默认周期
  var stats = await api('get', '/stats?recent=86400000');
  var period = '24 小时';
  if (stats.status === 400) { stats = await api('get', '/stats'); period = '统计周期内'; }
  var st = stats.status === 200 && stats.json ? stats.json : null;

  var state;
  var color;
  if (s.protection_enabled) { state = '防护中'; color = '#34C759'; }
  else if (s.protection_disabled_duration > 0) { state = '已暂停 · 还剩 ' + minutesLeft(s.protection_disabled_duration) + ' 分钟'; color = '#FF9500'; }
  else { state = '防护已关闭'; color = '#FF9500'; }
  if (s.running === false) { state = 'DNS 服务没在运行'; color = '#FF3B30'; }

  var lines = [];
  if (st) {
    var queries = Number(st.num_dns_queries) || 0;
    var blocked = (Number(st.num_blocked_filtering) || 0) + (Number(st.num_replaced_safebrowsing) || 0) + (Number(st.num_replaced_parental) || 0);
    lines.push(period + '查询 ' + count(queries) + ' · 拦截 ' + count(blocked) + (queries ? '（' + (blocked / queries * 100).toFixed(1) + '%）' : ''));
    if (st.avg_processing_time) lines.push('平均响应 ' + (st.avg_processing_time * 1000).toFixed(1) + ' ms');
    var blockedTop = top(st.top_blocked_domains, 2);
    if (blockedTop) lines.push('拦截最多 ' + blockedTop);
  } else {
    lines.push('统计数据读取失败：' + problem(stats));
  }
  lines.push((s.version || '') + (note ? ' · ' + note : '') + (ARGS.action === 'pause' ? ' · 点一下' + (s.protection_enabled ? '暂停' : '恢复') : ''));

  finish({
    title: 'AdGuard Home · ' + state,
    content: lines.join('\n'),
    icon: s.protection_enabled ? 'checkmark.shield.fill' : 'shield.slash.fill',
    'icon-color': color,
  });
}

main().catch(function (e) { fail('脚本出错：' + (e && e.message)); });
