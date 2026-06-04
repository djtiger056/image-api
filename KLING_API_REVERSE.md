# Kling AI 网页端 API 逆向分析

> 抓包日期: 2026-05-28
> 域名: klingai.com (旧域名，已迁移至 kling.ai)
> 模型: 图片 3.0

## 1. 发起图片生成

```
POST /api/task/submit?__NS_hxfalcon=<token>&caver=2
Content-Type: application/json
Cookie: (登录态 cookies)
```

### 请求体
```json
{
  "type": "mmu_img_aiweb",
  "inputs": [],
  "arguments": [
    {"name": "prompt",          "value": "a red rose"},
    {"name": "rich_prompt",     "value": "a red rose"},
    {"name": "skill",           "value": ""},
    {"name": "kolors_version",  "value": "3.0"},
    {"name": "__isUnLimited",   "value": false},
    {"name": "img_resolution",  "value": "2k",     "setByUser": false},
    {"name": "aspect_ratio",    "value": "3:4",    "setByUser": false},
    {"name": "imageCount",      "value": "2",      "setByUser": false},
    {"name": "source",          "value": ""},
    {"name": "paymentMode",     "value": 1},
    {"name": "showPrice",       "value": 200}
  ],
  "callbackPayloads": [
    {"name": "settingKeys", "value": "img_resolution|aspect_ratio|imageCount"},
    {"name": "imageMasks",  "value": "", "resources": []},
    {"name": "subjects",    "value": "[]"}
  ]
}
```

### 关键参数说明
| 参数 | 说明 | 示例值 |
|------|------|--------|
| type | 任务类型，固定值 | `mmu_img_aiweb` |
| kolors_version | 模型版本 | `3.0`, `2.1`, `2.0`, `1.5` |
| img_resolution | 分辨率 | `2k`, `1k` |
| aspect_ratio | 宽高比 | `3:4`, `1:1`, `16:9`, `9:16` |
| imageCount | 生成数量 | `"1"`, `"2"`, `"3"`, `"4"` (字符串!) |
| prompt | 正向提示词 | 自然语言 |
| rich_prompt | 带标签的提示词 | 同 prompt |
| skill | 风格/技能 | 空字符串或风格ID |
| paymentMode | 支付模式 | 1=积分 |
| __NS_hxfalcon | 反爬 token | 长字符串，每次不同 |

## 2. 查询任务状态

```
GET /api/task/status?__NS_hxfalcon=<token>&caver=2&taskId=<taskId>
```

返回任务当前状态。

## 3. 获取生成结果（轮询）

```
GET /api/user/works/personal/feeds?__NS_hxfalcon=<token>&caver=2
  &pageSize=20
  &contentType=
  &favored=false
  &pageDirection=PRE
  &pageTime=<timestamp>
  &extra=BASE_WORK
```

### 轮询逻辑
- 带 `taskId` 参数时查询特定任务
- 带 `contentType=omni` 过滤 Omni 类型
- `pageSize=1` 单条查询
- 轮询间隔约 1.5s

### 响应中的图片 URL 格式
从 response JSON 中提取: `work.resource.resource`, `work.cover.resource`, `payload.coverList[].resource`

## 4. 其他辅助接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/user/isLogin` | GET | 检查登录状态 |
| `/api/user/profile_and_features` | GET | 用户信息 |
| `/api/homepage/unread_works` | GET | 未读作品 |
| `/api/notify/has_new` | GET | 通知检查 |
| `/api/account/pointAndTicket` | GET | 积分/票据 |
| `/api/tags` | GET | 标签列表 |
| `/api/elements/search` | GET | 元素搜索 |
| `/api/notix/channel/sse-push/connect/` | GET | SSE 实时推送 |

## 5. 反爬机制

- **__NS_hxfalcon token**: 每个请求 URL 都带一个长加密 token，由前端 JS 生成
- **caver=2**: 版本号参数
- **Cookie 鉴权**: 需要完整的登录 cookie
- **XHR**: 请求走 XMLHttpRequest，非 fetch
- **域名迁移**: klingai.com → kling.ai (新域名 API 路径可能不同)
