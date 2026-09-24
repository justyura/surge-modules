# surge-modules

自己用的 Surge 模块。

## 模块列表

| 模块 | 作用 | 安装链接 |
| --- | --- | --- |
| 代理流量面板 | 在面板里显示剩余流量、已用比例、到期日期和重置时间 | `https://raw.githubusercontent.com/justyura/surge-modules/main/usage-pane.sgmodule` |

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

## 规矩

- 地址、token、订阅链接一律走 `#!arguments`，不写死在模块里。
- 新增模块时，在上面的表格里加一行，再补一节说明。
