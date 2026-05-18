# kling-api 项目架构与实现说明书

> 版本 v0.9.1 | TypeScript / Koa / Playwright

---

## 一、项目概述

kling-api 是一个本地 HTTP API 服务器，将**即梦 (Jimeng)** 和**可灵 (Kling)** 的图像/视频生成能力封装为 **OpenAI 兼容接口**，使现有 LLM 客户端可直接调用生图/生视频功能，无需对接官方 SDK。

核心价值：
- 统一入口：一个服务同时覆盖即梦（文生图、图生图、视频、Seedance）和可灵（网页模式免费额度）
- OpenAI 兼容：`/v1/chat/completions`、`/v1/images/generations` 等端点可无缝接入现有客户端
- 国内外双链路：自动识别 Token 前缀（`sg-`/`hk-`/`us-` 等），路由到国内版或国际版后端
- 反爬绕过：纯算法实现 X-Bogus / X-Gnarly 签名，以及 Playwright 浏览器代理模式

---

## 二、技术栈

| 层面 | 技术 |
|------|------|
| 语言 | TypeScript 5.3 |
| 运行时 | Node.js (ESM + CJS 双格式) |
| 构建工具 | tsup (esbuild 驱动) |
| Web 框架 | Koa 2 + koa-router |
| HTTP 客户端 | axios + 原生 fetch + undici (代理) |
| 浏览器自动化 | playwright-core + Chromium |
| 加密/签名 | Node crypto (MD5, HMAC-SHA256, ChaCha20, RC4, CRC32) |
| 配置管理 | YAML (yaml 库) + 环境变量 |
| 容器化 | Docker 多阶段构建 + Playwright Chromium |

---

## 三、整体架构图

```
                        ┌─────────────────────────────────────┐
                        │           客户端 (OpenAI 兼容)         │
                        └──────────────┬──────────────────────┘
                                       │ HTTP
                        ┌──────────────▼──────────────────────┐
                        │           Koa Server (lib/server.ts) │
                        │  CORS → 自定义 JSON 解析 → koa-body   │
                        │  API Key 校验 → 异常拦截               │
                        └──────────────┬──────────────────────┘
                                       │
                        ┌──────────────▼──────────────────────┐
                        │         Routes (api/routes/)         │
                        │  images | videos | chat | models ... │
                        └──┬────────────────────┬──────────────┘
                           │                    │
              ┌────────────▼─────┐  ┌───────────▼─────────────┐
              │  Jimeng Provider  │  │   Kling Provider         │
              │  (controllers/)   │  │   (providers/kling/)     │
              │                   │  │                          │
              │  ┌─────────────┐  │  │  ┌────────────────────┐  │
              │  │ core.ts     │  │  │  │ web-automation.ts  │  │
              │  │ images.ts   │  │  │  │ (Playwright 浏览器) │  │
              │  │ videos.ts   │  │  │  └────────────────────┘  │
              │  │ chat.ts     │  │  │  ┌────────────────────┐  │
              │  └─────────────┘  │  │  │ image-provider.ts  │  │
              └────────┬──────────┘  │  │ (任务队列+持久化)   │  │
                       │             │  └────────────────────┘  │
                       │             └───────────┬──────────────┘
                       │                         │
          ┌────────────▼─────────────────────────▼──────────────┐
          │                上游服务                               │
          │  ┌──────────────────┐  ┌───────────────────────────┐│
          │  │ 即梦国内版         │  │ 即梦国际版 / Dreamina       ││
          │  │ jimeng.jianying.com│  │ dreamina.capcut.com       ││
          │  │ (mweb API)        │  │ (mweb-api-sg.capcut.com)  ││
          │  └──────────────────┘  └───────────────────────────┘│
          │  ┌──────────────────┐                                │
          │  │ 可灵              │                                │
          │  │ kling.ai          │                                │
          │  │ (网页模式, 无API)  │                                │
          │  └──────────────────┘                                │
          └─────────────────────────────────────────────────────┘
```

---

## 四、模块详解

### 4.1 入口与启动

**`src/index.ts`** — 应用入口

