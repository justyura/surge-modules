# surge-modules

自己用的 Surge 模块。

## 模块列表

| 模块 | 作用 | 安装链接 |
| --- | --- | --- |
| 代理流量面板 | 在面板里显示剩余流量、已用比例、到期日期和重置时间 | `https://raw.githubusercontent.com/justyura/surge-modules/main/usage-pane.sgmodule` |
| 订阅流量面板 | 填机场订阅链接，显示剩余流量、已用比例和到期日期 | `https://raw.githubusercontent.com/justyura/surge-modules/main/sub-usage.sgmodule` |
| AdGuard Home 面板 | 在面板里显示自建 AdGuard Home 的防护状态、24 小时查询和拦截数，可以点一下暂停 / 恢复防护 | `https://raw.githubusercontent.com/justyura/surge-modules/main/adguard-home.sgmodule` |
| App 去广告合集 | 15 个常用 App 的开屏和 App 内广告，一个模块全包 | `https://raw.githubusercontent.com/justyura/surge-modules/main/adblock.sgmodule` |
| 网页弹窗和广告拦截 | Safari 里的弹窗、跳转广告、网页广告和跟踪，常用网站上的「打开 App」弹窗 | `https://raw.githubusercontent.com/justyura/surge-modules/main/web-popups.sgmodule` |
| 搜索引擎重定向 | 用 Google、Kagi、DuckDuckGo 等搜索时直接跳到自建搜索引擎 | `https://raw.githubusercontent.com/justyura/surge-modules/main/search-redirect.sgmodule` |
| 翻译合集 | YouTube 字幕和评论、Reddit、X、GitHub、Stack Overflow 的翻译，只填一个 OpenAI key：大模型结合上下文翻，DeepL / Google 兜底，每个站点可以单独关；Reddit、X 顺带去推广，X 可以屏蔽中文推文 | `https://raw.githubusercontent.com/justyura/surge-modules/main/translate.sgmodule` |

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

## 订阅流量面板

```
https://raw.githubusercontent.com/justyura/surge-modules/main/sub-usage.sgmodule
```

机场的订阅链接（Surge / Clash 用的那个）返回时，响应头里带着 `subscription-userinfo: upload=…; download=…; total=…; expire=…`。这个面板只读这一行，订阅内容本身不看、不改你的配置。

1. 装模块，在参数「订阅链接」里填订阅地址，「名称」是面板标题（订阅自己返回了名字就用它）。
2. 首页的面板点一下刷新，之后每小时自动更新。

显示出来大概是这样：

```
剩余 62.29 GiB / 100.00 GiB
已用 37.71 GiB · 37.7%（上传 20.49 · 下载 17.21）
到期 2026-11-01 · 12 天
更新 21:57
```

- 颜色：用了 75% 以上橙色，90% 以上红色；一周内到期也是橙色。
- 订阅链接只存在本机的模块参数里，不进仓库。请求时带 `Surge iOS` 的 UA，有的机场只给代理客户端返回流量信息。
- 和「代理流量面板」用的是同一个脚本 `usage-pane.js`，可以同时装：那个填流量查询接口（JSON），这个填订阅链接。
- 测试：`node tools/test_usage_pane.js`。

## AdGuard Home 面板

```
https://raw.githubusercontent.com/justyura/surge-modules/main/adguard-home.sgmodule
```

在 Surge 首页显示自建 AdGuard Home 的情况，用的是 AdGuard Home 自己的接口（`/control/status`、`/control/stats`、`/control/protection`），不用 MITM。脚本是自己写的：`scripts/adguard-home.js`。

面板上有：

- 标题：防护中 / 已暂停（还剩几分钟）/ 防护已关闭
- 过去 24 小时的查询数、拦截数和拦截比例
- 平均响应时间
- 拦截最多的两个域名
- AdGuard Home 版本

每 30 分钟自动刷新一次。

### 安装

1. Surge → 模块 → 安装新模块，粘贴上面的链接。
2. 在模块参数里填 `地址`（网页后台的地址，比如 `https://adguard.example.com`）、`用户名`、`密码`。
3. 想点一下就暂停防护，把 `点击` 改成 `pause`。一次暂停几分钟看 `暂停分钟`，到时间 AdGuard Home 自己恢复，暂停中再点一下马上恢复。

地址和账号只保存在本机的 Surge 配置里，不会进仓库。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 地址 | 占位文字 | AdGuard Home 网页后台的地址，不带 `/control` |
| 用户名 | 占位文字 | 网页后台的登录用户名 |
| 密码 | 占位文字 | 登录密码，不能有英文双引号 |
| 点击 | refresh | refresh 点面板刷新；pause 点面板暂停 / 恢复防护 |
| 暂停分钟 | 10 | 一次暂停几分钟，0 表示一直关着直到再点 |

### 需要知道的

- 面板显示「用户名或密码不对」：账号填错了。AdGuard Home 登录失败次数太多会暂时封锁，这时显示 403，等一会儿再试。
- AdGuard Home 的统计周期设得比 24 小时短时，显示的是整个统计周期的数字。
- 0.107.27 以前的老版本没有暂停功能，点一下是直接关掉防护，再点打开。
- 测试：`node tools/test_adguard_home.js`。

## App 去广告合集

一个链接装完：

```
https://raw.githubusercontent.com/justyura/surge-modules/main/adblock.sgmodule
```

### 覆盖范围

| App | 去掉什么 |
| --- | --- |
| 哔哩哔哩 | 开屏、首页推荐、动态、视频页、评论区、直播、搜索 |
| YouTube | 首页、搜索、播放页、Shorts 里的广告，片头和中途插播广告；YouTube Music 也管。另外默认隐藏 Shorts、小游戏、竖屏直播，打开视频自动开字幕 |
| 抖音 | 只能拦广告投放和素材域名，信息流广告去不掉 |
| 小红书 | 开屏、首页和关注页信息流、搜索页、详情页 |
| Twitter / X | 只拦广告和统计域名。时间线里的推广帖用「X 去广告、屏蔽中文和翻译」 |
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

