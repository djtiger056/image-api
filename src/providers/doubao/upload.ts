/**
 * 豆包图片上传模块
 *
 * 将图片上传到字节跳动的 ImageX / TOS 对象存储，
 * 返回 storeUri 用于豆包聊天接口的 attachments。
 *
 * 流程（5步）：
 * 1. prepare_upload → STS 临时凭证
 * 2. ApplyImageUpload → storeUri + 上传凭证
 * 3. TOS upload → 上传原始字节
 * 4. CommitImageUpload → 提交确认
 * 5. 返回 storeUri
 */

import crypto from "crypto";
import axios from "axios";

import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";

// ─── 常量 ────────────────────────────────────────────────────────────

const IMAGEX_HOST = "https://imagex.bytedanceapi.com";
const AWS_REGION = "cn-north-1";
const SERVICE_NAME = "imagex";

const FAKE_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  Origin: "https://www.doubao.com",
  Referer: "https://www.doubao.com",
  "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "cross-site",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

// ─── 工具函数 ──────────────────────────────────────────────────────

function generateCookie(sessionId: string): string {
  return `sessionid=${sessionId}; sessionid_ss=${sessionId}`;
}

/**
 * AWS4-HMAC-SHA256 签名生成
 */
function createSignature(
  method: string,
  url: string,
  headers: { [key: string]: string },
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken?: string,
  payload: string = "",
  awsRegion: string = AWS_REGION,
  serviceName: string = SERVICE_NAME
): string {
  const urlObj = new URL(url);
  const pathname = urlObj.pathname || "/";
  const search = urlObj.search;

  const timestamp = headers["x-amz-date"];
  const date = timestamp.substr(0, 8);
  const region = awsRegion;
  const service = serviceName;

  // 规范化查询参数
  const queryParams: Array<[string, string]> = [];
  const searchParams = new URLSearchParams(search);
  searchParams.forEach((value, key) => {
    queryParams.push([key, value]);
  });
  queryParams.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalQueryString = queryParams
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  // 规范化头部
  const headersToSign: { [key: string]: string } = {
    "x-amz-date": timestamp,
  };

  if (sessionToken) {
    headersToSign["x-amz-security-token"] = sessionToken;
  }

  let payloadHash = crypto.createHash("sha256").update("").digest("hex");
  if (method.toUpperCase() === "POST" && payload) {
    payloadHash = crypto
      .createHash("sha256")
      .update(payload, "utf8")
      .digest("hex");
    headersToSign["x-amz-content-sha256"] = payloadHash;
  }

  const signedHeaders = Object.keys(headersToSign)
    .map((key) => key.toLowerCase())
    .sort()
    .join(";");

  const canonicalHeaders = Object.keys(headersToSign)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((key) => `${key.toLowerCase()}:${headersToSign[key].trim()}\n`)
    .join("");

  const canonicalRequest = [
    method.toUpperCase(),
    pathname,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    credentialScope,
    crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");

  const kDate = crypto
    .createHmac("sha256", `AWS4${secretAccessKey}`)
    .update(date)
    .digest();
  const kRegion = crypto.createHmac("sha256", kDate).update(region).digest();
  const kService = crypto
    .createHmac("sha256", kRegion)
    .update(service)
    .digest();
  const kSigning = crypto
    .createHmac("sha256", kService)
    .update("aws4_request")
    .digest();
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/**
 * 计算 CRC32
 */
function calculateCRC32(buffer: ArrayBuffer): string {
  const crcTable: number[] = [];
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    crcTable[i] = crc;
  }

  let crc = 0 ^ -1;
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
  }
  return ((crc ^ -1) >>> 0).toString(16).padStart(8, "0");
}

// ─── 核心上传流程 ──────────────────────────────────────────────────

interface PrepareUploadResult {
  service_id: string;
  upload_host: string;
  upload_auth_token: {
    access_key: string;
    secret_key: string;
    session_token: string;
    expired_time: string;
    space_name: string;
  };
}

/**
 * 步骤1: 获取上传凭证
 */
