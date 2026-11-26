// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";

import { createProductionOpenAIEmbedding } from "./openai.production";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("common.unit.openai-production.001 — embedding client retries", () => {
  it("retries rate limits and server errors 5 times (the client's own backoff, no extra loop)", () => {
    vi.stubEnv("AZURE_OPENAI_API_EMBEDDINGS_DEPLOYMENT_NAME", "embedding");
    vi.stubEnv("AZURE_OPENAI_API_INSTANCE_NAME", "instance");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "test-key");

    const client = createProductionOpenAIEmbedding();

    expect(client.maxRetries).toBe(5);
  });
});
