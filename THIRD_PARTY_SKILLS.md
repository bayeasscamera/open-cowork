# Skills tiers intégrés

Ce fichier inventorie tout code ou texte repris d'un dépôt externe, avec le
hash exact de commit, la licence, les fichiers repris et **la liste des
modifications apportées**. Apache-2.0 exige que les changements soient
signalés ; cette exigence est satisfaite ici et dans l'en-tête de chaque
fichier modifié.

> Les auteurs d'origine n'ont pas donne leur accord pour Cowork. Leur
> travail est repris sous leur licence, pas avec leur accord.

---

## 1. haowjy/creative-writing-skills

| Champ | Valeur |
|---|---|
| Dépôt | `https://github.com/haowjy/creative-writing-skills` |
| Commit épinglé | `0d5bf7fd987554e05db7e05d569736e648297722` |
| Date du commit | 2026-09-23 |
| Auteur | Jimmy Yao |
| Licence | Apache-2.0 (copiée dans chaque dossier de skill) |

### Fichiers repris

| Fichier d'origine | Destinataire | Modifications |
|---|---|---|
| `skills/creative-writing-muse/SKILL.md` | `.claude/skills/creative-writing-muse/SKILL.md` | Réécrit (voir §1.1) |
| `skills/writing-principles/SKILL.md` | `.claude/skills/writing-principles/SKILL.md` | Réécrit (voir §1.1) |
| `skills/writing-principles/resources/failure-modes.md` | idem | Aucun |
| `skills/writing-principles/resources/citations.md` | idem | Aucun |
| `cw/skills/llm-writing/SKILL.md` | `.claude/skills/llm-writing/SKILL.md` | Réécrit (voir §1.1) |
| `skills/creative-writing-craft/SKILL.md` | `.claude/skills/creative-writing-craft/SKILL.md` | Réécrit (voir §1.1) |
| `skills/creative-writing-craft/resources/prose-writing.md` | idem | Aucun |
| `skills/creative-writing-craft/resources/scene-construction.md` | idem | Aucun |
| `skills/creative-writing-craft/resources/style-analysis.md` | idem | Aucun |
| `skills/creative-writing-craft/resources/genre/*.md` (6 fichiers) | idem | Aucun |
| `skills/creative-writing-modes/SKILL.md` | `.claude/skills/creative-writing-modes/SKILL.md` | Réécrit (voir §1.1) |
| `skills/creative-writing-modes/resources/prose-modes.md` | idem | Aucun |
| `skills/story-review/SKILL.md` | `.claude/skills/story-review/SKILL.md` | Réécrit (voir §1.1) |
| `skills/story-review/resources/*.md` (7 fichiers) | idem | Aucun |
| `skills/story-review/resources/prose-critique/*.md` (7 fichiers) | idem | 3 modifiés (voir §1.1) |

**Non repris, volontairement :** `agents/`, `cw/skills/` (copie interne
dupliquée), `mars.toml`, `meridian.toml`, `.codex/`, `.githooks/`, `.github/`,
`.claude-plugin/`, `bootstrap/`, `scripts/`, `AGENTS.md`, `CLAUDE.md`,
`CHANGELOG.md` — configuration et outillage propres à d'autres outils ou
scripts d'empaquetage.

### §1.1 Modifications apportées

1. **`SKILL.md` réécrits en profondeur.** Les fichiers d'origine ne sont pas
   compatibles avec le chargeur de Cowork :
   - `description: >` (pliage YAML sur plusieurs lignes) n'est pas supporté par
     le parseur de Cowork (`skills-manager.ts`, regex
     `/description:\s*["']?([^"'\r\n]+)["']?/`) : il ne lit que la première
     ligne et remonterait la chaîne littérale `">"`. Les descriptions sont
     désormais sur **une seule ligne**, bilingues français + anglais.
   - L'invocation par `/nom-du-skill` est remplacée par une mention de rôle,
     le modèle active le skill par description.
   - Les renvois vers des skills absents de Cowork (`/intent-modeling`,
     `/information-hierarchy`, `/reader-sim`, `/character-sim`,
     `/shared-dao`, `/story-planning`, `/story-memory`, `/creative-research`)
     sont supprimés. Aucun skill intégré ne dépend d'un autre fichier.
   - Ajout d'une section de détection de langue et de chargement de
     `references/fr/` lorsque le texte est en français.
2. **Ajout de `references/fr/`** dans `writing-principles`,
   `creative-writing-craft`, `creative-writing-modes`, `story-review` et
   `stop-slop`. Contenu neuf, non présent en amont.
3. **`story-review/resources/prose-critique/analyze.py` retiré.** Le script
   exige un toolchain Python/`uv` que Cowork ne suppose pas. Aucun skill ne
   doit exiger un exécutable absent. Les trois fichiers qui le référençaient
   (`baseline.md`, `antipatterns.md`, `prose-critique.md`) ont été réécrits
   pour demander les mêmes métriques par lecture, via les outils habituels de
   Cowork.

---

## 2. hardikpandya/stop-slop

| Champ | Valeur |
|---|---|
| Dépôt | `https://github.com/hardikpandya/stop-slop` |
| Commit épinglé | `8da1f030185bdfe8471220585162991eaeb970e9` |
| Date du commit | 2026-03-18 |
| Auteur | Hardik Pandya |
| Licence | MIT (copiée dans le dossier du skill) |

