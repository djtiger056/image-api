# images-api 项目深度分析 & 账号管理器改造方案

> 生成日期: 2025-05-27

---

## 一、项目概述

images-api 是一个多平台逆向 API 统一服务，将即梦(Jimeng)、可灵(Kling)、豆包(Doubao)、
小云雀(XYQ)、通义千问(Qwen) 五大AI图片/视频生成平台的接口聚合为 **OpenAI 兼容 API**。

### 核心能力矩阵

| 平台   | 文生图 | 图生图 | 视频生成        | 免费额度     |
|--------|--------|--------|-----------------|-------------|
| 即梦   | ✅     | ✅     | ✅ Seedance 2.0 | 需登录      |
| 可灵   | ✅     | ✅     | -               | 网页模式免费 |
| 豆包   | ✅     | -      | ✅ Seedance 2.0 | 每日10次    |
| 小云雀 | ✅     | -      | ✅              | 需登录      |
| 通义   | -      | -      | ✅              | 免费        |

---

## 二、技术架构

### 技术栈
- 语言: TypeScript 5.3 (ESM + CJS)
- 运行时: Node.js >= 18
- Web 框架: Koa 2 + koa-router
- 浏览器自动化: playwright-core (Chromium)
- 加密签名: X-Bogus / X-Gnarly (纯算法实现，无需浏览器)
- 构建工具: tsup (esbuild)

### 架构图
```
客户端(OpenAI兼容) → Koa Server → Routes → Providers → 上游平台API
                                ↓
                    ┌──────────────────────────┐
                    │  Jimeng Provider (逆向API) │
                    │  Kling Provider (网页模式)  │
                    │  Doubao Provider           │
                    │  XYQ Provider              │
                    │  Qwen Provider             │
                    │  Seedream 统一Provider     │
                    └──────────────────────────┘
```

### API 端点

| 端点                                    | 方法 | 功能            |
|----------------------------------------|------|-----------------|
| /v1/images/generations                 | POST | 文生图/图生图    |
| /v1/images/compositions                | POST | 图生图(文件上传) |
| /v1/videos/generations                 | POST | 视频生成         |
| /v1/videos/generations/async           | POST | 异步视频生成     |
| /v1/doubao/videos/generations          | POST | 豆包视频生成     |
| /v1/doubao/videos/generations/stream   | POST | 豆包视频流式     |
| /v1/chat/completions                   | POST | OpenAI对话格式   |
| /v1/models                             | GET  | 可用模型列表     |
| /token/check                           | POST | Token有效性检查  |
| /token/points                          | POST | 查询账户积分     |
| /ping                                  | GET  | 健康检查         |
| /console                               | GET  | Web管理面板      |

---

## 三、认证机制分析

### 当前认证流程
1. 每个平台使用各自的 `sessionid` cookie 作为 Bearer Token
2. 支持多账号逗号分隔: `token1,token2,token3`
3. 多 Token 随机轮询 (`_.sample(tokens)`)
4. Token 前缀自动识别区域 (us-/sg-/hk- → 国际版, 无前缀 → 国内版)

### 认证优先级链
```
请求头 Authorization > 环境变量 JIMENG_AUTHORIZATION > 环境变量 JIMENG_SESSIONID
```

### 现有配置文件 (local.env)
```
JIMENG_SESSIONID=          # 即梦sessionid
DOUBAO_SESSIONID=          # 豆包sessionid
KLING_ACCESS_KEY=          # 可灵API密钥
KLING_SECRET_KEY=          # 可灵API密钥
XYQ_SESSIONID=             # 小云雀sessionid
SERVER_API_KEYS=           # 对外API密钥
```

---

## 四、账号管理器改造方案

### 4.1 目标
将 images-api 从"单人工具"改造为"多账号管理中心"，支持：
- 多平台多账号统一管理
- 外部 API 调用模式 (RESTful + API Key 鉴权)
- 账号轮询、负载均衡、自动失效检测
- 积分/配额监控与告警

### 4.2 架构设计

