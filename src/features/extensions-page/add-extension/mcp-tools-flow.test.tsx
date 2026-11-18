import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../extension-services/mcp/mcp-service", () => ({
  DiscoverMcpTools: vi.fn(),
  DiscoverDraftMcpTools: vi.fn(),
  DisconnectMcpOAuth: vi.fn(),
  GetMcpConnections: vi.fn().mockResolvedValue({ status: "OK", response: [] }),
  StartMcpOAuth: vi.fn(),
}));

vi.mock("../extension-services/extension-service", () => ({
  CreateExtension: vi.fn(),
  UpdateExtension: vi.fn(),
}));

vi.mock("@/features/common/navigation-helpers", () => ({
  RevalidateCache: vi.fn(),
}));

vi.mock("@/features/ui/sheet", () => ({
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { McpServerSection, MCP_AUTO_LOAD_DELAY_MS } from "./mcp-server";
import { SECRET_MASK, extensionStore } from "../extension-store";
import { ExtensionEditFromQuery } from "../extension-edit-from-query";
import { CreateExtension, UpdateExtension } from "../extension-services/extension-service";
import { DiscoverDraftMcpTools, DiscoverMcpTools } from "../extension-services/mcp/mcp-service";
import type { ExtensionModel, McpConfigModel, McpToolInfo } from "../extension-services/models";

const FAKE = "Bearer fake-test-token";
const TOOLS: McpToolInfo[] = [
  { name: "get_price", description: "Price" },
  { name: "get_news" },
  { name: "place_order" },
];

const saved = (mcp: Partial<McpConfigModel> = {}, id = "ext1"): ExtensionModel => ({
  id,
  name: "Market data",
  description: "d",
  executionSteps: "s",
  headers: [],
  functions: [],
  userId: "u",
  isPublished: false,
  createdAt: new Date(),
  type: "EXTENSION",
  kind: "mcp",
  mcp: {
    url: "https://mcp.example.test/mcp",
    transport: "auto",
    secrets: [],
    toolAllowList: [],
    auth: "none",
    ...mcp,
  },
});

const box = (name: string) => screen.getByRole("checkbox", { name: new RegExp(`^${name}`) });
const summary = () => screen.getByTestId("mcp-tool-summary").textContent;
const flush = () => act(async () => {});

beforeEach(() => {
  vi.mocked(DiscoverDraftMcpTools).mockReset();
  vi.mocked(DiscoverMcpTools).mockReset();
  vi.mocked(CreateExtension).mockReset();
  vi.mocked(UpdateExtension).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("extensions-page.unit.components.003 — MCP tool selection", () => {
  it("shows every tool checked when the allow list is empty", () => {
    act(() => extensionStore.openAndUpdate(saved({ tools: TOOLS })));
    render(<McpServerSection />);
    for (const t of TOOLS) expect(box(t.name)).toBeChecked();
    expect(summary()).toBe("All tools are available.");
    expect(screen.queryByText(/With no selection/)).not.toBeInTheDocument();
  });

  it("unchecking one stores the other tools; checking it again stores an empty list", () => {
    act(() => extensionStore.openAndUpdate(saved({ tools: TOOLS })));
    render(<McpServerSection />);
    fireEvent.click(box("get_news"));
    expect(extensionStore.extension.mcp?.toolAllowList).toEqual(["get_price", "place_order"]);
    expect(box("get_news")).not.toBeChecked();
    expect(summary()).toBe("2 of 3 tools are available.");

    fireEvent.click(box("get_news"));
    expect(extensionStore.extension.mcp?.toolAllowList).toEqual([]);
    expect(summary()).toBe("All tools are available.");
  });

  it("shows a stored selection checked", () => {
    act(() => extensionStore.openAndUpdate(saved({ tools: TOOLS, toolAllowList: ["place_order"] })));
    render(<McpServerSection />);
    expect(box("place_order")).toBeChecked();
    expect(box("get_price")).not.toBeChecked();
    expect(summary()).toBe("1 of 3 tools are available.");
  });

  it("Clear unchecks every tool and blocks the save; Select all allows all again", async () => {
    act(() => extensionStore.openAndUpdate(saved({ tools: TOOLS, toolAllowList: ["get_price"] })));
    render(<McpServerSection />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    for (const t of TOOLS) expect(box(t.name)).not.toBeChecked();
    expect(summary()).toBe("Select at least one tool.");

    await act(() => extensionStore.submitForm(JSON.parse(JSON.stringify(extensionStore.extension))));
    expect(UpdateExtension).not.toHaveBeenCalled();
    expect(CreateExtension).not.toHaveBeenCalled();
    expect(extensionStore.formState.errors.map((e) => e.message)).toEqual(["Select at least one tool."]);
    expect(extensionStore.isOpened).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(extensionStore.extension.mcp?.toolAllowList).toEqual([]);
    expect(extensionStore.mcpNoToolSelected).toBe(false);
    expect(extensionStore.formState.errors).toEqual([]);
  });

  it("unchecking the last checked tool blocks the save too", async () => {
    act(() => extensionStore.openAndUpdate(saved({ tools: TOOLS, toolAllowList: ["get_price"] })));
    render(<McpServerSection />);
    fireEvent.click(box("get_price"));
    expect(summary()).toBe("Select at least one tool.");
    await act(() => extensionStore.submitForm(JSON.parse(JSON.stringify(extensionStore.extension))));
    expect(UpdateExtension).not.toHaveBeenCalled();
  });

  it("a refresh drops names the server no longer has; nothing left of a selection blocks the save", async () => {
    act(() =>
      extensionStore.openAndUpdate(saved({ tools: TOOLS, toolAllowList: ["get_price", "gone_tool"] }))
    );
    render(<McpServerSection />);
    vi.mocked(DiscoverMcpTools).mockResolvedValueOnce({
      status: "OK",
      response: saved({ tools: [TOOLS[0], TOOLS[1]] }),
    });
    fireEvent.click(screen.getByRole("button", { name: /refresh tools/i }));
    await flush();
    // Unchanged saved connection: read and stored through the saved extension.
    expect(DiscoverMcpTools).toHaveBeenCalledWith("ext1");
    expect(extensionStore.extension.mcp?.toolAllowList).toEqual(["get_price"]);

    act(() => extensionStore.openAndUpdate(saved({ tools: TOOLS, toolAllowList: ["gone_tool"] })));
    vi.mocked(DiscoverMcpTools).mockResolvedValueOnce({ status: "OK", response: saved({ tools: TOOLS }) });
    fireEvent.click(screen.getByRole("button", { name: /refresh tools/i }));
    await flush();
    expect(extensionStore.mcpNoToolSelected).toBe(true);
    expect(summary()).toBe("Select at least one tool.");
  });
});

describe("extensions-page.unit.components.004 — MCP tools load without save", () => {
  it("loads the tools of a NEW extension from the typed values by themselves (debounced)", async () => {
    vi.useFakeTimers();
    act(() => extensionStore.newAndOpenSlider("mcp"));
    vi.mocked(DiscoverDraftMcpTools).mockResolvedValue({ status: "OK", response: TOOLS });
    render(<McpServerSection />);
    expect(screen.getByRole("button", { name: /load tools/i })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://mcp.example.test/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: /add header/i }));
    fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "Authorization" } });
    act(() => vi.advanceTimersByTime(MCP_AUTO_LOAD_DELAY_MS));
    // A row without a value: no load yet.
    expect(DiscoverDraftMcpTools).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "Bearer fake" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: FAKE } });
    act(() => vi.advanceTimersByTime(MCP_AUTO_LOAD_DELAY_MS - 1));
    expect(DiscoverDraftMcpTools).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    await flush();

    expect(DiscoverDraftMcpTools).toHaveBeenCalledTimes(1);
    expect(DiscoverDraftMcpTools).toHaveBeenCalledWith({
      extensionId: undefined,
      url: "https://mcp.example.test/mcp",
      transport: "auto",
      secrets: [expect.objectContaining({ name: "Authorization", placement: "header", value: FAKE })],
    });
    for (const t of TOOLS) expect(box(t.name)).toBeChecked();
    expect(screen.getByRole("button", { name: /refresh tools/i })).toBeInTheDocument();

    // Loaded once: no second automatic read.
    act(() => vi.advanceTimersByTime(MCP_AUTO_LOAD_DELAY_MS * 2));
    expect(DiscoverDraftMcpTools).toHaveBeenCalledTimes(1);
  });

  it("shows a load error inline and keeps the form", async () => {
    act(() => {
      extensionStore.newAndOpenSlider("mcp");
      extensionStore.updateMcp({ url: "https://mcp.example.test/mcp" });
    });
    vi.mocked(DiscoverDraftMcpTools).mockResolvedValue({
      status: "ERROR",
      errors: [{ message: "The MCP server address is not allowed." }],
    });
    render(<McpServerSection />);
    fireEvent.click(screen.getByRole("button", { name: /load tools/i }));
    await flush();
    expect(screen.getByText("The MCP server address is not allowed.")).toHaveClass("text-red-500");
    expect(extensionStore.formState.errors).toEqual([]);
  });

  it("sends the mask for a saved row that was not retyped (the server reads the saved value)", async () => {
    act(() =>
      extensionStore.openAndUpdate(
        saved({
          secrets: [{ id: "row1", name: "X-Team", target: "X-Team", placement: "header", value: SECRET_MASK }],
        })
      )
    );
    vi.mocked(DiscoverDraftMcpTools).mockResolvedValue({ status: "OK", response: TOOLS });
    render(<McpServerSection />);
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://mcp2.example.test/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: /load tools/i }));
    await flush();
    expect(DiscoverDraftMcpTools).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionId: "ext1",
        url: "https://mcp2.example.test/mcp",
        secrets: [expect.objectContaining({ id: "row1", value: SECRET_MASK })],
      })
    );
    expect(DiscoverMcpTools).not.toHaveBeenCalled();
  });

  it("OAuth before save: says Save to connect and offers no load", () => {
    act(() => {
      extensionStore.newAndOpenSlider("mcp");
      extensionStore.updateMcp({ auth: "oauth", url: "https://mcp.example.test/mcp" });
    });
    render(<McpServerSection />);
    expect(screen.getByText("Save to connect.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /load tools/i })).not.toBeInTheDocument();
  });
});

