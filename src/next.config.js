/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  distDir: "build",
  typescript: {
    tsconfigPath: "tsconfig.build.json",
  },
  serverExternalPackages: [
    "@azure/storage-blob",
    "@azure/monitor-opentelemetry",
    "@opentelemetry/api",
    "@opentelemetry/instrumentation",
    "@opentelemetry/sdk-trace-base",
  ],
  images: {
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    qualities: [75, 100],
    localPatterns: [{ pathname: "/**" }],
  },
  experimental: {
    // Document upload goes through the CrackDocument server action. Keep in
    // line with MAX_UPLOAD_DOCUMENT_SIZE (50MB in prod).
    serverActions: {
      bodySizeLimit: "50mb",
    },
    // src/proxy.ts runs on every route, so Next buffers each request body for
    // it and cuts it at this size (default 10MB). Without this, uploads over
    // 10MB to /api/code-interpreter/upload and /api/chat arrive truncated.
    proxyClientMaxBodySize: "50mb",
    // Disable the Next.js client-side router cache for dynamic routes.
    // Default is 30s, which makes /chat/[id] show stale "no assistant" state
    // for half a minute after the background generation persisted a message.
    staleTimes: {
      // Default is 30s; set 0 so /chat/[id] navigations always refetch the
      // RSC payload and pick up assistant rows persisted in the background.
      dynamic: 0,
      static: 30,
    },
  },
  async headers() {
    return [
      {
        // Everything except /embed must never be framable. Negative lookahead
        // excludes /embed, whose framing policy is set at RUNTIME in
        // src/proxy.ts (so EMBED_ALLOWED_ANCESTORS can change without a
        // rebuild — next.config headers() are baked at build time).
        source: "/((?!embed).*)",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self';",
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
