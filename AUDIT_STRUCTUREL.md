# Audit structurel — Open Cowork 3.5.0

> **Document historique — superseded.** C'est la **première passe**. La mesure
> refaite, les affirmations rectifiées et les décisions prises sont dans
> `AUDIT_STRUCTUREL_APPROFONDI.md` — voir notamment son §10 « Corrections
> apportées à l'audit précédent », qui en corrige plusieurs conclusions
> (cycles d'imports, nombre de fichiers de test, `mcp/gui/exec.ts` déclaré mort
> à tort). Conservé tel quel pour la traçabilité de la méthode. **Ne pas s'y fier
> pour l'état courant.**

Date : 5 octobre 2026  
Périmètre : arborescence, frontières de couches, god objects, systèmes doubles, surface IPC, tests.  
Méthode : lecture du code actuel (`src/`, `packages/`, `tests/`, configs). Les documents `PROJECT_OVERVIEW.md` et `PHASE0_DISCOVERY.md` ont été confrontés au dépôt, pas pris comme source de vérité.

Verdict : **architecture Electron saine, domaine trop dense, migrations à moitié faites.** Les frontières processus (main / preload / renderer / shared) tiennent. La dette n’est pas un manque de modules : c’est la coexistence de deux générations de systèmes, et des fichiers-racine trop gros pour rester des racines.

---

## 1. Carte réelle du dépôt

### 1.1 Volume

| Zone | Fichiers `.ts`/`.tsx` | Rôle |
|---|---|---|
| `src/main` | 354 | Processus principal, domaines métier |
| `src/renderer` | 136 | UI React |
| `src/shared` | 33 | Contrats cross-process |
| `src/preload` | 1 | Pont `contextBridge` |
| **Total `src/`** | **524** | ~150 500 lignes |
| `tests/` | 497 | Vitest, hors colocalisation |
| `packages/mod-api` | 1 contrat types-only | API publique des mods |

Répartition `src/main` (fichiers) :

| Dossier | Fichiers | Lecture |
|---|---|---|
| `agent/` | 112 | Kitchen sink — runtime + swarm + workflow + routing + images |
| `memory/` | 28 | Quatre sous-systèmes de mémoire coexistent |
| `ipc/` | 28 | Extraction en cours, presque complète |
| `sandbox/` | 23 | Meilleur découpage du dépôt |
| `utils/` | 21 | Fourre-tout utilitaire |
| `machine-access/` | 19 | Domaine bien borné |
| `remote/` | 17 | Gateway + canaux |
| `mods/` | 16 | v1 + v2 côte à côte |
| `mcp/` | 14 | Dont un « exemple » de 3 413 lignes bundlé |
| `skills/` | 12 | Runtime + catalogue plugins |
| `config/` | 12 | Store monolithique |
| Autres (`tools`, `presets`, `artifacts`, `rooms`, `projects`, `db`, `a2a`…) | ≤ 6 chacun | Taille saine |

Le renderer est à l’inverse trop plat : **98 fichiers sous `components/`**, store unique, un hook IPC de 1 006 lignes.

### 1.2 Couches Electron (ce qui tient)

```
renderer (React 18 + Zustand + Tailwind)
    ↓ contextBridge, sandbox: true, contextIsolation: true
preload (window.electronAPI typé)
    ↓ ipcRenderer.invoke / on
main (composition root + domaines)
    ↓
shared/          contrats (types, IPC DTO, panels, artifacts, rooms, mods v2)
packages/mod-api contrat types-only des mods (pas de runtime)
```

Points positifs vérifiés dans le code :

- `contextIsolation: true`, `sandbox: true` (constat PHASE0, toujours vrai).
- CSP posée dans `index.html` (`default-src 'self'` + `wasm-unsafe-eval` + fonts Google). **PHASE0_DISCOVERY.md est faux sur ce point** (« aucune CSP ») — le fichier a bougé depuis.
- `run-code` est un **bundle enfant séparé** (`src/main/agent/run-code-child-main.ts`) pour que `new Function` n’entre jamais dans le graphe du main. Décision structurelle correcte, testée (`tests/eval-isolation.test.ts`).
- Agents VM Lima/WSL ont leur propre `tsconfig` et un flatten de bundle. Isolation de build réelle.
- Alias TS clairs : `@/*`, `@main/*`, `@renderer/*`, `@cowork/mod-api`.

