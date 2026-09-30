# Spec — Restauration de l'espace de travail au lancement

**Statut** : spécification — **aucune implémentation**. Les décisions produit
listées en §5 doivent être tranchées avant toute écriture de code.
**Date** : 2026-02 · **Commit de référence** : `b353cd1`

> Fichier placé à la racine du dépôt : le répertoire `docs/` est ignoré par
> `.gitignore` (ligne 70), donc une spec écrite là-bas n'aurait pas pu être
> commitée.

---

## 1. Contexte (établi par audit du code, pas supposé)

Faits relevés dans le code à la date du document :

| Fait | Source |
|---|---|
| **Le store renderer n'a aucune persistance** — ni `persist()`, ni `localStorage` | `src/renderer/store/index.ts` (0 occurrence) |
| `activeSessionId` est initialisé à `null` à chaque démarrage | `store/index.ts:322` |
| Le lancement appelle `listSessions()` (événement `session.list`), qui remplit `sessions` mais **n'active rien** | `App.tsx:149` → `useIPC.ts:826` |
| `removeSessions` remet correctement `activeSessionId` à `null` si la session supprimée était active (logique vérifiée par exécution — **pas de bug**) | `store/index.ts:442` |
| `localStorage` n'est utilisé que par i18next (`i18nextLng`) | `src/renderer/i18n/config.ts` |
| La mise en page est portée par des drapeaux mémoire (`sidebarCollapsed`, `diffPanelVisible`, `documentPanelVisible`, `planPanelVisible`…) | `store/index.ts:147-154` |
| La langue est déjà persistée et restaurée (i18next + `changeLanguage`) | `SettingsGeneral.tsx:222` |

**Conséquence** : au redémarrage, l'application affiche toujours le dashboard
vide, alors même que les sessions existent en base. C'est le problème visé ici.
La langue est le seul élément d'UI déjà restauré — c'est le précédent à suivre.

---

## 2. Objectif

Au lancement, restaurer la **session active** (et, selon §5, son contexte de
panneaux) pour retrouver son espace de travail sans le ressélectionner à la main.

**Hors périmètre** : le fil de conversation (déjà rechargé par
`getSessionMessages` une fois la session active) et la reprise de tâches de fond
(déjà couverte par `delegation_settings.resumeOnRestart`).

---

## 3. Découpage proposé (du plus petit au plus risqué)

### Lot 1 — Persistance minimale de la session active
- Persister **uniquement** `activeSessionId` (un module `workspace-persist.ts`
  s'appuyant sur `localStorage`, même mécanisme que `i18nextLng`).
- Au bootstrap : lire la valeur et **ne l'appliquer que si la session existe**
  dans le `session.list` reçu ; sinon retour silencieux au dashboard.
- Le snapshot ne contient **aucun contenu de conversation**, seulement un id.

### Lot 2 — Persistance du contexte de panneaux
- Persister le bloc de drapeaux de mise en page (`sidebarCollapsed`,
  `documentPanelVisible`, `diffPanelVisible`, `planPanelVisible`,
  `controlCenterVisible`, `modelRoutingVisible`, `memoryPanelVisible`).
- **Règle** : ne jamais restaurer un panneau *session-scoped* sans session
  restaurée — même invariant que le gating déjà livré dans
  `workspace-panel-toggles.ts` et le menu applicatif.

### Lot 3 — (optionnel) Suggestion de session, pas restauration
- Si rien n'a pu être restauré, mettre en avant la dernière session utilisée
  dans le dashboard au lieu de la rouvrir automatiquement.

---

## 4. Conception technique (à confirmer)

**Module de persistance** — `src/renderer/utils/workspace-persist.ts` :
```
loadWorkspace(): WorkspaceSnapshot | null   // parse + validation par gardes
saveWorkspace(snapshot: WorkspaceSnapshot): void  // try/catch, no-op si indisponible
```
- Validation stricte à la lecture : un JSON corrompu, ou un snapshot de version
  inconnue, est **ignoré silencieusement** (retour au défaut) — jamais fatal au
  démarrage.
- Écriture **différée** (debounce ~300 ms) pour ne pas écrire à chaque frame
  pendant le scroll.
- `WorkspaceSnapshot` est une interface explicite ; aucun `any` ; rétrécissement
  par gardes (`typeof === 'string'`, `typeof === 'boolean'`) conformément aux
  règles du projet.

**Point d'intégration** — le bootstrap `useIPC` (là où la config est déjà
hydratée, avec un `try/catch` isolé par réglage, sur le modèle appliqué au
réglage `notifyOnCompletion`) :
- lire le snapshot au démarrage ;
- appliquer `activeSessionId` **après** réception de `session.list`, si l'id
  existe dans la liste ;
- invalider le snapshot si la session a été supprimée (garde déjà présente dans
  `removeSessions`).

**Robustesse / sécurité** : snapshot limité à des ids et booléens (aucune donnée
sensible), pas de contenu de session, pas de commande shell, pas de nouveau canal
IPC.

---

## 5. Décisions produit à trancher (bloquantes)

Ces quatre points n'ont pas de réponse évidente et changent le comportement
observable. Ils ne peuvent pas être tranchés à l'implémentation.

1. **Quand une session restaurée est-elle « safe » à rouvrir ?**
   Une session `running`/`busy` au moment de la fermeture : le Lot 1 doit-il
   vérifier `status` avant de la rouvrir ?

2. **Cycles de travail multiples** — l'utilisateur travaille souvent plusieurs
   sessions en parallèle.
   - Restauration inconditionnelle de la dernière, ou
   - proposition non intrusive (« Reprendre : <titre> ? ») avec confirmation ?

3. **Périmètre du Lot 2** — restaurer les panneaux est-il souhaitable, ou se
   limiter à la session seule pour éviter les surprises d'UI au démarrage
   (retrouver la fenêtre avec un diff ouvert qu'on ne cherche pas) ?

4. **Support de stockage** — `localStorage` (simple, effaçable, non chiffré) ou
   le `config-store` du processus principal (fichier maîtrisé, mais IPC et cycle
   de vie plus lourds) ?

---

## 6. Stratégie de tests (si la spec est validée)

- **Comportementaux** : le module de persistance est pur (entrée/sortie
  explicite) → tests unitaires sans environment : round-trip, snapshot corrompu
  ignoré, version inconnue rejetée, garde de type sur chaque champ.
- **Intégration** : appliquer un snapshot dont la session n'existe plus dans
  `session.list` → aucun crash, retour au dashboard.
- **Non-régression** : les invariants déjà couverts (gating session des
  panneaux, raccourcis ⌘/Ctrl+1..7, menu localisé) doivent rester verts ; aucun
  panneau ne doit se restaurer sans session active.

---

## 7. Pourquoi cette spec n'est pas implémentée dans ce commit

Le Lot 1 est de faible difficulté technique, mais son comportement observable
(session restaurée automatiquement vs. proposée) relève d'un choix produit, et
le Lot 3 modifie l'écran d'accueil. Ces décisions sont soumises avant d'écrire
du code.
