#!/usr/bin/env python3
"""生成网页模块：web-popups.sgmodule 和 scripts/web/inject.js。

    python3 tools/build_web.py

做的事：
1. 读 rules/web-sites.txt，得到要注入脚本的网站
2. 下载 AdGuard 过滤列表，挑出这些网站能用的元素隐藏规则
3. 把规则、scripts/web/src/cleaners/ 里的清理脚本、AdGuard Popup Blocker 打包成网页代码
4. 生成 Surge 用的 scripts/web/inject.js 和 web-popups.sgmodule

AdGuard 过滤列表每天在变，GitHub Actions 每天跑一次。
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITES_FILE = ROOT / "rules" / "web-sites.txt"
SRC = ROOT / "scripts" / "web" / "src"
POPUP_BLOCKER = ROOT / "scripts" / "vendor" / "AdguardTeam-PopupBlocker" / "popupblocker.user.js"
INJECT = ROOT / "scripts" / "web" / "inject.js"
MODULE = ROOT / "web-popups.sgmodule"
RAW = "https://raw.githubusercontent.com/justyura/surge-modules/main/"

# AdGuard 过滤列表（GPL-3.0）：弹窗、App 横幅、其他烦人元素、中文
FILTERS = {
    19: "AdGuard Popups filter",
    20: "AdGuard Mobile App Banners filter",
    21: "AdGuard Other Annoyances filter",
    224: "AdGuard Chinese filter",
}
FILTER_URL = "https://filters.adtidy.org/ios/filters/{}_optimized.txt"

# 浏览器原生 CSS 做不到的 AdGuard 扩展语法，遇到就跳过这条规则
EXTENDED = re.compile(
    r":(has-text|contains|-abp-|matches-css|matches-attr|matches-property|xpath|nth-ancestor|upward|remove|if|if-not|min-text-length|style)\b|\[-ext-"
)
MARKERS = ["#@$?#", "#$?#", "#@?#", "#?#", "#@$#", "#$#", "#@%#", "#%#", "#@#", "##"]


def read_sites():
    sites = []
    for line in SITES_FILE.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip().lower()
        if line and line not in sites:
            if not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", line):
                sys.exit(f"web-sites.txt 里的域名格式不对：{line}")
            sites.append(line)
    return sites


def download(url):
    last = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(url, timeout=90) as response:
                return response.read().decode("utf-8")
        except Exception as error:  # 网络抖动重试
            last = error
    sys.exit(f"下载失败：{url}（{last}）")


def domain_matches(pattern, host):
    if pattern.endswith(".*"):
        base = re.escape(pattern[:-2])
        return re.search(rf"(^|\.){base}\.[a-z]{{2,}}(\.[a-z]{{2,}})?$", host) is not None
    return host == pattern or host.endswith("." + pattern)


def split_domains(text):
    positive, negative = [], []
    for item in filter(None, (d.strip().lower() for d in text.split(","))):
        (negative if item.startswith("~") else positive).append(item.lstrip("~"))
    return positive, negative


def parse_filters(texts):
    """返回 (rules, exceptions, hide_off)：
    rules      [(positive, negative, css)]  元素隐藏 / CSS 注入规则
    exceptions [(positive, selector)]       #@# 例外
    hide_off   {domain: "generic"|"all"}    $generichide / $elemhide
    """
    rules, exceptions, hide_off = [], [], {}
    for text in texts:
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("!") or line.startswith("["):
                continue
            # 网络规则里的 $generichide / $elemhide
            match = re.match(r"^@@\|\|([a-z0-9.*-]+)\^?\$(.+)$", line)
            if match:
                options = set(match.group(2).split(","))
                if options & {"elemhide", "ehide"}:
                    hide_off[match.group(1)] = "all"
                elif options & {"generichide", "ghide"}:
                    hide_off.setdefault(match.group(1), "generic")
                continue
            index = line.find("#")
            if index == -1 or re.search(r"[/|^$]", line[:index]):
                continue
            domains, rest = line[:index], line[index:]
            marker = next((m for m in MARKERS if rest.startswith(m)), None)
            if not marker:
                continue
            body = rest[len(marker):].strip()
            if not body or EXTENDED.search(body):
                continue
            positive, negative = split_domains(domains)
            if marker in ("##", "#?#"):
                rules.append((positive, negative, body + "{display:none!important}"))
            elif marker == "#$#":
                if "{" in body and body.endswith("}") and "remove:" not in body:
                    rules.append((positive, negative, body))
            elif marker in ("#@#", "#@?#"):
                exceptions.append((positive, body + "{display:none!important}"))
    return rules, exceptions, hide_off


def compile_css(sites, rules, exceptions, hide_off):
    generic = []            # 所有网站共用的规则
    generic_index = {}
    specific = {site: [] for site in sites}
    skip = {site: set() for site in sites}

    for positive, negative, css in rules:
        if not positive:
            if css not in generic_index:
                generic_index[css] = len(generic)
                generic.append(css)
            for site in sites:
                if any(domain_matches(d, site) for d in negative):
                    skip[site].add(generic_index[css])
        else:
            for site in sites:
                if any(domain_matches(d, site) for d in positive) and not any(domain_matches(d, site) for d in negative):
                    if css not in specific[site]:
                        specific[site].append(css)

    for positive, css in exceptions:
        for site in sites:
            if positive and not any(domain_matches(d, site) for d in positive):
                continue
            if css in generic_index:
                skip[site].add(generic_index[css])
            if css in specific[site]:
                specific[site].remove(css)

    result = {}
    for site in sites:
        mode = next((v for d, v in hide_off.items() if domain_matches(d.replace("*", ""), site)), None)
        result[site] = {
            "css": "" if mode == "all" else "\n".join(specific[site]),
            "generic": mode is None,
            "skip": sorted(skip[site]),
        }
    return generic, result


def popup_blocker():
    text = POPUP_BLOCKER.read_text(encoding="utf-8")
    header, _, code = text.partition("// ==/UserScript==")
    excludes = []
    for match in re.finditer(r"^// @exclude\s+(\S+)", header, re.M):
        glob = match.group(1)
        excludes.append("^" + re.escape(glob).replace(r"\*", ".*") + "$")
    version = re.search(r"^// @version\s+(\S+)", header, re.M).group(1)
    return code.strip(), excludes, version


def js_regex_array(patterns):
    return "[" + ",".join("/" + p.replace("/", r"\/") + "/i" for p in patterns) + "]"


def build_payload(sites_css, generic, cleaners, popup_code, popup_excludes):
    page = (SRC / "page.js").read_text(encoding="utf-8")
    replacements = {
        "__SITES__": json.dumps(sites_css, ensure_ascii=False),
        "__GENERIC__": json.dumps(generic, ensure_ascii=False),
        "__POPUP_EXCLUDES__": js_regex_array(popup_excludes),
        "__CLEANERS__": "\n".join(cleaners),
        "__POPUP_BLOCKER__": popup_code,
    }
    for key, value in replacements.items():
        if page.count(key) != 1:
            sys.exit(f"page.js 里的占位符 {key} 应该正好出现一次")
        page = page.replace(key, value, 1)
    # 代码要放进 HTML 的 <script> 里，不能出现 </script；<!-- 在代码里出现会被当成 HTML 注释开头
    page = re.sub(r"</(script)", r"<\\/\1", page, flags=re.I)
    if "<!--" in page:
        sys.exit("网页代码里出现了 <!--，需要处理")
    return page


def build_module(sites):
    hosts = ", ".join(sites)
    alternation = "|".join(re.escape(s).replace("/", r"\/") for s in sites)
    static = "js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|json|mp4|m3u8|ts|webm|mp3|m4a|wasm|map|txt|xml"
    pattern = (
        rf"^https?:\/\/(?:{alternation})(?::\d+)?\/"
        rf"(?!(?:api|i\/api|graphql)\/|[^?#]*\.(?:{static})(?:[?#]|$))"
    )
    return f"""#!name=网页弹窗和广告拦截
