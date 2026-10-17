import { createMemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";
import { adminActor, type Actor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";

export function ctxFor(store: Store, actor: Actor = adminActor()): ServiceContext {
  return { actor, store, baseUrl: "http://test.local", previewSecret: "test-preview-secret" };
}

export function newStore() {
  return createMemoryStore();
}
