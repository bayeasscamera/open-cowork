---
name: llm-writing
description: "Load before writing or revising any human-facing text, in French or English. Deliberate word choice, reader context, and removal of default model phrasing. Utilise avant toute rédaction ou révision de texte : choix des mots, contexte lecteur, suppression des tournures par défaut. Exemples de déclenchement : écris une nouvelle, rédige un mail, revise ce paragraphe."
license: Apache-2.0
metadata:
  tags: "Writing, Editing, Prose"
  category: "writing"
---

# Écriture délibérée

Adapté de `cw/skills/llm-writing/SKILL.md` — haowjy/creative-writing-skills
(Apache-2.0, commit `0d5bf7f`). Modifications : rôle agent unique, description
une seule ligne, détection de langue, renvois internes supprimés.

## Langue

Détecte la langue du texte de travail et de la demande. Réponds dans cette
langue. Si le texte est en français, charge les références `references/fr/`
avant de produire la version finale.

## Avant de produire un texte

1. **Portée.** Que sait le lecteur au début, et à la fin ? Que n'a-t-il pas
   besoin de savoir ? Découpe le texte en temps forts : chaque temps est un
   mouvement dans le parcours du lecteur, portant une idée, une fonction ou un
   retournement.
2. **Ancrage.** Vérifie les sources, références ou notes disponibles avant
   d'écrire, et assure-toi qu'elles concordent.
3. **Brouillon.** Écris une version complète sur disque pour pouvoir la
   reprendre morceau par morceau.
4. **Révision.** Commence par l'ensemble, puis descends vers l'intérieur :
   structure, temps forts, paragraphes, phrases, mots. À chaque échelle,
   demande-toi ce que fait le texte : est-il exact, découle-t-il de ce qui
   précède, le lecteur en a-t-il besoin ? Supprime ou réécris ce qui ne sert à
   rien. Reviens en arrière après chaque changement local : la modification doit
   toujours se raccorder, le rythme doit rester varié.

## Ce qu'il faut supprimer

- Écrire pour remplir une section parce qu'elle existe.
- Nommer un concept sans expliquer son mécanisme : explique ou coupe.
- Affirmer une conclusion sans preuve : montre la preuve ou abandonne
  l'affirmation.
- Cacher l'incertitude derrière un ton assuré : dis ce que tu ne sais pas.
- Adoucir chaque affirmation (« il convient de noter », « il est important de »,
  « force est de constater ») : dis-le, ou ne le dis pas.
- Répéter ce qui vient d'être dit autrement, ou résumer le corps en conclusion
  (« En conclusion », « Dans l'ensemble »).
- Relier les idées par des mots de transition au lieu du sens (« De plus »,
  « Par ailleurs », « En outre »). Si la relation n'est pas claire sans le mot,
  restructure.
- Apparier deux propositions dont une seule porte le sens (« ce n'est pas X,
  c'est Y »). Garde la moitié qui porte le sens.
- Écrire pour la personne qui a demandé le document plutôt que pour celle qui
  le lira.

Pour les tournures creuses propres au français, voir
[`references/fr/tics-ia-fr.md`](references/fr/tics-ia-fr.md). **Cette liste est
un jeu d/examples à valider, pas un catalogue définitif** : toute entrée doit
avoir été observée sur un texte réel, puis validée par l'auteur.
