/**
 * 千问 (Qwen) 素材上传助手
 *
 * 统一处理 Cookie 归一化、参考图下载/读取、OSS 上传与 material_id 回调。
 */

import axios from "axios";

import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import {
  absorbQwenSetCookie,
  createQwenSessionFromCookie,
  QwenSession,
} from "@/providers/qwen/session.ts";

export const RESOURCE_API_BASE = "https://aistudio-resource.qianwen.com";

export const DEFAULT_QWEN_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

export function normalizeCookieString(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        return arr
          .filter((item: any) => item && item.name)
          .map((item: any) => `${item.name}=${item.value || ""}`)
          .join("; ");
      }
    } catch {}
  }
  return trimmed;
}

export function buildResourceApiUrl(path: string): string {
  const reqId = util.uuid().replace(/-/g, "");
  return `${RESOURCE_API_BASE}${path}?biz_id=ai_image&req_id=${reqId}&uc_param_str=vesvutkpfrcgprospc&pr=kkpcweb&fr=win`;
}

export async function fetchImageData(
  imageSource: string
): Promise<{ buffer: Buffer; contentType: string }> {
  if (imageSource.startsWith("data:")) {
    const match = imageSource.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error("无效的 data URL 格式");
    return {
      buffer: Buffer.from(match[2], "base64"),
      contentType: match[1],
    };
  }

  const resp = await axios.get(imageSource, {
    responseType: "arraybuffer",
    timeout: 30000,
  });

  return {
    buffer: Buffer.from(resp.data),
    contentType: resp.headers["content-type"] || "image/png",
  };
}

export async function uploadImageToQwen(
  imageSource: string,
  sessionInput: string | QwenSession,
  logPrefix: string = "Qwen"
): Promise<string> {
  const session = typeof sessionInput === "string"
    ? createQwenSessionFromCookie(sessionInput, { source: "authorization", canPersist: false })
    : sessionInput;
  const { buffer: imageBuffer, contentType } = await fetchImageData(imageSource);
  const crypto = await import("crypto");

  logger.info(
    `[${logPrefix}] 图片已获取 (${(imageBuffer.length / 1024).toFixed(1)}KB, ${contentType})，开始上传到千问 CDN...`
  );

  const fileMd5 = crypto.createHash("md5").update(imageBuffer).digest("base64");
  const fileName = `img_${Date.now()}.png`;

  const ossTokenUrl = buildResourceApiUrl("/1/oss_token");
  logger.info(`[${logPrefix}] 获取 OSS 凭证: ${ossTokenUrl}`);

  let ossData: any;
  try {
    const tokenResp = await axios.post(
      ossTokenUrl,
      {
        file_name: fileName,
        content_type: "application/octet-stream",
        content_md5: fileMd5,
        size: String(imageBuffer.length),
        file_type: contentType || "image/png",
        entry: "ugc",
      },
      {
        headers: { Cookie: session.cookieHeader, ...DEFAULT_QWEN_HEADERS },
        timeout: 15000,
      }
    );
    await absorbQwenSetCookie(session, tokenResp);
    if (tokenResp.data.code !== 0) {
      throw new Error(tokenResp.data.msg || "获取 OSS 凭证失败");
    }
    ossData = tokenResp.data.data;
    logger.info(`[${logPrefix}] OSS 凭证获取成功: object=${ossData.object}`);
  } catch (e: any) {
    const status = e.response?.status;
    const data = e.response?.data;
    logger.warn(
      `[${logPrefix}] 获取 OSS 凭证失败: status=${status}, data=${JSON.stringify(data || e.message)}`
    );
    throw new Error(`获取 OSS 凭证失败: ${status} ${JSON.stringify(data)}`);
  }

  const ossUrl = `${ossData.host}/${ossData.object}`;
  const ossHeaders: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    Authorization: ossData.authorization,
    "Content-MD5": fileMd5,
  };
  for (const h of ossData.oss_headers || []) {
    ossHeaders[h.key] = h.value;
  }

  logger.info(`[${logPrefix}] 上传到 OSS: ${ossUrl}`);
  try {
    await axios.put(ossUrl, imageBuffer, {
      headers: ossHeaders,
      timeout: 30000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    logger.info(`[${logPrefix}] OSS 上传成功`);
  } catch (e: any) {
    const status = e.response?.status;
    const data = e.response?.data;
    logger.warn(
      `[${logPrefix}] OSS 上传失败: status=${status}, data=${JSON.stringify(data || e.message).substring(0, 200)}`
    );
    throw new Error(`OSS 上传失败: ${status}`);
  }

  const callbackUrl = buildResourceApiUrl("/1/oss/callback");
  logger.info(`[${logPrefix}] 注册素材: ${callbackUrl}`);

  let materialResp: any;
  try {
    materialResp = await axios.post(
      callbackUrl,
      {
        object: ossData.object,
        bucket: ossData.bucket,
        file_name: fileName,
        file_md5: fileMd5,
        file_type: "PNG",
        entry: "ugc",
        endpoint: ossData.endpoint,
      },
      {
        headers: { Cookie: session.cookieHeader, ...DEFAULT_QWEN_HEADERS },
        timeout: 15000,
      }
    );
    await absorbQwenSetCookie(session, materialResp);
  } catch (e: any) {
    const status = e.response?.status;
    const data = e.response?.data;
    logger.warn(
      `[${logPrefix}] 注册素材失败: status=${status}, data=${JSON.stringify(data || e.message).substring(0, 200)}`
    );
    throw new Error(`注册素材失败: ${status} ${JSON.stringify(data)}`);
  }

  if (materialResp.data.code !== 0) {
    throw new Error(`注册素材失败: ${materialResp.data.msg}`);
  }

  const materialId = materialResp.data.data?.material_id;
  if (!materialId) {
    throw new Error("注册素材成功但未返回 material_id");
  }

  logger.success(`[${logPrefix}] 图片上传成功，material_id=${materialId}`);
  return materialId;
}
