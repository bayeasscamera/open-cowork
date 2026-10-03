# Phase 0 — Découverte : mods, artifacts, salles

Branche : `fix/security-review-and-external-links`. Toutes les affirmations ci-dessous ont
été vérifiées dans le code de cette branche, pas déduites des rapports d'état.

---

## 1. `mods-runtime.ts` aujourd'hui

`src/main/mods/mods-runtime.ts` (171 lignes) expose **trois** crochets, tous **synchrones** :

| Crochet | Signature | Effet |
|---|---|---|
| `onPreToolUse` | `(call) => {block?, reason?}` | Premier `block` gagne, court-circuit la chaîne |
| `onPostToolUse` | `(call, result) => {replaceContent?}` | **La dernière** réécriture gagne |
| `getContextAdditions` | `(cwd) => string` | Ajout au prompt système |

`ModsRegistry` (l.60) tient un `Map<string, CoworkMod>`, un `electron-store` `mods-config`
pour `{enabled: Record<string,bool>}`, et `isEnabled()` renvoie `enabled !== false`
— **activé par défaut** si absent du store.

### Branchements réels

- `src/main/index.ts:123` importe `getModsRegistry` ; `index.ts:2238-2241` enregistre
  `createBuiltinMods()` dans le singleton.
- `src/main/ipc/mods-handlers.ts:17,29` — IPC `mods` list / setEnabled.
- `src/main/agent/agent-hooks.ts` — **deux** chemins distincts (voir §2).

## 2. Points d'extension dans `agent-runner.ts` et son pipeline

`agent-runner.ts` fait 2285 lignes. Points où une capacité将来 peut s'insérer :

