import { create } from 'zustand';

/** A link being added (or edited, when `editIndex` is set) in the Relation Builder. */
export interface LinkDraft {
  parentCollection?: string;
  localField?: string;
  collection?: string;
  foreignField?: string;
  editIndex?: number;
}

/** Transient UI state shared across panels (never persisted). */
interface UiState {
  /** Schema Manager: collection to show, or null when closed. */
  schemaFor: string | null;
  schemaOpen: boolean;
  linkDraft: LinkDraft | null;
  helpOpen: boolean;
  openSchema: (collection?: string | null) => void;
  closeSchema: () => void;
  openLink: (draft?: LinkDraft) => void;
  closeLink: () => void;
  setHelpOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  schemaFor: null,
  schemaOpen: false,
  linkDraft: null,
  helpOpen: false,
  openSchema: (collection) => set({ schemaOpen: true, schemaFor: collection ?? null }),
  closeSchema: () => set({ schemaOpen: false }),
  openLink: (draft = {}) => set({ linkDraft: draft }),
  closeLink: () => set({ linkDraft: null }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
}));