抖音和微信的广告走它们自己的加密协议，MITM 解不开，所以只能做到上面这些。美团主 App 的推广帖目前找不到靠谱的规则。

### 安装

1. Surge 里进 MITM，生成证书并安装，再去 iOS 设置 → 通用 → 关于本机 → 证书信任设置里打开信任，最后打开 MITM。
2. 安装上面的链接。
3. 把 App 从后台划掉再打开。还有广告就清一下 App 缓存，或者删了重装。

哔哩哔哩有几个参数可以调：动态最常访问、创作中心、过滤置顶评论广告、日志等级，在模块参数里改。

YouTube 有四个开关，默认都是 `true`，不想要就改成 `false`：

- `YouTube隐藏Shorts`：底部的 Shorts 标签，首页、搜索、播放页推荐里的 Shorts 栏
- `YouTube隐藏游戏`：首页里的 Playables 小游戏
- `YouTube隐藏竖屏直播`：推荐里的竖屏直播
- `YouTube自动字幕`：打开视频就自动开字幕。视频有原语言的人工字幕就用它，没有就用自动生成的。和「翻译合集」一起装，打开视频直接是双语

自动字幕是改的 YouTube 返回的「这个视频默认开不开字幕」，和 YouTube 给日语用户看英文视频时自动开日文字幕是同一个开关。你在某个视频里手动关了字幕，App 会记住，之后可能不再自动开，到播放器里再打开一次就好。

某个 App 用着有问题，想单独关掉它：先卸载合集，再从 `ads/` 里挑需要的单个模块装，每个文件都能单独用。

### Apple TV

用不了。电视版 YouTube 对 `www.youtube.com` 和 `*.googlevideo.com` 做了证书锁定，一解密就打不开，换 Mac 网关也一样。电视上想去广告：iPhone 上播放再 AirPlay 到电视，或者 YouTube Premium。

### 怎么维护

- 规则按 App 分开放在 `ads/`，改哪个 App 就改哪个文件。
- 改完跑 `python3 tools/build.py`，重新生成 `adblock.sgmodule`，两个一起提交。`adblock.sgmodule` 不要手改。
- 新加 App：在 `ads/` 里放一个新文件，再跑一次生成。

### 脚本放在哪

用到的脚本都存了一份在本仓库 `scripts/vendor/`，不直接引用别人的仓库。上游改了什么不会悄悄跑到手机上；代价是要手动更新，步骤见 [scripts/vendor/README.md](scripts/vendor/README.md)。

### 来源

