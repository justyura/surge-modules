# surge-modules

自己用的 Surge 模块。

## 模块列表

| 模块 | 作用 | 安装链接 |
| --- | --- | --- |
| 代理流量面板 | 在面板里显示剩余流量、已用比例、到期日期和重置时间 | `https://raw.githubusercontent.com/justyura/surge-modules/main/usage-pane.sgmodule` |
| App 去广告 | 每个 App 一个模块，见下面「App 去广告」 | `ads/` 目录 |

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

## App 去广告

每个 App 一个模块，用哪个装哪个。不只开屏，App 里面信息流、详情页、搜索页、弹窗的广告也一起去掉。

| App | 去掉什么 | 安装链接 |
| --- | --- | --- |
| 哔哩哔哩 | 开屏、首页推荐、动态、视频页、评论区、直播、搜索 | `https://raw.githubusercontent.com/justyura/surge-modules/main/ads/bilibili.sgmodule` |
| 小红书 | 开屏、首页和关注页信息流、搜索页、详情页 | `https://raw.githubusercontent.com/justyura/surge-modules/main/ads/xiaohongshu.sgmodule` |
| 微博 | 开屏、信息流、热搜、发现页、超话、详情页、评论区，含轻享版 | `https://raw.githubusercontent.com/justyura/surge-modules/main/ads/weibo.sgmodule` |
| 知乎 | 开屏、首页推荐、热榜、回答页、评论区、搜索页、会员页 | `https://raw.githubusercontent.com/justyura/surge-modules/main/ads/zhihu.sgmodule` |
| 闲鱼 | 开屏、首页信息流、同城页、搜索页、消息页、我的页面 | `https://raw.githubusercontent.com/justyura/surge-modules/main/ads/xianyu.sgmodule` |
| 淘宝 | 开屏、首页二楼、弹窗、各类广告接口 | `https://raw.githubusercontent.com/justyura/surge-modules/main/ads/taobao.sgmodule` |
| 京东 | 开屏、首页悬浮和通栏推广、我的页面、订单页、直播小窗 | `https://raw.githubusercontent.com/justyura/surge-modules/main/ads/jd.sgmodule` |
| 美团 / 美团外卖 | 外卖开屏、广告素材、广告和统计域名 | `https://raw.githubusercontent.com/justyura/surge-modules/main/ads/meituan.sgmodule` |
| 饿了么 | 开屏图片和视频、广告和统计域名 | `https://raw.githubusercontent.com/justyura/surge-modules/main/ads/eleme.sgmodule` |
| 拼多多 | 开屏、首页弹窗、快递页红包商品 | `https://raw.githubusercontent.com/justyura/surge-modules/main/ads/pinduoduo.sgmodule` |
| 高德地图 | 开屏、启动广告、增值推广、广告和统计域名 | `https://raw.githubusercontent.com/justyura/surge-modules/main/ads/amap.sgmodule` |

### 安装

1. Surge 里进 MITM，生成证书并安装，再去 iOS 设置 → 通用 → 关于本机 → 证书信任设置里打开信任，最后打开 MITM。
2. 装你要的 App 对应的模块。
3. 把 App 从后台划掉再打开。还有广告就清一下 App 缓存，或者删了重装。

哔哩哔哩模块有几个参数可以调：动态最常访问、创作中心、过滤置顶评论广告、日志等级，在模块参数里改。

### 脚本放在哪

模块用到的脚本都存了一份在本仓库 `scripts/vendor/`，不直接引用别人的仓库。好处是上游改了什么不会悄悄跑到手机上；代价是要手动更新，步骤见 [scripts/vendor/README.md](scripts/vendor/README.md)。

### 来源

- [kokoryh/Sparkle](https://github.com/kokoryh/Sparkle)（GPL-3.0）：哔哩哔哩
- [fmz200/wool_scripts](https://github.com/fmz200/wool_scripts)（GPL-3.0）：其他所有 App

规则基本照搬上游，去掉了跟去广告无关的部分：去水印、解除下载限制、换皮肤、解锁会员图标、外链跳转、P2P 屏蔽、空降助手。

### 失效了怎么办

App 更新后接口会变。先去上游看有没有新规则，有的话照着改模块、重新复制脚本。

## 规矩

- 地址、token、订阅链接一律走 `#!arguments`，不写死在模块里。
- 新增模块时，在上面的表格里加一行，再补一节说明。
