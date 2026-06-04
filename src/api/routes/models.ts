import _ from 'lodash';

export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            return {
                "data": [
                    {
                        "id": "jimeng-5.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI图像生成模型 5.0 版本（最新）"
                    },
                    {
                        "id": "jimeng-4.7",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI图像生成模型 4.7 版本"
                    },
                    {
                        "id": "jimeng-4.6",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI图像生成模型 4.6 版本"
                    },
                    {
                        "id": "jimeng-4.5",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI图像生成模型 4.5 版本"
                    },
                    {
                        "id": "jimeng-4.1",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI图像生成模型 4.1 版本"
                    },
                    {
                        "id": "jimeng-4.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI图像生成模型 4.0 版本"
                    },

                    {
                        "id": "jimeng-video-seedance-2.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "Seedance 2.0 多图智能视频生成模型（免费）"
                    },
                    {
                        "id": "jimeng-video-seedance-2.0-fast",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "Seedance 2.0 Fast 快速视频生成模型（免费）"
                    },
                    {
                        "id": "jimeng-video-3.5-pro",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "Seedance 1.5 Pro 视频生成模型（免费）"
                    },
                    {
                        "id": "kling-v3-omni",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "Kling 官方图片模型 v3 omni，建议搭配 Kling 原生图片接口使用"
                    },
                    {
                        "id": "kling-image-o1",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "Kling 官方图片模型 o1，支持 1K/2K 与智能比例能力"
                    },
                    {
                        "id": "doubao-seedream-5.0-lite",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "豆包 Seedream 5.0 Lite 生图模型（最新，支持联网检索）"
                    },
                    {
                        "id": "doubao-seedream-4.5",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "豆包 Seedream 4.5 生图模型"
                    },
                    {
                        "id": "doubao-seedream-4.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "豆包 Seedream 4.0 生图模型"
                    },
                    {
                        "id": "doubao-seedance-2.0-fast",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "豆包 Seedance 2.0 Fast 视频生成模型（每日10次免费额度，5秒视频）"
                    },
                    {
                        "id": "qwen-happyhorse-1.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "千问 HappyHorse 1.0 视频生成模型（通过 create.qianwen.com）"
                    },
                    {
                        "id": "wan2.6-t2v",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "通义万相 Wan 2.6 文生视频模型（DashScope）"
                    },
                    {
                        "id": "wan2.7-t2v",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "通义万相 Wan 2.7 文生视频模型（千问创作网页端）"
                    },
                    {
                        "id": "wan2.7-image",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "通义万相 Wan 2.7-Image 生图模型（最新，支持多图参考，最高2K）"
                    },
                    {
                        "id": "qwen-image-2.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "千问 Qwen-Image 2.0 高质感生图模型（免费，支持文生图/图生图）"
                    },
                    {
                        "id": "qwen-image-1.0-pro",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "千问 Qwen-Image 1.0 专业版生图模型（免费，支持文生图/图生图）"
                    },
                    {
                        "id": "qwen-image-1.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "千问 Qwen-Image 1.0 生图模型（免费，支持文生图/图生图）"
                    },
                    {
                        "id": "xyq-seedream-5.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "小云雀 Seedream 5.0 生图模型（最新）"
                    },
                    {
                        "id": "xyq-seedream-4.5",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "小云雀 Seedream 4.5 生图模型"
                    },
                    {
                        "id": "xyq-seedream-4.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "小云雀 Seedream 4.0 生图模型"
                    },
                    {
                        "id": "xyq-seedance-2.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "小云雀 Seedance 2.0 视频生成模型"
                    },
                    {
                        "id": "xyq-seedance-2.0-fast",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "小云雀 Seedance 2.0 Fast 快速视频生成模型"
                    },
                    {
                        "id": "seedream-5.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "统一 Seedream 5.0 模型（自动轮询 jimeng→xyq→doubao，积分/额度耗尽自动降级）"
                    },
                    {
                        "id": "seedream-4.5",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "统一 Seedream 4.5 模型（自动轮询 jimeng→xyq→doubao，积分/额度耗尽自动降级）"
                    },
                    {
                        "id": "seedream-4.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "统一 Seedream 4.0 模型（自动轮询 jimeng→xyq→doubao，积分/额度耗尽自动降级）"
                    }
                ]
            };
        }

    }
}