---

## 2. Forces structurelles

Ces choix sont à préserver, pas à « refactorer pour le plaisir ».

1. **Extraction IPC par domaine.** 28 modules `registerXxxIpcHandlers` avec injection de dépendances (`getSessionManager`, `getStore`…). C’est le bon pattern. `index.ts` n’est plus le lieu des handlers, seulement le wiring.
2. **`AgentRuntimeExtension`.** Seam réelle (`beforeSessionRun` / `afterSessionRun` / `onSessionDeleted`) utilisée par mémoire, config, subagents, artifacts. C’est le bon axe d’extension interne, distinct des mods.
3. **Sandbox en adaptateur.** `sandbox-adapter.ts` + exécuteurs (`native`, `wsl`, `lima`, `ssh`, `daytona`) + `path-guard` / `path-resolver`. Frontière OS propre.
4. **Contrats `src/shared` en croissance.** `artifact-contract`, `room-contract`, `mods-v2-contract`, `machine-access-contract`, `workspace-panels`, `task-contract`. Direction juste.
5. **Zustand unifié.** `SessionState` a remplacé « 8 Maps parallèles » (commentaire dans `store/index.ts`). Sélecteurs `useShallow` + constantes vides partagées : anti-re-render pensé.
6. **UI lourde en `lazy()`.** Chat, Settings, Projects, Control Center, Diff, etc. chargés à la demande depuis `App.tsx`.
7. **Settings découpés en onglets** (`settings/Settings*.tsx`, 22 fichiers). Le shell `SettingsPanel.tsx` (535 lignes) reste raisonnable.
8. **Densité de tests exceptionnelle.** 497 fichiers de tests pour 524 sources. Le risque n’est pas l’absence de filet, c’est que le filet fige les doublons (chaque système mort a sa suite).
9. **`packages/mod-api` types-only.** Pas de runtime, pas de build. Contrat public isolé — modèle à répliquer pour d’autres surfaces (artifacts, rooms) si elles deviennent des plugins.

---

## 3. Dettes critiques

Classées par impact structurel, pas par urgence produit.

### C1 — Systèmes doubles (priorité 1)

C’est **le** problème du dépôt. Chaque paire ci-dessous est une génération N et une génération N+1 qui tournent ensemble.

| Ancien | Nouveau | Preuve dans le code | Effet |
|---|---|---|---|
| `mods/mods-runtime.ts` + IPC `mods.*` | `mods/v2/*` + IPC `modsV2.*` | `index.ts:2364-2368` : « Two registries coexist on purpose during the v1 → v2 migration » | Deux stores Electron (`mods-config`, `mods-v2`), deux panneaux Settings (`SettingsMods` + `ModsV2Section`), agent branché **uniquement** sur v2 (`agent-hooks.ts` → `getModsRuntime`) |
| `MemoryManager` (historique session, notes, error patterns) | `MemoryService` (RAG, ingestion, retrieval) + `ProjectMemoryStore` + `memory-files-store` | Les deux sont instanciés : `SessionManager` crée `MemoryManager` ; `index.ts` crée `MemoryService`. IPC `memory.*` parle aux **deux** | Quatre modèles mentaux de « mémoire ». Aucun facade unique |
| `artifacts.readFile` / `ArtifactModal` | `artifacts.persistent.*` / `ArtifactStore` | Commentaire `artifact-store.ts` : « Deliberately separate » | Deux notions d’artifact dans l’UI |
| `ConfigModal` | `SettingsPanel` | Les deux sont lazy-loadés dans `App.tsx` | Deux surfaces de configuration |
| `ProjectsPanel` | `ProjectsPages` | Les deux montés dans `App.tsx` | Liste dock vs pages plein écran — recouvrement UX/code |
| Bus `client-event` / `client-invoke` | Canaux namespacés `ipcMain.handle('domain.action')` | `index.ts:2258-2271` **et** 28 fichiers ipc/ | Deux protocoles IPC. Le preload doit connaître les deux |
| `IPCRouter` | `ipcMain.handle` direct | `IPCRouter` n’est importé que par `preset-handlers.ts` | Abstraction morte à 95 % |

