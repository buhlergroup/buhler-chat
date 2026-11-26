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

  it("treats protocol-relative and other-origin URLs as external", () => {
    expect(isSameOriginUrl("/api/images?x=1")).toBe(true);
    expect(isSameOriginUrl("//example.com/x")).toBe(false);
    expect(isSameOriginUrl("https://example.com/x")).toBe(false);
    expect(isSameOriginUrl(`${window.location.origin}.example.com/`)).toBe(false);
  });
});
