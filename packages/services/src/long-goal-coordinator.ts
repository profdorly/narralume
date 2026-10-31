import { sha256Hex } from "@lapis/domain";

import { AUTOMATION_DEFAULTS, resolveEffectivePolicy } from "@lapis/contracts";
import {
  SqliteAssistantLongGoalRepository,
  SqliteAssistantRepository,
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteDocumentRepository,
  SqliteProjectRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  type AssistantLongGoal,
  type NarrativeDatabase,
} from "@lapis/persistence";

import type { AutopilotCoordinator } from "./autopilot-coordinator.js";
import { createFoundationRun } from "./automation-service.js";
import type { RunCoordinator } from "./run-coordinator.js";
import { requireWritingAssignment } from "./run-policy.js";

export interface LongGoalCoordinatorOptions {
  runCoordinator: RunCoordinator;
  autopilotCoordinator: AutopilotCoordinator;
  enableBackgroundWorker: boolean;
  environment: Readonly<Record<string, string | undefined>>;
}

/**
 * Composite long-term goal coordinator: runs "organize the outline → set up
 * chapters → continuously write the given number of chapters" in sequence as
 * one parent activity. It does not create a new task engine: each stage still
 * reuses the existing foundation Run / planning Session / quick create Session;
 * the coordinator only advances idempotently, driven by events (read the
 * current state, fill in whatever is missing). Only one active goal per project
 * at a time.
 */
