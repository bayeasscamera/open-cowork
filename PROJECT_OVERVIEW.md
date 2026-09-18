# Vue d'ensemble — Open Cowork

## Identité
- **Stack technique** :
  - **Langages** : TypeScript strict (`strict: true`), JavaScript, CSS (TailwindCSS)
  - **Frameworks & UI** : Electron (`^41.7.1`), React (`^18.3.1`), Vite (`^7.3.1`), TailwindCSS (`^3.4.16`), Lucide Icons, KaTeX / Remark / Rehype
  - **Base de données & État** : `better-sqlite3` (`^12.8.0`), `zustand` (`^5.0.12`), `electron-store` (`^11.0.2`), `i18next` (`^25.10.1`)
  - **Moteurs IA & Protocoles** : `@anthropic-ai/sdk`, `@google/genai`, `openai`, `@mariozechner/pi-coding-agent`, `@modelcontextprotocol/client` & `server`, `@slack/bolt`, `@larksuiteoapi/node-sdk`
  - **Exigences d'environnement** : Node.js `>= 22`
- **Base du projet** :
  - **Base d'origine** : Fork et évolution avancée du projet open-source `Open Cowork` (`@OpenCoworkAI/open-cowork`).
  - **Différences principales** : Refonte vers une architecture d'agent autonome de type OpenClaw / Hermes Agent intégrant un graphe de dépendances (CodeGraph persistent), un contrôleur système avec capture d'écran et automation GUI, un pool d'exécution multi-agent en DAG, des outils de recherche web natifs (DuckDuckGo, Brave, Tavily), un système de mémoire dialectique/causale SQLite avec auto-apprentissage des erreurs, et des outils chirurgicaux de self-healing et patch AST.
- **Objectif de l'app** :
  - Open Cowork est une application desktop IA pour macOS et Windows conçue pour exécuter des flux de codage, de planification et d'automatisation de manière autonome.
  - Elle fournit un environnement isolé sécurisé (WSL2, Lima, SSH/Daytona ou Natif) combinant l'écosystème Model Context Protocol (MCP), les Skills modulaires et un moteur multi-modèles (Anthropic, OpenAI, Gemini, OpenRouter, Ollama).

---

