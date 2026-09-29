import { CanonSpreadSchema, type CanonSpread } from "@narralume/contracts";
import { estimateTokens } from "@narralume/context";
import type {
  NarrativeRunStep,
  NarrativeSummary,
  OutlineNode,
  RunBudgetUsage,
  RunSnapshot,
} from "@narralume/domain";
import type {
  StepExecutionResult,
  StepWorker,
  WorkerRegistry,
} from "@narralume/harness";
import {
  SqliteCanonRepository,
  SqliteDocumentRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteReviewRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

import {
  candidateAfterInstructions,
  candidateSemanticIssues,
  materializeCandidateItems,
  readCanonSpread,
  type CanonSpreadState,
} from "./canon-candidate-context.js";
import {
  CANON_CANDIDATE_MODEL_CONTRACT,
  CanonCandidateModelResultSchema,
  canonCandidateModelValidator,
} from "./canon-candidate-schemas.js";
import { instructionsFor, promptLanguageOf } from "./prompt-language.js";
import {
  detectManuscriptLanguage,
  manuscriptLanguageHint,
  type DetectedManuscriptLanguage,
} from "./manuscript-language.js";
import type { NarrativeModelClient } from "./model-client.js";
import { requireActiveProject } from "./project-guard.js";

interface CanonContextArtifact extends Readonly<Record<string, unknown>> {
  spread: CanonSpread;
  instruction: string;
  baseFingerprint: string;
  current: CanonSpreadState["value"];
  prompt: string;
  /** 从近期正文与章节摘要检测出的作品语言；早于此字段的产物读作 unknown。 */
  manuscriptLanguage: DetectedManuscriptLanguage;
}

/** 故事圣经候选的文字跟随作品正文的语言，而非指令语言：作品语言只有 zh-CN / en，
 *  导入的其他语言（如葡语）原稿也必须得到同语言的候选。 */
const CANON_LANGUAGE_INVARIANT = {
  "zh-CN":
    "语言不变量：summary、每项的 title、rationale、impact，以及 afterJson 中的所有文字字段（名称、别名、描述、摘要、目标、冲突、谓词与值、关系、事件标题等）必须使用作品正文（recentManuscript 与章节摘要）的语言书写，即使它不同于本指令的语言；作品还没有正文时沿用故事圣经已有内容的语言。人物、地点等专有名词保留原文写法，不得翻译。字段名、枚举值与 ID 保持结构定义不变。",
  en: "Language invariant: write summary, every item's title, rationale, and impact, and every text field inside afterJson (names, aliases, descriptions, summaries, goals, conflicts, predicates and values, relations, event titles, and so on) in the language of the work's prose (recentManuscript and the chapter summaries), even when it differs from the language of these instructions; when the work has no prose yet, follow the language of the existing Story Bible content. Keep character, place, and other proper names exactly as written in the source, never translated. Field names, enum values, and IDs stay as defined by the schema.",
} as const;

export class CanonCandidateWorkerSuite {
  private readonly canon: SqliteCanonRepository;
  private readonly documents: SqliteDocumentRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly reviews: SqliteReviewRepository;
  private readonly story: SqliteStoryRepository;
  private readonly state: SqliteNarrativeStateRepository;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly model: NarrativeModelClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.canon = new SqliteCanonRepository(database);
    this.documents = new SqliteDocumentRepository(database);
    this.projects = new SqliteProjectRepository(database);
    this.reviews = new SqliteReviewRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.state = new SqliteNarrativeStateRepository(
      database,
      this.canon,
      this.story,
    );
  }

  registry(): WorkerRegistry {
    return {
      "canon.context": this.worker(this.compileContext.bind(this)),
      "canon.candidate": this.worker(this.generateCandidate.bind(this)),
      "canon.stage": this.worker(this.stageCandidate.bind(this)),
    };
  }

  private worker(
    execute: (
      snapshot: RunSnapshot,
      step: NarrativeRunStep,
      signal: AbortSignal,
    ) => Promise<StepExecutionResult>,
  ): StepWorker {
    return {
      execute: (snapshot, step, signal) => {
        requireActiveProject(this.database, snapshot.run.projectId);
        return execute(snapshot, step, signal);
      },
    };
  }

  private async compileContext(
    snapshot: RunSnapshot,
  ): Promise<StepExecutionResult> {
    const project = this.projects.get(snapshot.run.projectId);
    if (!project) throw permanent("project.not_found", "Project not found");
    const spread = CanonSpreadSchema.parse(
      policyString(snapshot.run.policy, "canonSpread"),
    );
    const instruction = policyString(snapshot.run.policy, "canonInstruction");
    const current = readCanonSpread(this.database, project.id, spread);
    const outline = this.story.listOutline(project.id);
    const entities = this.canon.listEntities(project.id, {
      includeRetired: true,
    });
    const documents = this.documents
      .list(project.id)
      .filter((document) => document.currentVersionId)
      .slice(-8)
      .map((document) => {
        const version = this.documents.getVersion(
          project.id,
          document.id,
          document.currentVersionId!,
        );
        return {
          id: document.id,
          title: document.title,
          kind: document.kind,
          outlineNodeId: document.outlineNodeId,
          content: version ? clipText(version.content, 10_000) : null,
        };
      });
    const packet = {
      task: {
        spread,
        instruction,
        afterJsonFields: candidateAfterInstructions(spread),
      },
      project: {
        id: project.id,
        title: project.title,
        premise: project.premise,
        language: project.language,
      },
      currentSpread: current.value,
      supportingIndex: {
        authorIntent: this.story.getAuthorIntent(project.id),
        outline: outline.slice(0, 200).map((node) => ({
          id: node.id,
          parentId: node.parentId,
          kind: node.kind,
          title: node.title,
          summary: node.summary,
          goal: node.goal,
          status: node.status,
        })),
        entities: entities.slice(0, 240).map((entity) => ({
          id: entity.id,
          type: entity.type,
          name: entity.name,
          aliases: entity.aliases,
          description: entity.description,
        })),
        chapterSummaries: {
          omittedEarlierChapters: 0,
          chapters: [] as ReturnType<
            typeof boundedChapterSummaries
          >["chapters"],
        },
      },
      recentManuscript: documents,
    };
    const contextWindow =
      this.model.effectiveContextWindow?.(snapshot.run, "canon-revision") ??
      64_000;
    packet.supportingIndex.chapterSummaries = boundedChapterSummaries(
      this.state.listLatestSummaries(project.id, "chapter"),
      outline,
      chapterSummaryTokenBudget({
        contextWindow,
        outputReserve: Math.min(
          policyNumber(
            snapshot.run.policy,
            "canonMaxOutputTokens",
            CANON_MAX_OUTPUT_TOKENS,
          ),
          this.model.effectiveOutputLimit?.(snapshot.run, "canon-revision") ??
            CANON_MAX_OUTPUT_TOKENS,
          Math.floor(contextWindow * 0.4),
        ),
        basePromptTokens: estimateTokens(JSON.stringify(packet)),
      }),
    );
    const detectionText = [
      ...documents.map((document) => document.content ?? ""),
      ...packet.supportingIndex.chapterSummaries.chapters.map(
        (chapter) => chapter.summary,
      ),
    ].join("\n\n");
    return {
      artifactKind: "canon-context",
      output: {
        spread,
        instruction,
        baseFingerprint: current.fingerprint,
        current: current.value,
        prompt: JSON.stringify(packet),
        manuscriptLanguage: detectManuscriptLanguage(detectionText),
      } satisfies CanonContextArtifact,
      usage: zeroUsage(),
    };
  }

  private async generateCandidate(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const context = canonContextArtifact(
      requiredArtifact(snapshot, "canon.context"),
    );
    const language =
      this.projects.get(snapshot.run.projectId)?.language ?? null;
    // 候选文字跟随作品正文的语言（指令里的语言不变量）；检测出语言时再加一行参考。
    const languageHint = manuscriptLanguageHint(
      promptLanguageOf(language),
      context.manuscriptLanguage,
    );
    const result = await this.model.structured(
      snapshot.run,
      step,
      "canon-revision",
      {
        instructions: instructionsFor(language, {
          "zh-CN": [
            "你是长篇小说的故事圣经编辑。只根据提供的作品材料，为指定 Canon Spread 生成少量、可逐项裁定的候选修改。",
            "不要直接改写数据库，不要声称候选已经生效。每项必须说明理由和影响；没有必要的改动不要凑数。",
            "create 的 targetId 必须为 null；update 必须使用 currentSpread 中真实存在的 id。作者意图只能 update 且 targetId 固定为 intent。",
            "只有 facts 可以 withdraw，此时 afterJson 为 null；其他 create/update 的 afterJson 必须是一个 JSON 对象序列化后的字符串。",
            `afterJson 只能使用这些字段：${candidateAfterInstructions(context.spread)}。update 只放要改的字段，create 提供完整必填字段。`,
            "引用实体、大纲、因果或依赖时只能使用 supportingIndex 中给出的真实 ID。不得生成数据库 ID。",
            "不要修改锁定策略本身；如果建议触及锁定内容，仍作为候选说明，系统会要求作者二次确认。",
            CANON_LANGUAGE_INVARIANT["zh-CN"],
          ],
          en: [
            "You are the story bible editor of a long-form novel. Working only from the provided project material, generate a small number of individually adjudicable change candidates for the given Canon Spread.",
            "Never rewrite the database directly and never claim candidates took effect. Every item must state its reasoning and impact; do not pad with unnecessary changes.",
            "create's targetId must be null; update must use ids that actually exist in currentSpread. Author intent may only be updated, with targetId fixed to intent.",
            "Only facts can be withdrawn, with afterJson null in that case; every other create/update must carry afterJson as a serialized JSON object string.",
            `afterJson accepts only these fields: ${candidateAfterInstructions(context.spread)}. update carries only changed fields; create provides every required field.`,
            "When referencing entities, outline nodes, causes, or dependencies, use only real IDs given in supportingIndex. Never invent database IDs.",
            "Do not modify lock policies themselves; when a suggestion touches locked content, still describe it as a candidate and the system will ask the author to confirm again.",
            CANON_LANGUAGE_INVARIANT.en,
          ],
        }),
        messages: [
          {
            role: "user",
            content: languageHint
              ? `${languageHint}\n\n${context.prompt}`
              : context.prompt,
          },
        ],
        reasoningEffort: "medium",
        maxOutputTokens: policyNumber(
          snapshot.run.policy,
          "canonMaxOutputTokens",
          CANON_MAX_OUTPUT_TOKENS,
        ),
      },
      CANON_CANDIDATE_MODEL_CONTRACT,
      canonCandidateModelValidator((value) =>
        candidateSemanticIssues(context.spread, context.current, value),
      ),
      signal,
    );
    return {
      artifactKind: "canon-candidate",
      output: {
        ...result.value,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private async stageCandidate(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
  ): Promise<StepExecutionResult> {
    const context = canonContextArtifact(
      requiredArtifact(snapshot, "canon.context"),
    );
    const generatedArtifact = requiredArtifact(snapshot, "canon.candidate");
    const generated = CanonCandidateModelResultSchema.parse({
      summary: generatedArtifact.summary,
      items: generatedArtifact.items,
    });
    const changeSetId = `${snapshot.run.id}:canon-change-set`;
    const items = materializeCandidateItems(
      snapshot.run.projectId,
      context.spread,
      context.current,
      generated,
    );
    this.reviews.insertCanonChangeSet({
      id: changeSetId,
      projectId: snapshot.run.projectId,
      runId: snapshot.run.id,
      stepId: step.id,
      changes: {
        kind: "canon_spread_revision",
        spread: context.spread,
        instruction: context.instruction,
        summary: generated.summary,
        baseFingerprint: context.baseFingerprint,
        items,
      },
      status: "candidate",
      createdAt: this.now().toISOString(),
    });
    return {
      artifactKind: "canon-candidate-set",
      output: {
        candidateSetId: changeSetId,
        spread: context.spread,
        itemCount: items.length,
      },
      usage: zeroUsage(),
    };
  }
}

function canonContextArtifact(
  value: Readonly<Record<string, unknown>>,
): CanonContextArtifact {
  return {
    spread: CanonSpreadSchema.parse(value.spread),
    instruction: stringField(value, "instruction"),
    baseFingerprint: stringField(value, "baseFingerprint"),
    current:
      value.current === null ||
      Array.isArray(value.current) ||
      isRecord(value.current)
        ? value.current
        : null,
    prompt: stringField(value, "prompt"),
    manuscriptLanguage: detectedLanguageField(value.manuscriptLanguage),
  };
}

const DETECTED_LANGUAGES: readonly DetectedManuscriptLanguage[] = [
  "Portuguese",
  "Spanish",
  "English",
  "Chinese",
  "unknown",
];

function detectedLanguageField(value: unknown): DetectedManuscriptLanguage {
  return DETECTED_LANGUAGES.find((language) => language === value) ?? "unknown";
}

function requiredArtifact(
  snapshot: RunSnapshot,
  kind: NarrativeRunStep["kind"],
): Readonly<Record<string, unknown>> {
  const artifact = [...snapshot.steps]
    .reverse()
    .find(
      (candidate) =>
        candidate.kind === kind && candidate.status === "succeeded",
    )?.outputArtifact;
  if (!artifact)
    throw permanent("artifact.missing", `Missing artifact for step ${kind}`);
  return artifact;
}

function policyString(
  policy: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = policy[key];
  if (typeof value !== "string" || !value.trim())
    throw permanent("policy.value.invalid", `Run policy is missing ${key}`);
  return value;
}

function policyNumber(
  policy: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = policy[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const entry = value[key];
  if (typeof entry !== "string" || !entry.trim())
    throw permanent("artifact.value.invalid", `Artifact is missing ${key}`);
  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const CHAPTER_SUMMARY_CHAR_BUDGET = 60_000;
const CHAPTER_SUMMARY_MAX = 800;
const CHAPTER_SUMMARY_MIN = 120;
/** Per-summary lengths tried from longest to shortest. */
const CHAPTER_SUMMARY_LENGTHS = [
  CHAPTER_SUMMARY_MAX,
  480,
  280,
  CHAPTER_SUMMARY_MIN,
];
/** Largest share of the effective context window the summaries may take. */
const CHAPTER_SUMMARY_WINDOW_SHARE = 0.25;
/** JSON wrapper of one summary entry (keys, id, quotes) beyond its text. */
const CHAPTER_SUMMARY_ENTRY_TOKENS = 24;
/** Held back for the instructions and the structured-output contract. */
const CANON_INSTRUCTION_RESERVE_TOKENS = 4_000;
const CANON_MAX_OUTPUT_TOKENS = 6_000;

/**
 * Tokens the chapter summaries may use in a spread revision prompt. It
 * mirrors the model client's input check (estimate ×1.12 + 256 plus a safety
 * band of max(1,024, 2% of the window)) and keeps the output reserve free, so
 * the finished prompt fits the effective context window of the assigned
 * model instead of failing with model.context_length.
 */
function chapterSummaryTokenBudget(input: {
  contextWindow: number;
  outputReserve: number;
  basePromptTokens: number;
}): number {
  const safety = Math.max(1_024, Math.ceil(input.contextWindow * 0.02));
  const inputCapacity = Math.floor(
    (input.contextWindow - input.outputReserve - safety - 256) / 1.12,
  );
  const available =
    inputCapacity - input.basePromptTokens - CANON_INSTRUCTION_RESERVE_TOKENS;
  return Math.max(
    0,
    Math.min(
      available,
      Math.floor(input.contextWindow * CHAPTER_SUMMARY_WINDOW_SHARE),
    ),
  );
}

/**
 * Whole-book chapter summaries in reading order, so a spread revision sees
 * more than the last few manuscripts. They share a token budget derived from
 * the model's effective context window (and a fixed character ceiling):
 * each summary is shortened step by step towards a minimum length; when even
 * that does not fit, only the most recent chapters are kept and the omission
 * is stated.
 */
function boundedChapterSummaries(
  summaries: readonly NarrativeSummary[],
  outline: readonly OutlineNode[],
  tokenBudget: number,
): {
  omittedEarlierChapters: number;
  chapters: { outlineNodeId: string; title: string; summary: string }[];
} {
  const chapters = new Map(
    outline
      .filter((node) => node.kind === "chapter")
      .map((node, index) => [node.id, { node, index }]),
  );
  const ordered = summaries
    .filter((summary) => chapters.has(summary.scopeId) && summary.summary)
    .toSorted(
      (left, right) =>
        chapters.get(left.scopeId)!.index - chapters.get(right.scopeId)!.index,
    );
  const entry = (summary: NarrativeSummary, limit: number) => ({
    outlineNodeId: summary.scopeId,
    title: chapters.get(summary.scopeId)!.node.title,
    summary: clipText(summary.summary, limit),
  });
  /* Most recent chapters that fit at this length, oldest first. */
  const fitting = (limit: number) => {
    const kept: ReturnType<typeof entry>[] = [];
    let tokens = 0;
    let characters = 0;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const next = entry(ordered[index]!, limit);
      tokens +=
        estimateTokens(next.title) +
        estimateTokens(next.summary) +
        CHAPTER_SUMMARY_ENTRY_TOKENS;
      characters += next.summary.length;
      if (tokens > tokenBudget || characters > CHAPTER_SUMMARY_CHAR_BUDGET) {
        break;
      }
      kept.push(next);
    }
    return kept.reverse();
  };
  let kept: ReturnType<typeof entry>[] = [];
  for (const limit of CHAPTER_SUMMARY_LENGTHS) {
    kept = fitting(limit);
    if (kept.length === ordered.length) break;
  }
  return {
    omittedEarlierChapters: ordered.length - kept.length,
    chapters: kept,
  };
}

function clipText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.floor(limit * 0.7))}\n\n[中间内容已省略]\n\n${value.slice(-Math.ceil(limit * 0.3))}`;
}

function zeroUsage(): RunBudgetUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    costUsd: 0,
    wallTimeMs: 0,
  };
}

function permanent(code: string, message: string): Error {
  const error = new Error(message) as Error & {
    code: string;
    retryable: boolean;
  };
  error.code = code;
  error.retryable = false;
  return error;
}
