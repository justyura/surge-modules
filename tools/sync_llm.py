#!/usr/bin/env python3
"""把 scripts/lib/llm.js 同步进各个翻译脚本。

大模型那一段（从「// ---------- 大模型：」到「// ---------- 大模型结束 ----------」）在几个脚本里一模一样，
Surge 脚本不能互相引用，只能各放一份。改的时候只改 scripts/lib/llm.js，然后跑：

    python3 tools/sync_llm.py          # 同步
    python3 tools/sync_llm.py --check  # 只检查有没有不一致，不一致返回 1
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIB = ROOT / "scripts" / "lib" / "llm.js"
SCRIPTS = ["youtube-subtitles", "reddit", "x", "github", "stackoverflow", "stackoverflow-web"]
BEGIN = "// ---------- 大模型：OpenAI 或兼容 OpenAI 的接口 ----------\n"
END = "// ---------- 大模型结束 ----------\n"


def main():
    check = "--check" in sys.argv
    block = LIB.read_text(encoding="utf-8")
    assert block.startswith(BEGIN) and block.endswith(END), "scripts/lib/llm.js 的开头和结尾标记不对"
    stale = []
    for name in SCRIPTS:
        path = ROOT / "scripts" / f"{name}.js"
        text = path.read_text(encoding="utf-8")
        start, end = text.find(BEGIN), text.find(END)
        if start == -1 or end == -1:
            raise SystemExit(f"{path.name}: 没找到大模型那一段的标记")
        new = text[:start] + block + text[end + len(END):]
        if new != text:
            stale.append(path.name)
            if not check:
                path.write_text(new, encoding="utf-8")
    if check and stale:
        raise SystemExit("这些脚本里的大模型代码和 scripts/lib/llm.js 不一致，跑一下 python3 tools/sync_llm.py：" + "、".join(stale))
    print("已同步：" + "、".join(stale) if stale and not check else "大模型代码都和 scripts/lib/llm.js 一样")


if __name__ == "__main__":
    main()
