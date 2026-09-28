# Run Locally

Clone this repository locally or fork to your GitHub account. Run all of the steps below from the `src` directory.

## Prerequisites

- **Node.js**: v18+ (the project uses Next.js 16)
- **History Database**: You must have a Cosmos DB instance configured to store chat history. Set the connection string via the `AZURE_COSMOSDB_URI` environment variable.
- **Azure OpenAI resource**: At least one model deployment (e.g. `gpt-6-sol`, `gpt-5.6-luna`) to test chat functionality.
- **Identity Provider**: For local development, you can use Basic Auth (username/password). If you prefer an Identity Provider, follow the [instructions](./5-add-identity.md) to add one.

## Steps

1. Change directory to the `src` folder
2. Copy `.env.example` to `.env.local` and populate the environment variables:
   ```bash
   cp .env.example .env.local
   ```
3. At minimum, configure:
   - `AZURE_COSMOSDB_URI` — Cosmos DB connection string
   - `AZURE_OPENAI_API_KEY` — Azure OpenAI API key
   - `AZURE_OPENAI_API_INSTANCE_NAME` — Azure OpenAI resource name
   - At least one model deployment name (e.g. `AZURE_OPENAI_API_GPT6_LUNA_DEPLOYMENT_NAME=gpt-6-luna`)
   - `NEXTAUTH_SECRET` — any random string for session encryption
   - `NEXTAUTH_URL=http://localhost:3000`
4. Install npm packages:
   ```bash
   npm install
   ```
5. Start the app:
   ```bash
   npm run dev
   ```
6. Access the app on [http://localhost:3000](http://localhost:3000)

You should now be prompted to login. With Basic Auth (DEV ONLY), any username you enter will create a new user id (hash of username@localhost). You can use this to simulate multiple users.

## Model Availability

Only models whose deployment environment variable is set and non-empty will appear in the model picker. See the [README](../README.md#model-configuration) for the full list of model env vars.

## VS Code Debugging

The project includes preconfigured debug configurations in `.vscode/launch.json`:

- **Next.js: debug server-side** — Debug API routes and server rendering
- **Next.js: debug client-side** — Debug React components in Chrome
- **Next.js: debug full stack** — Debug both simultaneously

Select the configuration from the Run & Debug panel (Ctrl+Shift+D) and press F5.

## Running Tests

```bash
# Unit tests
npm run test

# Watch mode
npm run test:watch

# E2E tests (Playwright)
npm run test:e2e

# Lint
npm run lint
```

[Next](/docs/5-add-identity.md)
