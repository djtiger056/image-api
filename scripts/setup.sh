#!/usr/bin/env bash
# images-api 一键部署脚本
# 用法: bash scripts/setup.sh [--port 8000] [--no-browser] [--no-systemd] [--install-dir /path]
set -euo pipefail

# ==================== 默认值 ====================
PORT=8000
INSTALL_BROWSER=true
SETUP_SYSTEMD=true
INSTALL_DIR=""
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ==================== 参数解析 ====================
while [[ $# -gt 0 ]]; do
  case $1 in
    --port) PORT="$2"; shift 2 ;;
    --no-browser) INSTALL_BROWSER=false; shift ;;
    --no-systemd) SETUP_SYSTEMD=false; shift ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    -h|--help)
      echo "用法: bash scripts/setup.sh [选项]"
      echo ""
      echo "选项:"
      echo "  --port PORT          服务端口 (默认: 8000)"
      echo "  --no-browser         跳过浏览器安装"
      echo "  --no-systemd         跳过 systemd 服务配置"
      echo "  --install-dir DIR    指定安装目录 (默认: 当前项目目录)"
      echo "  -h, --help           显示帮助"
      exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

cd "$PROJECT_ROOT"

echo "=========================================="
echo "  images-api 部署脚本"
echo "  项目目录: $PROJECT_ROOT"
echo "  服务端口: $PORT"
echo "=========================================="

# ==================== 1. 检查 Node.js ====================
echo ""
echo "[1/5] 检查 Node.js ..."
if ! command -v node &>/dev/null; then
  echo "  未检测到 Node.js，正在安装 ..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
    apt-get install -y nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_lts.x | bash -
    yum install -y nodejs
  else
    echo "  [错误] 无法自动安装 Node.js，请手动安装 v18+"
    exit 1
  fi
fi
NODE_VER=$(node -v)
echo "  Node.js: $NODE_VER"

# ==================== 2. 安装依赖 & 构建 ====================
echo ""
echo "[2/5] 安装依赖 & 构建 ..."
npm install --registry https://registry.npmmirror.com/
npm run build
echo "  构建完成"

# ==================== 3. 安装浏览器 ====================
echo ""
echo "[3/5] 浏览器检查 ..."
BROWSER_PATH=""

# 优先找系统 Chrome
for bin in google-chrome-stable google-chrome chromium-browser chromium; do
  if command -v "$bin" &>/dev/null; then
    BROWSER_PATH="$(command -v "$bin")"
    echo "  检测到系统浏览器: $BROWSER_PATH"
    break
  fi
done

if [[ -z "$BROWSER_PATH" ]] && [[ "$INSTALL_BROWSER" == "true" ]]; then
  echo "  未检测到系统浏览器，正在通过 Playwright 安装 Chromium ..."
  echo "  (这可能需要几分钟，取决于网络速度)"
  npx playwright-core install chromium --with-deps 2>&1 || {
    echo "  [警告] Playwright Chromium 安装失败"
    echo "  你可以稍后手动安装:"
    echo "    npx playwright-core install chromium --with-deps"
    echo "  或安装系统 Chrome:"
    echo "    apt-get install -y google-chrome-stable"
    echo "  Seedance/Kling 网页模式等依赖浏览器的功能将不可用"
  }
  # 找 playwright 安装的 chromium
  PW_CHROMIUM=$(find /root/.cache/ms-playwright -name "chrome" -type f 2>/dev/null | head -1)
  if [[ -n "$PW_CHROMIUM" ]]; then
    BROWSER_PATH="$PW_CHROMIUM"
    echo "  Playwright Chromium: $BROWSER_PATH"
  fi
elif [[ -z "$BROWSER_PATH" ]]; then
  echo "  [跳过] 未安装浏览器且 --no-browser，Seedance/Kling 网页模式将不可用"
fi

# ==================== 4. 配置 local.env ====================
echo ""
echo "[4/5] 配置环境变量 ..."
if [[ ! -f "local.env" ]]; then
  cp local.env.example local.env
  # 写入端口
  sed -i "s/^SERVER_PORT=.*/SERVER_PORT=$PORT/" local.env
  # 写入浏览器路径
  if [[ -n "$BROWSER_PATH" ]]; then
    sed -i "s|^BROWSER_EXECUTABLE_PATH=.*|BROWSER_EXECUTABLE_PATH=$BROWSER_PATH|" local.env
  fi
  echo "  已创建 local.env (从 local.env.example 复制)"
  echo "  请编辑 local.env 填写你的平台凭证 (JIMENG_SESSIONID 等)"
else
  echo "  local.env 已存在，跳过"
fi

# ==================== 5. systemd 服务 ====================
echo ""
echo "[5/5] systemd 服务 ..."
if [[ "$SETUP_SYSTEMD" == "true" ]] && command -v systemctl &>/dev/null; then
  SERVICE_FILE="/etc/systemd/system/images-api.service"
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=images-api 多平台生图服务
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_ROOT
ExecStart=$(which node) --env-file=$PROJECT_ROOT/local.env --enable-source-maps --no-node-snapshot $PROJECT_ROOT/dist/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=FORCE_COLOR=1

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  echo "  已创建 $SERVICE_FILE"
  echo ""
  echo "  启动服务:  sudo systemctl start images-api"
  echo "  开机自启:  sudo systemctl enable images-api"
  echo "  查看日志:  sudo journalctl -u images-api -f"
else
  echo "  [跳过] systemd 不可用或 --no-systemd"
fi

# ==================== 完成 ====================
echo ""
echo "=========================================="
echo "  部署完成！"
echo "=========================================="
echo ""
echo "下一步:"
echo "  1. 编辑 local.env 填写你的平台凭证"
if [[ "$SETUP_SYSTEMD" == "true" ]]; then
  echo "  2. sudo systemctl start images-api"
  echo "  3. curl http://127.0.0.1:$PORT/ping"
else
  echo "  2. npm start"
  echo "  3. curl http://127.0.0.1:$PORT/ping"
fi
echo ""
echo "管理后台: http://你的IP:$PORT/console"
echo "API 文档: http://你的IP:$PORT/docs/api-guide"
