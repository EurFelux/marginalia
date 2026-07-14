export interface ReadingClockDeps {
  /** 当前时间（ms）。注入便于测试。 */
  now: () => number;
  /** 落账：把某书一段秒数记到 atMs 所属日期（day 归属由 sink 用 localDayKey 计算）。 */
  commit: (bookId: string, atMs: number, seconds: number) => void;
}

export interface ReadingClock {
  getReadingBook: () => string | null;
  setReadingBook: (bookId: string | null) => void;
  setFocused: (focused: boolean) => void;
  setAwake: (awake: boolean) => void;
  /** 周期 flush（结算并进位）。 */
  tick: () => void;
}

/** 阅读时钟纯状态机：active = 有书 && 聚焦 && 未休眠。 */
export function createReadingClock(deps: ReadingClockDeps): ReadingClock {
  let currentBookId: string | null = null;
  let isFocused = false;
  let isAwake = false;
  let activeSince: number | null = null;

  const isActive = () => currentBookId != null && isFocused && isAwake;

  /** 结算已累计的整秒并进位 activeSince（保留 <1s 余数，防长会话漂移）。 */
  function settle(): void {
    if (activeSince == null || !isActive() || currentBookId == null) return;
    const t = deps.now();
    const seconds = Math.floor((t - activeSince) / 1000);
    if (seconds > 0) {
      deps.commit(currentBookId, t, seconds);
      activeSince += seconds * 1000;
    }
  }

  /** 状态翻转：先按旧状态结算，再切换，再重置活跃段起点。 */
  function transition(mutate: () => void): void {
    settle();
    mutate();
    activeSince = isActive() ? deps.now() : null;
  }

  return {
    getReadingBook: () => currentBookId,
    setReadingBook: (bookId) => {
      if (currentBookId !== bookId) transition(() => (currentBookId = bookId));
    },
    setFocused: (focused) => {
      if (isFocused !== focused) transition(() => (isFocused = focused));
    },
    setAwake: (awake) => {
      if (isAwake !== awake) transition(() => (isAwake = awake));
    },
    tick: () => settle(),
  };
}
