// Tiny IoC service registry. Production source uses `resolve(key)` to obtain
// service instances; the binding is supplied at boot time by `instrumentation.ts`.
// This module has zero knowledge of any concrete service or environment mode.

type Factory<T> = () => T;

// Turbopack production builds can duplicate this module across chunks, which
// would give each chunk its own registry Map and break the fake-injection
// path: instrumentation.ts registers fakes in registry instance A, while
// cosmos.ts / openai.ts resolve from registry instance B (still empty, so
// they fall through to their production factories). Storing the maps on
// `globalThis` makes every duplicated module instance share the same single
// pair of Maps in the Node process.
declare global {
  // eslint-disable-next-line no-var
  var __svcRegistry: Map<string, Factory<unknown>> | undefined;
  // eslint-disable-next-line no-var
  var __svcSingletons: Map<string, unknown> | undefined;
}

const registry: Map<string, Factory<unknown>> =
  globalThis.__svcRegistry ?? (globalThis.__svcRegistry = new Map());
const singletons: Map<string, unknown> =
  globalThis.__svcSingletons ?? (globalThis.__svcSingletons = new Map());

export function register<T>(key: string, factory: Factory<T>): void {
  registry.set(key, factory);
  singletons.delete(key);
}

export function has(key: string): boolean {
  return registry.has(key);
}

export function resolve<T>(key: string): T {
  if (singletons.has(key)) {
    return singletons.get(key) as T;
  }
  const factory = registry.get(key);
  if (!factory) {
    throw new Error(
      `service-container: no factory registered for "${key}". ` +
        `Check that instrumentation.ts has run (Next.js bootstrap hook).`,
    );
  }
  const instance = factory();
  singletons.set(key, instance);
  return instance as T;
}

export function reset(): void {
  registry.clear();
  singletons.clear();
}

export const SERVICE_KEYS = {
  cosmos: "cosmos-client",
  openaiChat: "openai-chat",
  openaiV1: "openai-v1",
  openaiMini: "openai-mini",
  openaiEmbedding: "openai-embedding",
  openaiVision: "openai-vision",
  openaiReasoning: "openai-reasoning",
  openaiV1Reasoning: "openai-v1-reasoning",
  openaiV1Image: "openai-v1-image",
  aiProvider: "ai-sdk-provider",
  foundryProvider: "ai-sdk-foundry-provider",
  anthropicProvider: "ai-sdk-anthropic-provider",
  contentBlobs: "content-blob-backend",
} as const;
