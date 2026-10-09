# surge-modules

自己用的 Surge 模块。

## 模块列表

| 模块 | 作用 | 安装链接 |
| --- | --- | --- |
| 代理流量面板 | 在面板里显示剩余流量、已用比例、到期日期和重置时间 | `https://raw.githubusercontent.com/justyura/surge-modules/main/usage-pane.sgmodule` |
| AdGuard Home 面板 | 在面板里显示自建 AdGuard Home 的防护状态、24 小时查询和拦截数，可以点一下暂停 / 恢复防护 | `https://raw.githubusercontent.com/justyura/surge-modules/main/adguard-home.sgmodule` |
| App 去广告合集 | 15 个常用 App 的开屏和 App 内广告，一个模块全包 | `https://raw.githubusercontent.com/justyura/surge-modules/main/adblock.sgmodule` |
| 网页弹窗和广告拦截 | Safari 里的弹窗、跳转广告、网页广告和跟踪，常用网站上的「打开 App」弹窗 | `https://raw.githubusercontent.com/justyura/surge-modules/main/web-popups.sgmodule` |
| 搜索引擎重定向 | 用 Google、Kagi、DuckDuckGo 等搜索时直接跳到自建搜索引擎 | `https://raw.githubusercontent.com/justyura/surge-modules/main/search-redirect.sgmodule` |
| YouTube 双语字幕 | YouTube 字幕和评论加 DeepL 翻译，多个 key 自动切换，可以标生词 | `https://raw.githubusercontent.com/justyura/surge-modules/main/youtube-subtitles.sgmodule` |
| Reddit 去广告和翻译 | Reddit App 的推广帖去掉，标题、正文、评论加 DeepL 翻译 | `https://raw.githubusercontent.com/justyura/surge-modules/main/reddit.sgmodule` |
| Stack Overflow 翻译 | 第三方 Stack Overflow App（Octostack 等）里的标题、问题、回答、评论按段加 DeepL 翻译 | `https://raw.githubusercontent.com/justyura/surge-modules/main/stackoverflow.sgmodule` |
| Stack Overflow 网页翻译 | Safari 里看 Stack Overflow 和其他 Stack Exchange 站点，同样按段加 DeepL 翻译 | `https://raw.githubusercontent.com/justyura/surge-modules/main/stackoverflow-web.sgmodule` |
| GitHub 翻译 | GitHub 官方 App 里 Issue、PR、评论、README 按段加 DeepL 翻译 | `https://raw.githubusercontent.com/justyura/surge-modules/main/github.sgmodule` |
| X 去广告、屏蔽中文和翻译 | X App 和 Safari 里的 x.com，时间线、推文详情、搜索、趋势里的推广和中文推文删掉，外文推文加 DeepL 翻译 | `https://raw.githubusercontent.com/justyura/surge-modules/main/x.sgmodule` |

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
- `YouTube自动字幕`：打开视频就自动开字幕。视频有原语言的人工字幕就用它，没有就用自动生成的。和「YouTube 双语字幕」一起装，打开视频直接是双语

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

## YouTube 双语字幕

```
https://raw.githubusercontent.com/justyura/surge-modules/main/youtube-subtitles.sgmodule
```

YouTube 字幕下面加一行 DeepL 翻译，评论区的外文评论也一样。脚本是自己写的：`scripts/youtube-subtitles.js`。

### 用法

1. 装模块，在参数「DeepL密钥」里填 key，多个用 `|` 分隔，比如 `key1:fx|key2:fx|key3:fx`。
2. 在 YouTube 里打开原文字幕（比如英文），就会变成双语。装了「App 去广告合集」并开着 `YouTube自动字幕` 的话，字幕会自动打开，不用手点。
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

### 评论翻译

打开评论区，外文评论的译文直接接在原文下面，往下翻、点进去看回复也一样。默认开着，参数「评论翻译」填 `#` 关掉。

长评论默认直接显示全文，不用点「展开」。不想要就把参数「评论展开」改成 `false`。

