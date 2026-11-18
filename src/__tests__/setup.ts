import "@testing-library/jest-dom/vitest";
import { vi, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

process.env.NEXTAUTH_SECRET ||= "test-nextauth-secret-do-not-use-in-prod";
process.env.NEXTAUTH_URL ||= "http://localhost:3000";
process.env.AZURE_COSMOSDB_URI ||= "https://cosmos.test.local";
process.env.AZURE_COSMOSDB_KEY ||= "test-key";
process.env.AZURE_COSMOSDB_DB_NAME ||= "chat";
process.env.AZURE_COSMOSDB_CONTAINER_NAME ||= "history";
process.env.AZURE_COSMOSDB_CONFIG_CONTAINER_NAME ||= "config";
process.env.AZURE_SEARCH_API_KEY ||= "test-search-key";
process.env.AZURE_SEARCH_NAME ||= "test-search";
process.env.AZURE_SEARCH_INDEX_NAME ||= "test-index";
process.env.AZURE_OPENAI_API_KEY ||= "test-openai-key";
process.env.AZURE_OPENAI_API_INSTANCE_NAME ||= "test-instance";
process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME ||= "gpt-test";
process.env.AZURE_OPENAI_API_VERSION ||= "2024-10-21";
process.env.AZURE_KEY_VAULT_NAME ||= "test-kv";
process.env.AZURE_STORAGE_ACCOUNT_NAME ||= "teststorage";
process.env.AZURE_STORAGE_ACCOUNT_KEY ||= "test-storage-key";
process.env.ADMIN_EMAIL_ADDRESS ||= "admin@test.local";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

vi.mock("server-only", () => ({}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: <T extends (...args: any[]) => any>(fn: T) => fn,
}));

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    }),
    usePathname: () => "/",
    useSearchParams: () => new URLSearchParams(),
    redirect: vi.fn((url: string) => {
      throw new Error(`NEXT_REDIRECT:${url}`);
    }),
    notFound: vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND");
    }),
  };
});

vi.mock("next-auth", () => ({
  default: vi.fn(),
  getServerSession: vi.fn(async () => ({
    user: {
      name: "Test User",
      email: "test@example.com",
      image: "",
      isAdmin: false,
      accessToken: "test-access-token",
    },
    expires: new Date(Date.now() + 86_400_000).toISOString(),
  })),
}));

vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => ({
    user: {
      name: "Test User",
      email: "test@example.com",
      image: "",
      isAdmin: false,
      accessToken: "test-access-token",
    },
    expires: new Date(Date.now() + 86_400_000).toISOString(),
  })),
}));

vi.mock("@/features/auth-page/auth-api", () => ({
  authOptions: {},
}));

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Node-environment tests (// @vitest-environment node) have no window.
if (typeof window !== "undefined" && typeof globalThis.matchMedia === "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}
