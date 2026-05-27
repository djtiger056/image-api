# images-api 部署指南

## 快速部署（推荐）

```bash
# 1. 克隆项目
git clone https://github.com/djtiger056/image-api.git
cd image-api

# 2. 一键部署
bash scripts/setup.sh

# 3. 编辑配置（填写平台凭证）
vi local.env

# 4. 启动服务
sudo systemctl start images-api
sudo systemctl enable images-api  # 开机自启

# 5. 验证
curl http://127.0.0.1:8006/ping
```

管理后台: `http://你的IP:8006/console`

## 手动部署

如果不想用一键脚本，按以下步骤操作：

### 1. 环境要求

- Node.js >= 18
- npm
- Linux (Ubuntu/Debian/CentOS 均可)

### 2. 安装依赖 & 构建

```bash
npm install --registry https://registry.npmmirror.com/
npm run build
```

### 3. 浏览器安装（Seedance/Kling 网页模式需要）

二选一：

**方案 A - 系统 Chrome（推荐，稳定快速）：**
```bash
# Ubuntu/Debian
apt-get install -y google-chrome-stable

# CentOS/RHEL
yum install -y google-chrome-stable
```

**方案 B - Playwright 自带 Chromium：**
```bash
npx playwright-core install chromium --with-deps
```

> 注意：如果浏览器未安装，服务仍可正常启动，只是 Seedance 视频生成、
> Kling 网页模式等依赖浏览器的功能不可用。纯 API 模式（Jimeng 图片、
> Kling 官方 API、豆包 Seedream）不受影响。

### 4. 配置环境变量

```bash
cp local.env.example local.env
vi local.env
```

填写你需要使用的平台凭证（详见文件内注释）。

### 5. 启动服务

**直接运行：**
```bash
npm start
```

**systemd 托管（推荐生产环境）：**
```bash
# 复制 service 文件（路径按实际修改）
sudo cp deploy/images-api.service /etc/systemd/system/
# 或用 setup.sh 自动生成（路径已正确替换）

sudo systemctl daemon-reload
sudo systemctl start images-api
sudo systemctl enable images-api
```

### 6. 验证

```bash
# 健康检查
curl http://127.0.0.1:8006/ping

# 查看模型列表
curl http://127.0.0.1:8006/v1/models

# 测试生图（需先配置 JIMENG_SESSIONID）
curl -X POST http://127.0.0.1:8006/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的jimeng_sessionid" \
  -d '{"model":"jimeng-4.5","prompt":"美丽的日落风景","ratio":"16:9"}'
```

## Docker 部署

```bash
# 构建
docker build -t images-api:latest .

# 运行
docker run -d --name images-api \
  -p 8006:8006 \
  -e TZ=Asia/Shanghai \
  -e JIMENG_SESSIONID=你的sessionid \
  images-api:latest
```

> Docker 镜像已内置 Chromium，开箱即用。

## 端口冲突

如果 8006 端口被占用，修改 `local.env` 中的 `SERVER_PORT`，或使用一键脚本：

```bash
bash scripts/setup.sh --port 18006
```

## 常见问题

### Q: 启动后 Seedance 视频生成报错 "browser not found"？

检查浏览器是否安装：
```bash
which google-chrome-stable || which chromium-browser || echo "未安装浏览器"
```
按上述「浏览器安装」步骤补装。

### Q: 如何查看服务日志？

```bash
# systemd 方式
sudo journalctl -u images-api -f

# 项目日志文件
tail -f logs/$(date +%Y-%m-%d).log
```

### Q: 如何更新版本？

```bash
cd image-api
git pull
npm install --registry https://registry.npmmirror.com/
npm run build
sudo systemctl restart images-api
```

### Q: 如何配置对外 API Key 鉴权？

在 `local.env` 中添加：
```
SERVER_API_KEYS=your-secret-key-1,your-secret-key-2
```

之后除 `/`、`/ping`、`/console`、`/docs` 外，所有接口需带请求头：
```
x-api-key: your-secret-key-1
```

### Q: 如何在非 root 用户下运行？

```bash
# 修改 service 文件中的 User
sudo vi /etc/systemd/system/images-api.service
# 添加: User=your-user

# 确保项目目录权限
sudo chown -R your-user:your-user /path/to/image-api

sudo systemctl daemon-reload
sudo systemctl restart images-api
```
