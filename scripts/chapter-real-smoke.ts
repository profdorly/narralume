import { resolve } from "node:path";

import { config as loadDotEnv } from "dotenv";

import { seedEnvironmentModelConfig } from "@lapis/services";
import { resolveEffectivePolicy } from "@lapis/contracts";
import {
  createOutlineNode,
  createProject,
  type RunStatus,
} from "@lapis/domain";
import { buildChapterRecipe, HarnessSupervisor } from "@lapis/harness";
import {
  ChapterWorkerSuite,
  GatewayNarrativeModelClient,
} from "@lapis/narrative";
import {
  SqliteAssignmentRepository,
  SqliteDocumentRepository,
  SqliteLlmCallRepository,
  SqliteModelRepository,
  SqliteProjectRepository,
  SqliteProviderRepository,
  SqliteReviewRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  resolveCredential,
  type StoredProvider,
} from "@lapis/persistence";
import { NodeNarrativeDatabase } from "@lapis/persistence/node";

import {
  createSmokeWorkspace,
  currentGitCommit,
  finalizeSmokeWorkspace,
  installSignalFlush,
  interruptOrphanedWork,
  originOf,
  parseRealSmokeArgs,
  RunWatcher,
  RunStateTracker,
  SmokeLogger,
  writeSmokeSummary,
  type SmokeCheck,
} from "./real-smoke-harness.js";

loadDotEnv({ path: resolve(process.cwd(), ".env.local"), quiet: true });

const scenario = "chapter-real";
const args = parseRealSmokeArgs(process.argv.slice(2), {
  script: "chapter-real-smoke.ts",
  defaultProtocols: ["openai-chat", "openai-responses", "anthropic-messages"],
});
const workspace = createSmokeWorkspace(scenario, { outputDir: args.outputDir });
const logger = new SmokeLogger(workspace.jsonlPath, scenario, {
  diagnostic: args.diagnostic,
});
installSignalFlush(logger);
const startedAt = new Date().toISOString();
const checks: SmokeCheck[] = [];
const chapterResults: Array<{
  protocol: string;
  runId: string;
  status: RunStatus;
  documentVersionId: string | null;
  contentHash: string | null;
  characters: number;
  reviews: number;
}> = [];

const database = new NodeNarrativeDatabase(workspace.dbPath);
database.migrate();
interruptOrphanedWork(logger, database);
seedEnvironmentModelConfig(database, process.env);
const providers = new SqliteProviderRepository(database);
const models = new SqliteModelRepository(database);
const assignments = new SqliteAssignmentRepository(database);
const providerByWireApi = new Map<string, StoredProvider>(
  providers.list(true).map((provider) => [provider.wireApi, provider]),
);
const model = new GatewayNarrativeModelClient(database, process.env);
const suite = new ChapterWorkerSuite(database, model);
const runs = new SqliteRunRepository(database);
const supervisor = new HarnessSupervisor(runs, suite.registry(), {
  retryDelayMs: 10,
});
const tracker = new RunStateTracker(logger, database, {
  diagnostic: args.diagnostic,
});
const watcher = new RunWatcher(tracker);
watcher.startPolling();
const terminal = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
  "awaiting_user",
]);
let failed = false;

logger.event("scenario.start", {
  protocols: args.protocols,
  workspace: workspace.dir,
  gitCommit: currentGitCommit(),
});

