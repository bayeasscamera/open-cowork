# Audit structurel approfondi — Open Cowork 3.5.0

Date : 5 octobre 2026
Branche : `fix/security-review-and-external-links` (HEAD `9becc9b`)
Périmètre : `src/` (524 fichiers TS/TSX), `tests/`, `packages/`, configs de build.
Méthode : **mesure instrumentée**, pas lecture d'intention. Un analyseur de graphe
d'imports (`.cowork-verify/audit-graph.mjs`, SCC de Tarjan) a été écrit et exécuté
sur `src/`. Les documents `PROJECT_OVERVIEW.md` et `PHASE0_DISCOVERY.md` ont été
confrontés au dépôt, jamais pris comme source de vérité.

Ce document **complète** `AUDIT_STRUCTUREL.md` (laissé intact) en apportant ce que
celui-ci déclarait non mesuré : cycles d'imports réels, inventaire du code mort,
parité preload ↔ handlers, dérive i18n, câblage effectif des backends sandbox.

---

## 0. Verdict

**Ossature Electron saine, domaine en migration permanente, et — nouveauté de cet
audit — une couche de code non câblé qui a survécu à ses propres tests.**

Les frontières processus tiennent (aucun import `main → renderer`, `shared` propre
à une exception près). Le vrai problème n'est pas l'absence de modules : c'est que
le dépôt contient **cinq cycles d'imports mesurés**, **douze fichiers-racine de
plus de 1 500 lignes**, et **~2 500 lignes de code jamais atteint en production**
(dont 1 197 strictement mortes), que la suite de tests — excellente par ailleurs —
continue de valider.

Verification exécutée pendant cet audit :

| Commande | Résultat réel |
|---|---|
| `npm run typecheck` | **exit 0**, 0 erreur (42 s) |
| Analyse de graphe (script dédié) | 524 fichiers, **5 SCC cycliques** |
| Détection d'orphelins | 33 fichiers jamais importés, dont 15 confirmés non câblés |

---

## 1. Carte mesurée

### 1.1 Volume (compté, pas estimé)

| Zone | Fichiers `.ts`/`.tsx` | Lignes |
|---|---|---|
| `src/main` | 354 | — |
| `src/renderer` | 136 | — |
| `src/shared` | 33 | — |
| `src/preload` | 1 | 2 150 |
| **Total `src/`** | **524** | **150 541** |
| `tests/` | 503 fichiers (499 à la racine) | — |

Répartition `src/main` (fichiers) :

| Dossier | Fichiers | Lecture |
|---|---|---|
| `agent/` | 112 | Kitchen sink confirmé — 112 fichiers à plat, aucun sous-dossier |
| `memory/` | 28 | Quatre sous-systèmes coexistent (détail §4.4) |
| `ipc/` | 28 | Extraction quasi complète, 27 fichiers déclarent des handlers |
| `sandbox/` | 23 | Meilleur découpage du dépôt |
| `utils/` | 21 | Fourre-tout |
| `machine-access/` | 19 | Domaine bien borné |
| `remote/` | 17 | Gateway + canaux |
| `mods/` | 16 | v1 (3 fichiers) + v2 (13 fichiers) côte à côte |
| `mcp/` | 14 | Dont deux « serveurs » bundlés séparément |
| `skills/`, `config/` | 12 chacun | Runtime + store monolithique |
| Autres (`tools`, `presets`, `workspace`, `session`, `artifacts`, `rooms`, `projects`, `db`, `a2a`, `schedule`, `extensions`, `system`, `startup`, `preview`, `git`, `events`, `documents`, `cli`) | ≤ 6 chacun | Taille saine |

Renderer : **98 fichiers sous `components/`**, 22 sous `utils/`, 9 hooks. Trop plat.

### 1.2 Couches Electron (ce qui tient — vérifié)

```
renderer (React 18 + Zustand + Tailwind)
    ↓ contextBridge · contextIsolation: true · sandbox: true
preload (window.electronAPI, 2 150 l., 247 appels ipcRenderer)
    ↓ ipcRenderer.invoke / on
main (composition root + 27 modules de handlers)
    ↓
shared/   contrats (33 fichiers)
packages/mod-api   contrat types-only (pas de runtime)
```

Contrôles effectués :

- `main → renderer` : **0 import** (ripgrep sur `src/main/`). Frontière tenue.
- `shared → main|renderer` : **1 import fautif** (détail C4).
- `renderer → @main` : **1 import** (détail C4).
- `tsc --noEmit` : **0 erreur** avec `strict`, `noUnusedLocals`,
  `noUnusedParameters`, `noFallthroughCasesInSwitch` actifs. Le typage n'est pas
  une dette ici.
- i18n : `en.json`, `fr.json`, `zh.json` = **1 994 clés chacun, 0 dérive**
  (comparaison récursive des clés, pas un comptage de caractères). Point positif
  à souligner : la règle « toute string UI dans en + fr » d'`AGENTS.md` est
  respectée, zh inclus.
- CI (`.github/workflows/ci.yml`) : matrice **ubuntu + windows + macos**,
  `npm run lint` + `tsc --noEmit` + `test:coverage` (seuils vitest appliqués sur
  Linux), `node scripts/audit-ci.mjs` pour les avis de sécurité. Le filet est
  réel, pas décoratif.

---

## 2. Forces structurelles

À préserver, pas à « refactorer pour le plaisir ».

