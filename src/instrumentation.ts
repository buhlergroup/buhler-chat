import { RequestOptions } from "https";
import { logInfo, logDebug } from "./features/common/services/logger";

declare global {
  // eslint-disable-next-line no-var
  var __azureMonitorRegistered: boolean | undefined;
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Boot-time service binding: when running against an in-memory backend
  // (e2e tests) register the fake factories before any route handler can
  // import a service module. Production source files have no awareness of
  // this mode; the only switch is here.
  if (process.env.AZURECHAT_TEST_BACKEND === "memory") {
    // Gate via the single shared helper; the variant throws when
    // misconfigured in production so Next.js logs a clear failure.
    const { assertE2eFakesAllowedOrRefuse } = await import(
      "./features/common/services/e2e-fakes-gate"
    );
    assertE2eFakesAllowedOrRefuse();
    await import("./__tests__/e2e-fakes/register");
  }

  // Telemetry is opt-in. AZURECHAT_TELEMETRY=1 must be set explicitly
  // (deployment env) AND a real connection string must be present. Local
  // `next dev` stays quiet even when .env.local carries a prod conn
  // string — avoids burning 1+ GB of RSS to send spans nobody reads.
  const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING ?? "";
  const enabled =
    process.env.AZURECHAT_TELEMETRY === "1" &&
    conn.includes("InstrumentationKey=") &&
    !conn.includes("test-key");

  if (!enabled) {
    logInfo("Azure Monitor disabled (set AZURECHAT_TELEMETRY=1 with a real APPLICATIONINSIGHTS_CONNECTION_STRING to enable)");
    return;
  }

  // Idempotency. Next.js invokes register() multiple times per server
  // start (vercel/next.js#51450) and Turbopack HMR re-runs it on file
  // changes. useAzureMonitor() is NOT idempotent: each call installs a
  // fresh tracer + meter provider, span batch processor, HTTP hook, and
  // exporter, and never tears the previous ones down. Six stacked
  // exporters with their own batch queues cost ~1 GB RSS. Guard on
  // globalThis (survives HMR module re-evaluation).
  if (globalThis.__azureMonitorRegistered) {
    logDebug("Azure Monitor already registered; skipping re-init");
    return;
  }
  globalThis.__azureMonitorRegistered = true;

  // Reduce SDK noise.
  process.env.OTEL_LOG_LEVEL = 'error';
  // Avoid async host.id resource detection. It triggers repeated
  // "Accessing resource attributes before async attributes settled" logs.
  process.env.OTEL_NODE_RESOURCE_DETECTORS ??= "env,os";
  // Disable Statsbeat (internal SDK telemetry pinged back to Microsoft).
  process.env.APPLICATIONINSIGHTS_STATSBEAT_DISABLED ??= "true";

  // Use dynamic import, not require(). @opentelemetry/api ships ESM (.mjs),
  // so Turbopack compiles span-enriching-processor as an async module.
  // require() returns it before its exports exist and the constructor is
  // undefined ("i is not a constructor"). await import() waits for it.
  const { useAzureMonitor: azureMonitor } = await import("@azure/monitor-opentelemetry");
  const { metrics } = await import("@opentelemetry/api");
  const { SpanEnrichingProcessor } = await import("./span-enriching-processor");

  const cosmosdb = new URL(process.env.AZURE_COSMOSDB_URI || "https://placeholder.documents.azure.com:443/");
  const cosmosdbHost = cosmosdb.hostname;

  const httpInstrumentationConfig = {
    enabled: true,
    ignoreIncomingRequestHook: (request: any) => request.method === 'OPTIONS',
    ignoreOutgoingRequestHook: (options: RequestOptions) => {
      if (options.hostname === cosmosdbHost) return true;
      return true; // ignore all outgoing for now
    },
  };

  azureMonitor({
    spanProcessors: [new SpanEnrichingProcessor()],
    azureMonitorExporterOptions: {
      connectionString: conn,
      // On-disk + in-memory retry buffer. Useless on Container Apps
      // (ephemeral storage) and wasteful in dev. Off.
      disableOfflineStorage: true,
    },
    // 10% trace sampling. Cuts span buffer pressure 10× under load;
    // doc-recommended starting point for chat-volume workloads.
    samplingRatio: 0.1,
    // Standard metrics keep a continuous in-process aggregator. Container
    // Apps platform metrics cover the same ground.
    enableStandardMetrics: false,
    enableLiveMetrics: false,
    instrumentationOptions: {
      azureSdk: { enabled: false },
      http: httpInstrumentationConfig,
    },
  });

  logDebug("Meter provider initialized", { hasMeterProvider: !!metrics.getMeterProvider() });
  logInfo("Application Insights initialized");
}
