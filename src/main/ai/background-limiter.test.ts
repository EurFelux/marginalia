import { describe, expect, it } from "vitest";
import { Limiter } from "@main/ai/background-limiter";

/** 可手动 resolve 的 deferred，用于精确控制任务完成时机。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Limiter", () => {
  it("runs immediately when below the limit and returns the result", async () => {
    const limiter = new Limiter(() => 2);
    await expect(limiter.run(async () => 42)).resolves.toBe(42);
  });

  it("never exceeds the concurrency limit", async () => {
    const limiter = new Limiter(() => 2);
    let active = 0;
    let peak = 0;
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
    const runs = gates.map((g) =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await g.promise;
        active--;
      }),
    );
    await Promise.resolve(); // 让已放行的任务推进到 await
    expect(active).toBe(2); // 仅 2 个在跑，其余排队
    gates.forEach((g) => g.resolve());
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it("releases a queued task in FIFO order when a slot frees", async () => {
    const limiter = new Limiter(() => 1);
    const order: number[] = [];
    const g1 = deferred<void>();
    const g2 = deferred<void>();
    const g3 = deferred<void>();
    const r1 = limiter.run(async () => {
      order.push(1);
      await g1.promise;
    });
    const r2 = limiter.run(async () => {
      order.push(2);
      await g2.promise;
    });
    const r3 = limiter.run(async () => {
      order.push(3);
      await g3.promise;
    });
    await Promise.resolve();
    expect(order).toEqual([1]); // 只有第一个启动
    g1.resolve();
    await r1;
    expect(order).toEqual([1, 2]); // 第二个（最先入队）接棒
    g2.resolve();
    await r2;
    expect(order).toEqual([1, 2, 3]);
    g3.resolve();
    await r3;
  });

  it("propagates rejection without wedging the queue", async () => {
    const limiter = new Limiter(() => 1);
    const g2 = deferred<void>();
    const r1 = limiter.run(async () => {
      throw new Error("boom");
    });
    let secondRan = false;
    const r2 = limiter.run(async () => {
      secondRan = true;
      await g2.promise;
    });
    await expect(r1).rejects.toThrow("boom");
    await Promise.resolve();
    expect(secondRan).toBe(true); // 失败释放空位，队列继续
    g2.resolve();
    await r2;
  });

  it("honors a raised limit on the next pump", async () => {
    let limit = 1;
    const limiter = new Limiter(() => limit);
    const g1 = deferred<void>();
    let started = 0;
    const r1 = limiter.run(async () => {
      started++;
      await g1.promise;
    });
    void limiter.run(async () => {
      started++;
      await new Promise(() => {}); // 故意永不 settle：模拟长期占用槽位的任务
    });
    await Promise.resolve();
    expect(started).toBe(1);
    limit = 2; // 调大
    g1.resolve();
    await r1; // settle 触发 pump，按新上限放行第二个
    await Promise.resolve();
    expect(started).toBe(2);
  });
});