1. **Extraction IPC par domaine.** 27 modules `registerXxxIpcHandlers` avec
   injection de dépendances. `index.ts` n'est plus le lieu des handlers.
2. **`AgentRuntimeExtension`.** Seam réelle (`beforeSessionRun` /
   `afterSessionRun` / `onSessionDeleted`), utilisée par mémoire, config,
   subagents, artifacts. Bon axe d'extension interne, distinct des mods.
3. **Sandbox en adaptateur.** `sandbox-adapter.ts` + `path-guard` /
   `path-resolver` + un exécuteur par backend. Frontière OS propre.
4. **Isolation réelle du code généré par le modèle.** `run-code-child-main.ts`
   est un point d'entrée esbuild séparé, jamais importé depuis `src` — décision
   structurelle correcte, et **volontaire** (commentaire explicite dans
   `run-code-child.ts`, testée par `tests/run-code-process.test.ts`).
5. **Deux serveurs MCP isolés en bundles distincts.**
   `software-dev-server-example.ts` et `gui-operate-server.ts` ne sont jamais
   importés : ils sont *spawnés* (référencés par chemin dans `mcp-manager.ts` et
   `scripts/bundle-mcp.js`). Le bundle principal ne les embarque pas.
6. **Contrats `shared/` en croissance.** `artifact-contract`, `room-contract`,
   `mods-v2-contract`, `machine-access-contract`, `task-contract`,
   `workflow-types`… Direction juste.
7. **`packages/mod-api` types-only.** Pas de runtime, pas de build. Modèle à
   répliquer pour d'autres surfaces publiques.
8. **Typage strict tenu dans le temps.** 0 erreur `tsc` sur 150 k lignes avec
   `noUnusedLocals` : ce n'est pas un accident, c'est une discipline.

---

## 3. Dette nouvelle — code mort et modules non câblés (C9)

C'est **l'apport principal de cet audit**. L'audit précédent signalait la
densité de tests comme une force ; la mesure montre qu'elle **fige aussi des
modules que la production n'appelle jamais**.