#!desc=用 Safari 浏览网页时拦截弹窗、跳转广告、网页广告和跟踪；常用网站上再用脚本隐藏「打开 App」横幅和弹窗
#!category=AdBlock
#!arguments=弹窗广告:REJECT,网页广告:REJECT,秋风广告:REJECT,anti-AD:REJECT,网页脚本:网页脚本
#!arguments-desc=规则集：填 REJECT 拦截，填 DIRECT 关掉\\n\\n弹窗广告\\nHaGeZi Pop-Up Ads，约 5 万个弹窗、跳转广告域名\\n\\n网页广告\\nSukka 的 reject 规则集，合并 AdGuard、EasyPrivacy 等，约 13 万个域名\\n\\n秋风广告\\nAWAvenue 秋风广告规则，约一千条，偏 App 内广告 SDK\\n\\nanti-AD\\n约 10 万个域名，中文网站覆盖好\\n\\n网页脚本\\n在 rules/web-sites.txt 列出的网站上注入脚本：AdGuard 元素隐藏规则、X 弹窗清理、AdGuard Popup Blocker。填 # 关掉

# 由 tools/build_web.py 生成，不要手改。要改注入的网站，改 rules/web-sites.txt 再生成
# 规则集：HaGeZi dns-blocklists（GPL-3.0）、SukkaW/Surge（AGPL-3.0）、AWAvenue-Ads-Rule（GPL-3.0）、anti-AD（MIT）
# 网页脚本：AdGuard 过滤列表（GPL-3.0）、AdGuard Popup Blocker（LGPL-3.0），来源见 scripts/vendor/README.md
# 注意：iOS 上的 Surge 不能按 App 分流，规则集对所有 App 都生效

