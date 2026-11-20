import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SHAREPOINT_URL = "https://contoso.sharepoint.com/";
});

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { accessToken: "token" } } }),
}));

const actions = vi.hoisted(() => ({
  ListAgentFiles: vi.fn(),
  AddAgentFiles: vi.fn(),
  ChangeAgentFileUse: vi.fn(),
  RemoveAgentFile: vi.fn(),
  CheckPersonaSkillNow: vi.fn(),
  UploadPersonaSkill: vi.fn(),
}));

vi.mock("../persona-services/agent-files/agent-file-service", () => ({
  ListAgentFiles: actions.ListAgentFiles,
  AddAgentFiles: actions.AddAgentFiles,
  ChangeAgentFileUse: actions.ChangeAgentFileUse,
  RemoveAgentFile: actions.RemoveAgentFile,
}));
vi.mock("../persona-services/skills/persona-skill-service", () => ({
  CheckPersonaSkillNow: actions.CheckPersonaSkillNow,
  UploadPersonaSkill: actions.UploadPersonaSkill,
}));

// The SharePoint picker is an iframe; here a button that "picks" two items.
vi.mock("./code-interpreter-file-picker", () => ({
  CodeInterpreterFilePicker: (props: any) => (
    <div data-testid="picker" data-mode={props.mode} data-single={String(Boolean(props.single))}>
      {props.trigger(() =>
        props.onFilesSelected([
          { documentId: "ITEM1", parentReference: { driveId: "b!d" } },
          { documentId: "ITEM2", parentReference: { driveId: "b!d" } },
        ]),
      )}
    </div>
  ),
}));

vi.mock("@/features/ui/use-toast", () => ({ toast: vi.fn() }));

import { PersonaFiles, FILES_SUBTITLE } from "./persona-files";

const item = (over: Record<string, unknown> = {}) => ({
  ref: { kind: "document", id: "doc-1" },
  name: "Handbook.pdf",
  webUrl: "https://contoso.sharepoint.com/Handbook.pdf",
  isFolder: false,
  use: "search",
  status: "ok",
  sizeBytes: 2000,
  allowedUses: ["search", "code"],
  ...over,
});

const editorList = (items = [item()], needsCodeInterpreter = false) => ({
  status: "OK",
  response: { canEdit: true, count: items.length, items, needsCodeInterpreter },
});

beforeEach(() => {
  actions.ListAgentFiles.mockResolvedValue(editorList());
});