Méthode : détection des fichiers jamais importés (résolution relative + alias),
puis contre-vérification ripgrep par nom de classe/export pour éliminer les faux
positifs (points d'entrée dynamiques, bundles spawnés).

### 3.1 Orphelins — état après corrections

> **Correction du 5 octobre, après mesure contradictoire.** La première version de
> cet audit listait `src/main/mcp/gui/exec.ts` (733 l.) comme mort. **C'était
> faux.** L'analyseur ne résolvait pas les imports suffixés `.js`
> (`import … from './exec.js'`), style ESM utilisé par tout `src/main/mcp/gui/`.
> `exec.ts` est importé par `actions.ts`, `display-coords.ts`, `vision.ts` et
> `windows-ops.ts` ; `tsc` l'a signalé dès la suppression. L'analyseur est
> corrigé (résolution `.js` → `.ts`) et la détection d'orphelins y est intégrée.
> **Leçon : un analyseur d'imports non validé par un compilateur produit des
> faux positifs dangereux.**

Fichiers sans **aucun** importateur (production ou test) :

| Fichier | Lignes | Statut | Décision |
|---|---|---|---|
| `src/main/sandbox/snapshot-manager.ts` | 91 | Remplacé par `agent/checkpoint-manager.ts` (archi « Cowork 4.0 », même rôle) | **Supprimé** |
| `src/main/utils/error-utils.ts` | 20 | Helper trivial, doublonné inline | **Supprimé** |
| `src/main/agent/codebase-rag.ts` | 192 | « Pilier 2 » — le « Pilier 4 » (`ast-code-intelligence`) est câblé, pas lui | **Conservé** — roadmap non intégrée |
| `src/main/agent/background-autopilot.ts` | 82 | En-tête explicite : « v3.6+ » | **Conservé** — version future |
| `src/main/agent/claude-bridge.ts` | 78 | Pont vers le CLI `claude`, aucun appelant | **Conservé** — intégration non construite |

**Supprimé : 111 lignes.** Les 352 lignes conservées le sont volontairement :
leur propre documentation les déclare comme travail planifié, et supprimer du
travail planifié n'est pas une décision d'audit — c'est une décision produit.
Elles restent **signalées** comme non atteintes.

### 3.2 Testés mais jamais câblés en production

Pire cas de figure : le module est couvert par une suite dédiée, donc il *paraît*
vivant, mais aucun chemin de production ne l'atteint. **Arbitré le 5 octobre** —
chaque ligne porte une décision, pas seulement un constat.

| Fichier | Lignes | Seul consommateur | Décision |
|---|---|---|---|
| `src/main/agent/impeccable-engine.ts` | 269 | `tests/impeccable-engine.test.ts` | **Conservé** — ajouté la veille (`4df6b70`) |
| `src/main/mods/v2/git-source.ts` | 222 | `tests/mods-v2-installer.test.ts` | **Conservé** — ajouté la veille |
| `src/main/sandbox/ssh-executor.ts` | 169 | `tests/cloud-executors.test.ts` | **Conservé** — backend non sélectionnable |
| `src/renderer/components/mods/ModDeclarativeUi.tsx` | 164 | `tests/mods-v2-ui.test.ts` | **Conservé** — gap ci-dessous |
| `src/renderer/components/MachineApprovalCard.tsx` | 132 | `tests/machine-access-card-render.test.ts` | **Conservé** — gap ci-dessous |
| `src/main/sandbox/daytona-executor.ts` | 130 | `tests/cloud-executors.test.ts` | **Conservé** — idem SSH |
| `src/main/memory/memory-prompt-optimizer.ts` | 115 | `tests/memory-eval-harness.test.ts` | **Conservé** — outil d'évaluation |
| `src/main/mcp/mcp-store-registry.ts` | 113 | `tests/mcp-store-registry.test.ts` | **Conservé** — ajouté la veille |
| `src/main/agent/model-router.ts` | 97 | `tests/model-router-fallback.test.ts` | **Conservé** — lié au fallback provider |
| `src/main/preflight.ts` | 59 | `tests/preflight-artifacts.test.ts` | **CORRIGÉ — `runPreflight()` appelé au boot** |

#### Gap 1 — le pipeline UI des mods v2 est complet côté main, mort côté renderer

`src/main/mods/v2/mod-context.ts` expose `contribute(modId, contribution: ModUiContribution)`
et le runtime l'implémente. **Rien ne consomme ces contributions** :
`ModDeclarativeUi.tsx` n'est jamais monté, et aucun autre composant ne lit les
slots (`statusBar`, `sidePanel`). La chaîne
`contribute() → renderer → slot` est interrompue au dernier maillon.

#### Gap 2 — `MachineApprovalCard` n'a ni producteur ni événement

Le composant existe, il est testé, `AGENTS.md` le documente. Mais
`ApprovalCardView` n'apparaît **nulle part** dans `src/main/`, et aucun variant de
`ServerEvent` ne porte de carte d'approbation. La fonctionnalité est à moitié
construite (le composant seul), pas abandonnée. C'est le cas typique que
`AGENTS.md` veut interdire : une surface UI sans contrat wire.

#### Gap 3 — backends sandbox déclarés mais non sélectionnables

`ssh-executor.ts` et `daytona-executor.ts` (299 l.) existent et sont testés, mais
`SandboxAdapter` n'instancie que `NativeExecutor` (`sandbox-adapter.ts:320`).
Aucun chemin ne choisit SSH ni Daytona : deux backends sont possibles sur le
papier et inatteignables en pratique.

**Total testé-mais-non-câblé : 1 491 lignes** (une seule corrigée : `preflight`).

### 3.3 Orphelins trouvés après correction de l'analyseur

| Fichier | Lignes | Note |
|---|---|---|
| `src/renderer/components/remote/SlackConfigStep.tsx` | 129 | Étape de configuration Slack jamais montée |
| `src/main/skills/preview-manager.ts` | 78 | Gestionnaire de preview inactif |

### 3.4 Barrels jamais importés

`src/main/machine-access/index.ts` (21), `src/main/sandbox/index.ts` (27),
`src/main/remote/index.ts` (20), `src/renderer/components/index.ts` (9). Façades
d'export que personne n'importe — la convention « importer via l'index du
dossier » n'est pas appliquée.

**Bilan C9 après action : ≈ 2 100 lignes non atteintes en production** (1,4 % de
`src/`), dont **111 supprimées** dans cette passe et **352 conservées
explicitement** comme travail planifié. Le reste est arbitré, pas oublié.

### 3.5 Ce qui n'est PAS mort (faux positifs écartés)

Pour éviter une conclusion fausse, ces fichiers ont été vérifiés et **ne sont pas
du code mort** :

- `mcp/gui/exec.ts` (733 l.) — **faux positif de la première passe** : importé via
  des specs `.js` par `actions.ts`, `display-coords.ts`, `vision.ts`,
  `windows-ops.ts`. Restauré après détection par `tsc`.
- `run-code-child-main.ts`, `vm-agent/{lima,wsl}/index.ts` — points d'entrée de
  build (tsconfig dédiés, esbuild).
- `software-dev-server-example.ts`, `gui-operate-server.ts`, `mcp/gui/*` — bundles
  MCP spawnés séparément ; `gui/*` est importé par `gui-operate-server.ts`.
- `mods/mods-runtime.ts` (v1) — **bien importé** par `index.ts:138` et
  `registerModsIpcHandlers()`. Le v1 est vivant (façade IPC), pas mort.
- `system/system-controller.ts` — atteint via `dynamic-tool-creator.ts` (7 appels).
- `ipc/ipc-router.ts` — atteint via `preset-handlers.ts` (4 canaux sur 178).

---

## 4. Dette critique (confirmée par mesure)

### C1 — Systèmes doubles (priorité 1)

| Ancien | Nouveau | Preuve mesurée |
|---|---|---|
| mods v1 : `mods-runtime.ts`, IPC `mods.list` / `mods.setEnabled` | mods v2 : `mods/v2/*` (13 fichiers), IPC `modsV2.*` (7 canaux) | Les **deux** `register*IpcHandlers` sont appelés (`index.ts:2440` et suite) |
| `MemoryManager` (session, notes, error patterns) | `MemoryService` (RAG, ingestion, retrieval) + `ProjectMemoryStore` + `memory-files-store` | Les deux instanciés : `SessionManager` crée `MemoryManager`, `index.ts` crée `MemoryService`. IPC `memory.*` parle aux deux |
| `artifacts.readFile` / `ArtifactModal` | `artifacts.persistent.*` / `ArtifactStore` | Deux notions d'artifact dans l'UI |
| `ConfigModal` | `SettingsPanel` | Les deux lazy-loadés dans `App.tsx` |
| `ProjectsPanel` (866 l.) | `ProjectsPages` (1 662 l.) | Les deux montés |
| Bus `client-event` / `client-invoke` | 178 canaux namespacés `domain.action` | `client-event-handler.ts` (table de dispatch) **et** 27 modules ipc/ |
| `IPCRouter` | `ipcMain.handle` direct | `IPCRouter` ne porte que **4 des 178 canaux** (2 %) |

Conséquence : « où se passe X ? » n'a pas de réponse unique. La migration v1→v2 des
mods est documentée comme transitoire ; les autres paires ne le sont pas.

### C2 — God objects (priorité 1)

Seuil : **> 1 500 lignes = racine qui a cessé d'être une racine.**
**12 fichiers** au-dessus ; **38 fichiers** au-dessus de 800.

| Fichier | Lignes | Ce qu'il devrait être |
|---|---|---|
| `src/main/mcp/software-dev-server-example.ts` | 3 413 | Serveur MCP isolé (bundle séparé) — plus gros fichier du dépôt |
| `src/main/index.ts` | 2 733 | Composition root — porte **101 imports internes** (record du dépôt) |
| `src/main/config/config-store.ts` | 2 336 | Store de config — fan-in 37 |
| `src/main/agent/agent-runner.ts` | 2 293 | Orchestrateur de tour — fan-out 55 |
| `src/renderer/hooks/useApiConfigState.ts` | 2 220 | Hook de formulaire API — logique de config dans le renderer |
| `src/preload/index.ts` | 2 150 | Façade mince — 247 appels `ipcRenderer` recopiés à la main |
| `src/main/mcp/gui/vision.ts` | 2 068 | Module vision (bundle GUI isolé) |
| `src/main/mcp/mcp-manager.ts` | 1 981 | Cycle de vie MCP |
| `src/main/session/session-manager.ts` | 1 905 | Cycle de vie session — second composition root (possède MCPManager + MemoryManager) |
| `src/main/tools/dynamic-tool-creator.ts` | 1 839 | Un outil — mini-runtime d'outils dynamiques |
| `src/main/agent/background-delegations.ts` | 1 675 | Délégation — dans le cycle principal (§5) |
| `src/renderer/components/projects/ProjectsPages.tsx` | 1 662 | Page projets |

### C3 — `src/main/agent/` kitchen sink (priorité 1)

**112 fichiers à plat**, aucun sous-dossier. Inventaire réel :

| Sous-responsabilité | Exemples | Devrait vivre |
|---|---|---|
| Session SDK pi | `create-pi-session`, `reuse-pi-session`, `pi-session-*`, `agent-runner` | `agent/runtime/` |
| Swarm / délégation | `swarm-runner`, `background-delegations`, `sub-agent-gate`, `detached-delegation`, `fork-policy` | `agent/swarm/` |
| Workflow / TDD / self-heal | `workflow-executor`, `tdd-orchestrator`, `self-healing-runner`, `auto-verification-loop` | `agent/workflow/` |
| Routage modèles | `model-router`, `model-routing-service`, `provider-fallback`, `pi-model-resolution` | `agent/routing/` |
| Images | `image-generation`, `image-tools` | `agent/images/` |
| Run-code isolé | `run-code-*` (7 fichiers) | `agent/run-code/` |
| Métriques / bench | `metrics-harness`, `model-benchmark` | `agent/metrics/` |
| Contrôle / audit | `control-center-service`, `activity-tracker`, `task-queue`, `audit-log*` | domaine UI — extraire |

Sans sous-dossiers, les dépendances croisées sont invisibles : le cycle principal
de 11 fichiers (§5) en est la conséquence directe.

### C4 — Violations de frontière (priorité 2) — mesurées

Deux violations, toutes deux confirmées par ripgrep :

1. `src/shared/machine-access-contract.ts:8`
   ```ts
   import type { AutonomyLevel, FolderGrant, GrantAccess, GrantScope }
     from '../main/machine-access/types';
   ```
   `shared/` dépend de `main/` — inversion de la règle énoncée dans le fichier
   lui-même (« declared once and imported by both sides »).

2. `src/renderer/components/settings/SettingsMachineAccess.tsx:4`
   ```ts
   import type { FolderGrant, AutonomyLevel } from '@main/machine-access/types';
   ```
   Le renderer importe `@main/*` — seule occurrence du dépôt.

Vite laisse passer (`import type` élidé), mais la frontière de module est cassée :
un refactor de `main/machine-access/types.ts` casse l'UI sans passer par `shared/`.

Règle à rétablir : **les types wire vivent dans `shared/`. `main/` les réexporte,
jamais l'inverse.**

### C5 — Preload artisanal (priorité 2) — chiffré

- **178 canaux `ipcMain.handle`** uniques, répartis sur **27 fichiers**.
- **247 appels `ipcRenderer.*`** dans un seul fichier de 2 150 lignes.
- Aucun schéma unique (Zod / ts-rest) d'où dériver handlers + preload + types.
- Aucun test d'exhaustivité « chaque canal a un miroir `electronAPI.x` ».
- **Deux protocoles** à maintenir : bus `client-event`/`client-invoke`, et les 178
  canaux namespacés.

L'écart 247 ↔ 178 (≈ 69 appels `on`/`send` d'événements en plus des `invoke`)
montre que le preload fait à la fois façade de commandes **et** abonnement
d'événements, sans registre commun.