启动流程：
1. 加载环境变量 (`lib/environment.ts`)
2. 加载配置 (`lib/config.ts`)
3. 执行初始化 (`lib/initialize.ts`)
4. 创建 Koa Server 实例
5. 附加路由 (`server.attachRoutes(routes)`)
6. 监听端口 (`server.listen()`)

**`src/daemon.ts`** — 守护进程

独立进程管理器，用 `child_process.spawn` 启动子进程运行 `index.js`，提供：
- 崩溃自动重启（最多 600 次，间隔 5 秒）
- 退出码区分：0=正常退出, 2=被杀, 3=主动重启（自动重启子进程）, 其他=崩溃
- 日志写入 `./logs/daemon.log`

### 4.2 HTTP 服务器层

**`src/lib/server.ts`** — Koa 服务器

中间件栈（按执行顺序）：

| 顺序 | 中间件 | 职责 |
|------|--------|------|
| 1 | koaCors | 跨域支持 |
| 2 | koaRange | Range 请求（大文件下载） |
| 3 | 异常拦截 | XML Content-Type 重写 + try/catch 包裹 |
| 4 | 自定义 JSON 解析 | 清理 \r、零宽空格、BOM 等问题字符后手动 JSON.parse；标记 `ctx._jsonProcessed` |
| 5 | koaBody (条件) | 仅对未被自定义解析器处理的请求生效（multipart/form-data 等） |

请求处理流程 (`#requestProcessing`)：
1. 构造 `Request` 对象
2. 调用 `verifyApiKey()` — 校验 `X-API-Key` 头（公开路由如 `/ping`、`/` 免校验）
3. 调用路由函数
4. 将返回值包装为 `Response` 并注入 Koa context
5. 全程异常捕获 → `FailureBody` → 统一错误格式

API Key 机制：
- 环境变量 `SERVER_API_KEYS` / `SERVER_API_KEY`（逗号分隔）
- 公开路由白名单：`/`、`/ping`、`/console`、`/docs/api-guide`
- 请求头 `X-API-Key` 传入

### 4.3 配置系统

**`src/lib/config.ts`** — 配置聚合器，包含 service 和 system 两部分。

**`src/lib/configs/service-config.ts`** — 服务配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| name | jimeng-free-api | 服务名 |
| host | 0.0.0.0 | 监听地址 |
| port | 5566 | 监听端口 |
| urlPrefix | (空) | 路由前缀 |
| bindAddress | 自动探测 | 外部访问地址 |

加载优先级：YAML 配置文件 (`configs/{env}/service.yml`) → 环境变量覆盖

**`src/lib/configs/system-config.ts`** — 系统配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| requestLog | false | 请求日志开关 |
| tmpDir | ./tmp | 临时目录 |
| logDir | ./logs | 日志目录 |
| debug | true | 调试模式 |
| tmpFileExpires | 86400000 | 临时文件过期时间 (24h) |

**`src/lib/configs/model-config.ts`** — 模型配置（draftVersion、internalModel 映射等），供 images/videos 控制器查询。

### 4.4 认证与 Token 管理

**`src/lib/service-authorization.js`** — 凭证解析

优先级链：
1. 请求头 `Authorization`（有值就直接用）
2. 环境变量 `JIMENG_AUTHORIZATION`
3. 环境变量 `JIMENG_SESSIONID`
4. 抛错：未配置凭证

**多 Token 轮询**：
- `Authorization: Bearer token1,token2,token3`
- `splitAuthorizationTokens()` 按逗号切分
- 实际使用时 `_.sample(tokens)` 随机选一个

**区域感知路由** (`src/api/controllers/core.ts: parseRegionFromToken`)：

```
Token 前缀    →  区域判定      →  上游域名
(无前缀)       →  CN 国内       →  jimeng.jianying.com
us-           →  US 美国       →  commerce.us.capcut.com / dreamina-api.us.capcut.com
sg-/hk-/jp-  →  国际 (非US)   →  commerce-api-sg.capcut.com / mweb-api-sg.capcut.com
其他2字母-     →  查表映射      →  同上
```

区域影响：
- `assistantId`：CN=513695, 国际=513641
- Cookie 域名：CN=`.jianying.com`, 国际=`.capcut.com`
- API Base URL
- 上传通道 (ImageX 区域节点)
- 是否需要 X-Bogus/X-Gnarly 签名