Conséquence : un contributeur ne peut pas répondre à « où se passe X ? » sans lire `index.ts`. La migration v1→v2 des mods est **documentée comme transitoire** ; les autres paires ne le sont pas.

### C2 — God objects (priorité 1)

Seuil : **> 1 500 lignes = racine qui a cessé d’être une racine.**

| Fichier | Lignes | Ce qu’il devrait être | Ce qu’il est |
|---|---|---|---|
| `src/main/mcp/software-dev-server-example.ts` | 3 413 | Exemple / serveur MCP isolé | Plus gros fichier du dépôt, bundlé en prod (`bundle-mcp.js`, `pre-build-check.js`) |
| `src/main/index.ts` | 2 733 | Composition root + lifecycle | Lifecycle + wiring IPC + boot mémoire/mods + quit watchdog + protocoles |
| `src/main/config/config-store.ts` | 2 336 | Store de config | Dieu de la configuration (sets, profils, secrets, personnalisation) |
| `src/main/agent/agent-runner.ts` | 2 293 | Orchestrateur de tour | Toujours le cœur malgré les extractions (`sandbox-session`, `formatting`, `loop-guard`, `mcp-tools`…) |
| `src/renderer/hooks/useApiConfigState.ts` | 2 220 | Hook de formulaire API | Logique de config **dans le renderer**, trop grosse pour un hook |
| `src/preload/index.ts` | 2 150 | Façade mince | Copie manuelle de **toute** l’API IPC |
| `src/main/mcp/gui/vision.ts` | 2 068 | Module vision | Implémentation monolithique |
| `src/main/mcp/mcp-manager.ts` | 1 981 | Cycle de vie MCP | Manager + chemins + reconnexion + outils |
| `src/main/session/session-manager.ts` | 1 905 | Cycle de vie session | Session + MCP + mémoire + files |
| `src/main/tools/dynamic-tool-creator.ts` | 1 839 | Un outil | Mini-runtime d’outils dynamiques |
| `src/main/agent/background-delegations.ts` | 1 675 | Délégation | Swarm + gate + resume |
| `src/renderer/components/projects/ProjectsPages.tsx` | 1 662 | Page projets | Page + détail + sessions |
| `src/main/db/database.ts` | 1 377 | Accès SQLite | Mega-DAO : sessions, messages, traces, tasks, projects, artifacts, rooms… |
| `src/renderer/components/ChatView.tsx` | 1 347 | Vue chat | Vue + input + layout + actions |
| `src/shared/types.ts` | 1 253 | Types partagés | Fourre-tout (session, project, plugin, schedule, remote…) |
| `src/renderer/store/index.ts` | 1 015 | Store UI | Tout l’état renderer |
| `src/renderer/hooks/useIPC.ts` | 1 006 | Abonnement événements | Dispatch central de **tous** les `ServerEvent` |

Les extractions déjà faites autour d’`agent-runner` (fichiers `agent-runner-*.ts`) prouvent que l’équipe sait découper. Le runner reste néanmoins au-dessus du seuil.

### C3 — `src/main/agent/` kitchen sink (priorité 1)

112 fichiers dans un seul dossier, sans sous-domaines. Inventaire réel :

| Sous-responsabilité | Exemples | Devrait vivre |
|---|---|---|
| Session SDK pi | `create-pi-session`, `reuse-pi-session`, `pi-session-*`, `agent-runner` | `agent/runtime/` |
| Swarm / délégation | `swarm-runner`, `background-delegations`, `sub-agent-gate`, `detached-delegation` | `agent/swarm/` |
| Workflow / TDD / self-heal | `workflow-executor`, `tdd-orchestrator`, `self-healing-runner`, `auto-verification-loop` | `agent/workflow/` |
| Routage modèles | `model-router`, `model-routing-service`, `provider-fallback` | `agent/routing/` |
| Images | `image-generation`, `image-tools` | `agent/images/` ou `tools/` |
| Control center | `control-center-service`, `activity-tracker`, `task-queue` | déjà un domaine UI — extraire |
| Run-code isolé | `run-code-*` (7 fichiers) | `agent/run-code/` (presque déjà le cas) |
| Métriques / bench | `metrics-harness`, `model-benchmark` | `agent/metrics/` |

