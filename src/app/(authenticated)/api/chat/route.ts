import { ChatAPIEntry } from "@/features/chat-page/chat-services/chat-api/chat-api";
import { UserPrompt } from "@/features/chat-page/chat-services/models";
import { logDebug } from "@/features/common/services/logger";

// Allow streaming responses to run for up to 10 minutes (600 seconds)
// This is needed for long-running reasoning models
export const maxDuration = 600;

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const content = formData.get("content") as unknown as string;
    const multimodalImage = formData.get("image-base64") as unknown as string;

    const userPrompt: UserPrompt = {
      ...JSON.parse(content),
      multimodalImage,
    };

    return await ChatAPIEntry(userPrompt, req.signal);
  } catch (error) {
    logDebug("Chat route error", { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    return new Response("Internal Server Error", { status: 500 });
  }
}
