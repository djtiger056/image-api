# images-api

多平台逆向 API 统一生图/视频服务 — 封装 Jimeng（即梦）、Kling（可灵）、Doubao（豆包）、XYQ（小云雀）、Qwen（通义千问）五大平台，提供 OpenAI 兼容格式接口。

## 功能一览

| 平台 | 文生图 | 图生图 | 视频生成 | 免费额度 |
|------|--------|--------|----------|----------|
| Jimeng | ✅ | ✅ | ✅ (含 Seedance 2.0) | 需登录 |
| Kling | ✅ (官方 API + 网页模式) | ✅ | - | 网页模式免费 |
| Doubao | ✅ (Seedream 4.5/4.0/3.0) | - | ✅ (Seedance 2.0 Fast) | 每日10次 |
| XYQ | ✅ (Seedream 5.0/4.5/4.0) | - | ✅ | 需登录 |
| Qwen | - | - | ✅ | 免费 |

## 快速部署

```bash
git clone https://github.com/djtiger056/image-api.git
cd image-api
bash scripts/setup.sh        # 一键安装依赖+构建+浏览器+systemd
vi local.env                 # 填写平台凭证
sudo systemctl start images-api
curl http://127.0.0.1:8000/ping
```

详细部署文档见 [DEPLOY.md](DEPLOY.md)。

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/images/generations` | POST | 文生图 / 图生图 |
| `/v1/images/compositions` | POST | 图生图（文件上传） |
| `/v1/videos/generations` | POST | 视频生成（含 Seedance 2.0） |
| `/v1/videos/generations/async` | POST | 异步视频生成（提交任务） |
| `/v1/videos/generations/async/:taskId` | GET | 异步视频生成（查询结果） |
| `/v1/doubao/videos/generations` | POST | 豆包视频生成 |
| `/v1/doubao/videos/generations/stream` | POST | 豆包视频生成（SSE 流式） |
| `/v1/chat/completions` | POST | OpenAI 兼容对话接口 |
| `/v1/models` | GET | 可用模型列表 |
| `/token/check` | POST | Token 有效性检查 |
| `/token/points` | POST | 账户积分查询 |
| `/ping` | GET | 健康检查 |

## 调用示例

### 文生图

```bash
curl -X POST http://127.0.0.1:8000/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的jimeng_sessionid" \
  -d '{
    "model": "jimeng-4.5",
    "prompt": "美丽的日落风景，湖边的小屋",
    "ratio": "16:9",
    "resolution": "2k"
  }'
```

### 豆包生图

```bash
curl -X POST http://127.0.0.1:8000/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的doubao_sessionid" \
  -d '{
    "model": "doubao-seedream-4.5",
    "prompt": "赛博朋克风格的城市夜景"
  }'
```

### 视频生成

```bash
curl -X POST http://127.0.0.1:8000/v1/videos/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的jimeng_sessionid" \
  -d '{
    "model": "jimeng-video-3.5-pro",
    "prompt": "一只小猫在花园里追逐蝴蝶"
  }'
```

### 豆包 / 千问视频

```bash
curl -X POST http://127.0.0.1:8000/v1/doubao/videos/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的doubao_sessionid" \
  -d '{
    "model": "doubao-seedance-2.0-fast",
    "prompt": "一只小猫在草地上欢快地奔跑",
    "ratio": "16:9",
    "duration": 5
  }'
```

```bash
curl -X POST http://127.0.0.1:8000/v1/qwen/videos/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的qwen_cookie" \
  -d '{
    "model": "qwen-happyhorse-1.0",
    "prompt": "一匹马在草原上奔跑",
    "ratio": "16:9",
    "duration": 10
  }'
```

## 认证方式

使用各平台的 `sessionid` Cookie 作为 Bearer Token：

- **Jimeng**: 登录 jimeng.jianying.com → F12 → Application → Cookies → `sessionid`
- **Doubao**: 登录 doubao.com → F12 → Application → Cookies → `sessionid`
- **XYQ**: 登录 xyq.jianying.com → F12 → Application → Cookies → `sessionid`
- **Kling**: 官方 API 使用 AccessKey/SecretKey；网页模式使用登录态 JSON

多账号支持：逗号分隔多个 sessionid。

## 管理后台

启动后访问 `http://你的IP:8000/console`，可在线管理 Token、测试生图、查看模型列表。

## 项目结构

```
src/
├── index.ts                    # 入口
├── api/
│   ├── controllers/            # 业务逻辑（images, videos, chat, core）
│   ├── routes/                 # API 路由定义
│   └── consts/                 # 异常定义
├── lib/
│   ├── server.ts               # Koa 服务器
│   ├── browser-service.ts      # Playwright 浏览器代理（shark 反爬绕过）
│   ├── x-bogus.ts / x-gnarly.ts # 签名算法
│   ├── config.ts               # 配置管理
│   └── ...                     # 日志、工具、中间件
└── providers/
    ├── jimeng/                 # 即梦 provider
    ├── kling/                  # 可灵 provider（API + 网页模式）
    ├── doubao/                 # 豆包 provider
    ├── xyq/                    # 小云雀 provider
    └── seedream/               # 统一 Seedream provider
```

## 技术栈

- **Runtime**: Node.js >= 18
- **Framework**: Koa
- **Language**: TypeScript (tsup 构建)
- **Browser**: Playwright-core (Chromium)
- **部署**: systemd / Docker

## 许可证

ISC