describe("extensions-page.unit.components.005 — MCP save keeps the sheet open", () => {
  it("keeps the sheet open, shows Saved., keeps the loaded tools; the next save updates", async () => {
    act(() => {
      extensionStore.newAndOpenSlider("mcp");
      extensionStore.updateMcp({ url: "https://mcp.example.test/mcp" });
      extensionStore.setMcpTools(TOOLS);
      extensionStore.toggleMcpTool("place_order", false);
    });
    vi.mocked(CreateExtension).mockResolvedValue({
      status: "OK",
      response: saved({ toolAllowList: ["get_price", "get_news"] }, "new-id"),
    });
    render(<McpServerSection />);
    await act(() => extensionStore.submitForm(JSON.parse(JSON.stringify(extensionStore.extension))));

    expect(CreateExtension).toHaveBeenCalledTimes(1);
    expect(extensionStore.isOpened).toBe(true);
    expect(extensionStore.saveNotice).toBe("Saved.");
    expect(extensionStore.extension.id).toBe("new-id");
    expect(extensionStore.extension.mcp?.tools).toEqual(TOOLS);
    expect(box("place_order")).not.toBeChecked();
    expect(DiscoverDraftMcpTools).not.toHaveBeenCalled();
    expect(DiscoverMcpTools).not.toHaveBeenCalled();

    // An edit clears the confirmation.
    fireEvent.click(box("place_order"));
    expect(extensionStore.saveNotice).toBe("");

    vi.mocked(UpdateExtension).mockResolvedValue({ status: "OK", response: saved({}, "new-id") });
    await act(() => extensionStore.submitForm(JSON.parse(JSON.stringify(extensionStore.extension))));
    expect(UpdateExtension).toHaveBeenCalledWith(expect.objectContaining({ id: "new-id" }));
    expect(CreateExtension).toHaveBeenCalledTimes(1);
  });

  it("loads the tools right after the save when none were loaded", async () => {
    act(() => {
      extensionStore.newAndOpenSlider("mcp");
      extensionStore.updateMcp({ url: "https://mcp.example.test/mcp" });
    });
    vi.mocked(CreateExtension).mockResolvedValue({ status: "OK", response: saved({}, "new-id") });
    vi.mocked(DiscoverMcpTools).mockResolvedValue({ status: "OK", response: saved({ tools: TOOLS }, "new-id") });
    await act(() => extensionStore.submitForm(JSON.parse(JSON.stringify(extensionStore.extension))));
    await flush();
    expect(DiscoverMcpTools).toHaveBeenCalledWith("new-id");
    expect(extensionStore.extension.mcp?.tools).toEqual(TOOLS);
    expect(extensionStore.isOpened).toBe(true);
  });

  it("HTTP extensions still close the sheet after a save", async () => {
    act(() => extensionStore.newAndOpenSlider("http"));
    vi.mocked(CreateExtension).mockResolvedValue({ status: "OK", response: { ...saved(), kind: "http" } });
    await act(() =>
      extensionStore.submitForm({ ...JSON.parse(JSON.stringify(extensionStore.extension)), kind: "http" })
    );
    expect(extensionStore.isOpened).toBe(false);
    expect(extensionStore.saveNotice).toBe("");
  });

  it("OAuth: after the save the sheet shows Connect directly", async () => {
    act(() => {
      extensionStore.newAndOpenSlider("mcp");
      extensionStore.updateMcp({ auth: "oauth", url: "https://mcp.example.test/mcp" });
    });
    vi.mocked(CreateExtension).mockResolvedValue({ status: "OK", response: saved({ auth: "oauth" }, "new-id") });
    render(<McpServerSection />);
    await act(() => extensionStore.submitForm(JSON.parse(JSON.stringify(extensionStore.extension))));
    await flush();
    expect(screen.getByRole("button", { name: /connect/i })).toBeInTheDocument();
    expect(DiscoverMcpTools).not.toHaveBeenCalled();
  });
});

describe("extensions-page.unit.components.006 — back from the OAuth sign-in", () => {
  it("reopens the extension sheet from ?edit and loads the tools after a sign-in", async () => {
    act(() => extensionStore.updateOpened(false));
    window.history.replaceState(null, "", "/extensions?edit=ext1&mcp=connected");
    vi.mocked(DiscoverMcpTools).mockResolvedValue({ status: "OK", response: saved({ auth: "oauth", tools: TOOLS }) });
    render(<ExtensionEditFromQuery extension={saved({ auth: "oauth" })} mcpResult="connected" />);
    await flush();
    expect(extensionStore.isOpened).toBe(true);
    expect(extensionStore.extension.id).toBe("ext1");
    expect(DiscoverMcpTools).toHaveBeenCalledWith("ext1");
    expect(extensionStore.extension.mcp?.tools).toEqual(TOOLS);
    expect(window.location.search).toBe("");
  });

  it("does nothing without an extension the user may edit", () => {
    act(() => extensionStore.updateOpened(false));
    render(<ExtensionEditFromQuery mcpResult="connected" />);
    expect(extensionStore.isOpened).toBe(false);
    expect(DiscoverMcpTools).not.toHaveBeenCalled();
  });
});

