# Kling 图片能力接入 /myproject/jimeng-api 开发计划

> 目标：让现有 jimeng-api 在不破坏现有即梦能力的前提下，新增对 Kling 图片生成能力的兼容支持。

## 先说结论

可行，但要先明确“兼容”的目标有两种，难度差很多：

1. 推荐方案：兼容 Kling 的官方图片能力 / 官方开放 API
   - 可行性：高
   - 稳定性：高
   - 开发成本：中
   - 风险：低
   - 推荐指数：最高

2. 不推荐方案：去模拟 https://klingai.com/app/image/ 官网页面的私有前端接口
   - 可行性：中
   - 稳定性：低
   - 开发成本：高
   - 风险：高（登录态、反爬、接口变更、风控、合规）
   - 推荐指数：低

本计划默认采用方案 1：走 Kling 官方开放 API，把 /myproject/jimeng-api 扩成“多 provider 图片网关”。

## 这次调研得到的关键事实

### 现有 jimeng-api 的结构

项目当前是 Koa + TypeScript，图片主入口和关键耦合点如下：

- `src/api/routes/images.ts`
  - 当前只提供：
    - `POST /v1/images/generations`
    - `POST /v1/images/compositions`
  - 当前是同步阻塞风格，直接返回最终图片 URL / base64
- `src/api/controllers/images.ts`
  - 即梦图片生成核心逻辑
  - 内部直接提交任务并轮询 history_id，最多轮询 10 分钟
- `src/api/controllers/core.ts`
  - 当前认证强绑定即梦 `sessionid` Cookie / Bearer token
  - 里面有即梦/CapCut 专用 headers、cookie、region、签名逻辑
- `src/api/routes/models.ts`
  - 当前模型列表是硬编码的 jimeng / seedance 系列
- `src/api/controllers/chat.ts`
  - 通过模型名前缀决定走图像还是视频生成

也就是说：
当前代码不是“provider 抽象层”，而是“jimeng 直连实现”。
如果直接往现有逻辑里硬塞 Kling，会越来越难维护。

### Kling 官方图片 API 能力

从 Kling 官方文档可确认：

- API 域名：`https://api-singapore.klingai.com`
- 认证方式：不是 session cookie，而是 `AccessKey + SecretKey -> JWT -> Authorization: Bearer <token>`
- 图片主接口：
  - `POST /v1/images/generations`
  - `GET /v1/images/generations/{id}`
  - `GET /v1/images/generations`
- 多图图片接口：
  - `POST /v1/images/multi-image2image`
  - `GET /v1/images/multi-image2image/{id}`
- 官方接口默认是“异步任务”模型：先创建 task，再查询 task 状态
- 图片模型文档里能看到至少这些模型：
  - `kling-v1`
  - `kling-v1-5`
  - `kling-v2`
  - `kling-v2-new`
  - `kling-v2-1`
  - `kling-v3`
  - `kling-v3-omni`
  - `kling-image-o1`

### Kling 和 jimeng 的关键不兼容点

1. 认证方式不同
- jimeng：Bearer sessionid / cookie
- Kling：AK/SK -> JWT

2. 返回模式不同
- jimeng 当前封装后对外是同步返回结果图
- Kling 官方是异步 task

3. 参数模型不同
- jimeng 当前对外参数更接近 OpenAI 兼容风格：
  - `model`
  - `prompt`
  - `images[]`
  - `ratio`
  - `resolution`
- Kling 官方常用字段：
  - `model_name`
  - `prompt`
  - `negative_prompt`
  - `image`
  - `aspect_ratio`
  - `n`
  - `callback_url`
  - `external_task_id`
  - `watermark_info`
  - 多图时还分 `subject_image_list` / `scene_image` / `style_image`

4. 多图语义不同
- 现有 jimeng 的 `images[]` 是“泛化多图输入”
- Kling 的多图接口是“有角色语义的多图输入”：主体图 / 场景图 / 风格图
- 所以“把当前 `images[]` 原样映射成 Kling 多图接口”并不天然成立

## 推荐落地策略

推荐做成“双层兼容”：

### A. 外层：保留你现在这套统一接口

继续支持：
- `POST /v1/images/generations`

当用户传：
- `model: "jimeng-4.6"` -> 走现有 jimeng 逻辑
- `model: "kling-v2-1"` -> 走 Kling provider

这样你现有接 OpenAI 风格 / 统一图片接口的客户端不用大改。

