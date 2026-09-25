# surge-modules

自己用的 Surge 模块。

## 模块列表

| 模块 | 作用 | 安装链接 |
| --- | --- | --- |
| 代理流量面板 | 在面板里显示剩余流量、已用比例、到期日期和重置时间 | `https://raw.githubusercontent.com/justyura/surge-modules/main/usage-pane.sgmodule` |
| 国内 App 开屏去广告 | 去掉哔哩哔哩、小红书、微博、知乎的开屏广告 | `https://raw.githubusercontent.com/justyura/surge-modules/main/splash-ads.sgmodule` |

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

## 国内 App 开屏去广告

### 安装

1. Surge 里进 MITM，生成证书并安装，再去 iOS 设置 → 通用 → 关于本机 → 证书信任设置里打开信任，最后打开 MITM。
2. 安装上面的链接。
3. 把 App 从后台划掉再打开。还有广告就清一下 App 缓存，或者删了重装。

### 覆盖范围

| App | 怎么去的 |
| --- | --- |
| 哔哩哔哩 | 脚本清空开屏列表、开屏展示和活动开屏 |
| 小红书 | 拦截广告 CDN，脚本把开屏广告的时间改到 2090 年 |
| 微博 | 拦截预加载域名，实时开屏返回空数据，脚本清空客户端缓存的开屏 |
| 知乎 | 开屏接口直接返回空数据 |

只管开屏，信息流、评论区这些里的广告不管。要全套净化，直接装下面这些项目的完整模块。

### 来源

规则和脚本来自这几个一直在更新的项目，脚本直接引用它们的地址，上游改了这边自动跟上：

- [kokoryh/Sparkle](https://github.com/kokoryh/Sparkle)：哔哩哔哩
- [fmz200/wool_scripts](https://github.com/fmz200/wool_scripts)：小红书、微博、知乎
- [zmqcherish/proxy-script](https://github.com/zmqcherish/proxy-script)：微博

App 更新后接口可能变，失效了先去上游看有没有新规则。

## 规矩

- 地址、token、订阅链接一律走 `#!arguments`，不写死在模块里。
- 新增模块时，在上面的表格里加一行，再补一节说明。
