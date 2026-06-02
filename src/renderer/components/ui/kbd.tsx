import type { ComponentProps } from "react";
import { cn } from "@renderer/lib/utils";

/** shadcn 风格的键位标签：展示单个按键（如 ⌘ / Ctrl / Enter）。 */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded-sm border border-border bg-muted px-1 font-sans text-[0.7rem] font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** 多个 Kbd 的容器（横向、统一间距）。 */
export function KbdGroup({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("inline-flex items-center gap-1", className)} {...props} />;
}
