import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** Sizes (px) of resizable panes, remembered per browser. */
interface LayoutState {
  sizes: Record<string, number>;
  setSize: (key: string, px: number) => void;
  resetSize: (key: string) => void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      sizes: {},
      setSize: (key, px) => set((s) => ({ sizes: { ...s.sizes, [key]: Math.round(px) } })),
      resetSize: (key) =>
        set((s) => {
          const sizes = { ...s.sizes };
          delete sizes[key];
          return { sizes };
        }),
    }),
    { name: 'litemongo.layout', version: 1, storage: createJSONStorage(() => localStorage) },
  ),
);

export function usePaneSize(key: string, fallback: number): number {
  return useLayoutStore((s) => s.sizes[key]) ?? fallback;
}
