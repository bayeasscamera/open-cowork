# État du projet — Mise à jour 2026-09-22

Complément à `PROJECT_OVERVIEW.md` (18/09/2026) et `PROJECT_STATUS_UPDATE.md` (19/09/2026).
Rédigé le **22/09/2026** à partir du code réel, de `git log`, de la base SQLite locale et de la
suite de tests — **pas** des rapports précédents. Branche : `fix/security-review-and-external-links`,
HEAD : `88afe98`. Build local installé le 22/09 : `/Applications/Open Cowork.app` (version 3.5.0).

### Écarts signalés avec les rapports précédents

- **Commits non poussés** : `PROJECT_STATUS_UPDATE.md` annonçait **16** commits locaux en attente ;
  l'état réel est **83** commits (branche 83 en avance sur `fork/fix/security-review-and-external-links`,
  0 en retard ; **156** en avance sur `origin/main`, 0 en retard).
- **Push vers `origin`** : le rapport précédent parlait d'un blocage « en attente d'authentification ».
  La cause réelle est une **permission refusée** : `git push --dry-run origin` renvoie
  `403 — Permission to OpenCoworkAI/open-cowork.git denied to bayeasscamera`. Ce n'est pas un problème
  de credentials mais de droits d'écriture sur le dépôt amont.
- **Skills** : le rapport précédent en listait 8 ; il y en a **9** — `i-have-adhd` (MIT, `178b50d`) est
  absent de sa liste.
- **ConfigSets** : l'affirmation « noms non lisibles » reste vraie (store chiffré), mais un export
  **lisible** existe désormais (`config.public.json`) et il **ne contient aucun ConfigSet** ; la seule
  référence exploitable est en base (`projects.config_set_id = set-6`).
- **WS5 à WS7** (« mission CC-gap ») : mentionnés uniquement dans `PROJECT_STATUS_UPDATE.md` ;
  aucune trace dans le code, les commits ou la roadmap → **non vérifiable**.
- **`PROJECT_OVERVIEW.md`** annonce les connecteurs Slack / Lark comme « en cours de développement » :
  le code existe déjà (`src/main/remote/channels/slack/`, `.../feishu/`) mais avec **0 % de couverture**.
- **Délégations détachées** : le message de commit `9df7247` dit « survivent à la fermeture ». Le code et
  les tests de reprise le confirment au niveau unitaire, mais **aucun test automatisé ne réalise un vrai
  cycle quit + restart** (voir « Points de vigilance »).
- **Build DMG** annoncé « fonctionnel » dans l'overview : confirmé le 22/09 (`release/Open Cowork-3.5.0-mac-arm64.dmg`, 273 Mo).

---

## Fonctionnalités livrées depuis la dernière mise à jour

> Statut utilisé : **testé en unitaire** = couvert par une suite Vitest ;
> **prouvé en conditions réelles** = exercé par une exécution réelle (run détaché, base live, build installé) ;
> **jamais vérifié visuellement** = aucun passage manuel/visuel de l'utilisateur.

### Fonctionnalité Projets (CRUD, contexte injecté, pipeline deux temps)

- **Quoi** : projets natifs regroupant les sessions autour d'un contexte de travail partagé (instructions,
  fichiers, workdir). CRUD complet : création, édition, archivage, **suppression définitive** et
  déplacement/retrait de sessions.
