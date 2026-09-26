# surge-modules

自己用的 Surge 模块。

## 模块列表

| 模块 | 作用 | 安装链接 |
| --- | --- | --- |
| 代理流量面板 | 在面板里显示剩余流量、已用比例、到期日期和重置时间 | `https://raw.githubusercontent.com/justyura/surge-modules/main/usage-pane.sgmodule` |
| App 去广告合集 | 15 个常用 App 的开屏和 App 内广告，一个模块全包 | `https://raw.githubusercontent.com/justyura/surge-modules/main/adblock.sgmodule` |
| 网页弹窗和广告拦截 | Safari 里的弹窗、跳转广告、网页广告和跟踪，常用网站上的「打开 App」弹窗 | `https://raw.githubusercontent.com/justyura/surge-modules/main/web-popups.sgmodule` |
| 搜索引擎重定向 | 用 Google、Kagi、DuckDuckGo 等搜索时直接跳到自建搜索引擎 | `https://raw.githubusercontent.com/justyura/surge-modules/main/search-redirect.sgmodule` |
| YouTube 双语字幕 | YouTube 字幕加 DeepL 翻译，多个 key 自动切换，Apple TV 也能装 | `https://raw.githubusercontent.com/justyura/surge-modules/main/youtube-subtitles.sgmodule` |

## 代理流量面板

### 安装

1. Surge → 模块 → 安装新模块，粘贴上面的安装链接。
2. 在模块参数里填 `URL`：你的流量查询接口完整地址。
3. 回到首页，面板点一下就会刷新，之后每小时自动更新。

`URL` 只保存在本机的 Surge 配置里，不会进仓库。

### 接口要求

接口返回 JSON，字段可以直接放在顶层，也可以包在 `data` 里。`ok: false` 视为出错。

| 字段 | 说明 |
| --- | --- |
| `name` | 面板标题，没有就显示「代理流量」 |
| `limit_gib` / `limit_bytes` | 总流量 |
| `bill_gib` / `bill_bytes` | 已用流量 |
| `left_gib` | 剩余流量，没有就用总量减已用 |
| `used_pct` | 已用百分比，没有就自己算 |
| `expires_at` | 到期时间，如 `2026-12-01` 或 `2026-12-01 00:00:00` |
| `next_reset_at` | 下次重置时间 |
| `reset_days_left` | 距离重置的天数 |
| `status` | `enabled` 显示「正常」，其它原样显示 |
| `updated_at` | 数据更新时间 |

示例：

```json
{
  "ok": true,
  "data": {
    "name": "My Proxy",
    "limit_gib": 100,
    "bill_gib": 42.5,
    "expires_at": "2026-12-01 00:00:00",
    "next_reset_at": "2026-10-01",
    "reset_days_left": 7,
    "status": "enabled",
    "updated_at": "2026-09-24 12:00"
  }
}
```

### 颜色

- 绿色：用了不到 75%
- 橙色：75% 到 90%
- 红色：90% 以上，或者请求失败

## App 去广告合集

一个链接装完：

```
https://raw.githubusercontent.com/justyura/surge-modules/main/adblock.sgmodule
```

### 覆盖范围

| App | 去掉什么 |
| --- | --- |
| 哔哩哔哩 | 开屏、首页推荐、动态、视频页、评论区、直播、搜索 |
| YouTube | 首页、搜索、播放页、Shorts 里的广告，片头和中途插播广告；YouTube Music、Apple TV 也管 |
| 抖音 | 只能拦广告投放和素材域名，信息流广告去不掉 |
| 小红书 | 开屏、首页和关注页信息流、搜索页、详情页 |
| Twitter / X | 只能拦广告和统计域名，时间线里的推广帖目前没有可用规则 |
| 微博 | 开屏、信息流、热搜、发现页、超话、详情页、评论区，含轻享版 |
| 知乎 | 开屏、首页推荐、热榜、回答页、评论区、搜索页、会员页 |
| 微信 | 只能去公众号文章底部广告和商品推广 |
| 淘宝 | 开屏、首页二楼、弹窗、各类广告接口 |
| 闲鱼 | 开屏、首页信息流、同城页、搜索页、消息页、我的页面 |
| 京东 | 开屏、首页悬浮和通栏推广、我的页面、订单页、直播小窗 |
| 拼多多 | 开屏、首页弹窗、快递页红包商品 |
| 美团 / 美团外卖 | 外卖开屏和广告素材；美团主 App 只能拦广告和统计域名 |
| 饿了么 | 开屏图片和视频、广告和统计域名 |
| 高德地图 | 开屏、启动广告、增值推广、广告和统计域名 |

