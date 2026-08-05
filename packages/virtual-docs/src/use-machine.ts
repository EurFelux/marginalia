import { useCallback, useEffect, useRef, useState } from "react";

export interface MachineTransition<S, F> {
  next: S;
  effects: F[];
}

/** 一次迁移的诊断记录；消费方转给自己的 logger（本包不引日志依赖）。 */
export interface TransitionRecord {
  event: string;
  from: string;
  to: string;
  effects: string[];
}

export interface UseMachineOptions<S> {
  /** 把状态压成一行标签用于打点；不传则用 JSON 之外的兜底（见实现）。 */
  describeState?: (state: S) => string;
  onTransition?: (record: TransitionRecord) => void;
}

/**
 * 把「纯 reducer + effect 描述」接进 React：dispatch 是唯一的状态写入口，
 * effects 在提交后按序执行，每次迁移经 onTransition 打点。
 *
 * 本包不过 React Compiler，故内部回调一律手写 useCallback / ref 稳定身份。
 */
export function useMachine<S, E extends { type: string }, F extends { kind: string }>(
  reduce: (state: S, event: E) => MachineTransition<S, F>,
  initial: S,
  runEffect: (effect: F) => void,
  options?: UseMachineOptions<S>,
): [S, (event: E) => void] {
  const runEffectRef = useRef(runEffect);
  runEffectRef.current = runEffect;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // 状态自管而非交给 useReducer：useReducer 在同一 React 批次内会连续调用 reducer，只提交
  // 最后一个结果——中间那次迁移产生的 effects 会被整体丢弃（丢掉一个 startTicker 就足以让
  // 收敛永不开始、Promise 永久悬挂）。raise 同步跑 reducer 并把 effects 累积进队列，
  // 从根本上不受批次语义影响；raise 不是 reducer，也就不受 StrictMode 双调用约束。
  const stateRef = useRef(initial);
  const pending = useRef<F[]>([]);
  const [, forceRender] = useState(0);

  const raise = useCallback((event: E) => {
    const { next, effects } = reduce(stateRef.current, event);
    // 空迁移短路：不重渲、不打点。滚动时高频事件（节流后仍每 120ms 一次）多数是空迁移，
    // 不短路会强制重渲并淹掉诊断日志。
    if (next === stateRef.current && effects.length === 0) return;
    const describe = optionsRef.current?.describeState;
    const record: TransitionRecord = {
      event: event.type,
      from: describe ? describe(stateRef.current) : "?",
      to: describe ? describe(next) : "?",
      effects: effects.map((e) => e.kind),
    };
    stateRef.current = next;
    if (effects.length > 0) pending.current.push(...effects);
    optionsRef.current?.onTransition?.(record);
    forceRender((n) => n + 1);
    // reduce 由消费方在挂载时固定；随渲染变化的量都走 ref。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pending.current.length === 0) return;
    const queue = pending.current;
    pending.current = [];
    for (const effect of queue) runEffectRef.current(effect);
  });

  return [stateRef.current, raise];
}