export class LongGoalCoordinator {
  private readonly goals: SqliteAssistantLongGoalRepository;
  private readonly assistants: SqliteAssistantRepository;
  private readonly automation: SqliteAutomationRepository;
  private readonly canon: SqliteCanonRepository;
  private readonly documents: SqliteDocumentRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly runs: SqliteRunRepository;
  private readonly story: SqliteStoryRepository;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly options: LongGoalCoordinatorOptions,
  ) {
    this.goals = new SqliteAssistantLongGoalRepository(database);
    this.assistants = new SqliteAssistantRepository(database);
    this.automation = new SqliteAutomationRepository(database);
    this.canon = new SqliteCanonRepository(database);
    this.documents = new SqliteDocumentRepository(database);
    this.projects = new SqliteProjectRepository(database);
    this.runs = new SqliteRunRepository(database);
    this.story = new SqliteStoryRepository(database);
  }

  startGoal(input: {
    goalId: string;
    projectId: string;
    conversationId: string;
    activityId: string;
    title: string;
    targetChapters: number;
    braindump: string | null;
    now: string;
  }): AssistantLongGoal {
    const active = this.goals.getActiveGoal(input.projectId);
    if (active) {
      throw new LongGoalError(
        "assistant.long_goal.active",
        "The project already has an active long goal",
        409,
      );
    }
    // The parent activity is persisted first: the
    // assistant_long_goals.activity_id foreign key points to
    // assistant_activities, so the goal must be inserted after the activity.
    // Both are in one transaction, so if the goal insert fails the activity
    // rolls back too, leaving no orphan rows.
    this.database.transaction(() => {
      this.assistants.insertActivity({
        id: input.activityId,
        conversationId: input.conversationId,
        messageId: null,
        kind: "long_goal",
        toolName: "long_goal.start",
        status: "running",
        goal: input.title,
        input: {
          targetChapters: input.targetChapters,
          braindump: input.braindump,
        },
        result: null,
        error: null,
        sourceType: null,
        sourceId: null,
        origin: null,
        executionMode: "auto",
        skillId: "compose.serial",
        phaseKey: "foundation",
        artifacts: null,
        createdAt: input.now,
        updatedAt: input.now,
      });
      this.goals.insertGoal({
        id: input.goalId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        activityId: input.activityId,
        title: input.title,
        targetChapters: input.targetChapters,
        phase: "foundation",
        status: "active",
        baselineHash: this.computeBaselineHash(input.projectId),
        sessionId: null,
        foundationRunId: null,
        outlineSessionId: null,
        lastError: null,
        createdAt: input.now,
        updatedAt: input.now,
      });
    });
    this.advance(input.goalId);
    return this.goals.requireGoal(input.goalId);
  }

  /** Read-only query, used by idempotent replay and projections. */
  getGoal(goalId: string): AssistantLongGoal | null {
    return this.goals.getGoal(goalId);
  }

  /**
   * Event-driven idempotent advance: every call decides the next step from the
   * current persisted state.
   */
  advance(goalId: string): void {
    const goal = this.goals.getGoal(goalId);
    if (!goal || goal.status !== "active") return;
    const currentHash = this.computeBaselineHash(goal.projectId);
    if (currentHash !== goal.baselineHash) {
      // This goal's own stage outputs (book-setup candidates completed,
      // planning session filling in chapters) necessarily change the baseline;
      // these changes are not external drift and are absorbed before
      // continuing. In any other case (the author editing text/outline/Canon
      // while the task runs) it parks and waits for confirmation.
      const outlineStatus = goal.outlineSessionId
        ? (this.automation.getSession(goal.outlineSessionId)?.status ?? null)
        : null;
      const ownOutput =
        (goal.foundationRunId
          ? this.runs.getRun(goal.foundationRunId)?.status === "completed"
          : false) ||
        (outlineStatus !== null &&
          ["pending", "planning", "running", "completed"].includes(
            outlineStatus,
          ));
      if (ownOutput) {
        this.goals.transitionGoal(goal.id, goal.version, {
          baselineHash: currentHash,
          now: new Date().toISOString(),
        });
      } else {
        this.pauseForBaseline(goal, currentHash);
        return;
      }
    }
    const refreshed = this.goals.requireGoal(goalId);
    if (refreshed.status !== "active") return;
    const now = new Date().toISOString();
    if (refreshed.phase === "foundation") {
      this.advanceFoundation(refreshed, now);
      return;
    }
    if (refreshed.phase === "outline") {
      this.advanceOutline(refreshed, now);
      return;
    }
    if (refreshed.phase === "writing") {
      this.advanceWriting(refreshed, now);
    }
  }

  /** Take over all active goals when the service starts or recovers. */
  reconcileAll(): void {
    for (const goal of this.goals.listActionableGoals()) {
      try {
        this.advance(goal.id);
      } catch {
        // A failure to advance one goal does not block the others; the error is
        // retried on the next event.
      }
    }
  }

  resume(goalId: string, now: string): AssistantLongGoal {
    const goal = this.goals.requireGoal(goalId);
    if (goal.status !== "paused_baseline") {
      throw new LongGoalError(
        "assistant.long_goal.invalid_state",
        `The long goal is in state "${goal.status}" and cannot be resumed`,
        409,
      );
    }
    const resumed = this.goals.transitionGoal(goalId, goal.version, {
      status: "active",
      baselineHash: this.computeBaselineHash(goal.projectId),
      lastError: null,
      now,
    });
    this.advance(goalId);
    return this.goals.requireGoal(resumed.id);
  }

  cancel(goalId: string, now: string): AssistantLongGoal {
    const goal = this.goals.requireGoal(goalId);
    if (goal.status === "completed" || goal.status === "cancelled") {
      return goal;
    }
    if (goal.sessionId) {
      const session = this.automation.getSession(goal.sessionId);
      if (session && !["completed", "cancelled"].includes(session.status)) {
        this.automation.requestSessionControl(session.id, "cancel", now);
        if (session.currentRunId) {
          this.options.runCoordinator.interrupt(
            session.currentRunId,
            "long_goal_cancelled",
          );
        }
      }
    }
    const cancelled = this.goals.transitionGoal(goalId, goal.version, {
      status: "cancelled",
      now,
    });
    this.assistants.transitionActivity(goal.activityId, "running", {
      status: "cancelled",
      now,
    });
    return cancelled;
  }

  private advanceFoundation(goal: AssistantLongGoal, now: string): void {
    const intent = this.story.getAuthorIntent(goal.projectId);
    const compass = this.automation.getCompass(goal.projectId);
    if (intent && compass) {
      this.transition(goal, { phase: "outline", now });
      this.advance(goal.id);
      return;
    }
    if (!goal.foundationRunId) {
      const activity = this.assistants.requireActivity(goal.activityId);
      const braindump =
        typeof activity.input.braindump === "string"
          ? activity.input.braindump
          : null;
      if (!braindump) {
        this.failGoal(goal, {
          code: "assistant.long_goal.braindump_missing",
          message:
            "The composite task has no story material, so the story direction cannot be assembled",
        });
        return;
      }
      requireWritingAssignment(this.database, this.options.environment);
      const runId = deterministicId("goal-foundation", goal.id);
      const root = this.story
        .listOutline(goal.projectId)
        .find((node) => node.kind === "book");
      createFoundationRun({
        runs: this.runs,
        runId,
        projectId: goal.projectId,
        rootOutlineNodeId: root?.id ?? null,
        braindump,
        preferences: {
          genre: null,
          audience: null,
          tone: null,
          targetChapters: goal.targetChapters,
          wordsPerChapter: AUTOMATION_DEFAULTS.wordsPerChapter,
          volumes: AUTOMATION_DEFAULTS.volumes,
        },
        policy: {
          assistantConversationId: goal.conversationId,
          assistantLongGoalId: goal.id,
          creationRequestId: goal.id,
          creationRequestHash: hashStable({ braindump }),
        },
        origin: { surface: "assistant", documentId: null, selection: null },
        environment: this.options.environment,
        now,
      });
      this.transition(goal, {
        foundationRunId: runId,
        phaseKey: "foundation",
        now,
      });
      this.wakeRuns();
      return;
    }
    const run = this.runs.getRun(goal.foundationRunId);
    if (!run) {
      this.failGoal(goal, {
        code: "assistant.long_goal.foundation_missing",
        message:
          "The foundation run is missing; the composite task cannot continue",
      });
      return;
    }
    if (run.status === "completed") {
      // Candidates are generated; once the author accepts them, intent/compass
      // exist and the next advance moves on.
      if (intent && compass) {
        this.transition(goal, { phase: "outline", now });
        this.advance(goal.id);
      }
      return;
    }
    if (["failed", "cancelled"].includes(run.status)) {
      this.failGoal(goal, {
        code: "assistant.long_goal.foundation_failed",
        message:
          "Assembling the story direction failed; the composite task is parked",
      });
    }
  }

  private advanceOutline(goal: AssistantLongGoal, now: string): void {
    const planned = this.countPlannedChapters(goal.projectId);
    if (planned >= goal.targetChapters) {
      this.transition(goal, { phase: "writing", now });
      this.advance(goal.id);
      return;
    }
    if (!goal.outlineSessionId) {
      requireWritingAssignment(this.database, this.options.environment);
      const sessionId = deterministicId("goal-outline", goal.id);
      const { effectivePolicy } = resolveEffectivePolicy({});
      this.automation.createSession({
        id: sessionId,
        projectId: goal.projectId,
        mode: "autopilot",
        targetChapters: goal.targetChapters,
        windowSize: Math.min(5, goal.targetChapters),
        maxRevisionCycles: 2,
        chapterPolicy: {
          ...effectivePolicy,
          explicitPolicyFields: [],
          planningMode: "auto",
          planningOnly: true,
          origin: { surface: "assistant", documentId: null, selection: null },
          assistantConversationId: goal.conversationId,
          assistantLongGoalId: goal.id,
          creationRequestId: goal.id,
          creationRequestHash: hashStable({
            goalId: goal.id,
            phase: "outline",
          }),
        },
        now,
      });
      this.transition(goal, {
        outlineSessionId: sessionId,
        phaseKey: "outline",
        now,
      });
      this.wakeAutopilot();
      return;
    }
    const session = this.automation.requireSession(goal.outlineSessionId);
    if (session.status === "completed") {
      if (this.countPlannedChapters(goal.projectId) >= goal.targetChapters) {
        this.transition(goal, { phase: "writing", now });
        this.advance(goal.id);
        return;
      }
      this.failGoal(goal, {
        code: "assistant.long_goal.outline_incomplete",
        message:
          "The outline still has too few chapters after planning; the composite task is parked",
      });
      return;
    }
    if (["failed", "cancelled"].includes(session.status)) {
      this.failGoal(goal, {
        code: "assistant.long_goal.outline_failed",
        message:
          "Filling in the chapter outline failed; the composite task is parked",
      });
    }
  }

  private advanceWriting(goal: AssistantLongGoal, now: string): void {
    if (!goal.sessionId) {
      requireWritingAssignment(this.database, this.options.environment);
      const sessionId = deterministicId("goal-writing", goal.id);
      const { effectivePolicy } = resolveEffectivePolicy({});
      this.automation.createSession({
        id: sessionId,
        projectId: goal.projectId,
        mode: "autopilot",
        targetChapters: goal.targetChapters,
        windowSize: Math.min(5, goal.targetChapters),
        maxRevisionCycles: 2,
        chapterPolicy: {
          ...effectivePolicy,
          explicitPolicyFields: [],
          planningMode: "auto",
          origin: { surface: "assistant", documentId: null, selection: null },
          assistantConversationId: goal.conversationId,
          assistantLongGoalId: goal.id,
          creationRequestId: goal.id,
          creationRequestHash: hashStable({
            goalId: goal.id,
            phase: "writing",
          }),
        },
        now,
      });
      this.transition(goal, { sessionId, phaseKey: "writing", now });
      this.wakeAutopilot();
      return;
    }
    const session = this.automation.requireSession(goal.sessionId);
    if (session.status === "completed") {
      this.goals.transitionGoal(goal.id, goal.version, {
        phase: "done",
        status: "completed",
        now,
      });
      this.assistants.transitionActivity(goal.activityId, "running", {
        status: "completed",
        result: {
          sessionId: session.id,
          completedChapters: session.completedChapters,
          targetChapters: session.targetChapters,
        },
        sourceType: "autopilot",
        sourceId: session.id,
        phaseKey: "done",
        now,
      });
      return;
    }
    if (session.status === "failed") {
      this.failGoal(goal, {
        code: "assistant.long_goal.writing_failed",
        message: "The writing session failed; the composite task is parked",
      });
      return;
    }
    if (session.status === "cancelled") {
      this.goals.transitionGoal(goal.id, goal.version, {
        status: "cancelled",
        now,
      });
      this.assistants.transitionActivity(goal.activityId, "running", {
        status: "cancelled",
        now,
      });
    }
  }

  private pauseForBaseline(goal: AssistantLongGoal, currentHash: string): void {
    const now = new Date().toISOString();
    if (goal.sessionId) {
      const session = this.automation.getSession(goal.sessionId);
      if (
        session &&
        ["pending", "planning", "running"].includes(session.status)
      ) {
        this.automation.requestSessionControl(session.id, "pause", now);
        if (session.currentRunId) {
          const child = this.runs.getRun(session.currentRunId);
          if (child && ["pending", "running"].includes(child.status)) {
            this.runs.requestPause(child.id, now);
          }
        }
      }
    }
    this.goals.transitionGoal(goal.id, goal.version, {
      status: "paused_baseline",
      baselineHash: currentHash,
      lastError: {
        code: "assistant.long_goal.baseline_changed",
        message:
          "You changed the manuscript, outline, or Canon that this task depends on, so the task is paused; it will re-read the latest state when resumed.",
      },
      now,
    });
    this.assistants.transitionActivity(goal.activityId, "running", {
      status: "running",
      phaseKey: "paused_baseline",
      now,
    });
  }

  private failGoal(
    goal: AssistantLongGoal,
    error: { code: string; message: string },
  ): void {
    const now = new Date().toISOString();
    this.goals.transitionGoal(goal.id, goal.version, {
      status: "failed",
      lastError: error,
      now,
    });
    this.assistants.transitionActivity(goal.activityId, "running", {
      status: "failed",
      error,
      now,
    });
  }

  private transition(
    goal: AssistantLongGoal,
    next: {
      phase?: AssistantLongGoal["phase"];
      phaseKey?: string;
      sessionId?: string | null;
      foundationRunId?: string | null;
      outlineSessionId?: string | null;
      now: string;
    },
  ): void {
    this.goals.transitionGoal(goal.id, goal.version, {
      phase: next.phase,
      sessionId: next.sessionId,
      foundationRunId: next.foundationRunId,
      outlineSessionId: next.outlineSessionId,
      lastError: null,
      now: next.now,
    });
    if (next.phaseKey) {
      this.assistants.transitionActivity(goal.activityId, "running", {
        status: "running",
        phaseKey: next.phaseKey,
        now: next.now,
      });
    }
  }

  computeBaselineHash(projectId: string): string {
    const intent = this.story.getAuthorIntent(projectId);
    const outline = this.story
      .listOutline(projectId)
      .map((node) => `${node.id}:${node.status}:${node.updatedAt}`);
    const facts = this.canon
      .listEffectiveFacts(projectId, { includeCandidates: true })
      .map((fact) => `${fact.id}:${fact.predicate}:${fact.authority}`);
    const documents = this.documents
      .list(projectId)
      .map(
        (document) => `${document.id}:${document.currentVersionId ?? "none"}`,
      );
    return hashStable({
      intent: intent?.updatedAt ?? null,
      outline,
      facts,
      documents,
    });
  }

  private countPlannedChapters(projectId: string): number {
    return this.story
      .listOutline(projectId)
      .filter((node) => node.kind === "chapter").length;
  }

  private wakeRuns(): void {
    if (this.options.enableBackgroundWorker) this.options.runCoordinator.wake();
  }

  private wakeAutopilot(): void {
    if (this.options.enableBackgroundWorker) {
      this.options.autopilotCoordinator.wake();
    }
  }
}

export class LongGoalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "LongGoalError";
  }
}

function deterministicId(kind: string, goalId: string): string {
  const hex = sha256Hex(`${kind}\0${goalId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function hashStable(value: unknown): string {
  return sha256Hex(stableJson(value));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}
