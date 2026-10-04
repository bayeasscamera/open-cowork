---
name: creative-writing-modes
description: Couche d ecriture pour mettre la prose sur la page : brouillon, revision, passerelle, variante, retouche. Ecris la scene, reprends ce passage, rends ce dialogue plus naturel, peaufine. Putting prose on the page: draft, revise, bridge, alternate take, polish.
license: Apache-2.0
metadata:
  tags: "Fiction, Drafting, Revision"
  category: "writing"
---

# Modes d'écriture créative

Adapté de `skills/creative-writing-modes/SKILL.md` —
haowjy/creative-writing-skills (Apache-2.0, commit `0d5bf7f`). Modifications :
rôle agent unique, description une seule ligne, détection de langue, renvois
internes supprimés, ajout de `references/fr/`.

Utilise le plus petit mode qui convient à la tâche. Ne lis que la section
correspondante de `resources/prose-modes.md`, sauf demande explicite de passe
hybride.

## Langue

Détecte la langue de la demande et du texte, et produis dans cette langue.
Charge `references/fr/` quand la langue est le français :
[`references/fr/craft-fr.md`](references/fr/craft-fr.md) pour la prose,
[`references/fr/typographie-fr.md`](references/fr/typographie-fr.md) pour un
texte destiné à la publication.

## Avant d'écrire un personnage

Trouve le style et l'état du personnage. Si la demande contredit cet état :
écris selon la demande, signale la contradiction, et ne modifie pas l'état du
personnage.

## Modes

- **Brouillon neuf** — prose neuve depuis un brief, un plan, un style, un état
  de personnage et un canon.
- **Révision** — modifier un brouillon existant selon une direction ou une
  critique.
- **Passerelle** — relier des scènes, comprimer le temps, changer de registre.
- **Variante** — tester une exécution nettement différente du même temps fort.
- **Retouche de phrase** — améliorer rythme, précision et texture une fois la
  structure stabilisée.

## Genres

Le genre est une orientation de technique, pas un mode de prose. Quand la
promesse du genre façonne la passe, charge le skill de technique et la ressource
`resources/genre/` correspondante.

## Frontière

Ce n'est pas un skill de planification ni de relecture. Utilise-le quand
l'étape suivante est d'écrire la prose, pas de juger une page existante.

## Ressources

- [`resources/prose-modes.md`](resources/prose-modes.md) — le détail par mode.
- `resources/genre/` — fantasy, horror, litfic, mystery, romance, thriller.
- [`references/fr/exemples-fr.md`](references/fr/exemples-fr.md) — paires
  avant/après pour chaque mode, en français.
