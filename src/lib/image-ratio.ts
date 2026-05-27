import fs from "fs";

import util from "@/lib/util.ts";

export interface ImageDimensions {
  width: number;
  height: number;
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function parsePngDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function parseGifDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 10) return null;
  const signature = buffer.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  };
}

function parseBmpDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 26) return null;
  if (buffer.toString("ascii", 0, 2) !== "BM") return null;
  const dibHeaderSize = buffer.readUInt32LE(14);
  if (dibHeaderSize < 12) return null;
  if (dibHeaderSize === 12) {
    return {
      width: buffer.readUInt16LE(18),
      height: buffer.readUInt16LE(20),
    };
  }
  return {
    width: Math.abs(buffer.readInt32LE(18)),
    height: Math.abs(buffer.readInt32LE(22)),
  };
}

function parseJpegDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset++;
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    if (offset >= buffer.length) break;

    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 1 >= buffer.length) break;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;

    const isSofMarker =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSofMarker) {
      if (offset + 7 >= buffer.length) break;
      return {
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3),
      };
    }

    offset += segmentLength;
  }

  return null;
}

function parseWebpDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 30) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WEBP") return null;

  const chunkType = buffer.toString("ascii", 12, 16);
  if (chunkType === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + readUInt24LE(buffer, 24),
      height: 1 + readUInt24LE(buffer, 27),
    };
  }

  if (chunkType === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }

  if (chunkType === "VP8L" && buffer.length >= 25) {
    const b0 = buffer[21];
    const b1 = buffer[22];
    const b2 = buffer[23];
    const b3 = buffer[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }

  return null;
}

export function getImageDimensions(buffer: Buffer): ImageDimensions | null {
  return (
    parsePngDimensions(buffer) ||
    parseJpegDimensions(buffer) ||
    parseGifDimensions(buffer) ||
    parseWebpDimensions(buffer) ||
    parseBmpDimensions(buffer)
  );
}

export function pickClosestAspectRatio(
  width: number,
  height: number,
  supportedRatios: string[],
  fallbackRatio: string
): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return fallbackRatio;
  }

  const actual = width / height;
  let bestRatio = fallbackRatio;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const ratio of supportedRatios) {
    const [rw, rh] = String(ratio).split(":").map(Number);
    if (!Number.isFinite(rw) || !Number.isFinite(rh) || rw <= 0 || rh <= 0) continue;
    const target = rw / rh;
    const distance = Math.abs(Math.log(actual / target));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestRatio = ratio;
    }
  }

  return bestRatio;
}

export async function inferClosestRatioFromImageSource(
  source: string,
  supportedRatios: string[],
  fallbackRatio: string
): Promise<string> {
  if (!source) return fallbackRatio;

  let buffer: Buffer;
  if (util.isBASE64Data(source)) {
    buffer = Buffer.from(util.removeBASE64DataHeader(source), "base64");
  } else if (util.isURL(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`下载图片失败: ${response.status}`);
    buffer = Buffer.from(await response.arrayBuffer());
  } else {
    buffer = fs.readFileSync(source);
  }

  const dimensions = getImageDimensions(buffer);
  if (!dimensions) return fallbackRatio;
  return pickClosestAspectRatio(
    dimensions.width,
    dimensions.height,
    supportedRatios,
    fallbackRatio
  );
}

export function inferClosestRatioFromImageBuffer(
  buffer: Buffer,
  supportedRatios: string[],
  fallbackRatio: string
): string {
  const dimensions = getImageDimensions(buffer);
  if (!dimensions) return fallbackRatio;
  return pickClosestAspectRatio(
    dimensions.width,
    dimensions.height,
    supportedRatios,
    fallbackRatio
  );
}
