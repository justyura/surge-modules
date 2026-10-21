/* Surge generic script: proxy usage information panel
 *
 * 两种数据来源：
 * 1. 流量查询接口，返回 JSON（字段见 README「代理流量面板」）
 * 2. 机场订阅链接：响应头里的 subscription-userinfo: upload=…; download=…; total=…; expire=…
 *    有这个头就按它显示，订阅内容本身不看。参数 name 是面板标题，订阅返回了 profile-title 就用它
 */

function parseArguments(raw) {
  var result = {};
  String(raw || "")
    .split("&")
    .forEach(function (part) {
      var index = part.indexOf("=");
      if (index < 0) return;
      var key = decodeURIComponent(part.slice(0, index));
      var value = decodeURIComponent(part.slice(index + 1));
      result[key] = value;
    });
  return result;
}

function number(value, fallback) {
  var parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function gib(value) {
  return number(value, 0).toFixed(2);
}

function dateOnly(value) {
  return String(value || "-").split(" ")[0];
}

function daysUntilInclusive(value) {
  var parts = String(value || "").split("-").map(Number);
  if (parts.length !== 3 || parts.some(function (item) { return !item; })) return null;

  var now = new Date();
  var todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  var targetUtc = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  return Math.max(0, Math.ceil((targetUtc - todayUtc) / 86400000) + 1);
}

function header(response, name) {
  var headers = (response && response.headers) || {};
  for (var key in headers) {
    if (key.toLowerCase() === name) return String(headers[key]);
  }
  return "";
}

// profile-title 可能是 base64:xxxx
function profileTitle(value) {
  var match = /^base64:(.+)$/i.exec(value);
  if (!match) return value;
  try {
    return decodeURIComponent(escape(base64Binary(match[1])));
  } catch (error) {
    return "";
  }
}

// Surge 的脚本环境不一定有 atob，自己解
function base64Binary(text) {
  var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var clean = String(text).replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "");
  var output = "";
  var buffer = 0;
  var bits = 0;
  for (var i = 0; i < clean.length; i++) {
    buffer = (buffer << 6) | alphabet.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 255);
    }
  }
  return output;
}

function localDate(seconds) {
  var d = new Date(seconds * 1000);
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function clock() {
  var d = new Date();
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

// subscription-userinfo: upload=1; download=2; total=3; expire=4
function subscriptionPanel(info, title) {
  var fields = {};
  info.split(";").forEach(function (part) {
    var pair = part.split("=");
    if (pair.length === 2) fields[pair[0].trim().toLowerCase()] = number(pair[1].trim(), 0);
  });
  var gibOf = function (bytes) { return (bytes || 0) / 1073741824; };
  var up = gibOf(fields.upload);
  var down = gibOf(fields.download);
  var used = up + down;
  var limit = gibOf(fields.total);
  var left = Math.max(0, limit - used);
  var percent = limit > 0 ? (used / limit) * 100 : 0;
  var color = percent >= 90 ? "#FF3B30" : percent >= 75 ? "#FF9500" : "#34C759";
  var expire = fields.expire ? localDate(fields.expire) : "";
  var expireDays = expire ? daysUntilInclusive(expire) : null;
  var lines = [
    limit > 0 ? "剩余 " + gib(left) + " GiB / " + gib(limit) + " GiB" : "已用 " + gib(used) + " GiB（订阅没给总量）",
    "已用 " + gib(used) + " GiB · " + percent.toFixed(1) + "%（上传 " + gib(up) + " · 下载 " + gib(down) + "）",
    expire ? "到期 " + expire + (expireDays === null ? "" : " · " + expireDays + " 天") : "到期 长期有效",
    "更新 " + clock()
  ];
  if (expireDays !== null && expireDays <= 7 && percent < 90) color = "#FF9500";
  $done({
    title: title + (limit > 0 ? " · 剩余 " + gib(left) + " GiB" : ""),
    content: lines.join("\n"),
    icon: "antenna.radiowaves.left.and.right",
    "icon-color": color
  });
}

function finishError(message) {
  $done({
    title: (args.name || "代理流量") + " · 更新失败",
    content: message || "无法读取账户信息",
    icon: "exclamationmark.triangle.fill",
    "icon-color": "#FF3B30"
  });
}

var rawArgument = typeof $argument === "undefined" ? "" : String($argument);
var args = parseArguments(rawArgument);
// url 放在最后且可能自带 ?a=1&b=2，所以取 "url=" 之后的全部内容
var urlMatch = rawArgument.match(/(?:^|&)url=(.*)$/);
var apiUrl = urlMatch ? urlMatch[1] : args.url || "";
try {
  apiUrl = decodeURIComponent(apiUrl);
} catch (decodeError) {}
apiUrl = apiUrl.trim();

if (!/^https?:\/\//i.test(apiUrl)) {
  finishError("模块未配置有效的 API 地址");
} else {
  $httpClient.get(
    {
      url: apiUrl,
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        // 订阅链接一般只给代理客户端返回 subscription-userinfo
        "User-Agent": "Surge iOS"
      }
    },
    function (error, response, body) {
      if (error) {
        finishError("请求失败，请检查网络或服务状态");
        return;
      }

      var info = header(response, "subscription-userinfo");
      if (info) {
        subscriptionPanel(info, profileTitle(header(response, "profile-title")) || args.name || "订阅流量");
        return;
      }

      try {
        var payload = JSON.parse(body || "{}");
        if (payload.ok === false) throw new Error("API error");
        var data = payload.data || payload;

        var limit = number(data.limit_gib, number(data.limit_bytes, 0) / 1073741824);
        var used = number(data.bill_gib, number(data.bill_bytes, 0) / 1073741824);
        var left = number(data.left_gib, Math.max(0, limit - used));
        var percent = number(data.used_pct, limit > 0 ? (used / limit) * 100 : 0);
        var expireDays = daysUntilInclusive(dateOnly(data.expires_at));
        var resetDays = number(data.reset_days_left, null);

        var color = percent >= 90 ? "#FF3B30" : percent >= 75 ? "#FF9500" : "#34C759";
        var status = data.status === "enabled" ? "正常" : String(data.status || "未知");

        var lines = [
          "剩余 " + gib(left) + " GiB / " + gib(limit) + " GiB",
          "本月已用 " + gib(used) + " GiB · " + percent.toFixed(1) + "%",
          "到期 " + dateOnly(data.expires_at) + (expireDays === null ? "" : " · " + expireDays + " 天"),
          "重置 " + dateOnly(data.next_reset_at) + (resetDays === null ? "" : " · " + resetDays + " 天"),
          "状态 " + status + " · 更新 " + String(data.updated_at || "-")
        ];

        $done({
          title: String(data.name || "代理流量") + " · 剩余 " + gib(left) + " GiB",
          content: lines.join("\n"),
          icon: "chart.bar.fill",
          "icon-color": color
        });
      } catch (parseError) {
        finishError("返回内容不是预期的用量数据");
      }
    }
  );
}

