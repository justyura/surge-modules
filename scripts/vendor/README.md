# 第三方脚本

这里的脚本是从上游复制过来的，模块只引用这里的版本。上游改了不会自动同步，要更新就重新复制，看一遍 diff 再提交。

| 目录 | 上游 | 许可证 | 复制自提交 |
| --- | --- | --- | --- |
| `kokoryh-Sparkle/` | [kokoryh/Sparkle](https://github.com/kokoryh/Sparkle) `dist/` | GPL-3.0 | `1bc5b545a544d7d59b1cf821785daddc3868e4a5`（2026-09-14） |
| `AdguardTeam-PopupBlocker/` | [AdguardTeam/PopupBlocker](https://github.com/AdguardTeam/PopupBlocker) 官方构建的 `popupblocker.user.js` 2.5.117 | LGPL-3.0 | `d05ebd36da54e86ba75df19565db80f1d510f591`（2026-09-17） |
| `gholts-surge/` | [gholts/surge](https://github.com/gholts/surge) `scripts/youtube/` 的 `request.js`、`response.js` | Apache-2.0（作者在模块里声明，基于 Maasea/sgmodule）；response.js 里打包的组件是 MIT | `4bccf6e63dbb200049e0e2e71d3d98c04e7d8073`（2026-09-21） |
| `fmz200-wool_scripts/` | [fmz200/wool_scripts](https://github.com/fmz200/wool_scripts) `Scripts/` | GPL-3.0 | `3ca7487b4e4b86d9af76e50df72c62eacfbb659e`（2026-09-10） |

每个目录里的 `LICENSE` 是上游的许可证原文。除了 `gholts-surge/response.js`，脚本内容都没有改过。

`gholts-surge/response.js` 加了两处本地改动，全部在 `gholts-surge/local.patch` 里：隐藏首页和搜索里的 Shorts 栏（`blockShorts` 原本只去掉底部标签），以及打开视频自动开字幕（`autoCaptions`）。

## 更新

```sh
git clone --depth 1 https://github.com/kokoryh/Sparkle /tmp/Sparkle
cp /tmp/Sparkle/dist/{bilibili.json.js,bilibili.protobuf.response.js,webpage.bilibili.js} scripts/vendor/kokoryh-Sparkle/


git clone --depth 1 https://github.com/fmz200/wool_scripts /tmp/wool_scripts
cp /tmp/wool_scripts/Scripts/{xiaohongshu/xiaohongshu.js,weibo/weibo_ads.js,weibo/weibo_main.js,zhihu/zhihu.js,xianyu/xianyu_ads.js,myBlockAds.js,jingdong/jingdong.js} scripts/vendor/fmz200-wool_scripts/

curl -o scripts/vendor/AdguardTeam-PopupBlocker/popupblocker.user.js https://userscripts.adtidy.org/release/popup-blocker/2.5/popupblocker.user.js
python3 tools/build_web.py && node tools/test_web.js   # Popup Blocker 更新后重新打包、测试

git clone --depth 1 https://github.com/gholts/surge /tmp/gholts
cp /tmp/gholts/scripts/youtube/{request.js,response.js} scripts/vendor/gholts-surge/
patch -p1 -d scripts/vendor/gholts-surge < scripts/vendor/gholts-surge/local.patch   # 打不上就手动改，再重新生成 local.patch

git diff scripts/vendor   # 看清楚改了什么再提交，顺手更新上面表格里的提交号
```

## 注意

- `bilibili.protobuf.response.js` 的 `sponsorBlock` 打开时，会把哔哩哔哩要下载的播放器插件包换成 kokoryh/chronos 仓库里的版本。`ads/bilibili.sgmodule` 里固定传的是 `false`，别改。
- Popup Blocker 不是直接加载的，由 `tools/build_web.py` 打包进 `scripts/web/inject.js`。原本依赖的用户脚本管理器接口换成了 localStorage 版本，字体资源不加载。

