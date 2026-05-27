# images-api

多平台逆向 API 统一生图/视频服务 — 封装 Jimeng（即梦）、Kling（可灵）、Doubao（豆包）、XYQ（小云雀）、Qwen（通义千问）五大平台，提供 OpenAI 兼容格式接口。

## 功能一览

| 平台 | 文生图 | 图生图 | 视频生成 | 免费额度 |
|------|--------|--------|----------|----------|
| Jimeng | ✅ | ✅ | ✅ (含 Seedance 2.0) | 需登录 |
| Kling | ✅ (官方 API + 网页模式) | ✅ | - | 网页模式免费 |
| Doubao | ✅ (Seedream 4.5/4.0/3.0) | - | ✅ (Seedance 2.0 Fast) | 每日10次 |
| XYQ | ✅ (Seedream 5.0/4.5/4.0) | - | ✅ | 需登录 |
| Qwen | - | - | ✅ | 免费 |

## 快速部署

```bash
git clone https://github.com/djtiger056/image-api.git   # 克隆项目到本地
cd image-api                                            # 进入项目目录
bash scripts/setup.sh                                   # 一键安装依赖、构建项目、安装浏览器并生成 systemd 服务
vi local.env                                            # 编辑本地配置文件，填写各平台凭证
sudo systemctl start images-api                         # 启动 images-api 服务
sudo systemctl enable images-api                        # 设置开机自启，避免服务器重启后服务丢失
curl http://127.0.0.1:8006/ping                         # 调用健康检查接口，确认服务已正常启动
```

详细部署文档见 [DEPLOY.md](DEPLOY.md)。

## 服务管理指令

如果你是通过 `bash scripts/setup.sh` 安装，默认生成的服务名就是 `images-api`。下面这套命令可直接用于日常后台管理。

### 基础管理

```bash
sudo systemctl start images-api                         # 启动服务，适合首次启动或服务已停止时使用
sudo systemctl stop images-api                          # 停止服务，适合维护、升级或临时下线时使用
sudo systemctl restart images-api                       # 重启服务，适合更新代码或修改配置后使其立即生效
sudo systemctl reload images-api                        # 重新加载服务配置，前提是该服务支持 reload 动作
sudo systemctl status images-api                        # 查看服务当前状态、最近日志和退出码
sudo systemctl is-active images-api                     # 只检查服务是否正在运行，适合脚本里做状态判断
sudo systemctl is-enabled images-api                    # 检查服务是否已设置为开机自启
```

### 开机自启管理

```bash
sudo systemctl enable images-api                        # 设置服务开机自启，推荐生产环境开启
sudo systemctl disable images-api                       # 取消开机自启，但不会立刻停止当前正在运行的服务
sudo systemctl reenable images-api                      # 重新写入开机自启链接，适合 service 文件调整后修复自启配置
```

### 查看日志

```bash
sudo journalctl -u images-api -f                        # 实时追踪服务日志，排查启动失败和运行时报错最常用
sudo journalctl -u images-api -n 100 --no-pager         # 查看最近 100 行日志，适合快速回溯最近一次故障
sudo journalctl -u images-api --since "1 hour ago"      # 查看最近 1 小时日志，适合定位某个时间段的问题
tail -f logs/$(date +%Y-%m-%d).log                      # 实时查看项目当天生成的应用日志文件
```

### 配置修改后生效

```bash
vi local.env                                            # 编辑项目配置，例如端口、API Key、各平台凭证
sudo systemctl restart images-api                       # 配置文件修改后重启服务，使新的环境变量立即生效
```

如果你修改的是 systemd 服务文件本身，例如 `/etc/systemd/system/images-api.service`，需要先执行下面这组命令：

```bash
sudo systemctl daemon-reload                            # 重新加载 systemd 配置，识别更新后的 service 文件
sudo systemctl restart images-api                       # 重启服务，应用新的 service 启动参数
sudo systemctl status images-api                        # 再次确认服务是否已按新配置正常运行
```

### 发布更新

```bash
cd /path/to/image-api                                   # 进入项目实际部署目录
git pull origin main                                    # 拉取远端最新代码到本地
npm install --registry https://registry.npmmirror.com/  # 安装或同步最新依赖
npm run build                                           # 重新构建项目产物
sudo systemctl restart images-api                       # 重启服务，让新版本代码正式生效
sudo systemctl status images-api                        # 检查更新后服务状态是否正常
```

### 健康检查与端口排查

