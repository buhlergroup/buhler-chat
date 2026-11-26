import { WorkspaceFileAPIEntry } from "@/features/chat-page/chat-services/copilot-runtime/workspace-file-api";

export async function GET(req: Request) {
  return await WorkspaceFileAPIEntry(req);
}