- **Où** : `src/main/projects/project-store.ts` (SQLite), `project-context.ts`
  (`resolveProjectContextForRunner`), injection dans `src/main/agent/agent-runner.ts:1056` et
  `:1707` (`systemPromptBlock`), tables `projects` / `project_context` / `project_files`.
  Commits `8202e7d` (groupement natif), `0b14948` (delete + move/remove), `0112c99` (fin d'impasse
  sur la suppression), `f7b7c57` (pages liste/détail), `e3f0b24` (pin d'un modèle précis).
- **Pipeline deux temps** : **implémenté et opt-in** — `src/main/projects/two-stage-pipeline.ts`,
  `pipelineMode === 'two-stage'` armé dans `agent-runner.ts:1079` (`twoStageArmed`), ConfigSets
  draft/refine distincts (`agent-runner.ts:1089-1096`). Commit `e61068c`.
- **État réel** : **testé en unitaire** (`project-store.test.ts`, `project-context.test.ts`,
  `project-context-usage.test.ts`, `projects-ui-actions.test.ts`, `projects-pipeline-ui.test.ts`) et
  **prouvé en conditions réelles** au niveau données (2 projets en base, `scripts/e2e-projects-proof.py`,
  commit `5739ff3`). **Jamais vérifié visuellement** par l'utilisateur.

### Interface dédiée Sous-agents

- **Quoi** : vue dédiée de premier niveau (même rang que les pages Projets) remplaçant la section de
  l'onglet API, avec badge de propositions en attente.
- **Où** : `src/renderer/components/subagents/SubAgentsView.tsx`, entrée sidebar
  (`Sidebar.tsx:312` et `:668`), route lazy (`App.tsx:52` et `:232`). Commits `a7b038c`, `ce16dae`.
- **État réel** : **testé en unitaire** (`subagents-view-navigation.test.ts`).
  **Doublon constaté** : le même composant est **aussi** rendu comme onglet Réglages
  (`SettingsPanel.tsx:308-311`, onglet `subagents`, commit `7523ebe`) → deux surfaces pour une seule vue
  (voir « Points de vigilance »). Jamais vérifié visuellement.

### Récursivité des sous-agents (profondeur 2, sémaphore global)

- **Quoi** : un sous-agent peut déléguer à son tour, avec une **profondeur maximale dure de 2**
  (agent principal 0 → sous-agent 1 → sous-sous-agent 2) et un **sémaphore global** partagé par le swarm,
  les délégations async et les enfants récursifs (un parent bloqué transfère temporairement son slot,
  donc pas d'interblocage).
- **Où** : `src/main/agent/background-delegations.ts:520` (`MAX_DELEGATION_DEPTH = 2`), `:523-524`
  (`subAgentGate`), `src/main/agent/sub-agent-gate.ts` (`SubAgentGate`), refus explicite au-delà du cap
  (`background-delegations.ts:1450`). Commits `2cc11ea`, `b9510b5`.
- **État réel** : **testé en unitaire** (`sub-agent-gate.test.ts` ; `background-delegation-resume.test.ts`
  couvre « skips depth-2 children » et le bornage des reprises). Artefacts réels présents
  (`background_delegations.json` contient des lignes `depth: 1`). Non vérifié visuellement.

### Vérification croisée (Zones 1/2/3 : sécurité, code, recherche)

- **Quoi** : trois passes de contradiction croisée, **strictement opt-in** :
  `reviewer_security` (Zone 1 — le reviewer et le security se challengent),
  `code_review` (Zone 2 — un point de revue substantiel déclenche **au plus une** ré-exécution ciblée du
  developer), `research` (Zone 3 — une passe unique croise tous les rapports de recherche parallèles et
  remonte les contradictions factuelles au lieu de les fusionner).
- **Où** : `src/main/agent/cross-verification.ts` (`CrossCheckKind`, `CROSS_VERIFICATION_COST` :
  `peerChallenge`, `codeReviewRerun`, `researchPass`), câblage dans `multi-agent-coordinator.ts` et
  `background-delegations.ts:1145`, coût affiché dans l'UI. Commits `2b68c7c`, `3f6873a`, `6170ae5`.
- **État réel** : **testé en unitaire** (`cross-verification.test.ts`,
  `multi-agent-cross-verification.test.ts`, `research-cross-verification.test.ts`). Le coût mesuré (~2,5x
  le chemin par défaut) justifie de **ne pas la généraliser** : un test de régression ajouté dans `88afe98`
  verrouille `crossVerification === false` par défaut et l'absence de `crossVerificationResults`.

### Délégations en arrière-plan détachées

- **Quoi** : une délégation s'exécute dans un **vrai processus détaché** (second instance Electron), avec
  fichier de résultat, log JSONL, kill du groupe de processus, polling par le parent, et reprise des
  tâches interrompues au redémarrage.
- **Où** : `src/main/agent/detached-delegation.ts` (`buildDetachedLaunchPlan`, `parseDetachedResult`,
  `killDetachedTree`, `readNewLogLines`), `background-delegations.ts` (`resumeInterruptedDelegations`,
  `ensureDetachedPolling`), appel au boot dans `src/main/index.ts:1483`. Réglages live
  (`delegation_settings.json`) : `detachedExecution: true`, `resumeOnRestart: true`,
  `detachedAutoApprove: false`, `maxConcurrent: 2`, `timeoutMs: 180000`. Commits `9df7247`, `57834d7`.
- **État réel** : **testé en unitaire / intégration** (`detached-delegation.test.ts` 9 tests,
  `background-delegation-detached.test.ts` 13 tests, `background-delegation-resume.test.ts` 8 tests) —
  le launcher est **injecté**, donc aucun vrai processus Electron n'est lancé en test. **Prouvé en
  conditions réelles** au niveau artefacts : `background_delegations.json` contient des lignes
  `detached: true` avec `pid` et `resultFile`. **La survie à la fermeture n'est pas prouvée par un E2E
  automatisé** (pas de test quit + restart réel).

### Binaire / CLI headless (`open-cowork`)

- **Quoi** : lanceur sans dépendances qui localise l'app installée (ou le checkout en dev) et la démarre
  en `--headless`, en relayant stdio/JSONL. Exposé en CLI via `bin` dans `package.json`.
- **Où** : `bin/open-cowork.mjs`, `src/main/cli/headless-io.ts`, `src/main/index.ts:840+`
  (`parseHeadlessArgs`, `--result-file`, `--auto-approve`). Commit `e4608eb`.
- **État réel** : **testé en unitaire** (`headless-cli.test.ts`, `headless-io.test.ts`,
  `headless-redaction.test.ts`, `headless-result-file.test.ts`). **Prouvé en conditions réelles** : le
  bundle installé le 22/09 contient bien `Contents/Resources/bin/open-cowork.mjs`. **Lien symbolique
  absent** : `/usr/local/bin` n'est pas inscriptible sans `sudo`, donc `open-cowork` n'est pas sur le PATH.

### Sécurisation multi-processus SQLite (WAL, busy_timeout, retry)

- **Quoi** : contrat multi-processus explicite (GUI + `--headless` + second lancement + délégations
  détachées partagent `cowork.db`) : WAL, `synchronous = NORMAL`, `busy_timeout = 5000` posés
  explicitement, puis **retry des verrous d'écriture** au niveau de la base (2 tentatives + backoff) et
  erreur typée `DatabaseWriteLockedError`.
- **Où** : `src/main/db/database.ts:277-287` (pragmas), `:530-611` (`isSqliteLockError`,
  `runWithWriteLockRetry`, `WRITE_LOCK_ATTEMPTS = 2`, `createLockResilientDatabase`). Commit `7ec6268`.
- **État réel** : **testé en unitaire** (`database-multi-process.test.ts`, `database-path-recovery.test.ts`)
  et **prouvé en conditions réelles** : la base live est bien en `journal_mode = wal`.
  **Réserves non résolues** : `DatabaseWriteLockedError` n'est **catchée nulle part** dans `src/`, et les
  migrations (`ensureColumn`) s'exécutent **avant** l'installation du wrapper resilient (voir ci-dessous).

### Génération / lecture d'images

- **Quoi** : outils natifs de **lecture vision** (image → description factuelle) et de **génération**
  d'image, avec détection du type MIME par magic bytes (jamais l'extension), plafond de taille,
  écriture dans `generated-images/`, estimation de coût **par image** et refus au-delà d'un seuil.
- **Où** : `src/main/agent/image-tools.ts` (`buildImageTools`), câblage
  `agent-runner.ts:131` et `:1732`. Commits `7e0dec1`, `549d8e4`.
- **État réel** : **testé en unitaire** (`image-tools.test.ts`, `config-image-generation.test.ts`,
  `image-tools-chat-render.test.ts`, `image-tools-ui.test.ts`). **Jamais vérifié visuellement**.

### Autres livraisons réelles depuis le 19/09 (hors liste demandée, mais présentes dans le dépôt)

- **Swarm : politique d'agrégation explicite + routage par criticité** (`88afe98`, 22/09) :
  `fail-all | partial-ok | retry-failed-only`, tâches bloquées marquées `skipped`, `partialSwarms` dans
  les stats, tiers `subAgents.criticality` (critique / économe) résolus **avant** le rôle et le ConfigSet
  (`swarm-runner.ts:122-169`). Testé en unitaire (5 suites).
- **Skills proposés par les sous-agents + validation humaine obligatoire** (`73c0ef7`, `22182c5`,
  `ff5cc78`, `ce16dae`, `2202b0a`) : remplace la création dynamique d'outils par l'agent, **retirée**
  (`535a582`).
- **Refactors de structure** : extraction des handlers IPC (`958db05`, `db1438f`, `ec04822`,
  `bb67d84`), mutualisation WSL/Lima (`c8d3206`, `4bee99f`, `59ccabc`), extraction de `agent-runner.ts`
  (`aee765a`, `27b0200`, `02162c6`, `0e15f2b`, `b8da791`), perf AST O(n²) (`95cdea3`),
  ratchets de couverture (`58daede`, `45fa827`, `ffa87ab`).
- **Sécurité / qualité** : audit de dépendances gaté et surface IPC durcie (`6388271`), redaction
  centralisée des secrets (`04ace94`), pi SDK isolé (`b9cbe57`).

### Audité mais volontairement reporté ou non retenu

- **Routeur de topologie** (DAG fixe vs fan-out simple vs solo) : **reporté** après stabilisation des
  points d'agrégation / criticité. `src/main/agent/openjev-router.ts` n'est **pas** un routeur de
  topologie : il ne fait qu'un _hint_ de besoin de swarm (`evaluateRoutingSignal`, `formatRoutingHint`).
- **Découpage de `run()`** (~2200 lignes) dans `agent-runner.ts` : **en attente de décision explicite**
  de l'utilisateur ; 5 grappes rentables ont été extraites, `run()` est resté intact.
- **Création dynamique d'outils par l'agent** : **non retenu** (surface d'exécution arbitraire) —
  remplacée par le circuit de propositions avec approbation humaine (`535a582`).
- **Suppression / re-création de fichiers mémoire** : hors périmètre (décision antérieure).
- **Garde-fou `config_write`** : allow-list volontairement restreinte.
- **WS5 à WS7** : non implémentés, et **non documentés ailleurs** que dans le rapport du 19/09.

---

## Commits en attente

**83 commits locaux non poussés** sur `fork/fix/security-review-and-external-links` (0 en retard sur le
fork ; **156** en avance sur `origin/main`, 0 en retard). Du plus récent au plus ancien :

| Commit    | Date       | Contenu                                                                                 |
| --------- | ---------- | --------------------------------------------------------------------------------------- |
| `88afe98` | 2026-09-22 | Agrégation explicite du swarm + routage des modèles par criticité                       |
| `b8da791` | 2026-09-22 | Extraction des hooks d'appel d'outils hors de l'agent runner                            |
| `0e15f2b` | 2026-09-22 | Extraction de la résolution des chemins de skills                                       |
| `02162c6` | 2026-09-22 | Extraction de la résolution des binaires bundled                                        |
| `27b0200` | 2026-09-22 | Extraction du pont d'outils MCP                                                         |
| `aee765a` | 2026-09-22 | Extraction des helpers de formatage de logs                                             |
| `6d27059` | 2026-09-22 | Tests des chemins d'erreur gateway et purge du rate-limit                               |
| `58daede` | 2026-09-22 | Ratchet des seuils de couverture                                                        |
| `53747eb` | 2026-09-22 | Extraction des wrappers d'outil bash                                                    |
| `59ccabc` | 2026-09-22 | Base commune de synchronisation VM (WSL/Lima)                                           |
| `fbe59d0` | 2026-09-22 | Tests de caractérisation du plan de contrôle gateway                                    |
| `45fa827` | 2026-09-22 | Ratchet des seuils de couverture                                                        |
| `c8d3206` | 2026-09-22 | Helpers de synchronisation partagés WSL/Lima                                            |
| `ffa87ab` | 2026-09-22 | Ratchet des seuils de couverture                                                        |
| `4657f65` | 2026-09-22 | Tests de sélection de mode et de délégation du sandbox                                  |
| `4bee99f` | 2026-09-22 | Surface d'exécution WSL/Lima mutualisée                                                 |
| `c0eb7c4` | 2026-09-22 | Harnais JSON-RPC + tests de caractérisation des bridges                                 |
| `abdb17b` | 2026-09-22 | Réduction de la surface d'export aux symboles référencés                                |
| `ec04822` | 2026-09-22 | Extraction des handlers IPC skills / window / mods / logs                               |
| `db1438f` | 2026-09-22 | Extraction des handlers IPC remote / schedule / memory                                  |
| `958db05` | 2026-09-22 | Extraction des handlers IPC de configuration                                            |
| `bb67d84` | 2026-09-22 | Extraction du dispatcher d'événements client et du thème de fenêtre                     |
| `22ad6f7` | 2026-09-22 | Suppression de logs de production, ratchet de couverture, docs                          |
| `95cdea3` | 2026-09-22 | Évite un scan AST en O(n²) et stabilise son test                                        |
| `b9cbe57` | 2026-09-22 | Isole les internes du SDK pi et extrait les handlers IPC MCP                            |
| `6388271` | 2026-09-22 | Gate l'audit de dépendances et durcit la surface IPC                                    |
| `9df7247` | 2026-09-22 | Délégations en processus détachés survivant au quit                                     |
| `57834d7` | 2026-09-22 | Reprise des tâches d'arrière-plan interrompues au redémarrage                           |
| `e4608eb` | 2026-09-22 | Lanceur headless packagé + bin `open-cowork`                                            |
| `7ec6268` | 2026-09-22 | Retry des verrous d'écriture SQLite entre processus                                     |
| `e61068c` | 2026-09-22 | Pipeline draft/refine en deux temps (opt-in)                                            |
| `549d8e4` | 2026-09-22 | Tout provider peut servir la lecture et la génération d'images                          |
| `7e0dec1` | 2026-09-22 | Outils natifs de lecture vision et de génération d'images                               |
| `6170ae5` | 2026-09-22 | Couvre tous les groupes de sujets de recherche + paraphrases sémantiques                |
| `3f6873a` | 2026-09-22 | Expose le coût de vérification croisée dans l'UI, groupe la recherche par sujet         |
| `2b68c7c` | 2026-09-22 | Phase de vérification croisée opt-in entre sous-agents                                  |
| `3fd39ec` | 2026-09-22 | Refonte de l'interface de réglages des projets                                          |
| `7523ebe` | 2026-09-22 | Restaure l'interface Sous-agents comme onglet des Réglages                              |
| `87f095a` | 2026-09-21 | Affiche le SHA et l'heure du build git dans les réglages généraux                       |
| `74e7790` | 2026-09-21 | Corrige l'interblocage FSEvents macOS qui bloquait chaque quit                          |
| `03ac08e` | 2026-09-21 | Resserre le code d'erreur d'approbation dans le skill doctor                            |
| `2202b0a` | 2026-09-21 | Sweep de démarrage : migration de `dynamic_skills` vers propositions                    |
| `ff5cc78` | 2026-09-21 | Section d'approbation des propositions dans la vue dédiée                               |
| `ce16dae` | 2026-09-21 | Badge live des propositions en attente dans la sidebar                                  |
| `22182c5` | 2026-09-21 | Approbation des propositions en conflit sous un répertoire renommé                      |
| `535a582` | 2026-09-21 | Retire la création dynamique d'outils ; skills via propositions                         |
| `73c0ef7` | 2026-09-21 | Skills proposés par sous-agent + validation humaine obligatoire                         |
| `b9510b5` | 2026-09-21 | Sémaphore global de hiérarchie sur le chemin swarm + coût cumulé                        |
| `a7b038c` | 2026-09-21 | Vue dédiée en sidebar remplaçant la section de l'onglet API                             |
| `d7d346a` | 2026-09-21 | Design system premium et navigation des réglages groupée                                |
| `60ccdbf` | 2026-09-21 | Refonte de l'onglet Général (résumé config, accès rapide, système, mods)                |
| `2cc11ea` | 2026-09-21 | Délégation récursive bornée, co-édition de doc, personas, routage OpenJev               |
| `ab5825c` | 2026-09-20 | Écran Sous-agents centralisé — 5 sections, composants partagés                          |
| `5c8046c` | 2026-09-20 | Sous-agents autonomes avec rapports structurés + vue de suivi                           |
| `42bdddd` | 2026-09-20 | Délégation asynchrone — sous-agents d'arrière-plan non bloquants                        |
| `e3f0b24` | 2026-09-20 | Pin d'un modèle précis dans le ConfigSet du projet ; picker partagé                     |
| `f7b7c57` | 2026-09-20 | Pages liste + détail dédiées remplaçant le flux en modale                               |
| `178b50d` | 2026-09-20 | Bundle du skill `i-have-adhd` (MIT, ayghri/i-have-adhd)                                 |
| `25f2d61` | 2026-09-20 | Hiérarchie sidebar à trois niveaux ; suppression de la barre de recherche               |
| `0112c99` | 2026-09-20 | Suppression définitive toujours découvrable (fin d'impasse)                             |
| `0b14948` | 2026-09-20 | Suppression définitive, move/remove de sessions ; input auto-extensible                 |
| `5739ff3` | 2026-09-20 | E2E projets : archive les projets de preuve obsolètes avant fermeture stdin             |
| `c6916e7` | 2026-09-19 | Persiste `sessions.project_id` dans `insertSession` (gap vu en E2E réel)                |
| `8202e7d` | 2026-09-19 | Projets natifs regroupant les sessions autour d'un contexte partagé                     |
| `839de18` | 2026-09-19 | Remplace le libellé ConfigSet par défaut non traduit par un libellé localisé            |
| `04ace94` | 2026-09-19 | Centralise la redaction des secrets (mod, logger, headless)                             |
| `45b6ac1` | 2026-09-19 | Ajout de `PROJECT_STATUS_UPDATE` (état factuel au 19/09)                                |
| `7d25d54` | 2026-09-19 | Mods en tête de l'onglet Skills ; remplace les drafts par `tender-and-funding-response` |
| `d5124c2` | 2026-09-19 | Système de mods à hooks locaux + panneau Diff + skill doctor                            |
| `c708082` | 2026-09-19 | Coût swarm mesuré dans la description d'outil ; preuve du chargement AGENTS.md          |
| `ad7d129` | 2026-09-19 | Idle timeout basé sur l'activité (remplace le timeout horloge murale)                   |
| `e0d3c77` | 2026-09-19 | Enregistre l'usage de tokens des sous-agents (mesure de coût)                           |
| `dc3d632` | 2026-09-19 | Instances de mesure parallèles via `COWORK_MULTI_INSTANCE`                              |
| `8d3af49` | 2026-09-19 | Plafond du contexte amont dupliqué + skip des rescans codegraph inchangés               |
| `4206136` | 2026-09-18 | Vérification syntaxique post-tâche ; drafts business                                    |
| `1ba6ae1` | 2026-09-18 | Skills `git-advanced-workflow` et `security-audit`                                      |
| `e89a54b` | 2026-09-18 | Mémoire causale : apprentissage des schémas d'échec terminal                            |
| `24b57bb` | 2026-09-18 | Ferme l'échappement symlink du confinement sous-agents                                  |
| `3811f97` | 2026-09-18 | Le bouton close quitte réellement + failsafe indépendant + raccourci sûr                |
| `191206b` | 2026-09-18 | Sélection de modèle par ConfigSet (avec migration du format legacy)                     |
| `e2a4d2c` | 2026-09-18 | UI de configuration des sous-agents avec test de persistance                            |
| `25bb26d` | 2026-09-18 | Masque les identifiants sur chaque événement stdout headless                            |
| `c5a31f6` | 2026-09-18 | Création de ConfigSets et persistance des réglages sous-agents sans creds               |

**Statut du push vers `origin` : TOUJOURS BLOQUÉ**, pour une raison de **droits** et non d'authentification :
`403 Permission to OpenCoworkAI/open-cowork.git denied to bayeasscamera` (vérifié le 22/09 par
`git push --dry-run origin`). Le travail local vit sur le fork `bayeasscamera/open-cowork`.

---

## Configuration actuelle

### ConfigSets

- **Non lisibles.** `~/Library/Application Support/open-cowork/config.json` est **chiffré** (fichier
  binaire, non UTF-8). Depuis `src/main/config/config-store.ts:820-846`, la clé stable est désormais une
  **clé aléatoire par installation protégée par le keyring OS** (`resolveStoreEncryptionKey`), plus des
  clés legacy dérivées en repli — donc non reconstructible depuis le dépôt.
- Un export **lisible** existe : `config.public.json`. Il contient `theme`, `provider`, `model`,
  `memoryEnabled`, `sandboxEnabled`, `trayEnabled`, `coworkInstructions`, etc. — **aucun ConfigSet**,
  aucun `subAgents`.
- Seule référence vérifiable en base : `projects.config_set_id = set-6` pour le projet « Baye Asse ».
  Le ConfigSet système par défaut reste `DEFAULT_CONFIG_SET_ID = 'default'` (schéma code).
- **Écart** : les noms de ConfigSets listés dans des rapports antérieurs ne sont **pas** vérifiables ;
  ce document ne les reprend donc pas.

### Modèles configurés par rôle de sous-agent

- **Non lisibles** (mêmes raisons). Le code ne définit **aucun** modèle par rôle en dur.
- Ordre de résolution réel (`src/main/agent/swarm-runner.ts:122-169`), après le commit `88afe98` :
  **tier de criticité dynamique** (`subAgents.criticality.critical` / `.economical`, si configuré et
  connu) → **surcharge par rôle** (`subAgents.perRole`) → **ConfigSet des sous-agents**
  (`subAgents.configSetId`) → **profil actif hérité**. Un `configSetId` inconnu retombe au niveau suivant
  avec un `logWarn`.
- Rôles définis : `architect`, `developer`, `reviewer`, `security`.
- Réglages de délégation live (`delegation_settings.json`) : `configSetId: default`, `timeoutMs: 180000`,
  `maxConcurrent: 2`, `detachedExecution: true`, `resumeOnRestart: true`.

### Modèles configurés par projet (lu en base SQLite, table `projects`)

- **« Baye Asse »** (`project-641a44ed-…`, workdir `/Users/bayeasssene/Documents/Moi`) :
  `config_set_id = set-6`, `config_model_id = NULL`, `pipeline_mode = NULL`.
- **« ABIO »** (`project-dc6cc9a2-…`, workdir `/Users/bayeasssene/Documents/ProjetsGithub/Plaateforme ABIO`) :
  `config_set_id` vide, `config_model_id = NULL`, `pipeline_mode = NULL`.
- **Écart** : il n'existe pas de projet nommé exactement « Asse » ; le projet réel est « Baye Asse ».
  Le **pipeline deux temps n'est activé sur aucun des deux projets** (`pipeline_mode` vide), donc jamais
  exercé en conditions réelles.
- Sessions : 1 rattachée à chaque projet, 15 sans projet.
- Profil actif réel (`config.public.json`) : `provider = custom`, `model = z-ai/glm-5.3-flash`
  (**écart** avec l'overview qui annonce Anthropic `claude-sonnet-4-6` comme défaut).

### Skills actifs dans `.claude/skills/` (9)

| Skill                         | Origine                       | Statut réel                                                                |
| ----------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| `docx`                        | Bundled (base)                | Présent, `SKILL.md` OK — jamais utilisé (voir note)                        |
| `pdf`                         | Bundled (base)                | Présent, `SKILL.md` OK — jamais utilisé                                    |
| `pptx`                        | Bundled (base)                | Présent, `SKILL.md` OK — jamais utilisé                                    |
| `xlsx`                        | Bundled (base)                | Présent, `SKILL.md` OK — jamais utilisé                                    |
| `skill-creator`               | Bundled (base)                | Présent, `SKILL.md` OK — jamais utilisé                                    |
| `git-advanced-workflow`       | Écrit localement (`1ba6ae1`)  | Présent, `SKILL.md` OK — jamais utilisé                                    |
| `security-audit`              | Écrit localement (`1ba6ae1`)  | Présent, `SKILL.md` OK — jamais utilisé                                    |
| `tender-and-funding-response` | Écrit localement (`7d25d54`)  | Présent, `SKILL.md` OK — **jamais testé en usage réel**                    |
| `i-have-adhd`                 | Bundled tiers MIT (`178b50d`) | Présent, `SKILL.md` OK — jamais utilisé ; `disable-model-invocation: true` |

- `skill-usage.json` ne trace **qu'un seul** skill utilisé, et c'est un skill **externe**
  (`~/.agents/skills/superpowers/using-superpowers/SKILL.md`). **Aucun des 9 skills bundled n'a d'usage
  enregistré.**

---

## Couverture de tests et qualité

- **Suite complète** (dernier run, 22/09) : **263 fichiers**, **2177 tests passés**, **2 ignorés**, **0 échec**.
  Le run de couverture correspondant est sorti en code 0.
- **Couverture globale mesurée** (`coverage/coverage-summary.json`, 22/09) :
  - Lignes : **57,99 %** (10 522 / 18 143)
  - Statements : **57,66 %** (10 982 / 19 043)
  - Fonctions : **65,97 %** (2 024 / 3 068)
  - Branches : **50,10 %** (6 078 / 12 130)
- **Seuils (ratchet `vitest.config.mts`)** : lignes 54, fonctions 62,5, branches 46, statements 54 —
  donc au-dessus des seuils, avec la marge de convention (~2,5-3 pts sous la baseline mesurée).
- **Zones les plus faibles (lignes %)** : `src/main/events` 7,4 ; `src/main/system` 23,5 ;
  `src/main/mcp` 26,0 ; `src/main/remote` 33,6 ; `src/main/session` 43,2 ; `src/main/tools` 52,1 ;
  `src/main/ipc` 53,4 ; `src/main/sandbox` 57,8.
- **Fichiers à 0 % ou quasi** : `agent/elite-coding-intelligence.ts` 0 % ;
  `remote/channels/feishu/feishu-channel.ts` 0 % ; `feishu-ws-client.ts` 0 % ;
  `remote/channels/slack/slack-channel.ts` 0 % ; `sandbox/native-executor.ts` 0 % ;
  `utils/shell-resolver.ts` 0 % ; `agent/agent-runner.ts` **5,56 %** (53/953) ;
  `mcp/software-dev-server-example.ts` 7,1 % ; `agent/auto-verification-loop.ts` 1,7 % ;
  `agent/self-healing-runner.ts` 4,0 %.
- **Le « reste » identifié** : il n'est stocké nulle part dans le dépôt (aucun fichier d'audit de
  couverture versionné). Les chiffres ci-dessus **sont** le reste mesuré à date ; le rapport du 19/09 ne
  publiait aucune couverture, donc c'est la première baseline chiffrée de la série de documents.
- **Angle mort qualité** : `tsconfig.json` a `include: ["src"]` et le script lint fait
  `eslint src --ext .ts,.tsx` → **`tests/` n'est ni typechecké ni linté** (il n'est couvert que par
  l'exécution Vitest).

---

## Ce qui reste non fait ou en pause

### Workstreams explicitement reportés

- **Routeur de topologie** (DAG fixe / fan-out parallèle simple / solo) : reporté après stabilisation de
  l'agrégation et de la criticité. Le seul composant de routage existant, `openjev-router.ts`, produit un
  _hint_ de complexité/need-swarm — il ne choisit **pas** de topologie.
- **Découpage de `run()`** (~2200 lignes) dans `agent-runner.ts` : en attente de décision explicite.
- **Connecteurs Slack / Feishu** : code présent et instancié (`remote-manager.ts:1167` et `:1189`),
  IPC `remote.updateFeishuConfig` présent, mais **0 % de couverture** et un seul test de canal
  (`stdio-channel.test.ts`) → livré mais non éprouvé.
- **Orchestration DAG inter-dossiers** pour refactorings massifs : ouvert (roadmap overview).
- **Moniteurs de quota / estimation fine des coûts par requête** : ouvert.
- **Vision multimodale sur snapshots en environnement de test** : partiellement livrée (lecture/génération
  d'images) ; aucun E2E de vision sur capture d'écran identifié.

### Audité et jugé non pertinent (ne pas reposer la question)

- **Push direct vers `origin`** : impossible (403, droits) — passer par le fork `bayeasscamera`.
- **Création dynamique d'outils par l'agent** : retirée volontairement ; passer par les propositions.
- **Suppression / re-création des fichiers mémoire** : hors périmètre.
- **Allow-list `config_write`** : volontairement restreinte.
- **WS5-WS7** : introuvables dans le dépôt → ne pas les traiter comme un backlog fiable.

### Limites connues non résolues

- **ConfigSets et modèles par rôle non auditables** hors exécution de l'app (store chiffré par clé keyring).
- **Mesure de tokens gateway** : la gateway locale peut rapporter `usage 0/0` ; les stats de swarm
  exposent `lastRunTokens` uniquement si le provider a réellement rapporté l'usage.
- **Harness SQLite (Vitest)** : alignement exact de l'ABI `better-sqlite3` requis entre Node CLI et
  Electron (`npm run rebuild`) ; l'app packagée fonctionne.
- **Sandbox Lima (macOS)** : exige `lima` installé si l'exécuteur natif est désactivé.
- **CLI headless non liée** : `open-cowork` n'est pas sur le PATH après installation (nécessite `sudo`).

---

## Points de vigilance

### Implémenté mais jamais vérifié visuellement

- **Vue Sous-agents** (`SubAgentsView.tsx`) — dans ses **deux** surfaces (vue dédiée et onglet Réglages).
- **Pages Projets** (liste, détail, picker de modèle, UI du pipeline deux temps).
- **Panneau Diff en direct**, **section Mods**, **rapport du Skill doctor** (hérités du rapport précédent,
  toujours non vérifiés).
- **Outils images** (rendu dans le chat, génération) — tests de rendu présents, aucun passage visuel.
- **Design system des Réglages** (`d7d346a`, `60ccdbf`).
- **CLI headless** en usage utilisateur réel (le binaire est présent dans le bundle, jamais lancé à la main).

### Risques résiduels toujours d'actualité

- **`ensureColumn` non protégée en multi-processus** : `initializeSchema(rawDb)` s'exécute
  (`database.ts:660`) **avant** `createLockResilientDatabase` (`:665`). Or `ensureColumn` fait
  `PRAGMA table_info` puis `ALTER TABLE ADD COLUMN` (`:490-524`) : deux processus qui démarrent ensemble
  (GUI + délégation détachée + headless) peuvent tous deux voir la colonne absente, et le second ALTER
  échoue en `duplicate column name` — erreur **non rattrapée** et **non retentée** (le retry ne couvre que
  `SQLITE_BUSY`/`SQLITE_LOCKED`).
- **`DatabaseWriteLockedError` jamais catchée** : levée à `database.ts:600`, aucune référence dans `src/`
  en dehors de sa définition ; seul `tests/database-multi-process.test.ts` la manipule. Un chemin d'écriture
  sous contention prolongée peut donc remonter une exception non gérée.
- **Survie à la fermeture des délégations détachées** : démontrée par le design (spawn `detached`, groupe
  de processus, reprise au boot) et par des tests à launcher injecté, mais **pas** par un E2E automatisé
  quit + restart.
- **Double/triple masquage de secrets** : mod `security-redactor` + logger (`b64a095`) + stdout headless
  (`25bb26d`, centralisé par `04ace94`) — les couches se recouvrent sur `sk-`/`ghp_` ; vérifier qu'aucune
  ne casse l'autre.
- **Deux chemins de compression mémoire** : `compressContext()` (sync) et `compressContextAsync()` (LLM)
  coexistent ; AGENTS.md impose le second quand l'async est disponible.
- **Codegraph : skip par fingerprint** (`8d3af49`) vs invalidation événementielle de
  `codegraph-indexer.ts` — un fingerprint trop agressif masquerait de vraies modifications.
- **Failsafe de fermeture (9 s)** vs cleanups longs : l'app peut quitter avant la fin du shutdown.
- **Fichier le plus risqué** : `src/main/agent/agent-runner.ts` — 953 lignes mesurées, 5,56 % de
  couverture, et `run()` (~2200 lignes) non découpé.

### Doublons ou conflits potentiels

- **Vue Sous-agents rendue deux fois** : `App.tsx:232` (vue dédiée) **et** `SettingsPanel.tsx:308-311`
  (onglet Réglages) instancient le **même** `SubAgentsView`. Les deux commits (`a7b038c` puis `7523ebe`)
  se contredisent sur l'emplacement attendu → clarifier la surface cible.
- **Trois mécanismes de sélection de modèle coexistent** : `subAgents.criticality` (dynamique, `88afe98`),
  `subAgents.perRole` (statique par rôle), et le pin projet (`config_set_id` / `config_model_id`,
  `e3f0b24`) plus le pipeline draft/refine. L'ordre de résolution est documenté côté swarm
  (`swarm-runner.ts:122-169`) mais **pas** côté exécution directe de session (`agent-runner.ts:1089-1096`).
- **Vérification croisée à deux endroits** : swarm (`peerChallenge`, `codeReviewRerun`) et délégations de
  recherche (`researchPass`) — coûts et déclencheurs distincts, à garder alignés.
- **Skills proposés vs skills bundled** : deux circuits d'ajout de skills (propositions approuvées vs
  `.claude/skills/`), avec un sweep de migration legacy au démarrage (`2202b0a`) — surveiller les doublons
  de répertoires lors des approbations en conflit (`22182c5`).
