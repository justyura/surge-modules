/* Surge generic script: proxy usage information panel */

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

function finishError(message) {
  $done({
    title: "代理流量 · 更新失败",
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
        "Cache-Control": "no-cache"
      }
    },
    function (error, response, body) {
      if (error) {
        finishError("请求失败，请检查网络或服务状态");
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

