# Couverture, mise en forme et export

## Principe : une seule source
Garde **un texte source en Markdown** avec métadonnées. Les `.docx`, `.pdf` et `.epub` sont **générés depuis cette source** pour qu'ils ne divergent jamais. Corrige toujours la source, jamais un export.

```
---
title: Titre
subtitle: Sous-titre
author: Nom de l'auteur
lang: fr
date: 2026-10-04
---
```

## Avant d'exporter
1. Le texte est validé par l'utilisateur (étape de validation avant export final).
2. Les champs `[À COMPLÉTER]` et `[à vérifier]` sont traités ou signalés.
3. Typographie française appliquée (`typographie-fr.md`).
4. Table des matières, page de titre, mentions (copyright, éditeur, ISBN si fourni par l'utilisateur) : **ne les invente pas**.

## Choisir le format
| Besoin | Format |
|---|---|
| Éditer encore, relire avec suivi | `.docx` |
| Envoyer, imprimer, figer la mise en page | `.pdf` |
| Lecture sur liseuse / téléphone | `.epub` |

## Outils
- **`.docx`** : suis le skill `docx`.
- **`.pdf`** : suis le skill `pdf`.
- **`.epub`** : Pandoc (Markdown → EPUB, avec feuille de style et couverture) ou équivalent. Vérifie avec **epubcheck** si disponible.
- **Vérifie la présence des outils** (version) avant de promettre un format. S'il en manque un, **dis-le et propose l'installation à l'utilisateur** ; n'installe rien sans son approbation.

## Contrôle de l'export (obligatoire)
- Ouvre ou convertis le fichier produit et **regarde le résultat** (pages du PDF rendues en images, structure du `.docx`, table des matières de l'`.epub`).
- Vérifie : titres et niveaux, sauts de page, coupures de mots, caractères accentués et espaces insécables, images, liens, métadonnées, numérotation.
- Un `.epub` doit passer epubcheck sans erreur. Corrige la source, régénère, revérifie.
- Ne dis jamais « exporté avec succès » sans avoir vérifié.

## Couverture

1. **Brief de couverture** : genre, ambiance, public, titre, auteur, éléments à éviter, couleurs.
2. **Image de fond générée sans texte** : les modèles d'images écrivent mal. Demande plusieurs variantes d'un visuel sans aucun texte.
3. **Titre et nom d'auteur ajoutés par le code** (composition d'image ou SVG) : polices maîtrisées, lisibilité en miniature, contraste.
4. **Taille** : ratio d'environ 1,6:1 (par exemple 1600 × 2560 px) pour les liseuses et librairies en ligne ; vérifie les consignes de la plateforme visée.
5. **Droits** : image générée ou libre de droits, police dont la licence autorise l'usage ; pas de personne réelle identifiable, pas de logo ou personnage protégé.
6. **Présente 2 à 3 variantes** à l'utilisateur et laisse-le choisir.

## Livraison
Présente les fichiers finaux, indique leur taille, ce qui a été vérifié et ce qui ne l'a pas pu être (par exemple « epubcheck non installé »).
