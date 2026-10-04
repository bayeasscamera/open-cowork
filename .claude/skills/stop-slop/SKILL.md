---
name: stop-slop
description: Retire les tics d ecriture des modeles, sur demande explicite uniquement. Polir ce texte, nettoyer ce paragraphe, passer cette scene au crible, ce texte sonne artificiel. Remove AI writing tics from prose on a deliberate polishing pass only, never automatically.
disable-model-invocation: true
license: MIT
metadata:
  tags: "Editing, Polish, Prose"
  category: "writing"
---

# Stop Slop

Adapté de `SKILL.md` — hardikpandya/stop-slop (MIT, commit `8da1f03`).

**Modifications par rapport à l'original** (détaillées dans
`THIRD_PARTY_SKILLS.md`) :

1. Le tiret cadratin n'est **pas** interdit. En français c'est le tiret de
   dialogue ; l'interdire casserait chaque dialogue.
2. « Tous les adverbes sont interdits » devient « les adverbes d'insistance
   creuse sont en excès ». Interdire tout adverbe est faux en français.
3. Ajout d'un garde-fou de fidélité, absent de l'original.
4. Description bilingue, sur une seule ligne.

## Quand ce skill s'applique

**Uniquement sur demande explicite** : « polis », « nettoie », « passe au
crible », « ce texte sonne artificiel ».

Ne l'applique pas automatiquement à toute écriture. Un texte déjà vivant —
avec ses reprises, ses hésitations, ses maladresses volontaires — peut être abîmé
par une passe trop mécanique. Une relecture non demandée est une réécriture
non demandée.

## Garde-fou de fidélité

Ce skill ne modifie jamais :

- le **sens** ;
- les **faits** ;
- le **ton voulu** par l'auteur ;
- la **voix** de l'auteur.

Quand tu hésites, **signale** au lieu de trancher. Écris par exemple : « "cette
formulation a été conservée : je ne sais pas si elle est idiomatique dans ce
registre — à toi de trancher ».

Une intention d'auteur qui paraît être une maladresse reste une intention. Une
grammaire non standard, un fragment de phrase, un temps qui déraille peuvent
être la voix ; s'ils sont constants dans le manuscrit, ce sont des choix, pas
des erreurs.

## Les huit règles

1. **Supprime les formules de remplissage.** Ouvreurs de gorge, échasses,
   emphases creuses. Voir [`references/phrases.md`](references/phrases.md) et,
   pour le français, [`references/fr/tics-ia-fr.md`](references/fr/tics-ia-fr.md).

2. **Casse les formules.** Contrastes binaires, énumérations négatives,
   fragmentation dramatique, questions rhétoriques, fausse agency. Voir
   [`references/structures.md`](references/structures.md) et
   [`references/fr/structures-fr.md`](references/fr/structures-fr.md).

3. **Voix active.** Chaque phrase a un sujet humain qui fait quelque chose. En
   français, l'accord participe présent rend cette règle plus difficile qu'en
   anglais : ne poursuis pas la chasse si elle force des tournures aberrantes.

4. **Sois précis.** Pas de déclaratif vague (« les raisons sont
   structurelles »). Nomme la chose précise. Pas d'extrêmes paresseux («
   toujours », « jamais ») qui font un travail flou.

5. **Mets le lecteur dans la pièce.** Ton de narrateur lointain : « on a conçu
   ce système » place le lecteur dehors. « Tu es là, à 4 h, la machine ronronne
   » le place dedans.

6. **Varie le rythme.** Mélange les longueurs. Deux éléments valent mieux que
   trois. Termine les paragraphes différemment. **Le tiret cadratin n'est pas un
   tic en français** : c'est le tiret de dialogue. Ne le retire jamais d'un
   dialogue ; signale seulement son usage comme incise abusive.

7. **Fie-toi au lecteur.** Énonce les faits directement. Supprime l'amadoue, la
   justification, la main tendue.

8. **Supprime les phrases à effet.** Si elle sonne comme un tiret de
   couverture, réécris-la.

## Vérifications rapides

Avant de rendre :

- Adverbes d'insistance creuse en intensif (« vraiment », « véritablement »,
  « profondément », «foncement ») ?
- Formules de remplissage en ouverture ?
- « Ce n'est pas X, c'est Y », « non pas X mais Y » ?
- Trois phrases consécutives de même longueur ?
- Paragraphe qui se termine sur une punchline isolée ?
- Banal déclaratif (« les implications sont importantes ») ?
- Narrateur lointain ?
- Métajunctions (« dans la suite de cet article ») ?
- **Dans un dialogue :** le tiret « — » est-il présent et correct ? Il ne doit
  **jamais** être signalé comme un défaut.

## Notation

Note de 1 à 10 sur chaque axe :

| Axe | Question |
|---|---|
| Directness | Des affirmations, ou des annonces ? |
| Rythme | Varié, ou métronomique ? |
| Confiance | L'intelligence du lecteur est-elle respectée ? |
| Authenticité | Est-ce que ça sonne humain ? |
| Densité | Y a-t-il de quoi couper ? |

Sous 35/50 : réécrire.

## Exemples

Voir [`references/examples.md`](references/examples.md) pour les transformations
avant/après, et [`references/fr/exemples-fr.md`](references/fr/exemples-fr.md)
pour la version française.

## Licence

MIT — voir `LICENSE`.
