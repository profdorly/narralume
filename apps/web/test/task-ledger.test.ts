import { beforeEach, describe, expect, it } from "vitest";

import { setLocale } from "../src/i18n";
import { taskHref } from "../src/lib/task-ledger";

beforeEach(() => {
  setLocale("pt-BR");
});

describe("任务现场链接", () => {
  it("an old co-creation run opens on the runs page", () => {
    expect(
      taskHref("p-1", "assistant", "run-1", {
        origin: {
          surface: "cocreate",
          sessionId: "room-1",
          branchId: "branch-1",
        },
      }),
    ).toBe("/projects/p-1/runs?run=run-1");
  });
});