Sans sous-dossiers, la dépendance circulaire est invisible : tout le monde importe tout le monde via des chemins `./`.

### C4 — Violation de frontière `shared` → `main` (priorité 2)

`src/shared/machine-access-contract.ts` ligne 8 :

```ts
import type { AutonomyLevel, FolderGrant, GrantAccess, GrantScope }
  from '../main/machine-access/types';
```

`shared/` **dépend de `main/`**. C’est l’inversion de la règle que le fichier lui-même énonce (« declared once and imported by both sides »).

Effet immédiat dans le renderer :

```ts
// SettingsMachineAccess.tsx
import type { FolderGrant, AutonomyLevel } from '@main/machine-access/types';
```

Le renderer importe `@main/*`. Vite peut le laisser passer parce que ce sont des `import type` (élidés), mais la frontière de module est cassée : un refactor de `main/machine-access/types.ts` casse l’UI sans passer par `shared/`.

Règle à rétablir : **les types wire vivent dans `shared/`. `main/` les réexporte, jamais l’inverse.**

### C5 — Preload = API publique non générée (priorité 2)

`src/preload/index.ts` (2 150 lignes) recopie à la main chaque canal. Il n’existe pas :

- de schéma unique (Zod / ts-rest / trpc-like) d’où dériver handlers + preload + types ;
- de test d’exhaustivité « chaque `ipcMain.handle('x')` a un miroir `electronAPI.x` » (à vérifier au cas par cas, pas structurellement garanti).

Deux protocoles à maintenir :

1. `client-event` / `client-invoke` → `ClientEvent` union dans `shared/types.ts`
2. ~150 `domain.action` namespacés

Le commentaire d’`ipc-types.ts` (« eliminate `any` from preload ») montre que le preload **était** un tas de `any`. Il est maintenant typé, mais toujours artisanal.

### C6 — Composition root trop chargé (priorité 2)

`src/main/startup/` ne contient que `boot-perf.ts`. Tout le boot vit dans `index.ts` :

- lifecycle Electron (ready, activate, before-quit, tray, shortcuts)
- création BrowserWindow
- init DB, SessionManager, Skills, MemoryService, Mods v1+v2, Workflow, ControlCenter, A2A, Remote, NavServer
- ~25 appels `register*IpcHandlers`
- watchdog de quit (commentaires longs, logique fragile — volontairement)

`index.ts` **doit** rester le composition root. À 2 733 lignes, il n’est plus lisible comme une liste de `new` + `register`. Extraire :

- `startup/create-services.ts`
- `startup/register-ipc.ts`
- `startup/window.ts`
- `startup/shutdown.ts`

garderait `index.ts` sous ~200 lignes de séquence.

### C7 — Renderer : un store, un bus, un dossier components (priorité 2)

- `store/index.ts` (1 015 l.) = état global unique. Les sélecteurs sont extraits (`selectors.ts`, 516 l.) — bien — mais le store lui-même n’est pas tranché par domaine (session, layout, sandbox, notices, machine-access…).
- `useIPC.ts` (1 006 l.) = switch géant sur `ServerEvent`. Même problème que l’ancien `index.ts` côté main, non encore extrait.
- `components/` : 49 fichiers à la racine + 7 sous-dossiers (`settings`, `projects`, `mods`, `message`, `subagents`, `remote`, `shared`). Inconsistant : `ChatView`, `Sidebar`, `ContextPanel` devraient être des dossiers, pas des fichiers de 800–1 300 lignes.

### C8 — Documentation d’architecture périmée (priorité 3)

