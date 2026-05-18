# Kling 网页免费额度 PoC 使用说明

日期：2026-04-20
项目：`/myproject/kling-api`
脚本：`scripts/kling-web-poc.mjs`

## 目标

这个 PoC 不是正式 provider。

它的用途是：
- 复用 **Kling 网页端登录态**
- 在 **headless Playwright** 里打开 `https://kling.ai/app/image/new`
- 自动填入 prompt 并点击 `Generate`
- 抓取页面里的候选请求/响应
- 产出截图、summary、traffic 日志
- 用来判断：**网页免费额度能不能被稳定封成后端 API**

---

## 当前结论

已确认：
- 未登录状态点击 `Generate` 会弹出登录框
- 页面可见：
  - prompt 输入框
  - Generate 按钮
  - One-click Sign In
  - Sign in with Google / Apple / email
- 因此要继续做网页额度 PoC，**必须先带入有效网页登录态**

---

## 脚本能力

`scripts/kling-web-poc.mjs` 支持：

1. 读取 Playwright `storageState` JSON
2. 或读取浏览器扩展导出的 `cookies.json`
3. 自动转成 Playwright 可用的登录态
4. 打开 Kling 图片创作页
5. 填 prompt
6. 点击 `Generate`
7. 抓取候选请求：
   - fetch/xhr
   - 过滤静态资源/分析埋点
   - 保留可能和图片生成/任务/资产相关的流量
8. 输出到 `tmp/kling-web-poc/`

---

## 产物位置

默认输出目录：

`tmp/kling-web-poc/`

运行后会生成：
- `01-page-loaded.png`
- `02-after-generate.png`
- `summary.json`
- `captured-traffic.json`
- `page-url.txt`
- `storage-state.json`（如果输入的是 cookies.json，会自动生成）

---

## 推荐用法

### 方式 A：你已经有 Playwright storageState

```bash
cd /myproject/kling-api
node scripts/kling-web-poc.mjs \
  --storage-state tmp/kling-web-poc/storage-state.json \
  --prompt "A cinematic fox walking through neon rain, ultra-detailed"
```

### 方式 B：你从浏览器导出了 cookies.json

```bash
cd /myproject/kling-api
node scripts/kling-web-poc.mjs \
  --cookies-json /path/to/kling-cookies.json \
  --prompt "A cinematic fox walking through neon rain, ultra-detailed"
```

---

## 如何准备网页登录态

### 推荐方法：浏览器扩展导出 cookies

在你自己的本地浏览器里：
1. 登录 Kling 网站
2. 打开 `https://kling.ai/app/image/new`
3. 用 cookies 导出扩展（例如 EditThisCookie 一类）导出当前站点 cookies 为 JSON
4. 把 JSON 文件传到服务器
5. 用 `--cookies-json` 跑 PoC

### 注意
如果登录态依赖：
- 短时 token
- 指纹绑定
- localStorage / sessionStorage
- 风控校验

那单纯 cookies 可能不够。

这种情况下要进一步升级 PoC：
- 支持导入更完整的 `storageState`
- 或做一次有界面的人工登录录制

---

## 成功/失败怎么看

看 `summary.json`：

### 1. `login_required_or_session_expired`
说明：
- 登录态没带上
- cookies 失效
- 账号被风控拦截
- 页面要求重新登录

### 2. `captured_candidate_requests`
说明：
- 已抓到一批可能与图片生成相关的网页请求
- 下一步就能分析：
  - 请求地址
  - 请求头
  - body
  - 响应结构
  - task id / asset id / queue status

### 3. `no_candidate_requests_observed`
说明：
- 点击 Generate 后没有看到目标流量
- 可能是：
  - 选择器没点中
  - 页面改版
  - 请求走 WebSocket / worker
  - 网站前端生成前先做了别的校验

---

## 当前限制

这个 PoC 还只是 **第一阶段抓流量脚本**，还没做：
- 自动完成网页登录
- 自动刷新过期登录态
- 将抓到的网页请求封装回 `/v1/images/generations`
- 自动轮询网页任务结果
- 免费额度余量探测
- 风控/验证码恢复

---

## 建议的下一阶段

如果你拿到一份有效网页登录态，并且 `summary.json` 出现：

`captured_candidate_requests`

那下一步就做这 3 件事：

1. 从 `captured-traffic.json` 里确认真正的生图提交请求
2. 抽出：
   - 请求 URL
   - headers
   - body 模板
   - 响应里的任务 ID
3. 再做一个第二阶段脚本：
   - `scripts/kling-web-submit-poc.mjs`
   - 直接复放网页请求
   - 查询任务状态
   - 下载结果图

---

## 风险提醒

这个方向只能当实验用途，不建议直接作为正式主链路，因为它天然有这些风险：
- 登录态失效
- 风控/验证码
- 页面字段变更
- 免费额度规则变化
- 账号封控
- 请求参数混淆/签名升级

所以更稳的正式方案依然是：
- Kling 官方 API provider
- 网页免费额度 PoC 仅作补充实验
