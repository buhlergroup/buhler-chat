import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { Response, isSameOriginUrl } from "./response";

const MARKDOWN = [
  "[Download **deck.pptx**](/api/images?t=thread-1&img=deck.pptx)",
  "",
  "[Example](https://example.com/page)",
].join("\n");

const LINK = '[data-streamdown="link"]';

describe("Response link handling", () => {
  let openSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  it("opens a relative app link directly without the external-link dialog", async () => {
    render(<Response>{MARKDOWN}</Response>);

    const links = document.querySelectorAll(LINK);
    expect(links).toHaveLength(2);
    fireEvent.click(links[0]);

    await vi.waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    expect(openSpy).toHaveBeenCalledWith(
      "/api/images?t=thread-1&img=deck.pptx",
      "_blank",
      "noreferrer"
    );
    expect(screen.queryByText(/Open external link/i)).not.toBeInTheDocument();
  });

  it("opens an absolute same-origin link directly", async () => {
    const href = `${window.location.origin}/api/code-interpreter/file/a.csv`;
    render(<Response>{`[File](${href})`}</Response>);
    fireEvent.click(document.querySelector(LINK)!);

    await vi.waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    expect(openSpy).toHaveBeenCalledWith(href, "_blank", "noreferrer");
    expect(screen.queryByText(/Open external link/i)).not.toBeInTheDocument();
  });

  it("still shows the dialog for an external link and does not open it", async () => {
    render(<Response>{MARKDOWN}</Response>);

    const links = document.querySelectorAll(LINK);
    fireEvent.click(links[1]);

    expect(await screen.findByText(/Open external link/i)).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
  });

  describe("workspace links (Copilot path)", () => {
    const download = (relative: string) =>
      `/api/workspace/file?t=thread-1&p=${encodeURIComponent(relative)}`;

    it.each([
      ["/workspace/squares.csv", "squares.csv"],
      ["sandbox:/workspace/squares.csv", "squares.csv"],
      ["file:///workspace/squares.csv", "squares.csv"],
      ["file:/workspace/squares.csv", "squares.csv"],
      ["sandbox:outputs/squares.csv", "outputs/squares.csv"],
    ])("opens %s as the download URL of the thread on screen", async (href, relative) => {
      render(<Response workspaceThreadId="thread-1">{`[Download squares.csv](${href})`}</Response>);
      fireEvent.click(document.querySelector(LINK)!);

      await vi.waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
      expect(openSpy).toHaveBeenCalledWith(download(relative), "_blank", "noreferrer");
      expect(screen.queryByText(/Open external link/i)).not.toBeInTheDocument();
    });

    it("rewrites an autolink", async () => {
      render(<Response workspaceThreadId="thread-1">{"<sandbox:/workspace/out/a.csv>"}</Response>);
      fireEvent.click(document.querySelector(LINK)!);

      await vi.waitFor(() =>
        expect(openSpy).toHaveBeenCalledWith(download("out/a.csv"), "_blank", "noreferrer")
      );
    });

    it("shows a workspace image from the download route", () => {
      render(
        <Response workspaceThreadId="thread-1">
          {"![Chart](sandbox:/workspace/outputs/chart.png)"}
        </Response>
      );
      expect(screen.getByAltText("Chart")).toHaveAttribute("src", download("outputs/chart.png"));
    });

    it.each([
      "/workspace/../session-state/events.jsonl",
      "sandbox:/workspace/%2e%2e/session-state/events.jsonl",
      "/session-state/events.jsonl",
      "file:///session-state/events.jsonl",
      "sandbox:../secret.txt",
    ])("blocks %s", (href) => {
      render(<Response workspaceThreadId="thread-1">{`[File](${href})`}</Response>);
      expect(document.querySelector(LINK)).toBeNull();
      expect(screen.getByText(/\[blocked\]/)).toBeInTheDocument();
    });

    it("blocks an image in the session state", () => {
      render(<Response workspaceThreadId="thread-1">{"![State](/session-state/x.png)"}</Response>);
      expect(screen.queryByAltText("State")).toBeNull();
      expect(screen.getByText("[Image blocked: State]")).toBeInTheDocument();
    });

    it("keeps an external link external", async () => {
      render(
        <Response workspaceThreadId="thread-1">
          {"[Example](https://example.com/workspace/a.csv)"}
        </Response>
      );
      fireEvent.click(document.querySelector(LINK)!);

      expect(await screen.findByText(/Open external link/i)).toBeInTheDocument();
      expect(openSpy).not.toHaveBeenCalled();
    });

    it("keeps a path in inline code as text", () => {
      render(<Response workspaceThreadId="thread-1">{"`[a](/workspace/a.csv)`"}</Response>);
      expect(document.querySelector(LINK)).toBeNull();
      expect(screen.getByText("[a](/workspace/a.csv)")).toBeInTheDocument();
    });

    it.each(["squares.csv", "www.example.com"])(
      "leaves the bare relative href %s to the sanitizer (blocked, no download link)",
      (href) => {
        render(<Response workspaceThreadId="thread-1">{`[File](${href})`}</Response>);
        expect(document.querySelector(LINK)).toBeNull();
        expect(screen.getByText(/\[blocked\]/)).toBeInTheDocument();
      }
    );

    it("does not turn a dot-relative href into a download link", () => {
      render(<Response workspaceThreadId="thread-1">{"[File](./out/a.csv)"}</Response>);
      fireEvent.click(document.querySelector(LINK)!);
      expect(openSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("/api/workspace/file"),
        expect.anything(),
        expect.anything()
      );
    });

    it("leaves workspace links alone without a workspace thread (AI SDK path)", () => {
      render(<Response>{"[Download](sandbox:/workspace/squares.csv)"}</Response>);
      expect(document.querySelector(LINK)).toBeNull();
      expect(screen.getByText(/\[blocked\]/)).toBeInTheDocument();
    });
  });

  it("treats protocol-relative and other-origin URLs as external", () => {
    expect(isSameOriginUrl("/api/images?x=1")).toBe(true);
    expect(isSameOriginUrl("//example.com/x")).toBe(false);
    expect(isSameOriginUrl("https://example.com/x")).toBe(false);
    expect(isSameOriginUrl(`${window.location.origin}.example.com/`)).toBe(false);
  });
});
