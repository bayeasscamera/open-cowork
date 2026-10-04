# Écrire de la fiction avec Cowork

Guide court. Sept skills d'écriture, adaptés au français, dans
`.claude/skills/`.

## Installation

Rien à installer. Les skills sont déjà dans `.claude/skills/`. Ils sont
chargés à chaud : pas besoin de redémarrer l'app après un ajout.

Pour les voir dans les réglages : **Settings → Skills**.

## Quel skill pour quoi

| Tu veux… | Skill |
|---|---|
| Rédiger de la prose, une scène, un chapitre | `creative-writing-modes` |
| Savoir *pourquoi* une scène sonne plate | `writing-principles` |
| Écrire ou réviser un texte soigné | `llm-writing` |
| Technique : scènes, style, genre | `creative-writing-craft` |
| Relire un texte existant (5 niveaux) | `story-review` |
| Tout faire soi-même, sans sous-agent | `creative-writing-muse` |
| Polir un texte | `stop-slop` — **sur demande explicite** |

Ils se combinent. Le plus courant : `writing-principles` pour comprendre ce qui
ne va pas, puis `creative-writing-modes` pour écrire, puis `story-review` pour
relire.

## Trois choses à savoir avant de commencer

**1. Le tiret « — » n'est pas un tic.** En anglais c'est une trace de génération
de texte ; en français c'est **le tiret de dialogue**. `— Bonjour. —` est
correct. Aucune passe ne le supprimera.

**2. `stop-slop` ne se déclenche jamais tout seul.** Il faut le demander
explicitement (« polys ce texte »). Une relecture automatique abîme un texte
déjà vivant, parce qu'elle ne voit pas ce qui est voulu.

**3. Les listes de tics sont des candidats, pas des lois.** La liste des
tournures creuses vit dans
`.claude/skills/writing-principles/references/fr/tics-ia-fr.md`. Elle a été
amorcée sur des observations puis **elle doit être validée par toi** : supprime
ce qui est sain dans ta voix, ajoute ce que tu as constaté ailleurs.

## Répertoire des références françaises

Chaque skill a un dossier `references/fr/`. Ils ne sont chargés que sur
demande, donc ils ne coûtent rien tant que tu n'écris pas en français.

| Fichier | Contenu |
|---|---|
| `tics-ia-fr.md` | Tournures creuses du français, à valider |
| `structures-fr.md` | Contrastes binaires, règle de trois, chute « citable » |
| `craft-fr.md` | Temps du récit, concordance, style indirect libre, calques, tutoiement |
| `typographie-fr.md` | Guillemets, espaces insécables, apostrophe, tiret de dialogue |
| `exemples-fr.md` | 8 paires avant/après, avec le défaut nommé |

## Démarrer un projet d'histoire

Les skills écrivent dans le dossier de travail du projet, donc tout passe par
les outils habituels — et donc par tes approbations.

```
story/          les manuscrits : chapter01.md, chapter02.md…
work/           les brouillons et les variantes
kb/             les notes : personnages, lieu, chronologie
```

Commencez par `story-review` sur un texte existant, ou par
`creative-writing-modes` pour une scène neuve. Écrivez sur disque : les skills
prévoyent de reprendre un texte morceau par morceau, ce qui suppose un fichier.

## Faire une passe de polissage

1. Demandez explicitement : `polisse cette scène`.
2. `stop-slop` note de 1 à 10 cinq axes, et réécrit sous 35/50.
3. **Lisez le diff.** Le skill ne change jamais le sens, les faits, le ton voulu
   ni votre voix ; quand il hésite, il signale plutôt que de trancher. Ce
   garde-fou est à vous : c'est vous qui jugez s'il a raison d'hésiter.

## Mesurer

Le harnais existe et fonctionne. Il ne conclut rien tout seul.

```bash
npm run bench:writing:corpus              # lister les 16 consignes
npm run bench:writing:measure pairs/      # scores automatiques
npm run bench:writing:blind out/ pairs/   # fichier en aveugle, mélangé
npm run bench:writing:tally out/          # dépouiller après notation
```

Le fichier en aveugle mélange les deux versions et cache la clé dans un
fichier séparé. **Ne l'ouvrez pas avant d'avoir noté** : si vous savez quelle
version vient des skills, la mesure ne vaut rien.

### Ce que la mesure peut et ne peut pas dire

Elle compte des choses qu'une machine peut compter : occurrences de tournures
creuses, variance des longueurs de phrases, répétitions de débuts, contrastes
binaires, erreurs de typographie française. Elle ne dit pas si un texte est
vivant. Seul votre jugement en aveugle répond à cette question.

État actuel : une seule paire a été générée et mesurée. Voir
`docs/writing-bench/MEASUREMENT.md`. **Aucune amélioration n'est affirmée à ce
jour.**

## Ce qui n'a pas été repris de la source, et pourquoi :

- Les définitions d'agents (`writer`, `critic`, `editor`) : Cowork n'a pas ces
  rôles, et le rôle de sous-agent `reviewer` ne remplace pas une relecture
  éditoriale.
- Le mécanisme d'invocation `/nom-du-skill`.
- Les routes vers des skills absents (`/intent-modeling`, `/reader-sim`…).
- `analyze.py` : il exige un toolchain Python que Cowork ne suppose pas.
- La deuxième vague (`story-planning`, `story-memory`, `reader-sim`,
  `character-sim`, `shared-dao`) : seulement après une mesure positive.

## Licences

Apache-2.0 (6 skills) et MIT (`stop-slop`). Dépôts d'origine, hashes épinglés,
fichiers repris et liste complète des modifications : `THIRD_PARTY_SKILLS.md`.
Les auteurs d'origine n'ont pas donné leur accord pour Cowork.