抖音和微信的广告走它们自己的加密协议，MITM 解不开，所以只能做到上面这些。美团主 App 和 Twitter 的推广帖目前找不到靠谱的规则。

### 安装

1. Surge 里进 MITM，生成证书并安装，再去 iOS 设置 → 通用 → 关于本机 → 证书信任设置里打开信任，最后打开 MITM。
2. 安装上面的链接。
3. 把 App 从后台划掉再打开。还有广告就清一下 App 缓存，或者删了重装。

哔哩哔哩有几个参数可以调：动态最常访问、创作中心、过滤置顶评论广告、日志等级，在模块参数里改。

某个 App 用着有问题，想单独关掉它：先卸载合集，再从 `ads/` 里挑需要的单个模块装，每个文件都能单独用。

### Apple TV 上用

电视上只装 YouTube 这一个就行，不用装整个合集：

```
https://raw.githubusercontent.com/justyura/surge-modules/main/ads/youtube.sgmodule
```

1. Apple TV 的 Surge 里打开 MITM，生成并安装证书，再到 Apple TV 的 设置 → 通用 → 关于本机 → 证书信任设置 里打开信任。
2. 装上面的模块。
3. 彻底退出 YouTube 再打开，看几个视频。

能去的：首页和搜索里的广告、片头广告、播放中途插播的广告、广告统计请求。

- Apple TV 上的 Surge 只有 JavaScriptCore，没有 `TextEncoder` / `TextDecoder`。去广告脚本自带补丁，已经在没有这两个的环境里跑过，能正常执行。
- Apple TV 版 YouTube 的接口我没法实测。YouTube 经常改服务端，有人反馈 MITM 去广告会间歇失效。还有广告的话告诉我是哪种（片头、中途、首页），我再对着改。

### 怎么维护

- 规则按 App 分开放在 `ads/`，改哪个 App 就改哪个文件。
- 改完跑 `python3 tools/build.py`，重新生成 `adblock.sgmodule`，两个一起提交。`adblock.sgmodule` 不要手改。
- 新加 App：在 `ads/` 里放一个新文件，再跑一次生成。

### 脚本放在哪

用到的脚本都存了一份在本仓库 `scripts/vendor/`，不直接引用别人的仓库。上游改了什么不会悄悄跑到手机上；代价是要手动更新，步骤见 [scripts/vendor/README.md](scripts/vendor/README.md)。

### 来源

