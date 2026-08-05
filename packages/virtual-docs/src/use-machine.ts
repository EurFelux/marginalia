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
  const pending = useRef<F[]>([]);
  const runEffectRef = useRef(runEffect);
  runEffectRef.current = runEffect;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [state, dispatch] = useReducer((current: S, event: E): S => {
    const { next, effects } = reduce(current, event);
    if (effects.length > 0) pending.current.push(...effects);
    const describe = optionsRef.current?.describeState;
    optionsRef.current?.onTransition?.({
      event: event.type,
      from: describe ? describe(current) : "?",
      to: describe ? describe(next) : "?",
      effects: effects.map((e) => e.kind),
    });
    return next;
  }, initial);

  useEffect(() => {
    if (pending.current.length === 0) return;
    const queue = pending.current;
    pending.current = [];
    for (const effect of queue) runEffectRef.current(effect);
  });

  const raise = useCallback((event: E) => dispatch(event), []);
  return [state, raise];
}
