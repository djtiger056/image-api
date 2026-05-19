import _ from 'lodash';

export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            return {
                "data": [
                    {
                        "id": "jimeng",
                        "object": "model",
                        "owned_by": "images-api"
                    },
                    {
                        "id": "jimeng-5.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI图像生成模型 5.0 版本（最新）"
                    },
                    {
                        "id": "jimeng-4.6",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI图像生成模型 4.6 版本（最新）"
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
                        "id": "jimeng-3.1",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI图像生成模型 3.1 版本"
                    },
                    {
                        "id": "jimeng-3.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI图像生成模型 3.0 版本"
                    },
                    {
                        "id": "jimeng-2.1",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI图像生成模型 2.1 版本"
                    },
                    {
                        "id": "jimeng-2.0-pro",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI图像生成模型 2.0 专业版"
                    },
                    {
                        "id": "jimeng-2.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI图像生成模型 2.0 版本"
                    },
                    {
                        "id": "jimeng-1.4",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI图像生成模型 1.4 版本"
                    },
                    {
                        "id": "jimeng-xl-pro",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI图像生成模型 XL Pro 版本"
                    },
                    {
                        "id": "jimeng-video-3.5-pro",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI视频生成模型 3.5 专业版"
                    },
                    {
                        "id": "jimeng-video-3.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI视频生成模型 3.0 版本"
                    },
                    {
                        "id": "jimeng-video-3.0-pro",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "即梦AI视频生成模型 3.0 专业版"
                    },
                    {
                        "id": "jimeng-video-seedance-2.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "Seedance 2.0 多图智能视频生成模型（国内兼容接口可用；国际 token hk-/jp-/sg- 建议走 /v1/videos/international/generations）"
                    },
                    {
                        "id": "seedance-2.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "Seedance 2.0 多图智能视频生成模型（jimeng-video-seedance-2.0 的别名，向后兼容）"
                    },
                    {
                        "id": "seedance-2.0-pro",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "Seedance 2.0 Pro 多图智能视频生成模型（jimeng-video-seedance-2.0 的别名，向后兼容）"
                    },
                    {
                        "id": "jimeng-video-seedance-2.0-fast",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "Seedance 2.0-fast 快速多图智能视频生成模型（国内兼容接口可用；国际 token hk-/jp-/sg- 建议走 /v1/videos/international/generations）"
                    },
                    {
                        "id": "seedance-2.0-fast",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "Seedance 2.0-fast 快速多图智能视频生成模型（jimeng-video-seedance-2.0-fast 的别名，向后兼容）"
                    },
                    {
                        "id": "jimeng-video-seedance-2.0-fast-vip",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "Seedance 2.0 Fast VIP Vision 文生视频模型（dreamina_seedance_40_vision，VIP 快速版，支持文生视频和图生视频）"
                    },
                    {
                        "id": "seedance-2.0-fast-vip",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "Seedance 2.0 Fast VIP Vision 文生视频模型（jimeng-video-seedance-2.0-fast-vip 的别名，向后兼容）"
                    },
                    {
                        "id": "jimeng-video-seedance-2.0-vip",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "Seedance 2.0 VIP Vision 主模态能力视频模型（dreamina_seedance_40_pro_vision，VIP 专业版，主模态能力）"
                    },
                    {
                        "id": "seedance-2.0-vip",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "Seedance 2.0 VIP Vision 主模态能力视频模型（jimeng-video-seedance-2.0-vip 的别名，向后兼容）"
                    },
                    {
                        "id": "kling-v2-1",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "Kling 官方图片模型 v2.1，已接入统一 /v1/images/generations 路由与原生任务查询接口"
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
                        "id": "kling-v3",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "Kling 官方图片模型 v3，作为后续扩展保留在模型清单中"
                    },
                    {
                        "id": "doubao-seedream-4.5",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "豆包 Seedream 4.5 生图模型（最新，默认推荐）"
                    },
                    {
                        "id": "doubao-seedream-4.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "豆包 Seedream 4.0 生图模型"
                    },
                    {
                        "id": "doubao-seedream-3.0",
                        "object": "model",
                        "owned_by": "images-api",
                        "description": "豆包 Seedream 3.0 生图模型"
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
