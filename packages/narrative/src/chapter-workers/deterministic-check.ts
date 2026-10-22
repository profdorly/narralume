import { type RunSnapshot } from "@narralume/domain";
import type { StepExecutionResult } from "@narralume/harness";

import { proseLintIssues } from "../prose-lint.js";

import {
  type ChapterWorkerDeps,
  finalContent,
  paragraphs,
  policyNumber,
  repeatedPhraseEvidence,
  sha256,
  zeroUsage,
} from "./helpers.js";

export async function deterministicCheck(
  deps: ChapterWorkerDeps,
  snapshot: RunSnapshot,
): Promise<StepExecutionResult> {
  const content = finalContent(snapshot);
  const issues: {
    code: string;
    severity: "major" | "critical";
    message: string;
    evidence: string | null;
  }[] = [];
  const minCharacters = policyNumber(
    snapshot.run.policy,
    "minChapterCharacters",
    1_200,
  );
  if ([...content].length < minCharacters) {
    issues.push({
      code: "draft.too_short",
      severity: "major",
      message: `A prosa tem menos de ${minCharacters} caracteres`,
      evidence: null,
    });
  }
  const placeholder =
    /(\{\{[^}]+\}\}|\[待(?:补|写|定)[^\]]*\]|\bTODO\b|作为(?:一个)?AI)/i.exec(
      content,
    );
  if (placeholder) {
    issues.push({
      code: "draft.placeholder",
      severity: "critical",
      message:
        "A prosa contém placeholder de template ou autodescrição do modelo",
      evidence: placeholder[0],
    });
  }
  const seen = new Set<string>();
  for (const paragraph of paragraphs(content)) {
    const normalized = paragraph.replace(/\s+/g, "").toLowerCase();
    if (normalized.length >= 30 && seen.has(normalized)) {
      issues.push({
        code: "draft.duplicate_paragraph",
        severity: "major",
        message: "A prosa contém parágrafos longos repetidos por completo",
        evidence: paragraph.slice(0, 160),
      });
      break;
    }
    seen.add(normalized);
  }
  const bannedTerms = Array.isArray(snapshot.run.policy.bannedTerms)
    ? snapshot.run.policy.bannedTerms.filter(
        (term): term is string => typeof term === "string" && Boolean(term),
      )
    : [];
  for (const term of bannedTerms) {
    const index = content.indexOf(term);
    if (index < 0) continue;
    issues.push({
      code: "draft.banned_term",
      severity: "critical",
      message: `A prosa contém termo banido: ${term}`,
      evidence: content.slice(index, index + Math.max(term.length, 40)),
    });
  }
  const formatLeak =
    /(^|\n)\s*(?:#{1,6}\s+|```|<\/?(?:analysis|assistant|system)>)/i.exec(
      content,
    );
  if (formatLeak) {
    issues.push({
      code: "draft.format_leak",
      severity: "critical",
      message:
        "A prosa contém título Markdown, cerca de código ou etiqueta de papel do modelo",
      evidence: formatLeak[0].trim(),
    });
  }
  const sectionBreaks = content.match(
    /(?:^|\n)\s*(?:\*{3,}|-{3,})\s*(?=\n|$)/g,
  );
  if ((sectionBreaks?.length ?? 0) > 5) {
    issues.push({
      code: "draft.section_break_abuse",
      severity: "major",
      message: "A prosa usa demais separadores de cena",
      evidence: sectionBreaks?.[0]?.trim() ?? null,
    });
  }
  const repeatedPhrase = repeatedPhraseEvidence(content, 12, 4);
  if (repeatedPhrase) {
    issues.push({
      code: "draft.repeated_phrase_density",
      severity: "major",
      message: "A prosa tem frases repetidas em alta frequência",
      evidence: repeatedPhrase,
    });
  }
  issues.push(...proseLintIssues(content));
  return {
    artifactKind: "deterministic-review",
    output: {
      verdict: issues.length ? "revise" : "pass",
      issues,
      characters: [...content].length,
      paragraphs: paragraphs(content).length,
      contentHash: sha256(content),
    },
    usage: zeroUsage(),
  };
}
