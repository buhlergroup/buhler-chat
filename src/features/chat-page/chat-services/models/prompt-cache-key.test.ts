import { describe, it, expect } from "vitest";

import {
  DEFAULT_PROMPT_CACHE_KEY_SHARDS,
  getPromptCacheKeyShards,
  getPromptCacheKeyStrategy,
  resolvePromptCacheKey,
  shardForUser,
  toolsetSignature,
} from "./prompt-cache-key";

const USER_A = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
const USER_B = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

describe("getPromptCacheKeyStrategy", () => {
  it("defaults to thread", () => {
    expect(getPromptCacheKeyStrategy(undefined)).toBe("thread");
    expect(getPromptCacheKeyStrategy("")).toBe("thread");
  });

  it("accepts persona case-insensitively", () => {
    expect(getPromptCacheKeyStrategy("persona")).toBe("persona");
    expect(getPromptCacheKeyStrategy(" PERSONA ")).toBe("persona");
  });

  it("treats an unrecognised value as thread (negative)", () => {
    expect(getPromptCacheKeyStrategy("global")).toBe("thread");
  });
});

describe("getPromptCacheKeyShards", () => {
  it("defaults to 4", () => {
    expect(getPromptCacheKeyShards(undefined)).toBe(
      DEFAULT_PROMPT_CACHE_KEY_SHARDS,
    );
    expect(DEFAULT_PROMPT_CACHE_KEY_SHARDS).toBe(4);
  });

  it("reads a positive integer", () => {
    expect(getPromptCacheKeyShards("8")).toBe(8);
  });

  it("rejects zero, negatives and junk so the modulo can never be by zero (negative)", () => {
    expect(getPromptCacheKeyShards("0")).toBe(4);
    expect(getPromptCacheKeyShards("-3")).toBe(4);
    expect(getPromptCacheKeyShards("many")).toBe(4);
  });
});

describe("toolsetSignature", () => {
  it("is insensitive to insertion order and duplicates", () => {
    expect(toolsetSignature(["b", "a", "b"])).toBe(toolsetSignature(["a", "b"]));
  });

  it("differs for a different tool set", () => {
    expect(toolsetSignature(["a", "b"])).not.toBe(
      toolsetSignature(["a", "b", "c"]),
    );
  });

  it("is a short, stable hex string", () => {
    const sig = toolsetSignature(["search_documents", "code_interpreter"]);
    expect(sig).toMatch(/^[0-9a-f]{8}$/);
    expect(toolsetSignature(["search_documents", "code_interpreter"])).toBe(sig);
  });
});

describe("shardForUser", () => {
  it("is deterministic for the same user", () => {
    expect(shardForUser(USER_A, 4)).toBe(shardForUser(USER_A, 4));
  });

  it("stays inside the bucket range", () => {
    for (const shards of [1, 2, 4, 8]) {
      const shard = shardForUser(USER_A, shards);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(shards);
    }
  });

  it("shards a non-hex subject id instead of collapsing it onto 0", () => {
    const shards = new Set(
      ["user:one", "user:two", "user:three", "user:four", "user:five"].map((u) =>
        shardForUser(u, 4),
      ),
    );
    expect(shards.size).toBeGreaterThan(1);
  });

  it("falls back to the default bucket count for a nonsense shard count", () => {
    expect(shardForUser(USER_A, 0)).toBeLessThan(
      DEFAULT_PROMPT_CACHE_KEY_SHARDS,
    );
  });
});

describe("resolvePromptCacheKey", () => {
  const base = {
    threadId: "thread-42",
    toolNames: ["search_documents", "code_interpreter"],
    userKey: USER_A,
    shards: 4,
  };

  it("uses the thread id under the default strategy", () => {
    expect(
      resolvePromptCacheKey({
        ...base,
        modelId: "gpt-5.6-terra",
        strategy: "thread",
      }),
    ).toBe("thread-42");
  });

  it("builds persona:<id>:<toolsetSignature>:<shard> under the persona strategy", () => {
    const key = resolvePromptCacheKey({
      ...base,
      modelId: "gpt-5.6-terra",
      personaId: "agent-7",
      strategy: "persona",
    });
    const expectedShard = shardForUser(USER_A, 4);
    expect(key).toBe(
      `persona:agent-7:${toolsetSignature(base.toolNames)}:${expectedShard}`,
    );
  });

  it("uses 'default' in place of a missing persona id", () => {
    const key = resolvePromptCacheKey({
      ...base,
      modelId: "gpt-5.6-sol",
      strategy: "persona",
    });
    expect(key.startsWith("persona:default:")).toBe(true);
  });

  it("gives two threads of the same agent + toolset + user the SAME key", () => {
    const one = resolvePromptCacheKey({
      ...base,
      threadId: "thread-1",
      modelId: "gpt-5.6-terra",
      personaId: "agent-7",
      strategy: "persona",
    });
    const two = resolvePromptCacheKey({
      ...base,
      threadId: "thread-2",
      modelId: "gpt-5.6-terra",
      personaId: "agent-7",
      strategy: "persona",
    });
    expect(one).toBe(two);
  });

  it("separates different agents and different toolsets", () => {
    const agentOne = resolvePromptCacheKey({
      ...base,
      modelId: "gpt-5.6-terra",
      personaId: "agent-1",
      strategy: "persona",
    });
    const agentTwo = resolvePromptCacheKey({
      ...base,
      modelId: "gpt-5.6-terra",
      personaId: "agent-2",
      strategy: "persona",
    });
    const otherTools = resolvePromptCacheKey({
      ...base,
      toolNames: ["search_documents"],
      modelId: "gpt-5.6-terra",
      personaId: "agent-1",
      strategy: "persona",
    });
    expect(agentOne).not.toBe(agentTwo);
    expect(agentOne).not.toBe(otherTools);
  });

  it("puts different users on (potentially) different shards but each one stably", () => {
    const forA = resolvePromptCacheKey({
      ...base,
      modelId: "gpt-5.6-terra",
      personaId: "agent-7",
      strategy: "persona",
    });
    const forB = resolvePromptCacheKey({
      ...base,
      userKey: USER_B,
      modelId: "gpt-5.6-terra",
      personaId: "agent-7",
      strategy: "persona",
    });
    expect(forA.endsWith(`:${shardForUser(USER_A, 4)}`)).toBe(true);
    expect(forB.endsWith(`:${shardForUser(USER_B, 4)}`)).toBe(true);
  });

  it("keeps the thread id for gpt-5.5 even under the persona strategy (negative)", () => {
    expect(
      resolvePromptCacheKey({
        ...base,
        modelId: "gpt-5.5",
        personaId: "agent-7",
        strategy: "persona",
      }),
    ).toBe("thread-42");
  });

  it("keeps the thread id for non-5.6 families generally (negative)", () => {
    for (const modelId of ["gpt-5.4", "gpt-5.4-mini", "claude-sonnet-5", "Kimi-K2.6"] as const) {
      expect(
        resolvePromptCacheKey({
          ...base,
          modelId,
          personaId: "agent-7",
          strategy: "persona",
        }),
      ).toBe("thread-42");
    }
  });
});