```bash
curl http://127.0.0.1:8006/ping                         # 检查接口是否返回健康状态
curl http://127.0.0.1:8006/v1/models                    # 检查模型列表接口是否可正常访问
ss -ltnp | grep 8006                                    # 查看 8006 端口是否已被服务监听
ps -ef | grep images-api | grep -v grep                # 辅助查看是否存在相关进程
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/images/generations` | POST | 文生图 / 图生图 |
| `/v1/images/compositions` | POST | 图生图（文件上传） |
| `/v1/videos/generations` | POST | 视频生成（含 Seedance 2.0） |
| `/v1/videos/generations/async` | POST | 异步视频生成（提交任务） |
| `/v1/videos/generations/async/:taskId` | GET | 异步视频生成（查询结果） |
| `/v1/doubao/videos/generations` | POST | 豆包视频生成 |
| `/v1/doubao/videos/generations/stream` | POST | 豆包视频生成（SSE 流式） |
| `/v1/chat/completions` | POST | OpenAI 兼容对话接口 |
| `/v1/models` | GET | 可用模型列表 |
| `/token/check` | POST | Token 有效性检查 |
| `/token/points` | POST | 账户积分查询 |
| `/ping` | GET | 健康检查 |

更完整的外部接入说明：

- 视频接入文档：`docs/video-external-api.md`
- 前后端复制模板：`docs/video-integration-templates.md`
- 页面版调用说明：`/docs/api-guide`

## 调用示例

### 文生图

```bash
curl -X POST http://127.0.0.1:8006/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的jimeng_sessionid" \
  -d '{
    "model": "jimeng-4.5",
    "prompt": "美丽的日落风景，湖边的小屋",
    "ratio": "16:9",
    "resolution": "2k"
  }'
```

### 豆包生图

```bash
curl -X POST http://127.0.0.1:8006/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的doubao_sessionid" \
  -d '{
    "model": "doubao-seedream-4.5",
    "prompt": "赛博朋克风格的城市夜景"
  }'
```

### 视频生成

```bash
curl -X POST http://127.0.0.1:8006/v1/videos/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的jimeng_sessionid" \
  -d '{
    "model": "jimeng-video-3.5-pro",
    "prompt": "一只小猫在花园里追逐蝴蝶"
  }'
```

### 豆包 / 千问视频

```bash
curl -X POST http://127.0.0.1:8006/v1/doubao/videos/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的doubao_sessionid" \
  -d '{
    "model": "doubao-seedance-2.0-fast",
    "prompt": "一只小猫在草地上欢快地奔跑",
    "ratio": "16:9",
    "duration": 5
  }'
```

```bash
curl -X POST http://127.0.0.1:8006/v1/qwen/videos/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的qwen_cookie" \
  -d '{
    "model": "qwen-happyhorse-1.0",
    "prompt": "一匹马在草原上奔跑",
    "ratio": "16:9",
    "duration": 10
  }'
```

## 认证方式

使用各平台的 `sessionid` Cookie 作为 Bearer Token：

- **Jimeng**: 登录 jimeng.jianying.com → F12 → Application → Cookies → `sessionid`
- **Doubao**: 登录 doubao.com → F12 → Application → Cookies → `sessionid`
- **XYQ**: 登录 xyq.jianying.com → F12 → Application → Cookies → `sessionid`
- **Kling**: 官方 API 使用 AccessKey/SecretKey；网页模式使用登录态 JSON
- **Qwen**: 登录 create.qianwen.com 后粘贴完整 Cookie 字符串或 Cookie-Editor JSON 数组；服务会同步到 `qwen.json`，并自动合并接口返回的 `Set-Cookie` 以延长登录态

多账号支持：逗号分隔多个 sessionid。
Qwen 多账号使用 `|||` 分隔完整 Cookie。

## 管理后台

启动后访问 `http://你的IP:8006/console`，可在线管理 Token、测试生图、查看模型列表。

## 项目结构

```
src/
├── index.ts                    # 入口
├── api/
│   ├── controllers/            # 业务逻辑（images, videos, chat, core）
│   ├── routes/                 # API 路由定义
│   └── consts/                 # 异常定义
├── lib/
│   ├── server.ts               # Koa 服务器
│   ├── browser-service.ts      # Playwright 浏览器代理（shark 反爬绕过）
│   ├── x-bogus.ts / x-gnarly.ts # 签名算法
│   ├── config.ts               # 配置管理
│   └── ...                     # 日志、工具、中间件
└── providers/
    ├── jimeng/                 # 即梦 provider
    ├── kling/                  # 可灵 provider（API + 网页模式）
    ├── doubao/                 # 豆包 provider
    ├── xyq/                    # 小云雀 provider
    └── seedream/               # 统一 Seedream provider
```

## 技术栈

- **Runtime**: Node.js >= 18
- **Framework**: Koa
- **Language**: TypeScript (tsup 构建)
- **Browser**: Playwright-core (Chromium)
- **部署**: systemd / Docker

## 许可证

ISC
