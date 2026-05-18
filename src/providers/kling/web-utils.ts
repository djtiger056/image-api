import fs from "fs-extra";
import path from "path";

import _ from "lodash";

export const DEFAULT_KLING_WEB_TARGET_URL = "https://kling.ai/app/image/new";
export const DEFAULT_KLING_WEB_ARTIFACTS_DIR = path.join(path.resolve(), "tmp", "kling-web-provider");
export const DEFAULT_KLING_WEB_LOCAL_STATE_PATH = path.join(path.resolve(), "kling.json");

type SameSite = "Strict" | "Lax" | "None";

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: SameSite;
}

export interface PlaywrightStorageState {
  cookies: PlaywrightCookie[];
  origins: any[];
}

function normalizeSameSite(value: any): SameSite {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "strict") return "Strict";
  if (normalized === "lax") return "Lax";
  return "None";
}

function normalizeCookie(cookie: any, originUrl = DEFAULT_KLING_WEB_TARGET_URL): PlaywrightCookie {
  const origin = new URL(originUrl);
  const domain = cookie.domain || origin.hostname;
  const secure = cookie.secure ?? origin.protocol === "https:";
  const expires = Number.isFinite(cookie.expires)
    ? Number(cookie.expires)
    : Number.isFinite(cookie.expirationDate)
      ? Number(cookie.expirationDate)
      : -1;

  return {
    name: String(cookie.name),
    value: String(cookie.value),
    domain,
    path: cookie.path || "/",
    expires,
    httpOnly: Boolean(cookie.httpOnly),
    secure,
    sameSite: normalizeSameSite(cookie.sameSite),
  };
}

export function normalizeKlingCookiesExport(
  payload: any[],
  originUrl = DEFAULT_KLING_WEB_TARGET_URL
): PlaywrightStorageState {
  if (!Array.isArray(payload)) {
    throw new Error("cookies payload must be an array");
  }
  return {
    cookies: payload.map((cookie) => normalizeCookie(cookie, originUrl)),
    origins: [],
  };
}

function parseInlineStorageState(raw: string): PlaywrightStorageState {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return normalizeKlingCookiesExport(parsed);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("KLING_WEB_STORAGE_STATE_JSON 不是合法 JSON 对象");
  }
  return {
    cookies: Array.isArray(parsed.cookies) ? parsed.cookies : [],
    origins: Array.isArray(parsed.origins) ? parsed.origins : [],
  };
}

function pickFirstDefined(...values: any[]) {
  return values.find((value) => !_.isUndefined(value) && value !== null && value !== "");
}

function parseStorageStateValue(value: any): PlaywrightStorageState {
  if (_.isString(value)) {
    return parseInlineStorageState(value);
  }
  if (Array.isArray(value)) {
    return normalizeKlingCookiesExport(value);
  }
  if (_.isPlainObject(value)) {
    return {
      cookies: Array.isArray((value as any).cookies) ? (value as any).cookies : [],
      origins: Array.isArray((value as any).origins) ? (value as any).origins : [],
    };
  }
  throw new Error("请求里的 storageState 格式不合法");
}

function parseCookiesValue(value: any): PlaywrightStorageState {
  if (_.isString(value)) {
    return normalizeKlingCookiesExport(JSON.parse(value));
  }
  if (Array.isArray(value)) {
    return normalizeKlingCookiesExport(value);
  }
  throw new Error("请求里的 cookies 格式不合法，应为数组或 JSON 字符串");
}

async function tryLoadDefaultLocalKlingState(): Promise<PlaywrightStorageState | null> {
  if (!(await fs.pathExists(DEFAULT_KLING_WEB_LOCAL_STATE_PATH))) {
    return null;
  }
  const raw = await fs.readFile(DEFAULT_KLING_WEB_LOCAL_STATE_PATH, "utf8");
  return parseInlineStorageState(raw);
}

export async function resolveKlingWebStorageState(
  providerOptions?: Record<string, any>
): Promise<PlaywrightStorageState> {
  const inlineProviderState = pickFirstDefined(
    providerOptions?.storage_state,
    providerOptions?.storageState,
    providerOptions?.storage_state_json,
    providerOptions?.storageStateJson,
    providerOptions?.kling_web_storage_state,
    providerOptions?.klingWebStorageState
  );
  if (!_.isUndefined(inlineProviderState)) {
    return parseStorageStateValue(inlineProviderState);
  }

  const inlineProviderCookies = pickFirstDefined(
    providerOptions?.cookies,
    providerOptions?.cookies_json,
    providerOptions?.cookiesJson,
    providerOptions?.kling_web_cookies,
    providerOptions?.klingWebCookies
  );
  if (!_.isUndefined(inlineProviderCookies)) {
    return parseCookiesValue(inlineProviderCookies);
  }

  const inlineState = process.env.KLING_WEB_STORAGE_STATE_JSON;
  if (inlineState) {
    return parseInlineStorageState(inlineState);
  }

  const storageStatePath = process.env.KLING_WEB_STORAGE_STATE_PATH;
  if (storageStatePath) {
    const resolvedPath = path.resolve(storageStatePath);
    const raw = await fs.readFile(resolvedPath, "utf8");
    return parseInlineStorageState(raw);
  }

  const cookiesJsonPath = process.env.KLING_WEB_COOKIES_JSON_PATH;
  if (cookiesJsonPath) {
    const resolvedPath = path.resolve(cookiesJsonPath);
    const raw = await fs.readFile(resolvedPath, "utf8");
    return normalizeKlingCookiesExport(JSON.parse(raw));
  }

  const defaultLocalState = await tryLoadDefaultLocalKlingState();
  if (defaultLocalState) {
    return defaultLocalState;
  }

  throw new Error(
    "Kling 网页模式缺少登录态。请在请求的 provider_options 里传 storage_state/cookies，或设置 KLING_WEB_STORAGE_STATE_JSON、KLING_WEB_STORAGE_STATE_PATH、KLING_WEB_COOKIES_JSON_PATH，或在项目根目录提供 kling.json。"
  );
}


