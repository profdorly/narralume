import { create } from "zustand";

import type { ManuscriptSelection } from "./manuscript-editor";

export type EditorSaveState = "saved" | "saving" | "dirty" | "error";

interface StudioEditorState {
  selection: ManuscriptSelection;
  saveState: EditorSaveState;
  focusMode: boolean;
  wordCount: number;
  characterCount: number;
  setSelection: (selection: ManuscriptSelection) => void;
  setSaveState: (saveState: EditorSaveState) => void;
  setFocusMode: (focusMode: boolean) => void;
  toggleFocusMode: () => void;
  setCounts: (wordCount: number, characterCount: number) => void;
}

export const useStudioEditorStore = create<StudioEditorState>((set) => ({
  selection: { start: 0, end: 0 },
  saveState: "saved",
  focusMode: false,
  wordCount: 0,
  characterCount: 0,
  setSelection: (selection) => set({ selection }),
  setSaveState: (saveState) => set({ saveState }),
  setFocusMode: (focusMode) => set({ focusMode }),
  toggleFocusMode: () => set((state) => ({ focusMode: !state.focusMode })),
  setCounts: (wordCount, characterCount) => set({ wordCount, characterCount }),
}));
