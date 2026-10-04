---
name: story-review
description: "Review existing fiction: editorial review, craft critique, continuity and voice, copyediting, proofreading. Diagnosis, not rewriting — load when judging a draft rather than writing it. Relecture de fiction : éditoriale, développement, ligne, copie, correction. Pour diagnostiquer un texte existant, pas le réécrire. Exemples : relis ce chapitre, fais une relecture éditoriale, vérifie la cohérence, corrige les fautes."
license: Apache-2.0
metadata:
  tags: "Fiction, Review, Editing"
  category: "writing"
---

# Relecture

Adapté de `skills/story-review/SKILL.md` — haowjy/creative-writing-skills
(Apache-2.0, commit `0d5bf7f`). Modifications : rôle agent unique, description
une seule ligne, détection de langue, renvois internes supprimés, script
`analyze.py` retiré (voir `THIRD_PARTY_SKILLS.md`), couche française ajoutée.

Relecture analytique de prose existante. Ce skill sert au **diagnostic**, pas à
la réécriture.

## Langue

Détecte la langue du manuscrit et rédige ta relecture dans cette langue. Pour un
texte français, charge [`references/fr/craft-fr.md`](references/fr/craft-fr.md)
et [`references/fr/typographie-fr.md`](references/fr/typographie-fr.md).

## Choisis le niveau avant de lire

Commence large avant d'aller au détail, sauf demande explicite de passe tardive.
Chaque niveau suppose que les précédents sont stables :

- **Relecture éditoriale** — passe globale d'un éditeur tiers. De quelle
  révision ce texte a-t-il besoin, et dans quel ordre ?
- **Écriture de développement** — structure, promesse, causalité, rythme, arc
  des personnages. Le texte a-t-il la bonne forme ?
- **Relecture de ligne** — voix, rythme, clarté, texture. La prose avance-t-elle
  bien ?
- **Copie** — grammaire, usage, ponctuation, cohérence. Est-ce correct ?
- **Correction** — dernière passe de surface. Qu'est-ce qui a échappé ?

## Ressources par niveau

- [`resources/editorial-review.md`](resources/editorial-review.md)
- [`resources/developmental-edit.md`](resources/developmental-edit.md)
- [`resources/line-edit.md`](resources/line-edit.md)
- [`resources/copyedit.md`](resources/copyedit.md)
- [`resources/proofreading.md`](resources/proofreading.md)

## Critique de technique (adversariale)

Pour une critique de technique plutôt qu'une relecture éditoriale :

- `resources/prose-critique.md` — méthodologie et routage par axe.
- `resources/prose-critique/` — ressources approfondies : structure,
  personnage, voix, prose, continuité, antipatterns, référence.

Pour intégrer un signal de lecture dans ta synthèse :
[`resources/reader-sim-signal.md`](resources/reader-sim-signal.md).

**Aucun script externe n'est requis.** Les métriques (distribution des
longueurs de phrase, variété des débuts, ratio dialogue/narration, répétitions,
répartition des pronoms) se gathers par lecture du manuscrit avec l'outil de
lecture habituel. Voir
[`resources/prose-critique/baseline.md`](resources/prose-critique/baseline.md).

## Couche française

- [`references/fr/tics-ia-fr.md`](references/fr/tics-ia-fr.md) — tournures creuses
  du français.
- [`references/fr/structures-fr.md`](references/fr/structures-fr.md) —
  contrastes binaires, énumérations par trois, fragments en rafale, chute
  « citable ».
- [`references/fr/typographie-fr.md`](references/fr/typographie-fr.md) —
  typographie française.
- [`references/fr/exemples-fr.md`](references/fr/exemples-fr.md) — paires
  avant/après.

**Le tiret de dialogue « — » n'est jamais un défaut dans un dialogue.** En
anglais il est un tic de génération ; en français il est la norme. Ne le
signale pas dans un dialogue ; signale seulement son abus comme incise.
