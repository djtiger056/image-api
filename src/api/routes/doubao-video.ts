import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import util from '@/lib/util.ts';
import logger from '@/lib/logger.ts';
import {
  createVideoCompletion,
  createVideoCompletionStream,
  isDoubaoVideoModelName,
  resolveDoubaoVideoModel,
  normalizeVideoRatio,
  DEFAULT_DOUBAO_VIDEO_MODEL,
} from '@/providers/doubao/video-api.ts';
import { tokenSplit } from '@/providers/doubao/api.ts';

/**
 * 解析豆包视频 Authorization
 */
function resolveDoubaoVideoAuthorization(authorization?: string): string {
  const incoming = String(authorization || '').trim();
  if (incoming) return incoming;

  const envAuth = String(process.env.DOUBAO_AUTHORIZATION || '').trim();
  if (envAuth) return /^Bearer\s+/i.test(envAuth) ? envAuth : `Bearer ${envAuth}`;

  const envSession = String(process.env.DOUBAO_SESSIONID || '').trim();
  if (envSession) return /^Bearer\s+/i.test(envSession) ? envSession : `Bearer ${envSession}`;

  throw new Error('豆包视频服务未配置可用凭证。请设置 DOUBAO_AUTHORIZATION 或 DOUBAO_SESSIONID。');
}

function pickDoubaoToken(authorization?: string): string {
  const raw = resolveDoubaoVideoAuthorization(authorization);
  const tokens = tokenSplit(raw);
  const token = _.sample(tokens);
  if (!token) throw new Error('Doubao Authorization 中没有可用 token');
  return token;
}

export default {

  prefix: '/v1/doubao/videos',

  post: {

    /**
     * POST /v1/doubao/videos/generations
     * 豆包视频生成（同步模式，等待完成后返回视频 URL）
     */
    '/generations': async (request: Request) => {
      request
        .validate('body.model', v => _.isUndefined(v) || _.isString(v))
        .validate('body.prompt', v => _.isString(v) && v.length > 0)
        .validate('body.ratio', v => _.isUndefined(v) || _.isString(v))
        .validate('body.duration', v => _.isUndefined(v) || _.isFinite(v))
        .validate('body.images', v => _.isUndefined(v) || Array.isArray(v))
        .validate('body.response_format', v => _.isUndefined(v) || _.isString(v));

      const token = pickDoubaoToken(request.headers.authorization as string | undefined);

      const {
        model = DEFAULT_DOUBAO_VIDEO_MODEL,
        prompt,
        ratio = '16:9',
        duration = 5,
        images = [],
        response_format = 'url',
      } = request.body;

      const modelMapping = resolveDoubaoVideoModel(model);
      const normalizedRatio = normalizeVideoRatio(ratio);

      logger.info(`[DoubaoVideo Route] 同步视频生成: model=${modelMapping.model}, ratio=${normalizedRatio}, duration=${duration}s, images=${Array.isArray(images) ? images.length : 0}`);

      const result = await createVideoCompletion(
        {
          prompt,
          ratio: normalizedRatio,
          duration,
          skillId: modelMapping.skillId,
          referenceImages: Array.isArray(images)
            ? images.filter((item) => _.isString(item) && item.trim()).map((item) => String(item).trim())
            : [],
        },
        token
      );

      // 检查额度用尽
      if (result.quotaExhausted) {
        return {
          created: util.unixTimestamp(),
          error: {
            message: '豆包视频今日免费额度已用完（每日10次），请明天再试。',
            type: 'quota_exhausted',
            code: 'daily_limit_reached',
          },
        };
      }

      // 检查是否获取到视频
      if (!result.videoUrl) {
        return {
          created: util.unixTimestamp(),
          error: {
            message: result.textContent || '豆包视频生成未返回视频URL',
            type: 'generation_failed',
          },
          debug: { textContent: result.textContent },
        };
      }

      if (response_format === 'b64_json') {
        const videoBase64 = await util.fetchFileBASE64(result.videoUrl);
        return {
          created: util.unixTimestamp(),
          data: [{ b64_json: videoBase64 }],
          model,
          provider: 'doubao',
        };
      }

      return {
        created: util.unixTimestamp(),
        data: [{ url: result.videoUrl }],
        model,
        provider: 'doubao',
      };
    },

    /**
     * POST /v1/doubao/videos/generations/stream
     * 豆包视频生成（流式 SSE 模式）
     */
    '/generations/stream': async (request: Request) => {
      request
        .validate('body.model', v => _.isUndefined(v) || _.isString(v))
        .validate('body.prompt', v => _.isString(v) && v.length > 0)
        .validate('body.ratio', v => _.isUndefined(v) || _.isString(v))
        .validate('body.duration', v => _.isUndefined(v) || _.isFinite(v))
        .validate('body.images', v => _.isUndefined(v) || Array.isArray(v));

      const token = pickDoubaoToken(request.headers.authorization as string | undefined);

      const {
        model = DEFAULT_DOUBAO_VIDEO_MODEL,
        prompt,
        ratio = '16:9',
        duration = 5,
        images = [],
      } = request.body;

      const modelMapping = resolveDoubaoVideoModel(model);
      const normalizedRatio = normalizeVideoRatio(ratio);

      logger.info(`[DoubaoVideo Route] 流式视频生成: model=${modelMapping.model}, ratio=${normalizedRatio}`);

      const transStream = await createVideoCompletionStream(
        {
          prompt,
          ratio: normalizedRatio,
          duration,
          skillId: modelMapping.skillId,
          referenceImages: Array.isArray(images)
            ? images.filter((item) => _.isString(item) && item.trim()).map((item) => String(item).trim())
            : [],
        },
        token
      );

      return new Response(transStream, {
        type: 'text/event-stream',
        headers: {
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    },
  },

  get: {

    /**
     * GET /v1/doubao/videos/models
     * 返回可用的豆包视频模型列表
     */
    '/models': async () => {
      return {
        data: [
          {
            id: 'doubao-seedance-2.0-fast',
            object: 'model',
            owned_by: 'images-api',
            description: '豆包 Seedance 2.0 Fast 视频生成模型（每日10次免费额度）',
          },
        ],
      };
    },
  },
};