| Point | Emplacement | Déjà câblé ? |
|---|---|---|
| Prompt système | `runtime-config-summary.ts:109` `buildCoworkAppendPrompt` | **Non pour les mods** |
| `setBeforeToolCall` (appel d'outil) | `agent-hooks.ts:150` `installPermissionHook` | Oui — gate partagée |
| Résultat d'appel d'outil | `agent-hooks.ts:259` `setAfterToolCall` | Oui — `runPostToolUse` |
| Compaction | `agent-runner.ts:2185` `compact()` | Non |
| Fin de session | `pi-session-lifecycle.ts` | Non |

Les commits `b8da791` (crochets d'outils) et `27b0200` (pont MCP) ne sont **pas**
des points d'extension mods : ce sont des installations de hooks sur le SDK pi.

### Constat 1 — les hooks de mods tournent en double sur le chemin SDK

`setBeforeToolCall` est un **slot unique**. L'ordre d'installation est
`create-pi-session.ts:155-156` :

```
deps.installPermissionHook(piSession);   // installe runToolGate
deps.installModsHooks(piSession);        // capture le hook précédent et s'enchaîne
```

`installModsHooks` (`agent-hooks.ts:248`) appelle `runPreToolUse` **puis** délègue au hook
capturé — qui est `installPermissionHook`, lequel appelle `runToolGate`, dont le stage 5
(`pipeline.ts:236`) est `runModsPre` → **deuxième** `runPreToolUse`.

Ordre effectif réel d'un appel SDK :

```
runPreToolUse  →  validate → allow-list → permission → machine-access → path-guard → runPreToolUse
```

Aucun mod intégré ne réécrit d'`args`, donc le double passage est aujourd'hui **inobservable**.
Mais c'est une divergence structurelle, pas une propriété.

### Constat 2 — les mods passent **après** `assessRisk`

`pipeline.ts` : machine-access au stage 3b (l.200), mods au stage 5 (l.236). Un mod qui
réécrit les `args` d'un appel **n'est pas réévalué** par `assessRisk`/`assessMachineAccess`.
C'est exactement l'écart que la partie A doit fermer (carte = action **finale**).

### Constat 3 — `getContextAdditions` n'a **aucun consommateur**

Recherche sur tout `src/` : seuls `mods-runtime.ts` et `builtin-mods.ts` le mentionnent.
La contribution de `domain-loader` au prompt est du **code mort**. `onContextBuild`
n'existe donc pas — il reste à câbler dans `buildCoworkAppendPrompt`.

## 3. Structure du renderer

`src/renderer/components/` — 40+ composants. Repères :

- `Sidebar.tsx` — barre latérale principale.
- `MessageCard.tsx` + `MessageMarkdown.tsx` — rendu des messages.
- `ContextUsageBar.tsx` — barre d'usage de contexte (≈ barre d'état).
- `DiffPanel.tsx` — panneau de diff existant, chargeable à la demande.
- `PanelDock.tsx` — docking des panneaux.
- `ArtifactModal.tsx` (173 l.) — lit **un fichier** via `electronAPI.artifacts.readFile`.
  Ce n'est **pas** un artifact persistant : pas de base, pas de version.

Emplacements d'interface réalistes pour les mods : `Sidebar` (entrée), `ContextUsageBar`
(rangée d'état), `MessageCard` (actions), `PanelDock` (panneau), onglet réglages.

## 4. Circuit de propositions

`src/main/skills/skill-proposals.ts` (361 l.). Invariant documenté l.11 :

> « stays INACTIVE until a human explicitly approves it in the Skill doctor »

API : `proposeSkill`, `listProposals`, `approveProposal` (avec `renameTo`), `rejectProposal`,
`validateProposalSlug`, `validateProposalContent`. L'approbation est un **déplacement de
fichier** du dossier `proposals/` vers le dossier actif.

**Réutilisabilité : limitée.** Le modèle est mono-type (contenu markdown, clé = slug) et
l'approbation est un `move` de fichier. Un mod (manifeste + code + hash épinglé) et un
artifact (contenu + versions) ne rentrent pas dedans sans généralisation.

## 5. Swarm et délégations

`src/main/agent/background-delegations.ts` :

- `subAgentGate = new SubAgentGate(maxConcurrent)` l.626 — **sémaphore global partagé**
  entre swarm **et** tous les niveaux de délégation.
- `DEFAULT_DELEGATION_SETTINGS.maxConcurrent = 2` (l.196), borné à `[1,4]` (l.410).
- `MAX_DELEGATION_DEPTH = 2` (l.623), contrôlé l.639 et l.1604.
- Reprise : `resumedFrom` / `resumedBy` (l.143-146), `resumeInterruptedDelegations`,
  **une** tentative de reprise par tâche (l.90).

Fichiers : `swarm-runner.ts`, `swarm-criticality.ts`, `swarm-stats.ts`,
`cross-verification.ts`, `detached-delegation.ts`, `subagent-extension.ts`.

## 6. Protections du renderer

- `index.ts:700-704` : `contextIsolation: true`, `sandbox: true`.
- **Aucune CSP** n'est posée sur la fenêtre (recherche `content-security-policy` : 0 résultat).
- **Aucun protocole personnalisé** enregistré (`protocol.register*` : 0 résultat).
- Le pont est `src/preload/index.ts` via `contextBridge`, canaux déclarés.

---

## Préconditions vérifiées

- `ensureColumn` : **déjà corrigé**. `runSchemaMigrations` (`database.ts:326`) encapsule le
  schéma dans `BEGIN IMMEDIATE` avec `runWithWriteLockRetry` ; `busy_timeout = 5000`
  (l.300). Aucun correctif requis.
- `assessRisk()` + cartes d'approbation : existent (`machine-access/risk-assessor.ts`,
  `MachineApprovalCard.tsx`, `PermissionDialog`).
- `invokeTool()` + registre : existent (`tools/invoke.ts`, `tools/registry.ts`).
- i18n : `src/renderer/i18n/locales/`.

## Hypothèses et points non tranchés

1. **`ArtifactModal` n'est pas un artifact persistant** — à confirmer avec l'utilisateur
   s'il faut le remplacer ou le garder comme vue « fichier ».
2. **Aucun `workflow_dispatch`** : la CI ne tourne que sur `main`/`dev` (voir `ci.yml`).
   Sans effet sur ce travail, mais toute vérification Windows reste hors de portée ici.
3. Le magasin chiffré et `i18n` à trois langues (`en`/`fr`/`zh`) sont cités par la mission ;
   `zh.json` n'a pas été vérifié dans cette phase.
4. Les bandes (`system`/`org`/`user`) n'existent pas : à créer.