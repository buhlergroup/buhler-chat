<p align="center">
  <img src="logo.svg" alt="Bühler Chat Logo" width="100%">
</p>

# Bühler Chat

1. [Introduction](#introduction)
1. [Run from your local machine](/docs/3-run-locally.md)
1. [Add identity provider](/docs/5-add-identity.md)
1. [Chatting with your file](/docs/6-chat-over-file.md)
1. [Persona](/docs/6-persona.md)
1. [Extensions](/docs/8-extensions.md)
1. [Environment variables](/docs/9-environment-variables.md)
1. [Migration considerations](/docs/migration.md)
1. [Reasoning Models & Summaries](/docs/reasoning-summaries.md)
1. [Environment-Based Model Selection](/docs/environment-based-model-selection.md)

# Introduction

_Bühler Chat — a private AI chat platform for the Bühler Group_

Bühler Chat allows the organisation to run a private chat environment with a familiar user experience and the added capabilities of chatting over your data and files.

## Latest Features

### Advanced Reasoning Models

- **Auto-summarization** of model reasoning process
- **Expandable reasoning thoughts** in the chat interface
- **Multiple effort levels** (low, medium, high, xhigh, max) for reasoning tasks

### Smart Model Selection

- **Environment-based model availability** - only configured models appear in the selector
- **Automatic model filtering** based on deployment environment variables
- **Dynamic model configuration** without code changes
- **Rich model picker** with pricing, task area, excels-at use cases, and details links

### Multi-Provider Support

- **Azure OpenAI** (GPT-6, GPT-5.6, GPT-5.5, GPT-5.4) via Responses API
- **Anthropic Claude** (Opus 5.5, Opus 4.8, Sonnet 5) via Azure /anthropic Messages API
- **Foundry-hosted models** (DeepSeek V4 Pro, Kimi K2.6, Grok 4.3) via OpenAI-compatible Chat Completions

### Cost Controls

- **Per-user daily/weekly budget caps** with automatic hard-cap downgrade
- **Intent-based model downgrade** (coding, translation, summarisation, etc.)
- **Prompt cache billing** support for GPT-6, GPT-5.6, and Claude families

### SharePoint Integration

- **Direct SharePoint file access** for persona knowledge bases
- **SharePoint group-based access control** for secure document sharing
- **Real-time file picker** with native SharePoint interface
- **Automatic document processing** from SharePoint libraries
- **Secure token-based authentication** for SharePoint resources

## Benefits

1. **Private**: Deployed in your own tenancy, isolating data from external services.

2. **Controlled**: Network traffic can be fully isolated to your network and other enterprise grade authentication security features are built in.

3. **Value**: Deliver added business value with your own internal data sources (plug and play) or integrate with your internal services.

4. **Advanced AI**: Support for cutting-edge reasoning models with transparent thinking processes.

5. **Flexible**: Environment-based model selection allows easy configuration without code changes.

6. **Enterprise Ready**: Native SharePoint integration for secure document access and collaboration.

# Development & Debugging

## Quick Start for Developers

1. **Clone and Setup**:

   ```bash
   git clone <repo-url>
   cd <repo>/src
   cp .env.example .env.local
   # Configure your environment variables (see .env.example for all options)
   npm install
   ```

2. **Run with Debugging**:

   ```bash
   # Standard development with Turbopack
   npm run dev

   # Debug mode without Turbopack
   npm run dev:debug

   # Debug mode with Turbopack and Node inspector
   npm run dev:turbo-debug
   ```

3. **Access the app** at [http://localhost:3000](http://localhost:3000)

## VS Code Debugging

The project includes preconfigured VS Code debugging setups in `.vscode/launch.json`:

### Debug Configurations

- **Next.js: debug server-side** - Debug backend API routes and server-side rendering
- **Next.js: debug client-side** - Debug React components in Chrome
- **Next.js: debug full stack** - Debug both frontend and backend simultaneously

### Debugging Features

- **Breakpoint support** in TypeScript/JavaScript
- **Variable inspection** and watch expressions
- **Call stack navigation** for API routes and React components
- **Console output** with integrated terminal
- **Hot reload** with debugging active

## Model Configuration

### Enabling Models

Models appear in the picker only when their deployment environment variable is set. Configure the ones you need in `.env.local`:

```bash
# GPT-6 family (Responses API)
AZURE_OPENAI_API_GPT6_SOL_DEPLOYMENT_NAME=gpt-6-sol
AZURE_OPENAI_API_GPT6_LUNA_DEPLOYMENT_NAME=gpt-6-luna

# GPT-5.6 family (Responses API)
AZURE_OPENAI_API_GPT56_SOL_DEPLOYMENT_NAME=gpt-5.6-sol
AZURE_OPENAI_API_GPT56_TERRA_DEPLOYMENT_NAME=gpt-5.6-terra
AZURE_OPENAI_API_GPT56_LUNA_DEPLOYMENT_NAME=gpt-5.6-luna

# GPT-5.5 (Responses API)
AZURE_OPENAI_API_GPT55_DEPLOYMENT_NAME=gpt-5.5

# GPT-5.4 family (Responses API)
AZURE_OPENAI_API_GPT54_DEPLOYMENT_NAME=gpt-5.4
AZURE_OPENAI_API_GPT54_MINI_DEPLOYMENT_NAME=gpt-5.4-mini

# Anthropic Claude (Azure /anthropic Messages API)
AZURE_ANTHROPIC_OPUS55_DEPLOYMENT_NAME=claude-opus-5-5
AZURE_ANTHROPIC_OPUS48_DEPLOYMENT_NAME=claude-opus-4-8
AZURE_ANTHROPIC_SONNET5_DEPLOYMENT_NAME=claude-sonnet-5

# Foundry-hosted low-cost models (OpenAI-compatible Chat Completions)
FOUNDRY_OPENAI_BASE_URL=https://<resource>.services.ai.azure.com/openai/v1
FOUNDRY_API_KEY=
FOUNDRY_DEEPSEEK_DEPLOYMENT_NAME=DeepSeek-V4-Pro
FOUNDRY_KIMI_DEPLOYMENT_NAME=Kimi-K2.6-1
FOUNDRY_GROK_DEPLOYMENT_NAME=grok-4.3
```

Only models with a non-empty deployment name will appear in the model selector.

### Cost Controls

```bash
# Per-user daily/weekly budget (USD). 0 or unset disables that window.
DOWNGRADE_DAILY_COST_USD=3
DOWNGRADE_WEEKLY_COST_USD=7

# Intent-based downgrade targets (applied when no explicit model is picked)
DOWNGRADE_INTENT_CODING_MODEL=
DOWNGRADE_INTENT_DEFAULT_MODEL=
```

### Default Model

Set the default model for new threads via `DEFAULT_MODEL_ID`:

```bash
DEFAULT_MODEL_ID=gpt-6-sol
```

## Troubleshooting

### Common Issues

1. **Models not appearing**: Check that the deployment name env vars are set and non-empty in `.env.local`
2. **Debugging not working**: Ensure VS Code is configured and ports are available
3. **Reasoning not showing**: Verify the model supports reasoning (`supportsReasoning: true` in config) and the deployment is correct
4. **API errors**: Check Azure OpenAI resource region, API version, and key
5. **SharePoint access issues**: Verify SharePoint URL and user permissions are configured correctly
6. **Budget-disabled models**: If a model is greyed out with a budget reason, check `DOWNGRADE_DAILY_COST_USD` / `DOWNGRADE_WEEKLY_COST_USD`

### Debug Logging

Enable detailed logging for troubleshooting:

```javascript
// Check console for detailed model and API information
console.log("Model configuration:", modelConfig);
console.log("Reasoning content:", reasoningContent);
console.log("API response events:", streamEvents);
```

[Next](./docs/1-introduction.md)

# Documentation

## Core Features

- [Run Locally](/docs/3-run-locally.md) - Local development setup
- [Identity Provider](/docs/5-add-identity.md) - Authentication setup
- [Chat over Files](/docs/6-chat-over-file.md) - Document chat functionality
- [Personas](/docs/6-persona.md) - AI assistant customization with SharePoint integration
- [Extensions](/docs/8-extensions.md) - Extensibility framework

## Configuration & Migration

- [Environment Variables](/docs/9-environment-variables.md) - Complete configuration reference

## API References

- [OpenAI SDK Migration](/docs/openai-sdk-migration.md) - SDK upgrade guide
- [OpenAI Responses API Streaming](/docs/openai-responses-api-streaming.md) - Streaming implementation
- [Chat API Sequence Diagram](/docs/chat-api-sequence-diagram.md) - API flow documentation

_This project was initially forked from [microsoft/azurechat](https://github.com/microsoft/azurechat)._
