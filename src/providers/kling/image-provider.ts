import path from "path";

import fs from "fs-extra";
import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import klingWebAutomation from "@/providers/kling/web-automation.ts";
import ImageProvider, {
  ImageProviderContext,
  UnifiedImageGenerateInput,
  UnifiedImageGenerateOutput,
} from "@/providers/types.ts";
import {
  DEFAULT_KLING_MODEL,
  isKlingModelName,
  mapUnifiedToKlingGenerationBody,
} from "@/providers/kling/mapper.ts";
import {
  DEFAULT_KLING_WEB_ARTIFACTS_DIR,
} from "@/providers/kling/web-utils.ts";

type WebTaskRecord = {
  taskId: string;
  createdAt: number;
  updatedAt: number;
  status: "queued" | "submitted" | "processing" | "succeed" | "failed";
  message?: string;
  imageUrls?: string[];
  error?: string;
  pageUrl?: string;
  observedTaskIds?: string[];
  queuePosition?: number;
};

type PendingWebExecution = {
  taskId?: string;
  createdAt: number;
  input: UnifiedImageGenerateInput;
  mode: "async" | "sync";
  resolve?: (task: WebTaskRecord) => void;
  reject?: (error: Error) => void;
};

function getPollIntervalMs(): number {
  const value = Number(process.env.KLING_POLL_INTERVAL_MS || 1500);
  return Number.isFinite(value) && value > 0 ? value : 1500;
}

