# État du projet — Mise à jour 2026-09-19

Ce document est un complément à `PROJECT_OVERVIEW.md` (daté du 18/09/2026) : il reflète
l'état **réel** du dépôt à la date du jour, sur la branche `fix/security-review-and-external-links`.
Il est rédigé à partir du code, de l'historique git et des fichiers présents — pas des rapports
antérieurs. Là où un rapport précédent ne correspond plus au code réel, l'écart est signalé.

---

## Fonctionnalités livrées depuis le dernier overview

> Statut utilisé : **« testé en unitaire »** = couvert par une suite Vitest ;
> **« prouvé en conditions réelles »** = exercé via une exécution réelle de l'application
> (headless / mesure / build installé), pas seulement en test. Rien ci-dessous n'a été
> validé **manuellement/visuellement** par l'utilisateur (voir « Points de vigilance »).

### Sous-agents configurables (config par rôle, configSet distinct, fallback)
- **Quoi** : un sous-agent peut être pointé sur un `ConfigSet` dédié, avec surcharge
  par rôle et repli progressif. Résolution dans `swarm-runner.ts` (`resolveSubAgentProfile`) :
  **surcharge par rôle → ConfigSet des sous-agents → profil actif hérité** ; un `configSetId`
  inconnu retombe en héritage avec un warning.
- **Où** : `src/main/agent/swarm-runner.ts`, `src/main/config/config-store.ts`
  (`subAgents.perRole`, normalisation du format legacy), `src/renderer/components/settings/SettingsSubAgents.tsx`,
  commits `191206b`, `e2a4d2c`, `c5a31f6`, `a91a8cf`.
- **État réel** : **prouvé en conditions réelles** (les mesures de coût swarm ont utilisé ce
  chemin avec des ConfigSets distincts par rôle) ; la persistance + l'UI sont couvertes par
  `config-subagents.test.ts` et `settings-subagents-ui.test.ts`. Les 4 rôles définis :
  `architect`, `developer`, `reviewer`, `security`.

### Auto-vérification syntaxique post-tâche
- **Quoi** : après une tâche de sous-agent, le runner vérifie la syntaxe du code produit et
  relance une correction ciblée si besoin (`[role]:syntax-fix`).
- **Où** : `src/main/agent/swarm-runner.ts` (~lignes 785–800), commit `4206136`.
- **État réel** : **testé en unitaire** (`swarm-runner.test.ts`) et exercé lors des runs de
  mesure réels. Non validé visuellement par l'utilisateur.

### Mémoire causale (apprentissage des erreurs entre sessions)
- **Quoi** : `recordErrorPattern(pattern, rootCause, fix, context)` mémorise les schémas
  d'erreur récurrents ; les motifs sont réinjectés dans le prompt système via
  `formatErrorPatternsForContext` avant envoi au LLM.
