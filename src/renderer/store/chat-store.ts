import { create } from "zustand";
import type { Chip } from "@shared/chat";

interface ChatState {
  activeConversationId: string | null;
  draftText: string;
  draftChips: Chip[];
  panelOpen: boolean;
}
interface ChatActions {
  setActiveConversation: (id: string | null) => void;
  setDraftText: (text: string) => void;
  setDraftChips: (chips: Chip[]) => void;
  setPanelOpen: (open: boolean) => void;
}

export const CHAT_INITIAL: ChatState = {
  activeConversationId: null,
  draftText: "",
  draftChips: [],
  panelOpen: false,
};

export const useChatStore = create<ChatState & ChatActions>((set) => ({
  ...CHAT_INITIAL,
  setActiveConversation: (activeConversationId) => set({ activeConversationId }),
  setDraftText: (draftText) => set({ draftText }),
  setDraftChips: (draftChips) => set({ draftChips }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
}));
