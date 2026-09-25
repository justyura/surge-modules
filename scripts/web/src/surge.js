// Surge http-response 脚本：往网页 HTML 里插一段 <script>（内容见 scripts/web/src/page.js）。
// tools/build_web.py 会把下面的 PAYLOAD 占位符换成打包好的网页代码，生成 scripts/web/inject.js。

(function () {
  var response = $response;
  var headers = response.headers || {};

  function header(name) {
    for (var key in headers) {
      if (key.toLowerCase() === name) return { key: key, value: String(headers[key]) };
    }
    return null;
  }

  var type = header('content-type');
  var body = response.body;
  if (!type || !/text\/html/i.test(type.value) || typeof body !== 'string' || body.indexOf('__surgeWebClean') !== -1) {
    return $done({});
  }

  function randomNonce() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    for (var i = 0; i < 24; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  // 网页有 CSP 时，内联脚本要带 nonce 才能跑：
  // - 已经有 nonce：用它的
  // - 允许 'unsafe-inline' 且没有 hash / strict-dynamic：不需要 nonce
  // - 其他情况：给 script-src 加一个我们自己的 nonce。这时网页原本的内联脚本本来就要靠
  //   nonce/hash 才能跑，多加一个 nonce 不会改变它们的行为
  function patchCsp(csp) {
    var directives = csp.split(';');
    var names = ['script-src-elem', 'script-src', 'default-src'];
    var nonce = '';
    var target = -1;
    for (var n = 0; n < names.length && target === -1; n++) {
      for (var i = 0; i < directives.length; i++) {
        var tokens = directives[i].trim().split(/\s+/);
        if (tokens[0].toLowerCase() === names[n]) { target = i; break; }
      }
    }
    if (target === -1) return { csp: csp, nonce: '' };

    var parts = directives[target].trim().split(/\s+/);
    for (var j = 1; j < parts.length; j++) {
      var match = /^'nonce-(.+)'$/.exec(parts[j]);
      if (match) return { csp: csp, nonce: match[1] };
    }
    var lower = parts.map(function (p) { return p.toLowerCase(); });
    var inlineAllowed = lower.indexOf("'unsafe-inline'") !== -1 &&
      !lower.some(function (p) { return /^'(sha(256|384|512)-|strict-dynamic)/.test(p); });
    if (inlineAllowed) return { csp: csp, nonce: '' };

    nonce = randomNonce();
    directives[target] = ' ' + parts.join(' ') + " 'nonce-" + nonce + "'";
    return { csp: directives.join(';'), nonce: nonce };
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

  var tag = '<script' + (nonce ? ' nonce="' + nonce + '"' : '') + '>' + __PAYLOAD__ + '</script>';

  // 插在 <head> 的最前面，比网页自己的脚本和 <meta> CSP 都早
  var inserted = false;
  body = body.replace(/<head(\s[^>]*)?>/i, function (m) { inserted = true; return m + tag; });
  if (!inserted) body = body.replace(/<html(\s[^>]*)?>/i, function (m) { inserted = true; return m + tag; });
  if (!inserted) body = body.replace(/^(\s*<!doctype[^>]*>)?/i, function (m) { return m + tag; });

  $done({ headers: newHeaders, body: body });
})();
