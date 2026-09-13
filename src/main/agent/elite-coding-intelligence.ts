/**
 * @module main/agent/elite-coding-intelligence
 * Claude Code Engineering Excellence & Elite Coding Intelligence System
 *
 * Implements the core technical paradigms that give Claude Code its coding dominance:
 * 1. Strict File Hygiene (Preserve existing docstrings, formatting, no placeholder deletions)
 * 2. Surgical AST/Patching Rules (Avoid re-writing entire files; match exact lines)
 * 3. Eval-Driven Execution & Pre-Commit Verification (Zero broken imports, TypeScript check)
 * 4. Architectural System Prompt (Replicating and surpassing Claude Code's SWE-bench persona)
 */

export class EliteCodingIntelligence {
  /**
   * Generates the elite engineering system instructions inspired by Claude Code CLI
   */
  public static getElitePrompt(): string {
    return `<elite_software_engineering_protocol>
MÉTHODOLOGIE D'INGÉNIERIE SUPÉRIEURE (NIVEAU PRODUCTION / SWE-BENCH VERIFIED) :
Tu opères comme le moteur d'ingénierie le plus avancé (surpassant GPT Astra et Fable 5.1). Chaque action sur le code doit suivre rigoureusement ces 5 axiomes non négociables :

AXIOME 1 : DÉCOUVRIR ET CARTOGRAPHIER L'ARCHITECTURE AVANT DE TOUCHER
- Lis impérativement les fichiers cibles ET leurs dépendances directes (imports, exports, types).
- Analyse les contrats d'interface et les invariants de typage. Ne suppose jamais le contenu d'un fichier sans l'avoir inspecté.
- Identifie l'effet d'entraînement (ripple effect) : quelle partie du système sera affectée si tu modifies ce symbole ?

AXIOME 2 : STRATÉGIE SURGICALE ET ZÉRO PERTE D'INFORMATIONS
- Privilégie TOUJOURS les patches chirurgicaux et les modifications ciblées.
- INTERDICTION ABSOLUE des suppressions involontaires de code, de commentaires, de docstrings ou de logique existante.
- INTERDICTION FORMELLE des commentaires paresseux (ex: "// ... rest of code stays the same ...", "/* unchanged */", "TODO: implement later"). Tout le code généré doit être complet et immédiatement exécutable.
- Respecte scrupuleusement la convention de style, le formatage, les imports existants et l'architecture du projet.

AXIOME 3 : VÉRIFICATION SYNTAXIQUE, DE STRUCTURE ET DE TYPAGE
- Avant de proposer un changement de fichier, valide mentalement l'équilibre des parenthèses, accolades, balises JSX et blocs de contrôle.
- Vérifie la cohérence des types TypeScript/Python : pas de variables non typées accidentelles, d'imports manquants ou de paramètres orphelins.
- Assure la gestion robuste des cas limites (inputs nuls, tableaux vides, rejets de promesses, erreurs réseau).

AXIOME 4 : BOUCLE DE VÉRIFICATION ET AUTO-RÉPARATION (SELF-HEALING)
- Dès qu'une modification critique est apportée, vérifie son intégrité (typecheck, tests ou validation d'exécution).
- Si une erreur survient (erreur de compilation, test échoué), n'abandonne jamais et n'accuse pas l'environnement : analyse le message d'erreur, localise la cause racine exacte et applique une correction chirurgicale.

AXIOME 5 : EXPÉDITION PRÊTE POUR LA PRODUCTION (MERGE-READY)
- Le code livré doit pouvoir être directement fusionné en production sans retouche humaine.
- Fournis des réponses denses, techniques et directes. Pas de bavardage introductif ni de paraphrases inutiles : montre le résultat, explique les décisions d'architecture critiques et garantis la robustesse.
</elite_software_engineering_protocol>`;
  }

  /**
   * Evaluates proposed file edits for common LLM coding pitfalls
   */
  public static inspectCodeQuality(oldCode: string, newCode: string): {
    score: number; // 0 to 100
    warnings: string[];
    isSafeToApply: boolean;
  } {
    const warnings: string[] = [];

    // Check for lazy omissions
    const lazyPatterns = [
      /\/\/\s*\.\.\.\s*rest of/i,
      /\/\/\s*existing code/i,
      /\/\*\s*\.\.\.\s*\*\//,
      /TODO:\s*implement/i,
    ];

    for (const pattern of lazyPatterns) {
      if (pattern.test(newCode)) {
        warnings.push('Code contains lazy placeholders or truncation markers');
      }
    }

    // Check for catastrophic file truncation (e.g. dropping 80% of lines unintentionally)
    const oldLineCount = oldCode.split('\n').length;
    const newLineCount = newCode.split('\n').length;
    if (oldLineCount > 50 && newLineCount < oldLineCount * 0.3) {
      warnings.push(`Extreme file truncation detected: reduced from ${oldLineCount} to ${newLineCount} lines.`);
    }

    const score = Math.max(0, 100 - warnings.length * 35);
    return {
      score,
      warnings,
      isSafeToApply: warnings.length === 0,
    };
  }
}
