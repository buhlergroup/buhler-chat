// E2E binding overrides. Imported by instrumentation.ts when
// AZURECHAT_TEST_BACKEND=memory is set in the dev server's env.
//
// This is the ONLY test-aware code that runs in the server process; production
// service modules (cosmos.ts / openai.ts) are unchanged in shape.

// Use the same RELATIVE path that production source files (cosmos.ts,
// openai.ts) use. Turbopack production builds can otherwise treat
// `@/features/...` aliased and `./...` relative imports as TWO different
// modules, producing two parallel `service-container` instances with two
// independent registries. The fake registration ends up in one registry,
// the production resolve() reads from the other, and the production
// factory wins.
import {
  register,
  SERVICE_KEYS,
} from "../../features/common/services/service-container";
import {
  CosmosInstance as createFakeCosmos,
} from "./cosmos";
import {
  OpenAIInstance as createFakeChat,
  OpenAIV1Instance as createFakeV1,
  OpenAIMiniInstance as createFakeMini,
  OpenAIEmbeddingInstance as createFakeEmbedding,
  OpenAIVisionInstance as createFakeVision,
  OpenAIReasoningInstance as createFakeReasoning,
  OpenAIV1ReasoningInstance as createFakeV1Reasoning,
  OpenAIV1ImageInstance as createFakeV1Image,
} from "./openai";
import { createFakeAzureProvider } from "./azure-provider";
import { createMemoryContentBlobBackend } from "../../features/common/services/content-store/memory-backend";

register(SERVICE_KEYS.cosmos, createFakeCosmos);
register(SERVICE_KEYS.openaiChat, createFakeChat);
register(SERVICE_KEYS.openaiV1, createFakeV1);
register(SERVICE_KEYS.openaiMini, createFakeMini);
register(SERVICE_KEYS.openaiEmbedding, createFakeEmbedding);
register(SERVICE_KEYS.openaiVision, createFakeVision);
register(SERVICE_KEYS.openaiReasoning, createFakeReasoning);
register(SERVICE_KEYS.openaiV1Reasoning, createFakeV1Reasoning);
register(SERVICE_KEYS.openaiV1Image, createFakeV1Image);
register(SERVICE_KEYS.aiProvider, createFakeAzureProvider);
register(SERVICE_KEYS.contentBlobs, createMemoryContentBlobBackend);

console.log("[e2e-fakes] in-memory service bindings registered");
