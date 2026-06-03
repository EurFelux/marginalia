"use client";

import * as React from "react";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

import { cn } from "@renderer/lib/utils";

function ScrollArea({
  className,
  viewportClassName,
  viewportRef,
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  /** 透传给 Viewport（滚动元素）。max-height 等限高场景传这里（如 `max-h-40`）。 */
  viewportClassName?: string;
  /** 透传给 Viewport DOM 的 ref，供程序化滚动（如 AIPanel 滚底）。 */
  viewportRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn("size-full", viewportClassName)}
      >
        <ScrollAreaPrimitive.Content>{children}</ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        // macOS 式：滚动时（data-scrolling 瞬现）或指针移到滚动条轨道（hover 条本身、非整区）时显示，停手/移开后经 duration-300 渐隐；不认整区 data-hovering。
        "z-10 flex touch-none select-none opacity-0 transition-opacity duration-300 hover:opacity-100 data-[scrolling]:opacity-100 data-[scrolling]:duration-0",
        orientation === "vertical" && "h-full w-2.5 justify-center",
        orientation === "horizontal" && "h-2.5 w-full flex-col items-center",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className={cn(
          "rounded-full bg-foreground/35",
          orientation === "vertical" ? "w-1.5" : "h-1.5",
        )}
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