### 4.5 反爬签名算法

#### 4.5.1 X-Bogus (`src/lib/x-bogus.ts`)

字节跳动国际版 shark 反爬签名，纯 TypeScript 实现，无浏览器依赖。

算法流程：
1. 对请求 body 做 double-MD5 (MD5(MD5(body)))
2. 对 URL 查询参数做 double-MD5
3. 对 User-Agent 做 RC4 加密 + Base64 编码 + MD5
4. 组装 21 元素 salt 数组（时间戳 + magic 536919696 + MD5 末字节 + 时间戳/魔数大端字节 + 校验和）
5. 通过 `filterList` 提取特定索引 → `scramble` 重排 → RC4 加密
6. 加 `\x02\xff` 前缀 → 自定义 Base64 编码（字母表 `Dkdpgh4ZKs...`）

输出示例：`&X-Bogus=DFSzswVO...`，直接拼接到查询参数后。

#### 4.5.2 X-Gnarly (`src/lib/x-gnarly.ts`)

更复杂的签名算法，基于 ChaCha20 流密码。

算法流程：
1. 对 queryString、requestBody、userAgent 分别做 MD5
2. 构造 12 字段数据对象（版本号 5.1.2 / 1.0.0.316 + 时间戳 + MD5 + magic + 校验和）
3. 序列化为 TLV 字节
4. 生成 12 个随机密钥字 → ChaCha20 加密数据
5. 计算密钥插入位置 → 组装最终字符串（控制字节 `0x4B` + 密文+密钥）
6. 自定义 Base64 编码（字母表 `u09tbS3Uvg...`）

PRNG 基于 ChaCha20 Block Function 的自定义实现（8 轮），非标准 Math.random。

### 4.6 浏览器代理服务

#### 4.6.1 BrowserService (`src/lib/browser-service.ts`)

为即梦/Seedance 国内版和国际版提供浏览器代理请求能力，绕过 shark SDK 安全检测。

核心能力：
- **懒启动** Chromium 实例（`--no-sandbox --disable-dev-shm-usage` 等 headless 参数）
- **会话池**：按 `{region}:{token}` 维护浏览器上下文，10 分钟空闲自动关闭
- **Cookie 注入**：根据区域自动生成 `.jianying.com` 或 `.capcut.com` 的 cookie
- **资源拦截**：屏蔽 image/font/stylesheet/media 资源加速加载；仅白名单域名脚本放行（字节系域名）
- **SDK 就绪等待**：国内版等待 `bdms.init` / `byted_acrawler`；国际版等待 `__secsdk` / `__ac_nonce`
- **API 路由重写**：国际版前端 `dreamina.capcut.com` → 实际 API `mweb-api-sg.capcut.com`，让 secsdk 在同源上下文签名
- **`fetch()` 代理方法**：在页面上下文中执行 `window.fetch()`，SDK 自动拦截并注入 `a_bogus` 签名

#### 4.6.2 Kling Web Automation (`src/providers/kling/web-automation.ts`)

可灵 (Kling) 图片生成——官方 API 已下线，仅保留网页模式。

工作流程：
1. 启动 Chromium → 创建浏览器上下文（注入 storageState/cookies）
2. 导航到 `kling.ai/app/image/new`
3. **基线收集**：截取页面已有图片 URL 存入 `baselineImageUrls`（排除推荐/历史图）
4. 输入 prompt（`div[contenteditable='true']` 文本框）
5. 如有参考图 → `input[type='file']` 上传文件
6. 点击生成按钮
7. **轮询等待**：定时 `collectDomImageUrls()`，新出现的图片 URL（不在基线中的）视为生成结果
8. 同时监听所有 XHR/Fetch 响应，提取 JSON 中的 task_id 和图片 URL
9. 结果持久化到 `tmp/kling-web-provider/{taskId}/`（截图 + summary.json + traffic.json）

并发控制：`KLING_WEB_MAX_CONCURRENT_TASKS`（默认 1）

#### 4.6.3 web-utils.ts — Kling 网页辅助