### B. 内层：补一组 Kling 原生兼容接口

新增对 Kling 官方协议的直通兼容：
- `POST /v1/images/generations`（支持 `model_name` 风格 body）
- `GET /v1/images/generations/:id`
- `GET /v1/images/generations`
- `POST /v1/images/multi-image2image`
- `GET /v1/images/multi-image2image/:id`

这样有两个好处：
1. 能继续服务你现有客户端
2. 也能让将来任何按 Kling 官方 API 写的调用方，基本不用改协议

## 不建议做的方向

不建议目标设成：
“让 `klingai.com/app/image` 官方网页前端直接连你本地这个服务”

原因：
- 这类站点前端通常不只是一组公开 REST API
- 经常带登录态、风控参数、设备指纹、灰度字段、ab 实验字段
- 页面接口会变，维护成本很高
- 浏览器端黑屏/空白页通常也意味着前端渲染、脚本加载、鉴权链路复杂
- 即使打通，也非常脆弱

如果你真正想要的是“支持 Kling 这家 provider 的图片能力”，走官方开放 API 就够了，也更适合部署到你这个本地项目里。

## MVP 范围建议

第一版先只做下面这 4 件事：

1. 支持 Kling 文生图
2. 支持 Kling 单图图生图
3. 支持 Kling 原生异步任务查询
4. 在现有统一接口里，把 Kling 异步结果包装成同步返回

第一版先不要做：
- 官网页面私有接口模拟
- 所有 Kling 图片子能力一次性全接
- 多图复杂语义自动推断（subject / scene / style 自动猜测）
- 4K、Omni、元素控制、系列图、AI Multi-Shot 全量打满

## 建议的目标架构

### 1. 新增 provider 抽象层

建议新增目录：

- `src/providers/types.ts`
- `src/providers/image-provider.ts`
- `src/providers/jimeng/image-provider.ts`
- `src/providers/kling/auth.ts`
- `src/providers/kling/client.ts`
- `src/providers/kling/image-provider.ts`
- `src/providers/kling/mapper.ts`

目的：
- 把“路由层”和“上游 provider 实现”分开
- jimeng / kling 都走统一接口
- 后面如果还要接豆包、Midjourney 中转、Liblib、Flux provider，会容易很多

### 2. 路由层做“请求形态识别”

`src/api/routes/images.ts` 里做两类判断：

1. 统一风格请求
- 例如：`model`, `prompt`, `images`, `ratio`, `resolution`

2. Kling 原生请求
- 例如：`model_name`, `aspect_ratio`, `external_task_id`, `subject_image_list`

这样同一路由就能兼容两套调用方式。

### 3. 认证层支持两种 Kling 模式

建议同时支持：

1. 托管模式（推荐）
- 服务端配置：
  - `KLING_ACCESS_KEY`
  - `KLING_SECRET_KEY`
- 本地服务代为生成 JWT
- 客户端不需要自己签 token

2. 透传模式
- 若请求头里已经带了 Kling 官方 JWT，就直接透传
- 方便以后做官方协议兼容测试

## 详细开发计划

### 阶段 0：先做最小重构，给多 provider 留入口

目标：不要直接在现有 `images.ts` 控制器里堆 if/else。

要改的文件：
- 修改：`src/api/routes/images.ts`
- 修改：`src/api/routes/models.ts`
- 新增：`src/providers/types.ts`
- 新增：`src/providers/image-provider.ts`
- 新增：`src/providers/provider-registry.ts`
- 新增：`src/providers/jimeng/image-provider.ts`

任务：
1. 定义统一图片生成输入输出类型
2. 把现有 jimeng 图片逻辑包成 `JimengImageProvider`
3. 做一个 provider registry，按模型名前缀或 body 结构分发
4. 先保证 jimeng 原功能不回归

完成标准：
- 现有 jimeng 文生图 / 图生图都还能跑
- 外部 API 行为不变
- 新 provider 可以插拔

### 阶段 1：接入 Kling 基础客户端

要新增的文件：
- `src/providers/kling/auth.ts`
- `src/providers/kling/client.ts`
- `src/providers/kling/types.ts`
- `src/providers/kling/errors.ts`

任务：
1. 实现 AK/SK -> JWT 生成
2. 实现统一 HTTP client，默认 base URL：`https://api-singapore.klingai.com`
3. 统一处理错误码、429、鉴权失败、内容风控失败
4. 加入最基础的请求日志（request_id、task_id、上游状态）

