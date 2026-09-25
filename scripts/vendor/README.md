# 第三方脚本

这里的脚本是从上游复制过来的，模块只引用这里的版本。上游改了不会自动同步，要更新就重新复制，看一遍 diff 再提交。

| 目录 | 上游 | 许可证 | 复制自提交 |
| --- | --- | --- | --- |
| `kokoryh-Sparkle/` | [kokoryh/Sparkle](https://github.com/kokoryh/Sparkle) `dist/` | GPL-3.0 | `1bc5b545a544d7d59b1cf821785daddc3868e4a5`（2026-09-14） |
| `Maasea-sgmodule/` | [Maasea/sgmodule](https://github.com/Maasea/sgmodule) `Script/Youtube/` | Apache-2.0 | `65075cdb388fc5e3094afd7e7314c67b243f3525`（2026-07-19） |
| `fmz200-wool_scripts/` | [fmz200/wool_scripts](https://github.com/fmz200/wool_scripts) `Scripts/` | GPL-3.0 | `3ca7487b4e4b86d9af76e50df72c62eacfbb659e`（2026-09-10） |

每个目录里的 `LICENSE` 是上游的许可证原文。脚本内容没有改过。

## 更新

```sh
git clone --depth 1 https://github.com/kokoryh/Sparkle /tmp/Sparkle
cp /tmp/Sparkle/dist/{bilibili.json.js,bilibili.protobuf.response.js,webpage.bilibili.js} scripts/vendor/kokoryh-Sparkle/

git clone --depth 1 https://github.com/Maasea/sgmodule /tmp/sgmodule
cp /tmp/sgmodule/Script/Youtube/youtube.response.js scripts/vendor/Maasea-sgmodule/

git clone --depth 1 https://github.com/fmz200/wool_scripts /tmp/wool_scripts
cp /tmp/wool_scripts/Scripts/{xiaohongshu/xiaohongshu.js,weibo/weibo_ads.js,weibo/weibo_main.js,zhihu/zhihu.js,xianyu/xianyu_ads.js,myBlockAds.js,jingdong/jingdong.js} scripts/vendor/fmz200-wool_scripts/

git diff scripts/vendor   # 看清楚改了什么再提交，顺手更新上面表格里的提交号
```

## 注意

- `bilibili.protobuf.response.js` 的 `sponsorBlock` 打开时，会把哔哩哔哩要下载的播放器插件包换成 kokoryh/chronos 仓库里的版本。`ads/bilibili.sgmodule` 里固定传的是 `false`，别改。
- Maasea 的 `youtube.request.js` 没有复制：它会把 YouTube 播放请求重定向到作者自己的 Cloudflare Worker。