- `resolveKlingWebStorageState()` — 多来源 cookies 解析（provider_options → 环境变量 → kling.json 本地文件）
- `shouldCaptureKlingWebRequest()` — 过滤 Kling API 请求（仅 fetch/xhr，排除 analytics）
- `isLikelyResultImageUrl()` — 判断 URL 是否为生成结果图（域名白名单 + 路径黑名单 + 扩展名匹配）
- `extractLikelyImageUrlsFromJson()` — 从 JSON 响应中递归提取图片 URL
- `extractLikelyTaskIds()` — 递归提取 task_id/taskId/id

### 4.7 Provider 架构

**`src/providers/types.ts`** — 统一接口定义

```typescript
interface ImageProvider {
  name: string;
  supportsModel(model?: string): boolean;
  generateUnified(input: UnifiedImageGenerateInput, context): Promise<UnifiedImageGenerateOutput>;
}

interface UnifiedImageGenerateInput {
  model?, prompt, images?, negativePrompt?, ratio?, resolution?,
  responseFormat?, sampleStrength?, intelligentRatio?, async?, n?,
  providerOptions?;
}
```

**`src/providers/provider-registry.ts`** — Provider 路由

解析策略：
1. 模型名以 `kling-` 开头 → KlingImageProvider
2. 请求体含 `model_name` / `aspect_ratio` / `external_task_id` 等 Kling 原生字段 → KlingImageProvider
3. 请求体含 `subject_image_list` / `scene_image` / `style_image` → KlingImageProvider
4. 其他 → JimengImageProvider

**JimengImageProvider** (`src/providers/jimeng/image-provider.ts`)：
- 委托 `controllers/images.ts` 的 `generateImages()` / `generateImageComposition()`
- Token 随机选取（多账号轮询）
- 支持 `url` 和 `b64_json` 两种 response_format

**KlingImageProvider** (`src/providers/kling/image-provider.ts`)：
- 全部走 web 模式（官方 API 已移除）
- 异步任务管理：`Map<taskId, WebTaskRecord>` 持久化到 `tasks.json`
- 并发控制 + 排队机制
- 支持同步等待和异步提交+查询两种模式
- 失败告警：写入 `alerts.jsonl` + 可选 webhook 通知

### 4.8 控制器层

#### 4.8.1 core.ts — 核心工具

关键函数：

| 函数 | 职责 |
|------|------|
| `parseRegionFromToken()` | Token 前缀 → RegionInfo（isUS/isInternational/isCN/regionCode） |
| `getAssistantId()` | 区域 → assistantId 映射 |
| `generateCookie()` | 构造 HTTP Cookie 字符串 |
| `getCookiesForBrowser()` | 构造 Playwright Cookie 数组（国内版） |
| `getCookiesForBrowserInternational()` | 构造 Playwright Cookie 数组（国际版） |
| `getCredit()` | 查询账户积分（赠送/购买/VIP） |
| `receiveCredit()` | 收取每日免费积分 |
| `request()` | 统一 HTTP 请求封装（见下文详述） |
| `uploadFile()` | 文件上传（获取凭证 → 上传到 ImageX） |
| `checkResult()` | 统一响应解析（ret=0 返回 data，5000 抛积分不足） |
| `acquireToken()` | 国际版 Token 去前缀 |
| `tokenSplit()` | 逗号分隔多 Token |
| `getTokenLiveStatus()` | 检查 Token 是否有效 |

**`request()` 函数核心流程**：

```
1. parseRegionFromToken(token) → 区域信息
2. 确定 baseUrl (CN/US Commerce/Dreamina/SG Commerce/SG Dreamina)
3. 构造公共参数 (aid, device_platform, region, webId, da_version...)
4. 构造伪装 headers (FAKE_HEADERS: Chrome 132 UA, Appvr 8.4.0...)
5. 生成 Device-Time + Sign (MD5 签名)
6. [国际版] signXBogus() → X-Bogus 拼入 URL
7. [国际版] getXGnarly() → X-Gnarly 加入请求头
8. axios.request() + 重试逻辑 (最多 3 次，指数退避)
9. checkResult() 解析响应
```

#### 4.8.2 images.ts — 图像生成

