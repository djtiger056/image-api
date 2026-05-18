# Images API 外部调用文档

统一图片生成 API 服务，封装 Jimeng（即梦）、Kling（可灵）、Doubao（豆包）、XYQ（小云雀）四大平台，
提供 OpenAI 兼容格式接口。支持文生图和图生图功能。

- 服务版本：v0.9.1
- 基础地址：`http://<your-server>:18081`
- 认证方式：`x-api-key` 请求头（若服务端配置了 API Key）

---

## 目录

1. [认证说明](#1-认证说明)
2. [文生图接口](#2-文生图接口)
3. [图生图接口](#3-图生图接口)
4. [模型列表接口](#4-模型列表接口)
5. [健康检查接口](#5-健康检查接口)
6. [模型清单与参数](#6-模型清单与参数)
7. [错误码说明](#7-错误码说明)
8. [调用示例](#8-调用示例)

---

## 1. 认证说明

### 1.1 API Key（可选）

如果服务端配置了 API Key，所有请求需在 Header 中携带：

```
x-api-key: your-api-key
```

### 1.2 平台 Token

各平台的 Token 通过服务端环境变量或控制台配置，调用方无需关心。服务端根据请求中的 `model` 参数自动选择对应平台的 Token。

---

## 2. 文生图接口

根据提示词生成图片。

### 请求

```
POST /v1/images/generations
Content-Type: application/json
x-api-key: your-api-key（可选）
```

### 请求参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| model | string | 否 | jimeng-4.5 | 模型名称，见下方模型清单 |
| prompt | string | 是 | - | 提示词，描述要生成的图片内容 |
| negative_prompt | string | 否 | - | 反向提示词，排除不想要的内容 |
| ratio | string | 否 | 1:1 | 图片比例，可选值见各模型说明 |
| resolution | string | 否 | 1k | 分辨率档位：1k / 2k / 4k |
| sample_strength | number | 否 | 0.5 | 采样强度，范围 0.1~1.0，值越大越自由 |
| n | number | 否 | 1 | 生成图片数量（Jimeng 最多 4 张） |
| response_format | string | 否 | url | 返回格式：url（图片链接）/ b64_json（Base64） |
| async | boolean | 否 | false | 是否异步模式（Kling 建议设为 true） |

**不支持的参数：** `size`、`width`、`height`（请用 `ratio` + `resolution` 控制尺寸）

### 请求示例

```json
{
  "model": "jimeng-5.0",
  "prompt": "一只可爱的橘猫坐在窗台上晒太阳，水彩画风格",
  "ratio": "16:9",
  "resolution": "2k",
  "n": 1,
  "response_format": "url"
}
```

### 成功响应

```json
{
  "created": 1715000000,
  "data": [
    {
      "url": "https://example.com/generated-image.jpg"
    }
  ],
  "provider": "jimeng"
}
```

当 `response_format` 为 `b64_json` 时：

```json
{
  "created": 1715000000,
  "data": [
    {
      "b64_json": "/9j/4AAQSkZJRg..."
    }
  ],
  "provider": "jimeng"
}
```

### 异步响应（Kling）

```json
{
  "task_id": "kling-web-xxx",
  "status": "processing",
  "message": "Kling 网页模式任务已提交，使用 GET /v1/images/generations/{task_id} 轮询结果"
}
```

异步查询：

```
GET /v1/images/generations/{task_id}
```

---

## 3. 图生图接口

基于参考图片 + 提示词生成新图片。支持 1~10 张输入图片，支持 HTTP URL 和 Base64 Data URL。

### 请求

```
POST /v1/images/compositions
Content-Type: application/json
x-api-key: your-api-key（可选）
```

### 请求参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| model | string | 否 | jimeng-4.5 | 模型名称 |
| prompt | string | 是 | - | 提示词，描述期望的生成效果 |
| images | string[] | 是 | - | 参考图片数组，1~10 个元素 |
| negative_prompt | string | 否 | - | 反向提示词 |
| ratio | string | 否 | 1:1 | 输出图片比例 |
| resolution | string | 否 | 2k | 分辨率档位 |
| sample_strength | number | 否 | 0.5 | 采样强度，值越大越偏离原图 |
| n | number | 否 | 1 | 生成图片数量 |
| response_format | string | 否 | url | 返回格式：url / b64_json |
| async | boolean | 否 | false | 是否异步模式 |

### images 数组说明

每个元素可以是以下格式之一：

1. **HTTP/HTTPS URL**
   ```
   "https://example.com/photo.jpg"
   ```

2. **Base64 Data URL**
   ```
   "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
   ```

3. **OpenAI 格式对象**（兼容）
   ```json
   { "url": "https://example.com/photo.jpg" }
   ```

### 请求示例

**URL 方式：**

```json
{
  "model": "jimeng-5.0",
  "prompt": "将这张照片转换为油画风格",
  "images": [
    "https://example.com/original-photo.jpg"
  ],
  "ratio": "1:1",
  "resolution": "2k",
  "sample_strength": 0.6
}
```

**多图合成：**

```json
{
  "model": "jimeng-4.6",
  "prompt": "将两张图片融合，生成一个新的艺术作品",
  "images": [
    "https://example.com/image1.jpg",
    "https://example.com/image2.jpg"
  ],
  "ratio": "1:1",
  "resolution": "2k",
  "sample_strength": 0.5
}
```

**Base64 方式：**

```json
{
  "model": "jimeng-5.0",
  "prompt": "在此基础上添加星空背景",
  "images": [
    "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
  ],
  "ratio": "16:9",
  "resolution": "1k"
}
```

### 成功响应

```json
{
  "created": 1715000000,
  "data": [
    {
      "url": "https://example.com/composition-result.jpg"
    }
  ],
  "provider": "jimeng",
  "input_images": 1,
  "composition_type": "multi_image_synthesis"
}
```

---

## 4. 模型列表接口

获取所有可用模型。

### 请求

```
GET /v1/models
x-api-key: your-api-key（可选）
```

### 响应

```json
{
  "data": [
    { "id": "jimeng-5.0", "object": "model", "owned_by": "images-api", "description": "即梦AI图像生成模型 5.0 版本（最新）" },
    { "id": "jimeng-4.6", "object": "model", "owned_by": "images-api", "description": "即梦AI图像生成模型 4.6 版本（最新）" },
    { "id": "kling-v2-1", "object": "model", "owned_by": "images-api", "description": "Kling 官方图片模型 v2.1" },
    { "id": "doubao-seedream-4.5", "object": "model", "owned_by": "images-api", "description": "豆包 Seedream 4.5 生图模型" },
    { "id": "xyq-seedream-5.0", "object": "model", "owned_by": "images-api", "description": "小云雀 Seedream 5.0 生图模型" }
  ]
}
```

---

## 5. 健康检查接口

```
GET /ping
```

响应：`{"ok": true}`

---

## 6. 模型清单与参数

### 6.1 Jimeng（即梦）模型

| 模型名 | 说明 | 支持比例 | 支持分辨率 | 推荐度 |
|--------|------|----------|-----------|--------|
| jimeng-5.0 | 最新模型，高质量 | 1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 21:9 | 1k, 2k, 4k | ★★★★★ |
| jimeng-4.6 | 推荐稳定模型 | 同上 | 1k, 2k, 4k | ★★★★★ |
| jimeng-4.5 | 兼容性好 | 同上 | 1k, 2k, 4k | ★★★★ |
| jimeng-4.1 | 旧版稳定 | 同上 | 1k, 2k, 4k | ★★★ |
| jimeng-4.0 | 旧版 | 同上 | 1k, 2k, 4k | ★★★ |
| jimeng-3.1 | 艺术风格 | 1:1, 4:3, 3:4, 16:9, 9:16 | 1k, 2k | ★★ |
| jimeng-3.0 | 通用旧版 | 同上 | 1k, 2k | ★★ |
| jimeng-2.1 | 旧版 | 1:1 | 1k | ★ |
| jimeng-xl-pro | XL 专业 | 1:1, 4:3, 3:4 | 1k, 2k | ★★ |

### 6.2 Kling（可灵）模型

| 模型名 | 说明 | 支持比例 | 支持分辨率 |
|--------|------|----------|-----------|
| kling-v2-1 | 网页模式，自动轮询 | 1:1, 16:9, 9:16, 4:3, 3:4 | 1k |
| kling-v3-omni | 高阶模型 | 1:1, 16:9, 9:16 | 1k, 2k |
| kling-image-o1 | 支持智能比例 | 1:1, 16:9, 9:16, 4:3, 3:4 | 1k, 2k |

**Kling 特殊说明：**
- 建议设置 `"async": true`，服务端会自动轮询结果
- 网页模式受页面和账号额度影响
- Kling 图生图仅支持单张参考图

### 6.3 Doubao（豆包）模型

| 模型名 | 说明 | 支持比例 |
|--------|------|----------|
| doubao-seedream-4.5 | 最新，推荐 | 1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 21:9 |
| doubao-seedream-4.0 | 稳定版 | 同上 |
| doubao-seedream-3.0 | 基础版 | 同上 |

**Doubao 特殊说明：**
- 使用 doubao.com 免费额度
- 图生图仅支持单张参考图（取 images 数组第一张）
- 支持 style 参数（可选）

### 6.4 XYQ（小云雀）模型

| 模型名 | 说明 | 支持比例 |
|--------|------|----------|
| xyq-seedream-5.0 | 最新 | 1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 21:9 |
| xyq-seedream-4.5 | 稳定版 | 同上 |
| xyq-seedream-4.0 | 基础版 | 同上 |

**XYQ 特殊说明：**
- 使用 xyq.jianying.com 免费额度
- 图生图仅支持单张参考图

---

## 7. 错误码说明

### HTTP 状态码

| 状态码 | 含义 |
|--------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 401 | 认证失败（Token 无效或缺失） |
| 403 | API Key 无效 |
| 429 | 请求频率超限 |
| 500 | 服务端内部错误 |

### 错误响应格式

```json
{
  "error": {
    "message": "错误描述",
    "type": "invalid_request_error",
    "code": "invalid_parameter"
  }
}
```

### 常见错误

| 错误信息 | 原因 | 解决方案 |
|----------|------|----------|
| prompt 不能为空 | 未提供 prompt 参数 | 填写 prompt 字段 |
| 至少需要提供1张输入图片 | 图生图未传 images | 传入至少 1 张图片 |
| 最多支持10张输入图片 | images 超过 10 张 | 减少图片数量 |
| 不支持的参数: size | 传了 size/width/height | 改用 ratio + resolution |
| Token 无效或积分不足 | 平台 Token 过期或额度用尽 | 更新 Token 或等待额度恢复 |

---

## 8. 调用示例

### 8.1 cURL - 文生图

```bash
curl -X POST http://localhost:18081/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "model": "jimeng-5.0",
    "prompt": "夕阳下的海边小镇，水彩风格",
    "ratio": "16:9",
    "resolution": "2k",
    "n": 2,
    "response_format": "url"
  }'
```

### 8.2 cURL - 图生图（URL）

```bash
curl -X POST http://localhost:18081/v1/images/compositions \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "model": "jimeng-5.0",
    "prompt": "将此照片转为动漫风格",
    "images": ["https://example.com/photo.jpg"],
    "ratio": "1:1",
    "resolution": "2k",
    "sample_strength": 0.6
  }'
```

### 8.3 cURL - 图生图（本地文件转 Base64）

```bash
# 将本地图片转为 base64 并调用
IMAGE_B64=$(base64 -w0 /path/to/image.jpg)
curl -X POST http://localhost:18081/v1/images/compositions \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d "{
    \"model\": \"jimeng-5.0\",
    \"prompt\": \"添加一个梦幻的天空背景\",
    \"images\": [\"data:image/jpeg;base64,${IMAGE_B64}\"],
    \"ratio\": \"16:9\",
    \"resolution\": \"2k\"
  }"
```

### 8.4 Python - 文生图

```python
import requests

resp = requests.post(
    "http://localhost:18081/v1/images/generations",
    headers={
        "Content-Type": "application/json",
        "x-api-key": "your-api-key",
    },
    json={
        "model": "jimeng-5.0",
        "prompt": "一只可爱的柴犬，日系插画风格",
        "ratio": "1:1",
        "resolution": "2k",
        "n": 1,
        "response_format": "url",
    },
)

result = resp.json()
image_url = result["data"][0]["url"]
print(f"图片地址: {image_url}")
```

### 8.5 Python - 图生图（本地文件）

```python
import requests
import base64

# 读取本地图片并转为 base64 data URL
with open("photo.jpg", "rb") as f:
    b64 = base64.b64encode(f.read()).decode()
    data_url = f"data:image/jpeg;base64,{b64}"

resp = requests.post(
    "http://localhost:18081/v1/images/compositions",
    headers={
        "Content-Type": "application/json",
        "x-api-key": "your-api-key",
    },
    json={
        "model": "jimeng-5.0",
        "prompt": "将这张照片转为油画风格",
        "images": [data_url],
        "ratio": "1:1",
        "resolution": "2k",
        "sample_strength": 0.6,
        "response_format": "url",
    },
)

result = resp.json()
image_url = result["data"][0]["url"]
print(f"图片地址: {image_url}")
```

### 8.6 JavaScript / Fetch - 图生图

```javascript
async function imageToImage(imageUrl, prompt) {
  const resp = await fetch("http://localhost:18081/v1/images/compositions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "your-api-key",
    },
    body: JSON.stringify({
      model: "jimeng-5.0",
      prompt: prompt,
      images: [imageUrl],
      ratio: "1:1",
      resolution: "2k",
      sample_strength: 0.5,
      response_format: "url",
    }),
  });

  const data = await resp.json();
  return data.data[0].url;
}

// 使用
imageToImage("https://example.com/photo.jpg", "转为赛博朋克风格")
  .then((url) => console.log("生成结果:", url));
```

### 8.7 OpenAI SDK 兼容调用

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:18081/v1",
    api_key="your-api-key",
)

# 文生图
result = client.images.generate(
    model="jimeng-5.0",
    prompt="一只在星空下奔跑的狼",
    size="1024x1024",  # 注意：本服务不支持此参数，需改用 ratio+resolution
    n=1,
)
print(result.data[0].url)
```

> **注意：** OpenAI SDK 的 `size` 参数本服务不支持。若需指定尺寸，请用原生 HTTP 请求并传 `ratio` + `resolution` 参数。

---

## 附录：各平台图生图能力对比

| 平台 | 多图输入 | 最大图片数 | Data URL | 说明 |
|------|----------|-----------|----------|------|
| Jimeng | ✅ | 10 | ✅ | 支持多图融合/合成 |
| Kling | ✅ | 1 (统一接口) | ✅ | 单图走统一接口，多图走原生 /multi-image2image |
| Doubao | ❌ | 1 | ✅ | 仅取第一张作为参考图 |
| XYQ | ❌ | 1 | ✅ | 仅取第一张作为参考图 |

---

## 附录：支持的图片比例与实际分辨率

| 比例 | 1k 分辨率 | 2k 分辨率 | 4k 分辨率 |
|------|-----------|-----------|-----------|
| 1:1 | 1024×1024 | 2048×2048 | 4096×4096 |
| 4:3 | 768×1024 | 2304×1728 | 4608×3456 |
| 3:4 | 1024×768 | 1728×2304 | 3456×4608 |
| 16:9 | 1024×576 | 2560×1440 | 5120×2880 |
| 9:16 | 576×1024 | 1440×2560 | 2880×5120 |
| 3:2 | 1024×682 | 2496×1664 | 4992×3328 |
| 2:3 | 682×1024 | 1664×2496 | 3328×4992 |
| 21:9 | 1195×512 | 3024×1296 | 6048×2592 |

> **注意：** 4k 分辨率仅 jimeng-4.0 及以上模型支持，且消耗更多积分。
