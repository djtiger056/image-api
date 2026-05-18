# Kling vs Jimeng 生图能力调研与可行性结论

日期：2026-04-20
项目：`/myproject/kling-api`

## 一句话结论

- **做 Kling 图片 API 兼容是可行的**，而且你本地的 `kling-api` 已经做出了 **第一版可用骨架**。
- **要做到“和当前本地 Jimeng 项目完全同等级效果”**，目前 **还没完全达到**，但在图片能力上 **可以继续补齐到比较接近**。
- **如果目标是“利用 Kling 网站免费额度，把网页生图封成 API”**：
  - **技术上可尝试**，
  - **但不建议作为主方案**，
  - 因为这条路依赖网页登录态、前端私有接口、风控与页面变化，**稳定性和可维护性都明显差于官方 API**。
- **Kling 官方本身已经有正式图片 API**，所以更推荐走 **官方 API 适配 + 统一网关**，而不是去硬抠网页免费额度。

---

## 已核实的信息来源

### 1. 本地项目代码/文档
- `/myproject/jimeng-api/CLAUDE.md`
- `/myproject/jimeng-api/src/api/controllers/images.ts`
- `/myproject/jimeng-api/docs/plans/2026-04-20-kling-image-compat-plan.md`
- `/myproject/kling-api/docs/kling-compat.md`
- `/myproject/kling-api/src/api/routes/images.ts`
- `/myproject/kling-api/src/providers/kling/client.ts`
- `/myproject/kling-api/src/providers/kling/auth.ts`
- `/myproject/kling-api/src/providers/kling/image-provider.ts`
- `/myproject/kling-api/src/providers/kling/mapper.ts`
- `/myproject/kling-api/tests/kling-image-route.test.mjs`

### 2. Kling 官方页面 / 文档
- `https://kling.ai/`
- `https://kling.ai/document-api/apiReference/model/imageGeneration`
- `https://kling.ai/document-api/apiReference/model/multiImageToImage`
- `https://kling.ai/document-api/apiReference/model/imageModels`
- `https://kling.ai/document-api/apiReference/accountInfoInquiry`
- `https://kling.ai/dev/pricing`

---

## 当前本地 Jimeng 项目已经做到什么

根据本地 `jimeng-api` 文档与代码，当前主项目已经具备：

### 图片能力
- `POST /v1/images/generations`
  - 文生图
  - 图生图
- `POST /v1/images/compositions`
  - 多图合成 / 图生图
- 支持模型：
  - `jimeng-5.0`
  - `jimeng-4.6`
  - `jimeng-4.5`
  - `jimeng-4.1`
  - `jimeng-4.0`
  - 更早版本兼容
- 支持分辨率：
  - `1k`
  - `2k`
  - `4k`
- 支持比例：
  - `1:1`
  - `4:3`
  - `3:4`
  - `16:9`
  - `9:16`
  - `3:2`
  - `2:3`
  - `21:9`
- 多图输入：
  - 统一 `images[]`
  - 最多 10 张
- 支持 JSON URL 输入与 multipart 文件上传
- 输出兼容 OpenAI 风格

### 架构特点
- 认证靠即梦网站 `sessionid` / Cookie
- 本质是**网页链路逆向/封装**
- 对外做成统一 OpenAI 兼容接口
- 你现在这套 Jimeng 路线，核心优势是：
  - 已经贴近你现有项目调用方式
  - 已经把网站能力包装成“服务端 API”了
  - 多图统一抽象比较方便

---

## 当前本地 kling-api 已实现到哪一步

根据 `docs/kling-compat.md` 和实际代码，当前 `kling-api` 已经完成：

### 已完成
- 独立项目目录：`/myproject/kling-api`
- 增加 provider 抽象层：Jimeng / Kling
- `POST /v1/images/generations`
  - 继续支持原有 Jimeng 风格统一请求
  - 支持 `model=kling-*` 自动分发给 Kling provider
  - 支持 Kling 原生 `model_name` 请求直通
- `POST /v1/images/compositions`
  - 保留统一多图入口
  - 当 `model=kling-*` 时走 Kling provider
- 新增 Kling 原生任务接口：
  - `GET /v1/images/generations`
  - `GET /v1/images/generations/:id`
  - `POST /v1/images/multi-image2image`
  - `GET /v1/images/multi-image2image/:id`
- `/v1/models` 已加入 Kling 模型展示
- Kling 网页登录态支持：
  - 通过 `storageState` / `cookies` 提交网页登录态
  - 或直接读取项目根目录 `./kling.json`
- 内置同步包装：
  - 上游 Kling 是异步 task
  - 本地统一接口可轮询后返回最终 URL

### 实测状态
已在本地运行：
- `npm test -- --test tests/kling-image-route.test.mjs`
- 结果：**4/4 通过**

覆盖内容包括：
- Kling 统一异步请求包装
- Kling 统一同步请求轮询并返回图片 URL
- `model -> model_name` 映射正确
- Kling 原生 body 直通正确

