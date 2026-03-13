# Prerequisites

Before getting started, make sure the following prerequisites are in place:

1. **OpenAI API access**: You'll need access to an OpenAI-compatible API endpoint (e.g. Azure OpenAI Service) with at least one language model deployed.

2. **Database**: An instance of Cosmos DB or compatible storage for persisting chat history.

3. **Authentication**: Configure an identity provider — see the [add an identity provider](./5-add-identity.md) section for options.

> [!NOTE]
> You can configure the authentication provider to your identity solution using [NextAuth providers](https://next-auth.js.org/providers/)

## Introduction

Bühler Chat is built using the following technologies:

- [Node.js 18](https://nodejs.org/en): an open-source, cross-platform JavaScript runtime environment.

- [Next.js 13](https://nextjs.org/docs): enables you to create full-stack web applications by extending the latest React features

- [NextAuth.js](https://next-auth.js.org/): configurable authentication framework for Next.js 13

- [OpenAI SDK](https://github.com/openai/openai-node): NodeJS library that simplifies building conversational UI

- [Tailwind CSS](https://tailwindcss.com/): a utility-first CSS framework

- [shadcn/ui](https://ui.shadcn.com/): re-usable components built using Radix UI and Tailwind CSS.

- [Azure Cosmos DB](https://learn.microsoft.com/en-GB/azure/cosmos-db/nosql/): fully managed NoSQL database used to store chat history

- [Azure OpenAI](https://learn.microsoft.com/en-us/azure/ai-services/openai/overview): REST API access to OpenAI's language models

### Optional Services

The following services can be configured to expand the feature set:

- **Azure Document Intelligence**: OCR and document parsing for chat-over-file functionality.

- **Azure AI Search**: Indexing and retrieval for document search.

- **Azure OpenAI Embeddings**: Embedding content extracted from uploaded files.

- **Azure Speech Service**: Speech recognition and generation with multi-lingual support.

[Next](/docs/3-run-locally.md)