async function prepareUpload(sessionId: string): Promise<PrepareUploadResult> {
  const response = await axios.request({
    method: "POST",
    url: "https://www.doubao.com/alice/resource/prepare_upload",
    params: {
      aid: "497858",
      device_platform: "web",
      language: "zh",
      pc_version: "2.44.0",
      region: "CN",
      sys_region: "CN",
      version_code: "20800",
    },
    headers: {
      ...FAKE_HEADERS,
      Cookie: generateCookie(sessionId),
      "Content-Type": "application/json",
    },
    data: {
      tenant_id: "5",
      scene_id: "5",
      resource_type: 2, // 2=图片
    },
    timeout: 15000,
    validateStatus: () => true,
  });

  const { code, data, msg } = response.data || {};
  if (code !== 0 || !data) {
    throw new Error(`[豆包] 获取上传凭证失败: code=${code}, msg=${msg}`);
  }

  return data;
}

/**
 * 步骤2: 申请图片上传 (ImageX ApplyImageUpload)
 */
async function applyImageUpload(
  serviceId: string,
  fileSize: number,
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken: string
): Promise<{ storeUri: string; auth: string; uploadHost: string; sessionKey: string }> {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:\-]/g, "").replace(/\.\d{3}Z$/, "Z");
  const randomStr = Math.random().toString(36).substring(2, 12);

  const applyUrl = `${IMAGEX_HOST}/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=${serviceId}&FileSize=${fileSize}&s=${randomStr}`;

  const requestHeaders: Record<string, string> = {
    "x-amz-date": timestamp,
    "x-amz-security-token": sessionToken,
  };

  const authorization = createSignature(
    "GET",
    applyUrl,
    requestHeaders,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    "",
    AWS_REGION,
    SERVICE_NAME
  );

  const response = await axios.request({
    method: "GET",
    url: applyUrl,
    headers: {
      ...FAKE_HEADERS,
      authorization,
      "x-amz-date": timestamp,
      "x-amz-security-token": sessionToken,
    },
    timeout: 15000,
    validateStatus: () => true,
  });

  const result = response.data;
  if (result?.ResponseMetadata?.Error) {
    throw new Error(
      `[豆包] 申请上传权限失败: ${JSON.stringify(result.ResponseMetadata.Error)}`
    );
  }

  const uploadAddress = result?.Result?.UploadAddress;
  if (!uploadAddress?.StoreInfos?.[0] || !uploadAddress?.UploadHosts?.[0]) {
    throw new Error(`[豆包] 获取上传地址失败: ${JSON.stringify(result)}`);
  }

  const storeInfo = uploadAddress.StoreInfos[0];
  return {
    storeUri: storeInfo.StoreUri,
    auth: storeInfo.Auth,
    uploadHost: uploadAddress.UploadHosts[0],
    sessionKey: uploadAddress.SessionKey,
  };
}

/**
 * 步骤3: 上传文件到 TOS
 */
async function uploadToTos(
  uploadHost: string,
  storeUri: string,
  auth: string,
  imageBuffer: Buffer,
  crc32: string
): Promise<void> {
  const uploadUrl = `https://${uploadHost}/upload/v1/${storeUri}`;

  const response = await axios.request({
    method: "POST",
    url: uploadUrl,
    headers: {
      Accept: "*/*",
      Authorization: auth,
      "Content-CRC32": crc32,
      "Content-Disposition": 'attachment; filename="image.png"',
      "Content-Type": "application/octet-stream",
      Origin: "https://www.doubao.com",
      Referer: "https://www.doubao.com/",
      "User-Agent": FAKE_HEADERS["User-Agent"],
    },
    data: imageBuffer,
    timeout: 60000,
    validateStatus: () => true,
  });

  if (response.status !== 200 || response.data?.code !== 2000) {
    throw new Error(
      `[豆包] 图片上传到TOS失败: status=${response.status}, data=${JSON.stringify(response.data)}`
    );
  }
}

/**
 * 步骤4: 提交上传确认 (ImageX CommitImageUpload)
 */
