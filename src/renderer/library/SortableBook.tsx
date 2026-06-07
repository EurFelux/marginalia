import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { BookSummaryDto } from "@shared/library";
import { BookCover } from "./BookCover";

/**
 * 可排序书卡（#48 spec §6.2）：useSortable 包 BookCover。listeners 挂 li——
 * PointerSensor 带 distance 8px 激活约束（注入处见 LibraryView），普通点击仍走 onOpen，
 * 且只响应主键，右键 ContextMenu 不受影响。transform/transition 是运行时计算值（内联 style 合规）。
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
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "opacity-40" : undefined}
      {...attributes}
      {...listeners}
    >
      <BookCover book={book} onOpen={onOpen} onDelete={onDelete} onUpdate={onUpdate} />
    </li>
  );
}
