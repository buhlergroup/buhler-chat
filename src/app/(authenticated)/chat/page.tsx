import { userHashedId } from "@/features/auth-page/helpers";
import { ChatHome } from "@/features/chat-home-page/chat-home";
import { GetAgentStatsForPersonas } from "@/features/common/services/agent-stats-service";
import { FindAllNewsArticles } from "@/features/common/services/news-service/news-service";
import { FindAllExtensionForCurrentUser } from "@/features/extensions-page/extension-services/extension-service";
import { GetUserFavoriteAgents } from "@/features/persona-page/persona-services/agent-favorite-service";
import { FindAllPersonaForCurrentUser } from "@/features/persona-page/persona-services/persona-service";
import { DisplayError } from "@/features/ui/error/display-error";

export default async function Home() {
  const personasPromise = FindAllPersonaForCurrentUser();
  // Stats only for the agents this user can open.
  const agentStatsPromise = personasPromise.then((r) =>
    r.status === "OK" ? GetAgentStatsForPersonas(r.response.map((p) => p.id)) : {}
  );
  const [personaResponse, extensionResponse, newsResponse, favoriteAgentIds, currentUserId, agentStats] = await Promise.all([
    personasPromise,
    FindAllExtensionForCurrentUser(),
    FindAllNewsArticles(),
    GetUserFavoriteAgents(),
    userHashedId(),
    agentStatsPromise,
  ]);

  if (personaResponse.status !== "OK") {
    return <DisplayError errors={personaResponse.errors} />;
  }

  if (extensionResponse.status !== "OK") {
    return <DisplayError errors={extensionResponse.errors} />;
  }

  if (newsResponse.status !== "OK") {
    return <DisplayError errors={newsResponse.errors} />;
  }

  return (
    <ChatHome
      personas={personaResponse.response}
      extensions={extensionResponse.response}
      news={newsResponse.response}
      favoriteAgentIds={favoriteAgentIds}
      currentUserId={currentUserId}
      agentStats={agentStats}
    />
  );
}
