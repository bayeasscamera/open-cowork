# Rapport de mesure — skills d'écriture Creative en français

**Date** : 2026-10-04 (mis à jour après la réparation de la clé : relais
`omnirouter`, endpoint local `http://localhost:20128/v1`, sonde « Tester la
connexion » OK)
**Modèle testé** : `custom` / `opencode-go/mimo-v2.6-flash`
**Statut** : **PARTIEL — 1 paire complète sur 3 visées, aucune conclusion
d'efficacité n'est possible**

---

## 1. Réponse courte

**Presque rien n'est démontré.** Après réparation de la clé, 12 générations ont
été tentées ; 3 ont produit un texte. Il existe **une seule paire comparable**
(`fr-03`), mesurée ci-dessous en §10. Le fichier aveugle correspondant
(`docs/writing-bench/blind-01/`) attend ta notation.

Sur cette paire unique : **zéro tic creux des deux côtés** (le modèle n'émet
pas la pathologie visée, avec ou sans skills), et un écart de typographie
massif (33 erreurs sans vs 5 avec, presque entièrement des apostrophes
droites : 28 contre 0). n=1, textes de longueurs très différentes (1980 vs
1014 caractères, la consigne ne fixait pas la longueur) — **aucune conclusion**.

---

## 2. Pourquoi la mesure s'est arrêtée

Trois générations demandées via l'app installée (`/Applications/Open Cowork.app`,
session.start) :

| Consigne | Résultat |
|---|---|
| `fr-01` première phrase, nouvelle | **OK** — 101 mots |
| `fr-03` description de lieu | ÉCHEC — `401 Invalid token` |
| `fr-05` réécriture d'un paragraphe | ÉCHEC — `400 model not found` |

Les deux échecs viennent du **fournisseur configuré**, pas des skills : le
profil actif renvoie une erreur d'authentification sur deux appels sur trois.
Un seul appel a réussi, de façon incohérente avec les deux autres — ce qui
évoque un jeton ou une configuration de modèle instable plutôt qu'un blocage
déterministe.

**Conséquence** : il est impossible de produire le bras « avec skills » de façon
fiable tant que le profil n'est pas réparé. Je n'ai pas touché à la
configuration du profil : elle contient des secrets et sort du périmètre de la
mission.

---

## 3. Ce que la mesure isolée apprend (sur le bras SANS skills)

`fr-01` — première phrase d'une nouvelle, 101 mots, généré sans les skills.

| Métrique | Valeur | Lecture |
|---|---|---|
| Tournures creuses / 1000 mots | **0** | Aucune. Le texte ne contient aucun des tics listés. |
| Variance des longueurs de phrase | **0,47** | Très faible. |
| Longueur moyenne de phrase | 33,7 mots | Long. |
| Débuts de phrase répétés | 0 | — |
| Contrastes binaires | 0 | — |
| Apostrophes droites | **9** | Une par contraction. |
| Fins « punchline » | 0 | — |

### Ce que ça dit

**Le modèle ne produit pas de tic creux sur ce type de consigne.** Zéro
occurrence, sans skill. C'est une information réelle et elle va à l'encontre de
l'intuition que le projet de départ — « les modèles écrivent avec des tics ».

**Le défaut mesurable n'est pas le tic, c'est le rythme.** Trois phrases de
~34 mots, écart-type de 0,47 : la prose est metronome. Aucun compteur de tics
n'aurait détecté ça. C'est l'argument le plus fort en faveur d'un skill comme
`writing-principles`, dont le travail porte sur les canaux de récompense — et
c'est aussi ce qui rend la phase 7 indispensable plutôt qu(optionnelle.

**Les apostrophes droites sont un défaut réel et facile à corriger** — 9 sur
~101 mots. C'est exactement ce que `typographie-fr.md` documente.

---

## 4. Ce que la mesure ne peut pas encore dire

- **L'effet des skills** : rien. Le bras « avec skills » n'existe pas.
- **La qualité perçue** : le fichier en aveugle existe et fonctionne, mais il
  n'a pas été noté. Aucune note humaine.
- **La généralisation** : 1 paire sur 16, sur une seule catégorie
  (ouverture). Rien ne permet de généraliser à une scène de dialogue, une
  lettre, un conte ou une scène d'action.
- **Le coût en tokens** : mesuré pour les descriptions (723 tokens au total,
  sous la cible de 1 500) mais **pas** le coût réel d'une génération avec les
  skills chargés, faute du bras « avec ».

---

## 5. Hypothèses, explicites

1. L'échec 401/400 est **un problème de configuration du profil**, pas un
   effet des skills. Hypothèse forte : les erreurs sont_http et ne mentionnent
   aucun fichier de skill.
2. Le modèle `mimo-v2.6-flash` se comporte comme un modèle de taille moyenne :
   bon fond, rythme faible. Un seul échantillon, donc c'est une hypothèse.
3. Le corpus de 16 consignes est suffisant pour une première lecture mais trop
   petit pour conclure. Il faudra plusieurs passages par consigne.

---

## 6. Pour finir la phase 7

1. ~~Réparer l'authentification du fournisseur~~ — **fait** : relais omnirouter,
   sonde OK le 2026-10-04.
2. Produire les paires manquantes : `fr-01` (bras avec) et `fr-05` (les deux
   bras). Le relais était très instable pendant la session (voir §10).
3. Construire le fichier en aveugle :
   `npm run bench:writing:blind out/ pairs/` — **fait pour `fr-03`** :
   `docs/writing-bench/blind-01/`.