**文生图 `generateImages()`**：
1. 模型名映射（如 `jimeng-5.0` → `high_aes_general_v50`）
2. 分辨率/比例解析（1k/2k/4k × 8种比例）
3. 检查积分，不足则自动领取每日积分
4. 构造 draft_content JSON（版本号、模型、prompt、尺寸、精细度等）
5. 调用 `/mweb/v1/aigc_draft/generate` 提交任务
6. 轮询 `/mweb/v1/get_history_by_ids`（最多 600 次/10 分钟）
7. 提取 `large_images[0].image_url` 作为结果

**图生图 `generateImageComposition()`**：
1. 逐张上传输入图片（URL → 下载 → uploadFile 或直接上传 Buffer）
2. 构造 `generate_type: "blend"` 的 draft_content
3. prompt 中用 `##` 占位符引用图片（`'#'.repeat(imageCount * 2) + prompt`）
4. 其余流程同文生图

#### 4.8.3 videos.ts — 视频生成

**普通视频 `generateVideo()`**：
- 支持 `jimeng-video-3.0` / `3.0-pro` / `3.5-pro`
- 支持 `ratio`、`resolution`（480p/720p/1080p）
- 支持首帧图片控制
- 提交 → 轮询 → 获取视频 URL

**Seedance 2.0 `generateSeedanceVideo()`**：
- 多模态素材支持：图片(image) / 视频(video) / 音频(audio)
- 素材类型自动检测（MIME → 扩展名兜底）
- prompt 中 `@1`, `@2` 占位符引用素材
- 支持 4-15 秒时长
- VIP 通道模型（`dreamina_seedance_40_vision` / `dreamina_seedance_40_pro_vision`）
- 国内版使用 BrowserService 代理请求（绕过 bdms SDK）
- 国际版使用纯算法签名（X-Bogus + X-Gnarly）

**上传链路**：
- 国内版：ImageX (`imagex.bytedanceapi.com`) + `get_upload_image_proof` + AWS4-HMAC-SHA256 签名
- 国际版非US：ImageX SG (`imagex-normal-sg.capcutapi.com`) + 代理支持 (`undici.ProxyAgent`)
- 国际版US：ImageX US (`imagex16-normal-us-ttp.capcutapi.us`)

#### 4.8.4 chat.ts — 对话补全

适配 OpenAI `/v1/chat/completions` 格式，将多模态生成包装为对话响应。

**模型路由**：
- `jimeng-video-*` / `seedance-*` → 视频生成
- 其他 → 图像生成

**同步模式 `createCompletion()`**：
- 直接调用 generateImages/generateVideo，阻塞等待结果
- 返回 OpenAI `chat.completion` 格式，content 中嵌入 `![image](url)` / `![video](url)`

**流式模式 `createCompletionStream()`**：
- 返回 PassThrough 流，以 SSE 格式推送
- 先发送 "生成中..." 进度消息
- 定时发送 "." 点进度（每 5 秒）
- 2 分钟超时提示（但后台继续尝试）
- 生成完成后发送结果 + `[DONE]`

### 4.9 路由层

| 路由文件 | 前缀 | 端点 |
|---------|------|------|
| images.ts | /v1/images | POST /generations, /compositions, /multi-image2image; GET /generations, /generations/:id |
| videos.ts | /v1/videos | POST /generations, /generations/async; GET /generations/async/:taskId; 国际版同步/异步端点 |
| video.ts | /v1/video | POST /generations (别名) |
| chat.ts | /v1/chat | POST /completions (同步+流式) |
| models.ts | /v1 | GET /models |
| token.ts | /token | POST /check, /points |
| ping.ts | / | GET /ping |
| console.ts | /console | 管理控制台 |

**images 路由特殊处理**：
- 支持 `application/json`（images 为 URL 数组）和 `multipart/form-data`（文件上传）两种格式
- `provider_options` 字段透传给 Kling Provider（如 storageState、targetUrl）
- Kling 原生格式请求体直接走 `klingImageProvider.createNativeGeneration()`

### 4.10 文件上传流程

即梦/Seedance 的图片/视频素材上传分两步：

```
Step 1: 获取上传凭证
  POST /mweb/v1/get_upload_image_proof
  → 返回 proof_info (headers, query_params, image_uri)

Step 2: 上传到字节 ImageX CDN
  POST https://imagex.bytedanceapi.com/
  Headers: proof_info.headers (含 Authorization 签名)
  Params: proof_info.query_params
  Body: FormData(file=Blob)
  → 返回 200 即成功，image_uri 作为后续引用 ID
```

