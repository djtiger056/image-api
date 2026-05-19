# Kling + Jimeng Compatible API Server

项目目录：`/myproject/kling-api`

这是一个本地 HTTP API 服务，统一封装：
- Jimeng 图像 / 视频 / chat 能力
- Kling 官方图片 API
- Kling 网页免费额度模式（实验性，基于浏览器自动化）

当前状态：
- Kling 官方 API 模式：可用，稳定性更高
- Kling 网页模式：已跑通真实任务，支持同步 / 异步 / 结果轮询 / 基础持久化
- Jimeng 相关接口：保留原有能力，并支持服务端凭证回退

如果你只是想直接跑起来，先看：
- `docs/kling-web-quickstart.md`
- `local.env.example`
- `scripts/start-local.sh`

## 1. 已支持的核心能力

### Kling
- `POST /v1/images/generations`
  - 统一请求体：`model: kling-*`
  - 原生请求体：`model_name: kling-*`
- `GET /v1/images/generations`
- `GET /v1/images/generations/:id`
- `POST /v1/images/multi-image2image`
- `GET /v1/images/multi-image2image/:id`

### Jimeng
- `POST /v1/images/generations`
- `POST /v1/images/compositions`
- `POST /v1/videos/generations`
- `POST /v1/videos/generations/async`
- `GET /v1/videos/generations/async/:taskId`
- `POST /v1/chat/completions`

### 通用
- `GET /v1/models`
- `GET /ping`
- 可选 `x-api-key` 服务端鉴权

## 2. Kling 调用方式

### 唯一链路：网页模式
当前仓库里的 Kling 路径只保留网页模式，不再提供官方 API 通道。

启用方式：
- `provider_options.transport=web`
- 或环境变量 `KLING_AUTH_MODE=web`

网页登录态来源优先级：
1. 请求内 `provider_options.storage_state / cookies`
2. 环境变量 `KLING_WEB_STORAGE_STATE_JSON / KLING_WEB_STORAGE_STATE_PATH / KLING_WEB_COOKIES_JSON_PATH`
3. 项目根目录 `./kling.json`

已支持：
- 同步返回结果
- 异步提交任务
- `GET /v1/images/generations/:id` 查询网页任务
- `KLING_WEB_TASKS_STATE_PATH` 落盘后，服务重启后仍可查询已完成 / 已失败任务
- 历史图基线过滤与结果 URL 去重

已知限制：
- 本质仍是浏览器自动化，页面改版、登录失效、验证码、风控都会影响稳定性
- ratio / resolution / n / 模型切换等网页控件映射还不完整
- 更适合做补充链路，不建议单独当唯一主链路

## 3. 快速开始

### 3.1 准备环境

```bash
cd /myproject/kling-api
cp local.env.example local.env
npm install
```

确认 Chrome 存在：

```bash
which google-chrome-stable
```

预期：

```bash
/usr/bin/google-chrome-stable
```

### 3.2 配置 `local.env`

最常用字段见 `local.env.example`。

当前 Kling 只走网页模式，常见配置是：

- `KLING_AUTH_MODE=web`
- `KLING_WEB_TARGET_URL=https://klingai.com/app/image/new`
- 准备好 `./kling.json`，或在环境变量里指定 storage state / cookies 文件

如果要把服务作为你自己的对外 API：
- 配 `SERVER_API_KEYS=***`
- 客户端请求时统一传 `x-api-key`

如果还要保留 Jimeng 能力，并且不想每次客户端都传 Jimeng Authorization：
- 可在服务端配置 `JIMENG_AUTHORIZATION` 或 `JIMENG_SESSIONID`
- 服务会优先用请求头 `Authorization`，缺失时再回退服务端凭证

### 3.3 启动服务

```bash
cd /myproject/kling-api
./scripts/start-local.sh
```

默认端口：`18080`

检查服务：

```bash
curl http://127.0.0.1:18080/ping
curl http://127.0.0.1:18080/v1/models
```

## 4. 调用示例

### 4.1 Kling 网页模式：统一接口

```bash
curl -X POST http://127.0.0.1:18080/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "kling-v2-1",
    "prompt": "一只在霓虹雨夜里的小狐狸，电影感，高清插画",
    "async": true,
    "provider_options": {
      "transport": "web",
      "target_url": "https://klingai.com/app/image/new"
    }
  }'
```

### 4.2 Kling 网页模式：异步提交

如果服务端已配置好 `KLING_AUTH_MODE=web` 且根目录有 `kling.json`，可以直接：

```bash
curl -X POST http://127.0.0.1:18080/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "kling-v2-1",
    "prompt": "一只戴透明雨衣的小狐狸站在霓虹雨夜街头，单主体，细节丰富",
    "async": true,
    "provider_options": {
      "transport": "web",
      "target_url": "https://klingai.com/app/image/new"
    }
  }'
```

返回里拿到 `task_id` 后继续查询：

```bash
curl http://127.0.0.1:18080/v1/images/generations/<task_id>
```

### 4.3 带 `x-api-key`

```bash
curl -X POST http://127.0.0.1:18080/v1/images/generations \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: your-api-key' \
  -d '{
    "model": "kling-v2-1",
    "prompt": "a cute fox in neon rain",
    "async": true
  }'
```

## 5. 调试与排障

Kling 网页模式每次运行会产出调试文件，默认在：

```bash
./tmp/kling-web-provider/
```

常见文件：
- `01-loaded.png`
- `02-result.png`
- `summary.json`
- `traffic.json`
- `error.json`

常见问题：

1) 网页模式提示登录失效
- 优先检查 `kling.json` 是否过期
- 检查 cookies 域名是否匹配目标站点
- 国内网页登录态建议配国内站：`https://klingai.com/app/image/new`

2) 服务已启动但生图失败
- 先看任务目录下的 `error.json` / `traffic.json` / `02-result.png`

3) 查询旧网页任务时报错
- 如果希望重启后仍可查，配置 `KLING_WEB_TASKS_STATE_PATH`
- 只有已落盘的任务能跨重启查询；重启前未完成任务会被标记为失败

## 6. 文档索引

- Kling 网页模式快速使用：`docs/kling-web-quickstart.md`
- 2026-04-21 网页模式进度：`docs/2026-04-21-kling-web-mode-progress.md`
- 2026-04-22 API 转发可行性结论：`docs/2026-04-22-kling-api-forwarding-feasibility.md`
- 兼容收口说明：`docs/kling-compat.md`

## 7. 当前建议

如果你要长期对外提供服务，建议：
- 网页模式 = 唯一 Kling 链路

如果你只是想复用网页登录态和免费额度，网页模式现在已经能用，但要接受它仍是实验性能力。
