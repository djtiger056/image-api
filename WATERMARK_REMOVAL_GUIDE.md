# AI 生成图片/视频水印去除方法说明文档

> 适用范围: 即梦(Jimeng)、豆包(Doubao)、可灵(Kling)、小云雀(XYQ) 等AI平台生成的图片和视频
> 生成日期: 2025-05-27

---

## 目录

1. [水印类型分析](#一水印类型分析)
2. [方法零: 源头去水印（最推荐）](#二方法零-源头去水印最推荐)
3. [图片去水印方案](#三图片去水印方案)
4. [视频去水印方案](#四视频去水印方案)
5. [与 images-api 集成方案](#五与-images-api-集成方案)
6. [工具对比总结](#六工具对比总结)

---

## 一、水印类型分析

### 1.1 即梦(Jimeng) 水印
- **左上角**: "AI生成" 文字水印 (合规要求，会员无法去除)
- **右下角**: 即梦 Logo/文字水印 (会员可去除)
- **类型**: 图片叠加型水印，半透明
- **特点**: 位置固定，尺寸固定

### 1.2 豆包(Doubao) 水印
- **左上角**: "AI生成" 文字水印
- **右下角**: 豆包 Logo
- **类型**: 与即梦类似，字节系统一风格

### 1.3 可灵(Kling) 水印
- **右下角**: 可灵/Kling Logo
- **类型**: 叠加型

### 1.4 通用 AI 水印特征
- 位置固定 (通常在角落)
- 尺寸固定 (与图片/视频分辨率成比例)
- 颜色通常是白色/半透明
- 可能包含隐形数字水印 (SynthID 等，不可见)

---

## 二、方法零: 源头去水印（最推荐）

### 2.1 即梦 - 平台内设置去除左上角水印

**操作步骤:**
1. 登录即梦网站: https://jimeng.jianying.com/ai-tool/home
2. 右下角菜单 → 点击【AI生成水印设置】
3. 启用【去除水印】选项
4. 之后新生成的内容将不带左上角 "AI生成" 水印

**注意:** 此设置只对启用后新生成的内容生效。

### 2.2 即梦图片 - 画布导出法 (去除右下角水印)

1. 点击生成的图片
2. 点击右上角 "更多"(...) → 选择"去画布编辑"
3. 在编辑界面 → 点击"导出"
4. 选择 **PNG** 格式导出
5. 下载的图片即为无水印版本

### 2.3 豆包图片 - 拖拽法 (去除水印)

1. 点击喜欢的图片进入大图页面
2. 直接用鼠标 **拖拽图片到桌面**
3. 桌面保存的图片完全没有水印

### 2.4 豆包图片 - 开发者工具法

1. 在豆包页面，按 F12 打开开发者工具
2. 点击左上角元素选择器(小箭头)
3. 选中页面上的图片
4. 在源代码中找到图片的 `src` 属性 (原始链接)
5. 点击链接 → 新标签页打开原图
6. 右键 → "图片另存为"

### 2.5 即梦视频 - 浏览器插件法

**所需工具:** Chrome + "猫抓" 扩展插件

1. Chrome 扩展商店搜索安装 "猫抓"
2. 打开即梦网站，生成或选择视频
3. 猫抓自动检测并抓取页面视频资源
4. 点击猫抓图标 → 在资源列表中找到视频
5. 直接下载 → 无水印视频

### 2.6 即梦/Tampermonkey 脚本法

**安装 Tampermonkey 脚本:**
- Greasy Fork: 搜索 "从即梦AI下载无水印视频和图片"
- GitHub: https://github.com/catscarlet/Download-from-JiMeng-without-Watermark

**使用:**
1. 安装 Tampermonkey 浏览器扩展
2. 安装上述脚本
3. 先在即梦设置中启用 "去除水印"
4. 生成页面会出现 "预览视频下载" / "下载预览图片" 按钮
5. 点击即可下载无水印内容

**注意:** 图片需要先点击进入详情 → 再次点击预览图 → 出现下载按钮。
默认格式为 WebP，可用 ImageMagick/GIMP 转换。

---

## 三、图片去水印方案

### 3.1 方案一: IOPaint / Lama Cleaner (AI修复，推荐)

**原理:** 使用 LaMa (Large Mask Inpainting) AI 模型，智能修复水印区域像素。

**安装:**
```bash
pip install iopaint
# 或旧版名称
pip install lama-cleaner
```

**启动 Web 界面:**
```bash
# 使用 LaMa 模型 (CPU)
iopaint run --model=lama --device=cpu --port=8080

# 使用 GPU (NVIDIA)
iopaint run --model=lama --device=cuda --port=8080
```
浏览器打开 http://127.0.0.1:8080，上传图片，涂抹水印区域，点击修复。

**命令行批量处理:**
```bash
# 单张图片
iopaint run --model=lama --device=cpu \
  --image=input.jpg --mask=mask.png --output=output.jpg

# 批量处理
iopaint run --model=lama --device=cpu \
  --image=input_dir/ --mask=mask_dir/ --output=output_dir/
```

**API 模式 (适合集成):**
```bash
# 启动 API 服务
iopaint api --model=lama --device=cpu --port=8080
```

```python
import requests

# 上传图片和掩码进行修复
files = {
    'image': open('input.jpg', 'rb'),
    'mask': open('mask.png', 'rb')
}
resp = requests.post('http://127.0.0.1:8080/inpaint', files=files)
with open('output.jpg', 'wb') as f:
    f.write(resp.content)
```

### 3.2 方案二: OpenCV inpaint (传统算法，轻量)

**原理:** 使用 OpenCV 内置的 Telea/Navier-Stokes 修复算法。

**安装:**
```bash
pip install opencv-python numpy
```

**Python 脚本:**
```python
import cv2
import numpy as np

def remove_watermark(image_path, mask_path, output_path):
    """使用 OpenCV 去除图片水印"""
    img = cv2.imread(image_path)
    mask = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)

    # 二值化掩码
    _, mask = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)

    # 膨胀掩码，扩大修复区域
    kernel = np.ones((5, 5), np.uint8)
    mask = cv2.dilate(mask, kernel, iterations=2)

    # Telea 算法修复
    result = cv2.inpaint(img, mask, 10, cv2.INPAINT_TELEA)

    cv2.imwrite(output_path, result)
    print(f"已保存: {output_path}")

# 使用
remove_watermark('input.jpg', 'mask.png', 'output.jpg')
```

**自动检测水印位置 (针对固定水印):**
```python
import cv2
import numpy as np

def create_watermark_mask(image_path, watermark_region):
    """
    根据已知水印区域创建掩码
    watermark_region: (x, y, width, height)
    """
    img = cv2.imread(image_path)
    h, w = img.shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)

    x, y, rw, rh = watermark_region
    mask[y:y+rh, x:x+rw] = 255

    # 可选: 膨胀边缘
    kernel = np.ones((3, 3), np.uint8)
    mask = cv2.dilate(mask, kernel, iterations=2)

    return mask

# 即梦右下角水印示例 (假设 1024x1024 图片)
mask = create_watermark_mask('jimeng_output.png',
    watermark_region=(850, 920, 160, 80))  # 需根据实际调整
cv2.imwrite('mask.png', mask)
```

### 3.3 方案三: GeminiWatermarkTool (专门针对字节系AI水印)

**特点:** 使用反向 Alpha 混合数学精确去除，非 AI 修复。

**安装:**
```bash
# GitHub 下载预编译版本
# https://github.com/search?q=GeminiWatermarkTool
```

**使用:**
```bash
# 简单模式
GeminiWatermarkTool watermarked.jpg

# 指定输出
GeminiWatermarkTool -i watermarked.jpg -o clean.jpg

# 批量处理
GeminiWatermarkTool -i ./input_folder/ -o ./output_folder/
```

### 3.4 方案四: 在线工具

| 工具            | 网址                                  | 说明                      |
|----------------|---------------------------------------|--------------------------|
| 灵猫           | 支持即梦/豆包/可灵的AI水印去除         | 在线，免费                |
| WatermarkRemover.io | https://www.watermarkremover.io  | 自动检测，免费有限额      |
| 大神去水印      | https://www.wuhenai.com               | 针对即梦强化训练，付费    |

---

## 四、视频去水印方案

### 4.1 方案一: static-ghost (AI修复，推荐)

**原理:** 提取视频帧 → LaMa AI 修复水印区域 → 重新合成视频。
仅处理水印区域(10-15x 更少像素)，速度快。

**安装:**
```bash
pip install static-ghost==0.4.0
```

**使用:**
```bash
# 交互式选择水印区域 (打开浏览器)
static-ghost pick video.mp4 --dilation 15 -o video_clean.mp4

# 指定水印坐标 (x,y,width,height)
static-ghost remove video.mp4 --region 1400,920,520,160 --dilation 15

# 自动检测水印 (适合高对比度水印)
static-ghost detect video.mp4

# 全自动流程 (检测 → 预览 → 确认 → 去除)
static-ghost remove video.mp4 --device cpu
```

**性能参考:**
| 视频时长 | 帧数  | CPU 耗时  | GPU 耗时  |
|---------|-------|----------|----------|
| 30秒    | 900   | ~8分钟   | ~4分钟   |
| 10分钟  | 18000 | ~2.5小时 | ~1.5小时 |

**关键参数:**
| 参数       | 默认 | 说明                              |
|-----------|------|----------------------------------|
| --region  | -    | 水印区域 x,y,w,h (可重复指定多个) |
| --dilation| 5    | 掩码扩展像素 (建议15-20)          |
| --device  | cpu  | cpu/mps (macOS Metal)            |
| -o        | auto | 输出路径                          |

**提示:**
- 先用 `ffmpeg -i input.mp4 -t 30 -c copy test.mp4` 截取30秒测试
- 水印区域画大一些，留50-100px余量
- 半透明水印自动检测可能失败，用 --region 手动指定

### 4.2 方案二: FFmpeg delogo 滤镜 (传统，快速)

**原理:** FFmpeg 内置 delogo 滤镜，用周围像素平均值替换水印区域。

```bash
# 基本用法
ffmpeg -i input.mp4 -vf "delogo=x=10:y=10:w=120:h=40:show=0" output.mp4

# 即梦左上角 "AI生成" 水印 (示例坐标)
ffmpeg -i input.mp4 -vf "delogo=x=15:y=15:w=100:h=35" output_clean.mp4

# 即梦右下角 Logo 水印 (示例坐标)
ffmpeg -i input.mp4 -vf "delogo=x=1700:y=1000:w=200:h=60" output_clean.mp4

# 同时去除两个水印
ffmpeg -i input.mp4 -vf "delogo=x=15:y=15:w=100:h=35,delogo=x=1700:y=1000:w=200:h=60" output_clean.mp4

# 查看视频首帧确定水印位置
ffmpeg -i input.mp4 -vf "select=eq(n\,0)" -vframes 1 frame.png
```

**show=1** 会显示绿色框便于定位水印区域:
```bash
ffmpeg -i input.mp4 -vf "delogo=x=10:y=10:w=120:h=40:show=1" preview.mp4
```

**优点:** 速度快，无需额外安装
**缺点:** 效果一般，可能出现模糊/色块

### 4.3 方案三: LazyCut Seedance 视频去水印器

**网址:** https://clean.lazyso.com/en/seedance-video

**特点:**
- 100% 浏览器本地处理 (隐私安全)
- 针对 Seedance/豆包视频优化
- 使用 FFmpeg.wasm 处理
- 拖拽框选水印区域

**使用:**
1. 打开网页
2. 上传 MP4 视频
3. 在预览图上拖拽/调整方框覆盖水印区域
4. 点击处理 → 等待 1-3 分钟 (10秒视频)
5. 下载结果

### 4.4 方案四: IOPaint + FFmpeg 组合 (最高质量)

```bash
# 1. 提取视频帧
mkdir frames
ffmpeg -i input.mp4 frames/%06d.png

# 2. 创建水印掩码 (用第一帧)
# 用图像编辑工具在 mask.png 中白色标记水印区域

# 3. 使用 IOPaint API 批量修复
iopaint api --model=lama --device=cuda --port=8080 &

# Python 批量处理脚本
python inpaint_frames.py --input frames/ --mask mask.png --output cleaned/

# 4. 重新合成视频
ffmpeg -framerate 30 -i cleaned/%06d.png -c:v libx264 -pix_fmt yuv420p \
  -i input.mp4 -map 0:v -map 1:a output_clean.mp4
```

**批量修复脚本 (inpaint_frames.py):**
```python
import os
import glob
import requests
import argparse

def inpaint_frame(frame_path, mask_path, output_path, api_url="http://127.0.0.1:8080"):
    with open(frame_path, 'rb') as f_img, open(mask_path, 'rb') as f_mask:
        resp = requests.post(f"{api_url}/inpaint",
            files={'image': f_img, 'mask': f_mask}
        )
    with open(output_path, 'wb') as f:
        f.write(resp.content)

parser = argparse.ArgumentParser()
parser.add_argument('--input', required=True)
parser.add_argument('--mask', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()

os.makedirs(args.output, exist_ok=True)
frames = sorted(glob.glob(os.path.join(args.input, '*.png')))

for i, frame in enumerate(frames):
    out = os.path.join(args.output, os.path.basename(frame))
    inpaint_frame(frame, args.mask, out)
    print(f"[{i+1}/{len(frames)}] {os.path.basename(frame)}")

print("处理完成!")
```

---

## 五、与 images-api 集成方案

### 5.1 自动去水印后处理流水线

在 images-api 生成图片/视频后，自动调用水印去除:

```
images-api 生成 → 下载结果 → 检测水印 → 去除水印 → 返回干净结果
```

### 5.2 图片自动去水印 Hook

```python
"""
post_process.py - images-api 生成后自动去水印

在 images-api 返回结果后调用:
  python post_process.py --image output.jpg --platform jimeng
"""

import argparse
import cv2
import numpy as np
import requests

# 各平台水印位置配置 (需根据实际分辨率调整)
WATERMARK_CONFIG = {
    "jimeng": {
        "top_left": (10, 10, 110, 35),     # "AI生成" 水印
        "bottom_right": (860, 940, 150, 50), # Logo 水印
    },
    "doubao": {
        "top_left": (10, 10, 110, 35),
        "bottom_right": (860, 940, 150, 50),
    },
    "kling": {
        "bottom_right": (860, 940, 150, 50),
    }
}

def create_mask_from_regions(image_shape, regions, padding=10):
    """根据水印区域列表创建掩码"""
    h, w = image_shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    for (x, y, rw, rh) in regions:
        x1 = max(0, x - padding)
        y1 = max(0, y - padding)
        x2 = min(w, x + rw + padding)
        y2 = min(h, y + rh + padding)
        mask[y1:y2, x1:x2] = 255
    return mask

def remove_watermark_opencv(image_path, platform, output_path):
    """使用 OpenCV 去除平台水印"""
    config = WATERMARK_CONFIG.get(platform, {})
    if not config:
        print(f"未知平台: {platform}")
        return

    img = cv2.imread(image_path)
    regions = list(config.values())
    mask = create_mask_from_regions(img.shape, regions, padding=5)

    # 膨胀掩码
    kernel = np.ones((3, 3), np.uint8)
    mask = cv2.dilate(mask, kernel, iterations=2)

    result = cv2.inpaint(img, mask, 10, cv2.INPAINT_TELEA)
    cv2.imwrite(output_path, result)
    print(f"已去除水印: {output_path}")

def remove_watermark_iopaint(image_path, platform, output_path,
                              api_url="http://127.0.0.1:8080"):
    """使用 IOPaint API 去除水印"""
    config = WATERMARK_CONFIG.get(platform, {})
    if not config:
        return

    img = cv2.imread(image_path)
    regions = list(config.values())
    mask = create_mask_from_regions(img.shape, regions, padding=10)

    # 保存临时掩码
    mask_path = image_path + ".mask.png"
    cv2.imwrite(mask_path, mask)

    with open(image_path, 'rb') as f_img, open(mask_path, 'rb') as f_mask:
        resp = requests.post(f"{api_url}/inpaint",
            files={'image': f_img, 'mask': f_mask})

    with open(output_path, 'wb') as f:
        f.write(resp.content)

    os.remove(mask_path)
    print(f"已去除水印(IOPaint): {output_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True)
    parser.add_argument('--platform', default='jimeng',
                       choices=['jimeng', 'doubao', 'kling'])
    parser.add_argument('--output', default=None)
    parser.add_argument('--method', default='opencv',
                       choices=['opencv', 'iopaint'])
    args = parser.parse_args()

    output = args.output or args.image.replace('.', '_clean.')
    if args.method == 'opencv':
        remove_watermark_opencv(args.image, args.platform, output)
    else:
        remove_watermark_iopaint(args.image, args.platform, output)
```

### 5.3 视频自动去水印 FFmpeg 命令

```bash
# 即梦视频 - 同时去除左上角和右下角水印
ffmpeg -i jimeng_video.mp4 -vf \
  "delogo=x=15:y=15:w=100:h=35,delogo=x=W-210:y=H-70:w=190:h=55" \
  -c:a copy output_clean.mp4

# 参数说明:
# x=15:y=15:w=100:h=35     → 左上角 "AI生成"
# x=W-210:y=H-70:w=190:h=55 → 右下角 Logo (W/H 自动取视频宽高)
```

### 5.4 批量处理脚本

```bash
#!/bin/bash
# batch_remove_watermark.sh
# 批量去除目录中所有图片/视频的水印

INPUT_DIR="./generated"
OUTPUT_DIR="./cleaned"
PLATFORM="jimeng"

mkdir -p "$OUTPUT_DIR"

for file in "$INPUT_DIR"/*.{jpg,png,webp}; do
    [ -f "$file" ] || continue
    filename=$(basename "$file")
    echo "处理: $filename"
    python post_process.py --image "$file" --platform "$PLATFORM" \
        --output "$OUTPUT_DIR/$filename" --method opencv
done

for file in "$INPUT_DIR"/*.mp4; do
    [ -f "$file" ] || continue
    filename=$(basename "$file")
    echo "处理视频: $filename"
    ffmpeg -i "$file" -vf "delogo=x=15:y=15:w=100:h=35,delogo=x=W-210:y=H-70:w=190:h=55" \
        -c:a copy "$OUTPUT_DIR/$filename" -y
done

echo "批量处理完成!"
```

---

## 六、工具对比总结

### 图片去水印

| 工具               | 质量 | 速度 | 难度 | 可批处理 | 适合场景          |
|-------------------|------|------|------|---------|-------------------|
| 源头设置去除       | ★★★★★| ★★★★★| ★    | -       | 最推荐，无损      |
| 画布导出/拖拽      | ★★★★★| ★★★★★| ★    | -       | 手动少量处理      |
| IOPaint (LaMa)    | ★★★★ | ★★★  | ★★   | ✅      | 批量高质量处理    |
| OpenCV inpaint    | ★★★  | ★★★★ | ★★   | ✅      | 轻量快速          |
| GeminiWatermarkTool| ★★★★| ★★★★ | ★    | ✅      | 字节系专用        |
| 浏览器插件         | ★★★★★| ★★★★ | ★    | ❌      | 手动使用          |

### 视频去水印

| 工具               | 质量 | 速度 | 难度 | 适合场景              |
|-------------------|------|------|------|-----------------------|
| 源头设置+插件下载  | ★★★★★| ★★★★★| ★    | 最推荐               |
| static-ghost      | ★★★★ | ★★★  | ★★   | AI修复，效果好        |
| FFmpeg delogo     | ★★★  | ★★★★★| ★★   | 快速处理，效果一般    |
| LazyCut           | ★★★★ | ★★   | ★    | 在线处理，隐私安全    |
| IOPaint+FFmpeg    | ★★★★★| ★★   | ★★★  | 最高质量，需要GPU     |

---

## 七、推荐工作流

### 日常使用 (少量)
1. 即梦设置去除水印 → 画布导出 (图片) + 猫抓插件 (视频)
2. 豆包拖拽法 (图片)

### 批量处理 (images-api 集成)
1. 图片: IOPaint API + 自动掩码生成
2. 视频: static-ghost 或 FFmpeg delogo
3. 集成到 images-api 的后处理管道

### 高质量要求
1. 图片: IOPaint (LaMa 模型 + GPU)
2. 视频: IOPaint 逐帧修复 + FFmpeg 合成

---

## 八、注意事项

1. **法律合规**: 去除 AI 水印前，请确保符合相关法律法规
2. **内容标识**: 中国法规要求 AI 生成内容需标识，去除水印后请自行承担合规风险
3. **画质影响**: 后处理去水印会有一定画质损失，源头去除是最佳方案
4. **坐标校准**: 不同分辨率下水印位置不同，需根据实际图片/视频调整坐标
5. **会员方案**: 如需高质量无水印，即梦/豆包 VIP 会员是最直接的方案