### C6 — Composition root trop chargé (priorité 2)

`src/main/startup/` ne contient que `boot-perf.ts`. Tout le boot vit dans
`index.ts` (2 733 lignes, **101 imports internes**, ~25 `register*IpcHandlers`) :

- lifecycle Electron (ready, activate, before-quit, tray, shortcuts)
- création BrowserWindow
- init DB, SessionManager, Skills, MemoryService, Mods v1 **et** v2, Workflow,
  ControlCenter, A2A, Remote, NavServer
- watchdog de quit (logique volontairement fragile, commentée)

`index.ts` doit rester le composition root. À 2 733 lignes et 101 imports, il n'est
plus lisible comme une liste de `new` + `register`.

### C7 — Renderer : un store, un bus, un dossier plat (priorité 2)

- `store/index.ts` (1 015 l.) = état global unique ; sélecteurs extraits
  (`selectors.ts`) mais store non tranché par domaine.
- `useIPC.ts` (1 006 l.) = switch géant sur `ServerEvent` — même problème que
  l'ancien `index.ts` côté main, non encore extrait.
- `components/` : 98 fichiers, 49 à la racine + 7 sous-dossiers. Incohérent :
  `ChatView` (1 347), `Sidebar` (974), `WelcomeView` (828) sont des fichiers, pas
  des dossiers.

