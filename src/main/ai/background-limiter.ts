// src/main/ai/background-limiter.ts

/** 包后台任务执行的注入端口：受全局并发上限约束地跑 fn，返回其结果（或透传其 reject）。 */
export type RunBackground = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * 全局并发限流器：同时放行的任务数不超过 getLimit() 返回值，超出的排队（FIFO），有空位再放行。
 * 纯类，无 Electron/DB 依赖，可独立单测。getLimit 每次放行时实时读取——调小立即对「新启动」生效，
 * 调大在下一次 run/settle 触发 pump 时生效（绝不杀正在跑的任务）。
 */
export class Limiter {
  constructor(private readonly getLimit: () => number) {}

  private active = 0;
  private readonly queue: Array<() => void> = [];

  // 箭头函数字段（非方法）：使 this 绑定到实例，调用方可直接把 `limiter.run` 当值传递/注入而不丢 this。
  run: RunBackground = (fn) =>
    new Promise((resolve, reject) => {
      const attempt = () => {
        this.active++;
        fn().then(
          (value) => {
            this.active--;
            this.pump();
            resolve(value);
          },
          (err: unknown) => {
            this.active--;
            this.pump();
            reject(err);
          },
        );
      };
      if (this.active < this.getLimit()) attempt();
      else this.queue.push(attempt);
    });

  private pump(): void {
    while (this.queue.length > 0 && this.active < this.getLimit()) this.queue.shift()!();
  }
}

export type SlotAcquisition = { ok: true; release: () => void } | { ok: false };

/**
 * 占一个后台槽位并保持占用直到 release()，超时未排到则放弃。
 * 用于「拿不到并发额度就降级」而非无限排队的调用方：占位任务体只是等 release，
 * 故超时分支同样调 release —— 该占位若稍后才被调度，会立即结束而不真正消耗额度。
 */
export function acquireSlot(run: RunBackground, timeoutMs: number): Promise<SlotAcquisition> {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let granted = () => {};
  const grant = new Promise<void>((resolve) => {
    granted = resolve;
  });
  void run(async () => {
    granted();
    await held;
  }).catch(() => {});

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      release();
      resolve({ ok: false });
    }, timeoutMs);
    void grant.then(() => {
      clearTimeout(timer);
      resolve({ ok: true, release });
    });
  });
}