- 一页 20 条左右，一个 DeepL 请求翻完，每条单独识别语言，英文、日文、西班牙文混着也没问题。
- 中文评论（目标语言是中文时）和纯表情不翻，不花额度。YouTube 给关键词加的搜索链接（「词⁠关联」）不送去翻。
- 翻过的评论缓存最近 300 条，再打开不重复花额度。
- 最多等 4 秒（比「最长等待」小就按它），翻不完先显示原文。DeepL、Google 都不行就是原评论，不影响评论区加载。
- 评论只能接在原文下面，「原文位置」对评论不起作用：评论里的链接、@ 都按位置标在原文上，译文放前面会错位。

和「App 去广告合集」一起装没问题。评论区走 `/youtubei/v1/next`，回复走 `/youtubei/v1/browse`，这两个接口的响应已经被去广告脚本占了（Surge 一个响应只跑一个脚本），所以评论翻译挂在请求阶段：认出评论请求后，脚本自己带上原来的请求头（登录状态也在里面）去 YouTube 拿评论，翻译好直接返回给 App；其他请求原样放行，去广告照常。代价是评论请求不经过去广告脚本，评论里本来也没有广告。

评论区的 App 端格式是 protobuf，字段位置是对着 iOS 客户端的真实响应找出来的。YouTube 改了格式的话，评论会原样显示，不会出错。

### 标生词

