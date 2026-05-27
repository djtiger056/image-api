import crypto from "crypto";
import path from "path";

import fs from "fs-extra";
import { AxiosResponse } from "axios";

import logger from "@/lib/logger.ts";

export interface QwenCookieRecord {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

interface QwenState {
  cookies: QwenCookieRecord[];
  browserId?: string;
  updatedAt?: string;
}

export interface QwenSession {
  key: string;
  source?: "state" | "env" | "authorization";
  cookieHeader: string;
  browserId: string;
  canPersist: boolean;
}

const ROOT_DIR = path.resolve();
const DEFAULT_STATE_PATH = path.join(ROOT_DIR, "qwen.json");
const QWEN_STATE_PATH = String(process.env.QWEN_COOKIE_STATE_PATH || DEFAULT_STATE_PATH);
const QWEN_COOKIE_DOMAIN = ".qianwen.com";

let loadedState: QwenState | null | undefined;
let writeQueue: Promise<void> = Promise.resolve();
const envBrowserIds = new Map<string, string>();

function nowIso() {
  return new Date().toISOString();
}

function getStatePath() {
  return QWEN_STATE_PATH;
}

function hashCookieHeader(cookieHeader: string): string {
  return crypto.createHash("sha256").update(cookieHeader).digest("hex").slice(0, 16);
}

function generateBrowserId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function pickCookieCredential(raw: string): string {
  const parts = String(raw || "")
    .replace(/^Bearer\s+/i, "")
    .split("|||")
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length === 0) return "";
  return parts[Math.floor(Math.random() * parts.length)];
}

function normalizeCookieRecord(item: any): QwenCookieRecord | null {
  if (!item || !item.name) return null;
  const name = String(item.name).trim();
  if (!name) return null;
  return {
    name,
    value: String(item.value ?? ""),
    ...(item.domain ? { domain: String(item.domain) } : {}),
    ...(item.path ? { path: String(item.path) } : { path: "/" }),
    ...(typeof item.expires === "number" ? { expires: item.expires } : {}),
    ...(typeof item.httpOnly === "boolean" ? { httpOnly: item.httpOnly } : {}),
    ...(typeof item.secure === "boolean" ? { secure: item.secure } : {}),
    ...(item.sameSite ? { sameSite: String(item.sameSite) } : {}),
  };
}

export function parseCookieString(cookieHeader: string): QwenCookieRecord[] {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part): QwenCookieRecord | null => {
      const eq = part.indexOf("=");
      if (eq <= 0) return null;
      const name = part.slice(0, eq).trim();
      if (!name) return null;
      return {
        name,
        value: part.slice(eq + 1).trim(),
        domain: QWEN_COOKIE_DOMAIN,
        path: "/",
      };
    })
    .filter((item): item is QwenCookieRecord => Boolean(item));
}

function parseCookieInput(raw: string): QwenCookieRecord[] {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map(normalizeCookieRecord)
          .filter((item): item is QwenCookieRecord => Boolean(item));
      }
    } catch {}
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed?.cookies)) {
        return parsed.cookies
          .map(normalizeCookieRecord)
          .filter((item): item is QwenCookieRecord => Boolean(item));
      }
    } catch {}
  }

  return parseCookieString(trimmed);
}

export function cookieRecordsToHeader(cookies: QwenCookieRecord[]): string {
  const nowSeconds = Date.now() / 1000;
  const map = new Map<string, QwenCookieRecord>();

  for (const cookie of cookies) {
    const normalized = normalizeCookieRecord(cookie);
    if (!normalized) continue;
    if (typeof normalized.expires === "number" && normalized.expires > 0 && normalized.expires < nowSeconds) {
      map.delete(normalized.name);
      continue;
    }
    map.set(normalized.name, normalized);
  }

  return Array.from(map.values())
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
}

async function loadState(): Promise<QwenState | null> {
  if (loadedState !== undefined) return loadedState;

  const statePath = getStatePath();
  try {
    if (!(await fs.pathExists(statePath))) {
      loadedState = null;
      return loadedState;
    }

    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (Array.isArray(parsed)) {
      loadedState = {
        cookies: parsed
          .map(normalizeCookieRecord)
          .filter((item): item is QwenCookieRecord => Boolean(item)),
      };
    } else {
      loadedState = {
        cookies: Array.isArray(parsed?.cookies)
          ? parsed.cookies
              .map(normalizeCookieRecord)
              .filter((item): item is QwenCookieRecord => Boolean(item))
          : [],
        ...(parsed?.browserId ? { browserId: String(parsed.browserId) } : {}),
        ...(parsed?.updatedAt ? { updatedAt: String(parsed.updatedAt) } : {}),
      };
    }
    return loadedState;
  } catch (error: any) {
    logger.warn(`[QwenSession] 读取 ${statePath} 失败: ${error.message}`);
    loadedState = null;
    return loadedState;
  }
}

async function persistState(state: QwenState): Promise<void> {
  loadedState = state;
  const statePath = getStatePath();
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    await fs.writeJson(statePath, { ...state, updatedAt: nowIso() }, { spaces: 2 });
  });
  await writeQueue;
}

