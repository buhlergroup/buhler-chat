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
- **Multiple effort levels** (low, medium, high) for reasoning tasks

### Smart Model Selection
- **Environment-based model availability** - only configured models appear in the selector
- **Automatic model filtering** based on deployment environment variables
- **Dynamic model configuration** without code changes

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
   git clone https://github.com/buhlergroup/azurechat
   cd azurechat/src
   cp .env.example .env.local
   # Configure your environment variables
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

## Model Development & Testing

### Environment-Based Model Selection
Configure which models appear in your chat interface by setting environment variables:

```bash
# Enable specific models in .env.local
AZURE_OPENAI_API_O3_DEPLOYMENT_NAME=o3-deployment
AZURE_OPENAI_API_O3_PRO_DEPLOYMENT_NAME=o3-pro-deployment
AZURE_OPENAI_API_GPT41_DEPLOYMENT_NAME=gpt41-deployment
AZURE_OPENAI_API_GPT41_MINI_DEPLOYMENT_NAME=gpt41-mini-deployment
```

Only models with configured deployment names will appear in the model selector.

### Reasoning Models
Test advanced reasoning capabilities with o3 and o4-mini models:

```bash
# Configure reasoning model deployment
AZURE_OPENAI_API_O3_DEPLOYMENT_NAME=your-o3-deployment
AZURE_OPENAI_API_O3_PRO_DEPLOYMENT_NAME=your-o3-pro-deployment
```

Features include:
- **Reasoning summaries** with expandable thought processes
- **Effort level control** (low/medium/high)
- **Debug logging** for reasoning content extraction

### SharePoint Integration
Configure SharePoint document access for personas:

```bash
# Enable SharePoint integration in .env.local
NEXT_PUBLIC_SHAREPOINT_URL=https://yourtenant.sharepoint.com
```

Features include:
- **Direct file access** from SharePoint libraries
- **Group-based access control** for secure sharing
- **Native file picker** interface
- **Automatic document processing** for persona knowledge bases

## Troubleshooting

### Common Issues

1. **Models not appearing**: Check environment variables are set correctly
2. **Debugging not working**: Ensure VS Code is configured and ports are available
3. **Reasoning not showing**: Verify model supports reasoning and deployment is correct
4. **API errors**: Check OpenAI resource region and API version compatibility
5. **SharePoint access issues**: Verify SharePoint URL and user permissions are configured correctly

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

## Advanced Features
- [Reasoning Models & Summaries](/docs/reasoning-summaries.md) - o3, o4-mini with thought processes
- [Environment-Based Model Selection](/docs/environment-based-model-selection.md) - Dynamic model configuration

## Configuration & Migration
- [Environment Variables](/docs/9-environment-variables.md) - Complete configuration reference
- [Migration Guide](/docs/migration.md) - Upgrade instructions and breaking changes

## API References
- [OpenAI SDK Migration](/docs/openai-sdk-migration.md) - SDK upgrade guide
- [OpenAI Responses API Streaming](/docs/openai-responses-api-streaming.md) - Streaming implementation
- [Chat API Sequence Diagram](/docs/chat-api-sequence-diagram.md) - API flow documentation

_This project was initially forked from [microsoft/azurechat](https://github.com/microsoft/azurechat)._
