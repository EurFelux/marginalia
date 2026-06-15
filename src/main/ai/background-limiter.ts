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
