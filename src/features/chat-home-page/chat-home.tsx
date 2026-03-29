"use client";

import { ExtensionModel } from "@/features/extensions-page/extension-services/models";
import { AgentList } from "@/features/persona-page/agent-list";
import { AddNewPersona } from "@/features/persona-page/add-new-persona";
import { PersonaModel } from "@/features/persona-page/persona-services/models";
import { AI_DESCRIPTION, AI_NAME } from "@/features/theme/theme-config";
import { Hero } from "@/features/ui/hero";
import { ScrollArea } from "@/features/ui/scroll-area";
import Image from "next/image";
import { FC, useState } from "react";
import { NewsArticleModel } from "@/features/common/services/news-service/news-model";
import { NewsArticle } from "./news-article";
import { Button } from "../ui/button";
import { ExternalLink, House, Logs } from "lucide-react";
import { Changelog } from "./changelog";

interface ChatPersonaProps {
  personas: PersonaModel[];
  extensions: ExtensionModel[];
  news: NewsArticleModel[];
  favoriteAgentIds: string[];
  currentUserId: string;
}

const FeedbackButton = ({ feedBackLink }: { feedBackLink: string }) => (
  <Button
    variant="ghost"
    className="flex items-center gap-3"
    onClick={() => window.open(feedBackLink, "_blank")}
  >
    <ExternalLink className="h-5 w-5" />
    Report Feedback
  </Button>
);

const HomeButton = ({ onClick }: { onClick: () => void }) => (
  <Button variant="ghost" className="flex items-center gap-3" onClick={onClick}>
    <House className="h-5 w-5" />
    <p>Home</p>
  </Button>
);

const ChangelogButton = ({ onClick }: { onClick: () => void }) => (
  <Button variant="ghost" className="gap-3" onClick={onClick}>
    <Logs className="h-5 w-5" />
    <p>Changelog</p>
  </Button>
);

const ChangelogSection = ({
  setShowChangelog,
}: {
  setShowChangelog: (arg0: boolean) => void;
}) => (
  <div>
    <div className="flex justify-between">
      <h2 className="text-2xl font-bold mb-3">Changelog</h2>
      <div className="flex gap-2">
        {process.env.NEXT_PUBLIC_FEEDBACK_LINK && (
          <FeedbackButton
            feedBackLink={process.env.NEXT_PUBLIC_FEEDBACK_LINK}
          />
        )}
        <HomeButton onClick={() => setShowChangelog(false)} />
      </div>
    </div>
    <Changelog />
  </div>
);

const ArticlesSection = ({
  news,
  setShowChangelog,
}: {
  news: NewsArticleModel[];
  setShowChangelog: (arg0: boolean) => void;
}) => (
  <div>
    <div className="flex justify-between">
      <h2 className="text-2xl font-bold mb-3">Articles</h2>
      <div className="flex gap-2">
        {process.env.NEXT_PUBLIC_FEEDBACK_LINK && (
          <FeedbackButton
            feedBackLink={process.env.NEXT_PUBLIC_FEEDBACK_LINK}
          />
        )}
        <ChangelogButton onClick={() => setShowChangelog(true)} />
      </div>
    </div>
    <div className="space-y-4">
      {news && news.length > 0 ? (
        news.map((newsArticle) => (
          <NewsArticle newsArticle={newsArticle} key={newsArticle.id} />
        ))
      ) : (
        <p className="text-muted-foreground max-w-xl">No current news</p>
      )}
    </div>
  </div>
);

export const ChatHome: FC<ChatPersonaProps> = ({ personas, extensions, news, favoriteAgentIds, currentUserId }) => {
  const [showChangelog, setShowChangelog] = useState<boolean>(false);

  return (
    <ScrollArea className="flex-1 px-3">
      <main className="flex flex-1 flex-col gap-6 pb-6">
        <Hero
          title={
            <>
              <Image
                src={"/ai-icon.png"}
                width={60}
                height={60}
                quality={100}
                alt="ai-icon"
              />{" "}
              {AI_NAME}
            </>
          }
          description={AI_DESCRIPTION}
        />
        <div className="container max-w-4xl flex gap-20 flex-col">
          {showChangelog ? (
            <ChangelogSection setShowChangelog={setShowChangelog} />
          ) : (
            <>
              <ArticlesSection
                news={news}
                setShowChangelog={setShowChangelog}
              />
              <AgentList
                personas={personas}
                initialFavoriteIds={favoriteAgentIds}
                currentUserId={currentUserId}
              />
            </>
          )}
        </div>
        <AddNewPersona extensions={extensions} personas={personas} />
      </main>
    </ScrollArea>
  );
};
