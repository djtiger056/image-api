# 本地部署说明（余念安已完成）

部署目录：`/myproject/jimeng-api`

## 我实际采用的方式
- 按仓库说明完成源码部署
- 依赖已安装：`npm install`
- 由于当前机器下载 Playwright 自带 Chromium 很慢，已做兼容处理：服务支持通过环境变量 `BROWSER_EXECUTABLE_PATH` 指向系统浏览器
- 当前机器已配置系统浏览器：`/usr/bin/google-chrome-stable`
- 为避免和机器上已占用的 `8000` 端口冲突，改为本地使用 `18000`

## 本地配置文件
文件：`/myproject/jimeng-api/local.env`

包含：
- `SERVER_HOST=0.0.0.0`
- `SERVER_PORT=18000`
- `BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable`
- `JIMENG_SESSIONID=你提供的 sessionid`

说明：
1. 服务本身仍然按项目原设计，从请求头 `Authorization: Bearer <sessionid>` 读取账号凭证
2. 我把 sessionid 放进 `local.env`，只是为了方便本机测试脚本复用
3. 如果后面你换新的 sessionid，只改 `local.env` 里的 `JIMENG_SESSIONID` 即可

## 启动方式
```bash
cd /myproject/jimeng-api
bash scripts/start-local.sh
```

## 验证方式
```bash
cd /myproject/jimeng-api
bash scripts/test-local.sh
```

## 常用调用示例
模型列表：
```bash
curl http://127.0.0.1:18000/v1/models
```

查询积分：
```bash
curl -X POST http://127.0.0.1:18000/token/points \
  -H "Authorization: Bearer 你的sessionid" \
  -H "Content-Type: application/json" \
  -d '{}'
```

文生图：
```bash
curl -X POST http://127.0.0.1:18000/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的sessionid" \
  -d '{
    "model": "jimeng-4.5",
    "prompt": "美丽的日落风景，湖边的小屋",
    "ratio": "16:9",
    "resolution": "2k"
  }'
```

## 这次本地兼容修改
文件：`src/lib/browser-service.ts`

改动：
- 新增读取环境变量 `BROWSER_EXECUTABLE_PATH`
- 如果设置了该变量，则 Playwright 直接调用系统 Chrome，而不强制依赖下载 Playwright 自带 Chromium

这样在当前这台 Ubuntu 云服务器上更稳，也更适合长期开机使用。
