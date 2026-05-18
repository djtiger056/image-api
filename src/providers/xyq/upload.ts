/**
 * 小云雀图片上传模块
 *
 * 走 /api/web/v1/common/upload_file，使用 sessionid cookie 认证。
 */

import axios from "axios";
import FormData from "form-data";

import logger from "@/lib/logger.ts";

const XYQ_BASE = "https://xyq.jianying.com";

const FAKE_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  Origin: XYQ_BASE,
  Referer: `${XYQ_BASE}/home?tab_name=home`,
  "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  appvr: "1.1.4",
  "entrance-from": "web",
  appid: "795647",
};

function buildCookie(sessionId: string): string {
  const raw = String(sessionId || "").trim();
  if (!raw) return "";
  const match = raw.match(/(?:^|;\s*)sessionid=([^;,\s]+)/i);
  const value = match?.[1] || raw.replace(/^Bearer\s+/i, "");
  return value ? `sessionid=${value}; sessionid_ss=${value}; sessionid_ss_pippitcn_web=${value}` : "";
}

function guessContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "png") return "image/png";
  return "application/octet-stream";
}

export interface XyqUploadResult {
  asset_id: string;
  pippit_asset_id: string;
  download_url: string;
  format?: string;
  size?: number;
  width?: number;
  height?: number;
}

function detectImageSize(buffer: Buffer): { width?: number; height?: number } {
  if (buffer.length < 10) return {};

  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xc3 &&
        offset + 8 < buffer.length
      ) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + length;
    }
  }

  if (
    buffer.length >= 10 &&
    (buffer.toString("ascii", 0, 6) === "GIF87a" || buffer.toString("ascii", 0, 6) === "GIF89a")
  ) {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    };
  }

  if (
    buffer.length >= 26 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunkType = buffer.toString("ascii", 12, 16);
    if (chunkType === "VP8X" && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
    if (chunkType === "VP8 " && buffer.length >= 30) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunkType === "VP8L" && buffer.length >= 25) {
      const b1 = buffer[21];
      const b2 = buffer[22];
      const b3 = buffer[23];
      const b4 = buffer[24];
      const width = 1 + (((b2 & 0x3f) << 8) | b1);
      const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      return { width, height };
    }
  }

  return {};
}

async function resolveBuffer(imageData: Buffer | string): Promise<{ buffer: Buffer; filename: string }> {
  if (typeof imageData === "string") {
    logger.info(`[XYQ] 下载图片: ${imageData.substring(0, 100)}...`);
    const response = await fetch(imageData);
    if (!response.ok) {
      throw new Error(`[XYQ] 下载图片失败: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const urlPath = new URL(imageData).pathname;
    const ext = urlPath.split(".").pop()?.toLowerCase();
    const filename = ext && ["png", "jpg", "jpeg", "webp", "gif"].includes(ext)
      ? `image.${ext}`
      : "image.png";
    return { buffer, filename };
  }

  return { buffer: imageData, filename: "image.png" };
}

export async function uploadImageToXyq(
  imageData: Buffer | string,
  sessionId: string
): Promise<XyqUploadResult> {
  const { buffer, filename } = await resolveBuffer(imageData);
  const cookieHeader = buildCookie(sessionId);
  const size = detectImageSize(buffer);

  logger.info(`[XYQ] 开始上传图片: ${buffer.length} 字节`);

  const form = new FormData();
  form.append("file", buffer, {
    filename,
    contentType: guessContentType(filename),
  });
  form.append("asset_type", "2");

  const response = await axios.request({
    method: "POST",
    url: `${XYQ_BASE}/api/web/v1/common/upload_file`,
    headers: {
      ...FAKE_HEADERS,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...form.getHeaders(),
    },
    data: form,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 60000,
    validateStatus: () => true,
  });

  const result = response.data;
  const { ret, errmsg, data } = result || {};

  if ((ret !== "0" && ret !== 0) || !data) {
    throw new Error(`[云雀图片上传失败]: ret=${ret}, errmsg=${errmsg}`);
  }

  const assetId = String(data.asset_id || "").trim();
  const pippitAssetId = String(data.pippit_asset_id || "").trim();

  if (!assetId && !pippitAssetId) {
    throw new Error(`[云雀图片上传未返回asset_id]: ${JSON.stringify(data)}`);
  }

  logger.info(`[XYQ] 图片上传成功: asset_id=${assetId}, pippit_asset_id=${pippitAssetId}`);

  return {
    asset_id: assetId,
    pippit_asset_id: pippitAssetId,
    download_url: data.download_url || "",
    format: data.format,
    size: data.size,
    width: size.width,
    height: size.height,
  };
}
