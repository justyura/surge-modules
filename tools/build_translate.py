#!/usr/bin/env python3
"""把几个翻译模块合并成一个 translate.sgmodule（翻译合集），key 只用填一次。

各个模块（youtube-subtitles、reddit、x、github、stackoverflow、stackoverflow-web）照常维护，
改完跑：

    python3 tools/build_translate.py          # 生成
    python3 tools/build_translate.py --check  # 只检查 translate.sgmodule 是不是最新的，不是返回 1

生成的 translate.sgmodule 不要手改，下次生成会被覆盖。

合集里：
- 大模型密钥、DeepL密钥、模型、接口、目标语言、备用翻译、调试日志所有站点共用一份；
- 每个站点一个开关参数，默认是脚本名，填 # 关掉（脚本那一行变成注释）；
- 少数常改的站点参数单独列出来（见 SOURCES），其余参数用各模块自己的默认值写死。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "translate.sgmodule"
SECTIONS = ["Rule", "Script", "MITM"]

# (模块文件名, {模块里的脚本名: 合集里的开关参数}, {模块里的参数: 合集里的参数})
SOURCES = [
    ("youtube-subtitles", {"YouTube 双语字幕": "YouTube字幕", "{{{评论翻译}}}": "YouTube评论"},
     {"原文位置": "字幕原文位置", "最长等待": "字幕最长等待", "生词服务": "生词服务", "评论展开": "评论展开"}),
    ("reddit", {"Reddit": "Reddit"}, {}),
    ("x", {"X": "X"}, {"屏蔽中文": "X屏蔽中文", "白名单": "X白名单"}),
    ("github", {"GitHub 翻译": "GitHub"}, {}),
    ("stackoverflow", {"Stack Overflow 翻译": "StackOverflow"}, {}),
    ("stackoverflow-web", {"Stack Overflow 网页翻译": "StackOverflow网页", "Stack Overflow 网页翻译接口": "StackOverflow网页"}, {}),
]

# 所有站点共用的参数，按这个顺序排在最前面
SHARED = [
    ("大模型密钥", '"填你的OpenAI密钥，多个用竖线分隔"',
     "OpenAI 的 API key（sk-…），多个用 | 分隔，按顺序使用，出错自动换下一个。下面所有站点都用它，"
     "先用大模型结合上下文翻译，DeepL、Google 兜底"),
    ("DeepL密钥", '"可以不填，大模型来不及或用不了时兜底"',
     "DeepL API key，多个用 | 分隔。不填也行：大模型来不及或用不了时直接用 Google 兜底"),
    ("大模型", "gpt-4.1-mini", "模型名，默认 gpt-4.1-mini（便宜、快、不思考）。想再省可以填 gpt-4.1-nano；用别家接口就填那家的模型名"),
    ("大模型接口", '"https://api.openai.com/v1"', "默认 OpenAI 官方。DeepSeek、OpenRouter 之类兼容 OpenAI 的接口填它们的地址"),
    ("目标语言", "ZH-HANS", "ZH-HANS 简体中文，ZH-HANT 繁体中文，也可以填 EN-US、JA、KO 等"),
    ("备用翻译", "google", "- google：大模型和 DeepL 都不能用时改用 Google 翻译\n- off：不兜底，显示原文"),
    ("调试日志", "false", "true：在 Surge 日志里打印每个站点的请求、翻了几段、key 的切换情况"),
]

SWITCH_DESC = {
    "YouTube字幕": "YouTube 字幕变双语",
    "YouTube评论": "YouTube 评论区和回复加译文",
    "Reddit": "Reddit App：去推广，标题、正文、评论加译文",
    "X": "X App 和 x.com：去推广、屏蔽中文推文，外文推文加译文",
    "GitHub": "GitHub 官方 App：Issue、PR、讨论、README 加译文",
    "StackOverflow": "第三方 Stack Overflow App（Octostack 等）加译文",
    "StackOverflow网页": "Safari 里的 Stack Overflow 和 Stack Exchange 站点加译文",
}

EXTRA_DESC = {
    "字幕原文位置": "- top：原文在上，译文在下\n- bottom：译文在上，原文在下\n- only：只显示译文",
    "字幕最长等待": "YouTube 字幕最多等几秒。离截止 2.5 秒还没翻好的先用 DeepL / Google 顶上，重新打开字幕接着用大模型翻。YouTube 报「加载字幕时出错」就调小",
    "生词服务": "自己部署的 vox 生词服务地址，比如 http://192.168.1.2:8090。填了之后英文字幕里的生词会标中文释义",
    "评论展开": "true：YouTube 长评论直接显示全文；false：保持原样",
    "X屏蔽中文": "true：删掉 X 上的中文推文；false：只去广告和翻译",
    "X白名单": "X 上这些账号的推文不删，填 @ 后面的用户名，多个用 | 分隔",
}


def parse(path):
    meta, sections, current = {}, {}, None
    for line in path.read_text(encoding="utf-8").splitlines():
        if current is None and line.startswith("#!"):
            key, _, value = line[2:].partition("=")
            meta[key] = value
            continue
        header = re.fullmatch(r"\[(.+)\]", line.strip())
        if header:
            current = header.group(1)
            if current not in SECTIONS:
                raise SystemExit(f"{path.name}: 不认识的段落 [{current}]")
            sections.setdefault(current, [])
            continue
        if current and line.strip() and not line.startswith("#"):
            sections[current].append(line)
    args = dict(re.findall(r'([^:,]+):("[^"]*"|[^,]*)', meta.get("arguments", "")))
    return meta, sections, args


def main():
    rules, scripts, hosts = [], [], []
    extra = []        # (合集参数名, 默认值)
    switches = []     # (开关参数名, 默认值)
    for name, names, exposed in SOURCES:
        path = ROOT / f"{name}.sgmodule"
        meta, sections, args = parse(path)
        rules += [r for r in sections.get("Rule", []) if r not in rules]
        for line in sections.get("Script", []):
            script, sep, rest = line.partition(" = ")
            if not sep or script not in names:
                raise SystemExit(f"{path.name}: 脚本「{script}」没在 SOURCES 里配开关")
            switch = names[script]
            first = next(s for s, w in names.items() if w == switch)
            if script == first:
                # 默认值就是脚本名，去掉空格：参数值里有空格要加引号，引号可能被原样带进脚本名
                default = script.replace(" ", "") if not script.startswith("{{{") else "YouTube评论翻译"
                switches.append((switch, default))
                script = "{{{" + switch + "}}}"
            else:
                script = "{{{" + switch + "}}}" + script.removeprefix(first)

            def sub(m):
                param = m.group(1)
                if any(param == s for s, _, _ in SHARED):
                    return m.group(0)
                if param in exposed:
                    if all(e != exposed[param] for e, _ in extra):
                        extra.append((exposed[param], args[param]))
                    return "{{{" + exposed[param] + "}}}"
                if param not in args:
                    raise SystemExit(f"{path.name}: 参数「{param}」没有默认值")
                return args[param].strip('"')
            scripts.append(f"{script} = " + re.sub(r"\{\{\{(.+?)\}\}\}", sub, rest))
        for line in sections.get("MITM", []):
            m = re.fullmatch(r"hostname\s*=\s*%APPEND%\s*(.+)", line.strip())
            if not m:
                raise SystemExit(f"{path.name}: 看不懂的 MITM 行：{line}")
            hosts += [h.strip() for h in m.group(1).split(",") if h.strip() not in hosts]

    params = [(n, d) for n, d, _ in SHARED] + switches + extra
    names = {n for n, _ in params}
    for line in scripts:
        for p in re.findall(r"\{\{\{(.+?)\}\}\}", line):
            assert p in names, f"参数「{p}」没在合集的参数里"

    desc = [f"{n}\\n{d}" for n, _, d in SHARED]
    desc += [f"{n}\\n{SWITCH_DESC[n]}。填 # 关掉" for n, _ in switches]
    desc += [f"{n}\\n{EXTRA_DESC[n]}" for n, _ in extra]
    out = [
        "#!name=翻译合集",
        "#!desc=YouTube 字幕和评论、Reddit、X、GitHub、Stack Overflow 一起翻译，只用填一个 OpenAI key："
        "大模型结合上下文翻，DeepL / Google 兜底。每个站点可以单独关",
        "#!category=Enhancement",
        "#!arguments=" + ",".join(f"{n}:{d}" for n, d in params),
        "#!arguments-desc=" + "\\n\\n".join(d.replace("\n", "\\n") for d in desc),
        "",
        "# 由 tools/build_translate.py 从 " + "、".join(f"{n}.sgmodule" for n, _, _ in SOURCES) + " 生成，不要手改。",
        "# 装了这个就别再装上面那几个单独的翻译模块，同一个请求会被处理两次。",
        "# 某个站点填 # 只是不跑脚本，MITM 的域名还在；完全不想解密某个站点就别用合集，装单独的模块",
    ]
    if rules:
        out += ["", "[Rule]"] + rules
    out += ["", "[Script]"] + scripts
    out += ["", "[MITM]", "hostname = %APPEND% " + ", ".join(hosts), ""]
    text = "\n".join(out)
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            raise SystemExit("translate.sgmodule 不是最新的，跑一下 python3 tools/build_translate.py")
        print("translate.sgmodule 是最新的")
        return
    OUT.write_text(text, encoding="utf-8")
    print(f"生成 {OUT.name}：{len(switches)} 个站点开关、{len(scripts)} 个脚本、{len(hosts)} 个 MITM 域名")


if __name__ == "__main__":
    main()