export function resolveKlingTransport(
  providerOptions?: Record<string, any>,
  authorization?: string
): "web" {
  void providerOptions;
  void authorization;
  return "web";
}

export function shouldCaptureKlingWebRequest({
  url,
  method = "GET",
  resourceType = "other",
}: {
  url?: string;
  method?: string;
  resourceType?: string;
}): boolean {
  if (!url) return false;
  if (!["fetch", "xhr"].includes(resourceType)) return false;

  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  const upperMethod = String(method).toUpperCase();

  const analyticsHosts = [
    "google-analytics.com",
    "analytics.google.com",
    "googletagmanager.com",
    "sentry.io",
    "datadoghq.",
    "bytetnsdoc.com",
    "ksurl.cn",
  ];
  if (analyticsHosts.some((pattern) => hostname.includes(pattern))) {
    return false;
  }

  const hostLooksRelevant = ["kling.ai", "klingai.com", "kuaishou.com", "yximgs.com", "127.0.0.1", "localhost"]
    .some((pattern) => hostname.includes(pattern));
  if (!hostLooksRelevant) return false;

  if (upperMethod !== "GET") return true;

  return ["/api/", "/image/", "/images/", "/generate", "/creation", "/task", "/asset", "/works"]
    .some((pattern) => pathname.includes(pattern));
}

export function isLikelyResultImageUrl(value?: string): boolean {
  if (!value || /^data:/i.test(value) || /^blob:/i.test(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  const hostAllowed = ["kling.ai", "klingai.com", "yximgs.com", "kwaistatic.com", "127.0.0.1", "localhost"]
    .some((pattern) => hostname.includes(pattern));
  if (!hostAllowed) return false;

  if (["/assets/", "/static/", "/favicon", "/logo", "/language/"]
    .some((segment) => pathname.includes(segment))) {
    return false;
  }

  if ([
    "user-identity-icon",
    "resources/web_wallpaper",
    "/element/",
    "face_image_crop_image",
    "/kling-website/",
    "/app_ad/",
    "dialog-weekly-exp",
    "/promote/",
    "/banner/",
    "/ad/",
    "/recommend",
    "/feed",
    "/discover",
    "/topic",
    "/explore",
  ].some((segment) => pathname.includes(segment))) {
    return false;
  }

  return /(\.png|\.jpg|\.jpeg|\.webp|\.avif)(\?|$)/.test(pathname) || pathname.includes("/generated/") || pathname.includes("/kimg/");
}

export function normalizeKlingResultImageUrl(value?: string): string {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    parsed.searchParams.delete("x-oss-process");
    return parsed.toString();
  } catch {
    return value;
  }
}

export function dedupeKlingResultImageUrls(values: string[] = []): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeKlingResultImageUrl(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function extractLikelyImageUrlsFromText(text?: string): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s\"'\\]+/g) || [];
  return dedupeKlingResultImageUrls(matches.filter((url) => isLikelyResultImageUrl(url)));
}

export function extractLikelyImageUrlsFromJson(value: any, bucket: Set<string> = new Set()): string[] {
  const addUrl = (url?: string | null) => {
    if (_.isString(url) && isLikelyResultImageUrl(url)) {
      const normalized = normalizeKlingResultImageUrl(url);
      if (normalized) {
        bucket.add(normalized);
      }
    }
  };

  const collectFromWork = (work: any) => {
    if (!work || typeof work !== "object") return;
    addUrl(work?.resource?.resource);
    addUrl(work?.cover?.resource);
    addUrl(work?.firstFrame?.resource);
  };

  const collectFromPayload = (payload: any) => {
    if (!payload || typeof payload !== "object") return;

    addUrl(payload?.resource);
    addUrl(payload?.cover?.resource);
    addUrl(payload?.firstFrame?.resource);

    if (Array.isArray(payload?.coverList)) {
      payload.coverList.forEach((item: any) => addUrl(_.isString(item) ? item : item?.resource));
    }

    if (Array.isArray(payload?.images)) {
      payload.images.forEach((item: any) => addUrl(item?.url || item?.resource));
    }

    if (payload?.task_result) {
      collectFromPayload(payload.task_result);
    }
  };

  if (_.isArray(value)) {
    value.forEach((item) => collectFromPayload(item));
  } else if (_.isPlainObject(value)) {
    collectFromPayload(value);
    collectFromPayload((value as any).data);
    collectFromPayload((value as any).result);
  }

  return [...bucket];
}

export function extractLikelyTaskIds(value: any, bucket: Set<string> = new Set()): string[] {
  if (_.isArray(value)) {
    value.forEach((item) => extractLikelyTaskIds(item, bucket));
    return [...bucket];
  }
  if (_.isPlainObject(value)) {
    Object.entries(value).forEach(([key, nestedValue]) => {
      if (["task_id", "taskId", "id"].includes(key) && _.isString(nestedValue)) {
        bucket.add(nestedValue);
      }
      extractLikelyTaskIds(nestedValue, bucket);
    });
  }
  return [...bucket];
}