```
┌─────────────────────────────────────────────────────┐
│                  账号管理器 (Account Manager)          │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐       │
│  │ 即梦账号池  │  │ 豆包账号池  │  │ 可灵账号池  │      │
│  │ account.json│  │ account.json│  │ account.json│    │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘       │
│        │              │              │              │
│  ┌─────▼──────────────▼──────────────▼─────┐       │
│  │         统一调度层 (Dispatcher)           │       │
│  │  - Token 健康检查                         │       │
│  │  - 积分/配额监控                          │       │
│  │  - 负载均衡 (轮询/随机/最少使用)          │       │
│  │  - 失败自动切换                           │       │
│  └────────────────┬────────────────────────┘       │
│                   │                                │
│  ┌────────────────▼────────────────────────┐       │
│  │         外部 API 层 (External API)       │       │
│  │  - RESTful 接口                          │       │
│  │  - API Key 鉴权                          │       │
│  │  - 速率限制                              │       │
│  │  - 使用统计                              │       │
│  └─────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────┘
```

### 4.3 账号数据结构设计

文件: `configs/accounts.json`

```json
{
  "accounts": {
    "jimeng": [
      {
        "id": "jimeng-01",
        "name": "即梦主号",
        "sessionid": "xxx",
        "authorization": "",
        "status": "active",
        "last_check": "2025-05-27T00:00:00Z",
        "points": { "free": 66, "paid": 0, "vip": false },
        "daily_usage": 0,
        "max_daily_usage": 50,
        "tags": ["primary", "high-quota"],
        "priority": 10,
        "created_at": "2025-05-27",
        "notes": "主力账号"
      },
      {
        "id": "jimeng-02",
        "name": "即梦备用号",
        "sessionid": "yyy",
        "status": "active",
        "priority": 5,
        "tags": ["backup"]
      }
    ],
    "doubao": [
      {
        "id": "doubao-01",
        "name": "豆包号",
        "sessionid": "zzz",
        "status": "active",
        "priority": 10,
        "daily_limit": 10
      }
    ],
    "kling": [
      {
        "id": "kling-01",
        "name": "可灵API",
        "access_key": "ak_xxx",
        "secret_key": "sk_xxx",
        "mode": "api",
        "status": "active",
        "priority": 10
      },
      {
        "id": "kling-02",
        "name": "可灵网页模式",
        "cookies_json_path": "./configs/kling.json",
        "mode": "web",
        "status": "active",
        "priority": 5
      }
    ],
    "xyq": [
      {
        "id": "xyq-01",
        "name": "小云雀号",
        "sessionid": "aaa",
        "status": "active",
        "priority": 10
      }
    ]
  },
  "api_keys": [
    {
      "key": "sk-proj-xxx",
      "name": "外部客户端A",
      "rate_limit": "100/hour",
      "allowed_platforms": ["jimeng", "doubao"],
      "created_at": "2025-05-27"
    },
    {
      "key": "sk-proj-yyy",
      "name": "内部服务",
      "rate_limit": "unlimited",
      "allowed_platforms": ["*"]
    }
  ],
  "settings": {
    "health_check_interval": 300000,
    "auto_receive_daily_credits": true,
    "failover_strategy": "priority",
    "rotation_strategy": "weighted-random"
  }
}
```

### 4.4 外部 API 调用模式

#### 4.4.1 OpenAI 兼容模式 (已有)
```bash
# 使用 API Key 鉴权
curl -X POST http://localhost:8000/v1/images/generations \
  -H "x-api-key: sk-proj-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jimeng-5.0",
    "prompt": "美丽的日落风景",
    "ratio": "16:9"
  }'
```

#### 4.4.2 多账号管理 API (新增)

```
# 账号管理
GET    /admin/accounts                 # 列出所有账号
POST   /admin/accounts                 # 添加账号
PUT    /admin/accounts/:id             # 更新账号
DELETE /admin/accounts/:id             # 删除账号
POST   /admin/accounts/:id/check       # 检查账号状态
POST   /admin/accounts/:id/credits     # 查询积分

# 统计监控
GET    /admin/stats/usage              # 使用统计
GET    /admin/stats/health             # 账号健康度
GET    /admin/stats/credits            # 积分总览

# API Key 管理
GET    /admin/api-keys                 # 列出 API Keys
POST   /admin/api-keys                 # 创建 API Key
DELETE /admin/api-keys/:id             # 删除 API Key
```