接的是自己的 [vox](https://github.com/justyura/vox) 里的 `05_vocabularyService`（ECDICT 词典，`POST /v1/extract`）。在参数「生词服务」里填它的地址，比如 `http://192.168.1.2:8090`。

- 英文字幕会整段发给这个服务，它挑出中高考、四级以外、词频 5000 名以后的词，带中文释义。
- 每个生词只在第一次出现的那句下面标一次，每句最多 2 个，释义只留第一个意思，像这样：

  ```
  Its ephemeral nature makes the phenomenon hard to quantify.
  它的短暂性使得这一现象难以量化。
  ephemeral 朝生暮死的 · quantify 定量
  ```

- 不用 DeepL、只想标生词也行：「DeepL密钥」不填，「备用翻译」填 off。
- 服务最多等 4 秒，连不上就只显示翻译，不影响字幕。同一个视频的生词会缓存。
- 手机要能连到这个地址：在家用局域网 IP；在外面要么把服务放到公网（建议加 HTTPS），要么在 Surge 里配 WireGuard 连回家。iPhone 同时只能开一个 VPN，Surge 开着时 Tailscale 用不了。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| DeepL密钥 | 占位文字 | 一个或多个 key，用 `\|` 分隔 |
| 目标语言 | ZH-HANS | ZH-HANT 繁体，也可以填 EN-US、JA、KO 等 |
| 原文位置 | top | top 原文在上；bottom 译文在上；only 只显示译文 |
| 备用翻译 | google | off 表示不用 Google 兜底 |
| 最长等待 | 8 | 最多等几秒，到时间先显示翻好的部分 |
| 生词服务 | 占位文字 | 自己的 vox 生词服务地址，比如 `http://192.168.1.2:8090`；不填就不标生词 |
| 评论翻译 | 评论翻译 | 填 `#` 关掉评论翻译 |
| 评论展开 | true | 长评论直接显示全文；false 保持要点「展开」 |
| 调试日志 | false | true 打印详细日志 |

### 其他

- 支持 YouTube 的三种字幕格式：json3、srv3 / srv1 XML、WebVTT。自动生成字幕会把逐词的片段合成整句再翻。
- 测试：`node tools/test_subtitles.js`，模拟 Surge 和 DeepL / Google / 生词服务接口，覆盖 key 切换、暂停、兜底、缓存、分批、三种字幕格式、标生词和评论翻译。
- DeepL 的条款是一人一个免费账号，多个免费账号轮着用超出额度违反条款，账号可能被封，自己把握。

## Reddit 去广告和翻译

```
https://raw.githubusercontent.com/justyura/surge-modules/main/reddit.sgmodule
```

给 Reddit 官方 App 用的，处理 App 的 GraphQL 接口（`gql.reddit.com`、`gql-fed.reddit.com`）和 REST 接口（`oauth.reddit.com`），要开 MITM。Safari 里的 reddit.com 由「网页弹窗和广告拦截」管。脚本是自己写的：`scripts/reddit.js`。

### 去广告

- 首页、版块、搜索信息流里的推广帖（`AdPost`、带广告标记的卡片）
- 帖子页正文下面、评论中间插的广告
- NSFW 标记不动

不放进「App 去广告合集」：Surge 一个响应只跑一个脚本，去广告和翻译得在同一个脚本里。

### 翻译

- 标题的译文接在下面。帖子正文和评论按段对照：一段原文，下面紧跟这一段的译文，再下一段原文。
- 中文段落和纯表情不翻。每段单独识别语言，一个响应一般一个 DeepL 请求翻完。翻过的缓存最近 500 段。
- 最多等 4 秒（参数「最长等待」），没翻完的显示原文，广告照样去掉。评论多的帖子会拆成最多 6 个请求同时翻，一般几百条评论也能在限时内翻完；还是翻不完就把「最长等待」调大，或者退出帖子再点进去，翻过的走缓存，会接着翻后面的。
- 评论多的帖子很费额度。只想看标题就把「翻译范围」改成 `title`，不想翻译改成 `off`。
- DeepL key 可以和「YouTube 双语字幕」填一样的，哪个 key 被暂停两边共用。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| DeepL密钥 | 占位文字 | 一个或多个 key，用 `\|` 分隔 |
| 目标语言 | ZH-HANS | ZH-HANT 繁体，也可以填 EN-US、JA、KO 等 |
| 翻译范围 | all | all 标题、正文、评论都翻；title 只翻标题；off 只去广告 |
| 备用翻译 | google | off 表示不用 Google 兜底 |
| 最长等待 | 4 | 最多等几秒翻译 |
| 调试日志 | false | true 打印删了几条广告、翻了几段 |

### 需要知道的

- 数据结构是照着 xream 的脚本和 [level3tjg/RedditFilter](https://github.com/level3tjg/RedditFilter) 写的，还没对着真机抓的响应核对过。哪里不对，打开「调试日志」看 Surge 日志里 `[Reddit]` 开头的几行。
- 帖子和评论的正文 App 里有 markdown、richtext、html、preview 几种写法，不确定 App 显示哪个，几种都按段插了译文。段落是去掉格式后按文字对上的。
- 不按类型名挑：GraphQL 里任何带正文的 `content`、REST 里的 `body`、`selftext` 都会翻，Reddit 改了类型名也照样能翻。
- 打开「调试日志」后，每个响应都会打一行：接口地址、`data` 下面的字段名、有哪些 `__typename`。某个页面没翻译，把这几行发出来就能看出是哪个接口。
- 测试：`node tools/test_reddit.js`。

## Stack Overflow 翻译

```
https://raw.githubusercontent.com/justyura/surge-modules/main/stackoverflow.sgmodule
```

Stack Overflow 官方 App 已经下架了，这个模块给第三方客户端用，在 [Octostack](https://apps.apple.com/us/app/-/id6443491836)（App Store 里叫「Stack Overflow Client」）上用。第三方客户端都通过 Stack Exchange 的官方接口 `api.stackexchange.com` 拿数据，脚本直接改接口返回的 JSON，要开 MITM。脚本是自己写的：`scripts/stackoverflow.js`。

### 翻译

- 问题列表、搜索结果：标题的译文接在下一行。
- 问题页：标题、问题、回答、评论。正文按段对照，一段原文下面紧跟它的译文。列表每项单独翻，译文接在这一项里面；引用里的译文还在引用里。
- 代码块不翻，行内代码原样保留在译文里。中文段落、纯代码不翻。
- 接口里正文有 HTML（`body`）和 markdown（`body_markdown`）两种写法，App 用哪个不确定，两种都按段插了译文。同一段两边只翻一次。
- 热门问题一次返回上百个回答，全翻一个问题就要好几万字。默认只翻前 10 个回答和它们的评论（参数「最多回答」），按 App 里的顺序数，一般就是票数最高的 10 个。标题照翻。
- 最多等 5 秒（参数「最长等待」），没翻完的显示原文。退出问题再点进去，翻过的走缓存，会接着翻后面的。缓存最近 800 段。
- DeepL key 可以和「YouTube 双语字幕」「Reddit 去广告和翻译」填一样的，哪个 key 被暂停几个模块共用。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| DeepL密钥 | 占位文字 | 一个或多个 key，用 `\|` 分隔 |
| 目标语言 | ZH-HANS | ZH-HANT 繁体，也可以填 EN-US、JA、KO 等 |
| 翻译范围 | all | all 全翻；post 不翻评论；title 只翻标题；off 不翻 |
| 最多回答 | 10 | 一次最多翻几个回答，0 不限 |
| 备用翻译 | google | off 表示不用 Google 兜底 |
| 最长等待 | 5 | 最多等几秒翻译 |
| 调试日志 | false | true 打印每个响应翻了几段、key 的切换 |

### 需要知道的

- 数据格式是照着 `api.stackexchange.com` 真实返回的数据写的，拿热门问题的真实响应跑过：译文去掉以后原文一个字没变。还没有在 Octostack 上试过。
- 装好后没有翻译：打开「调试日志」，在 Octostack 里点开一个问题，看 Surge 日志里有没有 `[StackOverflow]` 开头的行。没有的话，到「最近请求」里看 App 的请求发到了哪个域名，把域名发过来。
- 开了 MITM 以后 App 加载不出来，说明 App 不接受 MITM 证书，这种情况脚本没办法。
- 用 Google 兜底时译文里行内代码的格式会丢，只剩文字。
- 测试：`node tools/test_stackoverflow.js`。后面加一个存下来的接口响应 JSON 文件，可以看真实数据能翻多少段。

## Stack Overflow 网页翻译

```
https://raw.githubusercontent.com/justyura/surge-modules/main/stackoverflow-web.sgmodule
```

给 Safari 用的。用 App 看的话装上面的「Stack Overflow 翻译」，两个模块互不影响，可以只装一个。在 Safari 里打开 stackoverflow.com，点分享 →「添加到主屏幕」，主屏幕上就多一个全屏打开的 Stack Overflow。要开 MITM。脚本是自己写的：`scripts/stackoverflow-web.js`。

也管 Super User、Server Fault、Ask Ubuntu、MathOverflow、各个 `*.stackexchange.com` 站和它们的 meta 站，以及 ru、pt、es、ja 这些语言版的 Stack Overflow。

### 翻译

- 问题页：标题、问题、每个回答、评论。正文按段对照，一段原文下面紧跟它的译文，列表每项单独翻。
- 列表页、搜索结果：只翻标题。
- 代码块不翻，行内代码（`<code>`）原样保留在译文里。中文段落、纯代码不翻。
- 只翻快滚到屏幕里的段落，长帖子往下滑才翻后面的，不会一打开就把整页的额度用掉。点「显示更多评论」后加载出来的评论也会翻。
- 右下角的橙色「译」按钮：点一下隐藏译文，再点显示，会记住。
- 翻过的在 Surge 里缓存最近 800 段，再打开同一页不花额度。
- DeepL key 可以和「YouTube 双语字幕」「Reddit 去广告和翻译」「Stack Overflow 翻译」填一样的，哪个 key 被暂停几个模块共用。

### 怎么做的

两个脚本，用的是同一个文件：

1. 打开问题页时，往网页里插一段脚本。
2. 网页脚本把要翻的段落发给同一个网站的 `/__surge-translate`。
3. Surge 拦下这个请求，自己去调 DeepL，把译文直接返回给网页，请求不会发到 Stack Overflow。

DeepL key 只在 Surge 里用，网页拿不到。在 Safari 里打开 `https://stackoverflow.com/__surge-translate`，能看到模块是不是在工作、DeepL 能不能用。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| DeepL密钥 | 占位文字 | 一个或多个 key，用 `\|` 分隔 |
| 目标语言 | ZH-HANS | ZH-HANT 繁体，也可以填 EN-US、JA、KO 等 |
| 翻译范围 | all | all 全翻；post 不翻评论；title 只翻标题；off 不翻 |
| 备用翻译 | google | off 表示不用 Google 兜底 |
| 调试日志 | false | true 打印每次翻了几段、key 的切换 |

### 需要知道的

- 页面结构是照着现在的 Stack Overflow 问题页写的，新版评论（Svelte 渲染）和旧版评论都认。拿存下来的真实页面跑过，没有在真机上试过。哪里没翻，打开「调试日志」看 Surge 日志里 `[StackOverflow 网页]` 开头的几行。
- Stack Overflow 前面有 Cloudflare。开了 MITM 以后如果一直卡在「Verify you are human」，先关掉这个模块试试。
- 用 Google 兜底时译文里行内代码的格式会丢，只剩文字。
- 测试：`node tools/test_stackoverflow_web.js`，要装 Playwright。后面加一个存下来的问题页 HTML 文件，可以看真实页面能翻多少段。

## GitHub 翻译

```
https://raw.githubusercontent.com/justyura/surge-modules/main/github.sgmodule
```

给 GitHub 官方 App 用的。App 通过 `api.github.com` 拿数据，脚本直接改返回的 JSON，要开 MITM。脚本是自己写的：`scripts/github.js`。

### 翻译

- Issue、PR、讨论：标题的译文接在下一行，正文和评论按段对照，一段原文下面紧跟它的译文。
- Release 说明、仓库简介、README 也翻。
- 列表每项单独翻，代码块和表格不翻，行内代码原样保留。中文段落不翻，夹着英文名字的中文（比如「AdGuard Home 面板」）也算中文。
- 一个响应最多翻 400 段，最多等 5 秒（参数「最长等待」），没翻完的显示原文。退出再点进去，翻过的走缓存，会接着翻后面的。缓存最近 800 段。
- DeepL key 可以和其他几个翻译模块填一样的，哪个 key 被暂停几个模块共用。

### 编辑时不会带上译文

App 编辑评论时用的是 markdown 原文（`body`），不是用来显示的 HTML（`bodyHTML`）。脚本只改 HTML，所以在 App 里编辑评论，编辑框里是原文，不会把译文存进去。

标题没有单独的显示用字段，翻了的话改标题时编辑框里会带着译文。所以自己能编辑的 Issue、PR（自己开的，或者自己有权限的仓库里的），标题不翻。

参数「改markdown」打开后，别人的 markdown 原文也会插译文。只有装好后发现标题有译文、正文没有（说明 App 用 markdown 显示）时才需要打开。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| DeepL密钥 | 占位文字 | 一个或多个 key，用 `\|` 分隔 |
| 目标语言 | ZH-HANS | ZH-HANT 繁体，也可以填 EN-US、JA、KO 等 |
| 翻译范围 | all | all 全翻；title 只翻标题和仓库简介；off 不翻 |
| 改markdown | false | true 时 markdown 原文也插译文 |
| 备用翻译 | google | off 表示不用 Google 兜底 |
| 最长等待 | 5 | 最多等几秒翻译 |
| 调试日志 | false | true 打印每个响应的地址、字段和翻了几段 |

### 需要知道的

- GitHub App 具体请求哪些字段没有抓包核对过，是按 GitHub 公开的接口字段写的：GraphQL 里以 `HTML` 结尾的字段（`bodyHTML`、`descriptionHTML`、`titleHTML`）、REST 里的 `body_html`，加上 README 的两种格式（HTML 和 base64 的 markdown）。HTML 照着 GitHub 真实渲染出来的写法测过。
- 哪里没翻：打开「调试日志」，在 App 里点开那个页面，看 Surge 日志里 `[GitHub]` 开头的行。每个响应一行，写着地址、有哪些类型、有哪些 HTML 字段，把这几行发过来就知道 App 用的是什么。
- MITM 了 `api.github.com` 以后，其他用 GitHub 接口的 App 拿到的 Issue、README 也会带译文。
- 用 Google 兜底时译文里行内代码的格式会丢，只剩文字。
- 测试：`node tools/test_github.js`。

## X 去广告、屏蔽中文和翻译

```
https://raw.githubusercontent.com/justyura/surge-modules/main/x.sgmodule
```

X App 和 Safari 里的 x.com 都管，处理 App 的 GraphQL 接口（`api.x.com/graphql/…`、`api.twitter.com/graphql/…`）和网页版的（`x.com/i/api/graphql/…`），推广和中文推文在接口里就删掉，页面上不会闪一下再消失；留下的外文推文加上译文。要开 MITM。脚本是自己写的：`scripts/x.js`。

Surge 一个响应只跑一个脚本，所以去广告、屏蔽中文和翻译放在同一个脚本里。

### 去广告

- 「为你推荐」「正在关注」、列表、搜索里的推广帖
- 推文详情页回复里插的推广
- 推荐关注里的推广账号、趋势里的推广趋势

### 屏蔽中文

- 推文正文是中文的删掉：X 自己标的语言是中文，或者正文里汉字比英文单词多（至少 4 个汉字）。长推文看展开后的全文，转推看被转的那条。
- 带假名、谚文的算日文、韩文，不删；X 标成日文、韩文的也不删。
- 趋势名字是中文的删掉。
- 对话串里的中文回复删掉，英文的留着；整串都是中文就整串删。
- `中文判定` 改成 `strict` 会删得更狠：引用了中文推文、作者名字或简介里有汉字的推文也删（专治名字是中文、发英文的机器人），推荐关注里名字带汉字的账号也删。纯汉字的日文名字会被误伤。
- 这些地方不删：自己点开的那条推文和它上面的串、个人主页、用中文搜索的结果、白名单里的账号。

### 翻译

- 推文正文后面空一行接上译文。长推文翻全文，译文在全文最后，时间线上要点「显示更多」才看得到。转推翻被转的那条，引用的推文也翻。
- X 标的语言已经是目标语言的不翻，纯链接、纯表情、只有 @ 或话题的不翻。日文、韩文照翻。
- 推文少时一个 DeepL 请求翻完，多时拆成最多 6 个请求同时翻。翻过的缓存最近 500 条，刷新、翻回来都不再花额度。
- 最多等 4 秒（参数「最长等待」），没翻完的显示原文，广告和中文照样删掉。刷新一下会接着翻。
- 不填 DeepL 密钥也能用：备用翻译是 `google` 时直接用 Google 翻译。
- DeepL key 可以和「YouTube 双语字幕」「Reddit 去广告和翻译」填一样的，哪个 key 被暂停几个模块共用。
- 不想翻译把「翻译」改成 `off`。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 屏蔽中文 | true | false 只去广告 |
| 中文判定 | normal | normal 只看正文；strict 再看引用、作者名字和简介 |
| 白名单 | 占位文字 | 不删的账号，填 @ 后面的用户名，多个用 `\|` 分隔 |
| DeepL密钥 | 占位文字 | 一个或多个 key，用 `\|` 分隔 |
| 目标语言 | ZH-HANS | ZH-HANT 繁体，也可以填 EN-US、JA、KO 等 |
| 翻译 | all | off 不翻译 |
| 备用翻译 | google | off 表示不用 Google 兜底 |
| 最长等待 | 4 | 最多等几秒翻译 |
| 调试日志 | false | true 打印每个接口删了哪些条目、翻了几条 |

### 需要知道的

- 装好后把 X App 从后台划掉再打开。脚本按网页版的响应写的，不按固定路径找条目，App 的结构差不多就能用，但还没对着真机核对过。
- App 里没效果时，打开「调试日志」刷新一下，看 Surge 日志里 `[X]` 开头的几行：
  - 一行都没有：请求没被解密。看 Surge「最近请求」里 `api.x.com` 的请求有没有被 MITM，有没有握手失败。
  - `不是 JSON`：App 这个接口返回的不是 JSON，脚本处理不了。
  - `没找到带 entryId 的条目，响应的结构：…`：结构和网页版不一样，把这行发出来照着改。
  - `没删东西`：结构认得，但这一页正好没有广告和中文。
- 如果 X App 加载不出来，说明 App 不认 MITM 证书，先关掉这个模块。
- 网页上的「打开 App」弹窗由「网页弹窗和广告拦截」管，两个一起装不冲突。
- 网页版第一次装好后，在 Safari 设置里清一下 x.com 的网站数据，不然旧缓存里的推文还会出来。
- 不按固定路径找，整个响应里带 `entryId` 的条目都看，X 改了外层字段名也照样能用。
- 网页显示推文用的是 `full_text` 里 `display_text_range` 那一段，译文插在这一段末尾，后面图片链接的下标跟着往后挪，所以图片、链接、@ 都还能点。
- 测试：`node tools/test_x.js`。

## 规矩

- 地址、token、订阅链接一律走 `#!arguments`，不写死在模块里。
- 新增模块时，在上面的表格里加一行，再补一节说明。
- 去广告规则改 `ads/`，改完跑 `python3 tools/build.py`。
