# Kling / Jimeng 兼容收口说明

项目目录：`/myproject/kling-api`

这个文档用于说明当前仓库已经从早期的 “jimeng-api-kling 骨架” 收口到什么状态，以及现在该看哪些文档。

## 当前状态

当前项目已经不是只接了一个 Kling 骨架，而是实际具备：
- Jimeng 原有图像 / 视频 / chat 能力
- Kling 网页免费额度模式转发（当前唯一 Kling 链路）
- 统一图片入口 `POST /v1/images/generations`
- Kling 网页异步任务查询 `GET /v1/images/generations/:id`
- 可选 `x-api-key` 服务端鉴权
- Jimeng 服务端凭证回退

## 目录和命名说明

历史上这里曾被当成 `jimeng-api-kling` 开发副本。

现在实际目录是：
- `/myproject/kling-api`

所以如果你看到旧文档还写：
- `/myproject/jimeng-api-kling`

以当前目录 `/myproject/kling-api` 为准。

## 关键能力对照

### Kling 网页模式
- 走浏览器自动化
- 适合复用网页登录态和免费额度
- 支持：同步 / 异步 / 任务查询 / 调试产物 / 任务落盘查询
- 已解决历史图误判、结果 URL 去重等基础问题
- 仍受页面改版、登录失效、验证码、风控影响

### Jimeng 回退能力
- 对外只暴露 `x-api-key` 时，Jimeng 请求可不传 Authorization
- 服务会优先使用请求头 Authorization
- 缺失时回退到 `JIMENG_AUTHORIZATION` 或 `JIMENG_SESSIONID`

## 推荐启动方式

```bash
cd /myproject/kling-api
cp local.env.example local.env
npm install
npm run build
npm test
./scripts/start-local.sh
```

## 最小验证清单

1. 服务健康检查
```bash
curl http://127.0.0.1:18080/ping
curl http://127.0.0.1:18080/v1/models
```

2. Kling 网页模式异步提交
```bash
curl -X POST http://127.0.0.1:18080/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "kling-v2-1",
    "prompt": "一只小狐狸站在雨夜街头",
    "async": true,
    "provider_options": {
      "transport": "web",
      "target_url": "https://klingai.com/app/image/new"
    }
  }'
```

3. 查询任务
```bash
curl http://127.0.0.1:18080/v1/images/generations/<task_id>
```

## 你现在优先应该看哪几个文档

- 直接使用 Kling 网页模式：`docs/kling-web-quickstart.md`
- 看最近收口结论：`docs/2026-04-22-kling-api-forwarding-feasibility.md`
- 看网页模式阶段进度：`docs/2026-04-21-kling-web-mode-progress.md`
- 总览说明：`README.md`

## 当前还没完全收掉的点

- README 之外仍有部分历史分析文档保留旧目录名，这是历史记录，不影响代码运行
- Kling 网页模式的 UI 参数映射还不完整
- 更成熟的对外服务化还需要继续补：并发治理、监控告警、风控兜底

一句话说，现在这个项目已经能当你自己的 Kling 网页 API 转发服务来用了，但网页免费额度模式仍应被视为实验性补充链路。