建议环境变量：
- `KLING_BASE_URL=https://api-singapore.klingai.com`
- `KLING_ACCESS_KEY=`
- `KLING_SECRET_KEY=`
- `KLING_POLL_INTERVAL_MS=1500`
- `KLING_POLL_TIMEOUT_MS=180000`
- `KLING_ENABLED=true`

要修改的文件：
- 修改：`src/lib/environment.ts`
- 可新增：`src/lib/configs/provider-config.ts`
- 修改：`src/lib/config.ts`
- 修改：`local.env.example`（若项目里没有就新增）

完成标准：
- 本地能成功签出 JWT
- 能请求 Kling 创建任务接口
- 能按 task_id 查询任务

### 阶段 2：实现 Kling 图片 provider

要新增的文件：
- `src/providers/kling/image-provider.ts`
- `src/providers/kling/mapper.ts`

建议先支持的能力：
1. 文生图
2. 单图图生图
3. 原生任务查询

统一接口映射建议：

统一请求 -> Kling 请求：
- `model` -> `model_name`
- `prompt` -> `prompt`
- `negative_prompt` -> `negative_prompt`
- `ratio` -> `aspect_ratio`
- `images[0]` -> `image`
- `n`（新增） -> `n`

统一接口里先增加这几个可选参数：
- `n`
- `async`
- `provider_options`

其中：
- `async=false`：服务端代为轮询，最终返回图片 URL，兼容你当前同步风格
- `async=true`：直接返回 task_id

注意：
- 当前 jimeng 的 `sample_strength` 没法直接一比一映射到 Kling 所有模型，第一版不要硬映射
- 当前 jimeng 的 `resolution` 只支持 `1k/2k/4k` 概念，Kling 各模型支持范围不同，要按 model capability 做校验

完成标准：
- `model=kling-v2-1` 时能文生图
- `model=kling-v2-1` + 单张 `images[0]` 时能图生图
- 超时、风控、鉴权失败时错误返回结构稳定

### 阶段 3：补齐 Kling 原生兼容路由

要修改/新增的文件：
- 修改：`src/api/routes/images.ts`
- 新增：`src/api/controllers/kling-images.ts`（如果你想保持 route/controller 风格）

需要支持的接口：
- `POST /v1/images/generations`
- `GET /v1/images/generations/:id`
- `GET /v1/images/generations`
- `POST /v1/images/multi-image2image`
- `GET /v1/images/multi-image2image/:id`

实现原则：
- 如果 body 含 `model_name` / `external_task_id` / `aspect_ratio` 等 Kling 原生字段，就走 Kling-native 分支
- 如果 body 还是当前项目的 `model + images[] + ratio + resolution` 风格，就走统一风格分支

这样最终你既有：
- 统一兼容接口
- Kling 原生兼容接口

完成标准：
- 用 Kling 官方文档里的 cURL 样例，只需要把 host 改成你的本地服务，就能基本打通

### 阶段 4：支持多图图片能力

这是最容易“看起来能做，实际上语义不对”的阶段，要单独控制范围。

Kling 原生多图接口：
- `POST /v1/images/multi-image2image`

其输入不是简单 `images[]`，而是：
- `subject_image_list`
- `scene_image`
- `style_image`

所以建议分两步：

第一步：只支持 Kling 原生字段
- 先不强行把当前 `images[]` 自动变成多图语义
- 用户如果要多图能力，必须显式传：
  - `subject_image_list`
  - `scene_image`
  - `style_image`

第二步：再做统一接口增强
- 例如扩展当前统一接口：
  - `reference_images.subjects[]`
  - `reference_images.scene`
  - `reference_images.style`

不建议第一版的做法：
- `images[0]` 当 subject
- `images[1]` 当 scene
- `images[2]` 当 style
这种猜测虽然省事，但很容易产出错误结果。

完成标准：
- 明确支持 1~4 张主体图
- 场景图 / 风格图可选
- 返回 task_id 和结果查询正常

### 阶段 5：模型清单、文档和可观测性

要修改的文件：
- 修改：`src/api/routes/models.ts`
- 修改：`README.md`
- 新增：`docs/kling-compat.md`

建议把 Kling 模型先分级：

MVP 首批开放：
- `kling-v2-1`
- `kling-v3-omni`
- `kling-image-o1`

后续开放：
- `kling-v1`
- `kling-v1-5`
- `kling-v2`
- `kling-v2-new`
- `kling-v3`

