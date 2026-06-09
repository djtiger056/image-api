import { v4 as uuidv4 } from 'uuid';
import logger from './logger.ts';

// ─── Task 状态定义 ────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';
export type TaskType = 'image' | 'video' | 'composition';

export interface Task {
  id: string;
  status: TaskStatus;
  type: TaskType;
  provider: string;
  model: string;
  prompt: string;
  result?: any;          // generateUnified 的返回值
  error?: string;        // 失败时的错误信息
  createdAt: number;
  completedAt?: number;
}

// ─── 内存存储 ─────────────────────────────────────────

const tasks = new Map<string, Task>();

// 自动清理：30 分钟后移除已完成/失败的任务
const CLEANUP_INTERVAL = 5 * 60 * 1000;  // 5 分钟检查一次
const TASK_TTL = 30 * 60 * 1000;          // 30 分钟过期

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, task] of tasks) {
    if ((task.status === 'completed' || task.status === 'failed') && task.completedAt && (now - task.completedAt > TASK_TTL)) {
      tasks.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.info(`[TaskManager] 清理了 ${cleaned} 个过期任务，当前 ${tasks.size} 个任务`);
  }
}, CLEANUP_INTERVAL);

// ─── 创建任务 ─────────────────────────────────────────

export function createTask(params: {
  type: TaskType;
  provider: string;
  model: string;
  prompt: string;
}): Task {
  const task: Task = {
    id: uuidv4(),
    status: 'pending',
    type: params.type,
    provider: params.provider,
    model: params.model,
    prompt: params.prompt,
    createdAt: Date.now(),
  };
  tasks.set(task.id, task);
  logger.info(`[TaskManager] 创建任务 ${task.id} (${params.type}/${params.provider})`);
  return task;
}

// ─── 更新任务状态 ─────────────────────────────────────

export function updateTaskStatus(id: string, status: 'running'): void;
export function updateTaskStatus(id: string, status: 'completed', result: any): void;
export function updateTaskStatus(id: string, status: 'failed', error: string): void;
export function updateTaskStatus(id: string, status: TaskStatus, data?: any): void {
  const task = tasks.get(id);
  if (!task) return;

  task.status = status;
  if (status === 'completed') {
    task.result = data;
    task.completedAt = Date.now();
    const duration = task.completedAt - task.createdAt;
    logger.info(`[TaskManager] 任务 ${id} 完成 (${duration}ms)`);
  } else if (status === 'failed') {
    task.error = typeof data === 'string' ? data : data?.message || '未知错误';
    task.completedAt = Date.now();
    const duration = task.completedAt - task.createdAt;
    logger.warn(`[TaskManager] 任务 ${id} 失败 (${duration}ms): ${task.error}`);
  } else if (status === 'running') {
    logger.info(`[TaskManager] 任务 ${id} 开始执行`);
  }
}

// ─── 查询任务 ─────────────────────────────────────────

export function getTask(id: string): Task | undefined {
  return tasks.get(id);
}

export function getPendingTaskCount(): number {
  let count = 0;
  for (const task of tasks.values()) {
    if (task.status === 'pending' || task.status === 'running') count++;
  }
  return count;
}

// ─── 导出 ─────────────────────────────────────────────

export default {
  createTask,
  updateTaskStatus,
  getTask,
  getPendingTaskCount,
};