4. Le noter **sans ouvrir `ANSWER-KEY.tsv`** — **à toi de jouer** (grille 1-5,
   5 axes, dans `REVIEW.md`).
5. Dépouiller : `npm run bench:writing:tally out/`.

---

## 7. Coût

- Budget des descriptions (présentes dans chaque prompt) : **485 tokens**,
  mesuré après correction. Il était de 723 avant que le défaut de guillemets ne
  soit trouvé (voir §9) ; la moitié française était invisible et comptée pour
  rien.
- Corps des skills (chargés uniquement sur demande) : 2 à 5 ko chacun.
- Références françaises : chargées uniquement si le texte est en français.
- Coût d'une génération « avec skills » : **non mesuré**.

---

## 8. Ce que le harnais sait faire, vérifié

Le harnais a été testé sur des cas favorables, défavorables, d'égalité et de
fichier incomplet. Les quatre chemins produisent la sortie attendue, y compris
le verdict négatif. Il est donc utilisable pour trancher, pas seulement pour
produire un tableau.

Le détail des métriques et la méthode figurent dans
`scripts/writing-bench/metrics.ts`.

---

## 9. Défaut trouvé en installant, et corrigé

En rebuildant et relançant l'app installée pour vérifier que les skills
étaient bien livrés, j'ai vu que le routeur recevait des descriptions de 98 à
244 caractères alors qu'elles en font 331 à 422.

Cause : `SkillsManager.getSkillMetadata` utilise
`/description:\s*["']?([^"'\r\n]+)/`. Trois façons de perdre la moitié
française, toutes vérifiées :

1. **description pliée** (`description: >`) : renvoie la chaîne littérale `">"`.
2. **description entre guillemets** : s'arrête à la guillemet fermante, donc
   seule la moitié anglaise arrivait au routeur. C'est le cas rencontré ici.
3. **apostrophe** (`d'écriture`) : le classeur de caractères s'arrête là.

Les descriptions des 7 skills ont été réécrites sur une seule ligne, **non
guillemetées et sans apostrophes**, avec le français en premier pour que le
routeur dispose des deux moitiés. Budget réel après correction : 485 tokens
au lieu de 723 (la moitié française invisible était comptée pour rien).

Le test qui attrape ce défaut vérifie ce que le routeur voit réellement, pas la
description lisible. Il a été validé sur les deux régressions : guillemet
réintroduit, apostrophe réintroduite.

---

## 10. Session de génération du 2026-10-04 (relais omnirouter)

12 générations tentées via l'app installée, même modèle, mêmes réglages.
Bras « sans » = consigne seule. Bras « avec » = consigne + bloc méthode
explicite nommant les 4 skills (le skill ne peut pas être chargé autrement par
`session.start` : les skills arrivent par `additionalSkillPaths`, pas par
l'IPC — l'instruction explicite est la condition réaliste d'usage).

| Session | Bras | Résultat |
|---|---|---|
| `fr-03` cuisine abandonnée | sans | **texte, 1980 car.** |
| `fr-03` cuisine abandonnée | avec | **texte, 1014 car.** |
| `fr-01` première phrase | sans | texte, 101 car. (session précédente) |
| `fr-01` +padding neutre (~450 car.) | contrôle | **400** |
| `fr-01` / `fr-05` avec, suffixe long puis court | avec | **400 puis 404** à chaque fois |
| `fr-05` sans | sans | **503 puis 404** |

Erreurs relais rencontrées : `503 capacity unavailable`, `404` avec corps
gzip non décodé, `400 model not found` (message trompeur).

**Fait notable** : le contrôle à padding neutre échoue comme le bras « avec ».
Ce n'est donc pas le contenu de l'instruction qui coince, mais la **taille du
prompt** (ou un seuil relais) — avec une composante intermittente, puisque
`fr-03-avec` (436 car. de consigne) est passé une fois. Le relais a en outre
été instable toute la session.

**Quel modèle a réellement servi.** Les logs montrent que les 5 sessions bench
ont demandé `opencode-go/mimo-v2.6-flash` via le fallback synthétique
(registre pi-ai → protocole openai vers le relais) : les textes mesurés
viennent du modèle demandé. Les appels auxiliaires (mémoire) utilisaient un
autre modèle (`@cf/qwen/qwen3.8-27b`) — pas les textes mesurés. Une session en
échec (`fr-01-avec`) a brièvement basculé sur
`meta/muse-spark-1.3-contributor:free` ; son texte final étant une erreur, sans
impact sur les mesures.

### Mesure automatique de la paire `fr-03`

```
tics/1000 mots   sans 0  avec 0  écart 0
variance phrases sans 9.5  avec 5.56
débuts répétés   sans 2  avec 2
typo             sans 33  avec 5  (dont apostrophes droites : 28 contre 0)
```

Lecture honnête : les tics creux sont absents des deux côtés (2e confirmation).
L'écart de typographie est réel mais mécanique — il mesure surtout que le
texte « avec » applique `typographie-fr.md`, pas qu'il est meilleur. La
variance plus forte du « sans » vient en partie de sa longueur double. **n=1 :
aucune conclusion.**

### Sessions nettoyées

Les 14 sessions `bench-*` ont été supprimées de la base après extraction des
textes (sauvegarde préalable de la base). Textes conservés :
`docs/writing-bench/blind-01/` (paire + fichier aveugle) et
`docs/writing-bench/without-fr01.txt`.
