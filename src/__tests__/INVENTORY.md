# Azure Chat Next.js 15 App - Testable Surfaces Inventory

**Generated:** 2026-05-15  
**Purpose:** Complete mapping of testable surfaces for Vitest unit tests + Playwright e2e tests with mocked NextAuth

---

## Table of Contents
1. [Pages & Routes](#pages--routes)
2. [Middleware & Auth Boundary](#middleware--auth-boundary)
3. [Feature Folders Analysis](#feature-folders-analysis)
4. [External Service Integration Points](#external-service-integration-points)
5. [Stream Handlers](#stream-handlers)
6. [Existing Tests](#existing-tests)

---

## Pages & Routes

### Top-Level Routes

#### Public Routes
- **`/`** (`app/page.tsx`)
  - Renders `<LogIn>` component in development mode
  - Entry point for authentication flow
  - Behavior: Shows login page if user not authenticated

- **`/health`** (`app/health/route.ts`)
  - GET handler returning `{ status: 'ok' }`
  - Health check endpoint for monitoring

#### Authentication Routes
- **`/api/auth/[...nextauth]`** (`app/(authenticated)/api/auth/[...nextauth]/route.ts`)
  - NextAuth dynamic route handler
  - Supports GitHub, Azure AD, and local dev credentials
  - Processes OAuth callbacks and JWT management

### Protected Routes (Behind `(authenticated)` Group Layout)

#### Chat Routes
- **`/chat`** (`app/(authenticated)/chat/page.tsx`) - Chat home/list
  - Server component fetching personas, extensions, news, favorites
  - Renders `<ChatHome>`
  - Data: Server actions for `FindAllPersonaForCurrentUser`, `FindAllExtensionForCurrentUser`, etc.

- **`/chat/[id]`** (`app/(authenticated)/chat/[id]/page.tsx`) - Individual chat thread
  - Dynamic route with chat thread ID parameter
  - Renders `<ChatPage>` with messages, thread, documents
  - Data: `FindAllChatMessagesForCurrentUser`, `FindChatThreadForCurrentUser`, `FindAllChatDocuments`

- **`/chat/temporary`** (`app/(authenticated)/chat/temporary/page.tsx`)
  - Temporary chat session (no history persistence)

#### Persona Routes
- **`/persona`** (`app/(authenticated)/persona/page.tsx`) - Persona/Agent list
  - Server component listing all personas/agents
  - Renders `<ChatPersonaPage>`
  - Data: `FindAllPersonaForCurrentUser`, `FindAllExtensionForCurrentUser`, `GetUserFavoriteAgents`

- **`/persona/[personaId]/chat`** (`app/(authenticated)/persona/[personaId]/chat/page.tsx`)
  - Client component (useClient) creating new chat from persona
  - Fetches persona details and initiates chat
  - Server actions: `FindPersonaByID`, `CreatePersonaChat`

- **`/persona/access-denied`** - Persona access denied page

#### Agent Routes
- **`/agent`** (`app/(authenticated)/agent/page.tsx`) - Agent list (same as personas)
- **`/agent/[personaId]/chat`** - Create chat from agent

#### Extensions Routes
- **`/extensions`** (`app/(authenticated)/extensions/page.tsx`)
  - Lists and manages extensions
  - Renders `<ExtensionPage>`
  - Supports adding, deleting, toggling extensions

#### Prompt Routes
- **`/prompt`** (`app/(authenticated)/prompt/page.tsx`)
  - Manage saved prompts
  - Renders `<PromptPage>`

#### Reporting Routes
- **`/reporting`** (`app/(authenticated)/reporting/page.tsx`)
  - Admin-only route
  - List of all chat threads (admin view)
  - Protected by `proxy.ts` requireAdmin check

- **`/reporting/chat/[id]`** (`app/(authenticated)/reporting/chat/[id]/page.tsx`)
  - View specific chat thread as admin

#### Special Routes
- **`/unauthorized`** (`app/(authenticated)/unauthorized/page.tsx`)
  - Shown when user lacks admin role for restricted pages

---

## Middleware & Auth Boundary

### Proxy/Middleware

**File:** `proxy.ts`

**Purpose:** NextAuth-based route protection and role-based access control

**Protected Paths:**
- `/chat` → requires auth
- `/api/chat` → requires auth
- `/api/images` → requires auth
- `/reporting` → requires auth + admin role
- `/unauthorized` → requires auth
- `/agent/*` → requires auth
- `/persona/*` → requires auth

**Admin Paths:**
- `/reporting` → only accessible to `token.isAdmin === true`

**Public Paths:**
- `/api/auth/...` → no auth required (login endpoint)
- `/health` → no auth required

**Redirect Logic:**
- Unauthenticated users accessing protected routes → redirect to `/`
- Non-admin users accessing `/reporting` → rewrite to `/unauthorized`
- Logged-in users accessing `/` → redirect to `/chat`

### Auth Helpers

**File:** `features/auth-page/helpers.ts`

**Exported Functions:**
- `userSession()` → Returns current `UserModel` or null (uses `getServerSession`)
- `getCurrentUser()` → Throws if user not found; used in server actions
- `userHashedId()` → Returns SHA256 hash of user email (used for data isolation)
- `hashValue(value: string)` → Pure hash function
- `redirectIfAuthenticated()` → Redirects authenticated users to /chat

**User Model:**
```typescript
type UserModel = {
  name: string;
  image: string;
  email: string;
  isAdmin: boolean;
  token: string;
  isLocalDevUser: boolean;
}
```

### NextAuth Configuration

**File:** `features/auth-page/auth-api.ts`

**Providers Configured:**
1. **Azure AD** (production) - requires `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, `AZURE_AD_TENANT_ID`
2. **GitHub** (optional) - requires `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`
3. **Credentials** (dev only) - username/password, email suffix `@localhost`

**Admin Detection:**
- Via `ADMIN_EMAIL_ADDRESS` env var (comma-separated emails)

**JWT & Token Refresh:**
- Uses JWT strategy
- Azure AD: automatic refresh token handling
- Token expiry: from provider or default 1 hour

---

## Feature Folders Analysis

### 1. auth-page

**Location:** `features/auth-page/`

#### Server Actions
- `helpers.ts` — `userSession()`, `getCurrentUser()`, `userHashedId()`, `redirectIfAuthenticated()`

#### Components
- `login.tsx` — Login UI component
- `auth-api.ts` — NextAuth configuration (not a server action, but auth boundary)
- `logout-on-session-expired.ts` — Session expiration handler

#### Test Surface
- Mock `getServerSession` to test user fetching
- Test email hashing consistency
- Test admin role assignment from env var

---

### 2. chat-home-page

**Location:** `features/chat-home-page/`

#### Components (Client/Server)
- `chat-home.tsx` — Main home page component
- `changelog.tsx` — Display changelog
- `news-article.tsx` — Display news items

#### Dependencies
- Uses data from server actions: `FindAllPersonaForCurrentUser`, `FindAllExtensionForCurrentUser`, `FindAllNewsArticles`

#### Test Surface
- Test component rendering with personas/extensions/news data
- Test favorite agent highlighting

---

### 3. chat-page

**Location:** `features/chat-page/`

This is the largest feature folder with complex state management and streaming.

#### Server Actions (use server)

**Chat Thread Management:**
- `chat-services/chat-thread-service.ts`
  - `FindAllChatThreadForCurrentUser()` → SQL query chat threads for user
  - `FindChatThreadForCurrentUser(id)` → Get specific thread
  - `UpsertChatThread(thread)` → Create/update thread
  - `DeleteChatThread(id)` → Soft delete thread
  - `UpdateChatTitle(threadId, title)` → Update thread name
  - `UpdateChatThreadSelectedModel(threadId, model)` → Switch model mid-thread
  - `UpdateChatThreadReasoningEffort(threadId, effort)` → Change reasoning effort
  - `AddExtensionToChatThread(threadId, extensionId)` → Attach extension
  - `RemoveExtensionFromChatThread(threadId, extensionId)` → Detach extension
  - `UpdateChatThreadUsage(threadId, inputTokens, outputTokens, cachedTokens, costUsd, cacheWriteTokens, lastPromptTokens)` → Track token usage. The first five are TURN TOTALS (summed over every step of the turn — what was billed); `lastPromptTokens` is the different quantity, the size of the turn's LAST prompt, which is what the context row and the compaction decision read
  - `EnsureChatThreadOperation(threadId)` → Validates thread ownership

**Chat Messages:**
- `chat-services/chat-message-service.ts`
  - `FindTopChatMessagesForCurrentUser(threadId, top)` → Newest N rows (default 30). NOT used by the chat path any more — the row cap made the prompt prefix slide on every turn past row 30
  - `FindAllChatMessagesForCurrentUser(threadId)` → The whole thread, `createdAt ASC`, then put into a total order by `sortHistoryRowsDeterministically`. This is what the chat path loads
  - `CreateChatMessage(message)` → Save new message
  - `UpsertChatMessage(message)` → Create/update message
  - `DeleteChatMessage(messageId)` → Soft delete message

**History Ordering:**
- `chat-services/chat-history-order.ts`
  - `sortHistoryRowsDeterministically(rows)` — Total order over `(createdAt, sequence, id)`. `ORDER BY createdAt` alone is not total: parallel tool calls persist in the same millisecond and Cosmos leaves their order undefined, so two reads of one thread could differ and move the prompt prefix
  - **Tests:** `chat-services/chat-history-order.test.ts` (Vitest)

**Chat Documents:**
- `chat-services/chat-document-service.ts`
  - `FindAllChatDocuments(threadId)` → List attached documents, `ORDER BY createdAt ASC` so the names in the prompt cannot reshuffle
  - `DeleteAllChatDocuments(threadId)` → Remove documents from thread

**Code Interpreter:**
- `chat-services/code-interpreter-service.ts`
  - `UploadFileForCodeInterpreter(file)` → Send file to OpenAI
  - `DownloadFileFromCodeInterpreter(fileId)` → Retrieve output
  - `DeleteFileFromCodeInterpreter(fileId)` → Clean up

**Chat Images:**
- `chat-services/chat-image-service.ts`
  - `UploadImageToStore(threadId, fileName, imageData)` → Store image in Azure Blob
  - `GetImageFromStore(threadId, fileName)` → Retrieve image
  - `GetImageUrl(threadId, fileName)` → Generate access URL

**Azure AI Search Integration:**
- `chat-services/azure-ai-search/azure-ai-search.ts`
  - `SimpleSearch(searchText, filter)` → Search documents
  - `InsertChatDocumentWithEmbedding(doc)` → Index document with embedding
  - `DeleteDocumentsOfChatThread(threadId)` → Remove thread docs from search
  - `FindSimilarDocumentsForThread(threadId, query, top)` → RAG search
  - `UpdateSearchIndexEmbedding(docId, embedding)` → Reindex doc

**Chat Menu Service:**
- `chat-menu/chat-menu-service.ts`
  - `RenameChatMenu(threadId, newName)` → Rename thread
  - `DeleteChatMenu(threadId)` → Delete thread

**Citation/Action:**
- `citation/citation-action.tsx`
  - `CopyToClipboard(text)` — Copy to clipboard
  - `SaveCitationArticle(url)` — Save article reference

**Speech Service:**
- `chat-input/speech/speech-service.ts`
  - `TextToSpeech(text, voice)` — Generate speech audio
  - `SpeechToText(audioData)` — Transcribe audio

#### API Routes (POST/GET)

**Chat API:**
- `app/(authenticated)/api/chat/route.ts` (POST)
  - Handles user messages
  - Returns SSE stream of AI responses
  - Calls `ChatAPIEntry()` which streams `ChatAPIResponse`
  - Max duration: 10 minutes (for reasoning models)

**Images API:**
- `app/(authenticated)/api/images/route.ts` (GET)
  - Serves uploaded images from blob storage
  - Calls `ImageAPIEntry()`

**Code Interpreter Upload:**
- `app/(authenticated)/api/code-interpreter/upload/route.ts` (POST)
  - Validates file type and size (max 512MB)
  - Calls `UploadFileForCodeInterpreter()`
  - Returns `{ id, name }`

**Code Interpreter File Retrieval:**
- `app/(authenticated)/api/code-interpreter/file/[fileId]/route.ts` (GET)
  - Downloads processed file from OpenAI

**Document Search:**
- `app/(authenticated)/api/document/route.ts` (POST)
  - Calls `SearchAzureAISimilarDocuments()`

#### Pure Helpers / Utilities

**Prompt Building (with tests):**
- `chat-services/chat-api/prompt-builder.ts`
  - `buildSystemMessage(inputs)` — Assembles the cache-stable developer message: `staticSystemPrompt → personaMessage → trailingStaticBlock → documentHint`
  - `isoDate(now)` — ISO-8601 date formatting (locale-independent)
  - `sortFunctionTools(tools)` — Sorts tools by name for cache key stability
  - `withAnthropicPromptCache(system, messages)` — Two `cache_control` breakpoints (system prefix + latest turn) for the Azure /anthropic Messages API; always applied, since Claude caches nothing without one
  - `withPromptCacheBreakpoint(system, messages)` — The same provider-neutral "the reusable prefix ends here" breakpoint in the Responses-seam wire form (`providerOptions.openai.promptCacheBreakpoint {mode:"explicit"}`); gated by `PROMPT_CACHE_PERSONA_BREAKPOINT`, which is a no-op on Anthropic
  - **Tests:** `chat-services/chat-api/prompt-builder.test.ts` (Vitest)

**Compaction Notice (with tests):**
- `chat-services/chat-api/compaction-part.ts` — Pure, client-safe. The `data-compaction` wire contract shared by the route, the transcript and the thread loader, plus the copy derived from it
  - `compactionRunningPart` / `compactionDonePart` — Both phases, one stable part id so a later write replaces the earlier notice
  - `threadCompactionMarker(row)` / `compactionMarkerPlacement({marker, messages})` — The persisted divider: what it renders, and the message it is drawn after (`coversThroughMessageId`), with the turn count derived from the transcript
  - `compactionNoticeText` / `compactionMarkerText` / `formatTokenCount` — The words on screen
  - **Tests:** `chat-services/chat-api/compaction-part.test.ts` (Vitest)
- `chat-page/compaction-notice.tsx` — `CompactionNotice` (streamed part: running / done / trimmed-without-summary) and `CompactionMarker` (persisted divider). Muted centred row, `Collapsible` "Show summary"
  - **Tests:** `chat-page/compaction-notice.test.tsx` (Vitest + testing-library)

**History Budget & Summarisation (with tests):**
- `chat-services/chat-api/history-budget.ts` — Pure. Turn segmentation, watermark, and the compaction decision. **Nothing is estimated:** the decision has ONE input, the provider's measured size of the previous request's last prompt (`ThreadUsage.lastPromptTokens` — the LAST step's `inputTokens`, never the all-steps roll-up). Over budget compacts the history and the thread starts again; there is no target, no per-turn token accounting and no tokenizer heuristic anywhere in the path
  - `estimateTextTokens` — the only estimator left, and it decides nothing: the summary writer stamps an informational size on the row it persists
  - `splitIntoTurns(messages)` — A turn opens at every user row; carries the index span and no token figure
  - `applyHistoryWatermark(messages, coversThroughMessageId)` — Makes a compaction stick instead of sliding forward a turn per turn
  - `planHistoryTrim(messages, { budget, minKeptTurns, measuredPromptTokens })` — The compaction decision. `measuredPromptTokens > budget` → drop everything before the newest `minKeptTurns` turns. Self-correcting: the next request measures the result, so a compaction that was not enough simply compacts again
  - `resolveHistoryBudget(input)` — The whole budget decision, with the source of every number for logging: base budget (env `HISTORY_TOKEN_BUDGET` > per-model `historyTokenBudget` > 256 000 default) bounded by the model guard (`longContextThresholdTokens − reserve`, else 60 % of `contextWindow`, else none)
  - `resolveHistoryTokenBudget` / `resolveHistoryLongContextReserve` / `resolveHistoryProtectedTurns` — The effective budget only, the reserve (`HISTORY_LONG_CONTEXT_RESERVE`, default 16 000), and the protected-turn count (`HISTORY_PROTECTED_TURNS`, **default 0** — every persisted turn is eligible; the current user message is not in these rows at all)
  - `skipReason` says why a thread was left alone: `"no-measurement"` (a first turn, or a row written before `lastPromptTokens` — nothing is compacted and no summariser call is spent), `"under-budget"` (the ordinary case), `"nothing-droppable"` (over budget with no history to compact — an oversized current message cannot be helped, because the current turn is never droppable)
  - **Tests:** `chat-services/chat-api/history-budget.test.ts` (Vitest)
- `chat-services/chat-api/history-summary.ts` — Pure. Row shape, summariser prompt, replay text
  - **Tests:** `chat-services/chat-api/history-summary.test.ts` (Vitest)
- `chat-services/chat-api/history-summary-service.ts` — Cosmos read/write of the compaction row plus the summariser call (injectable; unit tests never reach a model). Gated by `HISTORY_SUMMARY_ENABLED`. `resolveHistorySummaryModel` picks a MODEL (`HISTORY_SUMMARY_DEPLOYMENT_NAME` > the thread's own model > terra > luna > titles) and the call goes through `resolveProvider` + `generateText` — the same seam as the chat route, because the legacy Azure chat-completions client 404s on the 5.6 deployments. Reports `historySummaryTokens`; never touches the user's cost cap. Every failure is a reason code (`ok`/`off`/`failed`/`timeout`/`no-deployment`) on the row and on the UI part
  - `FindChatHistorySummary` / `UpsertChatHistorySummary` / `SoftDeleteChatHistorySummary`
  - `recordHistoryCompaction(input)` — Advances the watermark; summarises when enabled
  - **Tests:** `chat-services/chat-api/history-summary-service.test.ts` (Vitest)
- **Append-only invariant:** `chat-services/chat-api/__tests__/history-append-only.test.ts` — The model-message list for turn n must be an exact item-by-item prefix of turn n+1 (developer message included). Compaction is the only sanctioned exception
- **Step-layout seam:** the same suite also pins the join between the two halves of this change set — `stepLayout` and `sequence`, written by `persist-assistant.ts`, must survive `FindAllChatMessagesForCurrentUser` and replay through `message-adapter.ts` in the live step shape, and the `CHAT_HISTORY_SUMMARY` row must stay invisible to both

**Utilities:**
- `chat-services/utils.ts`
  - `mapOpenAIChatMessages(messages)` — Converts internal format to OpenAI format
  - Citation/source mapping functions

**Models:**
- `chat-services/models.ts`
  - `ChatModel` type (gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini)
  - `MODEL_CONFIGS` record with pricing, context window, reasoning support
  - `ChatThreadModel`, `ChatMessageModel`, `ChatDocumentModel`, `AttachedFileModel`
  - `UserPrompt`, `AzureChatCompletion` response types
  - `DEFAULT_MODEL` = "gpt-5.5"

**Constants:**
- `chat-services/code-interpreter-constants.ts`
  - `CODE_INTERPRETER_SUPPORTED_EXTENSIONS` — .py, .js, .csv, etc.

#### Stream Handlers

**SSE / Streaming Responses:**
- `chat-services/chat-api/chat-api-response.ts` — Main streaming handler
  - Calls AI, yields tokens, handles function calls
  - Persists messages to Cosmos
  - Tracks token usage
  - Returns `Response` with `ReadableStream`

- `chat-services/chat-api/openai-responses-stream.ts`
  - `OpenAIResponsesStream()` — Processes OpenAI streaming chunks
  - Handles reasoning content, function calls, citations
  - Accumulates text, publishes SSE events

- `chat-services/chat-api/chat-api-text.tsx` — Text response handler

**Function Registry & Tool Execution:**
- `chat-services/chat-api/function-registry.ts`
  - `getAvailableFunctions()` — Build tool list for request
  - `executeFunction(name, args)` — Call registered tool
  - `registerDynamicFunction(name, fn)` — Add tool dynamically
  - `buildSubAgentTool()` — Create nested agent tool

**Conversation Manager:**
- `chat-services/chat-api/conversation-manager.ts`
  - `createConversationState()` — Initialize state machine
  - `startConversation()` — Begin multi-turn conversation
  - `continueConversation()` — Resume from previous state
  - `processFunctionCall()` — Execute tool and integrate result

#### State Management

**Chat Store (Valtio):**
- `chat-store.tsx`
  - `ChatState` class with messages, loading, phase, input, autoScroll
  - Server action calls integrated via useSnapshot
  - Form submission handling

#### Stores & Input Management
- `chat-input/file/file-store.ts` — File attachment tracking
- `chat-input/prompt/input-prompt-store.ts` — Prompt history store
- `features/ui/chat/chat-input-area/input-image-store.ts` — Image upload tracking

#### React Components (with Logic)

**Chat Components with Non-Trivial Logic:**
- `chat-page.tsx` — Main chat UI orchestrator
  - Conditional rendering of message area, input, headers
  - Calls `ChatAPIEntry` on submit
  - Handles message streaming via SSE

- `chat-header/chat-header.tsx` — Thread metadata display
- `chat-header/model-selector.tsx` — Model picker with conditional rendering
- `chat-header/context-window-indicator.tsx` — Token usage display
- `chat-header/persona-detail.tsx` — Show attached persona
- `chat-header/extension-detail.tsx` — Show attached extensions
- `chat-input/tool-toggles.tsx` — Enable/disable extensions
- `chat-input/reasoning-effort-selector.tsx` — Choose reasoning level
- `chat-menu/chat-menu.tsx` — Chat list sidebar
- `chat-menu/new-chat.tsx` — Create new conversation

#### Default Extensions
- `chat-services/chat-api/chat-api-default-extensions.ts`
  - Registers default tools (web search, code interpreter, document search)

#### RAG Extension
- `chat-services/chat-api/chat-api-rag-extension.ts`
  - Document RAG pipeline with Azure AI Search

#### Image Persistence
- `chat-services/chat-image-persistence-service.ts` — Save images across messages
- `chat-services/chat-image-persistence-utils.ts` — Image processing helpers

#### Test Surface
- Mock OpenAI API and streaming
- Test function registry with dynamic functions
- Test conversation state machine transitions
- Test Azure AI Search integration
- Test Cosmos DB queries (user isolation via userHashedId)
- Test code interpreter file upload validation
- Test model selection and fallback logic
- Test token usage tracking
- Test message deduplication in streaming

---

### 4. common

**Location:** `features/common/`

#### Server Actions

**Navigation:**
- `navigation-helpers.ts` (use server)
  - `RevalidateCache(page, params, type)` → ISR via `revalidatePath`
  - `RedirectToPage(path)` → Server-side redirect
  - `RedirectToChatThread(chatThreadId)` → Navigate to specific chat

**Usage & Metrics:**
- `services/usage-service.ts` (use server)
  - `GetDailyUsage()` → Token/cost usage for today
  - `GetWeeklyUsage()` → 7-day usage breakdown
  - `CheckLimits(userId, model)` → Verify daily token/cost limits, suggest fallback
  - `IncrementUsage(userId, model, tokens, cost)` → Log usage

**Chat Metrics:**
- `services/chat-metrics-service.ts` (use server)
  - `reportUserChatMessage(threadId, userId)` → Log user chat activity
  - `reportPromptTokens(model, tokens)` → Log input tokens
  - `reportCompletionTokens(model, tokens)` → Log output tokens

#### Pure Helpers / Utilities

**Schema Validation:**
- `schema-validation.ts`
  - `refineFromEmpty(value)` → Zod refinement for non-empty strings

**Server Action Response Types:**
- `server-action-response.ts`
  - `ServerActionResponse<T>` union type (OK | ERROR | NOT_FOUND | UNAUTHORIZED)
  - `zodErrorsToServerActionErrors(errors)` → Convert Zod errors to API errors

**Error Codes:**
- `error-codes.ts` — Application error code constants

**Utilities:**
- `util.ts`
  - `uniqueId()` → Generate 36-char random ID (nanoid)
  - `sortByTimestamp(a, b)` → Sort chat threads by `lastMessageAt`

**Navigation:**
- `navigation-helpers.ts` — `RevalidateCache`, `RedirectToPage`, `RedirectToChatThread`

#### Azure Service Integrations

**Cosmos DB:**
- `services/cosmos.ts`
  - `CosmosInstance()` → Singleton CosmosClient
  - `HistoryContainer()` → Chat history container
  - `ConfigContainer()` → Config container for prompts/personas/extensions

**Azure Storage Blobs:**
- `services/azure-storage.ts`
  - `GetBlob(container, path)` → Retrieve blob
  - `UploadBlob(container, path, buffer, options)` → Store blob
  - Used for image persistence

**Azure Key Vault:**
- `services/key-vault.ts`
  - `AzureKeyVaultInstance()` → Get secret values
  - Used for extension secure headers

**Azure Search:**
- `services/ai-search.ts`
  - `AzureAISearchInstance()` → Search client
  - `AzureAISearchIndexClientInstance()` → Index client
  - Used for RAG document search

**Azure Credentials:**
- `services/azure-default-credential.ts`
  - `getAzureDefaultCredential()` → AAD auth via DefaultAzureCredential

**OpenAI / LLM:**
- `services/openai.ts`
  - `OpenAIV1Instance()` → Standard OpenAI client (Responses API)
  - `OpenAIV1ReasoningInstance()` → Reasoning-enabled client
  - `OpenAIEmbeddingInstance()` → Embeddings for RAG

**Document Intelligence:**
- `services/document-intelligence.ts`
  - Parse PDFs, images, Office docs for RAG

**Microsoft Graph:**
- `services/microsoft-graph-client.ts`
  - Access SharePoint, OneDrive for document sources

**News Service:**
- `services/news-service/news-service.ts` (use server)
  - `FindAllNewsArticles()` — Fetch latest changelog/news

**Chat Token Service:**
- `services/chat-token-service.ts`
  - Token counting for context window estimation

**Logging:**
- `services/logger.ts`
  - `logDebug()`, `logInfo()`, `logWarn()`, `logError()`
  - Integrates with Application Insights

#### Hooks

**useResetableActionState:**
- `hooks/useResetableActionState.ts`
  - Wrapper around `useActionState` with reset capability

**useProfilePicture:**
- `hooks/useProfilePicture.ts` — Fetch user's profile picture

#### Components

**Info Modal:**
- `info-modal.tsx` — Global info/notification modal

**Display Error:**
- `ui/error/display-error.tsx` — Render error messages

#### Test Surface
- Mock Azure services (Cosmos, Storage, Search, KeyVault)
- Mock OpenAI API
- Test usage tracking and limit enforcement
- Test error code constants
- Test navigation helpers (redirect, revalidate)
- Test ID generation uniqueness
- Test schema validation refinements
- Test Zod error conversion

---

### 5. extensions-page

**Location:** `features/extensions-page/`

#### Server Actions

**Extension Service:**
- `extension-services/extension-service.ts` (use server)
  - `FindExtensionByID(id)` → Get single extension
  - `FindAllExtensionForCurrentUser()` → List user's extensions
  - `FindAllExtensionForCurrentUserAndIds(ids)` → Get specific extensions
  - `CreateExtension(model)` → Create new extension
  - `UpdateExtension(id, model)` → Modify extension
  - `PublishExtension(id)` → Admin action to publish
  - `DeleteExtension(id)` → Soft delete
  - `FindSecureHeaderValue(extensionId, headerId)` → Retrieve masked secret from Key Vault
  - Validates admin status for publish

#### Models
- `extension-services/models.ts`
  - `ExtensionModel` — OpenAPI spec, headers, functions, execution steps
  - `ExtensionModelSchema` — Zod validation
  - Function and header definitions

#### React Components

**Extension Page:**
- `extension-page.tsx` — Main extensions UI

**Extension Cards:**
- `extension-card/extension-card.tsx` — Display individual extension
- `extension-card/extension-context-menu.tsx` — Edit/delete actions
- `extension-card/start-new-extension-chat.tsx` — Begin chat with extension

**Add Extension:**
- `add-extension/add-new-extension.tsx` — Form to create extension
- `add-extension/add-function.tsx` — Add function/endpoint
- `add-extension/endpoint-header.tsx` — Header management
- `add-extension/error-messages.tsx` — Validation error display

**Extension Hero:**
- `extension-hero/extension-hero.tsx` — Welcome section
- `extension-hero/new-extension.tsx` — New extension quick button
- `extension-hero/ai-search-issues.tsx` — Debug Azure Search status
- `extension-hero/bing-search.tsx` — Built-in Bing extension

#### Store
- `extension-store.ts` — Valtio store for extension selection

#### Test Surface
- Test extension CRUD operations
- Test OpenAPI spec validation
- Test header masking (Key Vault integration)
- Test conditional rendering for admin vs. user
- Test extension-to-thread attachment/detachment
- Mock Azure Key Vault secret retrieval

---

### 6. globals

**Location:** `features/globals/`

#### Global State
- `global-message-store.tsx` — Toast/notification state (Valtio)
  - `showError(message)`, `showSuccess(message)`, `showInfo(message)`

#### Providers
- `providers.tsx` — Wraps app with React providers (Valtio, etc.)

#### Test Surface
- Test global message store mutations
- Test provider initialization

---

### 7. main-menu

**Location:** `features/main-menu/`

#### React Components

- `main-menu.tsx` — Left sidebar with navigation
- `menu-link.tsx` — Individual navigation link
- `menu-store.tsx` — Store for menu open/close state
- `menu-tray.tsx` — Mobile menu drawer
- `menu-tray-toggle.tsx` — Menu open/close button
- `theme-toggle.tsx` — Dark/light mode switch
- `user-profile.tsx` — User info, profile picture
- `user-usage.tsx` — Display daily token usage

#### Test Surface
- Test navigation link generation
- Test theme toggle persistence
- Test user profile display with mocked session
- Test usage widget with mocked API response

---

### 8. persona-page

**Location:** `features/persona-page/`

#### Server Actions

**Persona Service:**
- `persona-services/persona-service.ts` (use server)
  - `CreatePersona(input)` → Create new persona/agent
  - `UpdatePersona(id, input)` → Modify persona
  - `FindPersonaByID(id)` → Get single persona
  - `FindAllPersonaForCurrentUser()` → List user's personas
  - `FindAllPublishedPersonas()` → Get global personas
  - `DeletePersona(id)` → Soft delete
  - `PublishPersona(id)` → Admin action
  - `CreatePersonaChat(personaId)` → Create chat thread with persona
  - Validates user access via access groups

**Access Groups:**
- `persona-services/access-group-service.ts` (use server)
  - `AccessGroupById(groupId)` → Get access group
  - `UserAccessGroups()` → List groups for current user
  - `CreateAccessGroup(name, description)` → New group
  - `DeleteAccessGroup(groupId)` → Remove group
  - `AddUserToAccessGroup(groupId, userId)` → Grant access

**Persona Documents (SharePoint):**
- `persona-services/persona-documents-service.ts` (use server)
  - `FindPersonaDocuments(personaId)` → List attached documents
  - `UpdateOrAddPersonaDocuments(personaId, docs)` → Add/update documents
  - `DeletePersonaDocumentsByPersonaId(personaId)` → Remove all documents
  - Fetches from SharePoint via Microsoft Graph

**Persona Documents (Code Interpreter):**
- `persona-services/persona-ci-documents-service.ts` (use server)
  - `PersonaCIDocumentsByIds(docIds)` → Get CI files
  - `DownloadSharePointFile(fileUrl)` → Download file content

**Agent Favorite Service:**
- `persona-services/agent-favorite-service.ts` (use server)
  - `ToggleFavoriteAgent(agentId)` → Star/unstar
  - `GetUserFavoriteAgents()` → List favorited agents

#### Models
- `persona-services/models.ts`
  - `PersonaModel` — Agent definition with system message, extensions, access groups
  - `PersonaModelSchema` — Zod validation

#### React Components

**Persona Page:**
- `persona-page.tsx` — Main personas UI

**Persona Cards:**
- `persona-card/persona-card.tsx` — Display persona
- `persona-card/persona-view.tsx` — Read-only view
- `persona-card/persona-context-menu.tsx` — Edit/delete/publish
- `persona-card/copy-to-clipboard-button.tsx` — Copy persona ID
- `persona-card/favorite-agent-button.tsx` — Toggle favorite
- `persona-card/start-new-persona-chat.tsx` — Begin chat with persona
- `persona-card/persona-visibility-info.tsx` — Show access level

**Add Persona:**
- `add-new-persona.tsx` — Form to create persona

**Persona Documents:**
- `persona-documents/persona-documents.tsx` — Document list
- `persona-documents/sharepoint-file-picker.tsx` — Browse SharePoint
- `persona-documents/code-interpreter-file-picker.tsx` — Pick CI files

**Access Groups:**
- `persona-access-group/persona-access-group.tsx` — Access control UI
- `persona-access-group/persona-access-group-selector.tsx` — Picker

**Persona Hero:**
- `persona-hero/persona-hero.tsx` — Welcome/help section

**Agent List:**
- `agent-list.tsx` — Special view for agents only

#### Store
- `persona-store.ts` — Valtio store for persona selection

#### Test Surface
- Test persona CRUD with admin/user roles
- Test access group authorization
- Test SharePoint document fetching
- Test favorite toggle
- Test persona-to-thread creation
- Mock Microsoft Graph for SharePoint
- Mock Cosmos DB persona queries with user isolation

---

### 9. prompt-page

**Location:** `features/prompt-page/`

#### Server Actions

**Prompt Service:**
- `prompt-service.ts` (use server)
  - `CreatePrompt(model)` → Create reusable prompt
  - `UpdatePrompt(id, model)` → Modify prompt
  - `FindPromptByID(id)` → Get single prompt
  - `FindAllPromptForCurrentUser()` → List user's prompts
  - `FindAllPublishedPrompts()` → Get global prompts
  - `DeletePrompt(id)` → Soft delete
  - `PublishPrompt(id)` → Admin action

#### Models
- `models.ts`
  - `PromptModel` — Prompt with name, description, content, isPublished
  - `PromptModelSchema` — Zod validation

#### React Components

- `prompt-page.tsx` — Main prompts UI
- `prompts.tsx` — Prompt list component
- `prompt-card.tsx` — Individual prompt display
- `prompt-card-context-menu.tsx` — Edit/delete/publish
- `add-new-prompt.tsx` — Form to create prompt
- `prompt-hero/prompt-hero.tsx` — Welcome section

#### Store
- `prompt-store.ts` — Valtio store for prompt editing

#### Test Surface
- Test prompt CRUD
- Test publish action (admin only)
- Test Cosmos DB prompt queries

---

### 10. reporting-page

**Location:** `features/reporting-page/`

#### Server Actions

**Reporting Service:**
- `reporting-services/reporting-service.ts`
  - `FindAllChatThreadsForAdmin(limit, offset)` → Paginated chat list for admins
  - Authorization check: must be `isAdmin`

#### React Components

- `reporting-page.tsx` — Admin reporting dashboard
- `reporting-chat-page.tsx` — View specific chat as admin
- `reporting-hero.tsx` — Reporting welcome section
- `table-row.tsx` — Chat row in admin table

#### Test Surface
- Test admin authorization check
- Test pagination of chat threads
- Mock admin user role in tests

---

### 11. theme

**Location:** `features/theme/`

#### Configuration

- `theme-config.ts`
  - `AI_NAME` — Application name from env
  - `CHAT_DEFAULT_PERSONA` — Default agent ID
  - `CHAT_DEFAULT_SYSTEM_PROMPT` — System prompt template
  - `NEW_CHAT_NAME` — Default new chat title

- `theme-provider.tsx` — Theme context provider
- `customise.ts` — Tailwind/CSS customization

#### Test Surface
- Test theme configuration loading
- Test theme provider context setup

---

### 12. ui

**Location:** `features/ui/` (Pure Presentational Components)

This folder contains shadcn/ui and custom UI primitives. Most are pure presentational and require minimal testing.

#### Components to Skip in Testing
- `button.tsx`, `card.tsx`, `dialog.tsx`, `dropdown-menu.tsx` — Standard UI primitives
- `input.tsx`, `textarea.tsx`, `select.tsx` — Form inputs
- `tabs.tsx`, `accordion.tsx` — Layout components
- `badge.tsx`, `avatar.tsx` — Display primitives
- `loading.tsx`, `page-loader.tsx` — Loading indicators

#### Components with Logic Worth Testing

**Markdown Rendering:**
- `markdown/markdown.tsx` — Renders MDX content
- `markdown/code-block.tsx` — Syntax highlighting, copy button
- `markdown/markdown-context.tsx` — Markdown context provider

**Chat Components:**
- `chat/chat-message-area/chat-message-area.tsx` — Message list with scrolling
- `chat/chat-message-area/chat-message-container.tsx` — Message wrapper
- `chat/chat-message-area/chat-message-content.tsx` — Message content dispatch
- `chat/chat-message-area/use-chat-scroll-anchor.tsx` — Auto-scroll hook
- `chat/chat-input-area/internet-search.tsx` — Web search toggle

**Error Display:**
- `error/display-error.tsx` — Error rendering from ServerActionResponse

**Documents:**
- `persona-documents/document-item.tsx` — Document display
- `persona-documents/error-document-item.tsx` — Error state

**Citation:**
- `markdown/citation.tsx` — Inline citation display
- `markdown/citation-slider.tsx` — Citation carousel

#### Store
- `chat/chat-input-area/input-image-store.ts` — Image upload state
- `use-toast.ts` — Toast hook

#### Test Surface
- Mock markdown rendering
- Test error display format
- Test scroll anchor behavior
- Test citation formatting

---

## External Service Integration Points

### Azure Services

**Cosmos DB** (Primary database)
- Used in: chat-thread-service, chat-message-service, persona-service, prompt-service, extension-service, reporting-service
- Containers: `history` (chats), `config` (personas/prompts/extensions)
- User isolation: via `userHashedId()`
- Test strategy: Mock `HistoryContainer()` and `ConfigContainer()`

**Azure Blob Storage**
- Used in: chat-image-service, chat-image-persistence-service
- Container: `images`
- Test strategy: Mock `GetBlob()` and `UploadBlob()`

**Azure Key Vault**
- Used in: extension-service (secure headers)
- Test strategy: Mock `AzureKeyVaultInstance()`

**Azure AI Search**
- Used in: azure-ai-search.ts, chat-api-rag-extension.ts
- Index: documents with embeddings
- Test strategy: Mock search client and index client

**Document Intelligence**
- Used in: document parsing for RAG
- Test strategy: Mock API calls

**Microsoft Graph**
- Used in: persona-documents-service (SharePoint access)
- Test strategy: Mock Graph client

### OpenAI / Azure OpenAI

**Completions API** (main LLM)
- Used in: chat-api-response.ts, openai-responses-stream.ts
- Models: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini
- Test strategy: Mock streaming response

**Embeddings API**
- Used in: azure-ai-search.ts
- Test strategy: Mock embedding vectors

**Files API** (Code Interpreter)
- Used in: code-interpreter-service.ts
- Test strategy: Mock file upload/download

**Reasoning API** (o1 models)
- Used in: chat-api-response.ts when reasoning_effort is set
- Test strategy: Mock reasoning response

### External APIs

**News Service**
- Fetches changelog/announcements
- Test strategy: Mock HTTP response

**Bing Search** (Built-in extension)
- Web search results
- Test strategy: Mock search results

---

## Stream Handlers

### SSE (Server-Sent Events) / Streaming Responses

**Main Streaming Entry Point:**
- `POST /api/chat` → calls `ChatAPIEntry()` → streams `ChatAPIResponse()`

**Stream Processing:**
1. `ChatAPIResponse` orchestrates the AI call
2. `openai-responses-stream.ts` consumes `Stream<Responses.ResponseStreamEvent>`
3. Each chunk is processed and SSE-encoded
4. Client receives events via EventSource

**Events Emitted:**
- `text` — Token-by-token response
- `reasoning` — Thinking content (for reasoning models)
- `function_call` — Tool invocation
- `function_result` — Tool output integration
- `citation` — Source reference
- `complete` — Conversation finished

**Handling Function Calls:**
- Tool execution via `executeFunction()`
- Result integration back into conversation
- Multi-turn tool use supported

**State Machine:**
- `ConversationState` tracks:
  - Current phase (idle → submitted → streaming → complete)
  - Accumulated text/reasoning
  - Function call history
  - Context window usage

### Test Surface
- Mock OpenAI streaming response
- Test SSE event formatting
- Test function call execution and integration
- Test conversation state transitions
- Test error handling in streaming (e.g., abort)
- Test token counting and accumulation

---

## Existing Tests

### Current Test Files

1. **`features/chat-page/chat-services/chat-api/prompt-builder.test.ts`**
   - Uses Vitest
   - Tests: `buildSystemMessage()`, `isoDate()`, `sortFunctionTools()`
   - Focus: byte-for-byte stability for Azure OpenAI prompt cache keys
   - Pattern: Pure function tests, no mocks
   - **Test Cases:**
     - Idempotency across calls
     - Cache key stability
     - Input-output correlation
     - Field ordering

### Recommended Test Framework Setup

**Unit Tests (Vitest):**
- Location: Colocate with source files (`.test.ts`)
- Scope: Pure functions, server actions with mocked services
- Mocking: Mock all external services (Cosmos, OpenAI, Azure)
- Coverage: Utilities, business logic, validation

**E2E Tests (Playwright):**
- Location: `__tests__/e2e/`
- Scope: Full user flows (login, chat, persona creation)
- Setup: Mock NextAuth session, API responses
- Coverage: Navigation, forms, streaming, error states

**Integration Tests (Vitest):**
- Location: `__tests__/integration/`
- Scope: Multiple services together (e.g., chat + usage tracking)
- Mocking: Mock external APIs, keep internal interactions real

---

## Test Recommendations by Feature

### High Priority (Core Features)

1. **Chat API** (`chat-services/chat-api/`)
   - Mock OpenAI streaming
   - Test function registry and execution
   - Test conversation state transitions
   - Test token usage tracking

2. **Authentication** (`auth-page/`, `proxy.ts`)
   - Mock NextAuth session
   - Test user isolation via userHashedId
   - Test admin role authorization
   - Test redirect logic

3. **Server Actions** (all services)
   - Mock Cosmos DB queries
   - Test user isolation checks
   - Test Zod validation
   - Test error responses

4. **File Upload** (`code-interpreter-service.ts`, API route)
   - Mock OpenAI Files API
   - Test file validation (type, size)
   - Test error handling

### Medium Priority

5. **Personas & Access Groups** (`persona-page/`)
   - Mock SharePoint/Microsoft Graph
   - Test access control
   - Test document fetching

6. **Extensions** (`extensions-page/`)
   - Mock Key Vault for secure headers
   - Test OpenAPI spec validation
   - Test function execution

7. **Reporting** (`reporting-page/`)
   - Test admin-only access
   - Test pagination

### Lower Priority (Pure UI)

8. **Components** (UI folder)
   - Test markdown rendering
   - Test error display
   - Test conditional rendering in complex components

---

## Mock Strategy Template

```typescript
// Mock NextAuth Session
vi.mock('next-auth', () => ({
  getServerSession: vi.fn().mockResolvedValue({
    user: {
      name: 'Test User',
      email: 'test@example.com',
      image: 'https://example.com/avatar.jpg',
      isAdmin: false,
      accessToken: 'fake_token',
      isLocalDevUser: false,
    },
  }),
}));

// Mock Cosmos DB
vi.mock('@/features/common/services/cosmos', () => ({
  HistoryContainer: vi.fn().mockReturnValue({
    items: {
      query: vi.fn().mockReturnValue({
        fetchAll: vi.fn().mockResolvedValue({
          resources: [/* mock data */],
        }),
      }),
      create: vi.fn().mockResolvedValue({ resource: /* mock */ }),
    },
  }),
}));

// Mock OpenAI
vi.mock('@/features/common/services/openai', () => ({
  OpenAIV1Instance: vi.fn().mockReturnValue({
    chat: {
      completions: {
        create: vi.fn().mockReturnValue(/* mock stream */),
      },
    },
  }),
}));
```

---

## Directory Structure for Tests

```
src/__tests__/
├── INVENTORY.md (this file)
├── unit/
│   ├── auth/
│   │   ├── helpers.test.ts
│   │   └── auth-api.test.ts
│   ├── chat/
│   │   ├── prompt-builder.test.ts (existing)
│   │   ├── chat-api-response.test.ts
│   │   ├── function-registry.test.ts
│   │   └── conversation-manager.test.ts
│   ├── persona/
│   │   ├── persona-service.test.ts
│   │   └── access-group-service.test.ts
│   ├── extensions/
│   │   └── extension-service.test.ts
│   ├── common/
│   │   ├── util.test.ts
│   │   ├── navigation-helpers.test.ts
│   │   └── usage-service.test.ts
│   └── prompts/
│       └── prompt-service.test.ts
├── e2e/
│   ├── auth.e2e.ts
│   ├── chat.e2e.ts
│   ├── persona.e2e.ts
│   └── extensions.e2e.ts
├── mocks/
│   ├── nextauth.mock.ts
│   ├── cosmos.mock.ts
│   ├── openai.mock.ts
│   ├── azure-storage.mock.ts
│   └── graph-client.mock.ts
└── fixtures/
    ├── chat-threads.json
    ├── personas.json
    └── users.json
```

---

## Key Files Summary (Quick Reference)

| Category | File Path | Primary Export |
|----------|-----------|-----------------|
| Auth Helper | `features/auth-page/helpers.ts` | `userSession()`, `getCurrentUser()`, `userHashedId()` |
| Auth Config | `features/auth-page/auth-api.ts` | `options`, `handlers` |
| Middleware | `proxy.ts` | `proxy()` function |
| Chat Thread | `features/chat-page/chat-services/chat-thread-service.ts` | `FindAllChatThreadForCurrentUser()`, `UpsertChatThread()` |
| Chat Messages | `features/chat-page/chat-services/chat-message-service.ts` | `FindTopChatMessagesForCurrentUser()`, `CreateChatMessage()` |
| Chat API | `features/chat-page/chat-services/chat-api/chat-api.ts` | `ChatAPIEntry()` |
| Streaming | `features/chat-page/chat-services/chat-api/openai-responses-stream.ts` | `OpenAIResponsesStream()` |
| Persona | `features/persona-page/persona-services/persona-service.ts` | `CreatePersona()`, `FindAllPersonaForCurrentUser()` |
| Extensions | `features/extensions-page/extension-services/extension-service.ts` | `CreateExtension()`, `FindAllExtensionForCurrentUser()` |
| Prompts | `features/prompt-page/prompt-service.ts` | `CreatePrompt()`, `FindAllPromptForCurrentUser()` |
| Usage | `features/common/services/usage-service.ts` | `GetDailyUsage()`, `CheckLimits()` |
| Models | `features/chat-page/chat-services/models.ts` | `MODEL_CONFIGS`, `ChatModel`, `ChatThreadModel`, `DEFAULT_MODEL`, `resolveDefaultModel()` |
| Provider seam | `features/chat-page/chat-services/models/provider-seam.ts` | `resolveProvider()` — model + built-in tools + providerOptions |
| Prompt-cache key | `features/chat-page/chat-services/models/prompt-cache-key.ts` | `resolvePromptCacheKey()`, `toolsetSignature()`, `shardForUser()` |
| Reasoning effort | `features/chat-page/chat-services/models/reasoning-effort.ts` | `resolveReasoningEffort()`, `parseReasoningEffortOverrides()` |
| Tool order | `features/chat-page/chat-services/tools/stabilize-toolset.ts` | `stabilizeToolset()`, `compareByCodepoint()` |
| Code-interpreter container | `features/chat-page/chat-services/code-interpreter-container.ts` | `ensureCodeInterpreterContainer()` |
| Usage / cost | `features/chat-page/chat-services/chat-api/usage-data.ts` | `computeTokenCostUsd()`, `computeRequestUsage()` — keeps TURN TOTALS (billing, the cache split) apart from `lastPromptTokens` (the context figure) and carries `stepCount` |
| AI Search | `features/chat-page/chat-services/azure-ai-search/azure-ai-search.ts` | `SimpleSearch()`, `InsertChatDocumentWithEmbedding()` |
| Cosmos | `features/common/services/cosmos.ts` | `HistoryContainer()`, `ConfigContainer()` |

---

**Report Generated:** May 15, 2026
**Scope:** Complete Next.js 15 app with Cosmos DB, OpenAI Responses API, Azure AI Search, NextAuth
**Status:** Ready for test case generation
