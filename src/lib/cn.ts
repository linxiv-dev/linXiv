import { extendTailwindMerge } from "tailwind-merge";

/** Joins class lists; on a conflict the later class wins, so callers' className overrides a primitive's defaults. */
export const cn = extendTailwindMerge({
  // Custom keys from tailwind.config.ts; colors need nothing, tailwind-merge accepts any color name.
  extend: { theme: { radius: ["card"], shadow: ["card"] } },
});
