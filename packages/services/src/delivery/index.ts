import {
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteCreativeRepository,
  SqliteDeliveryRepository,
  SqliteDocumentRepository,
  SqliteImportUploadRepository,
  SqliteLoreRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteManuscriptIndexer,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@lapis/persistence";
import type {
  ImportFormat,
  ProjectQualityReport,
  QualityIssue,
} from "@lapis/domain";
import {
  DeliveryServiceError,
  count,
  type DeliveryContext,
  type ProjectExportOptions,
} from "./bundle.js";
import {
  applyImport,
  completeUpload,
  createUpload,
  discardImport,
  previewImport,
  putUploadChunk,
} from "./import.js";
import { exportProject } from "./export.js";
import { createBackup, duplicateProject, restoreBackup } from "./backup.js";
import { buildBundle } from "./bundle.js";

export {
  DeliveryServiceError,
  type NarrativeBundle,
  type ProjectExportOptions,
} from "./bundle.js";

export class DeliveryService {
  private readonly projects: SqliteProjectRepository;
  private readonly story: SqliteStoryRepository;
  private readonly canon: SqliteCanonRepository;
  private readonly documents: SqliteDocumentRepository;
  private readonly state: SqliteNarrativeStateRepository;
  private readonly creative: SqliteCreativeRepository;
  private readonly lore: SqliteLoreRepository;
  private readonly delivery: SqliteDeliveryRepository;
  private readonly automation: SqliteAutomationRepository;
  private readonly uploads: SqliteImportUploadRepository;
  private readonly indexer: SqliteManuscriptIndexer;

  constructor(private readonly database: NarrativeDatabase) {
    this.projects = new SqliteProjectRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.canon = new SqliteCanonRepository(database);
    this.documents = new SqliteDocumentRepository(database);
    this.state = new SqliteNarrativeStateRepository(
      database,
      this.canon,
      this.story,
    );
    this.creative = new SqliteCreativeRepository(database);
    this.lore = new SqliteLoreRepository(database);
    this.delivery = new SqliteDeliveryRepository(database);
    this.automation = new SqliteAutomationRepository(database);
    this.uploads = new SqliteImportUploadRepository(database);
    this.indexer = new SqliteManuscriptIndexer(database);
  }

  private ctx(): DeliveryContext {
    return {
      database: this.database,
      projects: this.projects,
      story: this.story,
      canon: this.canon,
      documents: this.documents,
      state: this.state,
      creative: this.creative,
      lore: this.lore,
      delivery: this.delivery,
      automation: this.automation,
      uploads: this.uploads,
      indexer: this.indexer,
    };
  }

  createUpload(input: {
    id: string;
    targetProjectId: string | null;
    filename: string;
    format: ImportFormat;
    totalBytes: number;
    chunkSize: number;
    expectedHash: string | null;
    now: string;
  }) {
    return createUpload(this.ctx(), input);
  }

  putUploadChunk(input: {
    sessionId: string;
    chunkIndex: number;
    contentBase64: string;
    chunkHash: string;
    now: string;
  }) {
    return putUploadChunk(this.ctx(), input);
  }

  async completeUpload(sessionId: string, now: string) {
    return completeUpload(this.ctx(), sessionId, now);
  }

  async previewImport(input: {
    targetProjectId: string | null;
    filename: string;
    format: ImportFormat;
    contentBase64: string;
    now: string;
  }) {
    return previewImport(this.ctx(), input);
  }

  applyImport(input: {
    batchId: string;
    selectedCandidateIds: readonly string[];
    projectTitle?: string;
    now: string;
  }) {
    return applyImport(this.ctx(), input);
  }

  discardImport(batchId: string, now: string) {
    return discardImport(this.ctx(), batchId, now);
  }

  buildBundle(projectId: string, now: string, options?: ProjectExportOptions) {
    return buildBundle(this.ctx(), projectId, now, options);
  }

  async exportProject(
    projectId: string,
    format: "markdown" | "text" | "docx" | "epub" | "narrative-bundle",
    now: string,
    options?: ProjectExportOptions,
  ) {
    return exportProject(this.ctx(), projectId, format, now, options);
  }

  createBackup(projectId: string, label: string, now: string) {
    return createBackup(this.ctx(), projectId, label, now);
  }

  restoreBackup(backupId: string, title: string | undefined, now: string) {
    return restoreBackup(this.ctx(), backupId, title, now);
  }

  duplicateProject(projectId: string, title: string | undefined, now: string) {
    return duplicateProject(this.ctx(), projectId, title, now);
  }

  qualityReport(projectId: string, now: string): ProjectQualityReport {
    const project = this.projects.get(projectId);
    if (!project)
      throw new DeliveryServiceError("project.not_found", "Project not found");
    const outline = this.story.listOutline(projectId);
    const documents = this.documents.list(projectId);
    const versions = documents.flatMap((document) =>
      this.documents.listVersions(projectId, document.id),
    );
    const currentVersions = documents
      .map((document) =>
        document.currentVersionId
          ? this.documents.getVersion(
              projectId,
              document.id,
              document.currentVersionId,
            )
          : null,
      )
      .filter((version): version is NonNullable<typeof version> =>
        Boolean(version),
      );
    const facts = this.canon.listEffectiveFacts(projectId, {
      includeCandidates: true,
    });
    const entities = this.canon.listEntities(projectId, {
      includeRetired: true,
    });
    const foreshadows = this.state.listForeshadows(projectId);
    const openComments = count(
      this.database,
      `SELECT COUNT(*) AS count FROM document_comments WHERE project_id = ? AND status = 'open'`,
      projectId,
    );
    const metrics = {
      outlineNodes: outline.length,
      chapters: outline.filter((node) => node.kind === "chapter").length,
      committedChapters: outline.filter(
        (node) => node.kind === "chapter" && node.status === "committed",
      ).length,
      documents: documents.length,
      versions: versions.length,
      manuscriptCharacters: currentVersions.reduce(
        (sum, version) => sum + [...version.content].length,
        0,
      ),
      entities: entities.length,
      facts: facts.length,
      candidateFacts: facts.filter((fact) => fact.authority === "candidate")
        .length,
      unresolvedForeshadows: foreshadows.filter(
        (item) => !["resolved", "abandoned"].includes(item.status),
      ).length,
      openComments,
      activeStyleProfiles: this.delivery.getActiveStyleProfile(projectId)
        ? 1
        : 0,
      enabledSkills: this.delivery.listWritingSkills(projectId, true).length,
    };
    const issues: QualityIssue[] = [];
    const add = (
      category: QualityIssue["category"],
      severity: QualityIssue["severity"],
      message: string,
      suggestion: string,
      targetType: string | null = null,
      targetId: string | null = null,
    ) =>
      issues.push({
        id: `quality:${issues.length + 1}`,
        category,
        severity,
        message,
        targetType,
        targetId,
        suggestion,
      });
    if (!project.premise)
      add(
        "structure",
        "warning",
        "A obra ainda não tem uma premissa em uma frase",
        "Fixe o conflito central na intenção da autoria",
      );
    if (!this.story.getAuthorIntent(projectId)?.promise)
      add(
        "structure",
        "warning",
        "Ainda não há uma promessa central ao leitor",
        "Complete e trave a intenção da autoria",
      );
    if (metrics.chapters === 0)
      add(
        "structure",
        "error",
        "A estrutura não tem nós de capítulo",
        "Crie capítulos ou rode o planejamento contínuo",
      );
    if (metrics.manuscriptCharacters === 0)
      add(
        "manuscript",
        "error",
        "Ainda não há prosa entregável",
        "Escreva, importe ou aceite ao menos uma cena",
      );
    for (const document of documents) {
      if (!document.currentVersionId) {
        add(
          "manuscript",
          "warning",
          `“${document.title}” ainda está em branco`,
          "Escreva prosa ou arquive este manuscrito",
          "document",
          document.id,
        );
      }
    }
    if (metrics.candidateFacts > 0)
      add(
        "canon",
        "warning",
        metrics.candidateFacts === 1
          ? "1 fato candidato ainda não foi julgado"
          : `${metrics.candidateFacts} fatos candidatos ainda não foram julgados`,
        "Confirme, promova ou descarte os candidatos na Bíblia da história",
      );
    if (metrics.unresolvedForeshadows > 0)
      add(
        "continuity",
        "info",
        metrics.unresolvedForeshadows === 1
          ? "1 antecipação ainda está em aberto"
          : `${metrics.unresolvedForeshadows} antecipações ainda estão em aberto`,
        "Antes de exportar, confirme que elas são intencionais, não esquecidas",
      );
    if (openComments > 0)
      add(
        "workflow",
        "warning",
        openComments === 1
          ? "1 anotação do manuscrito ainda está aberta"
          : `${openComments} anotações do manuscrito ainda estão abertas`,
        "Trate cada uma ou deixe explícito que ficam para a próxima revisão",
      );
    if (!metrics.activeStyleProfiles)
      add(
        "manuscript",
        "info",
        "Nenhum perfil de estilo está ativo",
        "Para um tom estável em texto longo, extraia de uma amostra ou crie um perfil",
      );
    const deduction = issues.reduce(
      (sum, issue) =>
        sum +
        (issue.severity === "error"
          ? 18
          : issue.severity === "warning"
            ? 7
            : 2),
      0,
    );
    const gates = [
      {
        id: "author-promise",
        label: "Promessa da autoria travada",
        passed: Boolean(this.story.getAuthorIntent(projectId)?.promise?.trim()),
        message:
          "Antes de entregar, deixe claro o que a obra promete ao leitor.",
        targetType: "author-intent",
        targetId: projectId,
      },
      {
        id: "chapter-plan",
        label: "Estrutura de capítulos estabelecida",
        passed: metrics.chapters > 0,
        message:
          "Crie ao menos um nó de capítulo para que a exportação tenha estrutura verificável.",
        targetType: "outline",
        targetId: null,
      },
      {
        id: "chapter-commitment",
        label: "Capítulos planejados já registrados",
        passed:
          metrics.chapters > 0 &&
          metrics.committedChapters === metrics.chapters,
        message:
          metrics.chapters === 0
            ? "Ainda não há capítulos a registrar."
            : `${metrics.committedChapters}/${metrics.chapters} ${metrics.chapters === 1 ? "capítulo registrado" : "capítulos registrados"}; capítulos incompletos não podem ser disfarçados pela nota suave.`,
        targetType: "outline",
        targetId: null,
      },
      {
        id: "manuscript-present",
        label: "Há prosa entregável",
        passed: metrics.manuscriptCharacters >= 1_000,
        message: `O manuscrito atual tem ${metrics.manuscriptCharacters} ${metrics.manuscriptCharacters === 1 ? "caractere" : "caracteres"}; a entrega só entra em julgamento a partir de 1.000.`,
        targetType: "document",
        targetId: null,
      },
      {
        id: "no-blocking-errors",
        label: "Sem erros de estrutura ou de manuscrito que bloqueiem",
        passed: !issues.some((issue) => issue.severity === "error"),
        message: "Resolva primeiro todos os itens marcados como bloqueio.",
        targetType: null,
        targetId: null,
      },
    ];
    const score = Math.max(0, 100 - deduction);
    const allGatesPassed = gates.every((gate) => gate.passed);
    return {
      projectId,
      score,
      readiness: allGatesPassed
        ? score >= 90
          ? "ready"
          : "needs_attention"
        : "blocked",
      gates,
      generatedAt: now,
      metrics,
      issues,
    };
  }
}
