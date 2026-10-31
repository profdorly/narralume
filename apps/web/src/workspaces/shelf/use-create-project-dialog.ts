import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";

import { useI18n } from "../../i18n";
import {
  createProject,
  createProjectWithFoundation,
  type Project,
  type ProjectLanguage,
} from "../../lib/api";
import { rememberTask } from "../../lib/task-ledger";

export type CreateBookMode = "blank" | "ai";
export type ProjectForm = "short-story" | "novella" | "novel";

export function useCreateProjectDialog(
  mode: CreateBookMode,
  onCreated: (project: Project) => void,
) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [premise, setPremise] = useState("");
  const [language, setLanguage] = useState<ProjectLanguage>("pt-BR");
  const [form, setForm] = useState<ProjectForm>("novel");
  const aiRequestRef = useRef<{ identity: string; requestId: string } | null>(
    null,
  );
  const blankRequestRef = useRef<{ identity: string; requestId: string } | null>(
    null,
  );
  const mutation = useMutation({
    mutationFn: async (input: {
      title: string;
      premise: string | null;
      language: ProjectLanguage;
      form: ProjectForm;
    }) => {
      /* A blank book uses plain project creation (works without a model);
         AI-guided book setup creates the project and starts the foundation
         background task in one go, with requestId as the idempotency key of
         this submission. */
      if (mode === "ai" && input.premise) {
        // Loaded on submit: @lapis/contracts carries the zod schemas, which the
        // shelf does not need to render.
        const { AUTOMATION_DEFAULTS } = await import("@lapis/contracts");
        const request = {
          title: input.title,
          premise: input.premise,
          language: input.language,
          form: input.form,
          braindump: input.premise,
          preferences: {
            genre: null,
            audience: null,
            tone: null,
            ...AUTOMATION_DEFAULTS,
          },
          policy: { qualityPreset: "standard" as const },
        };
        const identity = JSON.stringify(request);
        if (aiRequestRef.current?.identity !== identity) {
          aiRequestRef.current = {
            identity,
            requestId: crypto.randomUUID(),
          };
        }
        const created = await createProjectWithFoundation({
          ...request,
          requestId: aiRequestRef.current.requestId,
        });
        rememberTask({
          projectId: created.project.id,
          kind: "foundation",
          taskId: created.task.run.id,
          label: t("shelf.create.taskLabel", { name: created.project.title }),
          createdAt: new Date().toISOString(),
          origin: { surface: "autopilot" },
        });
        return created.project;
      }
      const identity = JSON.stringify(input);
      if (blankRequestRef.current?.identity !== identity) {
        blankRequestRef.current = {
          identity,
          requestId: crypto.randomUUID(),
        };
      }
      return createProject({
        ...input,
        requestId: blankRequestRef.current.requestId,
      });
    },
    onSuccess: (project) => {
      aiRequestRef.current = null;
      blankRequestRef.current = null;
      onCreated(project);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || (mode === "ai" && !premise.trim())) return;
    mutation.mutate({
      title: trimmed,
      premise: premise.trim() ? premise.trim() : null,
      language,
      form,
    });
  };

  return {
    title,
    setTitle,
    premise,
    setPremise,
    language,
    setLanguage,
    form,
    setForm,
    mutation,
    submit,
  };
}