function mergeCookies(base: QwenCookieRecord[], updates: QwenCookieRecord[]): QwenCookieRecord[] {
  const map = new Map<string, QwenCookieRecord>();
  for (const item of base) {
    const normalized = normalizeCookieRecord(item);
    if (normalized) map.set(normalized.name, normalized);
  }
  for (const item of updates) {
    const normalized = normalizeCookieRecord(item);
    if (!normalized) continue;
    if (normalized.value === "") {
      map.delete(normalized.name);
    } else {
      map.set(normalized.name, {
        ...map.get(normalized.name),
        ...normalized,
      });
    }
  }
  return Array.from(map.values());
}

function parseSetCookieHeaders(setCookie?: string[] | string): QwenCookieRecord[] {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const updates: QwenCookieRecord[] = [];

  for (const header of headers) {
    const parts = String(header || "").split(";").map((part) => part.trim()).filter(Boolean);
    const first = parts.shift();
    if (!first) continue;
    const eq = first.indexOf("=");
    if (eq <= 0) continue;

    const record: QwenCookieRecord = {
      name: first.slice(0, eq),
      value: first.slice(eq + 1),
      domain: QWEN_COOKIE_DOMAIN,
      path: "/",
    };

    for (const attr of parts) {
      const attrEq = attr.indexOf("=");
      const key = (attrEq >= 0 ? attr.slice(0, attrEq) : attr).trim().toLowerCase();
      const value = attrEq >= 0 ? attr.slice(attrEq + 1).trim() : "";
      if (key === "domain" && value) record.domain = value;
      else if (key === "path" && value) record.path = value;
      else if (key === "expires" && value) {
        const ts = Date.parse(value);
        if (!Number.isNaN(ts)) record.expires = Math.floor(ts / 1000);
      } else if (key === "max-age" && value) {
        const seconds = Number(value);
        if (Number.isFinite(seconds)) record.expires = Math.floor(Date.now() / 1000 + seconds);
      } else if (key === "httponly") record.httpOnly = true;
      else if (key === "secure") record.secure = true;
      else if (key === "samesite" && value) record.sameSite = value;
    }

    updates.push(record);
  }

  return updates;
}

function ensureBrowserId(sessionKey: string): string {
  const existing = envBrowserIds.get(sessionKey);
  if (existing) return existing;
  const browserId = generateBrowserId();
  envBrowserIds.set(sessionKey, browserId);
  return browserId;
}

export function createQwenSessionFromCookie(
  rawCookie: string,
  options: { source: QwenSession["source"]; canPersist?: boolean; key?: string; browserId?: string }
): QwenSession {
  const incoming = pickCookieCredential(rawCookie);
  if (!incoming) throw new Error("千问 Cookie 为空");
  const cookieHeader = cookieRecordsToHeader(parseCookieInput(incoming));
  const key = options.key || hashCookieHeader(cookieHeader || incoming);
  return {
    key,
    source: options.source,
    cookieHeader: cookieHeader || incoming,
    browserId: options.browserId || ensureBrowserId(key),
    canPersist: Boolean(options.canPersist),
  };
}

export async function resolveQwenSession(credential?: string): Promise<QwenSession> {
  const incoming = pickCookieCredential(String(credential || ""));
  if (incoming) {
    return createQwenSessionFromCookie(incoming, { source: "authorization", canPersist: false });
  }

  const state = await loadState();
  const stateCookieHeader = cookieRecordsToHeader(state?.cookies || []);
  if (stateCookieHeader) {
    const browserId = state?.browserId || generateBrowserId();
    if (!state?.browserId) {
      await persistState({ cookies: state?.cookies || [], browserId });
    }
    return {
      key: "qwen-state",
      source: "state",
      cookieHeader: stateCookieHeader,
      browserId,
      canPersist: true,
    };
  }

  const envCookie = String(process.env.QWEN_COOKIE || "").trim();
  if (envCookie) {
    return createQwenSessionFromCookie(envCookie, {
      source: "env",
      key: "qwen-env",
      browserId: ensureBrowserId("qwen-env"),
      canPersist: true,
    });
  }

  throw new Error("千问服务未配置可用凭证。请设置 QWEN_COOKIE 或 qwen.json。");
}

export async function saveQwenCookieToState(rawCookie: string): Promise<void> {
  const cookies = parseCookieInput(pickCookieCredential(rawCookie));
  if (cookies.length === 0) return;
  const current = await loadState();
  await persistState({
    cookies: mergeCookies(current?.cookies || [], cookies),
    browserId: current?.browserId || generateBrowserId(),
  });
}

export async function absorbQwenSetCookie(session: QwenSession, response?: AxiosResponse<any>): Promise<void> {
  if (!session.canPersist || !response) return;
  const updates = parseSetCookieHeaders(response.headers?.["set-cookie"]);
  if (updates.length === 0) return;

  const current = await loadState();
  const baseCookies = current?.cookies?.length
    ? current.cookies
    : parseCookieInput(session.cookieHeader);
  const nextCookies = mergeCookies(baseCookies, updates);
  await persistState({
    cookies: nextCookies,
    browserId: current?.browserId || session.browserId,
  });
  process.env.QWEN_COOKIE = cookieRecordsToHeader(nextCookies);
  logger.info(`[QwenSession] 已更新 ${updates.length} 个 cookie 到 ${getStatePath()}`);
}

export function getQwenStatePath(): string {
  return getStatePath();
}
