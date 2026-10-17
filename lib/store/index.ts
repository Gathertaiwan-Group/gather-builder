import { createSupabaseStore } from "./supabase";
import type { Store } from "./types";

let cached: Store | null = null;

/** 正式環境的 Store（Supabase）。測試用 createMemoryStore() 直接注入服務函式。 */
export function getStore(): Store {
  if (!cached) cached = createSupabaseStore();
  return cached;
}

export type { Store } from "./types";
