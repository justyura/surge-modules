// 注入到网页里运行的代码。tools/build_web.py 会把下面的 __XXX__ 占位符换成真实数据，
// 打包进 scripts/web/inject.js。这个文件本身不会被 Surge 直接加载。
(function () {
  if (window.__surgeWebClean) return;
  window.__surgeWebClean = true;

  var NONCE = (document.currentScript && document.currentScript.nonce) || '';
  var HOST = location.hostname;
  var SITES = __SITES__;       // 站点 -> { css: 站点规则, generic: 是否用通用规则, skip: 该站点例外的通用规则序号 }
  var GENERIC = __GENERIC__;   // AdGuard 通用隐藏规则，每条一个 CSS 规则
  var POPUP_EXCLUDES = __POPUP_EXCLUDES__;

  function siteOf(host) {
    var best = '';
    for (var site in SITES) {
      if ((host === site || host.slice(-site.length - 1) === '.' + site) && site.length > best.length) best = site;
    }
    return best;
  }

  // ---- 1. 元素隐藏（AdGuard 过滤规则） ----
  function addCss(css) {
    if (!css) return;
    try {
      // 用可构造样式表，不受网页 CSP 的 style-src 限制
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sheet]);
      return;
    } catch (e) {}
    var style = document.createElement('style');
    if (NONCE) style.setAttribute('nonce', NONCE);
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  var conf = SITES[siteOf(HOST)] || { css: '', generic: true, skip: [] };
  var skipped = {};
  conf.skip.forEach(function (i) { skipped[i] = true; });
  var genericCss = conf.generic
    ? GENERIC.filter(function (_, i) { return !skipped[i]; }).join('\n')
    : '';
  addCss(genericCss + '\n' + conf.css);

  // ---- 2. 按站点的清理脚本 ----
  var CLEANERS = {};
  __CLEANERS__
  for (var name in CLEANERS) {
    try {
      if (CLEANERS[name].match.test(HOST)) CLEANERS[name].run();
    } catch (e) {}
  }

  // ---- 3. AdGuard Popup Blocker ----
  function excluded(url) {
    for (var i = 0; i < POPUP_EXCLUDES.length; i++) {
      if (POPUP_EXCLUDES[i].test(url)) return true;
    }
    return false;
  }
  if (!excluded(location.href)) {
    (function () {
      // 用户脚本管理器接口的替身：设置存在当前网站的 localStorage 里，字体资源不加载（用系统字体）
      var PREFIX = '__adg_popup_blocker__';
      var unsafeWindow = window;
      function GM_getValue(key, fallback) {
        try {
          var raw = localStorage.getItem(PREFIX + key);
          return raw === null ? fallback : JSON.parse(raw);
        } catch (e) { return fallback; }
      }
      function GM_setValue(key, value) {
        try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (e) {}
      }
      function GM_deleteValue(key) {
        try { localStorage.removeItem(PREFIX + key); } catch (e) {}
      }
      function GM_listValues() {
        try {
          return Object.keys(localStorage)
            .filter(function (k) { return k.indexOf(PREFIX) === 0; })
            .map(function (k) { return k.slice(PREFIX.length); });
        } catch (e) { return []; }
      }
      function GM_getResourceURL() { return ''; }
      __POPUP_BLOCKER__
    })();
  }
})();
