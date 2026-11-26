import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

vi.mock("uuid", () => ({ v4: () => "channel-1" }));
vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

import { CodeInterpreterFilePicker } from "./code-interpreter-file-picker";

const TENANT = "https://contoso.sharepoint.com/";

// Sends an "initialize" message as the picker iframe would, from `origin`,
// and returns the port the picker would talk to.
const sendInitialize = (origin: string) => {
  const port = {
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    start: vi.fn(),
  };
  const event = new MessageEvent("message", {
    origin,
    data: { type: "initialize", channelId: "channel-1" },
  });
  Object.defineProperty(event, "ports", { value: [port] });
  act(() => {
    window.dispatchEvent(event);
  });
  return port;
};

describe("CodeInterpreterFilePicker — postMessage origin", () => {
  beforeEach(() => {
    render(
      <CodeInterpreterFilePicker tenantUrl={TENANT} token="tok" onFilesSelected={vi.fn()} />
    );
  });

  it("answers the tenant's exact origin", () => {
    const port = sendInitialize("https://contoso.sharepoint.com");
    expect(port.postMessage).toHaveBeenCalledWith({ type: "activate" });
  });

  it.each([
    "https://contoso.sharepoint.com.attacker.test",
    "https://evil-contoso.sharepoint.com",
    "http://contoso.sharepoint.com",
    "https://contoso.sharepoint.com:8443",
  ])("ignores a look-alike origin %s", (origin) => {
    const port = sendInitialize(origin);
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(port.start).not.toHaveBeenCalled();
  });
});