`PROJECT_OVERVIEW.md` omet des dossiers **réels** : `a2a/`, `artifacts/`, `rooms/`, `mods/`, `machine-access/`, `projects/`, `workspace/`, `documents/`, `git/`, `preview/`. Il décrit encore `src/main/system/system-controller.ts` comme pièce centrale — le domaine machine-access l’a remplacé.

`PHASE0_DISCOVERY.md` est un snapshot de branche utile, mais :

- nie la CSP (elle existe dans `index.html`) ;
- dit que `getContextAdditions` n’a aucun consommateur — le `legacy-adapter.ts` v2 le mappe maintenant sur `onContextBuild` (changement de comportement **volontairement** documenté dans l’adapter).

Risque : un agent ou un humain qui part de ces docs prend de mauvaises décisions de découpage.

---

## 4. Qualité des frontières, module par module

### 4.1 Sandbox — référence interne

Découpage lisible : adapter, bootstrap, sync, path-guard, path-resolver, un exécuteur par backend, `vm-agent/` isolé. C’est le modèle à copier pour `agent/` et `memory/`.

### 4.2 Machine-access — bon domaine, contrat mal placé

19 fichiers, types purs, risk-assessor, emergency-stop, handlers IPC dédiés. Le seul défaut est C4 (contrat qui pointe vers `main`).

### 4.3 Mods — migration assumée, pas terminée

v2 a une vraie architecture : `manifest-schema`, `loader`, `installer`, `approval-store`, `safe-mode`, `event-bus`, `legacy-adapter`. v1 reste pour l’IPC `mods.*` et le panneau legacy. Commentaire dans `index.ts` : les mods v1 **ne sont plus invoqués** sur les tool calls. Donc v1 est une façade UI/IPC zombie — à calendrier de suppression.

### 4.4 Memory — quatre produits dans un dossier

| Classe | Responsabilité réelle | Consommateur |
|---|---|---|
| `MemoryManager` | Messages, compression contexte, error patterns, notes, préférences | `SessionManager`, outils notes, IPC `memory.notes.*` |
| `MemoryService` | Ingestion, RAG, retrieval progressif, files | Extension agent, IPC `memory.getOverview/search/...` |
| `ProjectMemoryStore` | Mémoire liée au projet | IPC `projectMemory.*`, injection prompt |
| `memory-files-store` | Fichiers mémoire chiffrés | `MemoryService` |

Ce n’est pas « trop de fichiers », c’est **quatre bounded contexts non nommés**. Un `memory/README` interne + un facade `MemoryFacade` qui route, ou un split de dossiers (`memory/session`, `memory/rag`, `memory/project`, `memory/files`), éviterait que le prochain contributeur ajoute un cinquième store.

### 4.5 MCP — serveur exemple devenu produit

`software-dev-server-example.ts` (3 413 l.) est référencé par `mcp-manager`, `mcp-config-store`, le script de bundle et le pre-build-check. Ce n’est plus un exemple. Soit on le sort vers `src/main/mcp/servers/software-dev/`, soit on arrête de l’appeler example.

`gui/` (vision 2 068 l., actions 1 095 l., windows-ops 930 l.) est un sous-produit GUI-operate qui mérite `src/main/mcp/gui/` comme package mental séparé — le dossier existe déjà, les fichiers sont trop gros.

### 4.6 DB — un fichier, toutes les tables

`database.ts` (1 377 l.) expose `sessions`, `messages`, `traceSteps`, `scheduledTasks`, `projects`, plus artifacts/rooms via migrations. Pattern DAO unique = chaque nouveau domaine grossit ce fichier. Split par table (`db/sessions.ts`, `db/projects.ts`, …) avec `database.ts` = ouverture + migrations uniquement.

### 4.7 Tests — filet excellent, organisation plate

497 fichiers **à la racine de `tests/`**. Aucun miroir `tests/main/agent/`, `tests/renderer/`. Nommer un test est devenu un préfixe (`agent-runner-*`, `memory-*`, `config-store-*`). Ça marche jusqu’à ~200 fichiers ; à 497, la découverte est une recherche full-text.

Colocaliser n’est pas obligatoire, mais **grouper par domaine** (`tests/agent/`, `tests/memory/`, `tests/ipc/`, `tests/renderer/`) est le minimum.