日志建议记录：
- provider 名
- 上游 request_id
- task_id
- 创建耗时
- 轮询次数
- 最终状态
- 上游错误码

## 接口兼容策略建议

### 策略 1：统一接口继续保留同步风格

现有客户端最省心。

请求示例：
```json
{
  "model": "kling-v2-1",
  "prompt": "一只宫崎骏风格的小狗",
  "ratio": "1:1",
  "n": 1
}
```

服务端行为：
- 内部调用 Kling 创建任务
- 轮询直到成功/失败/超时
- 成功后仍然返回你当前项目已有的：
```json
{
  "created": 1710000000,
  "data": [
    { "url": "..." }
  ]
}
```

### 策略 2：额外支持 Kling 原生异步风格

请求示例：
```json
{
  "model_name": "kling-v2-1",
  "prompt": "Generate a Pixar-style puppy",
  "n": 2,
  "aspect_ratio": "1:1"
}
```

返回：
- 按 Kling 官方格式返回 task_id / task_status

这个双策略是最稳的。

## 主要风险点

### 风险 1：认证体系混杂

现有系统把 `Authorization` 视为 jimeng sessionid。
Kling 进来后，同一个 header 的含义会分裂。

建议：
- provider 识别后再解释 Authorization
- 或者新增服务端托管 AK/SK 模式，客户端不用传 Kling token

### 风险 2：图片多输入语义不一致

这是最大产品风险，不是代码风险。

因为 jimeng 的多图输入更“笼统”，Kling 的多图输入更“结构化”。
必须明确：
- 第一版只支持“单图图生图”走统一接口
- 多图高级能力走 Kling 原生接口

### 风险 3：同步包装超时

Kling 官方是任务式接口。
如果你在统一接口里强行同步等待：
- 请求会更慢
- 反向代理超时风险更高

建议：
- 默认超时 180 秒
- 超时后给出 task_id，允许客户端继续查询
- 或暴露 `async=true`

### 风险 4：能力表不一致

不同 Kling 模型：
- 支持的宽高比不同
- 支持的分辨率不同
- 是否支持单图/多图/元素控制不同

所以一定要做 `model capability map`，不能只靠前端随便传。

## 建议的里程碑

### 里程碑 M1：3~4 天

交付：
- provider 抽象层
- Kling auth/client
- `kling-v2-1` 文生图
- `kling-v2-1` 单图图生图
- 统一接口同步包装

### 里程碑 M2：2~3 天

交付：
- Kling 原生任务查询接口
- `/v1/images/generations/:id`
- `/v1/images/generations` 列表查询
- models 列表更新
- README 文档

### 里程碑 M3：2~4 天

交付：
- `multi-image2image` 原生支持
- subject / scene / style 参数
- 更完整的错误码映射
- 更完整的日志 / 超时 / 降级逻辑

## 验收标准

### 验收 1：不影响原有 jimeng
- 现有 `jimeng-4.5`、`jimeng-4.6` 调用不回归
- `/v1/images/compositions` 仍可用

### 验收 2：Kling 统一接口可用
- `POST /v1/images/generations` + `model=kling-v2-1` 可返回最终图片 URL
- 单图图生图可用

### 验收 3：Kling 原生接口可用
- `POST /v1/images/generations` 原生 body 可返回 task_id
- `GET /v1/images/generations/:id` 能查任务
- `POST /v1/images/multi-image2image` 能创建多图任务

### 验收 4：错误语义清晰
- 鉴权错误
- 内容风控错误
- 超时错误
- 上游限流错误
都能稳定返回，不要只抛原始异常

## 最终建议

最合适的路线不是“把这个项目硬改成 Kling 官网页面私有接口兼容器”，而是：

1. 先把项目升级成“多 provider 图片网关”
2. 把 Kling 作为第二个 provider 接入
3. 对外同时保留：
   - 你现在已有的统一/OpenAI 风格图片接口
   - Kling 官方原生兼容接口

这样做，代码可维护性最高，后面也更方便继续接别的图像平台。

## 我建议你下一步直接做什么

如果你要我继续推进，最合理的下一步是：

1. 我先帮你出一版“目录级改造方案”
   - 精确到要新增哪些文件
   - 每个文件放什么职责

2. 然后我可以继续直接在 `/myproject/jimeng-api/` 里给你落第一版骨架代码
   - 先把 provider 抽象层 + Kling auth/client 搭起来
   - 不动核心 jimeng 逻辑

这样风险最小，推进也最快。
