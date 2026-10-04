# Typographie française

Couche française. À appliquer quand le texte est **destiné à la publication**
(lecture, édition, impression). **À ne pas appliquer** dans du code, des
identifiants, des chemins, des commandes, ni quand on **citer un texte
destructivement** — on ne corrige pas la ponctuation d'une citation.

---

## 1. Espaces insécables

L'espace insécable (U+00A0 ou U+202F) empêche qu'un mot soit coupé en fin de
ligne. En français, elle est obligatoire :

| Avant | Caractère |
|---|---|
| `«` guillemet ouvrant | espace insécable **après** |
| `»` guillemet fermant | espace insécable **avant** |
| `:` deux-points | espace insécable **avant** |
| `;` point-virgule | espace insécable **avant** |
| `?` point d'interrogation | espace insécable **avant** |
| `!` point d'exclamation | espace insécable **avant** |
| `%` pourcentage | espace insécable **avant** (ou après selon la maison) |

```text
« Bonjour. » — il a dit : « Attendez. »
                    ↑          ↑
              espace insécable avant « : » et « ? »
```

**Ce qu'il ne faut pas faire** : une espace normale. C'est invisible à l'écran
et invisible au lecteur, mais le typographe le verra, et un mot peut se
retrouver seul en fin de ligne.

## 2. Guillemets

**Norme française** : les guillemets « » (chevrons), avec **espace insécable**
(U+00A0) à l'intérieur. Les guillemets anglais `" "` sont incorrects en
français.

Les exemples ci-dessous contiennent une **vraie** espace insécable. Si ton
éditeur ne la conserve pas, c'est un défaut d'outil, pas de style.

```text
« Bonjour. »        ✓  guillemets français, espaces insécables
«Bonjour. »            ✗  pas d'espace après le guillemet ouvrant
« Bonjour.»            ✗  pas d'espace avant le guillemet fermant
"Bonjour."                ✗  guillemets anglais
```

**Avec attribution** :

```text
« Bonjour. », dit-il.        ✓  virgule avant le guillemet fermant
— Bonjour, dit-il.              ✓  tiret de dialogue, sans guillemets
```

Dans le dialogue au tiret, on n'emploie généralement pas les guillemets : le
tiret tient déjà ce rôle. Les guillemets servent au discours rapporté et à la
citation dans le récit.

**Points de suspension** : le caractère `…` (U+2026) est préférable aux trois
points `...`.

**Point final** : dans une citation entre guillemets, la ponctuation double se
place **avant** le guillemet fermant — sauf si la citation n'est qu'un fragment :
`« …le quai était vide. »`.

## 3. Le tiret de dialogue « — »

**C'est le tiret de dialogue français**, et il est correct.

```text
— Bonjour, dit-il.                          ✓
— Vous partez maintenant ? — dit-elle.      ✓
```

**Règles** :

1. Chaque réplique commence par un tiret cadratin `—`, **avec espace insécable
   après**.
2. En fin de réplique, si le dernier mot est une ponctuation double
   (`?` `!` `.`), le guillemet fermant vient **après**, sans tiret de
   fermeture.
3. Un tiret **interne** à une réplique marque une interruption :
   `— Je ne sais pas — enfin, je crois que si. — Alors allons-y.`
4. Le tiret demi-cadratin `–` est pour les **incises**, les **dates**, les
   **intervalles**. Ne le confonds pas avec le tiret de dialogue.

## 4. Apostrophe

L'apostrophe typographique est la **courbe** : `’` (U+2019), pas `'` (U+0027).

```text
l'eau, jusqu'à, aujourd'hui, c'est      ✓
l'eau, jusqu'a, aujourd'hui, c'est      ✗ apostrophe droite
```

C'est une faute très visible en français, et le modèle la produit
régulièrement. **Corrige-la systématiquement** dans un texte destiné à la
publication.

## 5. Majuscules

- **Début de phrase** : majuscule.
- **Après un point-virgule, deux-points ou point-virgule** : pas de
  majuscule en français (contrairement à l'anglais). `Il dit : je pars.`
- **Sigles** : majuscules, sans points en français. `OMC`, `UE`, `RGDP` — pas
  `O.M.C.`
- **Prénoms et noms propres** : majuscule, y compris dans les langues qui
  n'en utilisent pas (`d'Artagnan`, `Mac Donald`).

## 6. Nombres

- **En français** : espace **insécable** comme séparateur de milliers.
  `1 000 000`, `12 500`.
- Virgule décimale : `3,5` — pas `3.5`.
- On écrit les nombres **inférieurs à cent** en toutes lettres dans un texte
  courant : `vingt-cinq ans`. Au-delà : `250 habitants`.
- Ordinal : `1er`, `2e` — ou `première`, `deuxième` en toutes lettres.

## 7. Titres d'œuvres

| Type | Traitement |
|---|---|
| **Romans, livres** | *italique* : *Le Petit Prince* |
| **Films** | *italique* : *Le Fabuleux Destin d'Amélie Poulain* |
| **Pièces de théâtre** | *italique* : *Huis clos* |
| **Journaux, revues** | *italique* en première mention, puis guillemets : *Le Monde*, puis « Le Monde » |
| **Chansons** | guillemets : « La Bohème » |
| **Peintures** | *italique* : *La Joconde* |
| **Titres de chapitres** | selon la convention de l'ouvrage |

## 8. Nombres et chiffres dans une œuvre de fiction

Dans une narration, on écrit généralement les nombres en toutes lettres jusqu'à
cent, sauf :

- pour un ** dialogue technique** ou un **message** écrit ;
- pour une **date**, une **mesure**, une **référence précise** ;
- quand le personnage lit ou cite un document.

## 9. Ce qu'il ne faut PAS typer

- **Code source, commandes, chemins** : espaces normales, apostrophes droites,
  guillemets ASCII. Un script doit rester exécutable.
- **Citations** : ne corrige pas la ponctuation d'un texte cité. Si une source
  est mal ponctuée, on la signale, on ne la réécrit pas.
- **URL, adresses web** : aucune espace insécable, apostrophes droites, pas de
  guillemets français.
- **Titres de sections et métadonnées** : le modèle suit la convention du
  projet.

## 10. Points de vigilance

| Piège | Correction |
|---|---|
| « mot » sans espace insécable | « **mot** » |
| `espace` : `mot` | espace insécable avant `:` |
| l'eau → l'eau | apostrophe courbe `’` |
| `« mot »` en ouverture | « **mot** » |
| `...` (trois points) | `…` (U+2026) |
| point avant le guillemet fermant | `« mot. »` pas `« mot » .` |
| `3.5` | `3,5` |
| `O.M.C.` | `OMC` |
| `oui, je pense que si.` après `;` | pas de majuscule |
