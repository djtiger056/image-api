# 可视化控制台与外部 API 调用说明

项目目录：`/myproject/kling-api`

## 新增内容

- 可视化控制台页面：`/console`
- 外部调用说明页面：`/docs/api-guide`
- 服务端凭证保存接口：`POST /console/credentials`
- 服务可用性检测接口：`GET /console/status`

## 控制台能力

1. 输入 `Jimeng sessionid / Authorization`
2. 输入 `Kling cookies JSON / storageState JSON`
3. 保存到服务端运行时
4. 检测服务状态
5. 选择 Jimeng / Kling 生图模型
6. 页面直接发起生图请求并展示结果

## 凭证保存规则

### Jimeng
- 保存 `sessionid` 时，会写入：`local.env -> JIMENG_SESSIONID`
- 同时清除 `JIMENG_AUTHORIZATION` 的优先覆盖，避免 session 保存后不生效

### Kling
- 保存 cookies / storageState 时，会写入：`kling.json`
- 同时写入运行时环境变量：`KLING_WEB_STORAGE_STATE_JSON`

## 外部调用常用接口

### 健康检查
`GET /ping`

### 模型列表
`GET /v1/models`

### Jimeng 生图
`POST /v1/images/generations`

### Kling 生图
`POST /v1/images/generations`
并传：

```json
{
  "model": "kling-v2-1",
  "prompt": "...",
  "provider_options": {
    "transport": "web",
    "target_url": "https://klingai.com/app/image/new"
  }
}
```

## 注意事项

- 如果服务配置了 `SERVER_API_KEYS`，控制台接口和外部 API 都需要携带 `x-api-key`
- `/console` 与 `/docs/api-guide` 设为公开页面，方便浏览器直接打开
- Jimeng 实际可用性可通过 `GET /console/status?deep=1` 看到积分检测结果
- Kling 的登录态检测目前以“已配置且可解析”为主，实际页面是否过期仍以真实生图结果为准
