import { describe, it, expect } from "vitest";
import { buildExtensionUrl, declaredQueryKeys } from "../extension-url-builder";

const schema = (...keys: string[]) => ({
  type: "object",
  properties: {
    query: {
      type: "object",
      properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
    },
  },
});

describe("extension-url-builder — declared keys", () => {
  it("reads the keys under parameters.properties.query.properties", () => {
    expect([...declaredQueryKeys(schema("a", "b"))]).toEqual(["a", "b"]);
    expect(declaredQueryKeys({}).size).toBe(0);
    expect(declaredQueryKeys(null).size).toBe(0);
  });
});

describe("extension-url-builder — buildExtensionUrl", () => {
  it("fills the documented bare placeholder in a query value", () => {
    expect(
      buildExtensionUrl(
        "https://api.example.com/v7.0/search?q=BING_SEARCH_QUERY",
        { BING_SEARCH_QUERY: "weather in Zürich & more" },
        schema("BING_SEARCH_QUERY")
      )
    ).toBe("https://api.example.com/v7.0/search?q=weather%20in%20Z%C3%BCrich%20%26%20more");
  });

  it("fills {name} and bare path placeholders, encoded", () => {
    expect(
      buildExtensionUrl(
        "https://api.example.com/repos/OWNER/{repo}/issues",
        { OWNER: "a b", repo: "x/y" },
        schema("OWNER", "repo")
      )
    ).toBe("https://api.example.com/repos/a%20b/x%2Fy/issues");
  });

  it("puts declared keys without a placeholder into the query string", () => {
    expect(
      buildExtensionUrl("https://api.example.com/search", { q: "a&b=c", n: 5 }, schema("q", "n"))
    ).toBe("https://api.example.com/search?q=a%26b%3Dc&n=5");
    expect(
      buildExtensionUrl("https://api.example.com/search?x=1", { q: "v" }, schema("q"))
    ).toBe("https://api.example.com/search?x=1&q=v");
  });

  it("ignores keys that the schema does not declare", () => {
    expect(
      buildExtensionUrl("https://api.example.com/search", { q: "v", evil: "1" }, schema("q"))
    ).toBe("https://api.example.com/search?q=v");
    expect(buildExtensionUrl("https://api.example.com/search", { q: "v" }, {})).toBe(
      "https://api.example.com/search"
    );
  });

  it("never swaps the host: a key equal to part of the host is not a placeholder there", () => {
    // Before the fix, url.replace("api", ...) swapped the host.
    const url = buildExtensionUrl(
      "https://api.example.com/v1/items",
      { api: "attacker.test/x?", example: "evil" },
      schema("api", "example")
    );
    expect(new URL(url).origin).toBe("https://api.example.com");
    expect(url).toBe("https://api.example.com/v1/items?api=attacker.test%2Fx%3F&example=evil");
  });

  it("never fills a placeholder in a query parameter name", () => {
    const url = buildExtensionUrl(
      "https://api.example.com/s?q=Q",
      { q: "injected", Q: "v" },
      schema("q", "Q")
    );
    expect(url).toBe("https://api.example.com/s?q=v&q=injected");
  });

  it("encodes /../, ? and # so the path and query cannot be steered", () => {
    const url = buildExtensionUrl(
      "https://api.example.com/v1/items/{id}/details",
      { id: "../../admin?x=1#frag" },
      schema("id")
    );
    expect(url).toBe("https://api.example.com/v1/items/..%2F..%2Fadmin%3Fx%3D1%23frag/details");
    expect(new URL(url).pathname).toBe("/v1/items/..%2F..%2Fadmin%3Fx%3D1%23frag/details");
  });

  it("refuses a value that turns a path segment into a dot segment", () => {
    for (const id of ["..", "."]) {
      expect(() =>
        buildExtensionUrl("https://api.example.com/v1/{id}/details", { id }, schema("id"))
      ).toThrow(/path/);
    }
  });

  it("keeps an encoded dot value literal (%2e is encoded again)", () => {
    expect(
      buildExtensionUrl("https://api.example.com/v1/{id}/details", { id: "%2e%2e" }, schema("id"))
    ).toBe("https://api.example.com/v1/%252e%252e/details");
  });

  it("keeps the origin of a template written without //", () => {
    const url = buildExtensionUrl("https:api.example.com/x/{id}", { id: "1" }, schema("id"));
    expect(url).toBe("https://api.example.com/x/1");
  });

  it("refuses a template that is not an absolute URL", () => {
    expect(() => buildExtensionUrl("/relative", {}, schema())).toThrow();
  });
});
