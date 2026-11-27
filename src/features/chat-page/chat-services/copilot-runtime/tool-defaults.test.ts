import { describe, it, expect } from "vitest";
import {
  copilotOffersWebSearch,
  copilotRunCodeToggle,
  copilotToolDefaults,
  runCodeDefaultOn,
  webSearchDefaultOn,
} from "./tool-defaults";

const deployed = { "fast-model": { deploymentName: "fast", supportsResponsesAPI: true, provider: "azure" } };
const none = { "chat-only": { deploymentName: "chat", supportsResponsesAPI: false, provider: "azure" } };

describe.each([
  ["COPILOT_WEB_SEARCH_DEFAULT", webSearchDefaultOn],
  ["COPILOT_RUN_CODE_DEFAULT", runCodeDefaultOn],
] as const)("%s", (name, read) => {
  it("is on when unset or empty", () => {
    expect(read({})).toBe(true);
    expect(read({ [name]: "" })).toBe(true);
    expect(read({ [name]: "true" })).toBe(true);
    expect(read({ [name]: "1" })).toBe(true);
  });

  it("is off for false, 0 and off, in any case and with spaces", () => {
    for (const value of ["false", "0", "off", " FALSE ", "Off"]) {
      expect(read({ [name]: value })).toBe(false);
    }
  });
});

it("the removed COPILOT_WEB_SEARCH_ALWAYS has no effect", () => {
  expect(webSearchDefaultOn({ COPILOT_WEB_SEARCH_ALWAYS: "false" })).toBe(true);
});

it("each setting turns only its own toggle off", () => {
  expect(webSearchDefaultOn({ COPILOT_RUN_CODE_DEFAULT: "false" })).toBe(true);
  expect(runCodeDefaultOn({ COPILOT_WEB_SEARCH_DEFAULT: "false" })).toBe(true);
});

describe("copilotOffersWebSearch", () => {
  it("no choice (undefined), setting unset, a Responses model deployed: offered", () => {
    expect(copilotOffersWebSearch({ toggle: undefined, env: {}, configs: deployed, defaultIds: [] })).toBe(true);
  });

  it("no choice, setting false: not offered (the old default off)", () => {
    expect(
      copilotOffersWebSearch({ toggle: undefined, env: { COPILOT_WEB_SEARCH_DEFAULT: "false" }, configs: deployed, defaultIds: [] }),
    ).toBe(false);
  });

  it("explicit off: not offered, also with the default on", () => {
    expect(copilotOffersWebSearch({ toggle: false, env: {}, configs: deployed, defaultIds: [] })).toBe(false);
  });

  it("explicit on: offered, also with the default off", () => {
    expect(copilotOffersWebSearch({ toggle: true, env: {}, configs: deployed, defaultIds: [] })).toBe(true);
    expect(
      copilotOffersWebSearch({ toggle: true, env: { COPILOT_WEB_SEARCH_DEFAULT: "off" }, configs: deployed, defaultIds: [] }),
    ).toBe(true);
  });

  it("no Responses model deployed: never offered", () => {
    expect(copilotOffersWebSearch({ toggle: undefined, env: {}, configs: none, defaultIds: [] })).toBe(false);
    expect(copilotOffersWebSearch({ toggle: true, env: {}, configs: none, defaultIds: [] })).toBe(false);
  });
});

describe("copilotRunCodeToggle", () => {
  it("no choice (undefined), setting unset, a Responses model deployed: on", () => {
    expect(copilotRunCodeToggle({ toggle: undefined, env: {}, configs: deployed, defaultIds: [] })).toBe(true);
  });

  it("no choice, setting false: off (the old default)", () => {
    expect(
      copilotRunCodeToggle({ toggle: undefined, env: { COPILOT_RUN_CODE_DEFAULT: "0" }, configs: deployed, defaultIds: [] }),
    ).toBe(false);
  });

  it("no choice, no Responses model deployed: off", () => {
    expect(copilotRunCodeToggle({ toggle: undefined, env: {}, configs: none, defaultIds: [] })).toBe(false);
  });

  it("an explicit choice wins over the default", () => {
    expect(copilotRunCodeToggle({ toggle: false, env: {}, configs: deployed, defaultIds: [] })).toBe(false);
    expect(
      copilotRunCodeToggle({ toggle: true, env: { COPILOT_RUN_CODE_DEFAULT: "off" }, configs: deployed, defaultIds: [] }),
    ).toBe(true);
  });
});

describe("copilotToolDefaults (the chat page's defaults)", () => {
  it("both on by default with a Responses model", () => {
    expect(copilotToolDefaults({ env: {}, configs: deployed, defaultIds: [] })).toEqual({ webSearch: true, runCode: true });
  });

  it("follows each setting", () => {
    expect(
      copilotToolDefaults({ env: { COPILOT_WEB_SEARCH_DEFAULT: "false" }, configs: deployed, defaultIds: [] }),
    ).toEqual({ webSearch: false, runCode: true });
    expect(
      copilotToolDefaults({ env: { COPILOT_RUN_CODE_DEFAULT: "false" }, configs: deployed, defaultIds: [] }),
    ).toEqual({ webSearch: true, runCode: false });
  });

  it("both off without a Responses model", () => {
    expect(copilotToolDefaults({ env: {}, configs: none, defaultIds: [] })).toEqual({ webSearch: false, runCode: false });
  });
});
