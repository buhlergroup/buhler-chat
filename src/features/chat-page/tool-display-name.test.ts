import { describe, it, expect } from "vitest";
import { stripExtensionKeyPrefix } from "./tool-display-name";

describe("chat-page.unit.tool-display-name — stripExtensionKeyPrefix", () => {
  it("strips an 8-char alphanumeric extension-id prefix and underscore", () => {
    expect(stripExtensionKeyPrefix("Kj3nQ8xz_aisearch")).toBe("aisearch");
  });

  it("strips a lowercase-only 8-char prefix", () => {
    expect(stripExtensionKeyPrefix("abcdefgh_my_api_call")).toBe("my_api_call");
  });

  it("leaves a built-in tool name unchanged (no 8-char-prefix shape)", () => {
    expect(stripExtensionKeyPrefix("search_documents")).toBe("search_documents");
    expect(stripExtensionKeyPrefix("get_current_time")).toBe("get_current_time");
    expect(stripExtensionKeyPrefix("call_sub_agent")).toBe("call_sub_agent");
    expect(stripExtensionKeyPrefix("search_sub_agent")).toBe("search_sub_agent");
    expect(stripExtensionKeyPrefix("search_company_content")).toBe(
      "search_company_content"
    );
  });

  it("leaves a short name unchanged (fewer than 8 chars before any underscore)", () => {
    expect(stripExtensionKeyPrefix("alpha")).toBe("alpha");
    expect(stripExtensionKeyPrefix("web_search")).toBe("web_search");
  });

  it("leaves a name unchanged when the 9th character is not an underscore", () => {
    expect(stripExtensionKeyPrefix("abcdefghi_aisearch")).toBe(
      "abcdefghi_aisearch"
    );
  });

  it("only strips once, from the start (no repeated/greedy stripping)", () => {
    // Two prefixes back-to-back: only the first is namespacing, the second
    // is part of the function name and must survive.
    expect(stripExtensionKeyPrefix("abcdefgh_ijklmnop_aisearch")).toBe(
      "ijklmnop_aisearch"
    );
  });

  it("keeps app tool names that have the key shape (generate_image)", () => {
    expect(stripExtensionKeyPrefix("generate_image")).toBe("generate_image");
  });

  it("is idempotent on an already-stripped name", () => {
    expect(stripExtensionKeyPrefix("aisearch")).toBe("aisearch");
  });
});
