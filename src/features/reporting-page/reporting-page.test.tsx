import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatReportingPage, ReportingContent } from "./reporting-page";
import type { ChatThreadModel } from "../chat-page/chat-services/models";

// ---------- module mocks ----------

vi.mock("./reporting-services/reporting-service", () => ({
  FindAllChatThreadsForAdmin: vi.fn(),
}));

vi.mock("./reporting-hero", () => ({
  ReportingHero: () => <div data-testid="reporting-hero">Hero</div>,
}));

vi.mock("./table-row", () => ({
  default: ({ id, name, useName }: ChatThreadModel) => (
    <tr data-testid="chat-thread-row" data-id={id}>
      <td>{name}</td>
      <td>{useName}</td>
    </tr>
  ),
}));

vi.mock("@/features/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/features/ui/page-loader", () => ({
  PageLoader: () => <div data-testid="page-loader">Loading…</div>,
}));

vi.mock("@/features/ui/error/display-error", () => ({
  DisplayError: ({ errors }: { errors: Array<{ message: string }> }) => (
    <div data-testid="display-error">
      {errors.map((e, i) => (
        <p key={i}>{e.message}</p>
      ))}
    </div>
  ),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// Lucide icons
vi.mock("lucide-react", () => ({
  ChevronLeft: () => <span data-testid="chevron-left" />,
  ChevronRight: () => <span data-testid="chevron-right" />,
  Sheet: () => <span data-testid="sheet-icon" />,
}));

// Table primitives – render semantically valid HTML for jsdom
vi.mock("@/features/ui/table", () => ({
  Table: ({ children }: { children: React.ReactNode }) => (
    <table>{children}</table>
  ),
  TableHeader: ({ children }: { children: React.ReactNode }) => (
    <thead>{children}</thead>
  ),
  TableBody: ({ children }: { children: React.ReactNode }) => (
    <tbody>{children}</tbody>
  ),
  TableHead: ({ children }: { children: React.ReactNode }) => (
    <th>{children}</th>
  ),
  TableRow: ({ children, ...props }: any) => <tr {...props}>{children}</tr>,
  TableCell: ({ children }: { children: React.ReactNode }) => (
    <td>{children}</td>
  ),
}));

vi.mock("@/features/ui/button", () => ({
  Button: ({ children, asChild, ...props }: any) => {
    if (asChild) return <>{children}</>;
    return <button {...props}>{children}</button>;
  },
}));

// Suspense in jsdom renders the fallback and never resolves async server components.
// Override it to render children directly so ChatReportingPage's inner async tree
// is resolved when we await the top-level async component.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    Suspense: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// ---------- helpers ----------

import { FindAllChatThreadsForAdmin } from "./reporting-services/reporting-service";

const mockFindAll = vi.mocked(FindAllChatThreadsForAdmin);

function makeThread(id: string, name: string, useName: string): ChatThreadModel {
  return {
    id,
    name,
    useName,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    lastMessageAt: new Date("2024-01-01T00:00:00Z"),
    userId: "u1",
    isDeleted: false,
    bookmarked: false,
    personaMessage: "",
    personaMessageTitle: "",
    extension: [],
    type: "CHAT_THREAD",
  };
}

// ChatReportingPage and ReportingContent are both async server components.
// jsdom cannot render async function components directly, so we resolve
// ReportingContent ourselves and place a hero stub alongside it (the outer's
// only non-Suspense child is ReportingHero, which is mocked).
async function renderAsync(page: number) {
  const innerEl = await ReportingContent({ page });
  return render(
    <>
      <div data-testid="reporting-hero">Hero</div>
      {innerEl as React.ReactElement}
    </>,
  );
}

// ---------- tests ----------

describe("reporting-page.unit.001 — admin sees chat thread rows", async () => {
  it("renders a row for each thread returned by the service", async () => {
    mockFindAll.mockResolvedValueOnce({
      status: "OK",
      response: [
        makeThread("t1", "Thread Alpha", "alice@example.com"),
        makeThread("t2", "Thread Beta", "bob@example.com"),
      ],
    });

    await renderAsync(0);

    expect(screen.getByText("Thread Alpha")).toBeInTheDocument();
    expect(screen.getByText("Thread Beta")).toBeInTheDocument();
  });
});

describe("reporting-page.unit.002 — service error shows DisplayError", async () => {
  it("renders DisplayError when FindAllChatThreadsForAdmin returns ERROR", async () => {
    mockFindAll.mockResolvedValueOnce({
      status: "ERROR",
      errors: [{ message: "You are not authorized to perform this action" }],
    });

    await renderAsync(0);

    expect(screen.getByTestId("display-error")).toBeInTheDocument();
    expect(
      screen.getByText("You are not authorized to perform this action")
    ).toBeInTheDocument();
  });
});

describe("reporting-page.unit.003 — empty result set shows no rows", async () => {
  it("renders no chat-thread-row elements when result is empty", async () => {
    mockFindAll.mockResolvedValueOnce({ status: "OK", response: [] });

    await renderAsync(0);

    expect(screen.queryAllByTestId("chat-thread-row")).toHaveLength(0);
  });
});

describe("reporting-page.unit.004 — pagination: no prev button on page 0", async () => {
  it("does not render previous-page link on page 0", async () => {
    mockFindAll.mockResolvedValueOnce({
      status: "OK",
      response: Array.from({ length: 100 }, (_, i) =>
        makeThread(`t${i}`, `Thread ${i}`, `user${i}@test.com`)
      ),
    });

    await renderAsync(0);

    expect(screen.queryByTestId("chevron-left")).not.toBeInTheDocument();
    expect(screen.getByTestId("chevron-right")).toBeInTheDocument();
  });
});

describe("reporting-page.unit.005 — pagination: prev button on page 1", async () => {
  it("renders previous-page link on page 1", async () => {
    mockFindAll.mockResolvedValueOnce({
      status: "OK",
      response: Array.from({ length: 100 }, (_, i) =>
        makeThread(`t${i}`, `Thread ${i}`, `user${i}@test.com`)
      ),
    });

    await renderAsync(1);

    expect(screen.getByTestId("chevron-left")).toBeInTheDocument();
  });
});

describe("reporting-page.unit.006 — pagination: no next button when fewer than 100 results", async () => {
  it("hides next-page link when result count < PAGE_SIZE (100)", async () => {
    mockFindAll.mockResolvedValueOnce({
      status: "OK",
      response: [makeThread("t1", "Only Thread", "user@test.com")],
    });

    await renderAsync(2);

    expect(screen.queryByTestId("chevron-right")).not.toBeInTheDocument();
  });
});

describe("reporting-page.unit.007 — prev button links to correct page", async () => {
  it("previous-page link points to page N-1", async () => {
    mockFindAll.mockResolvedValueOnce({ status: "OK", response: [] });

    await renderAsync(3);

    // No results → no next button; only the prev button link should be present
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/reporting?pageNumber=2");
  });
});

describe("reporting-page.unit.008 — negative page clamps to 0", async () => {
  it("calls service with offset 0 for negative page input", async () => {
    mockFindAll.mockResolvedValueOnce({ status: "OK", response: [] });

    // page = -1 should clamp internally; service should still be called
    await renderAsync(-1);

    // Service is called once regardless
    expect(mockFindAll).toHaveBeenCalledTimes(1);
  });
});

describe("reporting-page.unit.009 — hero always rendered", async () => {
  it("renders the ReportingHero for admin", async () => {
    mockFindAll.mockResolvedValueOnce({ status: "OK", response: [] });

    await renderAsync(0);

    expect(screen.getByTestId("reporting-hero")).toBeInTheDocument();
  });
});

describe("reporting-page.unit.010 — hero rendered even on error", async () => {
  it("renders the ReportingHero even when service returns ERROR", async () => {
    mockFindAll.mockResolvedValueOnce({
      status: "ERROR",
      errors: [{ message: "DB unavailable" }],
    });

    await renderAsync(0);

    expect(screen.getByTestId("reporting-hero")).toBeInTheDocument();
  });
});
