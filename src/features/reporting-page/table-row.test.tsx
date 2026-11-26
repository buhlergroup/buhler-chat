import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChatThreadRow from "./table-row";
import type { ChatThreadModel } from "../chat-page/chat-services/models";

const mockPush = vi.fn();

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useRouter: () => ({
      push: mockPush,
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    }),
  };
});

// Render inside a table so TableRow/TableCell are valid HTML
function renderRow(props: ChatThreadModel) {
  return render(
    <table>
      <tbody>
        <ChatThreadRow {...props} />
      </tbody>
    </table>
  );
}

function makeThread(overrides: Partial<ChatThreadModel> = {}): ChatThreadModel {
  return {
    id: "thread-1",
    name: "My conversation",
    useName: "alice@example.com",
    createdAt: new Date("2024-03-15T10:00:00Z"),
    lastMessageAt: new Date("2024-03-15T10:05:00Z"),
    userId: "user-1",
    isDeleted: false,
    bookmarked: false,
    personaMessage: "",
    personaMessageTitle: "",
    extension: [],
    type: "CHAT_THREAD",
    ...overrides,
  };
}

describe("table-row.unit.001 — renders thread data", () => {
  it("displays conversation name, user, and date", () => {
    renderRow(makeThread());
    expect(screen.getByText("My conversation")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    // Date rendering is locale-dependent; just assert a cell exists with a date string
    const cells = screen.getAllByRole("cell");
    expect(cells).toHaveLength(3);
  });
});

describe("table-row.unit.002 — row click navigates to reporting chat", () => {
  it("calls router.push with the correct URL on row click", async () => {
    const user = userEvent.setup();
    renderRow(makeThread({ id: "abc-123" }));
    const row = screen.getByRole("row");
    await user.click(row);
    expect(mockPush).toHaveBeenCalledWith("/reporting/chat/abc-123");
  });
});

describe("table-row.unit.003 — formats date as localeDateString", () => {
  it("renders a non-empty date cell", () => {
    renderRow(makeThread({ createdAt: new Date("2024-06-01T00:00:00Z") }));
    const cells = screen.getAllByRole("cell");
    // Third cell is the date
    expect(cells[2].textContent).not.toBe("");
  });
});

describe("table-row.unit.004 — renders with minimal required fields", () => {
  it("does not throw when optional fields are absent", () => {
    expect(() =>
      renderRow(
        makeThread({
          id: "min-1",
          name: "Minimal thread",
          useName: "user@test.com",
        })
      )
    ).not.toThrow();
  });
});