- [kokoryh/Sparkle](https://github.com/kokoryh/Sparkle)（GPL-3.0）：哔哩哔哩
- [Maasea/sgmodule](https://github.com/Maasea/sgmodule)（Apache-2.0）：YouTube。只用了处理响应的脚本；它的 request 脚本会把播放请求转到作者的 Cloudflare Worker，没用
- [fmz200/wool_scripts](https://github.com/fmz200/wool_scripts)（GPL-3.0）：其他所有 App，以及 YouTube 片头广告

规则基本照搬上游，去掉了跟去广告无关的部分：去水印、解除下载限制、换皮肤、解锁会员图标、外链跳转、P2P 屏蔽、空降助手。

### 失效了怎么办

App 更新后接口会变。先去上游看有没有新规则，有的话改 `ads/` 里对应的文件、重新复制脚本、跑一次生成。

## 网页弹窗和广告拦截

给手机上用 Safari 浏览网页准备的，和 App 去广告合集分开装：

```
https://raw.githubusercontent.com/justyura/surge-modules/main/web-popups.sgmodule
```

分两层：

1. **按域名拦**：四个规则集，不用 MITM，所有网站都管。
2. **脚本级别**：在常用网站上往网页里注入脚本，处理按域名拦不掉的东西，比如 x.com 的「Get the full app experience」弹窗、「打开 App」横幅、点一下就弹新窗口的广告。

### 开关

在模块参数里改。规则集填 `REJECT` 拦截、`DIRECT` 关掉；网页脚本填 `#` 关掉。

| 参数 | 内容 |
| --- | --- |
| 弹窗广告 | [HaGeZi Pop-Up Ads](https://github.com/hagezi/dns-blocklists)，约 5 万个弹窗、跳转广告域名 |
| 网页广告 | [Sukka 的 reject 规则集](https://ruleset.skk.moe)，合并 AdGuard、EasyPrivacy 等，约 13 万个域名 |
| 秋风广告 | [AWAvenue 秋风广告规则](https://github.com/TG-Twilight/AWAvenue-Ads-Rule)，约一千条，偏 App 内广告 SDK |
| anti-AD | [anti-AD](https://github.com/privacy-protection-tools/anti-AD)，约 10 万个域名，中文网站覆盖好 |
| 网页脚本 | 在下面这些网站上注入脚本 |

### 网页脚本做了什么

只在 `rules/web-sites.txt` 列出的网站上生效，默认有：X / Twitter、Reddit、知乎、微博、哔哩哔哩、小红书、豆瓣、贴吧、简书、CSDN。这些网站要开 MITM。

注入的脚本包含三部分：

| 部分 | 来源 | 作用 |
| --- | --- | --- |
| 元素隐藏 | AdGuard 的弹窗、App 横幅、其他烦人元素、中文过滤列表（GPL-3.0） | 隐藏网页里的「打开 App」横幅、遮罩、登录提示，和 AdGuard / Wipr 这类 Safari 内容拦截器做的事一样 |
| 站点清理 | 本仓库 `scripts/web/src/cleaners/` | 过滤列表管不到的，比如 x.com 的「Get the full app experience」弹窗，藏掉并恢复页面滚动 |
| Popup Blocker | [AdGuard Popup Blocker](https://github.com/AdguardTeam/PopupBlocker)（LGPL-3.0） | 拦截点一下就弹出新窗口、新标签页的广告，和 Userscripts + Popup Blocker 做的事一样 |

加网站：在 `rules/web-sites.txt` 加一行完整域名，跑 `python3 tools/build_web.py`，提交。

### 需要知道的

- iOS 上的 Surge 不能只对 Safari 生效，规则集对所有 App 都起作用。某个 App 出问题，先把「网页广告」「anti-AD」改成 `DIRECT` 试试。
- 网页脚本要对列出的网站做 MITM，这些网站的流量会在手机上被 Surge 解密。
- 第一次装好后，在 Safari 设置里清一下 x.com 的网站数据，把旧的 Service Worker 清掉。
- AdGuard 规则里需要它自家扩展才能跑的高级语法（`:has-text` 之类、scriptlet）用不了，只用了浏览器原生 CSS 能做到的部分。
- 规则集和 AdGuard 过滤规则每天由 GitHub Actions 自动更新（`.github/workflows/update-web-rules.yml`）。Popup Blocker 和清理脚本是代码，不自动更新。

### 还想更彻底

这些是 App，装不进 Surge 模块，可以和本模块一起用：

- **AdGuard（免费）/ Wipr / 1Blocker**：Safari 内容拦截器，对所有网站生效，不用 MITM。本模块的元素隐藏只管列出的网站。
- **Userscripts + AdGuard Popup Blocker**：同样对所有网站生效。本模块的 Popup Blocker 也只管列出的网站。

### 维护

- 改注入的网站：`rules/web-sites.txt`，然后 `python3 tools/build_web.py`
- 改清理脚本：`scripts/web/src/`，然后 `python3 tools/build_web.py`
- 测试：`node tools/test_web.js`，用 Playwright 模拟 iPhone Safari，在本地拼的页面上检查弹窗、CSP、Popup Blocker 是否正常
- `web-popups.sgmodule` 和 `scripts/web/inject.js` 是生成的，不要手改

### 调研过的方案

| 方案 | 做法 | 在本模块里 |
| --- | --- | --- |
| HaGeZi dns-blocklists | 按域名拦，有专门的弹窗列表 | 「弹窗广告」 |
| SukkaW/Surge | 专为 Surge 生成的规则集 | 「网页广告」 |
| AWAvenue 秋风广告规则 | 按域名拦，小而精 | 「秋风广告」 |
| anti-AD | 按域名拦，中文区覆盖好 | 「anti-AD」 |
| AdGuard 过滤列表 | Safari 内容拦截器用的元素隐藏规则 | 「网页脚本」的元素隐藏 |
| AdGuard Popup Blocker | 用户脚本，拦 JS 弹出的新窗口 | 「网页脚本」的 Popup Blocker |
| Adblock4limbo | MITM 四百多个站点注入 JS，主要针对影视站 | 没用，范围太大 |

## 搜索引擎重定向

```
https://raw.githubusercontent.com/justyura/surge-modules/main/search-redirect.sgmodule
```

在 Safari 地址栏搜索，或者打开这些搜索引擎的结果页时，直接 302 跳到 `https://search.wtyura.com/search?q=搜索词`。

支持：Google（含各国域名）、Kagi、DuckDuckGo、Bing、Yahoo、Brave Search、Ecosia、Startpage、Yandex、百度、搜狗、360 搜索。

- 只跳搜索结果页。搜索建议、首页、地图、账号页都不动。
- 要开 MITM，上面这些搜索引擎的域名会被解密。
- 换成别的搜索地址：把模块里的 `https://search.wtyura.com/search?q=` 全部换掉。
- 想临时用回原来的搜索引擎，在 Surge 里关掉这个模块。

## YouTube 双语字幕

```
https://raw.githubusercontent.com/justyura/surge-modules/main/youtube-subtitles.sgmodule
```

YouTube 字幕下面加一行 DeepL 翻译。脚本是自己写的：`scripts/youtube-subtitles.js`。

### 用法

1. 装模块，在参数「DeepL密钥」里填 key，多个用 `|` 分隔，比如 `key1:fx|key2:fx|key3:fx`。
2. 在 YouTube 里打开原文字幕（比如英文），就会变成双语。
3. YouTube 自带的「自动翻译」字幕和本来就是中文的字幕不会再翻。

### 多个 key 怎么切换

按填写顺序用，上次成功的 key 优先。某个 key 出错就马上换下一个，并按错误暂停它：

| 情况 | 暂停多久 |
| --- | --- |
| 403 key 无效 | 7 天 |
| 456 额度用完 | 24 小时后再试 |
| 429 请求太多 | 1 分钟 |
| 5xx 服务器出错 | 5 分钟 |
| 网络错误 | 不暂停，直接换下一个 |

所有 key 都不能用时，默认用 Google 翻译兜底；Google 也不行就保持原字幕，不影响播放。

长视频（比如一两个小时的播客）有几千句字幕：
- 几十句打包成一段发给 DeepL，一次请求能翻上千句，3 个请求同时跑，一般几秒内翻完。
- 超过「最长等待」（默认 8 秒）就先返回翻好的部分，没翻完的显示原文；翻好的会缓存，关掉字幕再打开会接着翻。
- 任何情况下超时 3 秒以上都会原样返回字幕，不会让 YouTube 报「加载字幕时出错」。

另外：
- 以 `:fx` 结尾的 Free key 走 `api-free.deepl.com`，其他当 Pro key 走 `api.deepl.com`。
- 同一个视频的翻译会缓存（最近 3 个视频），拖进度条、重新打开字幕不重复花额度。
- 状态里只存 key 的指纹，不存明文。
- 打开「调试日志」可以在 Surge 日志里看到每次请求和 key 的切换。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| DeepL密钥 | 占位文字 | 一个或多个 key，用 `\|` 分隔 |
| 目标语言 | ZH-HANS | ZH-HANT 繁体，也可以填 EN-US、JA、KO 等 |
| 原文位置 | top | top 原文在上；bottom 译文在上；only 只显示译文 |
| 备用翻译 | google | off 表示不用 Google 兜底 |
| 最长等待 | 8 | 最多等几秒，到时间先显示翻好的部分 |
| 调试日志 | false | true 打印详细日志 |

### Apple TV

脚本改的是 YouTube 下发的字幕文件，不改播放器，理论上 iPhone、iPad、Apple TV 的 YouTube App 都适用。但 Apple TV 我没法实测，需要你确认两件事：

1. Apple TV 上的 Surge 要能 MITM：Surge 的 CA 证书要装到 Apple TV 上并信任，MITM 开关打开。
2. Apple TV 版 YouTube 的字幕也是走 `/api/timedtext`：把「调试日志」改成 `true`，放一个开了英文字幕的视频，看 Surge 的请求记录或日志里有没有 `timedtext`。有就能用；没有的话把请求记录里和字幕相关的地址发我，我再适配。

### 其他

- 支持 YouTube 的三种字幕格式：json3、srv3 / srv1 XML、WebVTT。自动生成字幕会把逐词的片段合成整句再翻。
- 测试：`node tools/test_subtitles.js`，模拟 Surge 和 DeepL / Google 接口，覆盖 key 切换、暂停、兜底、缓存、分批和三种字幕格式。
- DeepL 的条款是一人一个免费账号，多个免费账号轮着用超出额度违反条款，账号可能被封，自己把握。

## 规矩

- 地址、token、订阅链接一律走 `#!arguments`，不写死在模块里。
- 新增模块时，在上面的表格里加一行，再补一节说明。
- 去广告规则改 `ads/`，改完跑 `python3 tools/build.py`。
