---
name: writing-principles
description: "What fiction readers actually reward, and the specific ways model training damages it. Diagnostic layer: use when drafting prose, critiquing a passage, or working out why a scene feels flat. Ce que le lecteur de fiction récompense, et comment l'entraînement le dégrade. Exemples : ce passage sonne plat, pourquoi, réécris cette scène, soigne la prose."
license: Apache-2.0
metadata:
  tags: "Fiction, Craft, Prose"
  category: "writing"
---

# Principes d'écriture

Adapté de `skills/writing-principles/SKILL.md` — haowjy/creative-writing-skills
(Apache-2.0, commit `0d5bf7f`). Modifications : rôle agent unique, description
une seule ligne, détection de langue, renvois internes supprimés, ajout de
`references/fr/`.

Ce skill est la couche **diagnostique** : il nomme ce que le lecteur veut et
comment l'entraînement le dégrade. La charge utile est dans
`resources/failure-modes.md` ; l'exécution est dans le skill de technique.

## Langue

Détecte la langue du texte et réponds dans cette langue. Pour un texte français,
charge [`references/fr/craft-fr.md`](references/fr/craft-fr.md) (temps du
récit, style indirect libre, calques de l'anglais) et
[`references/fr/typographie-fr.md`](references/fr/typographie-fr.md) si le
texte est destiné à la publication.

## Confier le travail au lecteur

Le lecteur est un collaborateur actif. Il reconstruit les émotions à partir des
comportements, déduit les motifs de l'action, maintient la tension d'une scène à
l'autre, comble les vides que le texte laisse ouverts. C'est là que réside la
récompense : reconstruction, inférence, anticipation.

L'instinct d'assistance tire en sens inverse : il veut expliquer, résoudre,
clarifier, compléter. En fiction, chacun de ces impulsions peut abîmer
l'expérience en faisant le travail que le lecteur voulait faire lui-même.

Confier n'est pas obscurcir. Le lecteur a aussi besoin d'une narration
cohérente, d'une géographie stable et d'un accès suffisant aux personnages. La
discipline consiste à savoir quand laisser de l'espace et quand orienter.

## Économie

Chaque élément doit faire plus d'une chose. Une réplique fait avancer
l'action **et** révèle un personnage. Un détail sensoriel ancre la scène **et**
montre qui voit. Une transition comprime le temps **et** porte un affect. La
prose à usage unique rend la fiction plate : une description qui ne fait que
décrire, un dialogue qui ne fait qu'informer.

L'économie n'est pas le minimalisme. Une prose dense et lyrique peut être
économique ; une prose pauvre peut être gaspilleuse. La mesure est simple :
retirer cet élément coûterait-il quelque chose au lecteur ?

## Canaux de récompense

Le lecteur-de-fiction scrute des canaux qui se recouvrent. Les protéger
tous à la fois ; en damage un seul, on damage l'expérience entière.

- **Transport** — entrer dans le monde. Protégé par une progression
  cohérente, un point de vue stable, un ancrage sensoriel concret. Écrire du
  point de vue, c'est écrire depuis l'état de connaissance du personnage : ce
  qu'il a vécu, ce qu'il sait maintenant, ce qu'il remarquerait et manquerait.
  L'histoire entière est dans ton contexte ; le personnage n'a que son vécu.
  Sépare les deux.
- **Esthétique** — le plaisir de la phrase. Protégé par la variété du rythme,
  le choix des mots, la forme des phrases, la ponctuation. Le style est un canal
  de récompense, pas une décoration.
- **Simulation sociale** — modelled les personnages comme des esprits. Protégé
  par un accès par le comportement et l'intériorité, des voix distinctes, une
  émotion que le lecteur interprète au lieu qu'on la lui dise.
- **Fluidité** — adéquation entre difficulté et compétence. Protégée par un
  rythme qui suit le travail de la scène et des phrases qui soutiennent la
  compréhension sans la rendre triviale.
- **Curiosité** — vouloir savoir ce qui va se passer. Protégée par les blancs
  d'information, l'incertitude, la mise en place et la résolution, les
  implications retenues que le lecteur peut modéliser activement.

Les canaux se composent : en optimiser un au détriment des autres échoue.
Trop expliquer casse la simulation sociale. Trop peu expliquer casse le
transport. Un style générique casse l'esthétique. Un style impénétrable casse la
fluidité.

## Ponctuation

En anglais, les lecteurs associent le tiret cadratin (`—`) à une prose générée par
modèle ; la règle amont est donc de le proscrire par défaut.

**Cette règle ne se transpose pas en français.** Le tiret cadratin y est le
tiret de dialogue (`— Bonjour. —`) : l'interdire casserait chaque dialogue. La
règle française porte uniquement sur son usage comme ponctuation d'incise
abusive. Voir [`references/fr/typographie-fr.md`](references/fr/typographie-fr.md).

## Appliquer les principes

Quand une page sonne creux et que tu ne sais pas nommer la raison, regarde les
canaux : lequel s'est cassé ? Puis consulte
`resources/failure-modes.md` pour le motif et le remède.

## Ressources

- [`resources/failure-modes.md`](resources/failure-modes.md) — analyses
  détaillées par motif, avec exemples et remèdes.
- [`resources/citations.md`](resources/citations.md) — recherche soutenant le
  modèle de récompense du lecteur.
- [`references/fr/craft-fr.md`](references/fr/craft-fr.md) — temps du récit,
  concordance, style indirect libre, calques de l'anglais.
- [`references/fr/tics-ia-fr.md`](references/fr/tics-ia-fr.md) — tournures creuses
  du français, à faire valider par l'auteur.
- [`references/fr/exemples-fr.md`](references/fr/exemples-fr.md) — paires
  avant/après en français.
