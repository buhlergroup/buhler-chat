import { HeroButton } from "@/features/ui/hero";
import { PocketKnife, Server } from "lucide-react";
import { extensionStore } from "../extension-store";

export const NewExtension = () => {
  return (
    <HeroButton
      title="New Extension"
      description="Create a new extension with your own internal API"
      icon={<PocketKnife />}
      onClick={() => extensionStore.newAndOpenSlider()}
    />
  );
};

export const NewMcpExtension = () => {
  return (
    <HeroButton
      title="Remote MCP server"
      description="Connect the tools of a remote MCP server"
      icon={<Server />}
      onClick={() => extensionStore.newAndOpenSlider("mcp")}
    />
  );
};
