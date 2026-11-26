// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  MAX_UI_ERROR_CHARS,
  ToolUserError,
  sanitizeUiErrorText,
  uiErrorText,
} from "../tool-user-error";

/**
 * The UI text of a tool error is cleaned: an outside server (an MCP tool)
 * can echo its URL, a header or a token in its error text. The model keeps
 * the full message.
 */
describe("uiErrorText cleans the text an outside server sent", () => {
  it("replaces URLs, also with a secret in the query string", () => {
    const error = new ToolUserError(
      "Market / get_price returned an error: GET https://api.example.com/v1/prices?api_key=sk_live_123&sym=X failed (see www.example.org/help)"
    );
    const text = uiErrorText(error);
    expect(text).toBe("Market / get_price returned an error: GET [url] failed (see [url])");
    expect(text).not.toMatch(/sk_live|example\.com/);
  });

  it("redacts Bearer and Basic credentials", () => {
    const text = uiErrorText(
      new ToolUserError(
        'Tool returned an error: 401 with header Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig and "Basic dXNlcjpwYXNzd29yZA=="'
      )
    );
    expect(text).not.toMatch(/eyJhbGci|dXNlcjpw/);
    expect(text).toContain("Bearer [redacted]");
    expect(text).toContain("Basic [redacted]");
  });

  it("redacts key, token, secret, password and sig pairs", () => {
    const text = uiErrorText(
      new ToolUserError(
        'Tool returned an error: {"apiKey": "abc123", "client_secret":"s3cr3t"} token=tok_9 password: hunter2 sig=Zm9v x-api-key: k1'
      )
    );
    for (const secret of ["abc123", "s3cr3t", "tok_9", "hunter2", "Zm9v", "k1"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('"apiKey": "[redacted]"');
    expect(text).toContain("password: [redacted]");
  });

  it("redacts long base64 or hex-like runs (> 32 characters)", () => {
    const hex = "a".repeat(20) + "0123456789abcdef0123";
    const b64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIzNDU2Nzg5";
    const text = uiErrorText(new ToolUserError(`Tool returned an error: id ${hex} blob ${b64} short 0123456789abcdef`));
    expect(text).not.toContain(hex);
    expect(text).not.toContain(b64);
    expect(text).toContain("short 0123456789abcdef");
  });

  it("limits the text to 300 characters on one line", () => {
    const text = uiErrorText(new ToolUserError(`Tool returned an error:\n${"word ".repeat(200)}`));
    expect(Array.from(text).length).toBeLessThanOrEqual(MAX_UI_ERROR_CHARS);
    expect(text).not.toContain("\n");
    expect(text.endsWith("…")).toBe(true);
  });

  it("keeps the full message for the model", () => {
    const message = "Tool returned an error: https://api.example.com/x?token=abc";
    const error = new ToolUserError(message);
    expect(error.message).toBe(message);
    expect(uiErrorText(error)).toBe("Tool returned an error: [url]");
  });

  it("uses a tool's own uiMessage, cleaned too", () => {
    const error = new ToolUserError("full text for the model", {
      uiMessage: "Short text, see https://status.example.com",
    });
    expect(uiErrorText(error)).toBe("Short text, see [url]");
    expect(error.message).toBe("full text for the model");
  });

  it("keeps plain texts as they are", () => {
    expect(sanitizeUiErrorText("Market / get_price: The MCP server request failed.")).toBe(
      "Market / get_price: The MCP server request failed."
    );
    expect(sanitizeUiErrorText("Use overview without patterns.")).toBe("Use overview without patterns.");
  });

  it("other errors still show the generic text", () => {
    expect(uiErrorText(new Error("Cosmos 500 at https://internal.example"))).toBe("An error occurred.");
  });
});