## Architecture
- **Arborescence des dossiers** :
  - `src/main/` : Processus principal Electron — cycle de vie, gestionnaires IPC, sécurité système et configuration.
  - `src/main/agent/` : Moteur d'exécution de l'agent IA — orchestration des tours, parsing des outils, self-healing, DAG swarm et boucles TDD.
  - `src/main/cli/` : Intégrations des interfaces en ligne de commande et ponts de session terminal.
  - `src/main/config/` : Magasin de configuration persistant (`configStore`), profils de modèles et clés de configuration.
  - `src/main/db/` : Couche de données locale SQLite, schémas de base, migrations et gestion des sessions/messages.
  - `src/main/events/` : Bus d'événements interne pour la synchronisation asynchrone des flux agents et de l'état système.
  - `src/main/extensions/` : Modules d'extension et intercepteurs de commandes additionnels.
  - `src/main/ipc/` : Canaux de communication typés IPC entre le main process et le renderer.
  - `src/main/mcp/` : Gestionnaire de serveurs MCP — cycle de vie stdio/SSE, catalogues d'outils, serveur GUI operate et authentification OAuth.
  - `src/main/memory/` : Moteur de mémoire long-terme, RAG sémantique, compression contextuelle LLM et indexation `codegraph-indexer`.
  - `src/main/remote/` : Gestionnaires d'exécution déportée (tunnels ngrok, passerelles de contrôle à distance).
  - `src/main/sandbox/` : Couche d'isolation — ponts d'exécution pour WSL2 (Windows), Lima (macOS), SSH, Daytona et Natif.
  - `src/main/schedule/` : Planificateur de tâches automatisées en arrière-plan et déclencheurs de routines.
  - `src/main/session/` : Gestion du cycle de vie des sessions, files de messages et persistance de l'état actif.
  - `src/main/skills/` : Découverte, parsing des fichiers `SKILL.md`, rechargement à chaud (Chokidar) et runtime de plugins.
  - `src/main/system/` : Contrôle système OS de bas niveau (capture d'écran, simulation clics/frappes via AppleScript/PowerShell).
  - `src/main/tools/` : Définition des outils natifs exposés à l'agent (`dynamic-tool-creator`, web search/fetch, daemon registry).
  - `src/main/utils/` : Utilitaires partagés (logger sécurisé, timeouts, sanitation de chemins, gestion des sous-processus).
  - `src/preload/` : Script de préchargement sécurisé exposant l'API typée `window.electronAPI` via `contextBridge`.
  - `src/renderer/` : Interface utilisateur React — composants visuels, vues chat/paramètres, hooks IPC et localisation.
  - `src/shared/` : Types TypeScript partagés, constantes, guides de paramétrage de providers et presets de modèles.
  - `tests/` : Suite complète de tests unitaires et d'intégration (Vitest).
  - `scripts/` : Scripts de build, préparation des binaires (Node, Python, Lima/WSL agents) et packaging DMG/NSIS.
  - `.claude/skills/` : Compétences intégrées distribuées au format Markdown (`SKILL.md`).

- **Emplacement de la logique de l'agent** :
  - Fichier central : `src/main/agent/agent-runner.ts` (orchestration de la boucle de dialogue, exécution des outils, validation des permissions, gestion des tokens et compaction).
  - Prompts et stratégies : `src/main/agent/elite-coding-intelligence.ts` et `src/main/agent/adaptive-strategy-engine.ts`.
  - Résolution des modèles et appels API : `src/main/agent/pi-model-resolution.ts` qui instancie les adaptateurs via `@mariozechner/pi-coding-agent`, `@anthropic-ai/sdk`, `openai` ou `@google/genai` avec streaming en temps réel (`src/main/agent/streaming-response-handler.ts`).

- **Gestion du multi-provider** :
  - Normalisation unifiée à travers les types `SharedProviderType` (`openrouter`, `anthropic`, `openai`, `gemini`, `ollama`, `custom`).
  - Chaque profil stocke son endpoint `baseUrl`, sa clé API chiffrée localement et ses modèles supportés (`src/shared/api-model-presets.ts`).
  - `src/main/agent/pi-model-resolution.ts` traduit à la volée les requêtes et les schémas de tools selon les spécificités du provider sélectionné.

---

## Fonctionnalités

### Liste des Skills intégrés (`.claude/skills/` et runtime dynamique)
- **`docx`** : Création, lecture, modification, conversion et manipulation avancée de documents Microsoft Word (`.docx`).
- **`pdf`** : Extraction de texte et tables, fusion, découpage, rotation, chiffrement, OCR et génération de documents PDF.
- **`pptx`** : Génération automatisée de présentations, pitch decks, diapositives et mise en page PowerPoint (`.pptx`).
- **`xlsx`** : Manipulation, analyse de données et édition de feuilles de calcul Excel (`.xlsx`).
- **`skill-creator`** : Création, test, mesure de performance et itération dynamique sur de nouveaux fichiers `SKILL.md`.

### Connecteurs MCP configurés
- **Serveur GUI Operate intégré** (`src/main/mcp/gui-operate-server.ts`) : Prise de contrôle visuel (screenshots, clics, frappes de touches).
- **Catalogue MCP Store en 1 clic** (`src/main/mcp/mcp-store-registry.ts`) :
  - `Brave Search` (`@modelcontextprotocol/server-brave-search`) : Recherche Web directe.
  - `PostgreSQL Explorer` (`@modelcontextprotocol/server-postgres`) : Inspection de schémas et requêtes SQL.
  - `GitHub Automator` (`@modelcontextprotocol/server-github`) : Gestion des issues, PRs et commits.
  - `Puppeteer Browser Control` (`@modelcontextprotocol/server-puppeteer`) : Automatisation de navigateur headless.
  - `Extended Filesystem Sandbox` (`@modelcontextprotocol/server-filesystem`) : Accès sécurisé à des dossiers dédiés.

### Niveau de sandbox / isolation
- **Architecture d'isolation multi-niveaux** pilotée par `src/main/sandbox/sandbox-adapter.ts` :
  - **Windows** : Exécution isolée via conteneur **WSL2** (`dist-wsl-agent`).
  - **macOS** : Exécution isolée par machine virtuelle **Lima** (`dist-lima-agent`) ou mode **Natif** contrôlé avec alertes.
  - **Distant / Cloud** : Exécuteurs **SSH** et conteneurs éphémères **Daytona**.
  - **Contrôle de chemins** : `src/main/sandbox/path-guard.ts` empêche toute écriture hors de l'espace de travail désigné.

### Fonctionnalités ajoutées par rapport à la base d'origine
- **Contrôleur OS & Vision** : Intégration de `takeScreenshot()` et `simulateGuiAction()` via `src/main/system/system-controller.ts`.
- **Moteur de recherche Web natif** : Outils `web_search` (moteur DuckDuckGo gratuit par défaut + support Brave & Tavily) et `web_fetch` avec conversion HTML-Markdown.
- **Indexeur de graphe de code persistent** : `src/main/memory/codegraph-indexer.ts` avec cache disque atomique JSON et TTL pour cartographier le code sans surcharge mémoire.
- **Gestionnaire de Daemons d'arrière-plan** : `BackgroundJobRegistry` avec persistance de statut (`background_jobs.json`), logs individuels et nettoyage garanti à la fermeture (`cleanupSandboxResources`).
- **Swarm Multi-Agents & DAG** : `MultiAgentCoordinator` pour orchestrer des sous-agents en parallèle avec partage de contexte.
- **Self-Healing & Auto-Correction** : `SelfHealingRunner` et `AutoVerificationLoop` pour corriger automatiquement les erreurs de compilation/tests lors des turns de codage.
- **Édition et Relance dans le Chat** : Bouton d'édition inline (`Pencil`) sur les requêtes utilisateur et bouton de régénération (`RefreshCw`) sur les réponses de l'assistant dans `MessageCard.tsx` et `ChatView.tsx`.
- **Persistance de continuité de projet** : Mémorisation SQLite de la session active et reprise instantanée du contexte projet.
- **Internationalisation complète** : Support strict et synchronisé en Anglais (`en.json`), Français (`fr.json`) et Chinois (`zh.json`).

---

## Configuration actuelle
- **Modèles par défaut configurés** :
  - Provider par défaut : Anthropic (`claude-sonnet-4-6` / `claude-3-7-sonnet-latest`) ou OpenRouter / Gemini selon la sélection utilisateur.
- **Providers supportés et intégrés** :
  - `Anthropic`, `OpenRouter`, `OpenAI`, `Google Gemini`, `Ollama` (local), et endpoints `Custom` (compatibles OpenAI/Anthropic).
  - Clés additionnelles supportées pour la recherche : `Brave Search API`, `Tavily API`.
- **Variables d'environnement supportées** :
  - `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`
  - `ANTHROPIC_BASE_URL`
  - `CLAUDE_MODEL`
  - `CLAUDE_CODE_PATH`
  - `OPENAI_API_KEY`
  - `GEMINI_API_KEY`
  - `BRAVE_API_KEY`
  - `TAVILY_API_KEY`
  - `POSTGRES_CONNECTION_STRING`
  - `GITHUB_PERSONAL_ACCESS_TOKEN`

---

## État du projet

### Ce qui fonctionne et est stable
- Boucle d'agent complète avec exécution d'outils, streaming de réponses et thinking.
- Système de fichiers, lecture/écriture chirurgicale (`surgical-patcher`), recherche AST et linter.
- Recherche Web intégrée (`web_search` DuckDuckGo/Brave/Tavily et `web_fetch`).
- Gestion de sessions complètes : création, archivage, épinglage, renommage et suppression.
- Système d'édition de messages utilisateur et relance (Retry) de réponses.
- Création et exécution de builds macOS arm64 DMG fonctionnels.
- Gestionnaires de cycles de vie et d'extinction propre sans fuites de processus orphelins.

### Ce qui est en cours de développement / roadmap
- Perfectionnement de l'orchestration multi-agents DAG pour des refactorings massifs inter-dossiers.
- Extension des intégrations de messagerie externe (connecteurs Slack et Lark / Feishu).
- Enrichissement des outils de vision multimodale sur les snapshots d'écran en environnement de test.

### Bugs connus ou limitations actuelles
- **Harness SQLite dans l'environnement de test Vitest local** : Certaines suites de tests mémoire (`memory-smoke-harness`, `memory-eval-harness`) nécessitent l'alignement exact de la version ABI de `better-sqlite3` entre Node.js CLI et Electron (`npm run rebuild`). L'application packagée fonctionne en production sans accroc.
- Le mode sandbox Lima sur macOS requiert l'installation préalable de l'utilitaire `lima` sur la machine hôte si l'utilisateur désactive l'exécuteur natif.

---

## Notes techniques
- **Décisions d'architecture clés** :
  - *Surgical Patching vs Full Rewrite* : L'agent privilégie les modifications ciblées (`replace_file_content`) plutôt que la réécriture intégrale de fichiers pour économiser le contexte et éviter les régressions.
  - *Sécurité IPC stricte* : Utilisation obligatoire de `contextBridge` sans `remote` Electron et sans `nodeIntegration` dans les fenêtres de rendu.
  - *Timeouts de fermeture* : Tous les serveurs MCP et daemons sont arrêtés avec un timeout de protection de 5000ms (`withTimeout`) pour éviter le blocage de la fermeture de l'application.
- **Dépendances externes critiques** :
  - `electron` : `^41.7.1`
  - `better-sqlite3` : `^12.8.0`
  - `@anthropic-ai/sdk` : `^0.39.0`
  - `@google/genai` : `^1.44.0`
  - `openai` : `^6.32.0`
  - `@modelcontextprotocol/client` : `^2.0.0`
  - `vite` : `^7.3.1`
  - `react` : `^18.3.1`
- **Prochaines étapes prévues** :
  - Ajout de profils de prompts adaptatifs selon le domaine de développement (Mobile, Web, Backend, DevOps).
  - Intégration de moniteurs de consommation de quotas et d'estimation fine des coûts par requête.