国际版额外步骤：
- 获取 STS 临时凭证 (`/mweb/v1/get_upload_token`)
- 用 AWS4-HMAC-SHA256 签名上传请求
- 区域感知的 ImageX 节点选择

### 4.11 Docker 部署

**Dockerfile** 采用多阶段构建：

1. **构建阶段** (`node:lts`)：`yarn install` + `yarn run build`
2. **运行阶段** (`node:lts`)：
   - 安装 Chromium 依赖库（libnss3, libatk, libdrm 等 13 个）
   - 复制构建产物 (dist, node_modules, configs, public)
   - `npx playwright-core install chromium` 安装浏览器
   - 暴露 8000 端口
   - `CMD ["npm", "start"]`

---

## 五、关键数据流

### 5.1 即梦文生图完整链路

```
客户端 POST /v1/images/generations
  │
  ├─ Authorization → splitAuthorizationTokens → _.sample(tokens)
  │
  ├─ parseRegionFromToken → RegionInfo
  │    ├─ CN: baseUrl = jimeng.jianying.com
  │    └─ 国际: baseUrl = dreamina-api.us.capcut.com / mweb-api-sg.capcut.com
  │
  ├─ getModel(model) → internalModel (e.g. high_aes_general_v50)
  ├─ resolveResolution(resolution, ratio) → width, height, imageRatio
  ├─ getCredit(token) → 积分不足则 receiveCredit(token)
  │
  ├─ POST /mweb/v1/aigc_draft/generate
  │    Headers: Cookie=generateCookie(), Device-Time, Sign
  │    [国际版] + X-Bogus (URL) + X-Gnarly (Header)
  │    Body: draft_content JSON + submit_id + metrics_extra
  │    → 返回 aigc_data.history_record_id
  │
  ├─ 轮询 POST /mweb/v1/get_history_by_ids (每秒, 最多600次)
  │    → status=10 + item_list.length > 0 → 完成
  │
  └─ 提取 item.image.large_images[0].image_url
       → response_format=url → 直接返回
       → response_format=b64_json → 下载图片转 Base64
```

### 5.2 可灵网页模式生图链路

```
客户端 POST /v1/images/generations { model: "kling-v2-1" }
  │
  ├─ resolveImageProvider → klingImageProvider
  ├─ KlingImageProvider.generateUnified()
  │    ├─ async=true → startWebTask() → 返回 task_id + status
  │    └─ async=false → runSyncWebGeneration()
  │
  ├─ klingWebAutomation.generate()
  │    ├─ ensureBrowser() → chromium.launch(headless)
  │    ├─ resolveKlingWebStorageState() → cookies
  │    ├─ browser.newContext({ storageState })
  │    ├─ page.goto("https://kling.ai/app/image/new")
  │    ├─ collectDomImageUrls() → baselineImageUrls (排除已有图)
  │    ├─ 输入 prompt → 点击生成按钮
  │    ├─ 轮询 collectDomImageUrls() → 新图 = observedImageUrls
  │    ├─ 同时监听 XHR/Fetch 响应提取 task_id 和图片 URL
  │    └─ 持久化 artifacts (截图 + summary + traffic)
  │
  └─ 返回 imageUrls[]
```

### 5.3 Seedance 国际版视频链路

```
客户端 POST /v1/videos/international/generations/async
  │
  ├─ parseRegionFromToken("sg-xxx") → isInternational=true
  ├─ isSeedanceModel → generateInternationalSeedanceVideoAsync()
  │
  ├─ 上传素材 (image/video/audio)
  │    ├─ request("post", "/mweb/v1/get_upload_token")
  │    ├─ AWS4-HMAC-SHA256 签名
  │    ├─ proxyFetch (undici ProxyAgent) → ImageX SG
  │    └─ 返回 uri / vid
  │
  ├─ 提交任务
  │    ├─ request("post", "/mweb/v1/aigc_draft/generate")
  │    ├─ signXBogus() + getXGnarly() (纯算法签名)
  │    └─ 返回 history_record_id → taskId
  │
  ├─ [异步模式] 立即返回 taskId
  │
  └─ [查询] GET /v1/videos/international/generations/async/:taskId
       ├─ request("post", "/mweb/v1/get_history_by_ids")
       ├─ status 判断 → processing/succeed/failed
       ├─ VIP Token → 自动调用 benefit_metadata/batch_get_user_benefit
       └─ 返回视频 URL (无水印/有水印)
```

