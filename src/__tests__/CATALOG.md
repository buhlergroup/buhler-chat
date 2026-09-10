# Azure Chat — Test Case Catalog

**Generated:** 2026-05-15
**Source inventory:** `__tests__/INVENTORY.md`
**Style reference:** `features/chat-page/chat-services/chat-api/prompt-builder.test.ts`
**Setup:** `__tests__/setup.ts` (NextAuth + `next/navigation` + env vars already mocked)

This catalog enumerates concrete test cases for an implementation agent. It does **not** prescribe assertion syntax — assertions are described in plain English with the observable behavior. IDs are stable; implementers should preserve them so this catalog can be cross-checked.

---

## Table of Contents

- [auth-page](#auth-page)
- [common — util & schema validation](#common--util--schema-validation)
- [common — navigation helpers](#common--navigation-helpers)
- [common — usage service](#common--usage-service)
- [common — server-action-response](#common--server-action-response)
- [common — services/cosmos & key-vault wiring](#common--services-cosmos--key-vault-wiring)
- [theme — theme-config](#theme--theme-config)
- [chat-page — prompt-builder](#chat-page--prompt-builder)
- [chat-page — history budget, ordering & summarisation](#chat-page--history-budget-ordering--summarisation)
- [chat-page — chat-thread-service](#chat-page--chat-thread-service)
- [chat-page — chat-message-service](#chat-page--chat-message-service)
- [chat-page — chat-document-service](#chat-page--chat-document-service)
- [chat-page — chat-image-service](#chat-page--chat-image-service)
- [chat-page — chat-image-persistence-utils](#chat-page--chat-image-persistence-utils)
- [chat-page — code-interpreter-service](#chat-page--code-interpreter-service)
- [chat-page — code-interpreter-constants](#chat-page--code-interpreter-constants)
- [chat-page — citation-service](#chat-page--citation-service)
- [chat-page — utils (mapOpenAIChatMessages)](#chat-page--utils-mapopenaichatmessages)
- [chat-page — chat-menu-service](#chat-page--chat-menu-service)
- [chat-page — azure-ai-search](#chat-page--azure-ai-search)
- [chat-page — function-registry & conversation-manager](#chat-page--function-registry--conversation-manager)
- [chat-page — openai-responses-stream (SSE)](#chat-page--openai-responses-stream-sse)
- [chat-page — chat components](#chat-page--chat-components)
- [chat-home-page](#chat-home-page)
- [persona-page — persona-service](#persona-page--persona-service)
- [persona-page — access-group-service](#persona-page--access-group-service)
- [persona-page — agent-favorite-service](#persona-page--agent-favorite-service)
- [persona-page — components](#persona-page--components)
- [prompt-page — prompt-service](#prompt-page--prompt-service)
- [prompt-page — components](#prompt-page--components)
- [extensions-page — extension-service](#extensions-page--extension-service)
- [extensions-page — components](#extensions-page--components)
- [reporting-page — reporting-service](#reporting-page--reporting-service)
- [main-menu — components](#main-menu--components)
- [globals — message store](#globals--message-store)
- [ui — markdown / citations / code-block](#ui--markdown--citations--code-block)
- [API routes — /api/chat](#api-routes--apichat)
- [API routes — /api/code-interpreter/upload](#api-routes--apicode-interpreterupload)
- [API routes — /api/code-interpreter/file/[fileId]](#api-routes--apicode-interpreterfilefileid)
- [API routes — /api/document](#api-routes--apidocument)
- [API routes — /api/images](#api-routes--apiimages)
- [API routes — /health](#api-routes--health)
- [Middleware — proxy.ts](#middleware--proxyts)
- [E2E — Playwright journeys](#e2e--playwright-journeys)
- [Summary](#summary)
- [Mocking matrix](#mocking-matrix)
- [Known untestable / deferred](#known-untestable--deferred)

---

## auth-page

Target file: `features/auth-page/helpers.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| auth-page.unit.helpers.001 | helpers.ts | `hashValue` is deterministic SHA-256 hex | unit | — | Call `hashValue("test@example.com")` twice; compare to a precomputed digest | Both calls return the same 64-char lowercase hex string equal to the precomputed digest of `"test@example.com"` |
| auth-page.unit.helpers.002 | helpers.ts | `hashValue` is collision-stable for whitespace differences | unit | — | Call `hashValue("a@b.com")` vs `hashValue(" a@b.com")` | Different digests (whitespace is significant); confirms no trimming happens |
| auth-page.unit.helpers.003 | helpers.ts | `userSession` returns mapped UserModel when getServerSession resolves | unit | Default setup mock: `getServerSession` returns `test@example.com` non-admin | Call `userSession()` | Returns `{ name, image, email, isAdmin: false, token: "test-access-token", isLocalDevUser: undefined }` (NOT null) |
| auth-page.unit.helpers.004 | helpers.ts | `userSession` returns null when no session | unit | `mockReturnValueOnce` on `getServerSession` → `null` | Call `userSession()` | Returns `null` |
| auth-page.unit.helpers.005 | helpers.ts | `userSession` returns null when session has no `.user` | unit | Override session to `{ expires: "..." }` (no user) | Call `userSession()` | Returns `null` |
| auth-page.unit.helpers.006 | helpers.ts | `getCurrentUser` throws when no session | unit | Override `getServerSession` → `null` | Call `getCurrentUser()` | Rejects with `Error("User not found")` |
| auth-page.unit.helpers.007 | helpers.ts | `getCurrentUser` returns user when authenticated | unit | Default mock | Call `getCurrentUser()` | Resolves with UserModel matching session |
| auth-page.unit.helpers.008 | helpers.ts | `userHashedId` hashes the session email | unit | Default mock (`test@example.com`) | Call `userHashedId()` | Returns `hashValue("test@example.com")` (assert via independent SHA-256) |
| auth-page.unit.helpers.009 | helpers.ts | `userHashedId` throws when no session | unit | `getServerSession` → null | Call `userHashedId()` | Rejects with `Error("User not found")` |
| auth-page.unit.helpers.010 | helpers.ts | `redirectIfAuthenticated` redirects logged-in users to /chat | unit | Default mock; `next/navigation` `redirect` already throws `NEXT_REDIRECT:` per setup | Call `redirectIfAuthenticated()` | Throws `NEXT_REDIRECT:/chat` (via `RedirectToPage("chat")`) |
| auth-page.unit.helpers.011 | helpers.ts | `redirectIfAuthenticated` is a no-op for anon users | unit | `getServerSession` → null | Call `redirectIfAuthenticated()` | Resolves without throwing; `redirect` mock not called |

---

## common — util & schema validation

Targets: `features/common/util.ts`, `features/common/schema-validation.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| common.unit.util.001 | util.ts | `uniqueId` returns a 36-char id from the documented alphabet | unit | — | Call `uniqueId()` once | Length is 36; every char ∈ `[0-9A-Za-z]` |
| common.unit.util.002 | util.ts | `uniqueId` produces no collisions in 10k draws | unit | — | Generate 10000 ids into a Set | `Set.size === 10000` |
| common.unit.util.003 | util.ts | `sortByTimestamp` sorts by `lastMessageAt` descending | unit | — | Sort `[{lastMessageAt: 2024-01-01}, {lastMessageAt: 2024-06-01}, {lastMessageAt: 2024-03-01}]` | Output order: 2024-06, 2024-03, 2024-01 |
| common.unit.util.004 | util.ts | `sortByTimestamp` is stable for equal timestamps | unit | — | Sort two threads with identical `lastMessageAt` | Returns 0 → original relative order preserved by `Array.prototype.sort` (V8 stable) |
| common.unit.schema.001 | schema-validation.ts | `refineFromEmpty` accepts empty string (paired with `min(1)` upstream) | unit | — | `refineFromEmpty("")` | Returns `true` |
| common.unit.schema.002 | schema-validation.ts | `refineFromEmpty` rejects whitespace-only | unit | — | `refineFromEmpty("   ")` | Returns `false` |
| common.unit.schema.003 | schema-validation.ts | `refineFromEmpty` accepts content with internal whitespace | unit | — | `refineFromEmpty("a b")` | Returns `true` |

---

## common — navigation helpers

Target: `features/common/navigation-helpers.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| common.unit.nav.001 | navigation-helpers.ts | `RevalidateCache` without params revalidates `/{page}` | unit | Setup mock for `next/cache.revalidatePath` | Call `RevalidateCache({page: "chat"})` | `revalidatePath` called with `("/chat", undefined)` |
| common.unit.nav.002 | navigation-helpers.ts | `RevalidateCache` with params revalidates `/{page}/{params}` and forwards type | unit | Same | Call `RevalidateCache({page: "persona", params: "abc", type: "layout"})` | `revalidatePath` called with `("/persona/abc", "layout")` |
| common.unit.nav.003 | navigation-helpers.ts | `RedirectToPage` redirects to `/{page}` | unit | Setup mock for `next/navigation.redirect` throws `NEXT_REDIRECT:` | Call `RedirectToPage("agent")` | Throws `NEXT_REDIRECT:/agent` |
| common.unit.nav.004 | navigation-helpers.ts | `RedirectToChatThread` redirects to `/chat/:id` | unit | Same | Call `RedirectToChatThread("thread-1")` | Throws `NEXT_REDIRECT:/chat/thread-1` |

---

## common — usage service

Target: `features/common/services/usage-service.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| common.unit.usage.001 | usage-service.ts | `GetOrCreateDailyUsage` returns existing doc when found | unit | Cosmos mock: `HistoryContainer().item(docId, userId).read` returns existing `UserUsageModel` with matching type | Call `GetOrCreateDailyUsage("uid-1", "2026-05-15")` | Returns the existing resource |
| common.unit.usage.002 | usage-service.ts | `GetOrCreateDailyUsage` returns synthetic doc when not found (does not write) | unit | `read` throws | Call `GetOrCreateDailyUsage("uid-1", "2026-05-15")` | Returns `{id: "uid-1-usage-2026-05-15", totalInputTokens: 0, …}`; no `upsert` call |
| common.unit.usage.003 | usage-service.ts | `IncrementUsage` accumulates per-model and totals | integration | Cosmos mock: returns existing doc with model `gpt-5.4` `{inputTokens:10,outputTokens:5,…requestCount:1}` | Call `IncrementUsage("u","gpt-5.4",2,3,1,0.5)` | `items.upsert` called with model totals `(12,8,4,…requestCount:2)` and document totals incremented by `(2,3,1,0.5)` |
| common.unit.usage.004 | usage-service.ts | `IncrementUsage` swallows Cosmos errors (logs only) | unit | `upsert` rejects | Call `IncrementUsage(...)` | Resolves without throwing |
| common.unit.usage.005 | usage-service.ts | `CheckLimits` returns `{exceeded:false}` when model has no limits | unit | Use a model id without `dailyTokenLimit`/`dailyCostLimit` (e.g. `gpt-5.4-mini`) | Call `CheckLimits("u","gpt-5.4-mini")` | `{exceeded:false}` |
| common.unit.usage.006 | usage-service.ts | `CheckLimits` returns `exceeded:true,limitType:"tokens"` when token limit hit | unit | Override `MODEL_CONFIGS` (or use a model already configured with a dailyTokenLimit; otherwise mock the config) so target model has `dailyTokenLimit: 1000, fallbackModel: "gpt-5.4-mini"`; Cosmos returns usage with model totals input+output ≥ 1000 | Call `CheckLimits` | `{exceeded:true, limitType:"tokens", currentUsage, limit:1000, fallbackModel:"gpt-5.4-mini"}` |
| common.unit.usage.007 | usage-service.ts | `CheckLimits` returns `exceeded:true,limitType:"cost"` when cost limit hit | unit | Similar to .006 but `dailyCostLimit: 1.0` | Cosmos returns `modelUsage.costUsd >= 1.0` → call `CheckLimits` | `{exceeded:true, limitType:"cost", currentUsage, limit:1.0, fallbackModel}` |
| common.unit.usage.008 | usage-service.ts | `CheckLimits` returns false when no usage row exists yet for that model | unit | Cosmos returns doc but `models[model]` missing | Call `CheckLimits` | `{exceeded:false}` |
| common.unit.usage.009 | usage-service.ts | `GetWeeklyUsage` queries with `userId` partitionKey and `>= weekAgo` | integration | Cosmos mock capturing query args | Call `GetWeeklyUsage("uid-1")` | Query parameters include `@userId="uid-1"`, `@startDate=<today-7>`; partitionKey was `"uid-1"` |
| common.unit.usage.010 | usage-service.ts | `GetDailyUsage` defaults `userId` to `userHashedId()` | unit | Default session mock | Call `GetDailyUsage()` | Result is the doc created/read for hashed `test@example.com` (assert partition key / doc id) |

---

## common — server-action-response

Target: `features/common/server-action-response.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| common.unit.sar.001 | server-action-response.ts | `zodErrorsToServerActionErrors` strips Zod issue down to `{message}` | unit | — | Pass `[{message:"x",path:["a"],code:"custom"}]` | Returns `[{message:"x"}]` |
| common.unit.sar.002 | server-action-response.ts | `zodErrorsToServerActionErrors` handles empty array | unit | — | Pass `[]` | Returns `[]` |

---

## common — services/cosmos & key-vault wiring

Targets: `features/common/services/cosmos.ts`, `features/common/services/key-vault.ts`. These are thin singletons — we test that the right env vars are read once.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| common.unit.cosmos.001 | services/cosmos.ts | `HistoryContainer` returns container named from `AZURE_COSMOSDB_CONTAINER_NAME` | unit | Mock `@azure/cosmos` `CosmosClient` to record `database().container(name)` | Import & call `HistoryContainer()` | `container("history")` is the name used (matches env in setup.ts) |
| common.unit.cosmos.002 | services/cosmos.ts | `ConfigContainer` reads `AZURE_COSMOSDB_CONFIG_CONTAINER_NAME` | unit | Same | Call `ConfigContainer()` | `container("config")` |
| common.unit.cosmos.003 | services/cosmos.ts | `CosmosInstance` is a singleton across calls | unit | Spy on `CosmosClient` constructor | Call `CosmosInstance()` twice | Constructor called exactly once |
| common.unit.kv.001 | services/key-vault.ts | `AzureKeyVaultInstance` constructs `SecretClient` with `https://<AZURE_KEY_VAULT_NAME>.vault.azure.net` | unit | Mock `@azure/keyvault-secrets` to capture endpoint | Call `AzureKeyVaultInstance()` | Endpoint contains `test-kv` (from setup env) |

---

## theme — theme-config

Target: `features/theme/theme-config.ts`. Tiny surface, but useful as a guard against accidental env defaults changing.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| theme.unit.config.001 | theme-config.ts | `AI_NAME` reads `NEXT_PUBLIC_AI_NAME` env, defaults to a non-empty fallback | unit | Override env in `vi.stubEnv` | Re-import module | When env unset → falls back to documented default; when set → reflects override |
| theme.unit.config.002 | theme-config.ts | `NEW_CHAT_NAME` is a non-empty string | unit | — | Import | `NEW_CHAT_NAME.length > 0` |

---

## chat-page — prompt-builder

**EXISTING TESTS** at `features/chat-page/chat-services/chat-api/prompt-builder.test.ts`. The cases below are gap-fills, not replacements.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.prompt-builder.001 | prompt-builder.ts | `buildSystemMessage` empty persona produces no trailing dangling marker | unit | — | Build with `personaMessage: ""` | Result ends with `"\n\n"` and contains no double trailing whitespace beyond what's documented |
| chat-page.unit.prompt-builder.002 | prompt-builder.ts | `buildSystemMessage` is whitespace-stable across unicode persona content | unit | — | Two equivalent NFC-normalized vs NFD-normalized persona strings | Output is byte-identical iff inputs are byte-identical (NOT NFC-normalized internally) |
| chat-page.unit.prompt-builder.003 | prompt-builder.ts | `sortFunctionTools` is stable for equal names | unit | — | Two tools with same `name` and distinguishable `description` | Their relative order preserved |
| chat-page.unit.prompt-builder.004 | prompt-builder.ts | `sortFunctionTools` sorts case-sensitively via localeCompare | unit | — | `["B","a","C"]` | Order is `localeCompare` order (not strict codepoint) |
| chat-page.unit.prompt-builder.005 | prompt-builder.ts | `isoDate` rejects invalid date by returning "Invalid Date" slice / handle NaN | unit | — | Call `isoDate(new Date("not-a-date"))` | Either throws or returns `"Invalid Date"` consistently; document chosen behavior |
| chat-page.unit.prompt-builder.006 | prompt-builder.ts | (property) Concatenation order: static < today < hint < persona for any inputs | property-style | — | 50 randomized strings | Invariant holds for all combinations |

---

## chat-page — history budget, ordering & summarisation

Targets: `features/chat-page/chat-services/chat-api/history-budget.ts`,
`history-summary.ts`, `history-summary-service.ts`,
`features/chat-page/chat-services/chat-history-order.ts`, and the history
handling in `chat-api/thread-context.ts`.

Background. The chat path used to load history with `SELECT TOP 30 … ORDER BY
createdAt DESC`. Past row 30 every turn pushed the oldest row out of the
window, which moved the first byte of the prompt after the developer message:
the prompt shrank on 20 % of turn pairs and the prompt-cache hit rate fell from
80 % to 30 %. The chat path now loads the whole thread and caps it by estimated
tokens, cutting only at turn boundaries and only when over budget, then down to
60 % of budget in one block so the prefix holds still for dozens of turns.

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.history-budget.001 | history-budget.ts | `estimateTextTokens` is deterministic (chars/4 rounded up) and decides NOTHING: it only stamps an informational size on a persisted summary row. The trim path has no estimator at all | unit | — | Estimate the same text 25 times; check the rounding boundaries | One distinct value; `""`/undefined → 0, `"a"` → 1, 4 000 chars → 1 000 |
| chat-page.unit.history-budget.002 | history-budget.ts | `splitIntoTurns` opens a turn at every user row and keeps its tool/assistant rows with it; rows before the first user row form a trimmable preamble; a turn carries its index span and no token figure | unit | — | Split mixed rows | Turn boundaries on user rows; `isPreamble` only for the leading block; `startIndex`/`endIndex` only |
| chat-page.unit.history-budget.003 | history-budget.ts | ONE measured number decides: the provider's size of the previous request's last prompt. No measurement → nothing happens; at or under budget → nothing happens; the size of the rows is never consulted | unit | — | Plan with no measurement, with 0/-1/NaN, at exactly budget, one over, and twice with the same measurement over wildly different histories | `skipReason` "no-measurement" / "under-budget"; `trimmed:false` at exactly budget and `true` one token over; identical plans for a 2-turn and a 200-turn thread |
| chat-page.unit.history-budget.004 | history-budget.ts | Over budget compacts the history and the thread starts again: the whole history goes to the summariser by default, and a configured tail is kept on a turn boundary | unit | — | Plan a 40-turn thread with a 20 000-token measurement against a 10 000 budget, with and without `minKeptTurns` | `kept` empty by default; with a tail, `dropped ++ kept` reconstructs the input, the first kept row is a user row, no tool row is orphaned, and the watermark is the newest dropped row |
| chat-page.unit.history-budget.005 | history-budget.ts | Hysteresis needs no arithmetic: after a compaction the provider measures the small new prompt, and the thread stays quiet until the measurement passes the budget again | unit | — | Compact, then append small turns while the measurement climbs 500 a turn from 3 000 | No further compaction while under budget; exactly 14 quiet turns before the next one |
| chat-page.unit.history-budget.006 | history-budget.ts | `MIN_KEPT_TURNS` is 0, so the expensive newest turn is compacted along with the rest; `HISTORY_PROTECTED_TURNS` restores a protected tail and keeps exactly that many turns | unit | — | Plan the 15k-paste shape, then with `minKeptTurns` 2 and 5 | Whole history dropped by default; the newest N turns kept verbatim when configured |
| chat-page.unit.history-budget.007 | history-budget.ts | `applyHistoryWatermark` drops rows up to and including the watermark, fails open when the watermark row is gone, and keeps the retained span fixed as the thread grows | unit | — | Apply a watermark across five appended turns | Same first retained row every turn (the prefix does not move); missing watermark returns everything |
| chat-page.unit.history-budget.008 | history-budget.ts | `resolveHistoryTokenBudget` precedence: `HISTORY_TOKEN_BUDGET` > model config > 256 000 default; unusable values ignored, fractions floored | unit | — | Resolve with each combination | Env wins; `""`/`abc`/`0`/`-5` ignored rather than honoured |
| chat-page.unit.history-budget.010 | history-budget.ts | The long-context guard: effective budget = min(configured, model guard), guard = `longContextThresholdTokens − reserve` else 60 % of `contextWindow` else no guard; reserve 16 000 from `HISTORY_LONG_CONTEXT_RESERVE` | unit | — | Resolve for a 272k threshold, a 128k window, an oversized env value, a 32k reserve, and a reserve larger than the threshold | 272k → 256 000; 128k window → 76 800; env 900 000 → capped to 256 000; reserve 32 000 → 240 000; guard ≤ 0 discarded so the configured budget stands |
| chat-page.unit.history-budget.011 | history-budget.ts | The measurement is compared with the EFFECTIVE budget, not the configured one | unit | — | Configure 900 000, guard down to 76 800 with a 128k window, then plan a 90 000 and a 70 000 measurement | `plan.budget` 76 800; 90 000 compacts, 70 000 does not |
| chat-page.unit.usage-panel.001 | chat-header/token-usage-display.tsx | The panel quotes the provider only: cumulative row renamed "Thread usage so far", a cache row splitting the last request into reads/writes/plain, and a context row reading "17,527 of 1.1M · 1.7 %" with no "~" anywhere | unit | jsdom, store mocked | Open the panel for a request with 17,527 input / 12,400 read / 5,100 write | "reads 12,400 · writes 5,100 · plain 27"; writes omitted when the persisted row never recorded them; plain floored at 0 |
| chat-page.unit.usage-panel.002 | chat-header/token-usage-display.tsx | The panel says which numbers are turn totals and which is the last prompt, so a 3-step turn does not read as a contradiction | unit | jsdom, store mocked | Open the panel for 99 000 billed input over a 35 000-token last prompt | "(last request, all steps)", "Input (all steps)", "Cache (all steps)"; the context row shows "35,000 of 1.1M" and never 99,000 |
| chat-page.unit.usage-panel.003 | chat-header/token-usage-display.tsx | The step count is shown when the turn made more than one model call — that is what explains totals bigger than the context figure | unit | same | Open the panel with `stepCount: 3` | A "Model calls" row reading "3 steps" |
| chat-page.unit.usage-panel.004 | chat-header/token-usage-display.tsx | No step row for a plain one-call turn, and none when the count is unknown (negative) | unit | same | `stepCount: 1`, then no `stepCount` at all (a thread seeded from persisted usage) | The row is absent both times |
| chat-page.unit.usage-panel.005 | chat-header/token-usage-display.tsx | A row written before `lastPromptTokens` existed falls back to the turn total for the context figure | unit | same | Open the panel with `inputTokens` only | Context row reads "17,527 of 1.1M" |
| chat-page.unit.usage-panel.006 | chat-header/token-usage-display.tsx | The cache row keeps reads + writes + plain equal to the TURN's input total | unit | same | 99 000 input with 60 000 read + 20 000 write | "reads 60,000 · writes 20,000 · plain 19,000" |
| chat-page.unit.compaction-part.001 | compaction-part.ts | Both phases of the notice carry the same part id (so the second write replaces the first), and the done part omits the summary fields and the watermark rather than sending undefined | unit | — | Build a running and a done part | `data-compaction`, id `compaction`; `summaryText`/`summaryModel`/`coversThroughMessageId` absent when there is no summary |
| chat-page.unit.compaction-part.002 | compaction-part.ts | One line per reason code, and token labels that round (184k, 96k) and never render junk | unit | — | Format running plus each of the five outcomes, and a NaN/negative token count | "Compacting older messages…" / "Compacted 12 older turns into a summary (184k → 96k tokens)" / "(no summary, feature off)" / "(summary failed, see server log)" / "(summary timed out)" / "(no summarizer deployment)"; singular kept singular |
| chat-page.unit.compaction-part.003 | compaction-part.ts | The persisted marker keeps only what the divider renders; an empty summary is still a marker but carries no model label; no watermark means no marker | unit | — | Narrow a row with, and without, content | `{coversThroughMessageId, summaryText?, summaryModel?}`; null without a watermark |
| chat-page.unit.compaction-part.004 | compaction-part.ts | The divider's position IS the summary row's `coversThroughMessageId`, and the turn count is derived from the transcript; a watermark row that is gone draws nothing (fail open) | unit | — | Place against a 6-row transcript, then a deleted watermark | `{afterMessageId:"a2", trimmedTurns:2}`; null when the row is missing |
| chat-page.unit.message-adapter.compaction | chat-api/message-adapter.ts | A `data-compaction` part is dropped, never persisted: a row would come back as history and reach the model's prompt | unit | — | Round-trip an assistant message carrying the part | Rows equal the originals; no "compaction" anywhere in them |
| chat-page.unit.compaction-notice.001 | compaction-notice.tsx | The running state shows the line and a spinner, with nothing to expand | unit | jsdom, testing-library | Render a `running` part | "Compacting older messages…" + Loader; no "Show summary" |
| chat-page.unit.compaction-notice.002 | compaction-notice.tsx | The done state names turns and tokens, stops spinning, and expands/hides the summary with the model that wrote it | unit | same | Render a `done` part and click the toggle | "Compacted 12 older turns into a summary (184k → 96k tokens)"; summary text and "Summary by terra-dep" appear, then hide |
| chat-page.unit.compaction-notice.003 | compaction-notice.tsx | Each no-summary reason code renders its own line, with no toggle and no spinner (negative) | unit | same | Render `off` / `failed` / `timeout` / `no-deployment` | The four matching lines; never "feature off" for a summariser that broke |
| chat-page.unit.compaction-notice.004 | compaction-notice.tsx | The persisted marker marks where the model's view of the conversation starts, with and without a summary | unit | same | Render `CompactionMarker` | "Conversation compacted here · 12 older turns" / "· 1 older turn" |
| chat-page.unit.history-budget.012 | history-budget.ts | A compaction that cannot help is not taken: declined when every turn is protected, and declined for an oversized current message with no history behind it (the current turn is never droppable) | unit | — | Plan with `minKeptTurns` covering every turn, then an empty history with a 600 000 measurement | `skipReason` "nothing-droppable", nothing dropped, no summariser call |
| chat-page.unit.history-budget.013 | history-budget.ts | The LAST STEP's prompt size is the only trigger, never the all-steps roll-up. The live regression from the dev log of 2026-09-10T06:54:11Z: 285 647 was a 2-step sum, the real prompt was ~142 800, budget 256 000 | unit | — | Plan the same 13-turn thread with 142 800, then with 285 647, then with 300 000 | 142 800 → "under-budget", nothing dropped, no notice; 285 647 → compacts (the defect); 300 000 → compacts; a fractional measurement is floored |
| chat-page.unit.history-order.001 | chat-history-order.ts | `createdAt` is the primary sort key, accepted as Date, ISO string or epoch millis; an unparseable value sorts to the front rather than making the sort unstable | unit | — | Sort mixed shapes and a corrupt row | Oldest-first; corrupt row first, same order both directions |
| chat-page.unit.history-order.002 | chat-history-order.ts | Rows sharing a `createdAt` millisecond (parallel tool calls) break the tie on `sequence`, which stays subordinate to `createdAt` | unit | — | Sort four permutations of four tied rows | All permutations collapse to one order |
| chat-page.unit.history-order.003 | chat-history-order.ts | Without `sequence`, `id` is the final tie-breaker, compared by code point (not locale); a missing `sequence` counts as 0; the sort is idempotent and non-mutating | unit | — | Sort tied rows with and without `sequence` | Total, locale-independent, repeatable order |
| chat-page.unit.history-summary.001 | history-summary.ts | The compaction row uses its own Cosmos `type`, so every `CHAT_MESSAGE` query is blind to it; its id is derived from the thread so a later trim upserts in place | unit | — | Inspect the constant and `historySummaryRowId` | `CHAT_HISTORY_SUMMARY` ≠ `MESSAGE_ATTRIBUTE`; `summary-<threadId>` |
| chat-page.unit.history-summary.002 | history-summary.ts | `buildHistorySummaryRow` stamps the discriminator, watermark, cumulative count and model; accepts an empty summary (watermark-only) | unit | — | Build with and without content | Fields as documented; pure function of its inputs |
| chat-page.unit.history-summary.003 | history-summary.ts | `formatTrimmedBlockForSummary` labels rows by role, unwraps the double-escaped tool envelope, marks reasoning, replaces images with a count, passes a malformed tool row through, and treats the legacy `function` role as a tool row | unit | — | Format a mixed block | `TOOL: tool=… arguments=… result=…`; no `\"`; `[1 image attached]`, no blob URL |
| chat-page.unit.history-summary.004 | history-summary.ts | `buildHistorySummaryPrompt` wraps the transcript in a `<transcript>` tag pair (pasted content cannot imitate one, a prose heading it can), oldest-first, and gives a previous summary its own `<prior-summary>` block with the fold-in contract spelled out: the old row is discarded, carry forward what is unfinished, the transcript wins a conflict | unit | — | Build with and without a previous summary | `<prior-summary>` precedes `<transcript>`; "discarded after this"/"the transcript wins" present; omitted when absent; deterministic |
| chat-page.unit.history-summary.005 | history-summary.ts | The summariser instructions ask for facts, decisions, open questions, document names and user preferences; forbid inventing an outcome; keep the summariser out of the conversation (no answering a trailing question, no mention of the compaction); hold the conversation's language; pin exact names, error messages, URLs, a neutral register and the size ceiling | unit | — | Inspect the prompt constant | All five headings present; "Never invent an outcome"; "Do not continue the conversation"; "Write the summary in the language of the conversation"; "error messages and URLs"; "Stay under 1500 tokens" |
| chat-page.unit.history-summary.006 | history-summary.ts | `formatSummaryReplayText` opens with `Summary of the earlier conversation:` and is byte-identical for a given stored summary | unit | — | Format twice | Byte-equal buffers |
| chat-page.unit.history-summary-service.001 | history-summary-service.ts | `HISTORY_SUMMARY_ENABLED` is honoured only as exactly `"true"`; `resolveHistorySummaryModel` returns a MODEL ID (the seam builds the client from it) resolving `HISTORY_SUMMARY_DEPLOYMENT_NAME` → the thread's own model, any provider → terra → luna → titles → undefined; a configured name no model config owns, an unknown id, and a model this environment has not deployed are all skipped with a log | unit | env stubbed per case; MODEL_CONFIGS mocked and mutable (the table, not the env, owns deployment names) | Resolve for sol/luna/claude/foundry/unknown/undeployed and for an unowned deployment name | Model ids, not deployment strings; claude/foundry summarise on themselves; unowned name → terra plus "has no model config" warning |
| chat-page.unit.history-summary-service.007 | history-summary-service.ts | The summariser is not billed but IS measured: no budget service, no legacy Azure chat-completions client (the 404 guard, asserted on comment-stripped source), `historySummaryTokens` reported per call, and a throwing metric does not fail a good summary | unit | seam + metric mocked | Scan the module source; record compactions | No `budget-service`/`recordUsage`; no `OpenAIV1Instance`/`chat.completions`/`max_completion_tokens`, but `resolveProvider` + `generateText` present; metric called with input/output/chatModel/threadId |
| chat-page.unit.history-summary-service.002 | history-summary-service.ts | `recordHistoryCompaction` writes the watermark row — with the summary when enabled, with an EMPTY summary when disabled — upserting in place, and returns null when even the watermark cannot be written | integration | Cosmos mock; summariser injected | Record one and then a second compaction | One row per thread; cumulative `coversMessageCount`; no summariser call for an empty block |
| chat-page.unit.history-summary-service.003 | history-summary-service.ts | A previous summary is passed to the summariser and replaced by the result; it is carried forward verbatim when the feature is switched off mid-thread | integration | Cosmos mock; summariser injected | Two compactions | Second prompt contains `PREVIOUS SUMMARY` and the earlier text |
| chat-page.unit.history-summary-service.004 | history-summary-service.ts | Fallback to plain trimming: the watermark still advances when the summariser throws, returns whitespace, or has no deployment; an earlier summary is kept | integration | summariser throws / returns `"  "`; deployment unset | Record a compaction | Row written with empty (or the earlier) content; `logWarn` mentions "falling back to plain trimming" |
| chat-page.unit.history-summary-service.005 | history-summary-service.ts | `FindChatHistorySummary` returns null when absent and when Cosmos throws; `SoftDeleteChatHistorySummary` clears summary and watermark so a rewound thread stops replaying it | integration | Cosmos mock | Read, soft-delete, read again | null → row → null; no-op when nothing to delete |
| chat-page.unit.history-summary-service.006 | chat-api/history-summary-service.ts | The request-path summariser has a deadline: `HISTORY_SUMMARY_TIMEOUT_MS` resolves with nonsense ignored (default 20000), a hanging summariser falls back to the plain trim with the watermark STILL written and a log line saying `timedOut`, the AbortSignal handed to the summariser is actually aborted rather than the call abandoned, and a summariser that answers in time is untouched | unit | Cosmos + logger mocked; fake summariser that never resolves | `recordHistoryCompaction` with a 25 ms timeout | Row content empty, watermark held, `timedOut: true`, signal aborted |
| chat-page.unit.message-service.015 | chat-message-service.ts | `FindAllChatMessagesForCurrentUser` has no row cap: no `TOP` and no `@top`, `ORDER BY r.createdAt ASC`, same thread/user/isDeleted scoping, and returns 250 rows unclipped | integration | Cosmos mock records querySpec | Call `("thread-1")` | Query has no TOP; 250 rows returned |
| chat-page.unit.message-service.016 | chat-message-service.ts + chat-history-order.ts | The loader applies `sequence` as the tie-break on same-millisecond rows and hands `sequence` and `stepLayout` through untouched; rows written before either field existed still come back in one stable order | integration | Cosmos mock returns tied rows out of order | Call `("thread-1")` | Order `u1, a1, t1`; both fields intact; legacy rows ordered by id |
| chat-page.unit.document-service.011 | chat-document-service.ts | `FindAllChatDocuments` orders deterministically so the document names in the prompt cannot reshuffle between turns | integration | Cosmos mock records querySpec | Call | `ORDER BY r.createdAt ASC` present |
| chat-page.unit.thread-context.001 | chat-api/thread-context.ts | The chat path loads the whole thread: the loader is called with only the thread id, keeps 200 rows when they fit the budget, and treats them as oldest-first without reversing | integration | message/summary services mocked | Load with 100 tiny turns | 201 messages (200 rows + current turn); no second argument to the loader |
| chat-page.unit.thread-context.002 | chat-api/thread-context.ts | The budget trims once and the trim sticks: compaction is recorded exactly once across two loads, the watermark is the newest dropped row, the cut is on a turn boundary, and a fitting thread is left alone | integration | message/summary services mocked; `HISTORY_TOKEN_BUDGET=10000` | Load twice, the second time with an extra persisted turn | `recordHistoryCompaction` called once; same first model item both turns |
| chat-page.unit.thread-context.002c | chat-api/thread-context.ts | A failed summariser is never presented as a summary: the row can carry text from an earlier trim, the notice must still say "failed" and offer nothing to expand | integration | record mocked to return `summaryOutcome:"failed"` with content | Load a thread over budget | `summaryOutcome` "failed", no `summaryText`, no `summaryModel` |
| chat-page.unit.thread-context.002d | chat-api/thread-context.ts | An untrimmable over-budget thread logs at INFO on a small configured budget and at WARN on the shipped default | integration | two protected turns over target | Load with `HISTORY_TOKEN_BUDGET=1000`, then unset | One INFO with `budgetSource:"env"`; one WARN with `budgetSource:"default"` |
| chat-page.unit.thread-context.002b | chat-api/thread-context.ts | A trim is reported on the context (turns, tokens before/after, summary text + model, duration, watermark) so the UI can show it; an unsummarised trim says so; a thread that fitted reports nothing | integration | message/summary services mocked; `HISTORY_TOKEN_BUDGET=10000` / `100000` | Load with the summariser on, off, and under budget | `ctx.compaction` set / `summarised:false` / undefined |
| chat-page.unit.thread-context.007a | chat-api/thread-context.ts | The loop is gone: a 15k-paste thread under a 12k budget compacts exactly ONCE across five consecutive loads, and lands at or under the target | integration | summariser mocked; `HISTORY_TOKEN_BUDGET=12000`, summary on | Load five times, appending a small turn each time | `recordHistoryCompaction` called once; four later loads report no compaction |
| chat-page.unit.thread-context.007b | chat-api/thread-context.ts | Hysteresis counts the replayed summary, so ten small turns after a compaction trigger neither a trim nor a summariser call | integration | same | Load, then append ten small turns | One summariser call in total |
| chat-page.unit.thread-context.007c | chat-api/thread-context.ts | An unreachable target does nothing, five loads over: no trim, no summariser call, no notice | integration | `HISTORY_PROTECTED_TURNS=2` holding a 15k paste | Load the same rows five times | Zero calls, `ctx.compaction` undefined each time |
| chat-page.unit.thread-context.007d | chat-api/thread-context.ts | The summariser is never shown the message being answered | integration | same | Load with a trimming thread | No dropped row contains the current user prompt |
| chat-page.unit.thread-context.003 | chat-api/thread-context.ts | A stored summary is replayed as the first model item with the documented prefix and no new summariser call; a watermark-only row (empty summary) replays nothing; a missing watermark row falls back to the full history | integration | summary service mocked | Load with a stored summary | Prefix present in `modelHistory`, absent from `history`; watermarked rows gone from the prompt |
| chat-page.unit.thread-context.004 | chat-api/thread-context.ts | The document hint is deterministic (names sorted, independent of Cosmos order) and, for an Azure-served thread, kept out of the developer message | integration | document service mocked | Load with documents in two orders | `alpha.pdf, mid.pdf, zeta.pdf` either way; `documentHintPlacement === "tail-message"` |
| chat-page.unit.thread-context.005 | chat-api/thread-context.ts | The document hint follows the model that RUNS the turn, not the thread's: `applyDocumentHintPlacement` pulls the hint out of the tail for an Anthropic effective model, moves it into the tail (immediately before the current user turn) for an Azure one, is a no-op when the placement already agrees, is idempotent, and does nothing for a thread with no documents | unit | thread `selectedModel` and effective provider varied | Load the context, then re-place it | `documentHintPlacement` / `documentHint` / the `dochint-*` item match the effective provider; exactly one hint item after a round trip |
| history.append-only.001 | chat-api/thread-context.ts + prompt-builder.ts | Plain turns only ever append: the model-message list for turn n is an exact item-by-item prefix of turn n+1, developer message included, across five turns and past the old 30-row boundary | integration | message/summary/document services mocked | Build the model input for consecutive turns | Deep-equal per item; developer message byte-identical |
| history.append-only.002 | chat-api/thread-context.ts | A tool-using turn only appends, whether the tool turn is the new one or already in the history; a tool result stays attached to the assistant message that called it | integration | as above | Build the model input for consecutive turns | Exact prefix; `tool` role after `assistant` |
| history.append-only.003 | chat-api/thread-context.ts | An attached document does not move earlier items: the hint rides in the prompt tail as its own developer message immediately before the current turn, the top developer message is identical with and without documents, and Claude threads fall back to the developer-message placement | integration | document service mocked; `selectedModel` varied | Build the model input with and without documents | Item #0 unchanged; `documentHintPlacement` `tail-message` for Azure, `developer-message` for Anthropic, `none` without documents |
| history.append-only.004 | chat-api/thread-context.ts | Compaction is the only sanctioned rewrite: the summary is the only new item at the front, everything after it matches the corresponding tail of the previous turn, the cut is on a turn boundary, later turns append again, and no summary item is replayed when summarisation is off | integration | summary service mocked; budget tightened between turns | Build the model input either side of a compaction | Developer message unchanged; one summary item; tail matches; exactly one compaction across four turns |
| history.append-only.005 | chat-history-order.ts + thread-context.ts | A same-millisecond write order cannot reshuffle the prompt: tied rows produce an identical model input whatever order Cosmos returns them in | integration | as above | Build the model input from two permutations of tied rows | Deep-equal model inputs |
| history.append-only.006 | chat-api/message-adapter.ts + chat-history-order.ts + thread-context.ts | The seam between the two halves: a turn persisted with `stepLayout` and `sequence` replays through the loader in the live step shape (assistant tool-call → tool → assistant text), survives a same-millisecond permutation, stays append-only across four tool turns, and mixes with rows written before either field existed | integration | message/summary/document services mocked | Build the model input for consecutive tool turns, with and without the two fields | Roles split on the persisted boundaries; deep-equal across permutations; exact prefix per turn |
| history.append-only.007 | chat-api/history-summary.ts + thread-context.ts | The compaction row never enters the history: its Cosmos `type` is one no message query selects, and the replayed summary is a plain user item with no metadata for the step-layout pass to act on and no presence in the browser-facing history | integration | as above | Compare the attributes; inspect `modelHistory[0]` and `history` | Types differ; one text part, no metadata; `history` carries no summary |

---

## chat-page — chat-thread-service

Target: `features/chat-page/chat-services/chat-thread-service.ts`.

**Cosmos mock strategy:** `vi.mock("@/features/common/services/cosmos")` → `HistoryContainer()` returns a stub whose `items.query` records `SqlQuerySpec`, `items.upsert`/`items.create` accept docs, and `item(id,pk).read/delete` are spies. Use `__tests__/helpers/cosmos-mock.ts` for an in-memory variant where useful.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.thread-service.001 | chat-thread-service.ts | `FindAllChatThreadForCurrentUser` scopes by hashed userId (data isolation) | integration | Default session; cosmos mock that captures querySpec | Call once | `parameters` include `{name:"@userId", value: sha256("test@example.com")}`, `@type=CHAT_THREAD`, `@isDeleted=false`; query also passes partitionKey equal to hashed id |
| chat-page.unit.thread-service.002 | chat-thread-service.ts | `FindAllChatThreadForCurrentUser` returns ERROR when Cosmos throws | unit | `query().fetchAll` rejects with `new Error("throttled")` | Call | Returns `{status:"ERROR", errors:[{message:"Error: throttled"}]}` |
| chat-page.unit.thread-service.003 | chat-thread-service.ts | `FindChatThreadForCurrentUser` returns NOT_FOUND when resource missing | unit | `item().read` returns `{resource: undefined}` | Call | `{status:"NOT_FOUND", errors:[…]}` |
| chat-page.unit.thread-service.004 | chat-thread-service.ts | `FindChatThreadForCurrentUser` returns NOT_FOUND when resource isDeleted | unit | `read` returns `{resource: {type:"CHAT_THREAD", isDeleted:true, …}}` | Call | NOT_FOUND |
| chat-page.unit.thread-service.005 | chat-thread-service.ts | `FindChatThreadForCurrentUser` returns NOT_FOUND when type mismatched | unit | `read` returns `{resource: {type:"OTHER"}}` | Call | NOT_FOUND |
| chat-page.unit.thread-service.006 | chat-thread-service.ts | `FindChatThreadForCurrentUser` passes hashed userId as partitionKey | integration | Cosmos mock records `item(id, pk)` args | Call with `id="t1"` | `item("t1", sha256("test@example.com"))` |
| chat-page.unit.thread-service.007 | chat-thread-service.ts | `CreateChatThread` sets defaults: `isDeleted:false, bookmarked:false, isTemporary:false, type:CHAT_THREAD, selectedModel:DEFAULT_MODEL` | integration | upsert returns the doc | Call `CreateChatThread()` | Returned OK; upsert doc has those defaults; `id` and `createdAt` present |
| chat-page.unit.thread-service.008 | chat-thread-service.ts | `CreateChatThread` honors `temporary:true` and `name` overrides | unit | — | Call `CreateChatThread({name:"X", temporary:true})` | upsert doc has `isTemporary:true, name:"X"` |
| chat-page.unit.thread-service.009 | chat-thread-service.ts | `UpsertChatThread` rejects cross-user updates (EnsureChatThreadOperation gate) | integration | session=non-admin user A; `read` returns thread owned by user B | Call `UpsertChatThread({id:"t1", userId:"B", …})` | Returns the EnsureChatThreadOperation response (the find result); does NOT call upsert (assert spy.notCalled) |
| chat-page.unit.thread-service.010 | chat-thread-service.ts | `UpsertChatThread` allows admin to update other users' threads | integration | session.isAdmin=true; `read` returns thread owned by other user | Call `UpsertChatThread` | upsert called; status OK |
| chat-page.unit.thread-service.011 | chat-thread-service.ts | `UpsertChatThread` proceeds when thread is new (no read precheck path) | unit | Pass model without `id` (undefined) | Call `UpsertChatThread({id: undefined as any, …})` | EnsureChatThreadOperation skipped; upsert called |
| chat-page.unit.thread-service.012 | chat-thread-service.ts | `UpsertChatThread` sets `lastMessageAt` to current time | unit | freeze date with `vi.setSystemTime` | Call | upsert doc `lastMessageAt` equals frozen Date |
| chat-page.unit.thread-service.013 | chat-thread-service.ts | `AddExtensionToChatThread` is idempotent for already-attached extension | unit | thread.extension=["ext-1"] | Call with `extensionId:"ext-1"` | No upsert call; returns OK with the unchanged thread |
| chat-page.unit.thread-service.014 | chat-thread-service.ts | `AddExtensionToChatThread` appends new extension | unit | thread.extension=[] | Call with `extensionId:"ext-1"` | upsert with `extension:["ext-1"]` |
| chat-page.unit.thread-service.015 | chat-thread-service.ts | `RemoveExtensionFromChatThread` filters out the id | unit | thread.extension=["a","b"] | Remove `"a"` | upsert with `["b"]` |
| chat-page.unit.thread-service.016 | chat-thread-service.ts | `UpdateChatThreadSelectedModel` updates `selectedModel` and persists | unit | thread exists, selectedModel="gpt-5.4-mini" | Call with `"gpt-5.5"` | upsert with `selectedModel:"gpt-5.5"` |
| chat-page.unit.thread-service.017 | chat-thread-service.ts | `UpdateChatThreadReasoningEffort` writes `reasoningEffort` field | unit | thread exists | Call with `"high"` | upsert with `reasoningEffort:"high"` |
| chat-page.unit.thread-service.018 | chat-thread-service.ts | `UpdateChatThreadUsage` accumulates onto existing usage and stamps `lastUpdated` | unit | thread.usage exists `(in:10,out:5,cached:1,cost:0.1)`; freeze time | Call with `(2,3,1,0.5)` | upsert with usage totals `(12, 8, 2, 0.6)` and ISO `lastUpdated` |
| chat-page.unit.thread-service.019 | chat-thread-service.ts | `UpdateChatThreadUsage` initializes usage to zeros when absent | unit | thread.usage undefined | Call with `(1,1,0,0.05)` | upsert with totals `(1,1,0,0.05)` |
| chat-page.unit.thread-service.020 | chat-thread-service.ts | `AddAttachedFile` deduplicates by `id` | unit | thread.attachedFiles=[{id:"f1",…}] | Call with `{id:"f1",…}` | No upsert; returns OK |
| chat-page.unit.thread-service.021 | chat-thread-service.ts | `RemoveAttachedFile` removes matching id | unit | thread.attachedFiles=[{id:"a"},{id:"b"}] | Remove `"a"` | upsert with `[{id:"b"}]` |
| chat-page.unit.thread-service.022 | chat-thread-service.ts | `SoftDeleteChatContentsForCurrentUser` soft-deletes all messages when no `untilMessage*` | unit | thread exists; 3 messages | Call without options | All 3 message upserts have `isDeleted:true` |
| chat-page.unit.thread-service.023 | chat-thread-service.ts | `SoftDeleteChatContentsForCurrentUser` deletes only after `untilMessageIndex` | unit | 5 messages | Call `untilMessageIndex: 1` | Messages at indexes 2,3,4 upserted with `isDeleted:true`; first two preserved |
| chat-page.unit.thread-service.024 | chat-thread-service.ts | `SoftDeleteChatContentsForCurrentUser` throws on invalid `untilMessageId` | unit | messages do not contain id "missing" | Call `untilMessageId:"missing"` | Returns ERROR (caught) with message including "untilMessageId not found" |
| chat-page.unit.thread-service.025 | chat-thread-service.ts | `SoftDeleteChatContentsForCurrentUser` throws on out-of-bounds index | unit | 2 messages | Call `untilMessageIndex: 5` | ERROR with "out of bounds" |
| chat-page.unit.thread-service.026 | chat-thread-service.ts | `SoftDeleteChatThreadForCurrentUser` marks the thread `isDeleted:true` after content cleanup | integration | Stub `SoftDeleteChatContentsForCurrentUser` (or rely on real with messages mock) | Call | Final upsert on the thread carries `isDeleted:true` |
| chat-page.unit.thread-service.027 | chat-thread-service.ts | `UpdateChatTitle` truncates prompt to 300 chars before calling ChatApiText | integration | mock `ChatApiText` to capture systemPrompt | Call with 1000-char prompt | `systemPrompt` includes only the first 300 chars of `prompt` |
| chat-page.unit.thread-service.028 | chat-thread-service.ts | `UpdateChatTitle` uses returned name; keeps old name when ChatApiText returns falsy | unit | `ChatApiText` returns `""` | Call | upsert keeps existing `name` |
| chat-page.unit.thread-service.029 | chat-thread-service.ts | `CreateChatAndRedirect` redirects to /chat/<id> on success | unit | `CreateChatThread` returns OK with id `"new-1"` | Call | `redirect` throws `NEXT_REDIRECT:/chat/new-1` |
| chat-page.unit.thread-service.030 | chat-thread-service.ts | `EnsureChatThreadOperation` returns the response when current user owns the thread | unit | thread.userId === hashedId | Call | Returns OK response with the thread |
| chat-page.unit.thread-service.031 | chat-thread-service.ts | `EnsureChatThreadOperation` admin sees other users' threads | unit | session.isAdmin=true; thread.userId="other" | Call | Returns OK |
| chat-page.unit.thread-service.032 | chat-thread-service.ts | `EnsureChatThreadOperation` returns the NOT_FOUND response unchanged | unit | underlying FindChatThreadForCurrentUser returns NOT_FOUND | Call | Same NOT_FOUND returned |

---

## chat-page — chat-message-service

Target: `features/chat-page/chat-services/chat-message-service.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.message-service.001 | chat-message-service.ts | `FindTopChatMessagesForCurrentUser` scopes by hashed userId and threadId | integration | Cosmos mock records querySpec | Call `("thread-1", 50)` | parameters include `@userId=sha256(email)`, `@threadId="thread-1"`, `@top=50`, `@isDeleted=false` |
| chat-page.unit.message-service.002 | chat-message-service.ts | `FindTopChatMessagesForCurrentUser` default `top=30` | unit | — | Call without `top` | `@top=30` in params |
| chat-page.unit.message-service.003 | chat-message-service.ts | `FindAllChatMessagesForCurrentUser` returns OK with resources | unit | Cosmos returns `[m1,m2]` | Call | `{status:"OK", response:[m1,m2]}` |
| chat-page.unit.message-service.004 | chat-message-service.ts | `FindAllChatMessagesForCurrentUser` returns ERROR on Cosmos throw | unit | query rejects | Call | ERROR with stringified error |
| chat-page.unit.message-service.005 | chat-message-service.ts | `CreateChatMessage` sets `userId` to hashed id, `type:MESSAGE_ATTRIBUTE`, `isDeleted:false`, generates `id` | integration | Stub `processMessageForImagePersistence` to return content unchanged; capture upserted doc | Call | upserted doc matches |
| chat-page.unit.message-service.006 | chat-message-service.ts | `CreateChatMessage` persists processed content (image stripping) | integration | Stub processor to return `{content:"cleaned", multiModalImage:"blob://..."}` | Call with raw base64 image | upserted doc has `content:"cleaned"` and `multiModalImage:"blob://..."` |
| chat-page.unit.message-service.007 | chat-message-service.ts | `UpsertChatMessage` preserves provided id and createdAt | unit | Provide explicit id and createdAt | Call | upserted doc has same id/createdAt |
| chat-page.unit.message-service.008 | chat-message-service.ts | `UpdateChatMessage` returns NOT_FOUND when no message matches | unit | query returns `[]` | Call | `{status:"NOT_FOUND"}` |
| chat-page.unit.message-service.009 | chat-message-service.ts | `UpdateChatMessage` merges updates while preserving id/createdAt/type | unit | query returns existing `{id:"m1", createdAt:D1, content:"old", role:"user"}` | Call with `{content:"new"}` | upserted doc has `content:"new"`, original `id` and `createdAt`, `type:"CHAT_MESSAGE"`, `isDeleted:false` |
| chat-page.unit.message-service.010 | chat-message-service.ts | `UpdateChatMessage` enforces userId filter in query | integration | Cosmos records querySpec | Call | `@userId=sha256(email)` present |

---

## chat-page — chat-document-service

Target: `features/chat-page/chat-services/chat-document-service.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.document-service.001 | chat-document-service.ts | `CrackDocument` short-circuits for plain text extensions | unit | FormData with `.txt` file containing 5000 chars; mock `EnsureIndexIsCreated` → OK; do NOT mock `LoadFile` (should not be called) | Call | Returns OK with chunked array; chunks ≤ 2300 chars with ~25% overlap |
| chat-page.unit.document-service.002 | chat-document-service.ts | `CrackDocument` falls back to Document Intelligence for PDF | unit | `.pdf` file; mock `LoadFile` to return paragraphs | Call | LoadFile invoked; returns chunked result |
| chat-page.unit.document-service.003 | chat-document-service.ts | `CrackDocument` returns ERROR if index ensure fails | unit | `EnsureIndexIsCreated` → ERROR | Call | Returns same ERROR |
| chat-page.unit.document-service.004 | chat-document-service.ts | `FindAllChatDocuments` filters by userId and threadId and isDeleted=false | integration | Cosmos records querySpec | Call `("t1")` | parameters include `@type=CHAT_DOCUMENT, @threadId="t1", @userId=hashed, @isDeleted=false` |
| chat-page.unit.document-service.005 | chat-document-service.ts | Upload over `MAX_UPLOAD_DOCUMENT_SIZE` returns ERROR | unit | File 10MB+1 byte | Call upload entry | ERROR with size message |

---

## chat-page — chat-image-service

Target: `features/chat-page/chat-services/chat-image-service.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.image-service.001 | chat-image-service.ts | `GetBlobPath` joins threadId/fileName | unit | — | `GetBlobPath("t","a.png")` | `"t/a.png"` |
| chat-page.unit.image-service.002 | chat-image-service.ts | `UploadImageToStore` calls UploadBlob with `images` container and `threadId/fileName` path | unit | Mock `UploadBlob` | Call with options | UploadBlob got `("images", "t/a.png", buffer, {contentType, metadata:{originalfilename:"a.png"}})` |
| chat-page.unit.image-service.003 | chat-image-service.ts | `GetImageUrl` builds query string `?t=...&img=...` | unit | NEXTAUTH_URL from setup env (`http://localhost:3000`) | Call | `http://localhost:3000/api/images?t=tid&img=a.png` |
| chat-page.unit.image-service.004 | chat-image-service.ts | `GetThreadAndImageFromUrl` extracts t and img | unit | — | Call with valid URL | OK with `{threadId, imgName}` |
| chat-page.unit.image-service.005 | chat-image-service.ts | `GetThreadAndImageFromUrl` returns ERROR on missing params | unit | — | Call with URL missing `img` | `{status:"ERROR", …}` |

---

## chat-page — chat-image-persistence-utils

Target: `features/chat-page/chat-services/chat-image-persistence-utils.ts`. Pure helpers — high signal.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.image-utils.001 | chat-image-persistence-utils.ts | `isBase64Image` matches valid `data:image/png;base64,…` | unit | — | Call with valid + invalid strings | Returns true / false correctly |
| chat-page.unit.image-utils.002 | chat-image-persistence-utils.ts | `extractImageMetadata` returns `{mimeType, data}` | unit | — | Call with `data:image/jpeg;base64,XXXX` | `{mimeType:"jpeg", data:"XXXX"}` |
| chat-page.unit.image-utils.003 | chat-image-persistence-utils.ts | `extractImageMetadata` returns null for plain text | unit | — | Call with `"hello"` | `null` |
| chat-page.unit.image-utils.004 | chat-image-persistence-utils.ts | `base64ToBuffer` roundtrips | unit | — | Buffer→base64→`base64ToBuffer` | Same bytes |
| chat-page.unit.image-utils.005 | chat-image-persistence-utils.ts | `isImageReference` recognises `blob://` prefix only | unit | — | True for `blob://...`, false for `http://...` | as documented |
| chat-page.unit.image-utils.006 | chat-image-persistence-utils.ts | `parseImageReference` parses `blob://t/id.png` correctly | unit | — | Call | `{threadId:"t", imageId:"id", fileName:"id.png", mimeType:"image/png"}` |
| chat-page.unit.image-utils.007 | chat-image-persistence-utils.ts | `parseImageReference` returns null when not a reference | unit | — | Call with `"http://x"` | `null` |
| chat-page.unit.image-utils.008 | chat-image-persistence-utils.ts | `parseImageReference` defaults mimeType to `image/png` when no extension | unit | — | Call with `"blob://t/abc"` | `mimeType:"image/png"` |

---

## chat-page — code-interpreter-service

Target: `features/chat-page/chat-services/code-interpreter-service.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.ci-service.001 | code-interpreter-service.ts | `UploadFileForCodeInterpreter` rejects unsupported extension | unit | Pass `File` named `evil.exe` | Call | `{status:"ERROR", errors:[{message:/not supported/i}]}`; OpenAI client NOT called |
| chat-page.unit.ci-service.002 | code-interpreter-service.ts | `UploadFileForCodeInterpreter` accepts a CSV and calls OpenAI files.create | unit | Mock `OpenAIV1Instance().files.create` to resolve `{id:"file_abc", filename:"data.csv"}` | Call with `data.csv` | OK; response `{id:"file_abc", name:"data.csv"}` |
| chat-page.unit.ci-service.003 | code-interpreter-service.ts | `UploadFileForCodeInterpreter` returns ERROR if OpenAI throws | unit | files.create rejects | Call | `{status:"ERROR",…}` |
| chat-page.unit.ci-service.004 | code-interpreter-service.ts | `DownloadFileFromCodeInterpreter` maps content-types via extension | unit | retrieve returns `{filename:"output.png"}`; content returns arrayBuffer | Call | Returns `{data:Buffer, name:"output.png", contentType:"image/png"}` |
| chat-page.unit.ci-service.005 | code-interpreter-service.ts | `DownloadFileFromCodeInterpreter` defaults unknown extension → octet-stream | unit | filename `out.bin` | Call | `contentType:"application/octet-stream"` |

---

## chat-page — code-interpreter-constants

Target: `features/chat-page/chat-services/code-interpreter-constants.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.ci-const.001 | code-interpreter-constants.ts | `isCodeInterpreterSupportedFile` returns true for documented extensions | unit | — | Call for `a.py`, `b.csv`, `c.PDF`, `d.zip` | All true (case-insensitive) |
| chat-page.unit.ci-const.002 | code-interpreter-constants.ts | Returns false for unknown extension | unit | — | `note.exe`, `arch.rar` | False |
| chat-page.unit.ci-const.003 | code-interpreter-constants.ts | Returns false for file with no extension | unit | — | `"README"` | False |

---

## chat-page — citation-service

Target: `features/chat-page/chat-services/citation-service.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.citation.001 | citation-service.ts | `CreateCitation` returns OK on successful create | unit | Cosmos `items.create` returns resource | Call | OK with the resource |
| chat-page.unit.citation.002 | citation-service.ts | `CreateCitation` returns ERROR when no resource returned | unit | create returns `{resource: undefined}` | Call | ERROR `"Citation not created"` |
| chat-page.unit.citation.003 | citation-service.ts | `CreateCitations` defaults userId to userHashedId() when not provided | unit | session mock default | Call with `[doc1, doc2]` | Cosmos receives docs with `userId=sha256(email)` |
| chat-page.unit.citation.004 | citation-service.ts | `CreateCitations` uses provided userId override | unit | — | Call with userId `"explicit"` | Cosmos docs have `userId:"explicit"` |
| chat-page.unit.citation.005 | citation-service.ts | `FindCitationByID` scopes query by hashed userId | integration | record querySpec | Call | `@userId=hashed` |

---

## chat-page — utils (mapOpenAIChatMessages)

Target: `features/chat-page/chat-services/utils.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.utils.001 | utils.ts | Skips `tool` and `function` messages | unit | Stub `getBase64ImageReference` | Pass mixed roles | Output array omits tool/function entries |
| chat-page.unit.utils.002 | utils.ts | User message with image produces input_text + input_image content array | unit | Stub `getBase64ImageReference` to return `data:image/png;base64,XYZ` | Pass user message with `multiModalImage:"blob://..."` | Output `content` array contains both parts with image_url referring to base64 ref |
| chat-page.unit.utils.003 | utils.ts | User text-only message yields string content | unit | — | user role, no image | Output `content` is a plain string equal to message.content |
| chat-page.unit.utils.004 | utils.ts | Assistant with `reasoningState` appends the reasoningState as a separate item | unit | — | assistant message with reasoningState | Output has assistant message followed by `reasoningState` entry |
| chat-page.unit.utils.005 | utils.ts | Ordering preserved across many messages | unit | — | 5 user/assistant messages | Output keeps same order |

---

## chat-page — chat-menu-service

Target: `features/chat-page/chat-menu/chat-menu-service.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.menu-service.001 | chat-menu-service.ts | `DeleteChatThreadByID` calls soft-delete and redirects to /chat | unit | Mock `SoftDeleteChatThreadForCurrentUser` | Call | Soft-delete called; `redirect` throws `NEXT_REDIRECT:/chat` |
| chat-page.unit.menu-service.002 | chat-menu-service.ts | `DeleteAllChatThreads` soft-deletes every owned thread and revalidates layout | integration | FindAll returns 3 threads | Call | 3 soft-delete calls; `RevalidateCache({page:"chat", type:"layout"})` invoked |
| chat-page.unit.menu-service.003 | chat-menu-service.ts | `DeleteAllChatThreads` returns ERROR from FindAll unchanged | unit | FindAll returns ERROR | Call | Same ERROR returned |
| chat-page.unit.menu-service.004 | chat-menu-service.ts | `UpdateChatThreadTitle` upserts with new `name` and revalidates | unit | — | Call with `{chatThread, name:"X"}` | Upsert payload `name:"X"`; cache revalidated |
| chat-page.unit.menu-service.005 | chat-menu-service.ts | `BookmarkChatThread` toggles `bookmarked` | unit | thread.bookmarked=false | Call | Upsert with `bookmarked:true` |

---

## chat-page — azure-ai-search

Target: `features/chat-page/chat-services/azure-ai-search/azure-ai-search.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.search.001 | azure-ai-search.ts | `SimpleSearch` iterates async results into array | unit | Mock SearchClient yielding `{score, document}` items via async iterable | Call | OK with the 2 results |
| chat-page.unit.search.002 | azure-ai-search.ts | `SimilaritySearch` adds vectorSearchOptions when `shouldCreateEmbedding=true` | integration | Mock OpenAI embeddings to return `[0.1,0.2,…]`; capture searchOptions | Call | searchOptions.vectorSearchOptions.queries[0] has the vector and `kNearestNeighborsCount===k` |
| chat-page.unit.search.003 | azure-ai-search.ts | `SimilaritySearch` skips embedding creation when flag is false | unit | OpenAI mock spy | Call with `shouldCreateEmbedding=false` | OpenAI.embeddings.create NOT called; no vectorSearchOptions in request |
| chat-page.unit.search.004 | azure-ai-search.ts | `IndexDocuments` tags each document with hashed userId | integration | Mock embeddings + SearchClient.uploadDocuments | Call | Each `AzureSearchDocumentIndex.user === sha256(email)` |
| chat-page.unit.search.005 | azure-ai-search.ts | `IndexDocuments` returns per-doc ERROR when upload fails | unit | Mock upload returns `{results: [{succeeded:false, errorMessage:"e"}]}` | Call | Output array contains an ERROR with `"e"` |
| chat-page.unit.search.006 | azure-ai-search.ts | `DeleteDocumentsOfChatThread` issues SimpleSearch filter scoped by chatThreadId | integration | Spy on SimpleSearch | Call `("t1")` | SimpleSearch filter contains `chatThreadId eq 't1'` |
| chat-page.unit.search.007 | azure-ai-search.ts | `DeleteSearchDocumentByPersonaDocumentId` filter includes hashed user | integration | Spy | Call | Filter contains `user eq '<hash>'` |
| chat-page.unit.search.008 | azure-ai-search.ts | `EnsureIndexIsCreated` returns existing index when getIndex resolves | unit | IndexClient.getIndex returns index | Call | OK with the index; createIndex NOT called |
| chat-page.unit.search.009 | azure-ai-search.ts | `EnsureIndexIsCreated` falls through to creation when getIndex throws | unit | getIndex throws; createIndex resolves | Call | OK with newly created index |

---

## chat-page — function-registry & conversation-manager

Targets: `features/chat-page/chat-services/chat-api/function-registry.ts`, `conversation-manager.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.fn-registry.001 | function-registry.ts | `executeFunction` returns "function not found" when name unknown | unit | Empty registry (fresh import; or reset registry) | Call with `{name:"unknown", arguments:{}, call_id:"c1"}` | `{call_id:"c1", output: JSON.stringify({error:/not found/i})}` |
| chat-page.unit.fn-registry.002 | function-registry.ts | `executeFunction` stringifies non-string results | unit | `registerFunction("ping", () => ({pong:1}))` | Call `ping` | output is `'{"pong":1}'` |
| chat-page.unit.fn-registry.003 | function-registry.ts | `executeFunction` returns string output verbatim | unit | register fn returning `"hello"` | Call | output `"hello"` |
| chat-page.unit.fn-registry.004 | function-registry.ts | `executeFunction` catches implementation errors | unit | register fn that throws | Call | output JSON includes `"Function execution failed"` |
| chat-page.unit.fn-registry.005 | function-registry.ts | `registerFunction` later registration overrides earlier | unit | register name twice | Call | Last impl wins |
| chat-page.unit.conv-mgr.001 | conversation-manager.ts | `createConversationState` clones initialInput and stamps messageId | unit | — | Pass an array of 2 items | Returned state's `conversationInput` is a new array (mutating one does not affect the other); `messageId` is 36-char `uniqueId` |
| chat-page.unit.conv-mgr.002 | conversation-manager.ts | `startConversation` calls `responses.create` with `stream:true` and signal | unit | Mock openaiInstance.responses.create spy | Call | call args include `stream:true`, `input: state.conversationInput`, and signal forwarded |
| chat-page.unit.conv-mgr.003 | conversation-manager.ts | `processFunctionCall` integrates result and updates state | integration | register a function that returns `"ok"`; pass call with that name | Call | `result.success===true, result.result==="ok"`; `updatedState.conversationInput` now includes the function_call input AND its output |
| chat-page.unit.conv-mgr.004 | conversation-manager.ts | `processFunctionCall` returns success:false when execution returns error JSON | unit | register fn that throws | Call | `result.success===false`, error string surfaces |

---

## chat-page — openai-responses-stream (SSE)

Target: `features/chat-page/chat-services/chat-api/openai-responses-stream.ts`. This is the SSE protocol surface — high signal.

**Helper:** create a fake `Stream<ResponseStreamEvent>` as an async generator yielding the documented event types. Consume the returned `ReadableStream`, decode bytes, and parse SSE lines into `{event, data}` records.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.stream.001 | openai-responses-stream.ts | Emits `content` events for each `response.output_text.delta` | unit | Fake stream yields 3 deltas (`"Hel"`, `"lo"`, `"!"`) then `response.completed` with `usage`; mock UpsertChatMessage; chatThread with id="t1" | Read SSE bytes until close | Three `event: content` records arrive in order with deltas; final `usageData` and `finalContent` events present |
| chat-page.unit.stream.002 | openai-responses-stream.ts | `finalContent` event carries the full concatenated message | unit | Same as .001 | Parse final `finalContent` data | `response === "Hello!"` |
| chat-page.unit.stream.003 | openai-responses-stream.ts | `usageData` event preceeds `finalContent` and includes computed cost | unit | usage `{input_tokens:1000, output_tokens:500, total_tokens:1500, input_tokens_details:{cached_tokens:200}}`; chatThread.selectedModel=`gpt-5.4` | Parse | usageData appears before finalContent; `costUsd ≈ (800/1e6)*2.5 + (200/1e6)*0.25 + (500/1e6)*15` |
| chat-page.unit.stream.004 | openai-responses-stream.ts | Persists assistant message via UpsertChatMessage on completion | unit | Spy on `UpsertChatMessage` | Run stream | Called once with `role:"assistant"`, threadId="t1", content=accumulated text |
| chat-page.unit.stream.005 | openai-responses-stream.ts | Emits `abort` event on `response.incomplete` with mapped reason | unit | Yield `{type:"response.incomplete", response:{incomplete_details:{reason:"max_output_tokens"}}}` after some deltas | Read SSE | `event: abort` with message `"reached the maximum output tokens limit"` |
| chat-page.unit.stream.006 | openai-responses-stream.ts | Persists partial message on `response.incomplete` | unit | Same plus spy on UpsertChatMessage | Run | UpsertChatMessage called once with partial content |
| chat-page.unit.stream.007 | openai-responses-stream.ts | Emits `error` event on stream `error` event | unit | Fake stream yields `{type:"error", error:{message:"boom"}}` | Read | `event: error` with `"boom"` |
| chat-page.unit.stream.008 | openai-responses-stream.ts | Emits `usageWarning` event when fallbackInfo provided | unit | Pass fallbackInfo `{originalModel:"gpt-5.5", fallbackModel:"gpt-5.4-mini", message:"x", limitType:"tokens", currentUsage:1, limit:1}` | Read | First event is `usageWarning` with the payload |
| chat-page.unit.stream.009 | openai-responses-stream.ts | Reasoning summary deltas stream as `reasoning` events | unit | Fake yields 2 `response.reasoning_summary_text.delta` (summary_index 0) then `response.completed` | Read | Two `event: reasoning` records with the deltas; saveMessage's reasoningContent includes both joined |
| chat-page.unit.stream.010 | openai-responses-stream.ts | Function call: emits `functionCall` then `functionCallResult` after processFunctionCall | unit | Sequence: output_item.added(function_call), function_call_arguments.delta, function_call_arguments.done, output_item.done(function_call); pre-register a function returning `"42"`; provide conversationState | Read | `event: functionCall` followed by `event: functionCallResult` whose data contains `"42"` |
| chat-page.unit.stream.011 | openai-responses-stream.ts | Function call: persists a tool message via UpsertChatMessage | unit | Same as .010 | Inspect UpsertChatMessage spy | Called with `role:"tool"`, content JSON includes `name`, `arguments`, `result`, `call_id` |
| chat-page.unit.stream.012 | openai-responses-stream.ts | Function call: sub-agent usage from result JSON is accumulated | integration | function result returns `JSON.stringify({usage:{inputTokens:10,outputTokens:5,cachedTokens:0,totalTokens:15,costUsd:0.01}})`; then response.completed with usage `{input_tokens:100, output_tokens:50, total_tokens:150}` | Read usageData event | usageData.response.inputTokens === 110, outputTokens === 55, costUsd reflects both |
| chat-page.unit.stream.013 | openai-responses-stream.ts | Closes stream after `onContinue` when function call output_item.done fires | unit | sequence triggers onContinue; mock `onContinue` | Read | onContinue called with updatedState; stream closes without sending finalContent in this segment |
| chat-page.unit.stream.014 | openai-responses-stream.ts | Persists usage via UpdateChatThreadUsage & IncrementUsage on completion | unit | spy both | Run | Both called with combined sub-agent + base totals |
| chat-page.unit.stream.015 | openai-responses-stream.ts | `contextUsagePercent` computed against MODEL_CONFIGS.contextWindow | unit | gpt-5.4-mini (`contextWindow:400000`); input_tokens=100000 | Inspect usageData | `contextUsagePercent` ≈ 25 |
| chat-page.unit.stream.016 | openai-responses-stream.ts | Reuses passed-in `conversationState.messageId` (no new id generated) | unit | conversationState `{messageId:"keep-me", …}` | Read | UpsertChatMessage doc has `id:"keep-me"` |

---

## chat-page — chat components

Skipping UI primitives; testing only components with meaningful logic.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.components.001 | chat-header/model-selector.tsx | Renders only models user can use; highlights `selectedModel` | unit | Render with thread.selectedModel="gpt-5.4" | Snapshot ARIA roles | Each model option present; aria-selected on gpt-5.4 |
| chat-page.unit.components.002 | chat-header/context-window-indicator.tsx | Displays usage percentage formatted to 1 decimal | unit | Pass `usage.totalInputTokens=500000` & contextWindow `1050000` | Render | Visible text matches `~47.6%` |
| chat-page.unit.components.003 | chat-input/reasoning-effort-selector.tsx | Calls action with selected effort | unit | Render with onChange spy | Click "high" | Spy called with `"high"` |
| chat-page.unit.components.004 | chat-input/tool-toggles.tsx | Toggling an extension calls Add/Remove server action | unit | Mock add/remove | Click toggle off (extension currently attached) | Remove called with threadId+extensionId |
| chat-page.unit.components.005 | chat-menu/chat-menu.tsx | Renders threads grouped by date and shows new-chat button | unit | Provide 3 threads spread across today/yesterday/older | Render | Headers present and threads ordered desc by `lastMessageAt` |
| chat-page.unit.components.006 | chat-page.tsx | On submit, calls `/api/chat` with FormData containing JSON-encoded UserPrompt | unit | Render; spy on `fetch` | Submit user message | fetch called with `/api/chat`, body=FormData; field `content` parses to JSON with `message` and `id` |

---

## chat-home-page

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-home-page.unit.001 | chat-home.tsx | Renders persona cards passed via props | unit | Render with 2 personas | Inspect rendered names | Both names visible |
| chat-home-page.unit.002 | chat-home.tsx | Favorite agents are visually highlighted (data attribute or class) | unit | personas = [a,b]; favorites=[a.id] | Render | a card has favorite marker, b does not |
| chat-home-page.unit.003 | news-article.tsx | Renders title/date/body; opens links in new tab | unit | — | Render | `target="_blank" rel="noopener"` on external links |
| chat-home-page.unit.004 | changelog.tsx | Renders fallback when no news | unit | items=[] | Render | Shows empty/placeholder content |

---

## persona-page — persona-service

Target: `features/persona-page/persona-services/persona-service.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| persona-page.unit.persona-service.001 | persona-service.ts | `CreatePersona` forces `isPublished=false` for non-admin | unit | session non-admin; mock AddOrUpdatePersonaDocuments OK; Cosmos create captures doc | Call with `isPublished:true` | Created doc has `isPublished:false`, `userId:hashed`, `id`, `type:"PERSONA"` |
| persona-page.unit.persona-service.002 | persona-service.ts | `CreatePersona` allows admin to publish | unit | session.isAdmin=true | Call with isPublished:true | Created doc `isPublished:true` |
| persona-page.unit.persona-service.003 | persona-service.ts | `CreatePersona` returns ERROR with Zod-mapped messages on invalid input | unit | Pass empty `name` and empty `description` | Call | `{status:"ERROR", errors:[{message:/Title/}, {message:/Description/}, …]}` |
| persona-page.unit.persona-service.004 | persona-service.ts | `CreatePersona` propagates persona-documents ERROR | unit | AddOrUpdatePersonaDocuments returns ERROR `[{message:"sp fail"}]` | Call | Returns same errors |
| persona-page.unit.persona-service.005 | persona-service.ts | `FindPersonaByID` returns NOT_FOUND when no rows | unit | query returns `[]` | Call | NOT_FOUND |
| persona-page.unit.persona-service.006 | persona-service.ts | `FindPersonaByID` returns UNAUTHORIZED when accessGroup denies | integration | persona has `accessGroup:{id:"g1"}`; mock AccessGroupById → ERROR | Call | `{status:"UNAUTHORIZED", errors:[{message:/access/i}]}` |
| persona-page.unit.persona-service.007 | persona-service.ts | `FindAllPersonaForCurrentUser` SQL includes published OR ownerId OR group membership | integration | Mock UserAccessGroups → `[{id:"g1"}]`; record querySpec | Call | Query string contains `isPublished=@isPublished OR r.userId=@userId OR ARRAY_CONTAINS(@groupIds, r.accessGroup.id)`; `@userId=hashed`, `@groupIds=["g1"]` |
| persona-page.unit.persona-service.008 | persona-service.ts | `FindAllPersonaForCurrentUser` filters out personas the user has lost group access to | unit | resources include persona with accessGroup whose AccessGroupById → ERROR | Call | That persona excluded from response |
| persona-page.unit.persona-service.009 | persona-service.ts | `EnsurePersonaOperation` returns UNAUTHORIZED for non-owner non-admin | unit | persona.userId="other"; session non-admin | Call | UNAUTHORIZED |
| persona-page.unit.persona-service.010 | persona-service.ts | `EnsurePersonaOperation` returns OK for admin | unit | persona.userId="other"; isAdmin=true | Call | OK |
| persona-page.unit.persona-service.011 | persona-service.ts | `DeletePersona` deletes associated documents then deletes the persona | unit | Stub `DeletePersonaDocumentsByPersonaId`, item.delete | Call | Both called in order |
| persona-page.unit.persona-service.012 | persona-service.ts | `UpsertPersona` preserves existing `isPublished` for non-admin | unit | existing `isPublished:true` (someone admin published); session non-admin tries `isPublished:false` | Call | upserted doc still `isPublished:true` |
| persona-page.unit.persona-service.013 | persona-service.ts | `CreatePersonaChat` returns UNAUTHORIZED when user lacks access group | integration | persona has accessGroup id "g1"; AccessGroupById returns ERROR | Call | UNAUTHORIZED |
| persona-page.unit.persona-service.014 | persona-service.ts | `CreatePersonaChat` uploads SharePoint CI docs and attaches files | integration | persona has `codeInterpreterDocumentIds=["d1"]`; mock PersonaCIDocumentsByIds OK; DownloadSharePointFile OK; UploadFileForCodeInterpreter OK | Call | UpsertChatThread payload `attachedFiles=[{id:openaiFileId, name, type:"code-interpreter", uploadedAt:Date}]` |
| persona-page.unit.persona-service.015 | persona-service.ts | `CreatePersonaChat` continues after a single CI doc fails to download | integration | first doc DownloadSharePointFile ERROR; second OK | Call | attachedFiles contains only the successful one; no throw |

---

## persona-page — access-group-service

Target: `features/persona-page/persona-services/access-group-service.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| persona-page.unit.access-group.001 | access-group-service.ts | `UserAccessGroups` short-circuits for local dev user with `[]` | unit | session.user.isLocalDevUser=true | Call | `{status:"OK", response:[]}` |
| persona-page.unit.access-group.002 | access-group-service.ts | `UserAccessGroups` returns UNAUTHORIZED + SESSION_EXPIRED code when token missing | unit | session.user.accessToken="" | Call | `{status:"UNAUTHORIZED", errors:[{code:"SESSION_EXPIRED", message:/session expired/i}]}` |
| persona-page.unit.access-group.003 | access-group-service.ts | `UserAccessGroups` maps Graph response into AccessGroup[] | integration | mock `getGraphClient` chain to return `{value:[{id:"1", displayName:"X", description:"D"}]}` | Call | `[{id:"1", name:"X", description:"D"}]` |
| persona-page.unit.access-group.004 | access-group-service.ts | `UserAccessGroups` maps 401 statusCode error to UNAUTHORIZED | unit | Graph throws `{statusCode:401}` | Call | UNAUTHORIZED with SESSION_EXPIRED code |
| persona-page.unit.access-group.005 | access-group-service.ts | `UserAccessGroups` maps "Access token is undefined" Error to UNAUTHORIZED | unit | Graph throws `new Error("Access token is undefined or empty")` | Call | UNAUTHORIZED with SESSION_EXPIRED |
| persona-page.unit.access-group.006 | access-group-service.ts | Other errors map to ERROR with message | unit | Graph throws `new Error("Network")` | Call | `{status:"ERROR", errors:[{message:/Network/}]}` |

---

## persona-page — agent-favorite-service

Target: `features/persona-page/persona-services/agent-favorite-service.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| persona-page.unit.favorite.001 | agent-favorite-service.ts | `GetUserFavoriteAgents` returns existing agentIds | unit | item.read returns `{resource:{agentIds:["a","b"]}}` | Call | `["a","b"]` |
| persona-page.unit.favorite.002 | agent-favorite-service.ts | `GetUserFavoriteAgents` returns `[]` when read throws | unit | item.read rejects | Call | `[]` |
| persona-page.unit.favorite.003 | agent-favorite-service.ts | `ToggleFavoriteAgent` adds new id to empty list | unit | read returns no resource | Call `Toggle("a1")` | upsert payload `agentIds:["a1"]`; cache revalidated for persona and agent |
| persona-page.unit.favorite.004 | agent-favorite-service.ts | `ToggleFavoriteAgent` removes existing id | unit | read returns `agentIds:["a1","a2"]` | Call `Toggle("a1")` | upsert payload `agentIds:["a2"]` |
| persona-page.unit.favorite.005 | agent-favorite-service.ts | `ToggleFavoriteAgent` uses doc id `AGENT_FAVORITE_<userHash>` | integration | spy on item() | Call | Document id matches pattern; partitionKey === userHash |

---

## persona-page — components

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| persona-page.unit.components.001 | add-new-persona.tsx | Submit calls CreatePersona action with form values | unit | Mock action; render form | Fill name, description, persona message; submit | Action called with those values; no validation errors shown |
| persona-page.unit.components.002 | add-new-persona.tsx | Validation: empty name shows error and does not call action | unit | Same | Submit empty | Action NOT called; error message displayed |
| persona-page.unit.components.003 | persona-card/favorite-agent-button.tsx | Toggling shows new state immediately | unit | Mock ToggleFavoriteAgent → OK with `[id]` | Click | aria-pressed transitions to true |
| persona-page.unit.components.004 | persona-card/persona-context-menu.tsx | "Publish" only visible to admin | unit | Render with isAdmin true/false | Snapshot | Hidden for non-admin |

---

## prompt-page — prompt-service

Target: `features/prompt-page/prompt-service.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| prompt-page.unit.prompt-service.001 | prompt-service.ts | `CreatePrompt` forces `isPublished:false` for non-admin | unit | non-admin session; ConfigContainer.create captures doc | Call `CreatePrompt({…, isPublished:true})` | doc `isPublished:false`, `userId:hashed`, `type:"PROMPT"`, id 36-char |
| prompt-page.unit.prompt-service.002 | prompt-service.ts | `CreatePrompt` validation rejects empty name | unit | Empty name | Call | ERROR with Zod messages |
| prompt-page.unit.prompt-service.003 | prompt-service.ts | `FindAllPrompts` SQL scopes by isPublished OR ownerId | integration | record querySpec | Call | Params include `@userId=hashed`, `@isPublished=true`, `@type=PROMPT` |
| prompt-page.unit.prompt-service.004 | prompt-service.ts | `FindPromptByID` returns NOT_FOUND when no rows | unit | query → [] | Call | NOT_FOUND |
| prompt-page.unit.prompt-service.005 | prompt-service.ts | `EnsurePromptOperation` rejects non-owner non-admin | unit | prompt.userId="other"; non-admin | Call | UNAUTHORIZED |
| prompt-page.unit.prompt-service.006 | prompt-service.ts | `EnsurePromptOperation` admin OK | unit | admin | Call | OK |
| prompt-page.unit.prompt-service.007 | prompt-service.ts | `DeletePrompt` calls item.delete with partition key | integration | EnsurePromptOperation OK | Call | item("p1", "<ownerHash>").delete called |
| prompt-page.unit.prompt-service.008 | prompt-service.ts | `UpsertPrompt` non-admin keeps existing isPublished | unit | existing `isPublished:true`; non-admin sends false | Call | upserted doc `isPublished:true` |

---

## prompt-page — components

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| prompt-page.unit.components.001 | add-new-prompt.tsx | Submits with name/description; shows error toast on action ERROR | unit | Mock action returning ERROR with message "fail" | Submit valid form | Toast/error region contains "fail" |
| prompt-page.unit.components.002 | prompt-card.tsx | Renders name + description; publish badge when isPublished | unit | — | Render with isPublished true | "Published" badge visible |

---

## extensions-page — extension-service

Target: `features/extensions-page/extension-services/extension-service.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| extensions-page.unit.extension-service.001 | extension-service.ts | `CreateExtension` forces isPublished=false for non-admin | unit | non-admin; capture upsert | Call with one valid function and one header | doc isPublished:false |
| extensions-page.unit.extension-service.002 | extension-service.ts | `CreateExtension` regenerates header/function ids (client-supplied ids ignored) | unit | input has headers/functions with id="client-1" | Call | upserted doc ids do NOT equal "client-1" and are 36-char ids |
| extensions-page.unit.extension-service.003 | extension-service.ts | `CreateExtension` writes header values to Key Vault and masks them | integration | KV `setSecret` spy | Call with header value="real-secret" | KV.setSecret called with `(headerId, "real-secret")`; persisted header.value === "**********" |
| extensions-page.unit.extension-service.004 | extension-service.ts | `CreateExtension` skips KV write if value already masked | unit | input header value === "**********" | Call | KV.setSecret NOT called for that header |
| extensions-page.unit.extension-service.005 | extension-service.ts | `CreateExtension` validation fails when function code not JSON | unit | function.code = "not json" | Call | ERROR with message containing "Error validating function schema" |
| extensions-page.unit.extension-service.006 | extension-service.ts | `CreateExtension` rejects functions with no `name` in JSON | unit | code = `'{"description":"x"}'` | Call | ERROR `"Function JSON must contain a 'name' field."` |
| extensions-page.unit.extension-service.007 | extension-service.ts | `CreateExtension` rejects functionName containing spaces | unit | functionName="my fn" | Call | ERROR `/cannot contain spaces/` |
| extensions-page.unit.extension-service.008 | extension-service.ts | `CreateExtension` rejects duplicate function names | unit | two functions same functionName | Call | ERROR `/already used/` |
| extensions-page.unit.extension-service.009 | extension-service.ts | `CreateExtension` requires at least one function | unit | functions: [] (and Zod-valid otherwise) | Call | ERROR `/At least one function is required/` |
| extensions-page.unit.extension-service.010 | extension-service.ts | `FindExtensionByID` returns NOT_FOUND when missing | unit | query → [] | Call | NOT_FOUND |
| extensions-page.unit.extension-service.011 | extension-service.ts | `EnsureExtensionOperation` rejects non-owner non-admin | unit | extension.userId="other"; non-admin | Call | UNAUTHORIZED |
| extensions-page.unit.extension-service.012 | extension-service.ts | `FindSecureHeaderValue` returns the secret value | unit | KV.getSecret → `{value:"shh"}` | Call | OK with `"shh"` |
| extensions-page.unit.extension-service.013 | extension-service.ts | `FindSecureHeaderValue` returns ERROR when KV value empty/undefined | unit | KV.getSecret → `{value:""}` | Call | ERROR |
| extensions-page.unit.extension-service.014 | extension-service.ts | `DeleteExtension` deletes secrets and the doc | integration | spy KV.beginDeleteSecret + item.delete | Call | beginDeleteSecret invoked per header; item.delete invoked once |
| extensions-page.unit.extension-service.015 | extension-service.ts | `UpdateExtension` preserves existing `isPublished` for non-admin | unit | existing isPublished:true; non-admin sends false | Call | upserted doc still isPublished:true |
| extensions-page.unit.extension-service.016 | extension-service.ts | `FindAllExtensionForCurrentUser` SQL scoping | integration | record querySpec | Call | `@userId=hashed`, `@isPublished=true`, query string has `r.isPublished=@isPublished OR r.userId=@userId` |
| extensions-page.unit.extension-service.017 | extension-service.ts | `FindAllExtensionForCurrentUserAndIds` adds ARRAY_CONTAINS predicate | integration | record querySpec | Call with `["e1","e2"]` | query includes ARRAY_CONTAINS @ids; `@ids=["e1","e2"]` |
| extensions-page.unit.extension-service.018 | extension-service.ts | `CreateChatWithExtension` attaches extension id to new thread | integration | FindExtensionByID OK; spy on UpsertChatThread | Call `"e1"` | UpsertChatThread payload `extension:["e1"]` |
| extensions-page.unit.extension-service.019 | extension-service.ts | `CreateChatWithExtension` surfaces FindExtensionByID error | unit | FindExtensionByID NOT_FOUND | Call | `{status:"ERROR", errors:[…NOT_FOUND messages]}` |

---

## extensions-page — components

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| extensions-page.unit.components.001 | add-extension/add-new-extension.tsx | Submitting calls CreateExtension and shows errors per error message | unit | mock action returning ERROR with two messages | Submit | Errors rendered to error-messages region |
| extensions-page.unit.components.002 | add-extension/add-function.tsx | "Function name" with space shows inline validation | unit | — | Type "my fn" then blur | Error displayed before submit |
| extensions-page.unit.components.003 | extension-card/extension-context-menu.tsx | "Publish" entry hidden for non-admin | unit | Render with isAdmin=false | Inspect | No publish menu item |

---

## reporting-page — reporting-service

Target: `features/reporting-page/reporting-services/reporting-service.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| reporting-page.unit.reporting-service.001 | reporting-service.ts | `FindAllChatThreadsForAdmin` rejects non-admin | unit | session non-admin | Call `(50,0)` | `{status:"ERROR", errors:[{message:/not authorized/i}]}` |
| reporting-page.unit.reporting-service.002 | reporting-service.ts | `FindAllChatThreadsForAdmin` admin OK paginates | integration | session admin; query records | Call `(25, 50)` | query parameters `@offset=50, @limit=25, @type=CHAT_THREAD`; query ends with `OFFSET @offset LIMIT @limit` |
| reporting-page.unit.reporting-service.003 | reporting-service.ts | `FindAllChatThreadsForAdmin` returns ERROR on Cosmos throw | unit | admin; query rejects | Call | ERROR |
| reporting-page.unit.reporting-service.004 | reporting-service.ts | `FindAllChatMessagesForAdmin` rejects non-admin | unit | non-admin | Call `"t1"` | ERROR not authorized |
| reporting-page.unit.reporting-service.005 | reporting-service.ts | `FindAllChatMessagesForAdmin` admin returns messages ordered asc | integration | admin; Cosmos returns 3 msgs | Call | OK; query orders by createdAt ASC; `@threadId="t1"` |

---

## main-menu — components

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| main-menu.unit.components.001 | main-menu.tsx | Shows /reporting link only for admins | unit | isAdmin=true vs false | Render both | Link present/absent accordingly |
| main-menu.unit.components.002 | theme-toggle.tsx | Toggling theme calls `setTheme` and updates aria-pressed | unit | Mock next-themes | Click | setTheme invoked with the opposite theme |
| main-menu.unit.components.003 | user-profile.tsx | Renders user name/email and avatar fallback when image empty | unit | session.user.image="" | Render | Avatar fallback letter visible |
| main-menu.unit.components.004 | user-usage.tsx | Displays formatted token count from GetDailyUsage | unit | mock GetDailyUsage returns totalInputTokens=12345 | Render | "12,345" appears |

---

## globals — message store

Target: `features/globals/global-message-store.tsx`.

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| globals.unit.store.001 | global-message-store.tsx | `showError` enqueues an error toast | unit | — | Call `showError("x")`; read snapshot | message list contains `{type:"error", message:"x"}` |
| globals.unit.store.002 | global-message-store.tsx | `showSuccess` enqueues success | unit | — | Call | success message present |
| globals.unit.store.003 | global-message-store.tsx | Subsequent calls accumulate | unit | — | Call success, then error | both messages present in order |

---

## ui — markdown / citations / code-block

Skipping primitives. Focus on rendering logic.

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| ui.unit.markdown.001 | markdown/markdown.tsx | Renders `**bold**` as `<strong>` | unit | — | Render `**hi**` | `<strong>hi</strong>` present |
| ui.unit.markdown.002 | markdown/code-block.tsx | Renders code with language class and copy button | unit | — | Render \`\`\`ts\nconsole.log(1)\`\`\` | Button with aria-label "Copy"; `<code class="language-ts">` |
| ui.unit.markdown.003 | markdown/code-block.tsx | Copy button copies text to clipboard | unit | mock `navigator.clipboard.writeText` | Click | writeText called with the code body |
| ui.unit.markdown.004 | markdown/citation.tsx | Inline citation `[1]` renders as link/marker referencing a citation id | unit | — | Render with citation list | Link/role exists for citation 1 |
| ui.unit.markdown.005 | markdown/citation-slider.tsx | Renders all citation cards and supports keyboard navigation | unit | 3 citations | Render | 3 cards; left/right arrow updates aria-current |
| ui.unit.error.001 | error/display-error.tsx | Renders array of error messages from ServerActionResponse | unit | Pass errors `[{message:"a"},{message:"b"}]` | Render | Both messages visible; role="alert" present |

---

## API routes — /api/chat

Target: `app/(authenticated)/api/chat/route.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| api.unit.chat.001 | route.ts | POST parses FormData and calls `ChatAPIEntry` with parsed UserPrompt + signal | unit | Mock `ChatAPIEntry` to return a `new Response("ok")`; build a FormData with content=JSON.stringify({message:"hi",id:"t1"}) and image-base64="" | Invoke POST(req) | ChatAPIEntry called with `{message:"hi", id:"t1", multimodalImage:""}` and `req.signal`; returns the mocked Response |
| api.unit.chat.002 | route.ts | POST returns 500 on parse failure | unit | content is not valid JSON | Invoke | Response 500 "Internal Server Error" |
| api.unit.chat.003 | route.ts | POST passes through `image-base64` as `multimodalImage` | unit | image-base64 = "data:image/png;base64,XYZ" | Invoke | ChatAPIEntry called with that multimodalImage |

---

## API routes — /api/code-interpreter/upload

Target: `app/(authenticated)/api/code-interpreter/upload/route.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| api.unit.ci-upload.001 | route.ts | Returns 400 when no file provided | unit | FormData has no `file` | Invoke | `Response.status === 400`; JSON body `{error:"No file provided"}` |
| api.unit.ci-upload.002 | route.ts | Returns 400 when file > 512MB | unit | Mock File with size=512*1024*1024+1 | Invoke | 400 with `/exceeds maximum/` |
| api.unit.ci-upload.003 | route.ts | Returns 400 when extension unsupported | unit | File name "x.exe" | Invoke | 400 with `/not supported/` |
| api.unit.ci-upload.004 | route.ts | Happy path returns 200 with `{id,name}` | unit | mock UploadFileForCodeInterpreter OK | Invoke `data.csv` | 200; body `{id:"file_abc", name:"data.csv"}` |
| api.unit.ci-upload.005 | route.ts | Returns 500 on UploadFileForCodeInterpreter ERROR | unit | mock returns ERROR | Invoke | 500 with `error.message` |
| api.unit.ci-upload.006 | route.ts | (auth gate documented but unenforced in handler) — getCurrentUser throwing yields 500 | unit | force getCurrentUser to throw | Invoke | Catches in outer try → 500 |

---

## API routes — /api/code-interpreter/file/[fileId]

Target: `app/(authenticated)/api/code-interpreter/file/[fileId]/route.ts`.

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| api.unit.ci-file.001 | route.ts | GET returns file bytes with content-type | unit | mock DownloadFileFromCodeInterpreter OK | Invoke with params.fileId | 200 with body bytes; `Content-Type` matches mock |
| api.unit.ci-file.002 | route.ts | GET returns 404 / error when download fails | unit | mock ERROR | Invoke | non-200 status with error body |

---

## API routes — /api/document

Target: `app/(authenticated)/api/document/route.ts`.

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| api.unit.document.001 | route.ts | Delegates to `SearchAzureAISimilarDocuments(req)` | unit | mock that function | POST | Mock called with request; response forwarded |

---

## API routes — /api/images

Target: `app/(authenticated)/api/images/route.ts`.

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| api.unit.images.001 | route.ts | GET delegates to ImageAPIEntry | unit | mock ImageAPIEntry returning Response | GET | mock called; response forwarded |
| api.unit.images.002 | route.ts | Returns blob bytes with correct content type when ImageAPIEntry returns image | integration | use real ImageAPIEntry with mocked storage returning a PNG buffer | GET `?t=t&img=a.png` | 200; content-type starts with `image/` |

---

## API routes — /health

Target: `app/health/route.ts`.

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| api.unit.health.001 | route.ts | GET returns 200 `{status:"ok"}` | unit | — | Invoke | 200; JSON body matches |

---

## Middleware — proxy.ts

Target: `proxy.ts`. Unit-test by constructing `NextRequest` and stubbing `getToken`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| middleware.unit.proxy.001 | proxy.ts | Logged-in user hitting `/` is redirected to `/chat` | unit | mock getToken → `{isAdmin:false}`; request `/` | Invoke | NextResponse.redirect to `/chat` |
| middleware.unit.proxy.002 | proxy.ts | Anonymous user hitting `/chat/x` is redirected to `/` | unit | getToken → null; request `/chat/x` | Invoke | redirect to `/` |
| middleware.unit.proxy.003 | proxy.ts | Authenticated non-admin hitting `/reporting` is rewritten to `/unauthorized` | unit | getToken → `{isAdmin:false}`; request `/reporting` | Invoke | NextResponse.rewrite to `/unauthorized` |
| middleware.unit.proxy.004 | proxy.ts | Authenticated admin hitting `/reporting` passes through | unit | getToken → `{isAdmin:true}` | Invoke | `NextResponse.next()` (no redirect/rewrite) |
| middleware.unit.proxy.005 | proxy.ts | Anonymous user hitting `/` passes through (no redirect) | unit | getToken → null; request `/` | Invoke | next() — important: NOT redirected to `/chat` (only logged-in users are) |
| middleware.unit.proxy.006 | proxy.ts | Authenticated user hitting `/api/chat` passes through | unit | getToken → `{}`; request `/api/chat` | Invoke | next() (no redirect) |
| middleware.unit.proxy.007 | proxy.ts | Authenticated non-admin hitting `/reporting/chat/abc` is rewritten | unit | getToken → `{isAdmin:false}`; `/reporting/chat/abc` | Invoke | rewrite to `/unauthorized` |
| middleware.unit.proxy.008 | proxy.ts | Anonymous hitting `/api/images` redirects to `/` (not 401) | unit | getToken → null | Invoke | redirect `/` |

---

## E2E — Playwright journeys

Tests live in `e2e/`. Setup writes a logged-in session to `e2e/.auth/user.json` (default `test@example.com`, non-admin) and `admin.json` for the admin journey. Existing `smoke.spec.ts` covers `/health` 200 and `/chat` reachability. The cases below extend coverage with route interception for deterministic data.

### E2E cases

| ID | Title | User flow | Route interceptions / fixtures needed | Expected outcome |
|---|---|---|---|---|
| e2e.001 | Anonymous redirect to home | Clear auth; navigate `/chat` | Use a fresh `browserContext()` with no storageState; intercept `/api/auth/session` → 200 with no user | URL settles at `/` (login page); `/chat` is not rendered |
| e2e.002 | Authenticated user reaches /chat shell | Default storageState (user.json); navigate `/chat` | None required | Page renders without 5xx; `data-testid="chat-menu"` (or equivalent landmark) is visible; URL is not `/` |
| e2e.003 | Non-admin /reporting redirected to /unauthorized | Default storageState; navigate `/reporting` | None | Final URL or visible content indicates `/unauthorized` |
| e2e.004 | Admin can load /reporting | storageState=admin.json; navigate `/reporting` | Intercept Cosmos via `/api/...` if any reporting actions; alternatively stub the server action via test-only seed. **Minimum**: page renders an admin table heading | 200; admin table visible |
| e2e.005 | Send a chat message with SSE stub | Open `/chat`; click "New chat"; type "hello"; press send | `page.route("**/api/chat", route => route.fulfill({ headers:{"content-type":"text/event-stream"}, body:"event: content\ndata: {\"type\":\"content\",\"response\":{\"choices\":[{\"message\":{\"content\":\"Hi!\",\"role\":\"assistant\"}}],\"id\":\"m1\"}}\n\nevent: usageData\ndata: {\"type\":\"usageData\",\"response\":{\"inputTokens\":1,\"outputTokens\":1,\"cachedTokens\":0,\"totalTokens\":2,\"costUsd\":0,\"threadTotalCostUsd\":0,\"threadTotalTokens\":2,\"contextWindowSize\":128000,\"contextUsagePercent\":0,\"model\":\"gpt-5.4-mini\"}}\n\nevent: finalContent\ndata: {\"type\":\"finalContent\",\"response\":\"Hi!\"}\n\n" }))`. Also intercept `/api/chat/**` create-thread server actions if needed. | Assistant message "Hi!" is rendered in the conversation; user message echoed |
| e2e.006 | Streaming error displays inline error toast | Same as e2e.005 but mock body emits `event: error\ndata: {"type":"error","response":"boom"}\n\n` | Same | Error toast or inline error region shows "boom" |
| e2e.007 | Persona library load and selection | Navigate `/persona`; click first persona card | Intercept Cosmos via server actions OR pre-seed via test-only API. Minimum: page rendered without 5xx; if "New chat with this agent" button visible, clicking it routes to `/chat/<id>` | Card list visible; clicking persona triggers navigation to a chat thread URL |
| e2e.008 | Prompt library open and create | Navigate `/prompt`; click "Add new"; fill name + description; submit | Intercept the `CreatePrompt` server action (POST to current page action endpoint). Stub to return OK | New prompt appears in list; no error toast |
| e2e.009 | Switch persona in active thread updates header | Open existing thread (seed via storage or stub); pick a different persona | Intercept `UpsertChatThread`/`UpdateChatThreadSelectedModel` server action | Thread header text updates to new persona name |
| e2e.010 | Health endpoint reachable without auth | New context with no storageState; `request.get("/health")` | None | 200; body `{ status: "ok" }` |
| e2e.011 | /api/code-interpreter/upload rejects unsupported file | Authenticated request via `page.request.post` with `evil.exe` | None | 400; JSON body contains "not supported" |
| e2e.012 | Admin sees /reporting nav link; non-admin does not | Compare main menu rendering between default and admin contexts | None | Admin context shows reporting link; non-admin does not |

---

## Gap-fill cases (auditor pass 2026-05-15)

The catalog up to this point enumerates ~282 cases. The auditor pass below adds explicit positive AND negative cases for every exported surface in `INVENTORY.md` that was previously uncovered or covered only on one branch. IDs continue the existing pattern; new sub-tables are appended to each feature section in spirit but listed contiguously here for review.

### auth-page — gap-fills

Source: `features/auth-page/helpers.ts` lines 6-50, `auth-api.ts` admin parser lines 99-205.

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| auth-page.unit.helpers.012 | helpers.ts | `userSession` flags admin when email matches ADMIN_EMAIL_ADDRESS | unit | `vi.stubEnv("ADMIN_EMAIL_ADDRESS","test@example.com")`; default session | Call `userSession()` | Returns UserModel with `isAdmin: true` |
| auth-page.unit.helpers.013 | helpers.ts | `userSession` `isAdmin` false when email NOT in ADMIN_EMAIL_ADDRESS list | unit | `vi.stubEnv("ADMIN_EMAIL_ADDRESS","other@example.com")` | Call | `isAdmin:false` |
| auth-page.unit.helpers.014 | helpers.ts | `userSession` tolerates ADMIN_EMAIL_ADDRESS missing entirely | unit | `vi.stubEnv("ADMIN_EMAIL_ADDRESS","")` | Call | `isAdmin:false`; no throw |
| auth-page.unit.helpers.015 | helpers.ts | `hashValue` rejects undefined input (TypeError surfaces) | unit | — | Call `hashValue(undefined as any)` | Throws (crypto rejects non-string); document chosen behavior |
| auth-page.unit.auth-api.001 | auth-api.ts | NextAuth `options` admin parser splits comma-separated list and trims | unit | `vi.stubEnv("ADMIN_EMAIL_ADDRESS"," a@x.com , b@y.com ")` | Re-import module; call `session({ token: {email:"b@y.com"} })` callback | Token reflects `isAdmin:true` for `b@y.com` |
| auth-page.unit.auth-api.002 | auth-api.ts | `signIn` callback rejects when no email present | unit | Invoke options.callbacks.signIn with user `{email:""}` | Returns `false`/redirect |
| auth-page.unit.logout.001 | logout-on-session-expired.ts | Triggers `signOut` when response code is SESSION_EXPIRED | unit | Mock `signOut` | Call with `{status:"UNAUTHORIZED", errors:[{code:"SESSION_EXPIRED"}]}` | signOut called once |
| auth-page.unit.logout.002 | logout-on-session-expired.ts | No-op when no SESSION_EXPIRED error code | unit | — | Call with `{status:"ERROR", errors:[{message:"x"}]}` | signOut NOT called |
| auth-page.unit.login.001 | login.tsx | Renders provider buttons given `isDevMode` flag | unit | Render `<LogIn isDevMode={true} />` | Inspect | Credentials form visible |
| auth-page.unit.login.002 | login.tsx | Hides credentials form in production mode | unit | `isDevMode={false}` | Render | Credentials form absent; only OAuth buttons |

### common — gap-fills (util / schema / hooks)

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| common.unit.util.005 | util.ts | `sortByTimestamp` handles missing `lastMessageAt` defensively (negative) | unit | — | Sort `[{lastMessageAt:undefined},{lastMessageAt:new Date()}]` | Either returns NaN-handled stable order or document throw. No silent corruption of array length |
| common.unit.nav.005 | navigation-helpers.ts | `RedirectToChatThread` with empty id still calls redirect with `/chat/` | unit | — | Call `RedirectToChatThread("")` | `NEXT_REDIRECT:/chat/` (documents the no-validation behavior) |
| common.unit.hooks.001 | hooks/useResetableActionState.ts | reset() returns state to initial after action call | unit | React test wrapper | Call action that mutates state, then reset | Returned state equals initial |
| common.unit.hooks.002 | hooks/useProfilePicture.ts | Returns empty string when token is undefined (negative) | unit | `useProfilePicture(undefined)` | Render | Result === "" |
| common.unit.hooks.003 | hooks/useProfilePicture.ts | Resolves profile picture URL when token present | unit | mock fetch to return a Blob | render with `"tkn"` | Returns object URL once resolved |

### common — usage-service gap-fills

Source: `features/common/services/usage-service.ts` lines 23-200; `CheckLimits` has nested branches.

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| common.unit.usage.011 | usage-service.ts | `GetWeeklyUsage` returns ERROR on Cosmos throw (negative) | unit | `fetchAll` rejects | Call | `{status:"ERROR", errors:[…]}` |
| common.unit.usage.012 | usage-service.ts | `GetDailyUsage` returns ERROR when current user lookup throws (negative) | unit | `getServerSession` → null so `userHashedId()` throws | Call `GetDailyUsage()` | ERROR envelope |
| common.unit.usage.013 | usage-service.ts | `CheckLimits` returns `{exceeded:false}` when neither limit defined (already covered .005, but verify with model AND usage row present) | unit | model config without limits; usage row exists | Call | `{exceeded:false}` |
| common.unit.usage.014 | usage-service.ts | `CheckLimits` returns ERROR / `{exceeded:false}` when MODEL_CONFIGS lacks the model (negative) | unit | Pass `model:"gpt-unknown"` | Call | `{exceeded:false}` (no crash) — confirms safe defaulting |

### common — azure-storage / chat-metrics / news-service

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| common.unit.storage.001 | services/azure-storage.ts | `UploadBlob` happy path uploads buffer and returns OK with URL | unit | Mock BlobServiceClient/getContainerClient chain | Call with `("images","t/a.png", buf, {contentType:"image/png"})` | `{status:"OK", response:<url>}`; uploadData called with buffer |
| common.unit.storage.002 | services/azure-storage.ts | `UploadBlob` returns ERROR when underlying client rejects (negative) | unit | Mock `uploadData` rejects | Call | ERROR envelope |
| common.unit.storage.003 | services/azure-storage.ts | `GetBlob` returns OK with stream+contentType when blob exists | unit | Mock `download` resolving with readableStreamBody, properties.contentType | Call | OK; `response.contentType` matches mock |
| common.unit.storage.004 | services/azure-storage.ts | `GetBlob` returns ERROR (404 mapped) when blob missing | unit | Mock `download` throws RestError 404 | Call | ERROR with `/not found/i` |
| common.unit.metrics.001 | services/chat-metrics-service.ts | `reportPromptTokens` records metric with model+role tags | unit | spy on metrics meter | Call `(1234, "gpt-5.5", "user")` | meter.add called with `1234` and attributes `{model, role}` |
| common.unit.metrics.002 | services/chat-metrics-service.ts | `reportCompletionTokens` no-throw when meter unavailable (negative) | unit | force `getMeter` to throw | Call | Resolves without throwing |
| common.unit.metrics.003 | services/chat-metrics-service.ts | `reportUserChatMessage` increments counter once | unit | spy meter | Call | counter.add(1) called once |
| common.unit.news.001 | services/news-service/news-service.ts | `FindAllNewsArticles` returns OK list when source resolves | unit | mock fetch / loader → `[{title,date,body}]` | Call | OK with that array |
| common.unit.news.002 | services/news-service/news-service.ts | `FindAllNewsArticles` returns OK with empty array on source error (negative) | unit | force loader to throw | Call | OK with `[]` OR ERROR — document the chosen behavior; assert observable shape |

### chat-page — prompt-builder gap-fill (negative)

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.prompt-builder.007 | prompt-builder.ts | `sortFunctionTools` with tools missing `name` does not throw (negative) | unit | — | Call with `[{description:"x"},{name:"a"}]` | Returns array; nameless tools sorted to a documented position (e.g. last) |

### chat-page — chat-thread-service gap-fills

Source: `features/chat-page/chat-services/chat-thread-service.ts` lines 31-619. Several exports were under-covered.

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.thread-service.033 | chat-thread-service.ts | `UpsertChatThread` returns ERROR when Cosmos upsert throws (negative) | unit | upsert rejects with `"throttle"` | Call (new thread; bypass ensure gate) | ERROR envelope including message |
| chat-page.unit.thread-service.034 | chat-thread-service.ts | `CreateChatThread` returns ERROR when underlying upsert returns no resource (negative) | unit | upsert returns `{resource:undefined}` | Call | ERROR `/Unable to create chat thread/` (or current message) |
| chat-page.unit.thread-service.035 | chat-thread-service.ts | `ResetChatThread` re-creates thread state | unit | thread exists | Call `ResetChatThread("t1")` | upsert with cleared fields (extension=[], attachedFiles=[]); cache revalidated |
| chat-page.unit.thread-service.036 | chat-thread-service.ts | `ResetChatThread` NOT_FOUND when thread missing (negative) | unit | find returns NOT_FOUND | Call | NOT_FOUND returned |
| chat-page.unit.thread-service.037 | chat-thread-service.ts | `UpdateChatThreadCodeInterpreterContainer` writes container id | unit | thread exists | Call with `"cnt-1"` | upsert sets `codeInterpreterContainer:"cnt-1"` |
| chat-page.unit.thread-service.038 | chat-thread-service.ts | `UpdateChatThreadCodeInterpreterContainer` NOT_FOUND when thread missing (negative) | unit | find NOT_FOUND | Call | NOT_FOUND |
| chat-page.unit.thread-service.039 | chat-thread-service.ts | `UpdateChatThreadAttachedFiles` replaces entire attachedFiles list | unit | thread.attachedFiles=[{id:"a"}] | Call with `[{id:"b"},{id:"c"}]` | upsert with exact replacement |
| chat-page.unit.thread-service.040 | chat-thread-service.ts | `UpdateChatThreadAttachedFiles` rejects when ensure fails (negative) | unit | other user's thread; non-admin | Call | UNAUTHORIZED-equivalent response; no upsert |
| chat-page.unit.thread-service.041 | chat-thread-service.ts | `SoftDeleteChatDocumentsForCurrentUser` soft-deletes documents for thread | unit | docs exist for thread | Call | each doc upserted with `isDeleted:true`; search docs cleanup invoked |
| chat-page.unit.thread-service.042 | chat-thread-service.ts | `SoftDeleteChatDocumentsForCurrentUser` returns ERROR when find docs throws (negative) | unit | FindAllChatDocuments returns ERROR | Call | Propagated ERROR |
| chat-page.unit.thread-service.043 | chat-thread-service.ts | `UpdateChatThreadReasoningEffort` returns NOT_FOUND when thread missing (negative) | unit | find NOT_FOUND | Call | NOT_FOUND |
| chat-page.unit.thread-service.044 | chat-thread-service.ts | `UpdateChatThreadSelectedModel` returns NOT_FOUND when thread missing (negative) | unit | find NOT_FOUND | Call | NOT_FOUND |
| chat-page.unit.thread-service.045 | chat-thread-service.ts | `AddExtensionToChatThread` returns NOT_FOUND when thread missing (negative) | unit | find NOT_FOUND | Call | NOT_FOUND |
| chat-page.unit.thread-service.046 | chat-thread-service.ts | `RemoveExtensionFromChatThread` is idempotent for missing id (negative) | unit | thread.extension=["a"] | Call with `"missing"` | upsert called with `["a"]` OR no upsert; document; verify final state |
| chat-page.unit.thread-service.047 | chat-thread-service.ts | `AddAttachedFile` returns NOT_FOUND when thread missing (negative) | unit | find NOT_FOUND | Call | NOT_FOUND |
| chat-page.unit.thread-service.048 | chat-thread-service.ts | `CreateChatAndRedirect` rethrows when CreateChatThread ERRORs (negative) | unit | CreateChatThread returns ERROR | Call | redirect NOT called; error surfaced/thrown |

### chat-page — chat-message-service gap-fills

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.message-service.011 | chat-message-service.ts | `CreateChatMessage` returns ERROR when Cosmos upsert throws (negative) | unit | upsert rejects | Call | ERROR envelope |
| chat-page.unit.message-service.012 | chat-message-service.ts | `UpsertChatMessage` defaults `userId` to hashed id when not provided | unit | message without userId | Call | upserted doc has `userId:hashed` |
| chat-page.unit.message-service.013 | chat-message-service.ts | `FindTopChatMessagesForCurrentUser` returns ERROR on Cosmos throw (negative) | unit | fetchAll rejects | Call | ERROR |
| chat-page.unit.message-service.014 | chat-message-service.ts | `UpdateChatMessage` returns ERROR when underlying upsert throws (negative) | unit | upsert rejects after find OK | Call | ERROR |

### chat-page — chat-document-service gap-fills

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.document-service.006 | chat-document-service.ts | `CrackDocument` ERROR on LoadFile failure (negative) | unit | LoadFile returns ERROR | Call with `.pdf` | Propagated ERROR |
| chat-page.unit.document-service.007 | chat-document-service.ts | `FindAllChatDocuments` returns OK with `[]` when no docs (positive empty) | unit | resources `[]` | Call | `{status:"OK", response:[]}` |
| chat-page.unit.document-service.008 | chat-document-service.ts | `FindAllChatDocuments` returns ERROR on throw (negative) | unit | fetchAll rejects | Call | ERROR |
| chat-page.unit.document-service.009 | chat-document-service.ts | `CreateChatDocument` returns OK with persisted resource (positive) | unit | upsert returns `{resource:{…}}` | Call `("f.pdf","t1")` | OK with the resource; doc has hashed userId, `type:CHAT_DOCUMENT`, `isDeleted:false` |
| chat-page.unit.document-service.010 | chat-document-service.ts | `CreateChatDocument` returns ERROR when no resource returned (negative) | unit | upsert returns `{resource:undefined}` | Call | ERROR `/Unable to save chat document/` |
| chat-page.unit.document-service.011 | chat-document-service.ts | `ChunkDocumentWithOverlap` returns single chunk when doc ≤ CHUNK_SIZE | unit | 100-char string | Call | array length 1 |
| chat-page.unit.document-service.012 | chat-document-service.ts | `ChunkDocumentWithOverlap` overlap shifts by 75% chunk size | unit | 5000-char string | Call | All adjacent chunks share at least CHUNK_OVERLAP chars at the boundary |
| chat-page.unit.document-service.013 | chat-document-service.ts | `ChunkDocumentWithOverlap` empty string yields single empty chunk | unit | `""` | Call | `[""]` (documents edge case) |

### chat-page — chat-image-service gap-fill

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.image-service.006 | chat-image-service.ts | `UploadImageToStore` propagates UploadBlob ERROR (negative) | unit | UploadBlob returns ERROR | Call | Same ERROR returned |
| chat-page.unit.image-service.007 | chat-image-service.ts | `GetImageFromStore` propagates GetBlob ERROR (negative) | unit | GetBlob returns ERROR | Call | ERROR |
| chat-page.unit.image-service.008 | chat-image-service.ts | `GetThreadAndImageFromUrl` ERROR when URL invalid (negative) | unit | — | Call with `"not a url"` | Throws or returns ERROR; assert observable behavior |

### chat-page — chat-image-persistence-service (new section — was missing)

Source: `features/chat-page/chat-services/chat-image-persistence-service.ts` lines 20-257.

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.image-persistence.001 | chat-image-persistence-service.ts | `persistBase64Image` happy path uploads + returns `blob://t/id.ext` | unit | mock UploadImageToStore → OK | Call with valid `data:image/png;base64,…` | OK; response matches `/^blob:\/\/t\/[a-z0-9]+\.png$/i` |
| chat-page.unit.image-persistence.002 | chat-image-persistence-service.ts | `persistBase64Image` ERROR on invalid base64 format (negative) | unit | — | Call with `"not-base64"` | `{status:"ERROR", errors:[{message:/Invalid base64/}]}` |
| chat-page.unit.image-persistence.003 | chat-image-persistence-service.ts | `persistBase64Image` propagates upload ERROR (negative) | unit | UploadImageToStore returns ERROR | Call with valid base64 | Same ERROR returned |
| chat-page.unit.image-persistence.004 | chat-image-persistence-service.ts | `persistBase64Image` jpg mimeType normalized to image/jpeg | unit | spy on UploadImageToStore | Call with `data:image/jpg;base64,X` | UploadImageToStore receives `contentType:"image/jpeg"` |
| chat-page.unit.image-persistence.005 | chat-image-persistence-service.ts | `resolveImageReference` returns API URL for valid ref (positive) | unit | NEXTAUTH_URL set | Call `"blob://t/a.png"` | OK; URL contains `?t=t&img=a.png` |
| chat-page.unit.image-persistence.006 | chat-image-persistence-service.ts | `resolveImageReference` ERROR on bad ref (negative) | unit | — | Call `"http://x"` | `{status:"ERROR", errors:[{message:/Invalid image reference/}]}` |
| chat-page.unit.image-persistence.007 | chat-image-persistence-service.ts | `processMessageForImagePersistence` replaces base64 content with reference | unit | mock persistBase64Image → OK with `"blob://t/x.png"` | Call with `(threadId, base64String, undefined)` | Returns `{content:"blob://t/x.png"}` |
| chat-page.unit.image-persistence.008 | chat-image-persistence-service.ts | `processMessageForImagePersistence` no-op when content is plain text (negative-of-branch) | unit | — | Call with plain text | content returned unchanged; no persist call |
| chat-page.unit.image-persistence.009 | chat-image-persistence-service.ts | `processMessageForImagePersistence` keeps original content when persist FAILS (graceful) | unit | persistBase64Image returns ERROR | Call | original base64 content returned (no throw) |
| chat-page.unit.image-persistence.010 | chat-image-persistence-service.ts | `getBase64ImageReference` returns base64 data URL for valid blob ref | unit | parseImageReference OK; GetImageFromStore returns stream | Call `"blob://t/a.png"` | Returns `data:image/png;base64,<…>` |
| chat-page.unit.image-persistence.011 | chat-image-persistence-service.ts | `getBase64ImageReference` throws on invalid reference (negative) | unit | — | Call `"http://invalid"` | Throws `Error(/Failed to retrieve/)` |
| chat-page.unit.image-persistence.012 | chat-image-persistence-service.ts | `getBase64ImageReference` follows http→ref path via getImageRefFromUrl | unit | URL passed | Call `"http://localhost:3000/api/images?t=t&img=a.png"` | Resolves to base64 |
| chat-page.unit.image-persistence.013 | chat-image-persistence-service.ts | `processMessageForImageResolution` replaces ref with URL (positive) | unit | resolveImageReference returns OK | Call with `("blob://t/a.png", undefined)` | content replaced with URL |
| chat-page.unit.image-persistence.014 | chat-image-persistence-service.ts | `processMessageForImageResolution` no-op for plain text (negative-of-branch) | unit | — | Call with plain text | content unchanged |

### chat-page — chat-image-persistence-utils gap-fill

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.image-utils.009 | chat-image-persistence-utils.ts | `getImageRefFromUrl` extracts ref from valid URL (positive) | unit | — | Call `"http://h/api/images?t=t&img=a.png"` | `"blob://t/a.png"` |
| chat-page.unit.image-utils.010 | chat-image-persistence-utils.ts | `getImageRefFromUrl` returns null when URL missing query (negative) | unit | — | Call `"http://h/x"` | `null` |

### chat-page — code-interpreter-service gap-fills

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.ci-service.006 | code-interpreter-service.ts | `DeleteFileFromCodeInterpreter` returns OK on success (positive) | unit | mock OpenAIV1Instance().files.del → OK | Call `"file_abc"` | OK |
| chat-page.unit.ci-service.007 | code-interpreter-service.ts | `DeleteFileFromCodeInterpreter` returns ERROR on throw (negative) | unit | files.del rejects | Call | ERROR envelope |
| chat-page.unit.ci-service.008 | code-interpreter-service.ts | `DownloadContainerFile` happy path returns buffer + name (positive) | unit | mock container files.content → arrayBuffer | Call `(containerId, fileId)` | OK with buffer, contentType derived from filename |
| chat-page.unit.ci-service.009 | code-interpreter-service.ts | `DownloadContainerFile` ERROR when container call rejects (negative) | unit | content rejects | Call | ERROR |
| chat-page.unit.ci-service.010 | code-interpreter-service.ts | `DownloadFileFromCodeInterpreter` ERROR on retrieve failure (negative) | unit | files.retrieve rejects | Call | ERROR |

### chat-page — citation-service gap-fills

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.citation.006 | citation-service.ts | `CreateCitation` ERROR when Cosmos throws (negative) | unit | items.create rejects | Call | ERROR envelope |
| chat-page.unit.citation.007 | citation-service.ts | `FindCitationByID` NOT_FOUND when no rows (negative) | unit | query → [] | Call | NOT_FOUND |
| chat-page.unit.citation.008 | citation-service.ts | `FindCitationByID` ERROR on throw (negative) | unit | fetchAll rejects | Call | ERROR |
| chat-page.unit.citation.009 | citation-service.ts | `FormatCitations` returns deduped citation list (positive) | unit | input `[{id:"a"},{id:"a"},{id:"b"}]` | Call | `[{id:"a"},{id:"b"}]` (or document chosen merge rule) |
| chat-page.unit.citation.010 | citation-service.ts | `FormatCitations` handles empty array (negative-edge) | unit | — | Call `[]` | `[]` |

### chat-page — utils (mapOpenAIChatMessages) gap-fill

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.utils.006 | utils.ts | Throws or returns ERROR when getBase64ImageReference rejects (negative) | unit | stub `getBase64ImageReference` to reject | Pass user message with multiModalImage | Function surfaces the failure (test asserts observable rejection or returned ERROR per implementation) |
| chat-page.unit.utils.007 | utils.ts | Returns empty array when input is empty (positive-edge) | unit | — | Pass `[]` | `[]` |

### chat-page — chat-menu-service gap-fills

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.menu-service.006 | chat-menu-service.ts | `UpdateChatThreadTitle` ERROR when find returns NOT_FOUND (negative) | unit | find NOT_FOUND | Call | NOT_FOUND propagated; no upsert |
| chat-page.unit.menu-service.007 | chat-menu-service.ts | `BookmarkChatThread` ERROR when find ERRORs (negative) | unit | find ERROR | Call | ERROR propagated |
| chat-page.unit.menu-service.008 | chat-menu-service.ts | `BookmarkChatThread` toggles bookmarked=false→true and true→false across two calls (positive) | unit | thread starts false | Call twice | First call upsert true; second call upsert false |

### chat-page — azure-ai-search gap-fills

Source: `features/chat-page/chat-services/azure-ai-search/azure-ai-search.ts` lines 31-508 — several exports not in catalog.

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.search.010 | azure-ai-search.ts | `SimpleSearch` ERROR when SearchClient throws (negative) | unit | search.search rejects | Call | ERROR envelope |
| chat-page.unit.search.011 | azure-ai-search.ts | `SimilaritySearch` ERROR when embedding API rejects (negative) | unit | OpenAIEmbedding rejects | Call with `shouldCreateEmbedding=true` | ERROR |
| chat-page.unit.search.012 | azure-ai-search.ts | `PersonaDocumentExistsInIndex` returns true when search returns ≥1 doc (positive) | unit | search yields 1 result | Call `(personaDocId)` | true |
| chat-page.unit.search.013 | azure-ai-search.ts | `PersonaDocumentExistsInIndex` returns false when search yields nothing (negative-of-branch) | unit | empty async iterable | Call | false |
| chat-page.unit.search.014 | azure-ai-search.ts | `ExtensionSimilaritySearch` returns mapped results (positive) | integration | mocks for embeddings + search | Call with extensionId | OK; results array |
| chat-page.unit.search.015 | azure-ai-search.ts | `ExtensionSimilaritySearch` ERROR on embedding failure (negative) | unit | embeddings reject | Call | ERROR |
| chat-page.unit.search.016 | azure-ai-search.ts | `EmbedDocuments` returns vectors aligned to inputs (positive) | unit | OpenAIEmbedding returns `[{embedding:[…]}]` per input | Call with 3 strings | array length 3 |
| chat-page.unit.search.017 | azure-ai-search.ts | `EmbedDocuments` propagates ERROR (negative) | unit | reject | Call | ERROR |
| chat-page.unit.search.018 | azure-ai-search.ts | `IndexDocuments` returns ERROR when EmbedDocuments fails (negative) | unit | EmbedDocuments ERROR | Call | Propagated ERROR |
| chat-page.unit.search.019 | azure-ai-search.ts | `DeleteSearchDocumentByPersonaDocumentId` ERROR on search failure (negative) | unit | SimpleSearch ERROR | Call | ERROR |
| chat-page.unit.search.020 | azure-ai-search.ts | `EnsureIndexIsCreated` ERROR when createIndex also throws (negative) | unit | getIndex throws AND createIndex throws | Call | ERROR envelope |

### chat-page — function-registry & conversation-manager gap-fills

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.fn-registry.006 | function-registry.ts | `getAvailableFunctions` returns the registered tool list (positive) | unit | register two functions; call | Result includes both definitions |
| chat-page.unit.fn-registry.007 | function-registry.ts | `getAvailableFunctions` returns `[]` when registry empty (negative-edge) | unit | reset registry | Call | `[]` |
| chat-page.unit.fn-registry.008 | function-registry.ts | `getToolByName` returns null when unknown (negative) | unit | empty | Call `"missing"` | `null` |
| chat-page.unit.fn-registry.009 | function-registry.ts | `getToolByName` returns definition for registered name (positive) | unit | register `"ping"` | Call | definition with `name:"ping"` |
| chat-page.unit.fn-registry.010 | function-registry.ts | `buildSubAgentTool` returns a callable tool definition (positive) | unit | mock OpenAIV1Instance | Call with valid persona | tool def with `name`, `description`, `parameters` |
| chat-page.unit.fn-registry.011 | function-registry.ts | `buildSubAgentTool` returns null/throws on missing persona (negative) | unit | persona id not found | Call | Either null or thrown Error — assert observable |
| chat-page.unit.fn-registry.012 | function-registry.ts | `registerDynamicFunction` adds tool callable via executeFunction (positive) | integration | — | register + execute | output flows |
| chat-page.unit.fn-registry.013 | function-registry.ts | `registerDynamicFunction` overrides existing (positive-replacement) | unit | register name twice | execute | Last impl runs |
| chat-page.unit.conv-mgr.005 | conversation-manager.ts | `continueConversation` re-invokes responses.create with accumulated input (positive) | unit | spy on openaiInstance.responses.create | Call with non-empty state | call args include the previous function_call_output items |
| chat-page.unit.conv-mgr.006 | conversation-manager.ts | `continueConversation` rejects when openai rejects (negative) | unit | mock rejects | Call | Rejection propagated |
| chat-page.unit.conv-mgr.007 | conversation-manager.ts | `getConversationInput` returns the current state input array (positive) | unit | seed state with 3 items | Call | array length 3, identity matches |
| chat-page.unit.conv-mgr.008 | conversation-manager.ts | `processFunctionCall` returns success:false when name not registered (negative) | unit | empty registry | Call with `{name:"missing"}` | `{success:false}`; updatedState still includes function_call_output |

### chat-page — openai-responses-stream gap-fills

Source: lines 1-end. Already has 16 cases; add explicit error-path cases.

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.stream.017 | openai-responses-stream.ts | Emits `error` event when UpsertChatMessage rejects during save (negative) | unit | mock UpsertChatMessage rejects on completion | Run stream | SSE `event: error` is observed before close |
| chat-page.unit.stream.018 | openai-responses-stream.ts | Stream closes cleanly when AbortSignal fires mid-stream (negative) | unit | Pass an AbortController; abort after 1 delta | Read SSE | Stream terminates without final usageData; no unhandled rejection |
| chat-page.unit.stream.019 | openai-responses-stream.ts | Handles zero deltas + completion (positive-edge) | unit | yield only `response.completed` with usage | Read | `finalContent` event has empty string; usageData present |

### chat-page — chat-api / chat-api-response / chat-api-text / chat-api-rag-extension (new sections)

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.chat-api.001 | chat-api.ts | `ChatAPIEntry` delegates to ChatAPIResponse on valid input (positive) | unit | mock ChatAPIResponse returns Response("ok") | Call `({message:"hi",id:"t",multimodalImage:""},signal)` | Returns mocked Response |
| chat-page.unit.chat-api.002 | chat-api.ts | `ChatAPIEntry` returns 400 "Missing File Extension" when base64 image lacks header (negative) | unit | multimodalImage = "garbage" | Call | Response.status === 400, body `"Missing File Extension"` |
| chat-page.unit.chat-api.003 | chat-api.ts | `ChatAPIEntry` returns 400 when file extension unsupported (negative) | unit | `data:image/bmp;base64,X` | Call | 400 `"Filetype is not supported"` |
| chat-page.unit.chat-api.004 | chat-api.ts | `ChatAPIEntry` returns 500 when ChatAPIResponse throws (negative) | unit | ChatAPIResponse rejects | Call | 500 with error message body |
| chat-page.unit.chat-api-response.001 | chat-api-response.ts | `ChatAPIResponse` happy path returns a Response with ReadableStream (positive) | integration | mock OpenAI + Cosmos + persona resolve | Call | response.body is a ReadableStream |
| chat-page.unit.chat-api-response.002 | chat-api-response.ts | `ChatAPIResponse` returns ERROR response when thread find ERRORs (negative) | unit | FindChatThreadForCurrentUser → NOT_FOUND | Call | Response body contains NOT_FOUND error |
| chat-page.unit.chat-api-response.003 | chat-api-response.ts | `ChatAPIResponse` applies usage fallback when CheckLimits exceeded (positive-of-branch) | unit | CheckLimits → exceeded with fallbackModel | Call | underlying model used is fallbackModel; usageWarning surfaced |
| chat-page.unit.chat-api-text.001 | chat-api-text.tsx | `ChatApiText` returns generated text on success (positive) | unit | mock OpenAI text response | Call | returns text |
| chat-page.unit.chat-api-text.002 | chat-api-text.tsx | `ChatApiText` returns empty string on OpenAI error (negative) | unit | mock OpenAI rejects | Call | returns `""` (callers treat as "keep old name") |
| chat-page.unit.chat-api-rag.001 | chat-api-rag-extension.ts | `SearchAzureAISimilarDocuments` happy path forwards SimilaritySearch results (positive) | integration | mock SimilaritySearch OK | POST `req` with body `{query, top}` | Response body contains results |
| chat-page.unit.chat-api-rag.002 | chat-api-rag-extension.ts | `SearchAzureAISimilarDocuments` 500 on similarity ERROR (negative) | unit | SimilaritySearch ERROR | POST | non-200 with error message |

### chat-page — images-api (new section)

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.images-api.001 | images-api.ts | Returns 404 when URL params missing (negative) | unit | request URL `http://h/api/images` (no `t`/`img`) | Call | Response status 404, body contains error message |
| chat-page.unit.images-api.002 | images-api.ts | Returns 404 when GetImageFromStore ERRORs (negative) | unit | GetThreadAndImageFromUrl OK; GetImageFromStore ERROR | Call | 404 |
| chat-page.unit.images-api.003 | images-api.ts | Returns stream + inline content-disposition for image (positive) | unit | GetImageFromStore OK with PNG | Call URL `?t=t&img=a.png` | 200; `content-type:image/png`; `content-disposition` starts with `inline; filename="a.png"` |
| chat-page.unit.images-api.004 | images-api.ts | Returns attachment content-disposition for non-image (positive-other-branch) | unit | OK with content-type `text/csv` | Call URL `?t=t&img=data.csv` | `content-disposition` starts with `attachment;` |
| chat-page.unit.images-api.005 | images-api.ts | Falls back to octet-stream when no contentType + unknown extension (negative-edge) | unit | OK with no contentType, filename `x.unknown` | Call | `content-type:application/octet-stream` |

### chat-page — components gap-fills (negative)

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.components.007 | chat-header/model-selector.tsx | Disables/hides models user lacks access to (negative) | unit | thread persona restricts model set | Render | restricted model option absent or aria-disabled |
| chat-page.unit.components.008 | chat-input/tool-toggles.tsx | Shows ERROR toast when Add/Remove server action returns ERROR (negative) | unit | mock add returns ERROR | Click toggle | global message store contains error message |
| chat-page.unit.components.009 | chat-menu/chat-menu.tsx | Renders empty state when no threads (negative-edge) | unit | threads=[] | Render | Empty state landmark visible |
| chat-page.unit.components.010 | chat-page.tsx | Renders error region when fetch rejects (negative) | unit | spy fetch → reject | Submit | error region populated; no double-submit |

### chat-home-page gap-fill

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-home-page.unit.005 | chat-home.tsx | Renders empty-state when no personas (negative-edge) | unit | personas=[] | Render | placeholder visible; no crash |

### persona-page — persona-service gap-fills

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| persona-page.unit.persona-service.016 | persona-service.ts | `DeletePersona` UNAUTHORIZED when not owner / non-admin (negative) | unit | EnsurePersonaOperation UNAUTHORIZED | Call | UNAUTHORIZED returned; no document delete |
| persona-page.unit.persona-service.017 | persona-service.ts | `UpsertPersona` ERROR when Cosmos throws (negative) | unit | upsert rejects | Call | ERROR envelope |
| persona-page.unit.persona-service.018 | persona-service.ts | `UpsertPersona` validation ERROR on empty fields (negative) | unit | empty name/description | Call | ERROR with Zod messages |
| persona-page.unit.persona-service.019 | persona-service.ts | `FindAllPersonaForCurrentUser` returns ERROR on Cosmos throw (negative) | unit | fetchAll rejects | Call | ERROR |
| persona-page.unit.persona-service.020 | persona-service.ts | `CreatePersonaChat` returns ERROR when UpsertChatThread fails (negative) | unit | UpsertChatThread ERROR | Call | ERROR propagated |

### persona-page — access-group-service gap-fill (positive 200)

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| persona-page.unit.access-group.007 | access-group-service.ts | `AccessGroupById` returns OK group when found (positive) | unit | Graph chain returns `{id:"g",displayName:"X",description:"D"}` | Call `"g"` | OK with the group |
| persona-page.unit.access-group.008 | access-group-service.ts | `AccessGroupById` returns ERROR/UNAUTHORIZED when Graph 404/401 (negative) | unit | Graph throws 404 | Call | ERROR (or NOT_FOUND) with mapped message |

### persona-page — persona-ci-documents-service (new section)

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| persona-page.unit.ci-docs.001 | persona-ci-documents-service.ts | `PersonaCIDocumentById` OK when doc exists | unit | item.read returns resource | Call | OK with the resource |
| persona-page.unit.ci-docs.002 | persona-ci-documents-service.ts | `PersonaCIDocumentById` NOT_FOUND when missing (negative) | unit | read returns `{resource:undefined}` | Call | NOT_FOUND |
| persona-page.unit.ci-docs.003 | persona-ci-documents-service.ts | `PersonaCIDocumentsByIds` returns filtered list (positive) | integration | query returns 2 docs | Call `["a","b"]` | OK with array length 2; query params include `@ids` |
| persona-page.unit.ci-docs.004 | persona-ci-documents-service.ts | `DeletePersonaCIDocumentById` deletes via partition key | unit | spy on item().delete | Call | delete called once |
| persona-page.unit.ci-docs.005 | persona-ci-documents-service.ts | `DeletePersonaCIDocumentById` ERROR on Cosmos throw (negative) | unit | delete rejects | Call | ERROR envelope |
| persona-page.unit.ci-docs.006 | persona-ci-documents-service.ts | `DeletePersonaCIDocumentsByPersonaId` deletes every owned CI doc | integration | query returns 3; spy delete | Call | 3 deletes invoked |
| persona-page.unit.ci-docs.007 | persona-ci-documents-service.ts | `UpdateOrAddPersonaCIDocuments` upserts each in input | unit | input 2 docs | Call | 2 upserts; docs tagged with userId, type=PERSONA_CI_DOCUMENT |
| persona-page.unit.ci-docs.008 | persona-ci-documents-service.ts | `DownloadSharePointFile` OK with binary content (positive) | unit | Graph chain returns ReadableStream | Call | OK with Buffer |
| persona-page.unit.ci-docs.009 | persona-ci-documents-service.ts | `DownloadSharePointFile` ERROR on Graph 401 (negative) | unit | Graph throws 401 | Call | UNAUTHORIZED with SESSION_EXPIRED |
| persona-page.unit.ci-docs.010 | persona-ci-documents-service.ts | `DownloadCIDocumentsFromSharePoint` returns mapped per-doc outcomes (positive) | integration | docs `[ok, fail, ok]` | Call | output preserves order; failures are ERROR entries |

### persona-page — persona-documents-service (new section)

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| persona-page.unit.docs.001 | persona-documents-service.ts | `DocumentDetails` fetches metadata for each SharePoint file (positive) | integration | Graph returns metadata | Call with 2 files | OK; 2 details |
| persona-page.unit.docs.002 | persona-documents-service.ts | `DocumentDetails` returns UNAUTHORIZED when Graph token missing (negative) | unit | session.accessToken="" | Call | UNAUTHORIZED with SESSION_EXPIRED |
| persona-page.unit.docs.003 | persona-documents-service.ts | `UpdateOrAddPersonaDocuments` upserts new docs and indexes them (positive) | integration | mock IndexDocuments OK | Call with 2 docs | upserts called; IndexDocuments invoked |
| persona-page.unit.docs.004 | persona-documents-service.ts | `UpdateOrAddPersonaDocuments` returns ERROR when indexing fails (negative) | unit | IndexDocuments ERROR | Call | ERROR propagated |
| persona-page.unit.docs.005 | persona-documents-service.ts | `PersonaDocumentById` OK when doc exists | unit | item.read OK | Call | OK |
| persona-page.unit.docs.006 | persona-documents-service.ts | `PersonaDocumentById` NOT_FOUND on missing (negative) | unit | read empty | Call | NOT_FOUND |
| persona-page.unit.docs.007 | persona-documents-service.ts | `DeletePersonaDocumentsByPersonaId` deletes docs and removes from search (positive) | integration | spy DeleteSearchDocumentByPersonaDocumentId | Call | each doc deleted from Cosmos AND search |
| persona-page.unit.docs.008 | persona-documents-service.ts | `AuthorizedDocuments` filters to docs current user can read (positive) | unit | mock AllowedPersonaDocumentIds → `["a"]`; input `[{id:"a"},{id:"b"}]` | Call | returns `[{id:"a"}]` |
| persona-page.unit.docs.009 | persona-documents-service.ts | `AllowedPersonaDocumentIds` returns empty when no group membership (negative) | unit | UserAccessGroups returns `[]` | Call | `[]` |

### persona-page — agent-favorite-service gap-fill (negative)

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| persona-page.unit.favorite.006 | agent-favorite-service.ts | `ToggleFavoriteAgent` returns ERROR when upsert rejects (negative) | unit | upsert rejects | Call | ERROR envelope; no cache revalidation |
| persona-page.unit.favorite.007 | agent-favorite-service.ts | `GetUserFavoriteAgents` returns `[]` when getCurrentUser throws (negative) | unit | session null | Call | Returns `[]` (no throw) |

### persona-page — components gap-fills (negative)

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| persona-page.unit.components.005 | add-new-persona.tsx | Submit shows error toast when CreatePersona returns ERROR (negative) | unit | mock action ERROR with message "fail" | Submit valid form | global message store contains "fail" |
| persona-page.unit.components.006 | persona-card/favorite-agent-button.tsx | Reverts UI on ToggleFavoriteAgent ERROR (negative) | unit | mock returns ERROR | Click | aria-pressed snaps back; error message displayed |
| persona-page.unit.components.007 | persona-documents/sharepoint-file-picker.tsx | Renders empty state when SharePoint returns no files (negative-edge) | unit | mock list returns `[]` | Render | placeholder visible |
| persona-page.unit.components.008 | persona-access-group/persona-access-group-selector.tsx | UNAUTHORIZED state shows session-expired prompt (negative) | unit | UserAccessGroups → UNAUTHORIZED w/ SESSION_EXPIRED | Render | sign-in-again prompt visible |

### prompt-page — prompt-service gap-fills

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| prompt-page.unit.prompt-service.009 | prompt-service.ts | `CreatePrompt` happy path returns OK with persisted doc (positive) | unit | create returns resource | Call valid input | OK with resource id, isPublished:false, type:"PROMPT" |
| prompt-page.unit.prompt-service.010 | prompt-service.ts | `CreatePrompt` ERROR when Cosmos throws (negative) | unit | create rejects | Call valid input | ERROR envelope |
| prompt-page.unit.prompt-service.011 | prompt-service.ts | `FindAllPrompts` returns ERROR on Cosmos throw (negative) | unit | fetchAll rejects | Call | ERROR |
| prompt-page.unit.prompt-service.012 | prompt-service.ts | `DeletePrompt` UNAUTHORIZED when not owner non-admin (negative) | unit | EnsurePromptOperation UNAUTHORIZED | Call | UNAUTHORIZED; no delete |
| prompt-page.unit.prompt-service.013 | prompt-service.ts | `UpsertPrompt` validation ERROR on empty name (negative) | unit | empty name | Call | ERROR with Zod messages |
| prompt-page.unit.prompt-service.014 | prompt-service.ts | `FindPromptByID` UNAUTHORIZED when prompt not owned and not published (negative) | unit | prompt.userId="other"; isPublished:false | Call as non-admin | UNAUTHORIZED |

### prompt-page — prompt-store gap-fill

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| prompt-page.unit.store.001 | prompt-store.ts | `FormDataToPromptModel` maps fields (positive) | unit | — | Call with FormData(name,description,content) | Returns matching PromptModel |
| prompt-page.unit.store.002 | prompt-store.ts | `FormDataToPromptModel` defaults isPublished=false when absent (negative-edge) | unit | — | Call without isPublished | `isPublished:false` |
| prompt-page.unit.store.003 | prompt-store.ts | `addOrUpdatePrompt` calls CreatePrompt for new + UpsertPrompt for existing | unit | spy both | Call with `id:""` then `id:"p1"` | First call CreatePrompt; second UpsertPrompt |

### extensions-page — extension-service gap-fills

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| extensions-page.unit.extension-service.020 | extension-service.ts | `FindExtensionByID` returns OK with extension (positive) | unit | query returns `[ext]` | Call | OK with extension |
| extensions-page.unit.extension-service.021 | extension-service.ts | `FindAllExtensionForCurrentUser` returns ERROR on Cosmos throw (negative) | unit | fetchAll rejects | Call | ERROR |
| extensions-page.unit.extension-service.022 | extension-service.ts | `FindAllExtensionForCurrentUserAndIds` empty ids array returns `[]` (negative-edge) | unit | — | Call `[]` | OK with `[]` |
| extensions-page.unit.extension-service.023 | extension-service.ts | `UpdateExtension` happy path persists changes (positive) | unit | EnsureExtensionOperation OK; upsert OK | Call with valid model | OK; upsert called |
| extensions-page.unit.extension-service.024 | extension-service.ts | `UpdateExtension` UNAUTHORIZED when ensure fails (negative) | unit | EnsureExtensionOperation UNAUTHORIZED | Call | UNAUTHORIZED |
| extensions-page.unit.extension-service.025 | extension-service.ts | `DeleteExtension` UNAUTHORIZED when ensure fails (negative) | unit | UNAUTHORIZED | Call | UNAUTHORIZED; no KV/Cosmos calls |
| extensions-page.unit.extension-service.026 | extension-service.ts | `CreateChatWithExtension` happy path: thread created and id returned (positive) | integration | FindExtensionByID OK; CreateChatThread OK | Call `"e1"` | OK with new threadId; extension attached |

### reporting-page — reporting-service gap-fills

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| reporting-page.unit.reporting-service.006 | reporting-service.ts | `FindAllChatMessagesForAdmin` returns ERROR on Cosmos throw (negative) | unit | admin; fetchAll rejects | Call | ERROR |
| reporting-page.unit.reporting-service.007 | reporting-service.ts | `FindAllChatThreadsForAdmin` admin returns empty list when none exist (positive-edge) | unit | admin; resources=[] | Call | OK with `[]` |

### main-menu — components gap-fills (negative)

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| main-menu.unit.components.005 | user-usage.tsx | Renders fallback "—" when GetDailyUsage ERRORs (negative) | unit | mock returns ERROR | Render | fallback indicator visible; no crash |
| main-menu.unit.components.006 | menu-tray.tsx | Closes on backdrop click (positive) | unit | open store | Click backdrop | store state becomes closed |

### globals — message store gap-fills

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| globals.unit.store.004 | global-message-store.tsx | `showInfo` enqueues info message (positive) | unit | — | Call `showInfo("hi")` | message present with type info |
| globals.unit.store.005 | global-message-store.tsx | Calling show* with empty string still enqueues (negative-edge) | unit | — | Call `showError("")` | message present with `message:""`; documents no-validation behavior |

### ui — gap-fills (negative)

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| ui.unit.error.002 | error/display-error.tsx | Renders nothing when errors array empty (negative-edge) | unit | errors=[] | Render | container empty / not rendered |
| ui.unit.markdown.006 | markdown/code-block.tsx | Copy button shows fallback when clipboard unavailable (negative) | unit | stub navigator without clipboard | Click | button is disabled OR shows "Copy unavailable" tooltip |
| ui.unit.markdown.007 | markdown/citation-slider.tsx | Renders empty state when no citations (negative-edge) | unit | citations=[] | Render | nothing rendered or "No citations" placeholder |
| ui.unit.documents.001 | persona-documents/document-item.tsx | Renders title + status (positive) | unit | doc with status `"indexed"` | Render | both visible |
| ui.unit.documents.002 | persona-documents/error-document-item.tsx | Renders error message + retry affordance (negative) | unit | doc with error | Render | error UI visible |

### API routes — /api/chat gap-fill (negative)

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| api.unit.chat.004 | route.ts | Returns 500 when ChatAPIEntry throws synchronously (negative) | unit | mock to throw | POST | 500 |
| api.unit.chat.005 | route.ts | Returns 400 when FormData missing `content` field (negative) | unit | empty FormData | POST | 400 OR 500 — assert observable shape |

### API routes — /api/code-interpreter/file/[fileId] gap-fill (positive)

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| api.unit.ci-file.003 | route.ts | Streams large file (positive-edge) | unit | mock returns 5MB buffer | GET | response body byte length matches buffer |

### API routes — /api/document gap-fill (negative)

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| api.unit.document.002 | route.ts | Returns 500 when SearchAzureAISimilarDocuments throws (negative) | unit | mock rejects | POST | non-200 with error |

### API routes — /api/images gap-fill (negative)

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| api.unit.images.003 | route.ts | Returns 404 when ImageAPIEntry returns 404 (negative) | unit | mock returns Response(404) | GET | 404 forwarded |

### Middleware — proxy.ts gap-fills

Source: `proxy.ts` lines 15-55.

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| middleware.unit.proxy.009 | proxy.ts | `/health` passes through unauthenticated (positive) | unit | getToken → null; path `/health` | Invoke | next() |
| middleware.unit.proxy.010 | proxy.ts | `/api/auth/...` passes through unauthenticated (positive) | unit | getToken → null; path `/api/auth/callback/azure` | Invoke | next() (no redirect) |
| middleware.unit.proxy.011 | proxy.ts | Anonymous hitting `/persona/x` redirects to `/` (negative) | unit | getToken → null; path `/persona/abc` | Invoke | redirect `/` |

### E2E — Playwright journeys gap-fills

| ID | Title | User flow | Route interceptions / fixtures needed | Expected outcome |
|---|---|---|---|---|
| e2e.013 | Anonymous health endpoint without auth (positive smoke) | New context; `request.get('/health')` | None | 200 |
| e2e.014 | /api/chat without auth returns redirect or 401 (negative) | New context (no storageState); POST `/api/chat` | None | Non-200 (redirect to `/` or 401) |
| e2e.015 | Persona create — empty name shows validation (negative) | `/persona` → "Add new" → submit empty | None | Validation visible; no network call |
| e2e.016 | Extension create — duplicate function name shows error (negative) | `/extensions` → add → 2 functions same name → submit | Intercept CreateExtension server action | error region populated |
| e2e.017 | Chat send abort on navigation (negative) | Send a message, then navigate to `/persona` before stream completes | Intercept `/api/chat` with slow SSE | request is aborted (network log shows cancelled); next page renders |

---

## chat-page — prompt-cache write efficiency (2026-09)

Targets: `features/chat-page/chat-services/models/provider-seam.ts`,
`features/chat-page/chat-services/models/prompt-cache-key.ts`,
`features/chat-page/chat-services/chat-api/usage-data.ts`,
`features/chat-page/chat-services/chat-api/persist-assistant.ts`,
`features/chat-page/chat-services/chat-api/message-adapter.ts`,
`features/chat-page/chat-services/chat-api/model-selection.ts`,
`features/chat-page/chat-services/tools/call-sub-agent.ts`,
`features/chat-page/chat-services/code-interpreter-container.ts`,
`app/(authenticated)/api/models/route.ts`.

### Unit cases

| ID | Target file | Case title | Type | Preconditions/mocks | Steps | Expected outcome |
|---|---|---|---|---|---|---|
| chat-page.unit.provider-seam.cache.001 | provider-seam.ts | `promptCacheOptions` is sent for every GPT-5.6 model | unit | `./provider` + `@ai-sdk/azure` stubbed (existing file mocks) | `resolveProvider` for gpt-5.6-sol / -terra / -luna | `providerOptions.openai.promptCacheOptions` equals `{ mode: "implicit", ttl: "30m" }`; `promptCacheKey` / `store` unchanged |
| chat-page.unit.provider-seam.cache.002 | provider-seam.ts | `promptCacheOptions` is omitted for pre-5.6 models (negative) | unit | same | `resolveProvider` for gpt-5.5 / gpt-5.4 / gpt-5.4-mini | `promptCacheOptions` is `undefined` (the model answers HTTP 400 when it is sent) |
| chat-page.unit.usage-data.cost.001 | usage-data.ts | `computeTokenCostUsd` splits input into uncached / cache-read / cache-write | unit | — | 10k input, 6k read, 3k write, 1k output at GPT-5.6-shaped pricing | Cost equals the four buckets summed at their own rates |
| chat-page.unit.usage-data.cost.002 | usage-data.ts | A full cache write costs 12.5x the same turn served from cache | unit | — | Same token counts, once all-write and once all-read | write > read and the ratio is 12.5 (1.25x input vs 0.1x input) |
| chat-page.unit.usage-data.cost.003 | usage-data.ts | Write count is ignored for a model with no write price (negative) | unit | pricing without `cacheWritePerMillion` | Cost with 3k writes vs cost with none | Identical — those tokens stay in the uncached-input bucket |
| chat-page.unit.usage-data.cost.004 | usage-data.ts | Uncached bucket clamps at zero when read + write exceed input | unit | — | 1k input with 800 read + 800 write | Cost is read + write only, never negative input |
| chat-page.unit.usage-data.cost.005 | usage-data.ts | Returns 0 when pricing is absent (negative) | unit | `pricing: undefined` | Call with non-zero tokens | 0 |
| chat-page.unit.usage-data.cost.006 | usage-data.ts | `computeRequestUsage` carries `cacheWriteTokens` into the client block | unit | — | Call with `cacheWriteTokens: 300`, and again omitting it | 300, then the 0 default |
| chat-page.unit.usage-data.steps.001 | usage-data.ts | A 3-step turn bills the ALL-STEPS sum and reports the LAST step's prompt as the context figure | unit | — | Steps of 30k/34k/35k input, cost checked against `computeTokenCostUsd` on the totals | `inputTokens` 99 000, `stepCount` 3, `lastPromptTokens` 35 000, `contextUsagePercent` 3.5 % (the roll-up would have said 9.9 %) |
| chat-page.unit.usage-data.steps.002 | usage-data.ts | A 1-step turn reports one number twice — no behaviour change on a plain turn | unit | — | One step of 17 527 | `inputTokens === lastPromptTokens`, `stepCount` 1 |
| chat-page.unit.usage-data.steps.003 | usage-data.ts | Falls back to the roll-up when no step usage reached the caller (an abort, a sentinel row) | unit | — | Omit `lastPromptTokens` and `stepCount` | `lastPromptTokens` equals `inputTokens`; `stepCount` 1 |
| chat-page.unit.usage-data.steps.004 | usage-data.ts | The cache identity holds on the turn totals: reads + writes + plain = the turn's input | unit | — | 99 000 input with 60 000 read + 20 000 write | plain 19 000 and the three sum to 99 000 |
| chat-page.unit.usage-data.steps.005 | usage-data.ts | An unusable step count or prompt size is ignored rather than shown (negative) | unit | — | `stepCount` 0/-1/NaN, `lastPromptTokens` NaN | `stepCount` 1; `lastPromptTokens` falls back to the roll-up |
| chat-page.unit.persist-assistant.cache-write.001 | persist-assistant.ts | Thread usage cost bills cache writes at the write rate | unit | Cosmos batch rejects → sequential path; thread/usage services mocked | `persistThread` on gpt-5.6-sol with 6k read + 3k write | `UpdateChatThreadUsage` receives the four-bucket cost |
| chat-page.unit.persist-assistant.cache-write.002 | persist-assistant.ts | Write tokens stay uncached-priced for a model with no write price (negative) | unit | same | `persistThread` on gpt-5.4-mini with a write count | Cost matches the three-bucket formula |
| chat-page.unit.persist-assistant.cache-write.003 | persist-assistant.ts | Emits `cacheWriteTokensUsed` with the threadId dimension | unit | `chat-metrics-service` mocked | `persistThread` with 3k writes | `reportCacheWriteTokens(3000, model, { threadId })` |
| chat-page.unit.persist-assistant.cache-write.004 | persist-assistant.ts | Emits 0 rather than skipping when the provider reports no writes | unit | same | `persistThread` with no `cacheWriteTokens` | `reportCacheWriteTokens(0, model, { threadId })` |
| chat-page.unit.persist.steps.001 | persist-assistant.ts | `persistAssistantFromFinishEvent` persists the LAST step's prompt size beside the billed roll-up | unit | thread/message services mocked; Cosmos batch rejected | Finish event with `usage.inputTokens` 99 000 and steps of 30k/34k/35k | `UpdateChatThreadUsage` gets 99 000 as the turn input and 35 000 as `lastPromptTokens` |
| chat-page.unit.persist.steps.002 | persist-assistant.ts | A single-step turn persists one number twice | unit | same | One step of 17 527 | Both arguments are 17 527 |
| chat-page.unit.persist.steps.003 | persist-assistant.ts | Nothing is persisted for the prompt size when the event carries no steps (negative) | unit | same | Finish event with no `steps` | `lastPromptTokens` argument is `undefined`, so readers fall back rather than trust a fabricated 0 |
| api.unit.chat-route.usage.001 | api/chat/route.ts | The `messageMetadata` callback catches each `finish-step`'s own `usage.inputTokens` and emits, on `finish` only, the turn totals plus the LAST step's prompt size and the step count | unit | `ai` streamText mocked; the callback is read off `toUIMessageStream`'s options | Drive the callback with three `finish-step` parts then a `finish` part | Steps return `undefined` (a non-undefined return would make the SDK enqueue a stray `message-metadata` chunk); the finish metadata carries `inputTokens` 99 000, `lastPromptTokens` 35 000, `stepCount` 3 |
| api.unit.chat-route.usage.002 | api/chat/route.ts | A 1-step turn reports the same number for both quantities | unit | same | One `finish-step` then `finish` | `inputTokens === lastPromptTokens`, `stepCount` 1 |
| api.unit.chat-route.usage.003 | api/chat/route.ts | Falls back to the roll-up when no `finish-step` carried a number | unit | same | `finish` alone | `lastPromptTokens` equals the roll-up; `stepCount` 1 |
| api.unit.chat-route.usage.004 | api/chat/route.ts | No metadata for any other part (negative) | unit | same | `start`, `text-delta`, `tool-call`, `start-step` | `undefined` for each |
| api.unit.chat-route.max-output.001 | api/chat/route.ts | The effective model's `maxOutputTokens` reaches streamText | unit | `ai` streamText mocked; model-selection mocked with `maxOutputTokens: 16000` | POST a message, read the streamText options | `options.maxOutputTokens === 16000` |
| api.unit.chat-route.max-output.002 | api/chat/route.ts | No cap is invented when the config has none (negative) | unit | model config without `maxOutputTokens` | POST a message | `options.maxOutputTokens` is `undefined` |
| chat-page.unit.call-sub-agent.max-output.001 | call-sub-agent.ts | The sub-agent generation is capped by the model's `maxOutputTokens` | unit | `generateText` mocked; persona on gpt-5.4-mini | Execute the tool | `generateText` receives `maxOutputTokens: 8000` |
| chat-page.unit.provider-seam.cache.003 | provider-seam.ts | `promptCacheKey` honours the caller override, else the thread id | unit | existing file mocks | `resolveProvider` with and without `promptCacheKey` | Override wins; otherwise `thread.id` |
| chat-page.unit.call-sub-agent.seam.001 | call-sub-agent.ts | Sub-agent turns carry a sub-agent cache key, `store: false` and the model's effort | unit | `generateText` + provider mocks | Execute the tool on a gpt-5.4-mini persona | `providerOptions.openai.promptCacheKey === "thread-1:sub:agent-1"`, `store === false`, no effort keys (model is non-reasoning) |
| chat-page.unit.call-sub-agent.seam.002 | call-sub-agent.ts | A GPT-5.6 sub-agent gets `promptCacheOptions` and an effort | unit | persona on gpt-5.6-sol | Execute the tool | `promptCacheOptions` is `{ implicit, 30m }`; `reasoningEffort === "low"` |
| chat-page.unit.call-sub-agent.seam.003 | call-sub-agent.ts | A Claude persona resolves through the anthropic seam (negative for Azure) | unit | persona on claude-sonnet-5 | Execute the tool | `resolveAnthropicModel` called, `resolveAzureModel` NOT called, options namespaced under `anthropic` |
| chat-page.unit.models.default.001 | models.ts | `resolveDefaultModel` returns the code default when the env var is unset/blank | unit | logger mocked | Call with `undefined`, `""`, `"   "` | `CODE_DEFAULT_MODEL` (gpt-5.6-terra) each time |
| chat-page.unit.models.default.002 | models.ts | A known id (trimmed) is accepted | unit | same | Call with `"gpt-5.6-luna"` and `"  gpt-5.5  "` | The matching model id |
| chat-page.unit.models.default.003 | models.ts | An unknown id is ignored and logged (negative) | unit | same | Call with `"gpt-9000"` | Code default returned; `logError` mentions DEFAULT_MODEL_ID with the offending value |
| chat-page.unit.models.default.004 | models.ts | Inherited Object.prototype keys are not model ids (negative) | unit | same | Call with `"toString"` / `"constructor"` | Code default returned |
| chat-page.unit.models.default.005 | models.ts | `DEFAULT_MODEL` equals the code default with no override present | unit | same | Read the export | gpt-5.6-terra, and it exists in MODEL_CONFIGS |
| chat-page.unit.models.default.006 | models.ts | The default model runs at "medium" effort, its siblings at "low" | unit | same | Read `defaultReasoningEffort` for terra / sol / gpt-5.5 | medium / low / low |
| chat-page.unit.models.default.007 | models.ts | A known id with no deployment is refused when the code default IS deployed, and honoured with a loud log when nothing is deployed | unit | same | Call with a known id, branching on the environment | Code default or the id, plus one `logError` naming the missing deployment |
| chat-page.unit.models.pricing | models.ts | The SHIPPED price table holds its own invariants: every model priced, no cache read above uncached input, every write-billing family (gpt-5.6 and claude) carries `cacheWritePerMillion` at exactly 1.25x input, no other family carries one, and every model has a `maxOutputTokens` between 8000 and its context window | unit | walks MODEL_CONFIGS itself, no fixtures | Iterate every entry | All invariants hold |
| chat-page.unit.max-output.001 | models/max-output-tokens.ts | `MAX_OUTPUT_TOKENS_OVERRIDES` parsing: a good map is read; absent/blank/unparseable/non-object yields none; an unknown model id and an inherited Object.prototype key are skipped; a value that is not a POSITIVE INTEGER (0, negative, fraction, numeric string, null, true) is skipped; good entries survive a bad neighbour | unit | logger mocked | Call with each shape | Empty or partial map plus a warning naming the reason |
| chat-page.unit.max-output.002 | models/max-output-tokens.ts | The env parse is memoised per distinct raw value, and the Symbol sentinel keeps an unset cache distinct from an undefined value | unit | same | Call repeatedly with the same and with changing values | One warning for three identical calls; re-parse on change |
| chat-page.unit.max-output.003 | models/max-output-tokens.ts | Resolution order: env override, then the model's own value; one model's override does not leak to another | unit | same | Resolve with and without an override | Override wins; sibling unaffected |
| chat-page.unit.max-output.004 | models.ts | The shipped ceilings: 32000 for the 5.6 family and 5.5 (reasoning comes out of the same budget), 16000 for Claude and gpt-5.4, 8000 for the small models, and every ceiling inside its context window | unit | walks MODEL_CONFIGS itself | Iterate every entry | Values as listed |
| chat-page.unit.persist-assistant.truncation | chat-api/persist-assistant.ts | A turn the provider cut at the output limit says so: the notice is appended, is idempotent across a re-persist, leaves the original text intact, and fires the `truncatedTurns` counter only when truncated | unit | metrics + Cosmos mocked | Persist with and without the flag | Notice present once; counter fired once, never on an ordinary turn |
| chat-page.unit.background-completion.truncation | chat-api/persist-assistant.ts | End to end from a finish event: `finishReason: "length"` appends the notice to the persisted assistant row, `"stop"` leaves it byte-identical, and an EMPTY truncated finish keeps the sentinel without stacking the notice on top | integration | message/thread/usage services mocked | Call `persistAssistantFromFinishEvent` with each finish reason | Row content as described |
| chat-page.unit.models.history-guard.001 | models.ts | Every 5.6 model declares the 272 000 long-context tier and resolves to an effective history budget of 256 000 | unit | logger mocked; walks the real MODEL_CONFIGS | Resolve for sol / terra / luna | `longContextThresholdTokens` 272 000; budget 256 000 each |
| chat-page.unit.models.history-guard.002 | models.ts | Claude declares no tier and keeps the 256 000 default — its 1M window guards higher | unit | same | Resolve for opus-4-8 / sonnet-5 | Guard 600 000 from `contextWindow`; budget 256 000; not capped |
| chat-page.unit.models.history-guard.003 | models.ts | A small-window model is capped below the default (negative) | unit | same | Resolve for DeepSeek-V4-Pro (163 840 window) | Budget 98 304 (60 %), below the default, `cappedByGuard` |
| chat-page.unit.models.history-guard.004 | models.ts | No model in the shipped table gets a budget outside its own context window, or over a declared tier | unit | same, walks every entry | Resolve for every model | Budget ≤ `contextWindow`, and < `longContextThresholdTokens` where declared |
| chat-page.unit.models.reasoning | models.ts | Every model that supports reasoning declares a `defaultReasoningEffort` (or it silently runs at the hardcoded "low"), and every declared `supportedReasoningEfforts` list is a superset of the levels the picker offers (or an env override is refused for a level a user can select by hand) | unit | walks MODEL_CONFIGS itself | Iterate every entry | Defaults present; each list contains minimal/low/medium/high |
| api.unit.models.006 | api/models/route.ts | `defaultModel` is DEFAULT_MODEL, not the first declared key | unit | MODEL_CONFIGS mocked with gpt-c declared first, DEFAULT_MODEL = gpt-a | Make gpt-c deployable, GET | `availableModelIds` is `["gpt-c","gpt-a"]` but `defaultModel` is `"gpt-a"` |
| api.unit.models.007 | api/models/route.ts | Falls back to the first available when DEFAULT_MODEL is undeployed (negative) | unit | same, gpt-a blanked | GET | `defaultModel === "gpt-c"` |
| chat-page.unit.message-adapter.steps.001 | message-adapter.ts | A 2-step tool turn replays as the same model-message sequence it was sent as | unit | real `convertToModelMessages` | Build the live UIMessages, persist, rehydrate, convert both | Sequences are equal (reasoning items ignored): user / assistant(tool-call) / tool / assistant(text) |
| chat-page.unit.message-adapter.steps.002 | message-adapter.ts | The step layout is persisted on the assistant row | unit | — | `chatMessagesFromUIMessages` on the live turn | `stepLayout` is `["step-start","tool:call-1","step-start","text:32"]`; `content` unchanged |
| chat-page.unit.message-adapter.steps.003 | message-adapter.ts | Re-persisting a rehydrated turn keeps the same layout | unit | — | Persist → rehydrate → persist | Layouts are equal (idempotent) |
| chat-page.unit.message-adapter.steps.004 | message-adapter.ts | Legacy rows with no layout keep the old flat replay (back-compat) | unit | rows without `stepLayout` | Rehydrate + convert | user / assistant([text, tool-call]) / tool — the pre-existing shape |
| chat-page.unit.message-adapter.steps.005 | message-adapter.ts | A layout whose text lengths don't match the row is ignored (negative) | unit | `text:999` against a 5-char content | Rehydrate | Flat ordering kept, no crash |
| chat-page.unit.message-adapter.steps.006 | message-adapter.ts | A layout naming a missing tool call is ignored (negative) | unit | `tool:missing`, no tool row | Rehydrate | Flat ordering kept |
| chat-page.unit.persist-assistant.steps.001 | persist-assistant.ts | `deriveStepToolLayout` yields one entry per step | unit | — | Two steps, one with a tool result | `[{toolCallIds:["call-1"]},{toolCallIds:[]}]` |
| chat-page.unit.persist-assistant.steps.002 | persist-assistant.ts | `buildAssistantUIMessage` emits step-start markers | unit | — | Build with a 2-step layout | Parts are step-start / dynamic-tool / step-start / text |
| chat-page.unit.persist-assistant.steps.003 | persist-assistant.ts | No layout supplied keeps the flat part shape (back-compat) | unit | — | Build without `stepLayout` | Parts are text / dynamic-tool |
| chat-page.unit.persist-assistant.steps.004 | persist-assistant.ts | A tool result no step claimed is still persisted (negative) | unit | layout with an empty step | Build | The tool part is appended rather than dropped |
| chat-page.unit.ci-container.001 | code-interpreter-container.ts | An existing container is returned without an API call | unit | `OpenAIV1Instance` mocked | Call with `existingContainerId` | Same id back; `containers.create` not called |
| chat-page.unit.ci-container.002 | code-interpreter-container.ts | A new container is named after the thread with an explicit idle window | unit | same | Call with no existing id | `create({ name: "chat-t1", expires_after: { last_active_at, 20 } })` |
| chat-page.unit.ci-container.003 | code-interpreter-container.ts | Attached files are deduped and sorted so the call is deterministic | unit | same | Call with `["file-b","file-a","file-b"]` | `file_ids: ["file-a","file-b"]` |
| chat-page.unit.ci-container.004 | code-interpreter-container.ts | A rejected create returns undefined so the caller falls back (negative) | unit | create rejects | Call | Resolves `undefined`, does not throw |
| chat-page.unit.ci-container.005 | code-interpreter-container.ts | A create with no id in the response returns undefined (negative) | unit | create resolves `{}` | Call | `undefined` |
| chat-page.unit.ci-container.006 | code-interpreter-container.ts | A client without the containers API returns undefined (negative) | unit | client stub `{}` | Call | `undefined`, no TypeError |
| api.unit.chat-route.ci-container.001 | api/chat/route.ts | The container is created before the first model call and declared on turn 1 | unit | container module + thread service mocked | POST with codeInterpreterEnabled | `resolveProvider` receives the pre-created id; it is persisted immediately |
| api.unit.chat-route.ci-container.002 | api/chat/route.ts | An existing container is reused, none created | unit | thread already has an id | POST | `ensureCodeInterpreterContainer` not called; seam gets the existing id |
| api.unit.chat-route.ci-container.003 | api/chat/route.ts | Creation failure falls back to the inline bootstrap (negative) | unit | ensure resolves undefined | POST | Seam gets `undefined`; nothing persisted |
| api.unit.chat-route.ci-container.004 | api/chat/route.ts | No container is created when code_interpreter is off (negative) | unit | toggle off | POST | `ensureCodeInterpreterContainer` not called |
| chat-page.unit.reasoning-effort.levels.001 | reasoning-effort.ts | GPT-5.6 levels include xhigh and max | unit | logger mocked | `getSupportedReasoningEfforts` for terra | none/low/medium/high/xhigh/max |
| chat-page.unit.reasoning-effort.levels.002 | reasoning-effort.ts | gpt-5.5 stops at xhigh | unit | same | Same for gpt-5.5 | contains xhigh, not max |
| chat-page.unit.reasoning-effort.levels.003 | reasoning-effort.ts | A model naming no levels falls back to the picker's set | unit | same | gpt-5.4 and `undefined` | minimal/low/medium/high |
| chat-page.unit.reasoning-effort.parse.001 | reasoning-effort.ts | Unset/blank env yields an empty map with no warning | unit | same | Parse `undefined` / `"   "` | `{}`, no warn |
| chat-page.unit.reasoning-effort.parse.002 | reasoning-effort.ts | A supported level is accepted, including 5.6-only ones | unit | same | `{"gpt-5.6-terra":"high"}`, `{"gpt-5.6-sol":"max"}` | Both kept |
| chat-page.unit.reasoning-effort.parse.003 | reasoning-effort.ts | A level the model rejects is dropped and warned (negative) | unit | same | `{"gpt-5.5":"max"}` | `{}` + warning naming model and effort |
| chat-page.unit.reasoning-effort.parse.004 | reasoning-effort.ts | An unknown model id is dropped and warned (negative) | unit | same | `{"gpt-9000":"high"}` | `{}` + warning |
| chat-page.unit.reasoning-effort.parse.005 | reasoning-effort.ts | A non-string value is dropped (negative) | unit | same | `{"gpt-5.6-terra":3}` | `{}` + warning |
| chat-page.unit.reasoning-effort.parse.006 | reasoning-effort.ts | Malformed JSON is ignored (negative) | unit | same | `"{not json"` | `{}` + "not valid JSON" warning |
| chat-page.unit.reasoning-effort.parse.007 | reasoning-effort.ts | A JSON array or null is rejected (negative) | unit | same | `"[]"`, `"null"` | `{}` twice, two warnings |
| chat-page.unit.reasoning-effort.parse.008 | reasoning-effort.ts | Valid entries survive a partly invalid map | unit | same | Three entries, one valid | Only the valid one |
| chat-page.unit.reasoning-effort.resolve.001 | reasoning-effort.ts | User pick beats override and default | unit | same | pick "minimal", override "high" | "minimal" |
| chat-page.unit.reasoning-effort.resolve.002 | reasoning-effort.ts | Override beats the model default | unit | same | override "xhigh" on terra (default medium) | "xhigh" |
| chat-page.unit.reasoning-effort.resolve.003 | reasoning-effort.ts | Model default applies with no pick and no override | unit | same | terra / sol / luna | medium / low / low |
| chat-page.unit.reasoning-effort.resolve.004 | reasoning-effort.ts | An override for another model does not leak (negative) | unit | same | override on terra, resolve sol | "low" |
| chat-page.unit.reasoning-effort.resolve.005 | reasoning-effort.ts | Falls back to "low" for a model with no default | unit | same | claude-sonnet-5 | "low" |
| chat-page.unit.reasoning-effort.cache.001 | reasoning-effort.ts | The env parse is memoised per raw value | unit | same | Same string twice, then a different one | Cached, then re-parsed |
| chat-page.unit.model-selection.effort.001 | model-selection.ts | Effort defaults to the effective model's default | unit | existing file mocks | Resolve with no pick | The model's `defaultReasoningEffort` |
| chat-page.unit.model-selection.effort.002 | model-selection.ts | An explicit pick wins | unit | same | Resolve with `reasoningEffort: "high"` | "high" |
| chat-page.unit.model-selection.effort.003 | model-selection.ts | The env override applies to the model that runs | unit | env var set for the pinned model | Resolve with no pick | The override |
| chat-page.unit.model-selection.effort.004 | model-selection.ts | Effort follows the DOWNGRADED model, not the requested one | unit | limit exceeded → downgrade; override only on the target | Resolve | Target's override, proving resolution happens after downgrade |
| chat-page.unit.prompt-cache-key.strategy.001 | prompt-cache-key.ts | Strategy defaults to "thread"; "persona" is case-insensitive; junk falls back | unit | — | `getPromptCacheKeyStrategy` with undefined / " PERSONA " / "global" | thread / persona / thread |
| chat-page.unit.prompt-cache-key.shards.001 | prompt-cache-key.ts | Shard count defaults to 4 and rejects 0, negatives and junk (negative) | unit | — | `getPromptCacheKeyShards` | 4 / 8 / 4 / 4 / 4 — never a modulo by zero |
| chat-page.unit.prompt-cache-key.signature.001 | prompt-cache-key.ts | Toolset signature ignores insertion order and duplicates | unit | — | `["b","a","b"]` vs `["a","b"]` | Equal, 8 hex chars, stable across calls |
| chat-page.unit.prompt-cache-key.signature.002 | prompt-cache-key.ts | A different toolset yields a different signature | unit | — | Two- vs three-tool sets | Different |
| chat-page.unit.prompt-cache-key.shard.001 | prompt-cache-key.ts | Sharding is deterministic per user and inside range | unit | — | Same hashed id twice; shard counts 1/2/4/8 | Same value; always `0 <= shard < shards` |
| chat-page.unit.prompt-cache-key.shard.002 | prompt-cache-key.ts | A non-hex subject id still spreads across shards (negative) | unit | — | Five `user:*` ids | More than one distinct shard |
| chat-page.unit.prompt-cache-key.resolve.001 | prompt-cache-key.ts | Thread strategy returns the thread id | unit | — | Resolve with strategy "thread" | `"thread-42"` |
| chat-page.unit.prompt-cache-key.resolve.002 | prompt-cache-key.ts | Persona strategy builds `persona:<id>:<sig>:<shard>` | unit | — | Resolve for gpt-5.6-terra with a persona | Exactly that format; "default" when the persona is absent |
| chat-page.unit.prompt-cache-key.resolve.003 | prompt-cache-key.ts | Two threads of the same agent + toolset + user share one key | unit | — | Resolve for thread-1 and thread-2 | Equal keys |
| chat-page.unit.prompt-cache-key.resolve.004 | prompt-cache-key.ts | Different agents and different toolsets get different keys | unit | — | Vary personaId, then toolNames | All different |
| chat-page.unit.prompt-cache-key.resolve.005 | prompt-cache-key.ts | gpt-5.5 and other families keep the thread id (negative) | unit | — | Resolve for 5.5 / 5.4 / claude / Kimi under persona strategy | `"thread-42"` each |
| chat-page.unit.prompt-builder.breakpoint.001 | prompt-builder.ts | The system prompt becomes a SystemModelMessage carrying `{mode:"explicit"}` | unit | — | `withPromptCacheBreakpoint` (Responses-seam wire form) | `providerOptions.openai.promptCacheBreakpoint` is `{mode:"explicit"}` |
| chat-page.unit.prompt-builder.breakpoint.002 | prompt-builder.ts | Conversation messages are copied, not annotated | unit | — | Same call | `messages` deep-equals the input, is a different array, carries no providerOptions |
| chat-page.unit.prompt-builder.breakpoint.003 | prompt-builder.ts | Output is byte-stable across calls | unit | — | Two calls, JSON compared | Identical |
| api.unit.chat-route.cache-key.001 | api/chat/route.ts | The thread id is the cache key by default | unit | route mocks | POST | `resolveProvider` gets `promptCacheKey: "t1"` |
| api.unit.chat-route.cache-key.002 | api/chat/route.ts | Persona strategy gives two threads of one agent the same key | unit | env `PROMPT_CACHE_KEY_STRATEGY=persona`, gpt-5.6-terra | POST on t1 then t2 | Key matches `persona:agent-7:<sig>:<shard>` and is identical for both |
| api.unit.chat-route.cache-key.003 | api/chat/route.ts | A non-5.6 model keeps the thread id under persona strategy (negative) | unit | same env, gpt-4o | POST | `promptCacheKey: "t1"` |
| api.unit.chat-route.breakpoint.001 | api/chat/route.ts | No breakpoint by default — system stays a plain string | unit | flag unset | POST | `typeof options.system === "string"` |
| api.unit.chat-route.breakpoint.002 | api/chat/route.ts | Flag on + 5.6 model marks the developer message | unit | `PROMPT_CACHE_PERSONA_BREAKPOINT=true`, promptCacheOptionsSupported | POST | `system.providerOptions.openai.promptCacheBreakpoint` is `{mode:"explicit"}` |
| api.unit.chat-route.breakpoint.003 | api/chat/route.ts | Flag on + pre-5.6 model marks nothing (negative) | unit | flag on, gpt-4o | POST | System stays a plain string |
| api.unit.chat-route.breakpoint.004 | api/chat/route.ts | The flag is a no-op on Anthropic: the system-prefix breakpoint is pinned with the flag off AND on | unit | flag unset / `=true`, claude-sonnet-5 | POST twice | `system.providerOptions.anthropic.cacheControl` is `{type:"ephemeral"}` both times; no `openai` provider options |
| api.unit.chat-route.compaction.001 | api/chat/route.ts | A trimming turn writes exactly one complete `data-compaction` part into the real SSE stream, with the stable id | unit | route mocks; `ctx.compaction` set; real `createUIMessageStream` | POST, then read the response body | One frame `type:"data-compaction"`, `id:"compaction"`, `data` deep-equals the outcome; no `coversThroughMessageId` on the wire |
| api.unit.chat-route.compaction.002 | api/chat/route.ts | A turn that did not trim writes no part (negative) | unit | same, `ctx.compaction` undefined | POST, read the body | Body contains no `data-compaction` |
| api.unit.chat-route.compaction.003 | api/chat/route.ts | Turns dropped with the summariser off are reported as unsummarised | unit | same, `summarised:false` | POST, read the body | `summarised:false`, no `summaryText`/`summaryModel` |
| common.unit.chat-metrics.009 | chat-metrics-service.ts | A 1-step plain turn reports stepCount 1 / toolCallCount 0 | unit | OTel meter mocked | `reportPromptTokens` with the dimensions | Recorded with both dimensions |
| common.unit.chat-metrics.010 | chat-metrics-service.ts | A 3-step tool turn's counts reach all five metrics | unit | same | All five report* calls | Four histograms plus the counter all carry stepCount 3 / toolCallCount 4 |
| common.unit.chat-metrics.011 | chat-metrics-service.ts | The dimensions default to 0 when omitted | unit | same | `reportCachedTokens` with only a threadId | stepCount 0 / toolCallCount 0 |
| common.unit.chat-metrics.012 | chat-metrics-service.ts | Junk counts coerce to 0 so the dimension type never splits (negative) | unit | same | `"three"` and `-2` | Both 0 |
| common.unit.chat-metrics.013 | chat-metrics-service.ts | Existing dimensions are unchanged | unit | same | `reportPromptTokens` | email / name / userHashedId / chatModel / threadId / role all still present |
| chat-page.unit.persist-assistant.shape.001 | persist-assistant.ts | `deriveTurnShape` counts steps and tool calls | unit | — | 1-step plain, 3-step with 3 calls, result-only step | Correct counts; zeroes for undefined/empty (negative) |
| chat-page.unit.persist-assistant.shape.002 | persist-assistant.ts | The turn shape reaches every metric | unit | metrics mocked | `persistThread` with `turnShape` | prompt / cached / userChatMessage all receive stepCount + toolCallCount |
| chat-page.unit.persist-assistant.shape.003 | persist-assistant.ts | Zeroes are emitted when there is no step information (negative) | unit | same | `persistThread` without `turnShape` | Both dimensions 0 |
| chat-page.unit.stabilize-toolset.compare.001 | stabilize-toolset.ts | Codepoint order differs from localeCompare where it matters | unit | — | Compare "B_tool" / "a_tool" with both comparators | Codepoint puts "B_tool" first, localeCompare does not |
| chat-page.unit.stabilize-toolset.compare.002 | stabilize-toolset.ts | "_" sorts after uppercase and before lowercase | unit | — | Compare "B_tool" / "_x" / "a_tool" | Codepoint order, i.e. B_tool, _x, a_tool |
| chat-page.unit.stabilize-toolset.order.001 | stabilize-toolset.ts | Output is insensitive to insertion order | unit | — | Same three tools, two insertion orders | Identical keys and identical JSON |
| chat-page.unit.stabilize-toolset.order.002 | stabilize-toolset.ts | Ordering is by codepoint, not locale | unit | — | `["a_tool","B_tool","_x"]` | `["B_tool","_x","a_tool"]`, different from a localeCompare sort |
| chat-page.unit.stabilize-toolset.order.003 | stabilize-toolset.ts | Built-ins lead, in the fixed precedence order | unit | — | Mixed built-ins and custom tools | code_interpreter, image_generation, web_search_preview, then customs by codepoint |
| chat-page.unit.stabilize-toolset.order.004 | stabilize-toolset.ts | A built-in with no pinned position follows the precedence list | unit | — | web_search / web_fetch alongside code_interpreter | ci, web_fetch, web_search, then customs |
| chat-page.unit.stabilize-toolset.order.005 | stabilize-toolset.ts | Caller-declared names are treated as built-in | unit | — | `stabilizeToolset(..., ["zz_new_builtin"])` | It leads despite sorting last by codepoint |
| chat-page.unit.stabilize-toolset.order.006 | stabilize-toolset.ts | Every tool and definition survives; empty input is fine (negative) | unit | — | Compare in/out sets; `{}` | Same members, same object identities; `{}` |
| chat-page.unit.stabilize-toolset.stable.001 | stabilize-toolset.ts | The same toolset assembled twice serialises identically | unit | — | Two different assembly orders | Identical JSON |
| chat-page.unit.stabilize-toolset.stable.002 | stabilize-toolset.ts | The code_interpreter definition is identical on turn 1 and turn 2 | unit | real `@ai-sdk/azure` | Same container id twice; then `container: {}` | Identical for the same id; different for the old bootstrap shape |
| chat-page.unit.registry.stable.001 | registry.ts | buildToolset twice for one thread state gives byte-identical definitions | unit | existing registry mocks | Build twice, compare name/description/inputSchema JSON | Identical, same key order |
| chat-page.unit.registry.stable.002 | registry.ts | Merging the built-ins on cannot change the wire order | unit | same | Merge built-ins before and after the custom set | Identical key order, built-ins leading |
| chat-page.unit.persist-assistant.sequence.001 | persist-assistant.ts | Rows written in the same millisecond get strictly increasing sequences | unit | fake timers; Cosmos batch rejected → sequential path | Persist a 3-item step | One shared createdAt; sequences `[1,2,3]` in production order |
| chat-page.unit.persist-assistant.sequence.002 | persist-assistant.ts | Sequence starts at 1, leaving 0 for the user row | unit | same | Persist a turn | Minimum sequence is 1 |

---

---

## Pos/Neg Coverage Matrix

Every exported symbol / component listed in INVENTORY.md is represented below. "+ case IDs" = positive cases; "– case IDs" = negative cases. "no negative needed" reasons annotated where the surface is genuinely irreducible.

### auth-page

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `hashValue` | auth-page.unit.helpers.001, .002 | auth-page.unit.helpers.015 |
| `userSession` | .003, .012 | .004, .005, .013, .014 |
| `getCurrentUser` | .007 | .006 |
| `userHashedId` | .008 | .009 |
| `redirectIfAuthenticated` | .010 | .011 |
| NextAuth `options` admin parser | auth-page.unit.auth-api.001 | auth-page.unit.auth-api.002 |
| `logoutOnSessionExpired` | auth-page.unit.logout.001 | auth-page.unit.logout.002 |
| `LogIn` component | auth-page.unit.login.001 | auth-page.unit.login.002 |
| `handlers` export | — | no negative needed — NextAuth-constructed handler; integration covered by e2e auth flow |

### common (util / schema / nav / sar / cosmos / kv / hooks / storage / news / metrics)

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `uniqueId` | common.unit.util.001, .002 | no negative needed — pure RNG with fixed alphabet; collision check (.002) is the meaningful guard |
| `sortByTimestamp` | common.unit.util.003, .004 | common.unit.util.005 |
| `refineFromEmpty` | common.unit.schema.001, .003 | common.unit.schema.002 |
| `zodErrorsToServerActionErrors` | common.unit.sar.001 | common.unit.sar.002 (empty input edge) |
| `RevalidateCache` | common.unit.nav.001, .002 | no negative needed — pure delegation to `revalidatePath`; no input validation branch |
| `RedirectToPage` | common.unit.nav.003 | no negative needed — pure delegation; invalid path covered by Next.js |
| `RedirectToChatThread` | common.unit.nav.004 | common.unit.nav.005 |
| `CosmosInstance` / `HistoryContainer` / `ConfigContainer` | common.unit.cosmos.001, .002, .003 | no negative needed — singleton wrappers; missing env vars surface as SDK errors during integration, covered by `__tests__/setup.ts` env contract |
| `AzureKeyVaultInstance` | common.unit.kv.001 | no negative needed — thin SDK wrapper |
| `UploadBlob` | common.unit.storage.001 | common.unit.storage.002 |
| `GetBlob` | common.unit.storage.003 | common.unit.storage.004 |
| `GetOrCreateDailyUsage` | common.unit.usage.001 | common.unit.usage.002 |
| `IncrementUsage` | common.unit.usage.003 | common.unit.usage.004 |
| `CheckLimits` | common.unit.usage.005, .006, .007, .013 | common.unit.usage.008, .014 |
| `GetWeeklyUsage` | common.unit.usage.009 | common.unit.usage.011 |
| `GetDailyUsage` | common.unit.usage.010 | common.unit.usage.012 |
| `reportPromptTokens` | common.unit.metrics.001 | common.unit.metrics.002 (failure mode) |
| `reportCompletionTokens` | common.unit.metrics.001 (covers shape) | common.unit.metrics.002 |
| `reportUserChatMessage` | common.unit.metrics.003 | common.unit.metrics.002 |
| `FindAllNewsArticles` | common.unit.news.001 | common.unit.news.002 |
| `useResetableActionState` | common.unit.hooks.001 | no negative needed — wraps `useActionState`; failure modes are React's |
| `useProfilePicture` | common.unit.hooks.003 | common.unit.hooks.002 |
| `SESSION_EXPIRED_ERROR_CODE` constant | — | no negative needed — string constant |

### theme

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `AI_NAME` | theme.unit.config.001 (env set) | theme.unit.config.001 (env unset) |
| `NEW_CHAT_NAME` | theme.unit.config.002 | no negative needed — constant string |
| `theme-provider.tsx` | (covered by e2e shell render) | no negative needed |
| `customise.ts` | — | no negative needed — Tailwind/CSS config object (per Known untestable list) |

### chat-page — prompt-builder

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `buildSystemMessage` | existing prompt-builder.test.ts + chat-page.unit.prompt-builder.001, .002, .006 | — (input contract is total over strings; no input-validation branch) |
| `isoDate` | existing tests | chat-page.unit.prompt-builder.005 |
| `sortFunctionTools` | chat-page.unit.prompt-builder.003, .004 | chat-page.unit.prompt-builder.007 |

### chat-page — chat-thread-service

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `FindAllChatThreadForCurrentUser` | chat-page.unit.thread-service.001 | .002 |
| `FindChatThreadForCurrentUser` | .006 | .003, .004, .005 |
| `CreateChatThread` | .007, .008 | .034 |
| `UpsertChatThread` | .010, .011, .012 | .009, .033 |
| `AddExtensionToChatThread` | .014 | .013 (idempotent path), .045 |
| `RemoveExtensionFromChatThread` | .015 | .046 |
| `UpdateChatThreadSelectedModel` | .016 | .044 |
| `UpdateChatThreadReasoningEffort` | .017 | .043 |
| `UpdateChatThreadCodeInterpreterContainer` | .037 | .038 |
| `UpdateChatThreadAttachedFiles` | .039 | .040 |
| `UpdateChatThreadUsage` | .018, .019 | (covered by upstream Cosmos error paths) |
| `AddAttachedFile` | .020 | .047 |
| `RemoveAttachedFile` | .021 | no negative needed — simple filter; missing id is idempotent (essentially .046 pattern) |
| `SoftDeleteChatContentsForCurrentUser` | .022, .023 | .024, .025 |
| `SoftDeleteChatThreadForCurrentUser` | .026 | (relies on contents soft-delete error path .024/.025) |
| `SoftDeleteChatDocumentsForCurrentUser` | .041 | .042 |
| `UpdateChatTitle` | .027 | .028 |
| `CreateChatAndRedirect` | .029 | .048 |
| `ResetChatThread` | .035 | .036 |
| `EnsureChatThreadOperation` | .030, .031 | .032 |

### chat-page — chat-message-service

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `FindTopChatMessagesForCurrentUser` | chat-page.unit.message-service.001, .002 | .013 |
| `FindAllChatMessagesForCurrentUser` | .003 | .004 |
| `CreateChatMessage` | .005, .006 | .011 |
| `UpsertChatMessage` | .007, .012 | (covered by upstream Cosmos throw → .011 pattern) |
| `UpdateChatMessage` | .009, .010 | .008, .014 |

### chat-page — chat-document-service

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `CrackDocument` | chat-page.unit.document-service.001, .002 | .003, .005, .006 |
| `FindAllChatDocuments` | .004, .007 | .008 |
| `CreateChatDocument` | .009 | .010 |
| `ChunkDocumentWithOverlap` | .011, .012 | .013 |

### chat-page — chat-image-service

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `GetBlobPath` | chat-page.unit.image-service.001 | no negative needed — string concat |
| `UploadImageToStore` | .002 | .006 |
| `GetImageFromStore` | (covered indirectly via images-api .003) | .007 |
| `GetImageUrl` | .003 | no negative needed — string concat |
| `GetThreadAndImageFromUrl` | .004 | .005, .008 |

### chat-page — chat-image-persistence-service

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `persistBase64Image` | chat-page.unit.image-persistence.001, .004 | .002, .003 |
| `resolveImageReference` | .005 | .006 |
| `processMessageForImagePersistence` | .007 | .008, .009 |
| `getBase64ImageReference` | .010, .012 | .011 |
| `processMessageForImageResolution` | .013 | .014 |

### chat-page — chat-image-persistence-utils

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `isBase64Image` | chat-page.unit.image-utils.001 (truthy) | chat-page.unit.image-utils.001 (falsy) |
| `extractImageMetadata` | .002 | .003 |
| `base64ToBuffer` | .004 | no negative needed — `Buffer.from` handles bad input as empty buffer |
| `isImageReference` | .005 (truthy) | .005 (falsy) |
| `parseImageReference` | .006, .008 | .007 |
| `getImageRefFromUrl` | chat-page.unit.image-utils.009 | chat-page.unit.image-utils.010 |

### chat-page — code-interpreter-service & constants

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `UploadFileForCodeInterpreter` | chat-page.unit.ci-service.002 | .001, .003 |
| `DownloadFileFromCodeInterpreter` | .004, .005 | chat-page.unit.ci-service.010 |
| `DeleteFileFromCodeInterpreter` | chat-page.unit.ci-service.006 | chat-page.unit.ci-service.007 |
| `DownloadContainerFile` | chat-page.unit.ci-service.008 | chat-page.unit.ci-service.009 |
| `isCodeInterpreterSupportedFile` | chat-page.unit.ci-const.001 | .002, .003 |

### chat-page — citation-service

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `CreateCitation` | chat-page.unit.citation.001 | .002, .006 |
| `CreateCitations` | .003, .004 | (covered by .006 pattern) |
| `FindCitationByID` | .005 | .007, .008 |
| `FormatCitations` | chat-page.unit.citation.009 | chat-page.unit.citation.010 |

### chat-page — utils

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `mapOpenAIChatMessages` | chat-page.unit.utils.002, .003, .004, .005, .007 | chat-page.unit.utils.001, .006 |

### chat-page — chat-menu-service

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `DeleteChatThreadByID` | chat-page.unit.menu-service.001 | (covered upstream via soft-delete) |
| `DeleteAllChatThreads` | .002 | .003 |
| `UpdateChatThreadTitle` | .004 | .006 |
| `BookmarkChatThread` | .005, .008 | .007 |

### chat-page — azure-ai-search

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `SimpleSearch` | chat-page.unit.search.001 | .010 |
| `SimilaritySearch` | .002, .003 | .011 |
| `PersonaDocumentExistsInIndex` | .012 | .013 |
| `ExtensionSimilaritySearch` | .014 | .015 |
| `IndexDocuments` | .004 | .005, .018 |
| `DeleteDocumentsOfChatThread` | .006 | (covered via SimpleSearch ERROR .010) |
| `DeleteSearchDocumentByPersonaDocumentId` | .007 | .019 |
| `EmbedDocuments` | .016 | .017 |
| `EnsureIndexIsCreated` | .008, .009 | .020 |

### chat-page — function-registry & conversation-manager

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `registerFunction` | chat-page.unit.fn-registry.005 | (collision behavior covered by .005) |
| `executeFunction` | .002, .003 | .001, .004 |
| `getAvailableFunctions` | chat-page.unit.fn-registry.006 | chat-page.unit.fn-registry.007 |
| `getToolByName` | chat-page.unit.fn-registry.009 | chat-page.unit.fn-registry.008 |
| `buildSubAgentTool` | chat-page.unit.fn-registry.010 | chat-page.unit.fn-registry.011 |
| `registerDynamicFunction` | chat-page.unit.fn-registry.012, .013 | (collision = override is positive; no failure surface) |
| `createConversationState` | chat-page.unit.conv-mgr.001 | no negative needed — pure constructor over plain object |
| `startConversation` | .002 | (negative covered by .006 continue path / openai rejection) |
| `processFunctionCall` | .003 | .004, chat-page.unit.conv-mgr.008 |
| `continueConversation` | chat-page.unit.conv-mgr.005 | chat-page.unit.conv-mgr.006 |
| `getConversationInput` | chat-page.unit.conv-mgr.007 | no negative needed — pure getter |

### chat-page — openai-responses-stream

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `OpenAIResponsesStream` | chat-page.unit.stream.001-.004, .008-.016, .019 | .005-.007, .017, .018 |

### chat-page — chat-api family

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `ChatAPIEntry` | chat-page.unit.chat-api.001 | .002, .003, .004 |
| `ChatAPIResponse` | chat-page.unit.chat-api-response.001, .003 | .002 |
| `ChatApiText` | chat-page.unit.chat-api-text.001 | chat-page.unit.chat-api-text.002 |
| `SearchAzureAISimilarDocuments` | chat-page.unit.chat-api-rag.001 | chat-page.unit.chat-api-rag.002 |
| `ImageAPIEntry` | chat-page.unit.images-api.003, .004 | chat-page.unit.images-api.001, .002, .005 |

### chat-page — components

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `model-selector.tsx` | chat-page.unit.components.001 | chat-page.unit.components.007 |
| `context-window-indicator.tsx` | chat-page.unit.components.002 | no negative needed — pure formatter; 0% is a valid output |
| `reasoning-effort-selector.tsx` | chat-page.unit.components.003 | (covered by usage UX) |
| `tool-toggles.tsx` | chat-page.unit.components.004 | chat-page.unit.components.008 |
| `chat-menu.tsx` | chat-page.unit.components.005 | chat-page.unit.components.009 |
| `chat-page.tsx` | chat-page.unit.components.006 | chat-page.unit.components.010 |

### chat-home-page

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `chat-home.tsx` | chat-home-page.unit.001, .002 | chat-home-page.unit.005 |
| `news-article.tsx` | .003 | no negative needed — pure render |
| `changelog.tsx` | (covers populated) | chat-home-page.unit.004 |

### persona-page — persona-service

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `CreatePersona` | persona-page.unit.persona-service.001, .002 | .003, .004 |
| `FindPersonaByID` | (positive via .006/.007 happy paths covered indirectly) | .005, .006 |
| `EnsurePersonaOperation` | .010 | .009 |
| `DeletePersona` | .011 | persona-page.unit.persona-service.016 |
| `UpsertPersona` | .012 | .017, .018 |
| `FindAllPersonaForCurrentUser` | .007 | .008, .019 |
| `CreatePersonaChat` | .014 | .013, .015, .020 |

### persona-page — access-group-service

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `UserAccessGroups` | persona-page.unit.access-group.001, .003 | .002, .004, .005, .006 |
| `AccessGroupById` | persona-page.unit.access-group.007 | persona-page.unit.access-group.008 |

### persona-page — agent-favorite-service

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `GetUserFavoriteAgents` | persona-page.unit.favorite.001 | .002, persona-page.unit.favorite.007 |
| `ToggleFavoriteAgent` | .003, .004, .005 | persona-page.unit.favorite.006 |

### persona-page — persona-ci-documents-service

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `PersonaCIDocumentById` | persona-page.unit.ci-docs.001 | .002 |
| `PersonaCIDocumentsByIds` | .003 | (covered by Cosmos ERROR pattern across services) |
| `DeletePersonaCIDocumentById` | .004 | .005 |
| `DeletePersonaCIDocumentsByPersonaId` | .006 | (covered upstream) |
| `UpdateOrAddPersonaCIDocuments` | .007 | (covered upstream) |
| `DownloadSharePointFile` | .008 | .009 |
| `DownloadCIDocumentsFromSharePoint` | .010 (mixed outcomes — includes failures) | .010 |

### persona-page — persona-documents-service

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `DocumentDetails` | persona-page.unit.docs.001 | .002 |
| `UpdateOrAddPersonaDocuments` | .003 | .004 |
| `PersonaDocumentById` | .005 | .006 |
| `DeletePersonaDocumentsByPersonaId` | .007 | (covered upstream) |
| `AuthorizedDocuments` | .008 | (filter result = exclusion → covered by .008 itself; .009 covers empty membership) |
| `AllowedPersonaDocumentIds` | (positive within .008) | .009 |

### persona-page — components

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `add-new-persona.tsx` | persona-page.unit.components.001 | .002, persona-page.unit.components.005 |
| `favorite-agent-button.tsx` | .003 | persona-page.unit.components.006 |
| `persona-context-menu.tsx` | .004 (admin visible) | .004 (non-admin hidden) |
| `sharepoint-file-picker.tsx` | (populated path implicit in e2e) | persona-page.unit.components.007 |
| `persona-access-group-selector.tsx` | (covered by access-group .003 happy path) | persona-page.unit.components.008 |

### prompt-page — prompt-service & store

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `CreatePrompt` | prompt-page.unit.prompt-service.001, .009 | .002, .010 |
| `FindAllPrompts` | .003 | .011 |
| `EnsurePromptOperation` | .006 | .005 |
| `DeletePrompt` | .007 | .012 |
| `FindPromptByID` | (covered via .006) | .004, .014 |
| `UpsertPrompt` | .008 | .013 |
| `FormDataToPromptModel` | prompt-page.unit.store.001 | prompt-page.unit.store.002 |
| `addOrUpdatePrompt` | prompt-page.unit.store.003 | (covered by service ERROR paths) |

### prompt-page — components

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `add-new-prompt.tsx` | prompt-page.unit.components.001 (covers both paths) | prompt-page.unit.components.001 (ERROR path) |
| `prompt-card.tsx` | prompt-page.unit.components.002 | no negative needed — pure render |

### extensions-page — extension-service

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `FindExtensionByID` | extensions-page.unit.extension-service.020 | .010 |
| `FindAllExtensionForCurrentUser` | .016 | .021 |
| `FindAllExtensionForCurrentUserAndIds` | .017 | .022 |
| `CreateExtension` | .001, .002, .003 | .004, .005, .006, .007, .008, .009 |
| `EnsureExtensionOperation` | (positive implied across .023) | .011 |
| `FindSecureHeaderValue` | .012 | .013 |
| `DeleteExtension` | .014 | .025 |
| `UpdateExtension` | .015, .023 | .024 |
| `CreateChatWithExtension` | .018, .026 | .019 |

### extensions-page — components

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `add-new-extension.tsx` | extensions-page.unit.components.001 | extensions-page.unit.components.001 (ERROR path) |
| `add-function.tsx` | (positive path through CreateExtension tests) | extensions-page.unit.components.002 |
| `extension-context-menu.tsx` | (admin visible — implied) | extensions-page.unit.components.003 |

### reporting-page

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `FindAllChatThreadsForAdmin` | reporting-page.unit.reporting-service.002, .007 | .001, .003 |
| `FindAllChatMessagesForAdmin` | .005 | .004, reporting-page.unit.reporting-service.006 |

### main-menu

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `main-menu.tsx` | main-menu.unit.components.001 (admin) | main-menu.unit.components.001 (non-admin) |
| `theme-toggle.tsx` | .002 | no negative needed — toggle invariant |
| `user-profile.tsx` | .003 | no negative needed — covers fallback in .003 |
| `user-usage.tsx` | .004 | main-menu.unit.components.005 |
| `menu-tray.tsx` | main-menu.unit.components.006 | no negative needed — covered by store store invariants |
| `menu-store.tsx` | — | no negative needed — per "Known untestable" — trivial Valtio boolean |

### globals

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `showError` | globals.unit.store.001, .003 | globals.unit.store.005 |
| `showSuccess` | globals.unit.store.002, .003 | (covers same edge as .005) |
| `showInfo` | globals.unit.store.004 | (covers same edge as .005) |

### ui

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `markdown.tsx` | ui.unit.markdown.001 | no negative needed — pure render |
| `code-block.tsx` | ui.unit.markdown.002, .003 | ui.unit.markdown.006 |
| `citation.tsx` | ui.unit.markdown.004 | no negative needed — pure render |
| `citation-slider.tsx` | ui.unit.markdown.005 | ui.unit.markdown.007 |
| `display-error.tsx` | ui.unit.error.001 | ui.unit.error.002 |
| `document-item.tsx` | ui.unit.documents.001 | (negative covered by error-document-item.001) |
| `error-document-item.tsx` | — | ui.unit.documents.002 |

### API routes

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `/api/chat` POST | api.unit.chat.001, .003 | .002, api.unit.chat.004, .005 |
| `/api/code-interpreter/upload` POST | api.unit.ci-upload.004 | .001, .002, .003, .005, .006 |
| `/api/code-interpreter/file/[fileId]` GET | api.unit.ci-file.001, api.unit.ci-file.003 | api.unit.ci-file.002 |
| `/api/document` POST | api.unit.document.001 | api.unit.document.002 |
| `/api/images` GET | api.unit.images.001, .002 | api.unit.images.003 |
| `/health` GET | api.unit.health.001 | no negative needed — constant 200 |
| `/api/auth/[...nextauth]` | — | no negative needed — NextAuth-managed; e2e auth covers |

### Middleware

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `proxy()` | middleware.unit.proxy.001, .004, .005, .006, middleware.unit.proxy.009, middleware.unit.proxy.010 | .002, .003, .007, .008, middleware.unit.proxy.011 |
| `config` matcher | — | no negative needed — exported matcher object; effects tested via `proxy()` |

### Stores (Valtio)

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `chatStore` / `useChat` / `useToolCallHistory` / `useReasoningMeta` | covered by chat-page.unit.components.006 (submit flow) | no negative needed — Valtio proxy snapshots; UI assertions cover branches |
| `extension-store.ts`, `persona-store.ts` | covered by feature component tests | no negative needed — trivial proxy stores |
| `file-store.ts`, `input-prompt-store.ts`, `input-image-store.ts` | covered by chat-input component tests | no negative needed — trivial proxy stores |

### Models / Schemas

| Symbol | + case IDs | – case IDs |
|---|---|---|
| `MODEL_CONFIGS` | (used positively throughout stream/usage tests) | no negative needed — constant config map |
| `PersonaModelSchema` | covered via persona-service.001 (valid) | covered via persona-service.003 (Zod ERROR) |
| `PromptModelSchema` | prompt-page.unit.prompt-service.001 (valid) | prompt-page.unit.prompt-service.013 (Zod ERROR) |
| `ExtensionModelSchema` | covered via extension-service.001 (valid) | extension-service.005-.009 (Zod ERRORs) |
| `convertDocumentMetadataToSharePointFile`, `convertPersonaDocumentToSharePointDocument`, `convertPersonaCIDocumentToSharePointDocument` | — | no negative needed — pure shape converters; output stability implicitly covered by persona-documents tests that feed them |
| `EXTERNAL_SOURCE`, `*_ATTRIBUTE` constants | — | no negative needed — string constants |

---

## Summary

Counts per feature (cases enumerated, excluding the existing prompt-builder.test.ts):

| Feature | Unit | E2E |
|---|---:|---:|
| auth-page (incl. auth-api / logout / login gap-fills) | 11 + 10 = 21 | 0 |
| common (util/schema/nav/usage/sar/cosmos/kv/hooks/storage/metrics/news) | 27 + 5 + 4 + 4 + 3 + 2 = 45 | 0 |
| theme | 2 | 0 |
| chat-page — prompt-builder (gap-fill) | 6 + 1 = 7 | 0 |
| chat-page — chat-thread-service | 32 + 16 = 48 | 0 |
| chat-page — chat-message-service | 10 + 4 = 14 | 0 |
| chat-page — chat-document-service | 5 + 8 = 13 | 0 |
| chat-page — chat-image-service | 5 + 3 = 8 | 0 |
| chat-page — chat-image-persistence-service (new) | 14 | 0 |
| chat-page — chat-image-persistence-utils | 8 + 2 = 10 | 0 |
| chat-page — code-interpreter-service | 5 + 5 = 10 | 0 |
| chat-page — code-interpreter-constants | 3 | 0 |
| chat-page — citation-service | 5 + 5 = 10 | 0 |
| chat-page — utils (mapOpenAIChatMessages) | 5 + 2 = 7 | 0 |
| chat-page — chat-menu-service | 5 + 3 = 8 | 0 |
| chat-page — azure-ai-search | 9 + 11 = 20 | 0 |
| chat-page — function-registry + conversation-manager | 9 + 8 + 4 = 17 | 0 |
| chat-page — openai-responses-stream | 16 + 3 = 19 | 0 |
| chat-page — chat-api family (chat-api/chat-api-response/chat-api-text/rag/images-api) | 4 + 3 + 2 + 2 + 5 = 16 | 0 |
| chat-page — components | 6 + 4 = 10 | 0 |
| chat-home-page | 4 + 1 = 5 | 0 |
| persona-page — persona-service | 15 + 5 = 20 | 0 |
| persona-page — access-group-service | 6 + 2 = 8 | 0 |
| persona-page — agent-favorite-service | 5 + 2 = 7 | 0 |
| persona-page — persona-ci-documents-service (new) | 10 | 0 |
| persona-page — persona-documents-service (new) | 9 | 0 |
| persona-page — components | 4 + 4 = 8 | 0 |
| prompt-page — prompt-service | 8 + 6 = 14 | 0 |
| prompt-page — prompt-store (new) | 3 | 0 |
| prompt-page — components | 2 | 0 |
| extensions-page — extension-service | 19 + 7 = 26 | 0 |
| extensions-page — components | 3 | 0 |
| reporting-page — reporting-service | 5 + 2 = 7 | 0 |
| main-menu — components | 4 + 2 = 6 | 0 |
| globals — message store | 3 + 2 = 5 | 0 |
| ui — markdown / citations / errors / documents | 6 + 4 = 10 | 0 |
| API routes — /api/chat | 3 + 2 = 5 | 0 |
| API routes — /api/code-interpreter/upload | 6 | 0 |
| API routes — /api/code-interpreter/file/[fileId] | 2 + 1 = 3 | 0 |
| API routes — /api/document | 1 + 1 = 2 | 0 |
| API routes — /api/images | 2 + 1 = 3 | 0 |
| API routes — /health | 1 | 0 |
| Middleware — proxy.ts | 8 + 3 = 11 | 0 |
| E2E journeys | — | 12 + 5 = 17 |
| **Total** | **496 unit** | **17 e2e** |

Existing tests in `prompt-builder.test.ts` (8 cases) and `smoke.spec.ts` (2 e2e) are NOT counted above.

---

## Mocking matrix

| External system | How to mock | Where |
|---|---|---|
| NextAuth session | Already mocked in `setup.ts` (`getServerSession`); override per-test with `vi.mocked(getServerSession).mockReturnValueOnce(...)` | Global |
| `next/navigation` redirect / notFound | Already in setup; throws `NEXT_REDIRECT:<url>` / `NEXT_NOT_FOUND` so callers can assert | Global |
| `next/cache` `revalidatePath` / `revalidateTag` | Setup provides `vi.fn()`s | Global |
| Cosmos DB (`@/features/common/services/cosmos`) | Per-test `vi.mock("@/features/common/services/cosmos", () => ({ HistoryContainer: vi.fn(() => fakeContainer), ConfigContainer: vi.fn(() => fakeContainer) }))`. Capture querySpec via spies. Use `__tests__/helpers/cosmos-mock.ts::createInMemoryContainer` where stateful behavior matters. | per-test |
| `@azure/cosmos` `CosmosClient` | Use `mockCosmosClient` in `cosmos-mock.ts` for tests that hit the singleton (`features/common/services/cosmos.ts`) | per-test |
| Azure Key Vault (`AzureKeyVaultInstance`) | `vi.mock("@/features/common/services/key-vault", () => ({ AzureKeyVaultInstance: () => ({ setSecret: vi.fn(), getSecret: vi.fn(), beginDeleteSecret: vi.fn() }) }))` | per-test |
| Azure AI Search clients | `vi.mock("@/features/common/services/ai-search", () => ({ AzureAISearchInstance: () => fakeSearch, AzureAISearchIndexClientInstance: () => fakeIndex }))`. Use async-iterable for `.search().results` | per-test |
| Azure Storage (`UploadBlob`/`GetBlob`) | `vi.mock("@/features/common/services/azure-storage")` with `vi.fn` returning ServerActionResponse | per-test |
| OpenAI Responses + Files (`OpenAIV1Instance`, `OpenAIV1ReasoningInstance`, `OpenAIEmbeddingInstance`) | `vi.mock("@/features/common/services/openai")` returning shaped objects with `responses.create`, `files.create/content/retrieve`, `embeddings.create` | per-test |
| OpenAI streaming response | Build an async generator that yields `Responses.ResponseStreamEvent` objects, wrapped in a fake `Stream<>` (has `[Symbol.asyncIterator]`). Pass into `OpenAIResponsesStream` | per-test |
| Microsoft Graph (`getGraphClient`) | `vi.mock("@/features/common/services/microsoft-graph-client", () => ({ getGraphClient: () => ({ api: () => ({ filter: () => ({ select: () => ({ get: vi.fn() }) }) }) }) }))` | per-test |
| Document Intelligence | `vi.mock("@/features/common/services/document-intelligence")` | per-test |
| Logger (`logger.ts`) | Usually leave as-is; if asserting, `vi.spyOn` on `logError`/`logInfo` | per-test |
| `crypto.createHash` | Don't mock — verify hashes via independent reference computations in test | — |
| `fetch` (used by stream → blob fallback) | `vi.spyOn(globalThis, "fetch")` | per-test |
| `navigator.clipboard.writeText` | `vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } })` | per-test for clipboard tests |
| Playwright `/api/chat` SSE | `page.route("**/api/chat", route => route.fulfill({ status:200, headers:{"content-type":"text/event-stream"}, body:"event: ...\ndata: {...}\n\n" }))` | e2e |
| Playwright Cosmos-backed pages | Either pre-seed by calling internal server actions via `page.request` to a test-only seeding endpoint, or stub the relevant server action route handlers. For most journeys, intercept the action's POST endpoint (Next.js server actions appear as POSTs to the same path with `Next-Action` header). | e2e |

---

## Known untestable / deferred

| Item | Why deferred |
|---|---|
| `NextAuth` provider wiring (`auth-api.ts`) admin-email parsing | Implementation reads `process.env.ADMIN_EMAIL_ADDRESS` at module load; rather than re-load the module per test, defer to e2e admin-context coverage (e2e.004, e2e.012). Could be added as a tiny unit if the env parser is extracted. |
| `proxy.ts` actual deployment behavior (response cookies, edge runtime specifics) | Unit tests target the function in node; full edge-runtime behavior covered indirectly by e2e. |
| Streaming back-pressure / partial flush guarantees in `openai-responses-stream.ts` | Asserting `await new Promise(setTimeout, 500)` timing yields flaky tests; only behavior, not timing, is covered. |
| `chat-image-persistence-service` real Azure Blob round-trip | Mocked at the `UploadBlob`/`GetBlob` boundary; full e2e with real storage is out of scope and would require an emulator (azurite). |
| `Microsoft Graph` SharePoint document download (`DownloadSharePointFile`) | Heavy dependency on Graph SDK chain; covered via mocks in persona-service `.014`/`.015` rather than its own test surface. |
| `chat-api.ts` (`ChatAPIEntry`) and `chat-api-default-extensions.ts` orchestrator | These pull together many already-tested pieces (function-registry, conversation-manager, openai-responses-stream). Adding a thin orchestrator integration test is recommended later; not enumerated here to avoid duplication. |
| `chat-page.tsx` SSE consumption (full client streaming integration) | Covered at e2e level (e2e.005/006) where deterministic SSE can be injected via Playwright. |
| `theme/customise.ts` | Pure config object; not worth testing individually. |
| `ui/` primitives (`button`, `card`, etc.) | Out of scope per task brief. |
| `main-menu/menu-store.tsx` | Trivial Valtio open/close boolean store — value of test < maintenance cost. |
| `features/common/services/azure-default-credential.ts` | Thin wrapper around `DefaultAzureCredential`; verifying construction would couple test to SDK internals. |
| `features/common/services/document-intelligence.ts` constructor | Same as above. |
| Speech service (`chat-input/speech/speech-service.ts`) | Browser-dependent Web Speech APIs; out of scope for vitest. Could be covered via e2e but flaky. |
| `chat-token-service.ts` exact counts | Token counting via tokenizer is sensitive to model/version; not enumerated to avoid lock-in to tokenizer revision. |