- [kokoryh/Sparkle](https://github.com/kokoryh/Sparkle)（GPL-3.0）：哔哩哔哩
- [gholts/surge](https://github.com/gholts/surge)（Apache-2.0，基于 Maasea/sgmodule）：YouTube。会在本地处理加密的播放数据，不经过第三方服务器
- [fmz200/wool_scripts](https://github.com/fmz200/wool_scripts)（GPL-3.0）：其他所有 App

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

## 翻译合集

```
https://raw.githubusercontent.com/justyura/surge-modules/main/translate.sgmodule
```

YouTube 字幕和评论、Reddit、X、GitHub、Stack Overflow（App 和 Safari）的翻译都在这一个模块里，**只用填一个 OpenAI key**。先用大模型结合上下文翻，DeepL / Google 兜底。Reddit 和 X 顺带去推广，X 还能屏蔽中文推文。脚本都是自己写的，在 `scripts/` 里。

### 用法

1. 装模块，参数「大模型密钥」填 OpenAI 的 key，多个用 `|` 分隔。
2. 「DeepL密钥」可以不填：大模型来不及或用不了时直接用 Google 兜底；填了就先用 DeepL 兜底，再用 Google。
3. 哪个站点不用，就把它的开关参数改成 `#`：YouTube字幕、YouTube评论、Reddit、X、GitHub、StackOverflow、StackOverflow网页。
4. 以前装过单独的「YouTube 双语字幕」「Reddit 去广告和翻译」「X 去广告、屏蔽中文和翻译」「GitHub 翻译」「Stack Overflow 翻译」「Stack Overflow 网页翻译」的，先卸掉，同一个请求不能被两个模块处理。这几个单独的模块已经不再更新。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 大模型密钥 | 占位文字 | OpenAI 的 key，用 `\|` 分隔，所有站点共用 |
| DeepL密钥 | 占位文字 | 可以不填，兜底用 |
| 大模型 | gpt-6-luna | 模型名 |
| 大模型接口 | `https://api.openai.com/v1` | 兼容 OpenAI 的接口地址 |
| 大模型思考 | auto | auto 按模型自动关掉思考；none、low、medium… 照填；off 不带这个参数 |
| 目标语言 | ZH-HANS | ZH-HANT 繁体，也可以填 EN-US、JA、KO 等 |
| 备用翻译 | google | off 表示不用 Google 兜底 |
| 最长等待 | 6 | Reddit、X、GitHub、Stack Overflow App 最多等几秒翻译 |
| 调试日志 | false | true 打印详细日志 |
| YouTube字幕 … StackOverflow网页 | 脚本名 | 七个站点开关，填 `#` 关掉 |
| 字幕原文位置 | top | YouTube 字幕：top 原文在上；bottom 译文在上；only 只显示译文 |
| YouTube译法 | faithful | YouTube 字幕和评论：faithful 贴着原文翻，适合学英语；natural 更口语，可以意译 |
| 视频概要 | true | YouTube：先把整条字幕读一遍，知道视频讲什么、术语怎么翻、哪些词听错了；false 不做 |
| 字幕最长等待 | 12 | YouTube 字幕最多等几秒，到时间先显示翻好的部分 |
| 生词服务 | 占位文字 | 自己的 vox 生词服务地址，见下面「标生词」；不填就不标 |
| 评论展开 | true | YouTube 长评论直接显示全文；false 保持要点「展开」 |
| Reddit翻译范围 | all | all 标题、正文、评论都翻；title 只翻标题；off 只去广告 |
| X屏蔽中文 | true | false 只去广告和翻译 |
| X中文判定 | normal | normal 只看正文；strict 再看引用、作者名字和简介 |
| X白名单 | 占位文字 | 不删的账号，填 @ 后面的用户名，多个用 `\|` 分隔 |
| X翻译 | all | off 不翻译，只去广告和屏蔽中文 |
| GitHub翻译范围 | all | all 全翻；title 只翻标题和仓库简介；off 不翻 |
| GitHub改markdown | false | true 时 markdown 原文也插译文，见下面 GitHub 一节 |
| StackOverflow翻译范围 | all | App 和网页都按这个：all 全翻；post 不翻评论；title 只翻标题；off 不翻 |
| StackOverflow最多回答 | 10 | App 一次最多翻几个回答，0 不限 |

站点开关填 `#` 只是不跑那个脚本，MITM 的域名还在。

### 大模型翻译

DeepL 和 Google 一句一句翻，看不到前后文：自动字幕一句话被切成好几行、没有标点、还有听错的词，翻出来经常是半句半句的；评论里的梗、人名也常翻错。所以先用大模型翻，DeepL、Google 变成兜底。

- **YouTube 字幕**：按时间顺序分组，每组二十句左右，同时带上视频标题、频道名、前面 10 句和后面 6 句。一组最后一句话常常在下一组才说完，带上后面几句才知道这半句是什么意思。大模型看得懂整句话，能纠正自动字幕听错的词，人名、术语前后一致。每行译文还是对着自己那行，时间轴不乱。
- **视频概要**：分组翻时每组只看得到前后十几句，不知道整个视频在讲什么，第 3 分钟和第 30 分钟同一个术语可能翻得不一样。所以第一次打开字幕时，先把整条字幕（最多 12 万字，大约两个半小时）发给大模型读一遍，要回来三样东西：
  - 视频讲什么：领域、谁在对谁说、语气，两三句话；
  - 术语表：最多 30 个人名、术语、反复出现的说法，各自统一用哪个译法；
  - 听错的词：自动字幕听错的词原本是什么。

  之后每组都带上「视频讲什么」，加上这一组里出现的术语和听错的词。概要一个视频只做一次，最近 20 个视频的存在手机上，关掉字幕再打开、换译法都不用再做。评论也会带上视频讲什么（回复用最近打开的视频）。

  第一次打开要先等概要，最多等 6 秒（不超过「字幕最长等待」的一半），等不到就先不带，概要回来后照样存下来，下次打开用。所以「字幕最长等待」默认改成了 12 秒。字幕少于 40 句的视频不做概要，前后十几句已经差不多是全部了。读一遍整条字幕很便宜：20 分钟的视频大约 5 千 token，用 gpt-6-luna 不到 0.001 美元。
- **YouTube 译法**：看 YouTube 是为了学英语的话，译文顺不够，还得对得上原文。所以默认 `faithful`：按原文的逻辑和顺序翻，每一部分都能对回原文的词；语气、正式程度、强弱（随口说、开玩笑、委婉、强调）照原样，不抹平也不加戏；术语用标准译法，前后一致；不增、不删、不概括、不解释。但还是通顺的中文，不是逐字硬译。只想看懂内容、要更口语的，把「YouTube译法」改成 `natural`。换了译法会重新翻，不用之前的缓存。Reddit、X 这些站点不受这个参数影响。
- **YouTube 评论**：带上视频标题，几条一组同时翻，梗和人名能对上视频内容。点进去看回复时，用的是最近打开的那个视频的标题。
- 视频标题用 YouTube 的 oEmbed 接口查（不用登录），最近 30 个视频的标题会记住。

**来不及翻怎么办**：大模型比 DeepL 慢，一组要几秒，所以十几组一起发。离「字幕最长等待」还剩 2.5 秒时（其他站点是「最长等待」前 2 秒），还没翻好的先交给 DeepL / Google 翻一版顶上，大模型在截止前回来的照样换成大模型的。兜底的译文单独缓存，下次打开字幕还会交给大模型重翻，大模型翻好之前先显示兜底的那版，不再花 DeepL 额度。大模型 key 全都用不了时马上换 DeepL，不等到截止。

一两个小时的长视频，一次只能用大模型翻前面一部分（默认 12 秒大概几百句），后面先是 DeepL 的，关掉字幕再打开接着用大模型翻。YouTube 不报「加载字幕时出错」的话，可以把「字幕最长等待」调到 15～20 秒，一次多翻一些。评论用大模型时最多等 6 秒。

**模型和费用**：默认 `gpt-6-luna`，每百万 token 输入 0.1 美元、输出 0.5 美元，一个 20 分钟的视频不到 0.01 美元，一页评论零点几美分。要更好的质量可以填 `gpt-6-sol`。价格以 OpenAI 官网为准。

**关掉思考**：gpt-6-luna 默认会先「思考」（`medium`）再回答。翻译用不着，开着一组要多等好几秒，来不及的句子就变成 DeepL / Google 的译文，看起来反而不准。所以参数「大模型思考」默认 `auto`，按模型自动关到最低：

| 模型 | auto 用的档位 |
| --- | --- |
| gpt-6-luna、gpt-6-sol、gpt-5.x | `none`，完全不思考 |
| gpt-5、gpt-5-mini、gpt-5-nano | `minimal` |
| gpt-6.1-sol、gpt-6-astra、o 系列 | `low`，它们没有 none |
| gpt-4.1 系列、别家的模型 | 不带这个参数 |

模型不认填的档位时，none / minimal 退到 low 再试，还不认就不带这个参数。想让它多想一点就填 `low` 或 `medium`，别家接口报错就填 `off`。打开「调试日志」，Surge 日志里每次请求都会打出用时和思考用掉的 token。

### 翻译状态面板

装好后 Surge 首页多一个「翻译状态」面板，每 30 分钟自己刷新一次，点一下马上刷新。只用 DeepL 时大概是这样：

```
在用：DeepL，Google 兜底
最近字幕 · 3 分钟前 · DeepL 2 次，失败 1 次（额度用完） → Google 1 次
最近评论 · 10 分钟前 · DeepL 1 次
DeepL key 1（…1111 免费）：剩 376,544 字，已用 25%
DeepL key 2（…2222 Pro）：额度用完，暂停到 10-22 14:30
```

- **在用**：按填的 key 算出来的顺序。填了大模型 key 先用大模型；没填就是 DeepL；DeepL 也没填就只有 Google 兜底。前面的都用不了时会多一行「实际会用 Google：前面的用不了」，标题也跟着变。
- **最近**：字幕、评论、整句文稿各自最近一次实际请求了哪个、几次，失败的原因（额度用完、key 无效、请求太多、连不上）。全部走缓存的那次不算。现在只有 YouTube 会记。
- **DeepL 额度**：每个 key 查一次 DeepL 的 `/v2/usage`，不花字数。显示剩多少字、用了百分之几，被暂停的 key 写到几点恢复。
- **颜色**：绿色一切正常；橙色有 key 用不了、额度用了 90% 以上，或者最近有失败；红色什么翻译都用不了。

填了大模型 key 时，面板还会测一下大模型：用你填的 key、模型、接口和「大模型思考」翻一小段字幕，显示出来大概是这样：

```
gpt-6-luna · 思考 none · 0.8 秒
思考 token 0，思考已关掉
原文：and then everyone rushed to the bank
译文：然后所有人都冲向银行
```

- 用的就是 YouTube 字幕实际发出去的提示词，包括「YouTube译法」。
- 测试的字幕是一句话被切成两行，单看这一行分不清 bank 是银行还是河岸，要结合视频标题和前后几句。翻成河岸会提示「没结合上下文」。
- 思考 token 不是 0，说明思考没关掉，面板会提示改「大模型思考」。
- 填了多个 key 会每个都测，列出哪个能用、哪个不能用（key 无效、额度用完、模型名不对、连不上接口）。
- 每次刷新每个大模型 key 一个很小的请求，几百个 token；面板每 30 分钟自己刷新，一天大概 48 次。不用大模型就不会发。

**别家的接口**：「大模型接口」默认 `https://api.openai.com/v1`。DeepSeek、OpenRouter、自己部署的 One API 之类兼容 OpenAI Chat Completions 的接口都行，填它们的地址（到 `/v1` 为止），「大模型」填那家的模型名。要求接口支持 `response_format: {"type": "json_object"}`。

### 每个站点带什么上下文

| 站点 | 除了要翻的段落，一起发过去的 |
| --- | --- |
| YouTube 字幕 | 视频标题和频道名，视频概要（视频讲什么，这一组用得上的术语和听错的词），每组前面 10 句、后面 6 句字幕 |
| YouTube 评论 | 视频标题和频道名，看过字幕的话还有视频讲什么（回复用最近打开的视频） |
| Reddit | 帖子标题（评论单独加载时用 10 分钟内最近打开的帖子），同一条帖子、评论的几段挨在一起 |
| X | 是哪种页面（推文详情是一条推文加它的回复，按顺序），推文按页面顺序 |
| GitHub | 仓库名，Issue / PR 标题（评论单独加载时用最近打开的那个） |
| Stack Overflow App | 问题标题（回答单独加载时用最近打开的那个问题） |
| Stack Overflow 网页 | 页面标题 |

GitHub 和 Stack Overflow 发过去的是简单 HTML，提示词里要求 `<code>` 里的内容、`<br>` 和转义字符原样保留，代码、命令、报错不翻。

大模型的译文和 DeepL / Google 的分开缓存。兜底的那版下次还会交给大模型重翻；YouTube 字幕换了模型也会重翻。

### 多个 key 怎么切换

大模型 key 和 DeepL key 都一样：按填写顺序用，上次成功的 key 优先。某个 key 出错就马上换下一个，并按错误暂停它：

| 情况 | 暂停多久 |
| --- | --- |
| key 无效（大模型 401、DeepL 403） | 7 天 |
| 额度用完（大模型 429 `insufficient_quota`、DeepL 456） | 24 小时后再试 |
| 429 请求太多 | 1 分钟 |
| 5xx 服务器出错 | 5 分钟 |
| 网络错误 | 不暂停，直接换下一个 |

大模型 key 全都不能用时马上换 DeepL；DeepL 也不行默认用 Google 兜底；都不行就显示原文，不影响 App 加载。

另外：
- 以 `:fx` 结尾的 Free key 走 `api-free.deepl.com`，其他当 Pro key 走 `api.deepl.com`。
- 状态里只存 key 的指纹，不存明文。
- 几个站点共用 key 的暂停状态：某个 key 在 YouTube 上额度用完了，Reddit 那边也知道。
- 打开「调试日志」可以在 Surge 日志里看到每次请求和 key 的切换。

### YouTube 字幕

在 YouTube 里打开原文字幕（比如英文），就会变成双语。装了「App 去广告合集」并开着 `YouTube自动字幕` 的话，字幕会自动打开，不用手点。YouTube 自带的「自动翻译」字幕和本来就是中文的字幕不会再翻。

- 同一个视频的翻译会缓存（最近 3 个视频），拖进度条、重新打开字幕不重复花额度。
- 超过「字幕最长等待」（默认 12 秒）就先返回翻好的部分，没翻完的显示原文；关掉字幕再打开会接着翻。任何情况下超时 3 秒以上都会原样返回字幕，不会让 YouTube 报「加载字幕时出错」。
- 只用 DeepL 时，60 句打包成一段、一段一个请求，最多 6 个同时发。每个请求都带上下文（DeepL 的 `context` 参数，只作参考、不翻译、不计费）：视频标题，这一段前面约 600 字和后面约 200 字的字幕。DeepL 能看到前后文，碎句、代词、术语翻得更准；从视频开头往后翻，几百句的视频几秒翻完，特别长的视频到时间先显示翻好的部分，重新打开字幕接着翻。
- 评论只用 DeepL 时也带上下文：「这些是某某视频下的评论」，看过字幕的话再加上视频讲什么。
- 支持 YouTube 的三种字幕格式：json3、srv3 / srv1 XML、WebVTT。自动生成字幕会把逐词的片段合成整句再翻。
- DeepL 的条款是一人一个免费账号，多个免费账号轮着用超出额度违反条款，账号可能被封，自己把握。

#### 标生词

接的是自己的 [vox](https://github.com/justyura/vox) 里的 `05_vocabularyService`（ECDICT 词典，`POST /v1/extract`）。在参数「生词服务」里填它的地址，比如 `http://192.168.1.2:8090`。

- 英文字幕会整段发给这个服务，它挑出中高考、四级以外、词频 5000 名以后的词，带中文释义。
- 每个生词只在第一次出现的那句下面标一次，每句最多 2 个，释义只留第一个意思，像这样：

  ```
  Its ephemeral nature makes the phenomenon hard to quantify.
  它的短暂性使得这一现象难以量化。
  ephemeral 朝生暮死的 · quantify 定量
  ```

- 只想标生词、不翻译也行：「大模型密钥」「DeepL密钥」都不填，「备用翻译」填 off。
- 服务最多等 4 秒，连不上就只显示翻译，不影响字幕。同一个视频的生词会缓存。
- 手机要能连到这个地址：在家用局域网 IP；在外面要么把服务放到公网（建议加 HTTPS），要么在 Surge 里配 WireGuard 连回家。iPhone 同时只能开一个 VPN，Surge 开着时 Tailscale 用不了。

### YouTube 字幕导出

开着字幕看视频，再在 Safari 里打开：

```
https://yt-subtitles.internal/
```

页面显示最近打开过字幕的那个视频（地址后面加 `?v=视频ID` 可以指定视频）：

- 在 Claude 中打开原文：把完整内容复制到剪贴板（提示词：先说这是什么视频、为什么对你重要、对生活有什么帮助、值不值得花时间——Claude 有你的记忆就结合你的情况；再写主旨、按顺序的要点并标出是研究结论还是讲者判断、反直觉的地方、能落到行动上的改变和这周能试的一件小事、没讲清和要核实的地方，最后是几道自测题和答案；中文写，专有名词保留英文，只按视频里说的来；后面接 Transcript:、视频标题和原文），再用 `claude://claude.ai/new?q=` 打开 Claude App，输入框里填好一句「Follow the instructions at the top of the text I paste below.」。长按粘贴（长的会变成文件附件，提示词在附件开头），发送。Claude App 只收链接里前 120 个字左右（实测在第 119 个字截断），所以提示词和原文都走剪贴板。提示词在 `scripts/youtube-subtitles.js` 的 `CLAUDE_PROMPT`，要改就改那里；这个链接写法不是官方文档里的，哪天失效了就用「复制原文」
- 复制原文：只复制原文，合成段落，不带译文和时间
- 字幕翻译开关：导出页上一键关掉 / 打开 YouTube 字幕翻译。只想把视频发给 Claude 总结时关掉，字幕照样记下来，导出、发 Claude 都正常，只是不翻译、不花 DeepL 额度，播放器里只显示原文字幕。「在 Claude 中打开」和快捷指令本身从来不走 DeepL。Surge 首页还有一个「字幕翻译」面板，点一下就切换，面板上显示开着还是关着（靠 Surge 点面板时给的 `$trigger`；要是点了不切换，用下面的控制中心）。「翻译状态」面板上也会显示关着。

  放到控制中心：在「快捷指令」App 里建一个快捷指令，两个动作：「获取 URL 内容」填 `https://yt-subtitles.internal/?translate=toggle`（切换一下，返回一句现在的状态），再加「显示通知」显示上一步的内容。然后下拉控制中心 → 左上角「+」→ 添加控制 → 快捷指令 → 运行快捷指令，选它。也可以用 `?translate=off` / `?translate=on` 做成固定的关和开
- 整句文稿：把切碎的字幕合成段落，一段英文、下面一段中文，适合从头读一遍。自动字幕没有标点，攒到 400 字左右在停顿最长的地方分段；人工字幕按句子分段。几段打包成一次 DeepL 请求，段落之间互为上下文，再带上前后各一段和视频标题。翻好的存下来，再打开不再花额度；最多翻 25 秒，没翻完的刷新接着翻。可以下载 TXT 或一键复制
- 下载双语 SRT、原文 SRT、译文 SRT，或者查看纯文本、一键复制全部文字
- 字幕就是你正在看的那一份：字幕脚本处理字幕时，把每句的时间、原文、译文记下来，记最近 2 个视频
- 要先打开字幕，等译文出来再导出。没翻完的句子在译文里用原文顶上，关掉字幕再打开会接着翻，翻完再导出就是全的
- 自动生成的字幕每句会和下一句重叠，导出时结束时间截到下一句开始

这个地址由 Surge 里的脚本直接回应，不会发到网上，所以要开 MITM（模块已经加好了）。

#### 不打开网页：敲两下手机背面，原文直接进 Claude

用「快捷指令」App 建一个快捷指令，依次加这四个动作：

1. 「获取 URL 内容」，网址填 `https://yt-subtitles.internal/?fmt=prompt`（提示词 + 视频标题 + 原文；`?fmt=paste` 也一样）
2. 「拷贝到剪贴板」
3. 「获取 URL 内容」，网址填 `https://yt-subtitles.internal/?fmt=claudeurl`（打开 Claude 的链接，带一句短话）
4. 「打开 URL」

再到 设置 → 辅助功能 → 触控 → 轻点背面 → 轻点两下，选这个快捷指令。看视频时开着字幕，敲两下手机背面，Claude 打开，长按输入框粘贴（长的会变成附件，你的提示词在附件开头），发送。也可以把快捷指令加到主屏幕或控制中心。

试过在播放器菜单里加一个「导出字幕」按钮：菜单是服务器下发的，按钮也加进去了，但新版 App 只显示自己认识的菜单项，新加的会被丢掉；把「Help & feedback」改成「导出字幕」，App 也照样显示自己的标题。所以没有做 App 里的按钮。

### YouTube 评论

打开评论区，外文评论的译文直接接在原文下面，往下翻、点进去看回复也一样。默认开着，参数「YouTube评论」填 `#` 关掉。

长评论默认直接显示全文，不用点「展开」。不想要就把参数「评论展开」改成 `false`。

- 一页 20 条左右，每条单独识别语言，英文、日文、西班牙文混着也没问题。
- 中文评论（目标语言是中文时）和纯表情不翻，不花额度。YouTube 给关键词加的搜索链接（「词⁠关联」）不送去翻。
- 翻过的评论缓存最近 300 条，再打开不重复花额度。
- 最多等 4 秒（用大模型时 6 秒，比「字幕最长等待」小就按它），翻不完先显示原文。大模型、DeepL、Google 都不行就是原评论，不影响评论区加载。
- 评论只能接在原文下面，「字幕原文位置」对评论不起作用：评论里的链接、@ 都按位置标在原文上，译文放前面会错位。

和「App 去广告合集」一起装没问题。评论区走 `/youtubei/v1/next`，回复走 `/youtubei/v1/browse`，这两个接口的响应已经被去广告脚本占了（Surge 一个响应只跑一个脚本），所以评论翻译挂在请求阶段：认出评论请求后，脚本自己带上原来的请求头（登录状态也在里面）去 YouTube 拿评论，翻译好直接返回给 App；其他请求原样放行，去广告照常。代价是评论请求不经过去广告脚本，评论里本来也没有广告。

评论区的 App 端格式是 protobuf，字段位置是对着 iOS 客户端的真实响应找出来的。YouTube 改了格式的话，评论会原样显示，不会出错。

### Reddit

给 Reddit 官方 App 用的，处理 App 的 GraphQL 接口（`gql.reddit.com`、`gql-fed.reddit.com`）和 REST 接口（`oauth.reddit.com`）。Safari 里的 reddit.com 由「网页弹窗和广告拦截」管。脚本：`scripts/reddit.js`。

去广告：

- 首页、版块、搜索信息流里的推广帖（`AdPost`、带广告标记的卡片）
- 帖子页正文下面、评论中间插的广告
- NSFW 标记不动

不放进「App 去广告合集」：Surge 一个响应只跑一个脚本，去广告和翻译得在同一个脚本里。

翻译：

- 标题的译文接在下面。帖子正文和评论按段对照：一段原文，下面紧跟这一段的译文，再下一段原文。
- 中文段落和纯表情不翻。每段单独识别语言。翻过的缓存最近 500 段。
- 大模型几段一组同时翻，按页面顺序排，同一条帖子、评论的几段挨在一起；帖子页带上帖子标题，评论单独加载时用 10 分钟内最近打开的帖子标题，信息流不带。
- 最多等 6 秒（参数「最长等待」），没翻完的显示原文，广告照样去掉。评论多的帖子拆成好几组同时翻；还是翻不完就把「最长等待」调大，或者退出帖子再点进去，翻过的走缓存，会接着翻后面的。
- 评论多的帖子很费额度。只想看标题就把「Reddit翻译范围」改成 `title`，不想翻译改成 `off`。

需要知道的：

- 数据结构是照着 xream 的脚本和 [level3tjg/RedditFilter](https://github.com/level3tjg/RedditFilter) 写的，还没对着真机抓的响应核对过。哪里不对，打开「调试日志」看 Surge 日志里 `[Reddit]` 开头的几行。
- 帖子和评论的正文 App 里有 markdown、richtext、html、preview 几种写法，不确定 App 显示哪个，几种都按段插了译文。段落是去掉格式后按文字对上的。
- 不按类型名挑：GraphQL 里任何带正文的 `content`、REST 里的 `body`、`selftext` 都会翻，Reddit 改了类型名也照样能翻。
- 打开「调试日志」后，每个响应都会打一行：接口地址、`data` 下面的字段名、有哪些 `__typename`。某个页面没翻译，把这几行发出来就能看出是哪个接口。
- 测试：`node tools/test_reddit.js`。

### X

X App 和 Safari 里的 x.com 都管，处理 App 的 GraphQL 接口（`api.x.com/graphql/…`、`api.twitter.com/graphql/…`）和网页版的（`x.com/i/api/graphql/…`），推广和中文推文在接口里就删掉，页面上不会闪一下再消失；留下的外文推文加上译文。脚本：`scripts/x.js`，去广告、屏蔽中文和翻译在同一个脚本里（Surge 一个响应只跑一个脚本）。

去广告：

- 「为你推荐」「正在关注」、列表、搜索里的推广帖
- 推文详情页回复里插的推广
- 推荐关注里的推广账号、趋势里的推广趋势

屏蔽中文：

- 推文正文是中文的删掉：X 自己标的语言是中文，或者正文里汉字比英文单词多（至少 4 个汉字）。长推文看展开后的全文，转推看被转的那条。
- 带假名、谚文的算日文、韩文，不删；X 标成日文、韩文的也不删。
- 趋势名字是中文的删掉。
- 对话串里的中文回复删掉，英文的留着；整串都是中文就整串删。
- 「X中文判定」改成 `strict` 会删得更狠：引用了中文推文、作者名字或简介里有汉字的推文也删（专治名字是中文、发英文的机器人），推荐关注里名字带汉字的账号也删。纯汉字的日文名字会被误伤。
- 这些地方不删：自己点开的那条推文和它上面的串、个人主页、用中文搜索的结果、「X白名单」里的账号。

翻译：

- 推文正文后面空一行接上译文。长推文翻全文，译文在全文最后，时间线上要点「显示更多」才看得到。转推翻被转的那条，引用的推文也翻。
- X 标的语言已经是目标语言的不翻，纯链接、纯表情、只有 @ 或话题的不翻。日文、韩文照翻。
- 翻过的缓存最近 500 条，刷新、翻回来都不再花额度。
- 最多等 6 秒（参数「最长等待」），没翻完的显示原文，广告和中文照样删掉。刷新一下会接着翻。
- 大模型按页面顺序几条一组翻，推文详情页里回复挨着它回的推文。
- 只想去广告、屏蔽中文，不想翻译：把「X翻译」改成 `off`。

需要知道的：

- 装好后把 X App 从后台划掉再打开。脚本按网页版的响应写的，不按固定路径找条目，App 的结构差不多就能用，但还没对着真机核对过。
- App 里没效果时，打开「调试日志」刷新一下，看 Surge 日志里 `[X]` 开头的几行：
  - 一行都没有：请求没被解密。看 Surge「最近请求」里 `api.x.com` 的请求有没有被 MITM，有没有握手失败。
  - `不是 JSON`：App 这个接口返回的不是 JSON，脚本处理不了。
  - `没找到带 entryId 的条目，响应的结构：…`：结构和网页版不一样，把这行发出来照着改。
  - `没删东西`：结构认得，但这一页正好没有广告和中文。
- 如果 X App 加载不出来，说明 App 不认 MITM 证书，先把「X」开关填 `#`。
- 网页上的「打开 App」弹窗由「网页弹窗和广告拦截」管，两个一起装不冲突。
- 网页版第一次装好后，在 Safari 设置里清一下 x.com 的网站数据，不然旧缓存里的推文还会出来。
- 不按固定路径找，整个响应里带 `entryId` 的条目都看，X 改了外层字段名也照样能用。
- 网页显示推文用的是 `full_text` 里 `display_text_range` 那一段，译文插在这一段末尾，后面图片链接的下标跟着往后挪，所以图片、链接、@ 都还能点。
- 测试：`node tools/test_x.js`。

### GitHub

给 GitHub 官方 App 用的。App 通过 `api.github.com` 拿数据，脚本直接改返回的 JSON。脚本：`scripts/github.js`。

- Issue、PR、讨论：标题的译文接在下一行，正文和评论按段对照，一段原文下面紧跟它的译文。
- Release 说明、仓库简介、README 也翻。
- 列表每项单独翻，代码块和表格不翻，行内代码原样保留。中文段落不翻，夹着英文名字的中文（比如「AdGuard Home 面板」）也算中文。
- 一个响应最多翻 400 段，最多等 6 秒（参数「最长等待」，长 README 可以调到 8），没翻完的显示原文。退出再点进去，翻过的走缓存，会接着翻后面的。缓存最近 800 段。
- 大模型带上仓库名和 Issue / PR 标题。

**编辑时不会带上译文**：App 编辑评论时用的是 markdown 原文（`body`），不是用来显示的 HTML（`bodyHTML`）。脚本只改 HTML，所以在 App 里编辑评论，编辑框里是原文，不会把译文存进去。

标题没有单独的显示用字段，翻了的话改标题时编辑框里会带着译文。所以自己能编辑的 Issue、PR（自己开的，或者自己有权限的仓库里的），标题不翻。

参数「GitHub改markdown」打开后，别人的 markdown 原文也会插译文。只有装好后发现标题有译文、正文没有（说明 App 用 markdown 显示）时才需要打开。

需要知道的：

- GitHub App 具体请求哪些字段没有抓包核对过，是按 GitHub 公开的接口字段写的：GraphQL 里以 `HTML` 结尾的字段（`bodyHTML`、`descriptionHTML`、`titleHTML`）、REST 里的 `body_html`，加上 README 的两种格式（HTML 和 base64 的 markdown）。HTML 照着 GitHub 真实渲染出来的写法测过。
- 哪里没翻：打开「调试日志」，在 App 里点开那个页面，看 Surge 日志里 `[GitHub]` 开头的行。每个响应一行，写着地址、有哪些类型、有哪些 HTML 字段，把这几行发过来就知道 App 用的是什么。
- MITM 了 `api.github.com` 以后，其他用 GitHub 接口的 App 拿到的 Issue、README 也会带译文。
- 用 Google 兜底时译文里行内代码的格式会丢，只剩文字。
- 测试：`node tools/test_github.js`。

### Stack Overflow App

Stack Overflow 官方 App 已经下架了，这个给第三方客户端用，在 [Octostack](https://apps.apple.com/us/app/-/id6443491836)（App Store 里叫「Stack Overflow Client」）上用。第三方客户端都通过 Stack Exchange 的官方接口 `api.stackexchange.com` 拿数据，脚本直接改接口返回的 JSON。脚本：`scripts/stackoverflow.js`。

- 问题列表、搜索结果：标题的译文接在下一行。
- 问题页：标题、问题、回答、评论。正文按段对照，一段原文下面紧跟它的译文。列表每项单独翻，译文接在这一项里面；引用里的译文还在引用里。
- 代码块不翻，行内代码原样保留在译文里。中文段落、纯代码不翻。
- 接口里正文有 HTML（`body`）和 markdown（`body_markdown`）两种写法，App 用哪个不确定，两种都按段插了译文。同一段两边只翻一次。
- 热门问题一次返回上百个回答，全翻一个问题就要好几万字。默认只翻前 10 个回答和它们的评论（参数「StackOverflow最多回答」），按 App 里的顺序数，一般就是票数最高的 10 个。标题照翻。
- 最多等 6 秒（参数「最长等待」），没翻完的显示原文。退出问题再点进去，翻过的走缓存，会接着翻后面的。缓存最近 800 段。
- 大模型带上问题标题，回答单独加载时用最近打开的那个问题。

需要知道的：

- 数据格式是照着 `api.stackexchange.com` 真实返回的数据写的，拿热门问题的真实响应跑过：译文去掉以后原文一个字没变。还没有在 Octostack 上试过。
- 装好后没有翻译：打开「调试日志」，在 Octostack 里点开一个问题，看 Surge 日志里有没有 `[StackOverflow]` 开头的行。没有的话，到「最近请求」里看 App 的请求发到了哪个域名，把域名发过来。
- 开了 MITM 以后 App 加载不出来，说明 App 不接受 MITM 证书，这种情况脚本没办法。
- 用 Google 兜底时译文里行内代码的格式会丢，只剩文字。
- 测试：`node tools/test_stackoverflow.js`。后面加一个存下来的接口响应 JSON 文件，可以看真实数据能翻多少段。

### Stack Overflow 网页

给 Safari 用的。在 Safari 里打开 stackoverflow.com，点分享 →「添加到主屏幕」，主屏幕上就多一个全屏打开的 Stack Overflow。也管 Super User、Server Fault、Ask Ubuntu、MathOverflow、各个 `*.stackexchange.com` 站和它们的 meta 站，以及 ru、pt、es、ja 这些语言版的 Stack Overflow。脚本：`scripts/stackoverflow-web.js`。

- 问题页：标题、问题、每个回答、评论。正文按段对照，一段原文下面紧跟它的译文，列表每项单独翻。
- 列表页、搜索结果：只翻标题。
- 代码块不翻，行内代码（`<code>`）原样保留在译文里。中文段落、纯代码不翻。
- 只翻快滚到屏幕里的段落，长帖子往下滑才翻后面的，不会一打开就把整页的额度用掉。点「显示更多评论」后加载出来的评论也会翻。
- 右下角的橙色「译」按钮：点一下隐藏译文，再点显示，会记住。
- 翻过的在 Surge 里缓存最近 800 段，再打开同一页不花额度。
- 大模型带上页面标题。

怎么做的：

两个脚本，用的是同一个文件：

1. 打开问题页时，往网页里插一段脚本。
2. 网页脚本把要翻的段落发给同一个网站的 `/__surge-translate`。
3. Surge 拦下这个请求，自己去调大模型 / DeepL，把译文直接返回给网页，请求不会发到 Stack Overflow。

key 只在 Surge 里用，网页拿不到。在 Safari 里打开 `https://stackoverflow.com/__surge-translate`，能看到模块是不是在工作、大模型和 DeepL 能不能用。

需要知道的：

- 页面结构是照着现在的 Stack Overflow 问题页写的，新版评论（Svelte 渲染）和旧版评论都认。拿存下来的真实页面跑过，没有在真机上试过。哪里没翻，打开「调试日志」看 Surge 日志里 `[StackOverflow 网页]` 开头的几行。
- Stack Overflow 前面有 Cloudflare。开了 MITM 以后如果一直卡在「Verify you are human」，先把「StackOverflow网页」开关填 `#` 试试。
- 用 Google 兜底时译文里行内代码的格式会丢，只剩文字。
- 测试：`node tools/test_stackoverflow_web.js`，要装 Playwright。后面加一个存下来的问题页 HTML 文件，可以看真实页面能翻多少段。

### 维护

- 「翻译合集」里的脚本每 10 分钟检查一次更新（`script-update-interval=600`，Surge 默认 24 小时）。改了脚本推上去，手机上最多十几分钟就用上新的（GitHub 的 raw 地址本身还有 5 分钟缓存），不用去「外部资源」里手动更新。

- 几个脚本的大模型代码是同一份：改 `scripts/lib/llm.js`，再跑 `python3 tools/sync_llm.py` 同步进各个脚本（Surge 脚本不能互相引用，只能各放一份）。
- 改了 `translate.sgmodule`（参数、脚本地址、匹配规则）跑 `node tools/test_translate.js`：检查用到的参数都声明了、每个参数都有说明、传给脚本的字段脚本都认识，顺带检查大模型代码有没有同步。
- 各站点的测试：`node tools/test_subtitles.js`（含字幕导出）、`test_reddit.js`、`test_x.js`、`test_github.js`、`test_stackoverflow.js`、`test_stackoverflow_web.js`（要装 Playwright），测试面板是 `test_translate_panel.js`。都模拟了 Surge 和大模型 / DeepL / Google 接口，假的大模型在 `tools/fake_llm.js`。

## 规矩

- 地址、token、订阅链接一律走 `#!arguments`，不写死在模块里。
- 新增模块时，在上面的表格里加一行，再补一节说明。
- 去广告规则改 `ads/`，改完跑 `python3 tools/build.py`。
- 翻译都在「翻译合集」一个模块里，新站点也加进去，不再单独出模块。大模型代码改 `scripts/lib/llm.js`，改完跑 `python3 tools/sync_llm.py`；改了模块跑 `node tools/test_translate.js`。
