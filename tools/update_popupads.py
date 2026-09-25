#!/usr/bin/env python3
"""把 HaGeZi 的弹窗广告列表转成 Surge DOMAIN-SET 格式。

HaGeZi 的 onlydomains 版本每行一个域名，默认要连子域名一起拦。
Surge 的 DOMAIN-SET 里域名前面要加 "." 才会匹配子域名，所以这里统一加上。

    python3 tools/update_popupads.py

GitHub Actions 每天跑一次（.github/workflows/update-web-rules.yml）。
"""
import sys
import urllib.request
from pathlib import Path

SOURCE = "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/popupads-onlydomains.txt"
OUT = Path(__file__).resolve().parent.parent / "rules" / "hagezi-popupads.txt"
MIN_ENTRIES = 10000  # 少于这个数多半是上游出问题了，不覆盖旧文件


def main():
    with urllib.request.urlopen(SOURCE, timeout=60) as response:
        text = response.read().decode("utf-8")

    header, domains = [], []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("#"):
            # 更新时间和版本号每次都变，去掉，免得内容没变也产生提交
            if not line.startswith(("# Last modified:", "# Version:", "# Expires:", "# Syntax:")):
                header.append(line)
            continue
        domains.append("." + line.lstrip("."))

    if len(domains) < MIN_ENTRIES:
        sys.exit(f"只拿到 {len(domains)} 条，可能是上游出错了，保留旧文件")

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(
        "\n".join([
            "# 由 tools/update_popupads.py 从 HaGeZi Pop-Up Ads 转换，别手改",
            f"# 来源: {SOURCE}",
            "# 格式: Surge DOMAIN-SET，前面带 . 表示连子域名一起拦",
            *header,
            *domains,
        ]) + "\n",
        encoding="utf-8",
    )
    print(f"{OUT.name}: {len(domains)} 条")


if __name__ == "__main__":
    main()