---

## 5. Graphe de dépendances (lecture qualitative)

### 5.1 Flux d’un tour agent (chemin chaud)

```
renderer ChatView
  → preload electronAPI (client-event | session.queue)
    → main index / session-handlers
      → SessionManager
        → AgentRunner
          → createPiSession / reusePiSession
            → agent-hooks (permissions + mods v2)
              → tools/pipeline (allow-list, path-guard, machine-access, mods)
            → MCPManager tools
            → MemoryExtension.beforeSessionRun
            → sandbox-adapter (exec)
          → ServerEvent stream
            → renderer useIPC → Zustand
```

Ce chemin est **compréhensible**. Les hooks et le pipeline d’outils sont les bonnes coutures.

### 5.2 Couplages dangereux

- `AgentRunner` connaît : Session, MCP, Config, Skills, Sandbox, MemoryManager, Projects, Two-stage pipeline, Swarm (via délégations), Control center (activity). Trop de directions sortantes.
- `SessionManager` (1 905 l.) est un second composition root : il possède MCPManager + MemoryManager. `index.ts` possède MemoryService. **Deux racines pour la mémoire.**
- `shared/types.ts` (1 253 l.) est importé partout. C’est un aimant à cycles de types. Les contrats récemment extraits (`artifact-contract`, `room-contract`…) montrent la direction : continuer à **casser** `types.ts` par domaine.

### 5.3 Cycles

Pas de cycle renderer → main runtime (seulement `import type` fautif, C4).  
Pas d’import `main` → `renderer` (vérifié).  
Le risque de cycle est **intra-`agent/`** et **intra-`memory/`**, non mesuré par un outil de graphe dans cet audit — à faire avec `madge` / `dependency-cruiser` comme prochaine mesure.

---

## 6. Score par axe

| Axe | Note | Commentaire |
|---|---|---|
| Isolation processus Electron | 8/10 | Isolation + CSP + child `run-code`. Moins 2 : preload mammouth, import `@main` depuis le renderer |
| Modularité domaines main | 5/10 | Bons dossiers (`sandbox`, `machine-access`, `ipc`) ; `agent/` et `memory/` non bornés |
| Unicité des concepts | 3/10 | Mods, mémoire, artifacts, settings, projets, IPC : deux de chaque |
| Taille des unités | 4/10 | ~15 fichiers > 1 500 lignes ; le plus gros est un « example » en prod |
| Contrats shared | 7/10 | Direction bonne, `types.ts` encore fourre-tout, C4 casse la règle |
| Extensibilité | 7/10 | Extensions runtime + mods v2 + skills. Trois mécanismes, un de trop à long terme |
| Testabilité structurelle | 8/10 | Handlers injectés, suites denses. Organisation `tests/` plate |
| Alignement doc / code | 4/10 | Overview et Phase 0 en retard sur le dépôt |

**Score global structure : 5,5 / 10** — pas un système fragile, un système **en migration permanente** sans date de fin des doubles voies.

---

## 7. Plan de remise en ordre (sans big-bang)

Ordre choisi pour **réduire le nombre de vérités**, pas pour réécrire l’agent.

### Vague 0 — gel des doublons (1–2 jours, documentation)

1. Un fichier `docs/architecture.md` généré depuis cet audit : carte des dossiers **réels**, règle `shared ↛ main`, liste des paires transitoires.
2. Marquer dans le code les façades zombies : `mods-runtime.ts`, IPC `mods.*`, `SettingsMods` — `@deprecated` + date cible.
3. Corriger C4 : déplacer `AutonomyLevel` / `FolderGrant` dans `shared/machine-access-contract.ts` ; `main` et renderer importent `shared` uniquement.

### Vague 1 — tuer une migration (mods) (1 sprint)

1. Brancher le panneau Settings unique sur `modsV2.*`.
2. Supprimer IPC `mods.*`, `SettingsMods`, éventuellement garder `legacy-adapter` **uniquement** pour charger d’anciens mods disque.
3. Un store Electron, pas deux.

Critère de fin : une recherche `getModsRegistry` ne sort plus que de l’adapter.

