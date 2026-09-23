# Vérification de la preuve — Cowork 4.0

## Règle

Une preuve **présente** ne vaut pas une preuve **démontrée**.

| Type de critère | Vérifié si | Échec si |
|---|---|---|
| Commande (ex. `npm test`) | une preuve porte la même commande **et** `exitCode === 0` | une preuve porte la commande avec un code de sortie non nul |
| Inspection (`inspection:<label>`) | une preuve de type review/note/artifact/diff porte un contenu réel (>= 10 caractères de sortie, ou un diff) | aucune preuve, ou une preuve sans contenu |
| Preuve déclarée requise (`requiredEvidence`) | la preuve existe, et si elle déclare une commande celle-ci a exit 0 | absente, commande différente, ou code de sortie non nul |

## Notes

- Les critères optionnels (`required: false`) ne bloquent jamais.
- Une déclaration `expectedEvidence: [diff]` est ignorée : le diff est fourni et compté par le checkpoint lui-même.
- Pour une tâche isolée en worktree, le diff est capturé **avant** le nettoyage du worktree et rattaché à la preuve, sinon il serait invérifiable.
- Les commandes de preuve sont **ré-exécutées par le processus principal** : la sortie déclarée par l'agent n'est jamais crue sur parole.

## Tests

`tests/workflow-verification.test.ts`, `tests/workflow-executor.test.ts`, `tests/workflow-orchestrator.test.ts`, `tests/proof-runner.test.ts`.
