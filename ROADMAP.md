# 🗺️ Open Cowork Roadmap

> This document outlines the development direction for Open Cowork. For feature requests and discussion, see [GitHub Issues](https://github.com/OpenCoworkAI/open-cowork/issues).

## ✅ Completed

- **Core**: Stable Windows & macOS installers with build verification
- **Security**: Full filesystem sandboxing + path traversal / zip-slip hardening
- **VM Sandbox**: WSL2 (Windows) and Lima (macOS) VM-level isolation
- **Skills**: PPTX, DOCX, PDF, XLSX support + custom skill management + hot-reload
- **MCP Connectors**: Custom connector support (stdio / SSE / Streamable HTTP)
- **Rich Input**: File upload and image input in chat
- **Multi-Model**: Claude, GPT, Gemini, DeepSeek, Qwen, GLM, Kimi, Grok, MiniMax, Ollama
- **UI/UX**: Enhanced interface with English/Chinese localization
- **Remote Control**: Feishu (Lark) bot integration with pairing mode + approval panel
- **CI/CD**: Automated builds, smoke tests, Codex-powered PR review bot
- **Model Presets**: Up-to-date model catalogs for all major providers
- **Dependency Policy**: Tiered management strategy with Dependabot grouping
- **Memory System Foundation**: Unified storage with core/experience memory and source-aware retrieval workflow (PR #138)
- **Memory System Enhancements**: LLM summaries + causal error-pattern memory
- **Scheduled Tasks**: Cron-like scheduling with UI management and persistent execution
- **Log Management**: Structured logging with rotation, size limits, and log viewer
- **Sandbox Hardening**: Shared JSON-RPC transport for VM bridges + wsl/lima parity locked by tests
- **Config Export/Import**: Plaintext config file sync with bidirectional watcher (#277)

## 🚧 In Progress

- **v3.5.x Stabilisation**: security hardening, god-file cleanup, test consolidation, CI OS matrix

## 📋 Planned

### Near-term (v3.6.0)

- **App Slimming**: Reduce installer from ~156 MB to ~80 MB — on-demand Python/Node.js download, lazy-load Feishu SDK, strip unused files ([details](docs/SLIM-PLAN.md))
- **Code Cleanup**: Finish splitting god files (gui-operate-server.ts 6889 lines, index.ts 3474 lines), lazy imports, dead code removal
- **Naming Standardization**: Clean up 75+ legacy references (claude-sdk, claude-sandbox, claude-plugin, pi-coding-agent) to consistent Open Cowork naming conventions
- **Tool Completeness**: Implement native TodoWrite, AskUserQuestion, Glob, Grep, WebFetch, WebSearch tool schemas + handlers for API key users
- **Sandbox Hardening**: Continue VM sandbox reliability, startup performance, and cross-platform consistency (Lima on macOS, WSL2 on Windows)
- **Installation Experience**: Smoother first-run — auto-detect system dependencies, clearer error messages, one-click setup
- **Linux Support**: First-class Linux builds (currently build-from-source only)

### Mid-term (v3.6.0+)

### Long-term

- **Computer Use (CUA)**: GUI automation via screen capture and mouse/keyboard control
- **Collaborative Mode**: Multiple users sharing a workspace
- **Mobile Companion**: Lightweight mobile app for monitoring and quick interactions

---

_Last updated: 2026-09-13_
_Want to contribute? Check our [Contributing Guide](CONTRIBUTING.md) and pick an issue labeled `good first issue`._
