# Kling API 当前进度（含网页免费额度模式）

日期：2026-04-21
项目目录：`/myproject/kling-api`

## 当前结论

项目现在已经只有一条 Kling 图片链路：

1. 网页登录态模式（实验性）
- 现状：已接入
- 认证：通过网页登录态（`storageState` 或 `cookies.json`）
- 实现方式：Playwright/Chrome 自动打开 Kling 图片页，注入登录态，填写 prompt，点击 Generate，抓取结果图 URL
- 特点：可走网页免费额度，但稳定性弱于纯 HTTP 直连接口

## 这次新增内容

### 新增文件
- `src/providers/kling/web-utils.ts`
- `src/providers/kling/web-automation.ts`

### 主要改动
- `src/providers/kling/image-provider.ts`
  - 改为网页单通道
  - `provider_options.transport=web` 时走网页模式
  - 支持同步返回结果
  - 支持异步提交 + `GET /v1/images/generations/:id` 查询本地 web task 状态
  - 支持“按请求直接传入网页登录凭证”
- `local.env.example`
  - 新增 Kling 网页模式配置项

### 已验证
- `npm run build` 通过
- `npm test` 通过（22/22）
- 已验证：
  - web 同步生图返回 URL
  - web 异步任务可轮询查询结果
  - provider_options 里直传 `storage_state` / `cookies` 可用
  - 请求未内联凭证时，可默认回退读取项目根目录 `./kling.json`
  - 开启 `KLING_WEB_TASKS_STATE_PATH` 后，服务重启后仍可继续查询本地 web task
  - 开启 `SERVER_API_KEYS` 后，除 `/` 和 `/ping` 外，其余接口需要 `x-api-key`
  - Jimeng 图片/聊天/视频/积分相关接口在请求未携带 Authorization 时，可回退使用服务端 `JIMENG_AUTHORIZATION` 或 `JIMENG_SESSIONID`

## 你现在最简单的用法

你不一定要先配环境变量。

现在最简单的是：
直接请求 `POST /v1/images/generations`，把网页登录凭证直接塞到 `provider_options` 里。

### 方式 A：直接传 storage_state

```bash
curl -X POST http://127.0.0.1:18080/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "kling-v2-1",
    "prompt": "a cute fox in neon rain",
    "provider_options": {
      "transport": "web",
      "storage_state": {
        "cookies": [...],
        "origins": []
      }
    }
  }'
```

支持这些别名：
- `storage_state`
- `storageState`
- `storage_state_json`
- `storageStateJson`

如果你传的是 JSON 字符串，也可以。

### 方式 B：直接传 cookies 数组

```bash
curl -X POST http://127.0.0.1:18080/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "kling-v2-1",
    "prompt": "a cute fox in neon rain",
    "provider_options": {
      "transport": "web",
      "cookies": [
        {
          "name": "sessionid",
          "value": "xxx",
          "domain": ".kling.ai",
          "path": "/",
          "httpOnly": true,
          "secure": true,
          "sameSite": "None"
        }
      ]
    }
  }'
```

支持这些别名：
- `cookies`
- `cookies_json`
- `cookiesJson`

### 方式 C：异步提交

```bash
curl -X POST http://127.0.0.1:18080/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "kling-v2-1",
    "prompt": "a cute fox in neon rain",
    "async": true,
    "provider_options": {
      "transport": "web",
      "storage_state": {
        "cookies": [...],
        "origins": []
      }
    }
  }'
```

再查询：
```bash
curl http://127.0.0.1:18080/v1/images/generations/<task_id>
```

## 仍然支持环境变量模式

如果你想长期跑服务，也可以在 `local.env` 里配：

```env
BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
KLING_AUTH_MODE=web
KLING_WEB_STORAGE_STATE_PATH=/your/path/storage-state.json
KLING_WEB_TARGET_URL=https://kling.ai/app/image/new
KLING_WEB_HEADLESS=true
KLING_WEB_WAIT_TIMEOUT_MS=180000
KLING_WEB_RESULT_POLL_INTERVAL_MS=2000
KLING_WEB_ARTIFACTS_DIR=./tmp/kling-web-provider
```

## 当前限制

网页模式目前优先保证“能跑通免费额度链路”，所以先做到：
- prompt 生图
- 可带参考图上传
- 返回结果图 URL
- 支持异步查询
- 支持请求里直传登录凭证

还没完全对齐网页模式全能力的部分：
- 模型切换暂未深度控制页面 UI
- ratio / resolution / n 等页面控件还没做完整自动化映射
- 多图语义化能力还没有为网页模式单独做 UI 层适配
- 页面改版、登录态失效、验证码、风控时仍可能失败

## 调试产物

网页模式每次运行都会在这里留产物：
- `tmp/kling-web-provider/<task_id>/`

常见文件：
- `01-loaded.png`
- `02-result.png`（成功时）
- `error.png`（失败时）
- `summary.json`
- `traffic.json`
- `error.json`

## 建议

网页免费额度模式：
- 适合作为补充链路
- 适合你手里已有登录账号、想复用网页免费额度时使用
- 不建议直接当唯一主链路
