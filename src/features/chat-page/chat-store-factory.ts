/**
 * chat-store-factory.ts
 *
 * Zustand vanilla store factory for per-tab / per-thread chat state.
 * Owns everything that is NOT streaming I/O (messages/status/sendMessage/stop
 * come from @ai-sdk/react useChat).
 *
 * Usage:
 *   const store = createChatStore({ threadId, userName, chatThread });
 *   store.getState().setSelectedModel("gpt-5.5");
 *
 * Task 11 will wire consumers; task 12 will delete the Valtio singleton.
 */
import { createStore } from "zustand/vanilla";
import {
  ChatModel,
  ReasoningEffort,
  AttachedFileModel,
  ChatThreadModel,
  UsageDataResponse,
  DEFAULT_MODEL,
  MODEL_CONFIGS,
} from "./chat-services/models";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageWarning {
  message: string;
  originalModel: string;
  fallbackModel: string;
}

export interface ChatStoreState {
  // --- identity ---
  threadId: string;
  userName: string;

  // --- model / tool toggles ---
  selectedModel: ChatModel;
  reasoningEffort: ReasoningEffort;
  webSearchEnabled: boolean;
  imageGenerationEnabled: boolean;
  companyContentEnabled: boolean;
  codeInterpreterEnabled: boolean;

  // --- files ---
  attachedFiles: AttachedFileModel[];

  // --- input draft (per-thread; speech & prompt-pick write here too) ---
  inputText: string;

  // --- usage ---
  lastUsageData: UsageDataResponse | null;
  usageWarning: UsageWarning | null;

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  setSelectedModel: (model: ChatModel) => void;
  setReasoningEffort: (effort: ReasoningEffort) => void;
  toggleWebSearch: (enabled: boolean) => void;
  toggleImageGeneration: (enabled: boolean) => void;
  toggleCompanyContent: (enabled: boolean) => void;
  toggleCodeInterpreter: (enabled: boolean) => void;

  setAttachedFiles: (files: AttachedFileModel[]) => void;
  addAttachedFile: (file: AttachedFileModel) => void;
  removeAttachedFile: (fileId: string) => void;
  clearAttachedFiles: () => void;
  getCodeInterpreterFileIds: () => string[];

  setInputText: (text: string) => void;