### C8 — Documentation d'architecture périmée (priorité 3)

`PROJECT_OVERVIEW.md` omet des dossiers réels : `a2a/`, `artifacts/`, `rooms/`,
`mods/`, `machine-access/`, `projects/`, `workspace/`, `documents/`, `git/`,
`preview/`. Il décrit encore `system/system-controller.ts` comme pièce centrale —
ce fichier n'est plus atteint que par `dynamic-tool-creator.ts`.

`PHASE0_DISCOVERY.md` nie la CSP (elle existe dans `index.html`) et dit que
`getContextAdditions` n'a aucun consommateur (le `legacy-adapter.ts` v2 le mappe
maintenant sur `onContextBuild`).

Risque : un agent ou un humain qui part de ces docs prend de mauvaises décisions
de découpage.

---

## 5. Graphe de dépendances — cycles mesurés (C10)

L'audit précédent déclarait les cycles « non mesurés, faute d'outil ». Ils le sont
maintenant : **5 composantes fortement connexes** (Tarjan sur le graphe d'imports
relatifs de `src/`, 524 fichiers).

### 5.1 Le graphe doit distinguer `import type` des imports de valeur

Première mesure : **5 SCC** sur le graphe complet, dont une de **11 fichiers**
traversant `session → agent → skills → tools → events`. C'est le chiffre que la
version initiale de cet audit mettait en avant.

**Il était trompeur.** L'arête qui refermait cette boucle —
`events/renderer-sender.ts → session/session-manager.ts` — est un **`import type`**,
effacé à la compilation. Un cycle de types n'est pas un cycle d'exécution : aucun
risque d'ordre d'initialisation. L'analyseur a donc été scindé en deux graphes
(toutes arêtes / arêtes de valeur), et l'arête fautive remplacée par une interface
structurelle locale (`SessionDispatcherTarget`).

| Graphe | Avant action | Après action |
|---|---|---|
| Toutes arêtes (dont `import type`) | 5 SCC, max **11** fichiers | **4 SCC, max 3** fichiers |
| **Arêtes de valeur (runtime réel)** | **2 SCC** | **1 SCC** |

### 5.2 Cycle runtime principal — swarm (corrigé)

```
main/agent/swarm-runner.ts           -> background-delegations.ts
main/agent/background-delegations.ts -> swarm-runner.ts, fork-policy.ts
main/agent/fork-policy.ts            -> background-delegations.ts
```

Trois fichiers, un seul domaine, mais un **vrai** cycle runtime. Deux coupes :