---

## 六、环境变量一览

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `JIMENG_AUTHORIZATION` | - | 即梦 Bearer Token（逗号分隔多账号） |
| `JIMENG_SESSIONID` | - | 即梦 sessionid（逗号分隔多账号） |
| `SERVER_API_KEY` / `SERVER_API_KEYS` | - | API 访问密钥 |
| `BROWSER_EXECUTABLE_PATH` | - | Chromium 可执行文件路径 |
| `KLING_WEB_STORAGE_STATE_JSON` | - | Kling cookies JSON（内联） |
| `KLING_WEB_STORAGE_STATE_PATH` | - | Kling cookies JSON 文件路径 |
| `KLING_WEB_COOKIES_JSON_PATH` | - | Kling cookies 数组文件路径 |
| `KLING_WEB_TARGET_URL` | https://kling.ai/app/image/new | Kling 网页目标 URL |
| `KLING_WEB_HEADLESS` | true | Kling 浏览器是否无头模式 |
| `KLING_WEB_WAIT_TIMEOUT_MS` | 180000 | Kling 等待超时 |
| `KLING_WEB_RESULT_POLL_INTERVAL_MS` | 2000 | Kling 结果轮询间隔 |
| `KLING_WEB_MAX_CONCURRENT_TASKS` | 1 | Kling 最大并发网页任务 |
| `KLING_WEB_FAILURE_ALERT_WEBHOOK_URL` | - | Kling 失败告警 Webhook |
| `KLING_POLL_INTERVAL_MS` | 1500 | Kling Provider 轮询间隔 |
| `KLING_POLL_TIMEOUT_MS` | 180000 | Kling Provider 轮询超时 |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | - | 代理（国际版上传使用） |
| `SERVER_PORT` | 5566 | 服务端口（覆盖配置文件） |

---

## 七、安全与反爬机制汇总

| 机制 | 适用场景 | 实现方式 |
|------|---------|---------|
| Cookie 认证 | 即梦国内版 | `sessionid` 伪装 Cookie |
| X-Bogus 签名 | 即梦国际版 (shark) | 纯算法：RC4 + MD5 + 自定义Base64 |
| X-Gnarly 签名 | 即梦国际版 (shark) | 纯算法：ChaCha20 加密 + 自定义Base64 |
| bdms SDK 代理 | 即梦国内版 Seedance | Playwright 页面内 fetch，SDK 自动注入 a_bogus |
| secsdk 代理 | 即梦国际版 Seedance | 同上 + API 路由重写保持同源 |
| AWS4-HMAC-SHA256 | 国际版 ImageX 上传 | 标准 AWS SigV4 签名 |
| Playwright 网页模式 | 可灵 (无 API) | 完整浏览器自动化 + 网络流量监听 |
| Device-Time + Sign | 即梦所有请求 | `MD5(9e2c\|uri后7字\|平台\|版本\|时间\|\|11ac)` |
| 资源屏蔽 | 浏览器代理 | 屏蔽 image/font/css/media + 非白名单脚本 |

---

## 八、项目目录结构

