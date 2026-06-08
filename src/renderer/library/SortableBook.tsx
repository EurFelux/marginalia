import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { BookSummaryDto } from "@shared/library";
import { useDragGuard } from "@renderer/lib/use-drag-guard";
import { BookCover } from "./BookCover";

/**
 * 可排序书卡（#48 spec §6.2）：useSortable 包 BookCover。listeners 挂 li——
 * PointerSensor 带 distance 8px 激活约束（注入处见 LibraryView），普通点击仍走 onOpen，
 * 且只响应主键，右键 ContextMenu 不受影响。transform/transition 是运行时计算值（内联 style 合规）。
 *
 * listeners 经 useDragGuard 包一层：BookCover 的编辑/删除 dialog 经 React Portal 渲染，在
 * React 树里是本 li 的后代、事件会冒泡回来——守卫按 DOM 归属拦下「在 dialog 里拖拽误触发书籍
 * 拖拽」，同时不阉割浮层自身的事件上浮（见 use-drag-guard）。
 */
export function SortableBook({
  book,
  onOpen,
  onDelete,
  onUpdate,
}: {
  book: BookSummaryDto;
  onOpen: () => void;
  onDelete: () => void;
  onUpdate: (patch: { title: string; author: string | null }) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: book.id,
  });
  const guard = useDragGuard(setNodeRef, listeners);
  return (
    <li
      ref={guard.setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "opacity-40" : undefined}
      {...attributes}
      {...guard.listeners}
    >
      <BookCover book={book} onOpen={onOpen} onDelete={onDelete} onUpdate={onUpdate} />
    </li>
  );
}
