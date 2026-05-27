import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import util from '@/lib/util.ts';
import logger from '@/lib/logger.ts';
import { inferClosestRatioFromImageSource } from '@/lib/image-ratio.ts';
import {
  createVideoCompletion,
  createVideoCompletionStream,
  DOUBAO_VIDEO_FIXED_DURATION,
  fetchDoubaoVideoBuffer,
  fetchDoubaoVideoStream,
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

const DOUBAO_VIDEO_REFERENCE_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'];
const DOUBAO_VIDEO_PROXY_TTL_MS = 60 * 60 * 1000;
const doubaoVideoProxyCache = new Map<string, { url: string; token: string; expiresAt: number }>();

function normalizeOptionalMs(value: any): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : undefined;
}

async function resolveDoubaoVideoRatio(ratio: string, images: any[]): Promise<string> {
  const fallback = normalizeVideoRatio(ratio);
  const firstImage = Array.isArray(images)
    ? images.find((item) => _.isString(item) && item.trim())
    : undefined;

  if (!firstImage) return fallback;

  try {
    return await inferClosestRatioFromImageSource(
      String(firstImage).trim(),
      DOUBAO_VIDEO_REFERENCE_RATIOS,
      fallback
    );
  } catch (error: any) {
    logger.warn(`[DoubaoVideo Route] 无法解析参考图比例，使用默认比例 ${fallback}: ${error.message}`);
    return fallback;
  }
}

function pruneDoubaoVideoProxyCache() {
  const now = util.timestamp();
  for (const [id, item] of doubaoVideoProxyCache.entries()) {
    if (item.expiresAt <= now) doubaoVideoProxyCache.delete(id);
  }
}

function createDoubaoVideoProxyUrl(url: string, token: string): string {
  pruneDoubaoVideoProxyCache();
  const id = util.uuid(false);
  doubaoVideoProxyCache.set(id, {
    url,
    token,
    expiresAt: util.timestamp() + DOUBAO_VIDEO_PROXY_TTL_MS,
  });
  return `/v1/doubao/videos/proxy/${id}`;
}

