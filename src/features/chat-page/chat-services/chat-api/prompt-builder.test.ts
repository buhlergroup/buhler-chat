import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { compareByCodepoint } from "../tools/stabilize-toolset";
import {
  buildSystemMessage,
  withAnthropicPromptCache,
  withPromptCacheBreakpoint,
} from "./prompt-builder";

// These tests lock down byte-for-byte stability of the parts of the request
// that participate in the Azure OpenAI prompt cache key. A regression here
// translates directly into cache misses and a 10x cost increase on the
// affected input tokens.

describe("buildSystemMessage", () => {
  const baseInputs = {
    staticSystemPrompt: "You are a friendly Test AI assistant.",
    personaMessage: "Be terse. Cite sources.",
    documentHint: "",
  };

  it("is a pure function — same inputs yield byte-identical output", () => {
    const a = buildSystemMessage(baseInputs);
    const b = buildSystemMessage(baseInputs);
    const c = buildSystemMessage({ ...baseInputs }); // different object identity, same values
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("byte-identical across two distinct calls (no hidden state)", () => {
    const a = buildSystemMessage(baseInputs);
    // simulate a separate request lifecycle
    const inputsCopy = JSON.parse(JSON.stringify(baseInputs));
    const b = buildSystemMessage(inputsCopy);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("changes when (and only when) one of the documented inputs changes", () => {
    const baseline = buildSystemMessage(baseInputs);
    expect(buildSystemMessage({ ...baseInputs, personaMessage: "Different persona." })).not.toBe(baseline);
    expect(buildSystemMessage({ ...baseInputs, documentHint: "\n\nDOCS: foo.pdf" })).not.toBe(baseline);
    expect(buildSystemMessage({ ...baseInputs, staticSystemPrompt: "different static" })).not.toBe(baseline);
  });

  it("treats omitted documentHint as empty string", () => {
    const withEmpty = buildSystemMessage({ ...baseInputs, documentHint: "" });
    const withOmitted = buildSystemMessage({
      staticSystemPrompt: baseInputs.staticSystemPrompt,
      personaMessage: baseInputs.personaMessage,
    });
    expect(withOmitted).toBe(withEmpty);
  });

  it("does NOT inject any date — output must be stable across calendar days", () => {
    const out = buildSystemMessage({
      staticSystemPrompt: "STATIC",
      personaMessage: "PERSONA",
      documentHint: "",
    });
    // No ISO date and no "Today" marker should leak into the prompt; otherwise
    // the prompt cache would invalidate at every UTC midnight rollover.
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(out.toLowerCase()).not.toContain("today");
  });

  it("places segments in the documented order: static, persona, trailing static block, doc-hint", () => {
    const out = buildSystemMessage({
      staticSystemPrompt: "STATIC",
      personaMessage: "PERSONA",
      documentHint: "DOCHINT",
      trailingStaticBlock: "TRAILING",
    });
    expect(out.indexOf("STATIC")).toBeLessThan(out.indexOf("PERSONA"));
    expect(out.indexOf("PERSONA")).toBeLessThan(out.indexOf("TRAILING"));
    expect(out.indexOf("TRAILING")).toBeLessThan(out.indexOf("DOCHINT"));
  });

  it("keeps the whole prefix byte-identical when only the document hint changes", () => {
    // The regression this pins: documentHint used to sit BETWEEN the static
    // prompt and the persona, so attaching one document rewrote every byte
    // after the static prompt. Now the shared prefix must survive intact.
    const base = {
      staticSystemPrompt: "STATIC PROMPT",
      personaMessage: "PERSONA MESSAGE",
      trailingStaticBlock: "\n\n## Interactive UI\nrules",
    };
    const withoutDocs = buildSystemMessage(base);
    const withDocs = buildSystemMessage({
      ...base,
      documentHint: "\n\nDOCUMENT CONTEXT: a.pdf",
    });
    expect(withDocs.startsWith(withoutDocs)).toBe(true);
    expect(withDocs).not.toBe(withoutDocs);
  });

  it("keeps the prefix byte-identical when the document hint only changes wording", () => {
    const base = {
      staticSystemPrompt: "STATIC PROMPT",
      personaMessage: "PERSONA MESSAGE",
      trailingStaticBlock: "\n\n## Interactive UI\nrules",
    };
    const oneDoc = buildSystemMessage({ ...base, documentHint: "\n\nDOCS: a.pdf" });
    const twoDocs = buildSystemMessage({ ...base, documentHint: "\n\nDOCS: a.pdf, b.pdf" });
    const shared = buildSystemMessage(base);
    expect(oneDoc.startsWith(shared)).toBe(true);
    expect(twoDocs.startsWith(shared)).toBe(true);
  });

  it("treats an omitted trailingStaticBlock as empty string", () => {
    const a = buildSystemMessage({
      staticSystemPrompt: "S",
      personaMessage: "P",
      trailingStaticBlock: "",
    });
    const b = buildSystemMessage({ staticSystemPrompt: "S", personaMessage: "P" });
    expect(a).toBe(b);
  });

});

describe("withAnthropicPromptCache", () => {
  const EPHEMERAL = { type: "ephemeral" };
  const userMsgs: ModelMessage[] = [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "follow-up question" },
  ];

  it("returns the system prompt as a cached SystemModelMessage (breakpoint #1: tools+system)", () => {
    const { instructions: system } = withAnthropicPromptCache("SYSTEM PROMPT", userMsgs);
    expect(system.role).toBe("system");
    expect(system.content).toBe("SYSTEM PROMPT");
    expect(system.providerOptions?.anthropic?.cacheControl).toEqual(EPHEMERAL);
  });

  it("marks the LAST message with a cache_control breakpoint (breakpoint #2: history)", () => {
    const { messages } = withAnthropicPromptCache("SYS", userMsgs);
    const last = messages[messages.length - 1];
    expect(last.providerOptions?.anthropic?.cacheControl).toEqual(EPHEMERAL);
  });

  it("leaves all non-last messages untouched (≤ 2 breakpoints total → under Anthropic's max of 4)", () => {
    const { messages } = withAnthropicPromptCache("SYS", userMsgs);
    const cachedCount = messages.filter(
      (m) => m.providerOptions?.anthropic?.cacheControl,
    ).length;
    expect(cachedCount).toBe(1); // the last message; the system breakpoint lives on `system`
    expect(messages[0].providerOptions).toBeUndefined();
    expect(messages[1].providerOptions).toBeUndefined();
  });

  it("does not mutate the caller's messages array or its objects", () => {
    const snapshot = JSON.stringify(userMsgs);
    const { messages } = withAnthropicPromptCache("SYS", userMsgs);
    expect(JSON.stringify(userMsgs)).toBe(snapshot); // input unchanged
    expect(messages).not.toBe(userMsgs);
    expect(userMsgs[userMsgs.length - 1].providerOptions).toBeUndefined();
  });

  it("preserves message content/role while adding the breakpoint", () => {
    const { messages } = withAnthropicPromptCache("SYS", userMsgs);
    const last = messages[messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("follow-up question");
  });

  it("merges with pre-existing providerOptions on the last message rather than clobbering", () => {
    const withOpts: ModelMessage[] = [
      {
        role: "user",
        content: "q",
        providerOptions: { anthropic: { something: "keep-me" } },
      },
    ];
    const { messages } = withAnthropicPromptCache("SYS", withOpts);
    const anth = messages[0].providerOptions?.anthropic as Record<string, unknown>;
    expect(anth.something).toBe("keep-me");
    expect(anth.cacheControl).toEqual(EPHEMERAL);
  });

  it("handles an empty messages array (still caches the system prompt)", () => {
    const { instructions: system, messages } = withAnthropicPromptCache("SYS", []);
    expect(system.providerOptions?.anthropic?.cacheControl).toEqual(EPHEMERAL);
    expect(messages).toEqual([]);
  });

  it("uses fresh cacheControl objects per breakpoint (no aliasing across messages)", () => {
    const { instructions: system, messages } = withAnthropicPromptCache("SYS", userMsgs);
    const sysCc = system.providerOptions?.anthropic?.cacheControl;
    const lastCc = messages[messages.length - 1].providerOptions?.anthropic?.cacheControl;
    expect(sysCc).not.toBe(lastCc); // distinct object identities
    expect(sysCc).toEqual(lastCc); // but equal value
  });
});

describe("byte-for-byte invariant (the cache contract)", () => {
  // This is the headline test: if these inputs are stable, the assembled
  // request prefix MUST be byte-identical, regardless of the order extensions
  // were registered or which conditional branches fired during assembly.

  const personaMessage = "Be a helpful coding assistant. Always cite line numbers when referring to code.";
  const staticSystemPrompt = "You are a friendly Bühler Chat AI assistant.\n\nFORMAT WITH MARKDOWN.";

  it("two requests with identical thread state produce identical system messages and tool arrays", () => {
    const toolsRequest1 = [
      { name: "search_documents", description: "..." },
      { name: "call_sub_agent", description: "..." },
      { name: "search_sub_agent", description: "..." },
    ];
    // Same logical set, registered in a different order (e.g. extensions loaded async)
    const toolsRequest2 = [
      { name: "search_sub_agent", description: "..." },
      { name: "search_documents", description: "..." },
      { name: "call_sub_agent", description: "..." },
    ];

    // `today` used to be passed here; the builder never accepted it (a date in
    // the prefix would void the cache at every UTC midnight) and TypeScript
    // was flagging it.
    const sys1 = buildSystemMessage({ staticSystemPrompt, personaMessage, documentHint: "" });
    const sys2 = buildSystemMessage({ staticSystemPrompt, personaMessage, documentHint: "" });
    // The live path orders tools with stabilizeToolset's comparator; sort with
    // the same one here so this asserts the shipped ordering, not a helper.
    const byName = (a: { name: string }, b: { name: string }) =>
      compareByCodepoint(a.name, b.name);
    const sortedTools1 = [...toolsRequest1].sort(byName);
    const sortedTools2 = [...toolsRequest2].sort(byName);

    // System message is byte-identical
    expect(Buffer.from(sys1).equals(Buffer.from(sys2))).toBe(true);
    // Tool array is byte-identical (same JSON serialization)
    expect(JSON.stringify(sortedTools1)).toBe(JSON.stringify(sortedTools2));
  });
});

// Provider-neutral concept, Responses-seam wire form. The Anthropic wire form
// of the same breakpoint is covered by the withAnthropicPromptCache describe
// above (breakpoint #1, on the system message).
describe("withPromptCacheBreakpoint", () => {
  const msgs: ModelMessage[] = [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "follow-up question" },
  ];

  it("returns the system prompt as a SystemModelMessage carrying the breakpoint", () => {
    const { instructions: system } = withPromptCacheBreakpoint("SYSTEM PROMPT", msgs);
    expect(system.role).toBe("system");
    expect(system.content).toBe("SYSTEM PROMPT");
    // The wire shape @ai-sdk/openai emits as prompt_cache_breakpoint.
    expect(system.providerOptions?.openai?.promptCacheBreakpoint).toEqual({
      mode: "explicit",
    });
  });

  it("leaves the conversation messages untouched", () => {
    const { messages } = withPromptCacheBreakpoint("SYSTEM", msgs);
    expect(messages).toEqual(msgs);
    // A copy, so a later mutation cannot reach the caller's array.
    expect(messages).not.toBe(msgs);
    expect(messages.every((m) => m.providerOptions === undefined)).toBe(true);
  });

  it("is byte-stable across calls (the prefix must not drift)", () => {
    expect(
      JSON.stringify(withPromptCacheBreakpoint("SYSTEM", msgs)),
    ).toBe(JSON.stringify(withPromptCacheBreakpoint("SYSTEM", msgs)));
  });
});
