# Kling 网页模式快速使用

项目目录：`/myproject/kling-api`

适用前提：
- 走国内站 `https://klingai.com/app/image/new`
- 不需要额外 API 凭证
- 复用现有网页登录态 `./kling.json`
- 当前版本支持默认直接读取项目根目录 `./kling.json`

## 1. 一次性准备

确认这几个文件/条件已经就绪：
- cookies 文件：`/myproject/kling-api/kling.json`
- Chrome：`/usr/bin/google-chrome-stable`
- 项目已安装依赖：`npm install`

建议把本地启动配置写进 `local.env`：

```env
SERVER_NAME=kling-api
SERVER_HOST=0.0.0.0
SERVER_PORT=18080
BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
SERVER_API_KEYS=your-api-key

KLING_AUTH_MODE=web
KLING_WEB_TARGET_URL=https://klingai.com/app/image/new
KLING_WEB_HEADLESS=true
KLING_WEB_WAIT_TIMEOUT_MS=240000
KLING_WEB_RESULT_POLL_INTERVAL_MS=3000
KLING_WEB_ARTIFACTS_DIR=./tmp/kling-web-provider
KLING_WEB_TASKS_STATE_PATH=./tmp/kling-web-provider/tasks.json
```

## 2. 启动服务

在项目根目录执行：

```bash
cd /myproject/kling-api
./scripts/start-local.sh
```

启动后默认地址：

```bash
http://127.0.0.1:18080
```

先确认服务起来：

```bash
curl http://127.0.0.1:18080/v1/models
```

## 3. 提交一个真实 Kling 网页任务

推荐先走 async。

如果配置了 `SERVER_API_KEYS`，调用时记得带：

```bash
-H "x-api-key: your-api-key"
```

如果服务本身就是在 `/myproject/kling-api` 下启动，且根目录已有 `kling.json`，现在可以不在请求里重复传 cookies，服务会默认回退读取这个文件。

在项目根目录执行：

```bash
cd /myproject/kling-api
python3 - <<'PY'
import json
from pathlib import Path
import urllib.request

base_url = 'http://127.0.0.1:18080'
cookies = json.loads(Path('kling.json').read_text())

payload = {
    'model': 'kling-v2-1',
    'prompt': '一只戴着透明雨衣的小狐狸站在霓虹雨夜街头，电影感，细节丰富，单主体，高清插画',
    'async': True,
    'provider_options': {
        'transport': 'web',
        'target_url': 'https://klingai.com/app/image/new',
        'cookies': cookies,
    }
}

req = urllib.request.Request(
    base_url + '/v1/images/generations',
    data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
    headers={'Content-Type': 'application/json'},
)

with urllib.request.urlopen(req, timeout=60) as r:
    print(r.read().decode('utf-8'))
PY
```

正常会返回类似：

```json
{
  "created": 1776762803,
  "provider": "kling",
  "transport": "web",
  "task_id": "kling-web-...",
  "status": "submitted",
  "message": "Kling 网页任务已提交，正在后台执行。"
}
```

## 4. 轮询任务结果

把上一步返回的 `task_id` 换进去：

```bash
curl http://127.0.0.1:18080/v1/images/generations/<task_id>
```

如果想自动轮询，直接执行：

```bash
cd /myproject/kling-api
python3 - <<'PY'
import json, time, urllib.request

task_id = '把这里换成你的 task_id'
base_url = 'http://127.0.0.1:18080'

while True:
    with urllib.request.urlopen(base_url + f'/v1/images/generations/{task_id}', timeout=60) as r:
        data = json.loads(r.read().decode('utf-8'))
    status = ((data.get('data') or {}).get('task_status'))
    print(status, json.dumps(data, ensure_ascii=False))
    if status in ('succeed', 'failed'):
        break
    time.sleep(5)
PY
```

## 5. 成功后的返回特点

成功时会在：

```json
data.task_result.images
```

里拿到图片 URL。

项目现在已经做了两层关键处理：
- 过滤页面历史/推荐图，尽量只保留本次提交后的结果
- 对 `x-oss-process=...` 这类同图变体做归一化去重

所以返回会比之前干净。

## 6. 调试产物位置

每次任务会在这里留下调试文件：

```bash
/myproject/kling-api/tmp/kling-web-provider/
```

常见文件：
- `01-loaded.png`
- `02-result.png`
- `summary.json`
- `traffic.json`
- `error.json`（失败时）

## 7. 最常见问题

### 1) 返回登录失效
优先检查：
- `kling.json` 是否过期
- cookies 域名是不是 `klingai.com`
- 目标地址是不是国内站 `https://klingai.com/app/image/new`

### 2) 服务能起，但生成失败
先看对应任务目录里的：
- `error.json`
- `traffic.json`
- `02-result.png`

### 3) Chrome 启动失败
确认：

```bash
which google-chrome-stable
```

应返回：

```bash
/usr/bin/google-chrome-stable
```

## 8. 最短使用流程

```bash
cd /myproject/kling-api
./scripts/start-local.sh
# 另开一个终端执行第 3 步提交任务
# 再执行第 4 步轮询结果
```
