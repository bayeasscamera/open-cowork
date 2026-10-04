---
name: creative-writing-craft
description: "Craft references for writing fiction well: prose, scenes, style, voice and genre technique. Load when you need how-to-write guidance rather than a production mode. Références techniques pour bien écrire : prose, scènes, style, voix, genres. Exemples : comment construire cette scène, analyse ce style, fais une fiche de personnage."
license: Apache-2.0
metadata:
  tags: "Fiction, Craft, Reference"
  category: "writing"
---

# Technique d'écriture

Adapté de `skills/creative-writing-craft/SKILL.md` —
haowjy/creative-writing-skills (Apache-2.0, commit `0d5bf7f`). Modifications :
rôle agent unique, description une seule ligne, détection de langue, renvois
internes supprimés, ajout de `references/fr/`.

La couche « comment écrire ». La couche « pourquoi le lecteur lit » est dans
le skill de principes ; la couche « mettre la prose sur la page » est dans le
skill de modes.

## Langue

Détecte la langue du texte et réponds dans cette langue. Pour un texte français,
charge [`references/fr/craft-fr.md`](references/fr/craft-fr.md) — temps du
récit, concordance des temps, style indirect libre, registres, calques de
l'anglais, tutoiement/vouvoiement.

## Charge uniquement la ressource utile

- [`resources/prose-writing.md`](resources/prose-writing.md) — distance psychique, style indirect libre, rythme, ancrage sensoriel, intériorité, point de vue.
- [`resources/scene-construction.md`](resources/scene-construction.md) — entrée en scène, dialogue, rythme, transitions.
- [`resources/style-analysis.md`](resources/style-analysis.md) — analyser des échantillons de prose et produire des fiches de style.
- `resources/genre/` — orientation par genre, une ressource par genre :
  [`fantasy.md`](resources/genre/fantasy.md), [`horror.md`](resources/genre/horror.md), [`litfic.md`](resources/genre/litfic.md), [`mystery.md`](resources/genre/mystery.md), [`romance.md`](resources/genre/romance.md), [`thriller.md`](resources/genre/thriller.md).
- [`references/fr/craft-fr.md`](references/fr/craft-fr.md) — spécificités de la
  prose française.
- [`references/fr/typographie-fr.md`](references/fr/typographie-fr.md) —
  typographie française, pour un texte destiné à la publication.
- [`references/fr/exemples-fr.md`](references/fr/exemples-fr.md) — paires
  avant/après en français, avec le défaut corrigé nommé.

## Français

Les ressources en anglais restent valables : la technique de scène, le style
indirect libre et l'ancrage sensoriel ne sont pas propriétaires d'une langue.
Ce qui change, et que `references/fr/craft-fr.md` couvre, c'est :

- le **temps du récit** (passé simple, imparfait, passé composé, présent de
  narration) et la concordance ;
- le **tutoiement et le vouvoiement** dans les dialogues, à trancher par
  personnage et à tenir ;
- les **calques de l'anglais** à éviter ;
- le **tiret de dialogue** « — », qui est la norme et non un tic.