describe("PersonaFiles", () => {
  it("one section with the plain-English subtitle (decision 1)", () => {
    render(<PersonaFiles personaId="" />);
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.getByText(FILES_SUBTITLE)).toBeInTheDocument();
    expect(FILES_SUBTITLE).toBe(
      "Add files and folders from SharePoint. The app chooses how the agent uses each item. You can change it.",
    );
  });

  it("a new agent: 'Save the agent to add files.' and no server call (decision 7)", () => {
    const onNeeds = vi.fn();
    render(<PersonaFiles personaId="" onNeedsCodeInterpreterChange={onNeeds} />);
    expect(screen.getByText("Save the agent to add files.")).toBeInTheDocument();
    expect(actions.ListAgentFiles).not.toHaveBeenCalled();
    expect(onNeeds).toHaveBeenCalledWith(false);
  });

  it("a viewer sees only the number of files (decision 9)", async () => {
    actions.ListAgentFiles.mockResolvedValue({
      status: "OK",
      response: { canEdit: false, count: 3, items: [], needsCodeInterpreter: true },
    });
    render(<PersonaFiles personaId="p1" />);
    expect(await screen.findByText("This agent uses 3 files.")).toBeInTheDocument();
    expect(screen.queryByText(/Add from SharePoint/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("an editor sees each item with its name, link and use", async () => {
    const onNeeds = vi.fn();
    actions.ListAgentFiles.mockResolvedValue(
      editorList(
        [
          item(),
          item({
            ref: { kind: "file-source", id: "src-1" },
            name: "Reports",
            isFolder: true,
            use: "on-demand",
            allowedUses: ["on-demand"],
            webUrl: undefined,
          }),
        ],
        true,
      ),
    );
    render(<PersonaFiles personaId="p1" onNeedsCodeInterpreterChange={onNeeds} />);
    expect(await screen.findByRole("link", { name: "Handbook.pdf" })).toHaveAttribute(
      "href",
      "https://contoso.sharepoint.com/Handbook.pdf",
    );
    const rows = screen.getAllByTestId("persona-file-item");
    expect(within(rows[0]).getByTestId("persona-file-use")).toHaveTextContent("Search");
    expect(within(rows[0]).getByTestId("persona-file-use")).toHaveAttribute(
      "title",
      "The model searches the text. The app copies the text when you add the file.",
    );
    expect(within(rows[1]).getByTestId("persona-file-use")).toHaveTextContent("On demand");
    expect(onNeeds).toHaveBeenLastCalledWith(true);
  });

  it("the use menu lists only the item's allowed uses and changes the use (decision 5)", async () => {
    actions.ChangeAgentFileUse.mockResolvedValue({ status: "OK", response: {} });
    render(<PersonaFiles personaId="p1" />);
    await userEvent.click(await screen.findByTestId("persona-file-use"));
    const menu = await screen.findByRole("menu");
    const options = within(menu).getAllByRole("menuitemradio").map((o) => o.textContent);
    expect(options).toEqual([
      "SearchThe model searches the text. The app copies the text when you add the file.",
      "CodeThe file is in the code interpreter when a chat starts.",
    ]);
    expect(within(menu).queryByText("On demand")).not.toBeInTheDocument();
    await userEvent.click(within(menu).getByText("Code"));
    await waitFor(() =>
      expect(actions.ChangeAgentFileUse).toHaveBeenCalledWith("p1", { kind: "document", id: "doc-1" }, "code"),
    );
  });

  it("removes an item from its menu", async () => {
    actions.RemoveAgentFile.mockResolvedValue({ status: "OK", response: true });
    render(<PersonaFiles personaId="p1" />);
    await userEvent.click(await screen.findByTestId("persona-file-use"));
    await userEvent.click(await screen.findByText("Remove"));
    await waitFor(() =>
      expect(actions.RemoveAgentFile).toHaveBeenCalledWith("p1", { kind: "document", id: "doc-1" }),
    );
  });

  it("one 'Add from SharePoint' button opens one picker for files and folders (decision 2)", async () => {
    actions.AddAgentFiles.mockResolvedValue({
      status: "OK",
      response: [
        { driveId: "b!d", itemId: "ITEM1", status: "added", name: "a.pdf", use: "search", ref: { kind: "document", id: "d2" } },
        { driveId: "b!d", itemId: "ITEM2", status: "rejected", name: "setup.exe", reason: "Files of type .exe cannot be added." },
      ],
    });
    render(<PersonaFiles personaId="p1" />);
    const picker = await screen.findByTestId("picker");
    expect(picker.dataset.mode).toBe("all");
    expect(picker.dataset.single).toBe("false");
    await userEvent.click(screen.getByRole("button", { name: /Add from SharePoint/ }));
    await waitFor(() =>
      expect(actions.AddAgentFiles).toHaveBeenCalledWith("p1", [
        { driveId: "b!d", itemId: "ITEM1" },
        { driveId: "b!d", itemId: "ITEM2" },
      ]),
    );
    const notAdded = await screen.findByTestId("persona-files-not-added");
    expect(notAdded).toHaveTextContent("setup.exe: Files of type .exe cannot be added.");
    expect(actions.ListAgentFiles).toHaveBeenCalledTimes(2);
  });

  it("keeps the skill upload as a small secondary link", async () => {
    actions.UploadPersonaSkill.mockResolvedValue({ status: "OK", response: { name: "brand" } });
    render(<PersonaFiles personaId="p1" />);
    const link = await screen.findByRole("button", { name: /Upload a skill zip/ });
    expect(link.tagName).toBe("BUTTON");
    const input = screen.getByTestId("persona-files-zip") as HTMLInputElement;
    const zip = new File([new Uint8Array([1, 2, 3])], "brand.zip", { type: "application/zip" });
    await userEvent.upload(input, zip);
    await waitFor(() => expect(actions.UploadPersonaSkill).toHaveBeenCalled());
    const form = actions.UploadPersonaSkill.mock.calls[0][0] as FormData;
    expect(form.get("personaId")).toBe("p1");
  });

  it("offers 'Check now' for a linked skill and 'Replace zip' for an uploaded one", async () => {
    actions.ListAgentFiles.mockResolvedValue(
      editorList([
        item({ ref: { kind: "skill", id: "s1" }, name: "brand.zip", use: "skill", allowedUses: ["skill", "code"], linkedSkill: true }),
      ]),
    );
    render(<PersonaFiles personaId="p1" />);
    await userEvent.click(await screen.findByTestId("persona-file-use"));
    expect(await screen.findByText("Check now")).toBeInTheDocument();
    expect(screen.queryByText("Replace zip")).not.toBeInTheDocument();
  });
});
