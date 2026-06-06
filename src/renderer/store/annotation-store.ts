import { create } from "zustand";
import type { SelectionInfo } from "@renderer/types";

export type AnnoTarget = { type: "create" } | { type: "edit"; annotationId: string };
export interface StyleBarState {
  rect: { x: number; y: number; width: number; height: number };
  target: AnnoTarget;
}
export interface NoteModalState {
  target: AnnoTarget;
  /**
   * create 模式的选区快照（locatorRange/selectedText）；edit 模式不需要（读标注）。
   * 快照避免 save 时依赖易失的 `selection`——笔记过长时 textarea 内部滚动会被
   * EpubReader 的捕获阶段 scroll 监听清掉选区，若 save 仍读 selection 会静默丢笔记。
   */
  anchor?: { locatorRange: string; selectedText: string };
}

interface AnnotationState {
  selection: SelectionInfo | null;
  styleBar: StyleBarState | null;
  noteModal: NoteModalState | null;
  /** 命令信号（非状态）：nonce 递增触发 EpubReader 滚动到该 CFI。 */
  scrollCommand: { cfi: string; nonce: number } | null;
}
interface AnnotationActions {
  setSelection: (selection: SelectionInfo | null) => void;
  openStyleBar: (s: StyleBarState) => void;
  closeStyleBar: () => void;
  openNoteModal: (s: NoteModalState) => void;
  closeNoteModal: () => void;
  requestScroll: (cfi: string) => void;
}

export const ANNOTATION_INITIAL: AnnotationState = {
  selection: null,
  styleBar: null,
  noteModal: null,
  scrollCommand: null,
};

export const useAnnotationStore = create<AnnotationState & AnnotationActions>((set) => ({
  ...ANNOTATION_INITIAL,
  setSelection: (selection) => set({ selection }),
  openStyleBar: (styleBar) => set({ styleBar }),
  closeStyleBar: () => set({ styleBar: null }),
  openNoteModal: (noteModal) => set({ noteModal }),
  closeNoteModal: () => set({ noteModal: null }),
  requestScroll: (cfi) =>
    set((s) => ({ scrollCommand: { cfi, nonce: (s.scrollCommand?.nonce ?? 0) + 1 } })),
}));