### 当前限制
- 统一接口下，Kling 目前只做了：
  - 文生图
  - 单图图生图
- Kling 多图能力目前还没在统一语义层完全抽象
  - 现在原生接口可用：`/v1/images/multi-image2image`
  - 但统一 `images[]` 自动映射成 `subject/scene/style` 还没做完善
- 还没补完整能力表校验 / 错误码映射 / 回调处理

---

## Kling 官方图片 API 能力，和 Jimeng 的主要差异

## 1) 认证方式不同

### Jimeng
- 用网站登录态 `sessionid`
- 本质偏“网页逆向接口”

### Kling
- 官方 API 文档明确支持：
  - `Authorization: Bearer <token>`
  - token 可由 `AccessKey + SecretKey` 生成 JWT
- `src/providers/kling/auth.ts` 已按这个方式实现

**结论：**
Kling 这块比 Jimeng 更正规，**更适合长期服务化**。

---

## 2) 接口风格不同

### Jimeng 当前统一接口风格
- `model`
- `prompt`
- `images[]`
- `ratio`
- `resolution`
- `sample_strength`

### Kling 官方图片接口风格
#### 文生图 / 单图图生图
- `POST /v1/images/generations`
- 常用字段：
  - `model_name`
  - `prompt`
  - `negative_prompt`
  - `image`
  - `aspect_ratio`
  - `resolution`
  - `n`
  - `callback_url`
  - `external_task_id`
  - `watermark_info`

#### 多图图生图
- `POST /v1/images/multi-image2image`
- 字段是带语义的：
  - `subject_image_list`
  - `scene_image`
  - `style_image`

**结论：**
- Jimeng 的统一多图输入更“粗粒度”
- Kling 的多图输入更“结构化 / 语义化”

也就是说，**Kling 不是不能做成统一接口，而是要多一层语义映射。**

---

## 3) 任务模型不同

### Jimeng
- 当前项目对外更多是“同步拿结果”的体验
- 服务端内部自己轮询

### Kling
- 官方就是 task 模式：
  - 创建任务
  - 轮询 `GET /v1/images/generations/{id}`
  - 或轮询 `GET /v1/images/multi-image2image/{id}`
  - 支持 `callback_url`

**结论：**
Kling 原生更适合异步任务系统，也更适合将来做统一图片网关。

---

## 4) 模型与能力差异

### Kling 官方模型页可确认的图片模型
- `kling-v1`
- `kling-v1-5`
- `kling-v2`
- `kling-v2-new`
- `kling-v2-1`
- `kling-v3`
- `kling-v3-omni`
- `kling-image-o1`

### Kling 官方模型页可确认的图片能力
- 文生图
- 单图图生图
- subject / face 参考图
- multi-image to image
- restyle
- element control
- series-image generation
- 1K / 2K / 4K（新模型支持更强）
- 智能比例 / 自定义比例（部分新模型支持）

### Jimeng 本地项目当前对外优势
- 统一接口更成熟
- `images[]` 多图泛化做得更顺手
- 和你现有调用方兼容更强
- 反向封装已经打磨过一轮

**结论：**
- **就“官方图片 API 能力上限”看，Kling 不弱，甚至在官方开放度上更好。**
- **就“你当前本地项目的现成统一封装成熟度”看，Jimeng 目前领先。**

---

## Kling 能不能做到“和当前本地 Jimeng 项目一样的效果”？

## 短答
**能接近，但现在还没完全到位。**

## 分项判断

### A. 文生图
- **能**
- 现在已经接上
- 统一路由已支持

### B. 单图图生图
- **能**
- 现在已经接上

### C. 多图图生图
- **能做，但还没完全做完统一抽象**
- Kling 官方有原生接口 `multi-image2image`
- 但它不是简单 `images[]`，而是：
  - 主体图
  - 场景图
  - 风格图
- 所以如果你想复制 Jimeng 现在“随手丢多张图就生成”的体验，需要额外做：
  - 语义映射
  - 默认推断策略
  - 显式 provider_options

### D. OpenAI 风格统一 API 兼容
- **能**
- 当前已经有第一版

### E. 稳定服务化
- **如果走官方 API：能，且更稳**
- **如果走网页免费额度：能试，但很脆**

### F. 完全达到当前 Jimeng 现有成熟度
- **暂时不能直接说已经达到**
- 还差：
  - Kling 多图语义层完善
  - 完整错误码映射
  - 更细的模型能力校验
  - 回调 / webhook / 异步任务追踪
  - 更完整测试矩阵

---

## “利用免费额度，把网站生图转成 API”这件事到底可不可行？

## 先说结论
### 技术上：
**可尝试。**

### 工程上：
**不建议作为主线方案。**

### 产品上：
**风险高。**

---

## 为什么不建议把“网站免费额度”当核心方案

### 1. Kling 已经有官方 API
既然官方已经提供：
- 正式鉴权
- 正式 task 查询
- 正式文档
- 正式计费

那再去套网页免费额度，本质就是：
- 为了省资源包成本，换来
- 更高维护成本
- 更高封号/风控风险
- 更差稳定性

