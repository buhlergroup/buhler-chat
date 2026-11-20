import { ExtensionPage } from "@/features/extensions-page/extension-page";
import { FindAllExtensionForCurrentUser } from "@/features/extensions-page/extension-services/extension-service";
import { DisplayError } from "@/features/ui/error/display-error";

interface Props {
  searchParams: Promise<{ edit?: string | string[]; mcp?: string | string[] }>;
}

const single = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

export default async function Home(props: Props) {
  const [extensionResponse, searchParams] = await Promise.all([
    FindAllExtensionForCurrentUser(),
    props.searchParams,
  ]);

  if (extensionResponse.status !== "OK") {
    return <DisplayError errors={extensionResponse.errors} />;
  }

  return (
    <ExtensionPage
      extensions={extensionResponse.response}
      editId={single(searchParams.edit)}
      mcpResult={single(searchParams.mcp)}
    />
  );
}