  setUsageData: (data: UsageDataResponse | null) => void;
  setUsageWarning: (warning: UsageWarning | null) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateChatStoreOptions {
  threadId: string;
  userName?: string;
  chatThread?: ChatThreadModel;
}

export function createChatStore(options: CreateChatStoreOptions) {
  const { threadId, userName = "", chatThread } = options;

  // Resolve initial model from thread
  const threadModel = chatThread?.selectedModel;
  const initialModel: ChatModel =
    threadModel && MODEL_CONFIGS[threadModel] ? threadModel : DEFAULT_MODEL;

  const modelCfg = MODEL_CONFIGS[initialModel];

  // Resolve initial tool toggles
  const dt = chatThread?.defaultTools;
  const hasCodeInterpreterFiles =
    (chatThread?.attachedFiles ?? []).some((f) => f.type === "code-interpreter");

  // Resolve initial usage data. Seed the "last turn" input/output from the
  // persisted per-turn counts (lastInputTokens/…) so a reloaded thread shows
  // the same values the header showed live, not 0. Older rows without these
  // fields fall back to 0 (only the thread totals are shown for them).
  //
  // `lastInputTokens` is the TURN TOTAL (all steps, what was billed);
  // `lastPromptTokens` is the size of the LAST PROMPT. The context row needs
  // the second one. Rows written before `lastPromptTokens` existed fall back
  // to the roll-up: exact for a single-step turn, and an OVERSTATEMENT of a
  // multi-step one by roughly the number of steps.
  let initialUsageData: UsageDataResponse | null = null;
  if (chatThread?.usage) {
    const u = chatThread.usage;
    const contextWindowSize = modelCfg?.contextWindow ?? 128000;
    const lastInput = u.lastInputTokens ?? 0;
    const lastOutput = u.lastOutputTokens ?? 0;
    const lastPrompt = u.lastPromptTokens ?? lastInput;
    initialUsageData = {
      inputTokens: lastInput,
      outputTokens: lastOutput,
      cachedTokens: u.lastCachedTokens ?? 0,
      // Real numbers from the last completed request, so a reloaded thread
      // shows the same context size and cache split it showed live — the
      // header never estimates.
      ...(typeof u.lastCacheWriteTokens === "number"
        ? { cacheWriteTokens: u.lastCacheWriteTokens }
        : {}),
      totalTokens: lastInput + lastOutput,
      costUsd: 0,
      threadTotalCostUsd: u.totalCostUsd,
      threadTotalTokens: u.totalInputTokens + u.totalOutputTokens,
      lastPromptTokens: lastPrompt,
      // `stepCount` is NOT persisted, so a reloaded thread cannot say how many
      // steps the last turn took and the panel leaves the badge off rather
      // than claiming "1 step" it does not know.
      contextWindowSize,
      contextUsagePercent:
        contextWindowSize > 0 ? (lastPrompt / contextWindowSize) * 100 : 0,
      model: initialModel,
    };
  }

  return createStore<ChatStoreState>((set, get) => ({
    // --- identity ---
    threadId,
    userName,

    // --- model ---
    selectedModel: initialModel,
    reasoningEffort:
      chatThread?.reasoningEffort ?? modelCfg?.defaultReasoningEffort ?? "low",

    // --- tool toggles ---
    webSearchEnabled: dt?.webSearch ?? false,
    imageGenerationEnabled: dt?.imageGeneration ?? !!modelCfg?.supportsImageGeneration,
    companyContentEnabled: dt?.companyContent ?? false,
    codeInterpreterEnabled: dt?.codeInterpreter ?? hasCodeInterpreterFiles,

    // --- files ---
    attachedFiles: chatThread?.attachedFiles ?? [],

    // --- input draft ---
    inputText: "",

    // --- usage ---
    lastUsageData: initialUsageData,
    usageWarning: null,

    // -----------------------------------------------------------------------
    // Actions
    // -----------------------------------------------------------------------

    setSelectedModel: (model) => {
      const cfg = MODEL_CONFIGS[model];
      set({
        selectedModel: model,
        reasoningEffort: cfg?.defaultReasoningEffort ?? "low",
        imageGenerationEnabled: !!cfg?.supportsImageGeneration,
      });
    },

    setReasoningEffort: (effort) => set({ reasoningEffort: effort }),

    toggleWebSearch: (enabled) => {
      set((s) => ({
        webSearchEnabled: enabled,
        reasoningEffort:
          enabled && s.reasoningEffort === "minimal" ? "low" : s.reasoningEffort,
      }));
    },

    toggleImageGeneration: (enabled) => {
      set((s) => ({
        imageGenerationEnabled: enabled,
        reasoningEffort:
          enabled && s.reasoningEffort === "minimal" ? "low" : s.reasoningEffort,
      }));
    },

    toggleCompanyContent: (enabled) => {
      set((s) => ({
        companyContentEnabled: enabled,
        reasoningEffort:
          enabled && s.reasoningEffort === "minimal" ? "low" : s.reasoningEffort,
      }));
    },

    toggleCodeInterpreter: (enabled) => {
      set((s) => ({
        codeInterpreterEnabled: enabled,
        reasoningEffort:
          enabled && s.reasoningEffort === "minimal" ? "low" : s.reasoningEffort,
      }));
    },

    setAttachedFiles: (files) => set({ attachedFiles: files }),
    addAttachedFile: (file) =>
      set((s) => ({ attachedFiles: [...s.attachedFiles, file] })),
    removeAttachedFile: (fileId) =>
      set((s) => ({ attachedFiles: s.attachedFiles.filter((f) => f.id !== fileId) })),
    clearAttachedFiles: () => set({ attachedFiles: [] }),
    getCodeInterpreterFileIds: () =>
      get()
        .attachedFiles.filter((f) => f.type === "code-interpreter")
        .map((f) => f.id),

    setInputText: (text) => set({ inputText: text }),

    setUsageData: (data) => set({ lastUsageData: data }),
    setUsageWarning: (warning) => set({ usageWarning: warning }),
  }));
}

/** Opaque store type — use this everywhere instead of the inferred return type. */
export type ChatStore = ReturnType<typeof createChatStore>;
