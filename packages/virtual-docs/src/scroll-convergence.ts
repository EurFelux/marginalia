export interface ScrollConvergenceOptions {
  delayMs?: number;
  maxAttempts?: number;
  minimumAttempts?: number;
  successesRequired?: number;
  onSuccess?: () => void;
}

/** Run a bounded series of delayed alignment attempts and return an idempotent cancel function. */
export function startScrollConvergence(
  attempt: () => boolean,
  onTimeout: () => void,
  options: ScrollConvergenceOptions = {},
): () => void {
  const delayMs = options.delayMs ?? 100;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 80);
  const minimumAttempts = Math.min(maxAttempts, Math.max(1, options.minimumAttempts ?? 1));
  const successesRequired = Math.max(1, options.successesRequired ?? 1);
  let attempts = 0;
  let successStreak = 0;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = () => {
    timer = null;
    if (cancelled) return;

    attempts += 1;
    successStreak = attempt() ? successStreak + 1 : 0;
    if (attempts >= minimumAttempts && successStreak >= successesRequired) {
      options.onSuccess?.();
      return;
    }
    if (attempts >= maxAttempts) {
      onTimeout();
      return;
    }
    timer = setTimeout(tick, delayMs);
  };

  timer = setTimeout(tick, delayMs);
  return () => {
    if (cancelled) return;
    cancelled = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