try {
  for (const protocol of args.protocols) {
    const provider = providerByWireApi.get(protocol);
    const writingModel = provider
      ? models.listByProvider(provider.id, true)[0]
      : undefined;
    const credential = provider
      ? resolveCredential(provider, process.env)
      : null;
    if (!provider || !writingModel || !credential?.ok) {
      process.stdout.write(
        `${protocol}: SKIPPED (missing local configuration)\n`,
      );
      checks.push({
        name: `${protocol} configured`,
        ok: false,
        detail: "missing local configuration",
      });
      failed = true;
      continue;
    }
    // The runtime resolves calls through the writing assignment; point it at
    // this protocol's environment model for the duration of the run.
    assignments.set("writing", writingModel.id, new Date().toISOString());
    logger.event("model.resolved", {
      protocol: provider.wireApi,
      model: writingModel.modelId,
      baseUrlOrigin: originOf(provider.baseUrl),
    });
    const now = new Date().toISOString();
    const projectId = `real-${protocol}`;
    const chapterId = `${projectId}-chapter`;
    new SqliteProjectRepository(database).insert(
      createProject({
        id: projectId,
        title: `Prova real de protocolo · ${protocol}`,
        premise:
          "O guarda-noturno percebe: cada minuto atrasado no relógio da estação abandonada faz alguém esquecer o amanhã.",
        now,
      }),
    );
    const story = new SqliteStoryRepository(database);
    const root = story.insertOutlineNode(
      createOutlineNode({
        id: `${projectId}-book`,
        projectId,
        parent: null,
        kind: "book",
        ordinal: 0,
        title: "Estação do relógio atrasado",
        now,
      }),
    );
    story.insertOutlineNode(
      createOutlineNode({
        id: chapterId,
        projectId,
        parent: root,
        kind: "chapter",
        ordinal: 0,
        title: "O minuto que atrasa",
        summary:
          "O guarda-noturno vê o relógio da estação andar para trás e percebe que a passageira esqueceu o combinado de amanhã.",
        goal: "Estabelecer, com ação visível, a regra causal entre o relógio e o esquecimento",
        conflict: "A única passageira insiste que a estação nunca teve relógio",
        outcome:
          "Ele deixa uma marca verificável e decide continuar a investigação",
        now,
      }),
    );
    story.upsertAuthorIntent({
      projectId,
      promise:
        "A regra sobrenatural precisa ser observável, ter custo e ser coerente.",
      themes: ["memória", "tempo", "responsabilidade"],
      audience: "leitores adultos de ficção de gênero",
      tone: "contido, concreto, com suspense baixo",
      boundaries: [
        "sem metadiscurso do modelo",
        "não explicar o tema num parágrafo-resumo",
      ],
      endingDirection: null,
      currentFocus: "estabelecer a primeira regra verificável",
      lockedFields: ["promise", "boundaries"],
      updatedAt: now,
    });

    const runId = `${projectId}-run`;
    const recipe = buildChapterRecipe(runId, 2);
    runs.create({
      id: runId,
      projectId,
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "autopilot",
      targetOutlineNodeId: chapterId,
      policy: resolveEffectivePolicy({
        requestStartTimeoutMs: 45_000,
        maxRetries: 1,
        // Small models need one more repair round with feedback for review
        // citations (observed in M6).
        maxRepairAttempts: 2,
        contextWindow: 128_000,
        // Reasoning models count reasoning tokens against the output budget; a
        // structured/revision call budget that is too low truncates the JSON
        // (found in the M5 baseline).
        draftMaxOutputTokens: 32_000,
        reviewMaxOutputTokens: 24_000,
        settlementMaxOutputTokens: 24_000,
        minChapterCharacters: 180,
      }).effectivePolicy,
      steps: recipe.steps,
      now,
    });
    logger.event("run.created", { runId, projectId, protocol });
    watcher.track(runId);

    const started = Date.now();
    for (let index = 0; index < 200; index += 1) {
      const status = runs.getRun(runId)?.status;
      if (status && terminal.has(status)) break;
      const processed = await supervisor.processRun(
        runId,
        `real-smoke-${protocol}`,
      );
      tracker.diff(runId);
      if (!processed) {
        // Since M3, step retries use backoff: processRun returns false while
        // the job's available_at is in the future. While the run is still
        // failed_recoverable/running, wait out the backoff window and keep
        // driving instead of mistaking it for a stall and exiting.
        const current = runs.getRun(runId)?.status;
        if (current === "failed_recoverable" || current === "running") {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        break;
      }
    }
    tracker.diff(runId);
    const snapshot = runs.getSnapshot(runId);
    const documents = new SqliteDocumentRepository(database).list(
      projectId,
      "chapter",
    );
    const document = documents[0];
    const version = document?.currentVersionId
      ? new SqliteDocumentRepository(database).getVersion(
          projectId,
          document.id,
          document.currentVersionId,
        )
      : null;
    const calls = new SqliteLlmCallRepository(database).listForRun(runId);
    const reviews = new SqliteReviewRepository(database).listReports(runId);
    chapterResults.push({
      protocol,
      runId,
      status: snapshot.run.status,
      documentVersionId: version?.id ?? null,
      contentHash: version?.contentHash ?? null,
      characters: version ? [...version.content].length : 0,
      reviews: reviews.length,
    });
    process.stdout.write(
      `${protocol}: ${snapshot.run.status.toUpperCase()} · ${calls.length} calls · ${version ? [...version.content].length : 0} chars · ${reviews.length} reviews · ${Date.now() - started} ms\n`,
    );
    const ok = snapshot.run.status === "completed" && Boolean(version?.content);
    checks.push({
      name: `${protocol} chapter completed`,
      ok: snapshot.run.status === "completed",
      detail: `status=${snapshot.run.status}`,
    });
    checks.push({
      name: `${protocol} chapter content`,
      ok: Boolean(version?.content),
      detail: `${version ? [...version.content].length : 0} chars`,
    });
    logger.event("scenario.check", {
      protocol,
      ok,
      status: snapshot.run.status,
      calls: calls.length,
      characters: version ? [...version.content].length : 0,
    });
    if (!ok) {
      failed = true;
      const failedStep = snapshot.steps.find(
        (step) => step.status === "failed",
      );
      if (failedStep?.error) {
        process.stdout.write(
          `  ${failedStep.kind}: ${failedStep.error.code} · ${failedStep.error.message.slice(0, 300)}\n`,
        );
        if (failedStep.error.details) {
          process.stdout.write(
            `  details: ${JSON.stringify(failedStep.error.details).slice(0, 1_000)}\n`,
          );
        }
      }
      for (const call of calls) {
        process.stdout.write(
          `  call ${call.purpose}: ${call.status} · ${call.finishReason ?? "no-finish"} · output ${call.usage?.outputTokens ?? 0} · reasoning ${call.usage?.reasoningTokens ?? 0}\n`,
        );
      }
      const lastEvent = snapshot.events.at(-1);
      if (lastEvent) {
        process.stdout.write(`  last event: ${lastEvent.type}\n`);
      }
    }
  }
} catch (error) {
  failed = true;
  logger.event("scenario.error", {
    message: error instanceof Error ? error.message : String(error),
  });
  checks.push({
    name: "scenario completed",
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
  });
} finally {
  watcher.stop();
  const success = !failed;
  logger.event("scenario.end", {
    success,
    durationMs: Date.now() - Date.parse(startedAt),
  });
  writeSmokeSummary({
    workspace,
    database,
    scenario,
    protocols: args.protocols,
    startedAt,
    success,
    checks,
    extra: { chapters: chapterResults },
  });
  database.close();
  finalizeSmokeWorkspace(workspace, {
    success,
    keepArtifacts: args.keepArtifacts,
  });
}

if (failed) {
  process.stderr.write(
    "One or more real chapter pipelines did not complete.\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write("All selected real chapter pipelines completed.\n");
}