### 2. 网页免费额度和 API 资源包不是同一套体系的概率很大
从官方文档能确认：
- API 侧是 **resource pack / unit deduction** 体系
- 还有 `/account/costs` 查询资源包余额

而官网创作页展示的“free credits / trial”更像 **消费端工作台权益**。

**这意味着：**
- 网页送的免费额度，不一定能直接用于 API 平台
- 即使同账号，也不保证互通
- 更不保证长期稳定

### 3. 免费额度通常伴随这些问题
- 登录态失效
- 风控校验
- 滑块 / 验证码 / 邮箱验证
- 水印
- 队列更慢
- 免费模型和付费模型能力差异
- 页面前端字段频繁改

### 4. 若走网页自动化，会比 Jimeng 更难维护
Jimeng 你现在已经有现成逆向基础和兼容链路。

而 Kling 如果要抠网页免费额度，通常要面对：
- 前端 SPA / 动态签名
- 请求链复杂
- 任务轮询逻辑在前端拼装
- 可能存在设备指纹 / 风控 token
- 页面更新后自动化脚本很容易失效

---

## 更合理的路线建议

## 推荐路线 A：官方 API + 统一图片网关（主推荐）

### 适合目标
- 给其他项目稳定提供接口
- 长期部署
- 低维护成本
- 质量可控

### 方案
- 保留现有 `jimeng-api` 统一协议
- 把 Kling 当成第二个 provider
- 对外仍然提供：
  - `POST /v1/images/generations`
  - `POST /v1/images/compositions`
- 内部按模型/参数路由到：
  - Jimeng provider
  - Kling provider

### 优点
- 稳
- 合法边界更清晰
- 便于后面继续接别的 provider
- 更适合做你后续多项目复用的图片网关

---

## 备选路线 B：网页自动化 / 私有接口逆向（只建议实验，不建议主线）

### 适合目标
- 只是短期验证
- 想试下网站免费额度能不能转 API
- 可接受不稳定和高维护

### 可能做法
- Playwright 登录 Kling 网页工作台
- 保持 cookie / localStorage / 指纹环境
- 模拟文生图提交
- 轮询前端任务接口
- 下载结果图
- 本地再包成 `/v1/images/generations`

### 问题
- 登录态容易失效
- 验证码/风控会卡死
- 免费额度可能很少
- 页面字段一变就坏
- 并发能力差
- 账号风控风险高

### 结论
**可以做 PoC，但不建议拿来做长期 API 服务。**

---

## 我对你当前问题的最终判断

## 1. Kling 和 Jimeng 有哪些关键区别？
最核心就四个：
- **认证不同**：Jimeng 更像网页登录态；Kling 有官方 AK/SK API
- **任务模型不同**：Jimeng 现有项目偏同步体验；Kling 原生 task 异步
- **多图语义不同**：Jimeng 是通用 `images[]`；Kling 是 `subject/scene/style`
- **稳定性不同**：Kling 官方 API 明显更适合长期服务化

## 2. 能不能做到和当前本地 Jimeng 项目一样？
- **图片方向：能做到大部分，当前已做出第一版**
- **完全达到现有成熟度：暂时还没完全到位**
- **再补一轮多图语义层和能力映射后，图片部分可以很接近**

## 3. 能不能利用免费网站免费额度转成 API？
- **技术上可以研究 / 做 PoC**
- **但不建议作为正式方案**
- **更推荐直接用 Kling 官方 API**

---

## 建议你下一步怎么做

### 如果你的目标是“尽快可用”
优先走：
1. 继续完善 `kling-api`
2. 把 Kling 图片能力补齐到统一接口
3. 先不碰网页免费额度自动化

### 如果你的目标是“尽量白嫖测试”
可以单独做一个实验分支：
1. 新建 `browser-kling-provider`
2. 只做 Playwright PoC
3. 验证：
   - 是否能稳定登录
   - 是否能稳定提交图片任务
   - 是否会频繁触发验证码/风控
   - 免费额度是否真能持续支持
4. 只要稳定性不好，就立刻止损

---

## 我建议的实际决策

### 正式方案
- **Jimeng：继续保留现有逆向封装链路**
- **Kling：走官方 API 适配**
- **外层统一成一个图片网关**

### 实验方案
- 如果你特别想验证“白嫖免费额度转 API”，
- 就把它定义成 **PoC / 实验性 provider**，
- 不要让主业务依赖它。

---

## 当前可直接复用的本地结论

- 目录：`/myproject/kling-api`
- 当前已通过 Kling 图片路由测试：**4/4 pass**
- 当前最适合的继续方向：
  - 补 Kling 多图统一语义层
  - 完善模型能力表
  - 完善错误码与任务状态映射
  - 再决定要不要单独做“网站免费额度 PoC”

---

## 如果继续开发，我建议的优先级

1. **先把官方 Kling provider 做完整**
2. **把统一接口补齐到接近 Jimeng 体验**
3. **最后再决定要不要开网页免费额度实验分支**

这样最省时间，也最稳。
