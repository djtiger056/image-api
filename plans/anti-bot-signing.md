# Anti-Bot 签名实现计划

## 目标
用 Playwright 浏览器生成 anti-bot 签名参数，解决 xyq/doubao 的 API 被拒问题。

## 实现步骤

### Phase 1: 基础设施
- [x] 保存方案为 skill (browser-sign-anti-bot)
- [ ] 安装 Playwright 依赖
- [ ] 创建 BrowserSigner 类

### Phase 2: xyq 适配
- [ ] 实现 xyq 签名捕获（route 拦截器）
- [ ] 移除旧的 fake fp/msToken/a_bogus 代码
- [ ] 集成到 xyqRequest 函数
- [ ] 测试 xyq 生图

### Phase 3: doubao 适配
- [ ] 实现 doubao 签名捕获
- [ ] 移除旧的 fake msToken/a_bogus 代码
- [ ] 集成到 doubaoRequest 函数
- [ ] 测试 doubao 生图

### Phase 4: 验证
- [ ] 通过前端控制台测试 xyq 生图
- [ ] 通过前端控制台测试 doubao 生图
- [ ] 确认 jimeng 仍然正常

## 技术细节

### BrowserSigner 核心设计
- 单例模式，全局共享
- 启动时导航到 xyq.jianying.com（加载 sdk-glue.js）
- 用 page.route() 拦截 API 请求，捕获签名后的 URL
- 通过 Promise 队列实现并发签名
- 自动重启机制（崩溃恢复）

### 签名捕获流程
```
1. 调用 browserSigner.sign(url, method, body)
2. 通过 page.evaluate() 触发浏览器端 fetch
3. route 拦截器捕获签名后的完整 URL
4. 返回 {url, headers} 给调用方
5. 调用方用 axios 发送实际请求
```
