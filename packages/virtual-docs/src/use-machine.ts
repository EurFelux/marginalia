import { useCallback, useEffect, useReducer, useRef } from "react";

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

  // 待办 effects 与打点素材都进 reducer 的返回值，绝不写在 reducer 体内：渲染层启用了
  // StrictMode，React 会双调用 reducer 以暴露不纯实现——体内的副作用会跑两次（effects 入队
  // 两份、日志打两份），而返回值只提交一次。seq 让「同一批 effects」只被排空一次。
  const [committed, dispatch] = useReducer(
    (current: Committed<S, F>, event: E): Committed<S, F> => {
      const { next, effects } = reduce(current.state, event);
      // 空迁移短路：返回同一对象让 React bail out，不重渲、不打点。滚动时高频事件
      // （节流后仍每 120ms 一次）多数是空迁移，不短路会强制重渲并淹掉诊断日志。
      if (next === current.state && effects.length === 0) return current;
      const describe = optionsRef.current?.describeState;
      return {
        state: next,
        effects,
        seq: current.seq + 1,
        record: {
          event: event.type,
          from: describe ? describe(current.state) : "?",
          to: describe ? describe(next) : "?",
          effects: effects.map((e) => e.kind),
        },
      };
    },
    { state: initial, effects: [], seq: 0, record: null },
  );

  useEffect(() => {
    if (committed.record) optionsRef.current?.onTransition?.(committed.record);
    for (const effect of committed.effects) runEffectRef.current(effect);
    // 按 seq 触发：同一次 dispatch 的产物只排空一次，即使前后两批 effects 内容相同。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed.seq]);

  const raise = useCallback((event: E) => dispatch(event), []);
  return [committed.state, raise];
}

interface Committed<S, F> {
  state: S;
  effects: F[];
  seq: number;
  record: TransitionRecord | null;
}