- **Où** : `src/main/memory/memory-manager.ts` + appel dans `src/main/agent/agent-runner.ts`,
  commits `e89a54b` (schémas d'échec terminal) et `669f081` (mémoire causale initiale).
- **État réel** : code câblé dans le vrai agent-runner ; un incident réel a été enregistré
  (rapport précédent). Non re-vérifié ici.

### Mods locaux (telemetry, security-redactor, domain-loader, diff-panel)
- **Quoi** : système de *hooks* de fonctions locales (`CoworkMod` : `onPreToolUse`,
  `onPostToolUse`, `getContextAdditions`). 4 mods built-in :
  `telemetry` (log local, aucun réseau), `security-redactor` (masque `sk-`, `ghp_`, connexions
  DB, `api_key`…), `domain-loader` (charge `.cowork/domain-conventions.md` dans le prompt),
  `diff-panel` (snapshots avant/après des écritures).
- **Où** : `src/main/mods/mods-runtime.ts`, `src/main/mods/builtin-mods.ts`, câblés dans
  `src/main/index.ts` (~lignes 2448–2451), UI `SettingsMods.tsx`. Commit `d5124c2`.
- **État réel** : **prouvé en conditions réelles** (le bundle installé `d5124c2` contenait bien
  les canaux preload compilés, les labels des mods et le chunk renderer — vérifié lors de
  l'audit du commit `7d25d54`) ; couvert par `mods-runtime.test.ts` et `mods-ipc-contract.test.ts`.

### Panneau Diff en direct
- **Quoi** : sidebar latérale listant les fichiers modifiés d'une session avec compteur de
  lignes ajoutées/supprimées et diff inline (LCS borné, repli honnête sur fichiers > 2000 lignes).
- **Où** : `src/renderer/components/DiffPanel.tsx` (lazy-loaded + toggle dans `App.tsx`),
  alimenté par le mod `diff-panel` via le canal IPC `diff.getSessionFiles`.
- **État réel** : code et UI présents, **jamais vérifié visuellement par l'utilisateur**
  (voir « Points de vigilance »).

### Skill doctor
- **Quoi** : analyse locale du coût de contexte des skills chargés (`/skill doctor`), rapport
  structuré avec tailles/estimations.
- **Où** : `src/main/mods/skill-doctor.ts` (`buildSkillDoctorReport`), UI
  `SettingsSkillDoctor.tsx`, canal `mods`/doctor dans `index.ts`.
- **État réel** : testé en unitaire ; rapport non vérifié visuellement par l'utilisateur.

### Skills actuels dans `.claude/skills/`
| Skill | Statut | Note |
|-------|--------|------|
| `docx` | Finalisé (bundled) | Fourni avec la base, présent depuis le 11/09 |
| `pdf` | Finalisé (bundled) | idem |
| `pptx` | Finalisé (bundled) | idem |
| `xlsx` | Finalisé (bundled) | idem |
| `skill-creator` | Finalisé (bundled) | idem |
| `git-advanced-workflow` | Finalisé (écrit localement) | Commit `1ba6ae1` (18/09) — rework d'historique, recovery (reflog/bisect), hotfix |
| `security-audit` | Finalisé (écrit localement) | Commit `1ba6ae1` (18/09) — audit dépendances, secrets, injection, IPC |
| `tender-and-funding-response` | **À valider par toi** | Commit `7d25d54` (19/09) — assistant généraliste appels d'offres / dossiers de financement / documents formels. **Remplacé** les 2 brouillons `dahira-admin-assistant` et `funding-dossier` (qui n'existaient que depuis `4206136` et n'ont jamais été utilisés). Jamais testé en usage réel. |

### Optimisations Phase 4
- **Quoi** : (a) plafonnement du contexte amont dupliqué (`capDepContext`) et (b) skip des
  rescans codegraph inchangés via *fingerprint* — `perf(swarm)`.
- **Où** : `src/main/agent/swarm-runner.ts` + codegraph (cache disque), commits `8d3af49`,
  `1ade141` (ignore du cache runtime dans git).
- **État réel** : exercé lors des runs de mesure réels ; la réduction de coût mesurée
  (rapport précédent) n'est pas re-vérifiée ici.

### Corrections de bugs critiques
- **Fermeture d'app** : `3811f97` — le bouton de fermeture quitte réellement l'app, avec un
  failsafe indépendant de 9 s, `trayEnabled` par défaut à `false` et raccourci `Cmd+Alt+Space`.
  (Suite de `d4b80f7` et `a3b1c3c`.)
- **Fuite / exposition de clés API** : le mod `security-redactor` + `25bb26d` (masquage des
  identifiants sur **chaque** événement stdout headless). Le garde-fou `security-redactor`
  **double** le masquage déjà fait dans `b64a095` au niveau du logger (voir « Points de vigilance »).
- **Confinement sous-agents** : `24b57bb` — fermeture de l'échappement par symlink dans le
  confinement du workspace des sous-agents.

---

## Commits en attente

16 commits locaux non poussés (branche `fix/security-review-and-external-links`, 16 en avant
du fork `bayeasscamera/open-cowork` ; **0/89** vs `origin/OpenCoworkAI`). Push vers `origin`
toujours bloqué (action utilisateur non résolue). Liste du plus récent au plus ancien :

| Commit | Contenu |
|--------|---------|
| `7d25d54` | UI : section Mods en tête de l'onglet Skills ; remplace les drafts business par `tender-and-funding-response` |
| `d5124c2` | Système de mods à hooks locaux + panneau Diff en direct + skill doctor |
| `c708082` | Mesure du coût swarm dans la description d'outil ; preuve du chargement natif AGENTS.md |
| `ad7d129` | Idle timeout basé sur l'activité (remplace le timeout de tâche à l'horloge murale) |
| `e0d3c77` | Enregistrement de l'usage de tokens des sous-agents (mesure de coût) |
| `dc3d632` | Instances de mesure parallèles via `COWORK_MULTI_INSTANCE` |
| `8d3af49` | Plafond du contexte amont dupliqué + skip des rescans codegraph inchangés |
| `4206136` | Vérification syntaxique post-tâche ; (drafts business — aujourd'hui remplacés) |
| `1ba6ae1` | Skills `git-advanced-workflow` et `security-audit` |
| `e89a54b` | Mémoire : apprentissage des schémas d'échec terminal (continuité inter-sessions) |
| `24b57bb` | Sécurité : ferme l'échappement symlink du confinement sous-agents |
| `3811f97` | Fermeture : le bouton close quitte réellement + failsafe indépendant + raccourci sûr |
| `191206b` | Swarm : sélection de modèle par ConfigSet (avec migration du format legacy) |
| `e2a4d2c` | UI des paramètres sous-agents (avec test de persistance) |
| `25bb26d` | Sécurité : masque les identifiants sur chaque stdout headless |
| `c5a31f6` | RPC : création de ConfigSets + persistance des réglages sous-agents sans exposer de creds |

---

## Configuration actuelle

### ConfigSets
- **Schéma (dans le code)** : `ApiConfigSet { id, name, provider, profiles, activeProfileKey, … }`.
  Le ConfigSet système est `DEFAULT_CONFIG_SET_ID = 'default'`, dont le nom par défaut est
  « 默认方案 » (libellé chinois hérité). La config sous-agents (`subAgents`) porte
  `configSetId`, `modelId`, et `perRole { architect, developer, reviewer, security }`,
  chacun avec `{ configSetId, modelId }`.
- **Ordre de résolution du modèle sous-agent** (`swarm-runner.ts`) : surcharge par rôle →
  ConfigSet des sous-agents → profil actif hérité.
- ⚠️ **Écart signalé** : les **noms réels** des ConfigSets et modèles configurés sont stockés
  dans le store chiffré `electron-store` (`~/Library/Application Support/open-cowork/config.json`),
  **non lisible depuis le dépôt** (fichier encodé/binaire, non UTF-8). Les rapports précédents
  listaient des noms de ConfigSets ; **ces noms ne sont pas vérifiables** à partir du code ni
  du store chiffré. Seule la structure est confirmée ici.

### Modèles configurés par rôle de sous-agent
- Identique : valeurs runtime dans le store chiffré, non extractibles hors exécution de l'app.
  Le code ne définit pas de modèles par rôle en dur ; tout passe par la résolution ConfigSet ci-dessus.
  Si tu veux la liste exacte, il faut la lire dans l'UI Paramètres → Sous-agents (ou exporter la config).

---

## Ce qui reste non fait ou en pause

### Workstreams en attente
- **WS5 à WS7** de la mission CC-gap (objectif : rattraper/gap avec Claude Code) — non implémentés.
- Items de la roadmap de `PROJECT_OVERVIEW.md` toujours ouverts : orchestration DAG inter-dossiers
  pour refactorings massifs ; connecteurs Slack / Lark (Feishu) ; enrichissement vision multimodale
  sur snapshots en environnement de test ; moniteurs de quota/estimation fine des coûts par requête.

### Audité et jugé non pertinent (ne pas reposer la question)
- **Push vers `origin` (OpenCoworkAI)** : bloqué, en attente d'une action utilisateur (authentification).
  Le travail local vit sur le fork `bayeasscamera`.
- **Suppression/re-création de fichiers mémoire** : volontairement hors périmètre (décision antérieure).
- **Garde-fou `config_write` (allow-list RPC)** : délibérément restreint à un petit ensemble de clés.

### Limites connues et non résolues
- **Instrumentation / mesure de tokens** : la gateway locale actuelle rapporte `usage 0/0`
  (mesure dépendante du fournisseur) — le coût swarm mesuré est fiable, mais pas la décomposition
  par token côté gateway. Non résolu.
- **Harness SQLite (Vitest)** : alignement exact de l'ABI `better-sqlite3` requis entre Node CLI
  et Electron (`npm run rebuild`) ; l'app packagée tourne en production sans problème.
- **Sandbox Lima (macOS)** : exige `lima` installé sur l'hôte si l'exécuteur natif est désactivé.

---

## Points de vigilance

### Implémenté mais jamais vérifié visuellement / manuellement par toi
- **Panneau Diff en direct** (`DiffPanel.tsx`, bascule dans `App.tsx`) — code + câblage présents,
  aucun passage visuel utilisateur.
- **Section Mods** de l'onglet Skills — vérifiée dans le bundle compilé (audit `7d25d54`), pas
  validée à l'œil par l'utilisateur.
- **Rapport du Skill doctor** — non affiché/vérifié manuellement.
- **UI des sous-agents / ConfigSets** (paramètres) — testée en unitaire, non inspectée visuellement.
- **Viewer mémoire** (parcourir/restaurer les fichiers mémoire) — build présent, non validé manuellement.

### Doublons ou conflits potentiels
- **Double masquage de secrets** : `security-redactor` (mod) **et** le masquage logger existant
  (`b64a095`) + stdout headless (`25bb26d`). Les couches se complètent, mais il faut s'assurer
  qu'aucune ne casse l'autre (deux regex se chevauchent sur `sk-`/`ghp_`).
- **Deux chemins de compression mémoire** : `compressContext()` (synchrone) et
  `compressContextAsync()` (LLM) coexistent — veiller à utiliser le second partout où le contexte
  async est disponible (AGENTS.md le rappelle).
- **Codegraph : cache + skip fingerprint** — le skip de rescan (`8d3af49`) doit rester cohérent
  avec l'invalidation événementielle de `codegraph-indexer.ts` ; un fingerprint trop agressif
  pourrait masquer de vraies modifications.
- **Failsafe de fermeture (9 s)** vs nettoyage long : si un cleanup dépasse le failsafe, l'app
  quitte avant la fin du shutdown — comportement assumé mais à surveiller.