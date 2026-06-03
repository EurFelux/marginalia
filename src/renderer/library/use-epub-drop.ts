import { useRef, useState, type DragEvent } from "react";
import { isFilesDrag } from "./epub-drop";

export interface EpubDropHandlers {
  onDragEnter: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: DragEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
}

export interface UseEpubDrop {
  /** 文件拖入窗口（→ 显示 overlay）。 */
  isDragging: boolean;
  /** 指针在投放卡片上（→ 激活样式）。 */
  isOverZone: boolean;
  /** 接到书库根容器：驱动 overlay 显隐 + 暗背景落点取消。 */
  rootHandlers: EpubDropHandlers;
  /** 接到投放卡片：驱动激活 + 命中导入。 */
  zoneHandlers: EpubDropHandlers;
}

/**
 * 书库文件拖拽状态机。
 * - 根节点计数器驱动 overlay 显隐：仅当拖拽负载含外部文件（isFilesDrag）才进入拖拽态。
 * - 卡片计数器驱动激活样式。两套计数器分别治 dragenter/dragleave 因子元素冒泡造成的闪烁。
 * - drop 落卡片 → onFiles(files)；落暗背景（冒泡到根）→ 取消、不导入。
 * - dragover 必须 preventDefault 才允许 drop。
 */
export function useEpubDrop(onFiles: (files: File[]) => void): UseEpubDrop {
  const [isDragging, setDragging] = useState(false);
  const [isOverZone, setOverZone] = useState(false);
  const rootCount = useRef(0);
  const zoneCount = useRef(0);

  const reset = () => {
    rootCount.current = 0;
    zoneCount.current = 0;
    setDragging(false);
    setOverZone(false);
  };

  const rootHandlers: EpubDropHandlers = {
    onDragEnter: (e) => {
      if (!isFilesDrag(e.dataTransfer.types)) return;
      e.preventDefault();
      rootCount.current += 1;
      setDragging(true);
    },
    onDragOver: (e) => {
      if (!isFilesDrag(e.dataTransfer.types)) return;
      e.preventDefault(); // 允许 drop
    },
    onDragLeave: (e) => {
      if (!isFilesDrag(e.dataTransfer.types)) return;
      rootCount.current -= 1;
      if (rootCount.current <= 0) reset();
    },
    onDrop: (e) => {
      e.preventDefault(); // 落暗背景：取消
      reset();
    },
  };

  const zoneHandlers: EpubDropHandlers = {
    onDragEnter: (e) => {
      e.preventDefault();
      zoneCount.current += 1;
      setOverZone(true);
    },
    onDragOver: (e) => {
      e.preventDefault();
    },
    onDragLeave: () => {
      zoneCount.current -= 1;
      if (zoneCount.current <= 0) setOverZone(false);
    },
    onDrop: (e) => {
      e.preventDefault();
      e.stopPropagation(); // 阻止冒泡到 rootHandlers.onDrop（否则会被当成取消）
      const files = Array.from(e.dataTransfer.files); // 必须在任何 await 前同步读取
      reset();
      onFiles(files);
    },
  };

  return { isDragging, isOverZone, rootHandlers, zoneHandlers };
}