async function commitImageUpload(
  serviceId: string,
  sessionKey: string,
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken: string
): Promise<void> {
  const commitUrl = `${IMAGEX_HOST}/?Action=CommitImageUpload&Version=2018-08-01&ServiceId=${serviceId}`;

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:\-]/g, "").replace(/\.\d{3}Z$/, "Z");

  const commitPayload = JSON.stringify({
    SessionKey: sessionKey,
    SuccessActionStatus: "200",
  });

  const payloadHash = crypto
    .createHash("sha256")
    .update(commitPayload, "utf8")
    .digest("hex");

  const requestHeaders: Record<string, string> = {
    "x-amz-date": timestamp,
    "x-amz-security-token": sessionToken,
    "x-amz-content-sha256": payloadHash,
  };

  const authorization = createSignature(
    "POST",
    commitUrl,
    requestHeaders,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    commitPayload,
    AWS_REGION,
    SERVICE_NAME
  );

  const response = await axios.request({
    method: "POST",
    url: commitUrl,
    headers: {
      ...FAKE_HEADERS,
      authorization,
      "content-type": "application/json",
      "x-amz-date": timestamp,
      "x-amz-security-token": sessionToken,
      "x-amz-content-sha256": payloadHash,
    },
    data: commitPayload,
    timeout: 15000,
    validateStatus: () => true,
  });

  const result = response.data;
  if (result?.ResponseMetadata?.Error) {
    throw new Error(
      `[豆包] 提交上传失败: ${JSON.stringify(result.ResponseMetadata.Error)}`
    );
  }

  const uriStatus = result?.Result?.Results?.[0]?.UriStatus;
  if (uriStatus !== 2000) {
    logger.warn(`[豆包] 提交上传后 UriStatus=${uriStatus}，可能未成功`);
  }
}

// ─── 公开接口 ──────────────────────────────────────────────────────

/**
 * 上传图片到豆包的 ImageX/TOS 存储
 *
 * @param imageData - 图片数据（Buffer 或 URL 字符串）
 * @param sessionId - 豆包 sessionid
 * @returns storeUri（如 "tos-cn-i-xxx/yyy"），用于 attachment.key
 */
export async function uploadImageToDoubao(
  imageData: Buffer | string,
  sessionId: string
): Promise<string> {
  let imageBuffer: Buffer;

  if (typeof imageData === "string") {
    // URL → 下载为 Buffer
    logger.info(`[Doubao] 下载图片: ${imageData.substring(0, 100)}...`);
    const response = await fetch(imageData);
    if (!response.ok) {
      throw new Error(`[Doubao] 下载图片失败: ${response.status}`);
    }
    imageBuffer = Buffer.from(await response.arrayBuffer());
  } else {
    imageBuffer = imageData;
  }

  const fileSize = imageBuffer.length;
  logger.info(`[Doubao] 开始上传图片: ${fileSize} 字节`);

  // 步骤1: 获取 STS 凭证
  const prepareResult = await prepareUpload(sessionId);
  const { access_key, secret_key, session_token } = prepareResult.upload_auth_token;
  const serviceId = prepareResult.service_id;

  logger.info(`[Doubao] 获取上传凭证成功: service_id=${serviceId}`);

  // 步骤2: 申请上传
  const applyResult = await applyImageUpload(
    serviceId,
    fileSize,
    access_key,
    secret_key,
    session_token
  );

  logger.info(`[Doubao] 申请上传成功: storeUri=${applyResult.storeUri}`);

  // 步骤3: 上传到 TOS
  const crc32 = calculateCRC32(imageBuffer.buffer.slice(
    imageBuffer.byteOffset,
    imageBuffer.byteOffset + imageBuffer.byteLength
  ));
  await uploadToTos(
    applyResult.uploadHost,
    applyResult.storeUri,
    applyResult.auth,
    imageBuffer,
    crc32
  );

  logger.info(`[Doubao] TOS 上传成功`);

  // 步骤4: 提交确认
  await commitImageUpload(
    serviceId,
    applyResult.sessionKey,
    access_key,
    secret_key,
    session_token
  );

  logger.info(`[Doubao] 图片上传完成: ${applyResult.storeUri}`);
  return applyResult.storeUri;
}
