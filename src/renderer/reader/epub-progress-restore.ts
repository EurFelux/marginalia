export function advanceRestoreGate(
  target: number | null,
  _visibleIndex: number,
): { target: number | null; shouldPersist: boolean } {
  if (target == null) return { target: null, shouldPersist: true };
  return { target, shouldPersist: false };
}