function buildDoubaoVideoResponse(result: any, model: string, token: string) {
  const videoUrls = result.videoUrls?.length ? result.videoUrls : [result.videoUrl];
  const proxyUrl = createDoubaoVideoProxyUrl(result.videoUrl, token);
  const playbackUrls = videoUrls.map((url: string) =>
    url === result.videoUrl ? proxyUrl : createDoubaoVideoProxyUrl(url, token)
  );

  return {
    created: util.unixTimestamp(),
    data: [{ url: result.videoUrl, playback_url: proxyUrl, raw_url: result.videoUrl }],
    model,
    provider: 'doubao',
    videoUrl: result.videoUrl,
    playbackUrl: proxyUrl,
    videoUrls: videoUrls,
    playbackUrls: playbackUrls,
    rawVideoUrl: result.videoUrl,
    rawVideoUrls: videoUrls,
    result_url: result.videoUrl,
    playback_url: proxyUrl,
    raw_result_url: result.videoUrl,
    text: result.textContent || undefined,
  };
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
        .validate('body.poll_timeout_ms', v => _.isUndefined(v) || _.isFinite(v))
        .validate('body.poll_interval_ms', v => _.isUndefined(v) || _.isFinite(v))
        .validate('body.response_format', v => _.isUndefined(v) || _.isString(v));

      const token = pickDoubaoToken(request.headers.authorization as string | undefined);

      const {
        model = DEFAULT_DOUBAO_VIDEO_MODEL,
        prompt,
        ratio = '16:9',
        images = [],
        poll_timeout_ms,
        poll_interval_ms,
        response_format = 'url',
      } = request.body;
      const duration = DOUBAO_VIDEO_FIXED_DURATION;

      const modelMapping = resolveDoubaoVideoModel(model);
      const referenceImages = Array.isArray(images)
        ? images.filter((item) => _.isString(item) && item.trim()).map((item) => String(item).trim())
        : [];
      const normalizedRatio = await resolveDoubaoVideoRatio(ratio, referenceImages);

      logger.info(`[DoubaoVideo Route] 同步视频生成: model=${modelMapping.model}, ratio=${normalizedRatio}, duration=${duration}s, images=${referenceImages.length}`);

      const result = await createVideoCompletion(
        {
          prompt,
          ratio: normalizedRatio,
          duration,
          skillId: modelMapping.skillId,
          referenceImages,
          pollOptions: {
            timeoutMs: normalizeOptionalMs(poll_timeout_ms),
            intervalMs: normalizeOptionalMs(poll_interval_ms),
          },
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

      if (result.streamClosedWhilePending && !result.videoUrl) {
        return {
          created: util.unixTimestamp(),
          error: {
            message: result.candidateVideoUrls?.length
              ? '豆包已返回视频候选 URL，但服务端下载探测返回 403/非视频内容，未能转成前端可播放视频。'
              : (result.textContent || '豆包已接受视频生成任务，但当前连接已结束，未同步返回视频结果。'),
            type: 'generation_pending',
            code: result.candidateVideoUrls?.length
              ? 'candidate_video_url_not_playable'
              : 'upstream_stream_closed_while_pending',
          },
          debug: {
            textContent: result.textContent,
            conversation_id: result.conversationId || undefined,
            candidate_video_urls: result.candidateVideoUrls || undefined,
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
          debug: {
            textContent: result.textContent,
            conversation_id: result.conversationId || undefined,
            candidate_video_urls: result.candidateVideoUrls || undefined,
          },
        };
      }

      if (response_format === 'b64_json') {
        const rawVideoUrl = result.rawVideoUrl || result.videoUrl;
        const { buffer } = await fetchDoubaoVideoBuffer(rawVideoUrl, token);
        const videoBase64 = buffer.toString('base64');
        return {
          created: util.unixTimestamp(),
          data: [{ b64_json: videoBase64 }],
          model,
          provider: 'doubao',
          videoUrl: rawVideoUrl,
          playbackUrl: result.playbackUrl || undefined,
          videoUrls: result.videoUrls || [rawVideoUrl],
          playbackUrls: result.playbackUrls || undefined,
          rawVideoUrl,
          text: result.textContent || undefined,
        };
      }

      return buildDoubaoVideoResponse(result, model, token);
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
        .validate('body.poll_timeout_ms', v => _.isUndefined(v) || _.isFinite(v))
        .validate('body.poll_interval_ms', v => _.isUndefined(v) || _.isFinite(v))
        .validate('body.images', v => _.isUndefined(v) || Array.isArray(v));

      const token = pickDoubaoToken(request.headers.authorization as string | undefined);

      const {
        model = DEFAULT_DOUBAO_VIDEO_MODEL,
        prompt,
        ratio = '16:9',
        images = [],
        poll_timeout_ms,
        poll_interval_ms,
      } = request.body;
      const duration = DOUBAO_VIDEO_FIXED_DURATION;

      const modelMapping = resolveDoubaoVideoModel(model);
      const referenceImages = Array.isArray(images)
        ? images.filter((item) => _.isString(item) && item.trim()).map((item) => String(item).trim())
        : [];
      const normalizedRatio = await resolveDoubaoVideoRatio(ratio, referenceImages);

      logger.info(`[DoubaoVideo Route] 流式视频生成: model=${modelMapping.model}, ratio=${normalizedRatio}`);

      const transStream = await createVideoCompletionStream(
        {
          prompt,
          ratio: normalizedRatio,
          duration,
          skillId: modelMapping.skillId,
          referenceImages,
          pollOptions: {
            timeoutMs: normalizeOptionalMs(poll_timeout_ms),
            intervalMs: normalizeOptionalMs(poll_interval_ms),
          },
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

    /**
     * GET /v1/doubao/videos/proxy/:id
     * 代理豆包视频播放，避免浏览器跨域/防盗链导致控制台预览失败。
     */
    '/proxy/:id': async (request: Request) => {
      pruneDoubaoVideoProxyCache();
      const id = String(request.params.id || '');
      const item = doubaoVideoProxyCache.get(id);
      if (!item) throw new Error('豆包视频代理链接已过期，请重新生成视频。');

      const upstream = await fetchDoubaoVideoStream(
        item.url,
        item.token,
        request.headers.range as string | undefined
      );
      const headers: Record<string, string> = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      };
      for (const key of ['content-length', 'content-range']) {
        const value = upstream.headers[key];
        if (value) headers[key] = String(value);
      }

      return new Response(upstream.stream, {
        statusCode: upstream.status === 206 ? 206 : 200,
        type: upstream.contentType || 'video/mp4',
        headers,
      });
    },
  },
};
