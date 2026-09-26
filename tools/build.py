#!/usr/bin/env python3
"""把 ads/*.sgmodule 合并成一个 adblock.sgmodule。

改规则时只改 ads/ 里对应 App 的文件，然后跑：

    python3 tools/build.py

生成的 adblock.sgmodule 不要手改，下次生成会被覆盖。
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "ads"
OUT = ROOT / "adblock.sgmodule"

# YouTube 的 response 脚本在 Apple TV 上缺 TextEncoder/TextDecoder，打包时在前面补上
YT_VENDOR = ROOT / "scripts" / "vendor" / "gholts-surge" / "response.js"
YT_COMPAT = ROOT / "scripts" / "compat" / "text-codec.js"
YT_OUT = ROOT / "scripts" / "youtube-ads" / "response.js"

# 合并顺序，没列出的 App 按文件名排在最后
ORDER = [
    "bilibili", "youtube", "douyin", "xiaohongshu", "twitter", "weibo", "zhihu", "wechat",
    "taobao", "xianyu", "jd", "pinduoduo", "meituan", "eleme", "amap",
]
SECTIONS = ["Rule", "URL Rewrite", "Body Rewrite", "Map Local", "Script", "MITM"]


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
        if current and line.strip():
            sections[current].append(line)
    return meta, sections


def build_youtube():
    YT_OUT.parent.mkdir(exist_ok=True)
    YT_OUT.write_text(
        "// 由 tools/build.py 生成，不要手改：scripts/compat/text-codec.js + scripts/vendor/gholts-surge/response.js\n"
        + YT_COMPAT.read_text(encoding="utf-8") + "\n"
        + YT_VENDOR.read_text(encoding="utf-8"),
        encoding="utf-8",
    )


def main():
    build_youtube()
    files = sorted(SRC.glob("*.sgmodule"),
                   key=lambda p: (ORDER.index(p.stem) if p.stem in ORDER else len(ORDER), p.stem))
    apps = [(p.stem, *parse(p)) for p in files]

    names = [meta["name"].removesuffix("去广告") for _, meta, _ in apps]
    arguments = [meta["arguments"] for _, meta, _ in apps if meta.get("arguments")]
    arguments_desc = [meta["arguments-desc"] for _, meta, _ in apps if meta.get("arguments-desc")]

    out = [
        "#!name=App 去广告合集",
        "#!desc=" + "、".join(names) + "。开屏和 App 内的广告、推广一起去",
        "#!category=AdBlock",
    ]
    if arguments:
        out.append("#!arguments=" + ",".join(arguments))
    if arguments_desc:
        out.append("#!arguments-desc=" + "\\n\\n".join(arguments_desc))
    out += [
        "",
        "# 由 tools/build.py 从 ads/ 生成，不要手改",
        "# 脚本都在本仓库 scripts/vendor/，来源和许可证见 scripts/vendor/README.md",
    ]

    script_names, hosts = set(), []
    for section in SECTIONS:
        if section == "MITM":
            for _, _, sections in apps:
                for line in sections.get("MITM", []):
                    match = re.match(r"hostname\s*=\s*%APPEND%\s*(.+)", line)
                    if not match:
                        continue
                    for host in (h.strip() for h in match.group(1).split(",")):
                        if host and host not in hosts:
                            hosts.append(host)
            out += ["", "[MITM]", "hostname = %APPEND% " + ", ".join(hosts)]
            continue

        blocks = []
        for (stem, meta, sections), name in zip(apps, names):
            lines = sections.get(section, [])
            if not any(not l.startswith("#") for l in lines):
                continue
            if section == "Script":
                # 同一个模块里脚本名不能重复
                renamed = []
                for line in lines:
                    if not line.startswith("#") and "=" in line:
                        script, rest = line.split("=", 1)
                        script = script.strip()
                        base, n = script, 2
                        while script in script_names:
                            script, n = f"{base}{n}", n + 1
                        script_names.add(script)
                        line = f"{script} ={rest}"
                    renamed.append(line)
                lines = renamed
            blocks.append([f"# ---- {name} ----", *lines])
        if blocks:
            out += ["", f"[{section}]"]
            for i, block in enumerate(blocks):
                if i:
                    out.append("")
                out += block

    OUT.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)}: {len(apps)} 个 App，{len(hosts)} 个 MITM 域名")


if __name__ == "__main__":
    main()