#### 4.4.3 外部调用示例 (Python)

```python
import requests

API_BASE = "http://localhost:8000"
API_KEY = "sk-proj-xxx"

headers = {
    "x-api-key": API_KEY,
    "Content-Type": "application/json"
}

# 文生图
def generate_image(prompt, model="jimeng-5.0", ratio="16:9"):
    resp = requests.post(f"{API_BASE}/v1/images/generations",
        headers=headers,
        json={"model": model, "prompt": prompt, "ratio": ratio}
    )
    return resp.json()

# 视频生成
def generate_video(prompt, model="seedance-2.0"):
    resp = requests.post(f"{API_BASE}/v1/videos/generations",
        headers=headers,
        json={"model": model, "prompt": prompt}
    )
    return resp.json()

# 豆包生图 (指定平台)
def generate_doubao_image(prompt):
    resp = requests.post(f"{API_BASE}/v1/images/generations",
        headers=headers,
        json={"model": "doubao-seedream-4.5", "prompt": prompt}
    )
    return resp.json()

# 查看可用模型
def list_models():
    resp = requests.get(f"{API_BASE}/v1/models", headers=headers)
    return resp.json()
```

### 4.5 账号轮询策略

| 策略           | 说明                                   |
|---------------|---------------------------------------|
| random        | 随机选择 (当前默认)                     |
| round-robin   | 严格轮询                               |
| least-used    | 选择当日使用次数最少的账号               |
| priority      | 按优先级排序，高优先级账号优先            |
| weighted-random | 按优先级权重随机 (推荐)                |

### 4.6 实现路径

**Phase 1 - 账号池管理 (最小可行)**
1. 创建 `configs/accounts.json` 账号配置文件
2. 编写 `AccountManager` 类读取配置
3. 修改 `service-authorization.js` 支持从账号池获取 Token
4. 修改 `core.ts` 的 `tokenSplit()` 从账号池获取活跃 Token 列表

**Phase 2 - 健康检查与积分监控**
1. 添加定时任务检查所有账号有效性 (调用 `/token/check`)
2. 定时查询积分 (调用 `/token/points`)
3. 积分不足时自动切换账号并告警
4. Web 控制台展示账号状态面板

**Phase 3 - 外部 API 层**
1. 添加 API Key 中间件 (已有基础)
2. 实现速率限制 (rate limiting)
3. 添加使用统计记录
4. 生成 API 文档 (Swagger/OpenAPI)

**Phase 4 - 高级功能**
1. 失败自动重试 + 账号切换
2. 积分自动领取
3. Webhook 通知 (积分不足/账号失效)
4. 批量任务队列

---

## 五、Windows 本地部署指南

### 5.1 环境要求
- Node.js >= 18 (已安装 v24.12.0)
- npm (已安装 v11.13.0)
- Chrome 浏览器 (已安装)

### 5.2 项目路径
```
E:\MyProject\hermescodes\image-api
```

### 5.3 启动方式
```bash
cd E:\MyProject\hermescodes\image-api
npm run build
npm start
```

### 5.4 Windows 注意事项
1. 环境变量通过 `local.env` 文件配置 (非 systemd)
2. 浏览器路径: `C:\Program Files\Google\Chrome\Application\chrome.exe`
3. 不支持 systemd 服务托管，建议使用 PM2 或直接运行
4. Seedance/Kling 网页模式需要 Playwright 浏览器，首次运行自动安装

### 5.5 使用 PM2 管理 (推荐)
```bash
npm install -g pm2
pm2 start npm --name "images-api" -- start
pm2 save
pm2 startup  # 开机自启
```

---

## 六、安全建议

1. **API Key 管理**: 不要在代码中硬编码 API Key，使用环境变量
2. **网络隔离**: 建议仅监听 localhost，通过 Nginx 反向代理暴露
3. **Session ID 定期更新**: 各平台的 sessionid 有有效期，需定期更新
4. **日志脱敏**: 请求日志中不要记录完整的 Token/SessionID
5. **HTTPS**: 生产环境务必使用 HTTPS
