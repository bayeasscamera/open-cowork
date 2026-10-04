# Rapport de mesure — skills d'écriture Creative en français

**Date** : 2026-10-04
**Modèle testé** : `custom` / `opencode-go/mimo-v2.6-flash` (profil actif, lu
dans `config.public.json`)
**Statut** : **INCOMPLET — aucune conclusion d'efficacité n'est possible**

---

## 1. Réponse courte

**Rien n'est démontré.** Sur les trois générations tentées, une seule a
abouti, et c'est le bras **sans** skills. Il n'existe donc aucune paire
comparable, et le skills n'a pas été mis à l'épreuve une seule fois.

Ce qui est rapporté ici est donc : un harnais vérifié, et une première mesure
isolée qui apprend quelque chose sur le modèle — pas sur l'efficacité des
skills.

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

1. Réparer l'authentification du fournisseur dans Settings → API.
2. Rejouer `npm run bench:writing:measure` sur les trois consignes échouées.
3. Générer le bras « avec skills » : créer une session, charger les skills
   dans le contexte, puis régénérer les mêmes trois consignes avec le même
   modèle.
4. Construire le fichier en aveugle :
   `npm run bench:writing:blind out/ pairs/`
5. Le noter **sans ouvrir `ANSWER-KEY.tsv`**.
6. Dépouiller : `npm run bench:writing:tally out/`.

Tant que ces six points ne sont pas faits, ce document doit rester tel quel.

---

## 7. Coût

- Budget des descriptions (présentes dans chaque prompt) : **723 tokens**,
  mesuré, sous la cible de 1 500.
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