function getPollTimeoutMs(): number {
  const value = Number(process.env.KLING_POLL_TIMEOUT_MS || 180000);
  return Number.isFinite(value) && value > 0 ? value : 180000;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getWebTasksStatePath(): string {
  return process.env.KLING_WEB_TASKS_STATE_PATH || path.join(DEFAULT_KLING_WEB_ARTIFACTS_DIR, "tasks.json");
}

function getMaxConcurrentWebTasks(): number {
  const value = Number(process.env.KLING_WEB_MAX_CONCURRENT_TASKS || 1);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function getFailureAlertsPath(): string {
  return process.env.KLING_WEB_FAILURE_ALERTS_PATH || path.join(DEFAULT_KLING_WEB_ARTIFACTS_DIR, "alerts.jsonl");
}

function getFailureAlertWebhookUrl(): string {
  return process.env.KLING_WEB_FAILURE_ALERT_WEBHOOK_URL || "";
}

export default class KlingImageProvider implements ImageProvider {
  name = "kling";
  private webTasks: Map<string, WebTaskRecord> = new Map();
  private webTasksLoaded = false;
  private webTasksLoadPromise: Promise<void> | null = null;
  private webTasksPersistQueue: Promise<void> = Promise.resolve();
  private activeWebExecutions = 0;
  private pendingWebExecutions: PendingWebExecution[] = [];

  private async ensureWebTasksLoaded() {
    if (this.webTasksLoaded) return;
    if (this.webTasksLoadPromise) {
      await this.webTasksLoadPromise;
      return;
    }

    this.webTasksLoadPromise = (async () => {
      const statePath = getWebTasksStatePath();
      if (!(await fs.pathExists(statePath))) {
        this.webTasksLoaded = true;
        return;
      }

      try {
        const raw = await fs.readFile(statePath, "utf8");
        const parsed = JSON.parse(raw);
        const tasks = Array.isArray(parsed) ? parsed : parsed?.tasks;
        if (Array.isArray(tasks)) {
          const now = util.unixTimestamp();
          let shouldRewrite = false;
          this.webTasks = new Map(
            tasks
              .filter((task) => task?.taskId)
              .map((task) => {
                if (["queued", "processing", "submitted"].includes(task.status)) {
                  shouldRewrite = true;
                  return [task.taskId, {
                    ...task,
                    updatedAt: now,
                    status: "failed",
                    error: task.error || "服务已重启，未完成的网页任务已终止，请重新提交。",
                    message: task.message || "服务已重启，未完成的网页任务已终止，请重新提交。",
                    queuePosition: undefined,
                  } as WebTaskRecord];
                }
                return [task.taskId, task as WebTaskRecord];
              })
          );
          if (shouldRewrite) {
            await this.persistWebTasks();
          }
        }
      } catch (err) {
        logger.warn(`读取 Kling web task 持久化文件失败: ${statePath} - ${(err as Error).message}`);
      }

      this.webTasksLoaded = true;
    })();

    try {
      await this.webTasksLoadPromise;
    } finally {
      this.webTasksLoadPromise = null;
    }
  }

  private async persistWebTasks() {
    const statePath = getWebTasksStatePath();
    await fs.ensureDir(path.dirname(statePath));
    await fs.writeJson(statePath, [...this.webTasks.values()], { spaces: 2 });
  }

  private async waitForWebTasksPersisted() {
    await this.webTasksPersistQueue.catch(() => null);
  }

  private async upsertWebTask(task: WebTaskRecord) {
    await this.ensureWebTasksLoaded();
    this.webTasks.set(task.taskId, task);
    this.webTasksPersistQueue = this.webTasksPersistQueue
      .catch(() => null)
      .then(() => this.persistWebTasks());
    await this.webTasksPersistQueue;
  }

  private async refreshQueuedTaskPositions() {
    let queuePosition = 0;
    for (const execution of this.pendingWebExecutions) {
      if (!execution.taskId) continue;
      queuePosition += 1;
      const current = this.webTasks.get(execution.taskId);
      if (!current) continue;
      this.webTasks.set(execution.taskId, {
        ...current,
        status: "queued",
        updatedAt: util.unixTimestamp(),
        message: `Kling 网页任务排队中，队列位置: ${queuePosition}`,
        queuePosition,
      });
    }
    await this.persistWebTasks();
  }

  private async emitFailureAlert(task: WebTaskRecord, input: UnifiedImageGenerateInput, error: Error) {
    const alert = {
      taskId: task.taskId,
      prompt: input.prompt,
      provider: this.name,
      transport: "web",
      error: error.message,
      pageUrl: task.pageUrl,
      targetUrl: input.providerOptions?.target_url || input.providerOptions?.targetUrl || process.env.KLING_WEB_TARGET_URL,
      occurredAt: new Date().toISOString(),
    };

    const alertsPath = getFailureAlertsPath();
    await fs.ensureDir(path.dirname(alertsPath));
    await fs.appendFile(alertsPath, `${JSON.stringify(alert)}\n`);

    const webhookUrl = getFailureAlertWebhookUrl();
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(alert),
        });
      } catch (webhookError) {
        logger.error(`Kling web failure alert webhook failed: ${(webhookError as Error).message}`);
      }
    }
  }

  private async finalizeWebExecution() {
    this.activeWebExecutions = Math.max(0, this.activeWebExecutions - 1);
    const next = this.pendingWebExecutions.shift();
    await this.refreshQueuedTaskPositions();
    if (!next) return;
    this.activeWebExecutions += 1;
    void this.executeWebExecution(next);
  }

  private async executeWebExecution(execution: PendingWebExecution) {
    const startedAt = Date.now();
    if (execution.taskId) {
      await this.upsertWebTask({
        taskId: execution.taskId,
        createdAt: execution.createdAt,
        updatedAt: util.unixTimestamp(),
        status: "processing",
        message: "Kling 网页任务执行中。",
        queuePosition: undefined,
      });
      logger.info(`Kling web task started: ${execution.taskId}`);
    }

    try {
      const result = await klingWebAutomation.generate(execution.input);
      const task: WebTaskRecord = {
        taskId: execution.taskId || result.taskId,
        createdAt: execution.createdAt,
        updatedAt: util.unixTimestamp(),
        status: "succeed",
        imageUrls: result.imageUrls,
        pageUrl: result.pageUrl,
        observedTaskIds: result.observedTaskIds,
        message: `ok (${Date.now() - startedAt}ms)`,
      };
      if (execution.taskId) {
        await this.upsertWebTask(task);
      }
      logger.info(`Kling web task succeed: ${task.taskId} images=${task.imageUrls?.length || 0} duration_ms=${Date.now() - startedAt}`);
      execution.resolve?.(task);
    } catch (err) {
      const error = err as Error;
      const failedTask: WebTaskRecord = {
        taskId: execution.taskId || `kling-web-${util.uuid(false)}`,
        createdAt: execution.createdAt,
        updatedAt: util.unixTimestamp(),
        status: "failed",
        error: error.message,
        message: error.message,
      };
      if (execution.taskId) {
        const existing = this.webTasks.get(execution.taskId);
        await this.upsertWebTask({
          ...failedTask,
          pageUrl: existing?.pageUrl,
          observedTaskIds: existing?.observedTaskIds,
        });
        await this.emitFailureAlert({ ...failedTask, pageUrl: existing?.pageUrl, observedTaskIds: existing?.observedTaskIds }, execution.input, error);
      }
      logger.error(`Kling web task failed: ${execution.taskId || 'sync'} duration_ms=${Date.now() - startedAt}`, error);
      execution.reject?.(error);
    } finally {
      await this.finalizeWebExecution();
    }
  }

  private async scheduleWebExecution(execution: PendingWebExecution) {
    if (this.activeWebExecutions < getMaxConcurrentWebTasks()) {
      this.activeWebExecutions += 1;
      void this.executeWebExecution(execution);
      return;
    }
    this.pendingWebExecutions.push(execution);
    await this.refreshQueuedTaskPositions();
  }

  private async runSyncWebGeneration(input: UnifiedImageGenerateInput): Promise<WebTaskRecord> {
    return new Promise<WebTaskRecord>((resolve, reject) => {
      void this.scheduleWebExecution({
        createdAt: util.unixTimestamp(),
        input,
        mode: "sync",
        resolve,
        reject,
      });
    });
  }

  supportsModel(model?: string): boolean {
    return isKlingModelName(model || DEFAULT_KLING_MODEL);
  }

  private isWebMode(providerOptions: Record<string, any> | undefined, context: ImageProviderContext) {
    void providerOptions;
    void context;
    return true;
  }

  private buildWebTaskResponse(task: WebTaskRecord) {
    return {
      code: 0,
      message: task.error || task.message || "ok",
      data: {
        task_id: task.taskId,
        task_status: task.status,
        task_status_msg: task.error || task.message,
        task_result: task.imageUrls?.length
          ? {
              images: task.imageUrls.map((url, index) => ({ index, url })),
            }
          : undefined,
        created_at: task.createdAt,
        updated_at: task.updatedAt,
        page_url: task.pageUrl,
        observed_task_ids: task.observedTaskIds,
        queue_position: task.queuePosition,
      },
    };
  }

  private async runWebGeneration(input: UnifiedImageGenerateInput): Promise<WebTaskRecord> {
    const result = await klingWebAutomation.generate(input);
    return {
      taskId: result.taskId,
      createdAt: util.unixTimestamp(),
      updatedAt: util.unixTimestamp(),
      status: "succeed",
      imageUrls: result.imageUrls,
      pageUrl: result.pageUrl,
      observedTaskIds: result.observedTaskIds,
      message: "ok",
    };
  }

  private async startWebTask(input: UnifiedImageGenerateInput): Promise<WebTaskRecord> {
    await this.ensureWebTasksLoaded();
    const taskId = `kling-web-${util.uuid(false)}`;
    const now = util.unixTimestamp();
    const immediate = this.activeWebExecutions < getMaxConcurrentWebTasks();
    const record: WebTaskRecord = {
      taskId,
      createdAt: now,
      updatedAt: now,
      status: immediate ? "processing" : "queued",
      message: immediate ? "Kling 网页任务执行中。" : "Kling 网页任务排队中。",
      queuePosition: immediate ? undefined : this.pendingWebExecutions.length + 1,
    };
    await this.upsertWebTask(record);
    await this.scheduleWebExecution({
      taskId,
      createdAt: now,
      input,
      mode: "async",
    });
    return this.webTasks.get(taskId) || record;
  }

  private nativeBodyToUnifiedInput(body: any): UnifiedImageGenerateInput {
    return {
      model: body.model_name || body.model || DEFAULT_KLING_MODEL,
      prompt: body.prompt,
      images: body.image ? [body.image] : undefined,
      negativePrompt: body.negative_prompt,
      ratio: body.aspect_ratio,
      resolution: body.resolution,
      responseFormat: body.response_format,
      async: body.async,
      n: body.n,
      providerOptions: {
        ...(body.provider_options || {}),
        transport: "web",
      },
    };
  }

  private async generateViaWeb(
    input: UnifiedImageGenerateInput
  ): Promise<UnifiedImageGenerateOutput> {
    if (input.async) {
      const task = await this.startWebTask(input);
      return {
        created: util.unixTimestamp(),
        provider: this.name,
        transport: "web",
        task_id: task.taskId,
        status: task.status,
        message: task.message,
        queue_position: task.queuePosition,
      };
    }

    const task = await this.runSyncWebGeneration(input);
    const responseFormat = input.responseFormat || "url";
    const imageUrls = task.imageUrls || [];

    if (responseFormat === "b64_json") {
      const data = await Promise.all(imageUrls.map((url) => util.fetchFileBASE64(url)));
      return {
        created: util.unixTimestamp(),
        provider: this.name,
        transport: "web",
        task_id: task.taskId,
        status: task.status,
        page_url: task.pageUrl,
        observed_task_ids: task.observedTaskIds,
        data: data.map((b64) => ({ b64_json: b64 })),
      };
    }

    return {
      created: util.unixTimestamp(),
      provider: this.name,
      transport: "web",
      task_id: task.taskId,
      status: task.status,
      page_url: task.pageUrl,
      observed_task_ids: task.observedTaskIds,
      data: imageUrls.map((url) => ({ url })),
    };
  }

  async createNativeGeneration(body: any, context: ImageProviderContext) {
    void context;
    return this.generateViaWeb(this.nativeBodyToUnifiedInput(body));
  }

  async getNativeGeneration(id: string, context: ImageProviderContext) {
    await this.ensureWebTasksLoaded();
    const webTask = this.webTasks.get(id);
    if (!webTask) {
      throw new Error(`Kling 网页任务不存在: ${id}`);
    }
    if (["succeed", "failed"].includes(webTask.status)) {
      await this.waitForWebTasksPersisted();
      return this.buildWebTaskResponse(this.webTasks.get(id) || webTask);
    }
    return this.buildWebTaskResponse(webTask);
  }

  async listNativeGenerations(query: Record<string, any>, context: ImageProviderContext) {
    void query;
    void context;
    await this.ensureWebTasksLoaded();
    return {
      code: 0,
      message: "ok",
      data: [...this.webTasks.values()].map((task) => this.buildWebTaskResponse(task).data),
    };
  }

  async createNativeMultiImageToImage(body: any, context: ImageProviderContext) {
    void body;
    void context;
    throw new Error("Kling 官方 API 已移除，当前仅支持网页模式。多图转图暂不提供。");
  }

  async getNativeMultiImageToImage(id: string, context: ImageProviderContext) {
    void id;
    void context;
    throw new Error("Kling 官方 API 已移除，当前仅支持网页模式。多图转图暂不提供查询。");
  }

  private async pollUntilCompleted(taskId: string, context: ImageProviderContext) {
    const startedAt = Date.now();
    const timeoutMs = getPollTimeoutMs();
    const intervalMs = getPollIntervalMs();

    while (Date.now() - startedAt < timeoutMs) {
      const result = await this.getNativeGeneration(taskId, context);
      const status = result?.data?.task_status;
      if (status === "succeed") {
        return result;
      }
      if (status === "failed") {
        throw new Error(
          result?.data?.task_status_msg || result?.message || "Kling 图片任务失败"
        );
      }
      await sleep(intervalMs);
    }

    logger.warn(`Kling 图片任务轮询超时: ${taskId}`);
    return null;
  }

  async generateUnified(
    input: UnifiedImageGenerateInput,
    context: ImageProviderContext
  ): Promise<UnifiedImageGenerateOutput> {
    if (this.isWebMode(input.providerOptions, context)) {
      return this.generateViaWeb(input);
    }

    const createResponse = await this.createNativeGeneration(
      mapUnifiedToKlingGenerationBody(input),
      context
    );
    const taskId = createResponse?.task_id;
    const taskStatus = createResponse?.status;

    if (!taskId) {
      throw new Error("Kling 创建任务成功但未返回 task_id");
    }

    if (input.async) {
      return {
        created: util.unixTimestamp(),
        provider: this.name,
        task_id: taskId,
        status: taskStatus || "submitted",
        message: "Kling 图片任务已提交，可继续查询 /v1/images/generations/:id",
      };
    }

    const completed = await this.pollUntilCompleted(taskId, context);
    if (!completed) {
      return {
        created: util.unixTimestamp(),
        provider: this.name,
        task_id: taskId,
        status: "processing",
        message: "Kling 图片任务仍在处理中，请稍后调用 GET /v1/images/generations/:id 查询。",
      };
    }

    const images = completed?.data?.task_result?.images || [];
    const responseFormat = input.responseFormat || "url";
    const data = responseFormat === "b64_json"
      ? (await Promise.all(images.map((item: any) => util.fetchFileBASE64(item.url)))).map((b64) => ({ b64_json: b64 }))
      : images.map((item: any) => ({ url: item.url }));

    return {
      created: util.unixTimestamp(),
      provider: this.name,
      data,
      task_id: taskId,
      status: completed?.data?.task_status,
    };
  }
}