[Rule]
DOMAIN-SET,{RAW}rules/hagezi-popupads.txt,{{{{{{弹窗广告}}}}}},extended-matching
DOMAIN-SET,https://ruleset.skk.moe/List/domainset/reject.conf,{{{{{{网页广告}}}}}},extended-matching
RULE-SET,https://ruleset.skk.moe/List/non_ip/reject.conf,{{{{{{网页广告}}}}}},extended-matching
RULE-SET,https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-Surge-RULE-SET.list,{{{{{{秋风广告}}}}}},extended-matching
DOMAIN-SET,https://raw.githubusercontent.com/privacy-protection-tools/anti-AD/master/anti-ad-surge2.txt,{{{{{{anti-AD}}}}}},extended-matching

[URL Rewrite]
# 不让 X 注册 Service Worker，否则网页可能从缓存加载、绕过脚本注入
^https:\\/\\/(?:x|twitter|mobile\\.twitter)\\.com\\/sw\\.js - reject

[Script]
{{{{{{网页脚本}}}}}} = type=http-response,pattern={pattern},requires-body=1,max-size=3145728,timeout=10,script-path={RAW}scripts/web/inject.js

[MITM]
hostname = %APPEND% {hosts}
"""


def main():
    sites = read_sites()
    texts = [download(FILTER_URL.format(fid)) for fid in FILTERS]
    rules, exceptions, hide_off = parse_filters(texts)
    generic, sites_css = compile_css(sites, rules, exceptions, hide_off)
    cleaners = [p.read_text(encoding="utf-8") for p in sorted((SRC / "cleaners").glob("*.js"))]
    popup_code, popup_excludes, popup_version = popup_blocker()

    payload = build_payload(sites_css, generic, cleaners, popup_code, popup_excludes)
    surge = (SRC / "surge.js").read_text(encoding="utf-8")
    if surge.count("__PAYLOAD__") != 1:
        sys.exit("surge.js 里的 __PAYLOAD__ 应该正好出现一次")
    INJECT.write_text(
        "// 由 tools/build_web.py 生成，不要手改。源码在 scripts/web/src/\n"
        f"// 包含：AdGuard 过滤列表 {', '.join(str(i) for i in FILTERS)}（GPL-3.0），"
        f"AdGuard Popup Blocker {popup_version}（LGPL-3.0）\n"
        + surge.replace("__PAYLOAD__", json.dumps(payload, ensure_ascii=False), 1),
        encoding="utf-8",
    )
    MODULE.write_text(build_module(sites), encoding="utf-8")

    specific = sum(len(v["css"].splitlines()) for v in sites_css.values())
    print(f"{len(sites)} 个网站，通用规则 {len(generic)} 条，站点规则 {specific} 条，"
          f"Popup Blocker {popup_version}，inject.js {INJECT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
