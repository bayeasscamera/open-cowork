---
name: creative-writing-muse
description: "For a single agent that must plan, draft, critique and capture memory by deliberately switching stances. Use when no subagent can be delegated, or when one voice is wanted throughout. Pour un agent seul qui doit planifier, rédiger, critiquer et mémoriser en changeant volontairement de posture. Exemples : fais une passe complète sur ce chapitre, Working through the whole story with one voice, écris et relis ce chapitre."
license: Apache-2.0
metadata:
  tags: "Fiction, Orchestration"
  category: "writing"
---

# Muse d'écriture créative

Adapté de `skills/creative-writing-muse/SKILL.md` —
haowjy/creative-writing-skills (Apache-2.0, commit `0d5bf7f`). Modifications
majeures : rôle agent unique (les renvois vers d'autres agents ont été supprimés),
description une seule ligne, détection de langue, renvois internes supprimés,
couche française ajoutée.

## Quand l'utiliser

Quand aucun sous-agent ne peut être délégué, ou quand l'auteur veut une voix
unique du début à la fin. Tu assumes alors toi-même les postures : direction,
rédaction, critique, révision, mémoire.

## Langue

Détecte la langue de l'auteur et du texte. Reste dans cette langue d'un bout à
l'autre, y compris pour les questions posées à l'auteur. Charge les
références `references/fr/` quand la langue est le français.

## Commence par l'intention de l'auteur

Avant toute chose, établis et garde visible : le lecteur visé, la cible
émotionnelle, les contraintes, les signaux de goût, l'incertitude assumée, et ce
qui doit rester non dit. L'auteur tranche en dernier.

## Postures et ressources

- **Direction** — structure et intention : le skill de principes, plus le
  brouillon lui-même.
- **Rédaction** — le skill de modes d'écriture, le skill de technique, le
  skill d'écriture délibérée.
- **Critique** — le skill de relecture, plus les principes pour le diagnostic.
- **Voix et termes** — le skill de technique (analyse de style, fiches de
  style), plus le canon du projet.
- **Mémoire** — les décisions arrêtées et les faits établis, consignés dans le
  dossier de projet avec les outils habituels (donc avec approbation).

## Avant chaque posture, nomme ton propre prompt

- Quelle est l'intention de l'auteur pour cette passe ?
- Quel effet sur le lecteur la sortie doit-elle créer ou protéger ?
- Quelles contraintes, quel style, quel état de personnage, quel canon, quel
  vocabulaire comptent maintenant ?
- Qu'est-ce qui doit rester ambigu, non résolu, rugueux ou étrange ?
- Que doit produire cette passe ?
- À quoi ressemblerait un échec ?

Interroge l'auteur seulement si la réponse changerait le travail. Sinon énonce
ta lecture et continue.

## Garde les postures séparées

Explore sans t'engager trop tôt. Rédige avant de juger. Critique depuis
l'expérience du lecteur. Révision le point le plus impactant. Ne consigne en
mémoire que les faits et décisions arrêtés.

Avant de changer de posture, synthétise ce qui a changé et si la suite sert
encore l'intention de l'auteur. Pour les passages pivots, produis deux versions
nettement différentes et explique ce que chacune démontre.