### Vague 2 — nommer la mémoire (1 sprint, pas de merge de code)

1. Découper `src/main/memory/` en sous-dossiers : `rag/`, `session/`, `project/`, `files/`.
2. Un `memory/index.ts` façade pour `index.ts` / IPC.
3. Ne **pas** fusionner `MemoryManager` et `MemoryService` dans ce sprint — seulement les ranger. Fusionner ensuite les notes (`memory.notes`) vers un seul store.

### Vague 3 — composition root et preload (1–2 sprints)

1. Éclater `index.ts` en `startup/{services,ipc,window,shutdown}.ts`.
2. Introduire un registre de canaux (constantes + types) d’où preload et handlers tirent les noms — même sans codegen au début.
3. Extraire `useIPC.ts` en handlers par domaine (`useSessionEvents`, `useSandboxEvents`, …) comme le main l’a fait avec `ipc/`.

### Vague 4 — `agent/` en sous-packages (2 sprints, mécanique)

Déplacer sans changer le comportement :

```
src/main/agent/
  runtime/     runner, pi-session, hooks
  swarm/
  workflow/
  routing/
  run-code/
  metrics/
```

Interdire les imports trans-sous-dossier sauf via `index.ts` publics. Mesurer avec `dependency-cruiser`.

### Vague 5 — god objects restants (continu)

Priorité interne une fois les frontières posées :

1. `software-dev-server-example.ts` → `mcp/servers/software-dev/` (plusieurs fichiers).
2. `config-store.ts` par concern (sets, secrets, profiles).
3. `database.ts` par table.
4. `ChatView.tsx` / `ProjectsPages.tsx` en dossiers.

Ne pas toucher à `agent-runner.ts` tant que Vague 4 n’a pas réduit ses imports.

### Hors scope volontaire

- Réécriture du moteur pi / changement de SDK.
- Fusion artifacts fichier vs persistants (ce sont deux concepts, le code le dit — garder, mais nommer `WorkspaceFilePreview` vs `PersistentArtifact`).
- Colocalisation tests à côté des sources (grouper `tests/<domaine>/` suffit).

---

## 8. Règles structurelles à adopter

À coller dans `AGENTS.md` / `CONTRIBUTING.md` si l’équipe les valide :

1. **`src/shared` n’importe jamais `src/main` ni `src/renderer`.** Même en `import type`.
2. **Le renderer n’importe jamais `@main/*`.** Contrats via `shared/` ou le shim `renderer/types`.
3. **Un concept = un store + un préfixe IPC.** Toute paire v1/v2 a une date de suppression dans le code.
4. **Fichier > 800 lignes** = ticket de split avant nouvelle feature dans ce fichier.
5. **Nouveau domaine** = dossier `main/<domaine>` + `ipc/<domaine>-handlers.ts` + contrat `shared/<domaine>-contract.ts` + onglet settings **ou** panneau, pas les deux sans RFC.
6. **Trois mécanismes d’extension maximum aujourd’hui** (skills, mods v2, `AgentRuntimeExtension`). Un quatrième exige d’en retirer un.
7. **`index.ts` (main) ne contient plus de logique** — seulement l’ordre d’assemblage.

---

## 9. Ce que cet audit n’a pas mesuré

- Cycles d’imports exacts (`madge` non exécuté).
- Couverture de tests en % de branches (seulement le **nombre** de fichiers).
- Performance de boot (il existe `boot-perf.ts` et des tests `boot-performance` / `app-startup-lazy-load` — hors structure).
- Sécurité runtime au-delà des frontières (path-guard, CSP, isolation `run-code`) — un audit sécu est un autre livrable.
- Qualité i18n `en`/`fr`/`zh` (sync des clés).

---

## 10. Synthèse en une phrase

Open Cowork a une **bonne ossature Electron et un excellent filet de tests**, mais le domaine a grandi par **accrétion de doubles systèmes** (`mods`, mémoire, artifacts, settings, IPC) et par **quelques fichiers-racine de 2–3 kLOC** ; tant que les migrations n’ont pas de date de fin, chaque feature nouvelle a deux endroits possibles — et les deux seront remplis.