```
/myproject/kling-api/
├── src/
│   ├── index.ts                    # 应用入口
│   ├── daemon.ts                   # 守护进程
│   ├── api/
│   │   ├── controllers/
│   │   │   ├── core.ts             # 核心工具 (Token/积分/请求/签名)
│   │   │   ├── images.ts           # 即梦图像生成 (文生图+图生图)
│   │   │   ├── videos.ts           # 视频生成 (含Seedance, 4000+行)
│   │   │   └── chat.ts             # OpenAI兼容对话适配
│   │   ├── routes/
│   │   │   ├── index.ts            # 路由聚合
│   │   │   ├── images.ts           # /v1/images/* 端点
│   │   │   ├── videos.ts           # /v1/videos/* 端点
│   │   │   ├── video.ts            # /v1/video/* (别名)
│   │   │   ├── chat.ts             # /v1/chat/* 端点
│   │   │   ├── models.ts           # /v1/models 端点
│   │   │   ├── token.ts            # /token/* 端点
│   │   │   ├── ping.ts             # /ping 健康检查
│   │   │   └── console.ts          # 管理控制台
│   │   └── consts/
│   │       └── exceptions.ts       # API异常定义
│   ├── providers/
│   │   ├── types.ts                # ImageProvider 统一接口
│   │   ├── provider-registry.ts    # Provider 路由/注册
│   │   ├── jimeng/
│   │   │   └── image-provider.ts   # 即梦 Provider (委托controllers)
│   │   └── kling/
│   │       ├── mapper.ts           # Kling 模型映射 + 原生格式检测
│   │       ├── image-provider.ts   # Kling Provider (任务队列+持久化)
│   │       ├── web-automation.ts   # Kling Playwright 网页自动化
│   │       └── web-utils.ts        # Kling 网页辅助 (cookies/URL检测/状态解析)
│   └── lib/
│       ├── server.ts               # Koa 服务器 + 中间件栈
│       ├── browser-service.ts      # 浏览器代理服务 (bdms/secsdk)
│       ├── x-bogus.ts              # X-Bogus 签名算法
│       ├── x-gnarly.ts             # X-Gnarly 签名算法 (ChaCha20)
│       ├── config.ts               # 配置聚合器
│       ├── logger.ts               # 日志工具
│       ├── util.ts                 # 辅助工具 (UUID/MD5/BASE64/URL检测)
│       ├── environment.ts          # 环境变量解析
│       ├── initialize.ts           # 初始化逻辑
│       ├── console-service.ts      # 控制台服务
│       ├── http-status-codes.ts    # HTTP状态码
│       ├── service-authorization.js # 凭证解析
│       ├── request/Request.ts      # 请求解析与验证
│       ├── response/               # 响应包装 (Response/Body/FailureBody)
│       ├── exceptions/             # 异常类 (Exception/APIException)
│       ├── interfaces/             # 接口定义 (ICompletionMessage)
│       └── configs/
│           ├── model-config.ts     # 模型配置
│           ├── service-config.ts   # 服务配置
│           └── system-config.ts    # 系统配置
├── dist/                           # 构建产物
├── public/                         # 静态文件 (welcome.html, api-guide.html)
├── configs/                        # YAML 配置文件 (按环境分目录)
├── kling.json                      # Kling cookies 本地文件
├── Dockerfile                      # Docker 构建文件
├── package.json                    # 依赖与脚本
├── CLAUDE.md                       # Claude Code 指导文档
└── ARCHITECTURE.md                 # 本文档
```

---

## 九、构建与运行

```bash
# 开发模式（热重载）
npm run dev

# 生产构建
npm run build

# 启动生产服务
npm start
# 或指定端口
npm start -- --port 8000

# Docker
docker build -t jimeng-free-api-all:latest .
docker run -d --init -p 8000:8000 -e TZ=Asia/Shanghai jimeng-free-api-all:latest
```

---

## 十、已知限制与注意事项

1. **可灵仅网页模式**：官方 API 已移除，所有 Kling 请求走 Playwright 浏览器自动化，并发受限（默认 1）
2. **Seedance 国内版需浏览器**：Seedance CN 版使用 `browser-service.ts` 代理请求绕过 bdms SDK，需安装 Chromium
3. **国际版签名时效**：X-Bogus / X-Gnarly 为纯算法实现，如字节更新签名算法版本需同步更新
4. **内存占用**：文件上传为全量内存模式（`Buffer.from`），大文件/高并发时需关注内存
5. **EPIPE 问题**：当 stdout/stderr 被断开（如 logger 输出到已关闭的管道），`console.log` 触发 write EPIPE，可能导致 `/v1/images/generations` 等端点挂起
6. **视频生成耗时**：普通视频 1-2 分钟，Seedance 可达数分钟，流式模式下有 2 分钟超时提示但后台继续尝试
7. **积分机制**：每日免费积分自动领取，不足时尝试 `receiveCredit()`，但仍可能因积分耗尽导致 5000 错误