### Fichiers repris

| Fichier d'origine | Destinataire | Modifications |
|---|---|---|
| `SKILL.md` | `.claude/skills/stop-slop/SKILL.md` | Réécrit (voir §2.1) |
| `references/phrases.md` | `.claude/skills/stop-slop/references/phrases.md` | Aucun |
| `references/structures.md` | `.claude/skills/stop-slop/references/structures.md` | Aucun |
| `references/examples.md` | `.claude/skills/stop-slop/references/examples.md` | Aucun |

**Non repris :** `README.md` (documentation du dépôt d'origine), `CHANGELOG.md`.

### §2.1 Modifications apportées

1. **Règle 6 (« No em dashes ») inversée pour le français.** Le tiret cadratin
   est banni en anglais parce qu'il y est un tic de génération ; en français il
   est **le tiret de dialogue** (`— Bonjour. —`). L'interdire casserait chaque
   dialogue. La règle porte désormais sur son usage comme ponctuation d'incise
   abusive, jamais dans un dialogue.
2. **Règle 1 (« Cut all adverbs ») atténuée.** Interdire tout adverbe est
   impraticable en français, où les adverbes en `-ment` sont courants et
   porteuses de sens. La cible devient l'**adverbe d'insistance creuse** en
   intensif automatique.
3. **Ajout de `disable-model-invocation: true`.** Le skill ne doit pas
   s'appliquer automatiquement : une passe trop mécanique abîme un texte déjà
   vivant. Il ne s'applique que sur demande explicite.
4. **Ajout d'un garde-fou de fidélité** : le skill ne modifie jamais le sens,
   les faits, le ton voulu ni la voix de l'auteur ; il signale son doute.
5. **Description bilingue** sur une seule ligne, et détection de langue.
6. **Ajout de `references/fr/`** : `tics-ia-fr.md`, `structures-fr.md`.
   Contenu neuf, construit pour le français.


---

## 3. pbakaus/impeccable

| Champ | Valeur |
|---|---|
| Dépôt | `https://github.com/pbakaus/impeccable` |
| Commit épinglé | `e103efe779e2dd01274dabae83531fef00bf2563` |
| Date du commit | 2026-10-03 |
| Auteur | Paul Bakaus |
| Licence | Apache-2.0 (copiée dans `.claude/skills/impeccable/LICENSE`) |

### Fichiers repris

| Fichier d'origine | Destinataire | Modifications |
|---|---|---|
| `.claude/skills/impeccable/SKILL.md` | `.claude/skills/impeccable/SKILL.md` | Aucun (description déjà monoligne et sans apostrophes) |
| `.claude/skills/impeccable/reference/*.md` | `.claude/skills/impeccable/reference/*.md` | Aucun |
| `.claude/skills/impeccable/scripts/*` | `.claude/skills/impeccable/scripts/*` | Aucun |
| `LICENSE` | `.claude/skills/impeccable/LICENSE` | Aucun |

---

## 4. vectorize-io/hindsight

| Champ | Valeur |
|---|---|
| Dépôt | `https://github.com/vectorize-io/hindsight` |
| Commit épinglé | `f7dd3f4fd7420f7beec60c32c965e5e5cf7be066` |
| Date du commit | 2026-10-02 |
| Auteur | Vectorize AI, Inc. |
| Licence | MIT (copiée dans `.claude/skills/hindsight-memory/LICENSE`) |

### Fichiers repris

| Fichier d'origine | Destinataire | Modifications |
|---|---|---|
| `hindsight-integrations/coding-agents/skill/SKILL.md` | `.claude/skills/hindsight-memory/SKILL.md` | Frontmatter adapté (description monoligne sans apostrophes) |
| `LICENSE` | `.claude/skills/hindsight-memory/LICENSE` | Aucun |

---

## 5. Vérification des licences

Les licences annoncées par les dépôts ont été lues dans les fichiers
`LICENSE` et correspondent aux exigences (Apache-2.0 et MIT).
Aucun écart, donc aucune interruption à ce titre.

```
Apache-2.0  — .claude/skills/{creative-writing-muse,writing-principles,
             llm-writing,creative-writing-craft,creative-writing-modes,
             story-review,impeccable}/LICENSE
MIT         — .claude/skills/{stop-slop,hindsight-memory}/LICENSE
```

---

## 6. Revue de sécurité

Voir `tests/creative-writing-skills-security.test.ts`, qui rejoue
automatiquement les contrôles décrits ci-dessous sur les fichiers intégrés.

| Contrôle | Résultat |
|---|---|
| Caractère de contrôle / largeur nulle / bidirectionnel | Aucun |
| Blob encodé (base64 et assimilés) | Aucun |
| Instruction d'ignorance d'instructions antérieures | Aucune |
| Instruction de masquage à l'utilisateur | Aucune |
| `curl` / `wget` / installation de paquet | Aucun |
| `subprocess` / `eval` / `exec` dans le seul script exécutable | Aucun |
| Exécutable externe requis par un skill | Aucun (script retiré) |
| URL | uniquement académiques : arXiv, ACL Anthology, DOI, PubMed — références bibliographiques, jamais des appels réseau |
| Mention « silently » | 3 occurrences, contexte bénin : « corriger sans en faire un drame » avec règle de prudence juste après. Faux positif. |
