import { describe, it, expect } from "vitest";
import {
  copilotOffersWebSearch,
  WEB_SEARCH_REQUESTED_NOTE,
  webSearchAlways,
  withWebSearchRequestNote,
} from "./web-search-default";

const deployed = { "fast-model": { deploymentName: "fast", supportsResponsesAPI: true, provider: "azure" } };
const none = { "chat-only": { deploymentName: "chat", supportsResponsesAPI: false, provider: "azure" } };

describe("webSearchAlways (COPILOT_WEB_SEARCH_ALWAYS)", () => {
  it("is on when unset or empty", () => {
    expect(webSearchAlways({})).toBe(true);
    expect(webSearchAlways({ COPILOT_WEB_SEARCH_ALWAYS: "" })).toBe(true);
    expect(webSearchAlways({ COPILOT_WEB_SEARCH_ALWAYS: "true" })).toBe(true);
    expect(webSearchAlways({ COPILOT_WEB_SEARCH_ALWAYS: "1" })).toBe(true);
  });

  it("is off for false, 0 and off, in any case and with spaces", () => {
    for (const value of ["false", "0", "off", " FALSE ", "Off"]) {
      expect(webSearchAlways({ COPILOT_WEB_SEARCH_ALWAYS: value })).toBe(false);
    }
  });
});

describe("copilotOffersWebSearch", () => {
  it("toggle off, setting unset, a Responses model deployed: offered", () => {
    expect(copilotOffersWebSearch({ toggle: false, env: {}, configs: deployed, defaultIds: [] })).toBe(true);
  });

  it("toggle off, setting false: not offered", () => {
    expect(
      copilotOffersWebSearch({ toggle: false, env: { COPILOT_WEB_SEARCH_ALWAYS: "false" }, configs: deployed, defaultIds: [] }),
    ).toBe(false);
  });

  it("toggle on: offered, with the setting on or off", () => {
    expect(copilotOffersWebSearch({ toggle: true, env: {}, configs: deployed, defaultIds: [] })).toBe(true);
    expect(
      copilotOffersWebSearch({ toggle: true, env: { COPILOT_WEB_SEARCH_ALWAYS: "off" }, configs: deployed, defaultIds: [] }),
    ).toBe(true);
  });

  it("no Responses model deployed: the toggle decides, as before", () => {
    expect(copilotOffersWebSearch({ toggle: false, env: {}, configs: none, defaultIds: [] })).toBe(false);
    expect(copilotOffersWebSearch({ toggle: true, env: {}, configs: none, defaultIds: [] })).toBe(true);
  });
});

describe("withWebSearchRequestNote", () => {
  it("adds the static note at the end of the user message only when the toggle is on", () => {
    expect(withWebSearchRequestNote("What is new?", false)).toBe("What is new?");
    const withNote = withWebSearchRequestNote("What is new?", true);
    expect(withNote.startsWith("What is new?")).toBe(true);
    expect(withNote.endsWith(WEB_SEARCH_REQUESTED_NOTE)).toBe(true);
    // Static text: the same note for every message.
    expect(withWebSearchRequestNote("Other text", true).endsWith(WEB_SEARCH_REQUESTED_NOTE)).toBe(true);
  });
});