1. **`fork-policy → background-delegations`** ne tenait qu'à une constante
   (`MAX_DELEGATION_DEPTH`). Déplacée dans le nouveau module feuille
   `src/main/agent/delegation-limits.ts` ; `background-delegations` la réexporte
   pour ne rien casser (deux suites de tests l'importent de là).
2. **`swarm-runner → background-delegations`** ne tenait qu'à une fonction
   (`buildSubAgentDelegationTool`). Inversée en injection : `SwarmRunnerOptions`
   et `SubAgentSessionArgs` portent désormais `buildDelegationTool`, fourni par
   `background-delegations`. Absent, le sous-agent n'a simplement pas l'outil
   `delegate_subtask`.

Résultat : **0 cycle runtime dans `agent/`**.

### 5.3 Cycle restant — sandbox, volontaire et documenté

```
main/sandbox/sandbox-bootstrap.ts  -> wsl-bridge.ts, lima-bridge.ts
main/sandbox/{wsl,lima}-bridge.ts  -> sandbox-bootstrap.ts   (import() paresseux)
```

`wsl-bridge.ts:17` porte le commentaire `// Import lazily to avoid circular
dependency` et charge le bootstrap par `await import('./sandbox-bootstrap')` à
l'appel, pas au chargement du module. **C'est une coupe volontaire, pas un
défaut** : l'analyseur la signale uniquement parce qu'un `import()` dynamique est
une arête de valeur. À laisser tel quel.

### 5.4 Cycles type-only restants (couplage de types, pas de runtime)

| Taille | Fichiers | Nature |
|---|---|---|
| 2 | `config/{auth-utils, config-store}` | Store ↔ auth — refactor local |
| 2 | `agent/{machine-access-gate, agent-hooks}` | Gate ↔ hooks — porte la sécurité |
| 2 | `memory/{memory-tools, memory-service}` | Outils ↔ service — borné au dossier |

Aucun risque d'initialisation. À traiter avec la règle « les types wire vivent
dans `shared/` » (C4), pas en priorité.

### 5.5 Fan-in / fan-out (points de couplage)

**Fan-in — les aimants :**

| Imports internes | Fichier |
|---|---|
| 144 | `src/main/utils/logger.ts` |
| 54 | `src/shared/types.ts` |
| 42 | `src/renderer/types/index.ts` |
| 41 | `src/renderer/store/index.ts` |
| 37 | `src/main/config/config-store.ts` |
| 25 / 25 / 20 | `shared/{task-contract, workflow-types, control-center-types}` |
| 14 | `src/main/machine-access/types.ts` |

`shared/types.ts` (1 253 l., 54 importeurs) reste un aimant à cycles de types : les
contrats récemment extraits montrent la direction — continuer à **casser**
`types.ts` par domaine.

**Fan-out — les hyperconnectés :**

| Imports internes | Fichier |
|---|---|
| 101 | `src/main/index.ts` |
| 55 | `src/main/agent/agent-runner.ts` |
| 32 | `src/renderer/App.tsx` |
| 28 | `src/main/session/session-manager.ts` |
| 26 | `src/main/memory/memory-service.ts` |

`AgentRunner` connaît : Session, MCP, Config, Skills, Sandbox, MemoryManager,
Projects, pipeline deux-étages, Swarm, Control center. `SessionManager` est un
**second composition root** (il possède MCPManager + MemoryManager) alors que
`index.ts` possède MemoryService — **deux racines pour la mémoire**.

### 5.6 Cycles interdits (vérifiés absents)

- `renderer → main` runtime : absent (seul l'`import type` fautif de C4).
- `main → renderer` : absent.
- `shared → main` : présent une seule fois (C4).

---

## 6. Score par axe

| Axe | Note | Justification mesurée |
|---|---|---|
| Isolation processus Electron | 8/10 | 0 import `main→renderer` ; `run-code` enfant isolé ; CSP présente. −2 : preload 2 150 l., 1 import `@main` |
| Modularité domaines main | 5/10 | Bons dossiers (`sandbox`, `machine-access`, `ipc`) ; `agent/` 112 fichiers à plat |
| Unicité des concepts | 3/10 | mods, mémoire, artifacts, settings, projets, IPC : deux de chaque |
| Taille des unités | 4/10 | 12 fichiers > 1 500 l., 38 > 800 l. ; le plus gros est un « example » |
| Contrats shared | 6/10 | Direction bonne ; `types.ts` fourre-tout ; C4 casse la règle. −1 vs audit précédent : la violation est confirmée, pas théorique |
| **Hygiène du code mort** | **5/10** | 111 l. supprimées, 352 conservées comme travail planifié ; restent 1 491 l. testées-mais-non-câblées, dont 3 gaps réels nommés |
| **Intégrité du graphe d'imports** | **7/10** | 0 cycle runtime hors `sandbox` (volontaire, documenté) ; 3 cycles type-only restants |
| Extensibilité | 7/10 | Extensions runtime + mods v2 + skills — trois mécanismes, un de trop |
| Testabilité structurelle | 7/10 | 503 fichiers, CI 3 OS, seuils de couverture. −3 : la suite **valide du code non câblé**, elle ne le détecte pas |
| Alignement doc / code | 4/10 | `PROJECT_OVERVIEW` et `PHASE0` en retard |
| Typage & i18n | 9/10 | `tsc` 0 erreur en strict ; 1 994 clés × 3 langues, 0 dérive |

**Score global : 5,5 / 10** — 5,0 à la première mesure, **5,5 après les trois
actions** (code mort arbitré, `preflight` câblé, cycle runtime principal cassé).
Verdict inchangé sur le fond : ce n'est pas un système fragile, c'est un système
**en migration permanente**. Mais la nature de la dette a changé : ce n'est plus
« du code mort », c'est **trois fonctionnalités à moitié construites** — UI
déclarative des mods v2, carte d'approbation machine, backends SSH/Daytona — qu'il
faut soit finir, soit retirer. Un audit ne peut pas trancher à la place du
produit.

---

## 7. Plan de remise en ordre (sans big-bang)

Ordre choisi pour **réduire le nombre de vérités**, pas pour réécrire l'agent.

### Vague 0 — souveraineté du graphe (1–2 jours, mécanique, sans risque produit)

1. **Supprimer le code strictement mort (C9 §3.1)** : 1 197 lignes, 6 fichiers,
   zéro référence — `git rm` sans effet fonctionnel. Le plus gros gain par heure
   investie de tout ce plan.
2. **Trancher sur les 9 modules testés-mais-non-câblés (C9 §3.2)** : pour chacun,
   *câbler* (avec un test d'intégration qui prouve l'atteinte) ou *supprimer la
   suite + le module*. `preflight.ts` est le cas d'école : soit on appelle
   `runPreflight()` au boot, soit on assume qu'il ne sert plus.
3. **Corriger C4** : déplacer `AutonomyLevel` / `FolderGrant` dans
   `shared/machine-access-contract.ts` ; `main` et renderer importent `shared`.
4. **Écrire `docs/architecture.md`** : carte des dossiers réels, règle
   `shared ↛ main`, liste des paires transitoires, et la commande
   `node .cowork-verify/audit-graph.mjs src` pour rejouer la mesure.

### Vague 1 — casser le cycle de 11 fichiers (1 sprint, priorité haute)

Le cycle principal traverse `session → agent → skills → tools → events`. Deux
coupures suffisent à le briser :

1. `skills/skill-proposals.ts → events/renderer-sender.ts` : passer par un port
   (interface injectée) au lieu d'importer l'émetteur.
2. `tools/dynamic-tool-creator.ts → agent/swarm-runner.ts` + `background-delegations.ts` :
   inverser via un callback/registre, comme le reste du dépôt le fait déjà.

Critère de fin : le script d'analyse retourne **0 SCC** contenant plus d'un dossier
de premier niveau.

### Vague 2 — tuer une migration (mods) (1 sprint)

1. Brancher le panneau Settings unique sur `modsV2.*`.
2. Supprimer IPC `mods.*` (2 canaux), `SettingsMods`, garder `legacy-adapter`
   **uniquement** pour charger d'anciens mods disque.
3. Un store Electron, pas deux.

Critère de fin : `getModsRegistry` ne sort plus que de l'adapter.

### Vague 3 — nommer la mémoire (1 sprint, rangement, pas de fusion)

1. Découper `src/main/memory/` (28 fichiers) en `rag/`, `session/`, `project/`, `files/`.
2. Un `memory/index.ts` façade pour `index.ts` / IPC.
3. Ne **pas** fusionner `MemoryManager` et `MemoryService` ici — ranger d'abord,
   unifier les notes ensuite.

### Vague 4 — composition root et preload (1–2 sprints)

1. Éclater `index.ts` (2 733 l., 101 imports) en
   `startup/{services,ipc,window,shutdown}.ts`.
2. Introduire un registre de canaux (constantes + types) d'où preload et handlers
   tirent les noms — même sans codegen.
3. Extraire `useIPC.ts` par domaine, comme le main l'a fait avec `ipc/`.

### Vague 5 — `agent/` en sous-packages (2 sprints, mécanique)

Déplacer sans changer le comportement : `runtime/`, `swarm/`, `workflow/`,
`routing/`, `run-code/`, `metrics/`. Interdire les imports trans-sous-dossier sauf
via `index.ts` publics. Mesurer après chaque étape avec le script d'analyse.

### Vague 6 — god objects restants (continu)

1. `software-dev-server-example.ts` → `mcp/servers/software-dev/` (le renommer :
   ce n'est plus un exemple).
2. `config-store.ts` par concern (sets, secrets, profiles).
3. `db/database.ts` (1 377 l.) par table.
4. `ChatView.tsx` / `ProjectsPages.tsx` / `Sidebar.tsx` en dossiers.

Ne pas toucher à `agent-runner.ts` avant que la Vague 5 n'ait réduit ses 55 imports.

### Hors scope volontaire

- Réécriture du moteur pi / changement de SDK.
- Fusion artifacts fichier vs persistants (deux concepts assumés — mais les
  **renommer** `WorkspaceFilePreview` vs `PersistentArtifact`).
- Colocalisation des tests à côté des sources (grouper `tests/<domaine>/` suffit).

---

## 8. Règles structurelles à adopter

À coller dans `AGENTS.md` / `CONTRIBUTING.md` si l'équipe les valide :

1. **`src/shared` n'importe jamais `src/main` ni `src/renderer`.** Même en `import type`.
2. **Le renderer n'importe jamais `@main/*`.** Contrats via `shared/`.
3. **Un concept = un store + un préfixe IPC.** Toute paire v1/v2 a une date de
   suppression dans le code.
4. **Fichier > 800 lignes** = ticket de split avant nouvelle feature dans ce fichier.
5. **Nouveau domaine** = dossier `main/<domaine>` + `ipc/<domaine>-handlers.ts` +
   contrat `shared/<domaine>-contract.ts` + onglet settings **ou** panneau, pas les
   deux sans RFC.
6. **Trois mécanismes d'extension maximum** (skills, mods v2,
   `AgentRuntimeExtension`). Un quatrième exige d'en retirer un.
7. **`index.ts` (main) ne contient plus de logique** — seulement l'ordre d'assemblage.
8. **Aucun cycle entre dossiers de premier niveau.** CI : faire échouer le build si
   `node .cowork-verify/audit-graph.mjs src` retourne un SCC multi-domaine.
9. **Un module testé doit avoir un appelant en production**, sinon le test est une
   décoration. Un test d'intégration « le module est atteint » vaut mieux qu'un
   test unitaire sur un module orphelin.

---

## 9. Ce que cet audit n'a pas mesuré

- **Couverture en % de branches.** Seul le *nombre* de fichiers de test a été
  compté, et la présence des seuils vitest dans `vitest.config.mts` n'a pas été
  vérifiée par exécution de `test:coverage` (suite complète non lancée : hors
  périmètre d'un audit structurel, et coûteuse).
- **Performance de boot.** `boot-perf.ts` et les tests `boot-performance` /
  `app-startup-lazy-load` existent — hors structure.
- **Sécurité runtime** au-delà des frontières (path-guard, CSP, isolation
  `run-code`) — un audit sécu est un autre livrable.
- **Qualité des traductions** (les clés sont synchronisées, leur contenu ne l'est
  pas nécessairement).
- **Le dossier `website/`** (site marketing, `package.json` séparé) — non audité.
- **`dist-electron` (196 Mo) et `release/` (955 Mo)** : artefacts de build
  présents dans l'arbre de travail ; vérifier qu'ils sont bien ignorés par git
  (`.gitignore`), ce qui n'a pas été contrôlé ligne à ligne.

---

## 10. Corrections apportées à l'audit précédent

| Affirmation de `AUDIT_STRUCTUREL.md` | Statut après mesure |
|---|---|
| « Cycles non mesurés (madge non exécuté) » | **Résolu** : 5 SCC mesurés, puis **corrigés** en 2 cycles runtime + 3 cycles type-only |
| « Cycle principal de 11 fichiers » (cet audit, 1ʳᵉ passe) | **Corrigé** : c'était un cycle **type-only** — l'arête fermante est un `import type`. Le graphe de valeur ne comptait que 2 SCC de 3 fichiers |
| « 497 fichiers de tests » | **499 à la racine, 503 au total** |
| « `IPCRouter` importé seulement par `preset-handlers.ts` » | **Confirmé**, précisé : 4 canaux sur 178 (2 %) |
| « `mods v1` est une façade zombie » | **Nuancé** : `mods-runtime.ts` est bien importé (`index.ts:138`) et 2 canaux `mods.*` sont enregistrés — vivant, pas mort |
| « `mcp/gui/exec.ts` (733 l.) strictement mort » (cet audit, 1ʳᵉ passe) | **Faux** — importé via des specs `.js` ; l'analyseur a été corrigé et le fichier restauré (`tsc` l'a démasqué) |
| « Score global 5,5 / 10 » | **Révisé à 5,0** à la première mesure, **remonté à 5,5** après les trois actions |
| — | **Ajout** : `runPreflight()` jamais appelé (corrigé), backends SSH/Daytona non câblés, UI mods v2 jamais montée, `MachineApprovalCard` sans producteur |
| — | **Ajout** : i18n vérifié sain (1 994 clés × 3, 0 dérive) et `tsc` 0 erreur |

**Méthode** : chaque affirmation ci-dessus a été vérifiée deux fois (analyseur +
ripgrep), et toute suppression a été validée par `tsc --noEmit`. Un analyseur
d'imports **non** validé par un compilateur produit des faux positifs dangereux —
`exec.ts` l'a prouvé.

---

## 11. Synthèse en une phrase

Open Cowork a une **bonne ossature Electron, un typage strict tenu et un filet de
tests dense**, mais le domaine a grandi par **accrétion de doubles systèmes**, par
**quelques fichiers-racine de 2–3 kLOC**, par des **cycles d'imports** dont un seul
réellement actif à l'exécution, et il traîne **~2 100 lignes de code que la
production n'exécute jamais** — tant que les migrations n'ont pas de date de fin et
que la CI ne mesure pas le graphe, chaque feature nouvelle a deux endroits
possibles, et les deux seront remplis.

---

## 12. Actions appliquées (5 octobre 2026)

Les trois points du plan §7 Vague 0–1 ont été exécutés. Vérifié à chaque étape :
`tsc --noEmit` exit 0, `eslint` exit 0, suite ciblée 97/98 (le 1 échec est
préexistant : `tests/background-delegations.test.ts:761` vérifie une chaîne
absente de `pi-session-tools.ts` **y compris dans HEAD**).

### Action 1 — code mort arbitré

| Fichier | Décision |
|---|---|
| `src/main/sandbox/snapshot-manager.ts` (91 l.) | **Supprimé** — remplacé par `agent/checkpoint-manager.ts` |
| `src/main/utils/error-utils.ts` (20 l.) | **Supprimé** — trivial, doublonné inline |
| `mcp/gui/exec.ts`, `codebase-rag.ts`, `background-autopilot.ts`, `claude-bridge.ts` | **Restaurés / conservés** — fausse accusation (`exec`) ou travail planifié (les trois autres) |

Net : **−111 lignes**, zéro référence perdue (vérifié `tsc` + ripgrep src/tests/scripts).

### Action 2 — `preflight` câblé

`runPreflight()` est appelé en début de `whenReady()` dans `src/main/index.ts`,
derrière un `try/catch` qui ne peut pas bloquer le boot. No-op hors build packagé
(le fichier le garantit : `if (!app.isPackaged) return []`).

Les 9 autres modules non câblés sont **conservés et arbitrés** (§3.2) : quatre ont
1 à 3 jours d'âge et une intention explicite, les autres sont des gaps nommés
(UI mods v2, carte d'approbation, backends SSH/Daytona) qui exigent une décision
produit, pas une suppression d'audit.

### Action 3 — cycle runtime cassé

| Changement | Fichiers |
|---|---|
| `MAX_DELEGATION_DEPTH` extraite vers un module feuille | nouveau `agent/delegation-limits.ts` ; `fork-policy.ts` ; `background-delegations.ts` (réexport) |
| `buildSubAgentDelegationTool` injecté au lieu d'importé | nouveau type `DelegationToolBuilder` ; `swarm-runner.ts` ; `background-delegations.ts` |
| Arête `import type` remplacée par une interface structurelle | `events/renderer-sender.ts` |

Résultat mesuré : **2 SCC runtime → 1** (celui de `sandbox/`, volontaire et
documenté dans le code), et le SCC de 11 fichiers disparaît du graphe complet.

### Ce qui reste

- Trois gaps produits à arbitrer : UI déclarative mods v2, `MachineApprovalCard`,
  backends SSH/Daytona (§3.2).
- Trois cycles type-only (§5.4) — sans risque runtime, à traiter avec C4.
- La suite complète n'a pas été rejouée dans cette passe (une exécution a tourné
  **pendant** les éditions, résultat inutilisable) : la relancer avant merge.
