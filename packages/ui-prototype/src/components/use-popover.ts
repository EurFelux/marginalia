import { useEffect, useRef, useState } from "react";

/** 极简 popover：开合状态 + 点击外部关闭。ref 挂在 trigger 的相对定位容器上。 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return { open, setOpen, ref };
}
