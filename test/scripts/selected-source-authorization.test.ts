import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { evaluateWorkflowCondition } from "./ci-workflow.test-support.js";

const owners = [
  ["install-smoke-reusable", "preflight"],
  ["openclaw-live-and-e2e-checks-reusable", "validate_selected_ref"],
  ["openclaw-performance", "resolve_target"],
  ["openclaw-release-checks", "resolve_target"],
  ["openclaw-release-telegram-qa", "trusted_identity"],
  ["openclaw-repo-e2e-reusable", "build"],
  ["package-acceptance", "resolve_package"],
  ["plugin-clawhub-release", "preview_plugins_clawhub"],
  ["plugin-npm-release", "preview_plugins_npm"],
] as const;

type AuthorizationStep = {
  name?: string;
  if?: string;
  with?: { script?: string };
};

function selectedSourceAdmission(workflow: string, job: string) {
  const document = parse(readFileSync(`.github/workflows/${workflow}.yml`, "utf8")) as {
    jobs: Record<string, { steps: AuthorizationStep[] }>;
  };
  return document.jobs[job]?.steps.find(
    (step) => step.name === "Authorize selected-source execution",
  );
}

async function runAdmission(
  step: AuthorizationStep | undefined,
  options: {
    event?: "workflow_dispatch" | "schedule" | "pull_request";
    actor?: string;
    triggeringActor?: string;
    permissions?: Record<string, string | undefined>;
    apiError?: Error;
  },
) {
  const eventName = options.event ?? "workflow_dispatch";
  if (
    !step ||
    (step.if &&
      !evaluateWorkflowCondition(step.if, { eventName, repository: "owner/fork", runAttempt: 1 }))
  ) {
    return;
  }
  await runInNewContext(`(async () => { ${step.with?.script ?? ""} })()`, {
    context: { actor: options.actor, repo: { owner: "owner", repo: "fork" } },
    process: { env: { TRIGGERING_ACTOR: options.triggeringActor } },
    github: {
      rest: {
        repos: {
          getCollaboratorPermissionLevel: async ({ username }: { username: string }) => {
            if (options.apiError) {
              throw options.apiError;
            }
            return { data: { permission: options.permissions?.[username] } };
          },
        },
      },
    },
  });
}

describe.each(owners)("%s selected-source admission", (workflow, job) => {
  const step = selectedSourceAdmission(workflow, job);

  it("refuses unprivileged, unknown, and unavailable authority before selected code runs", async () => {
    for (const permission of ["read", "triage", undefined]) {
      await expect(
        runAdmission(step, { actor: "caller", permissions: { caller: permission } }),
      ).rejects.toThrow();
    }
    await expect(runAdmission(step, {})).rejects.toThrow();
    await expect(
      runAdmission(step, {
        actor: "caller",
        apiError: new Error("permission service unavailable"),
      }),
    ).rejects.toThrow("permission service unavailable");
  });

  it("requires current authority for both the original actor and a rerun actor", async () => {
    for (const permission of ["write", "maintain", "admin"]) {
      await expect(
        runAdmission(step, {
          event: "schedule",
          actor: "owner",
          permissions: { owner: permission },
        }),
      ).resolves.toBeUndefined();
    }
    await expect(
      runAdmission(step, {
        actor: "owner",
        triggeringActor: "reader",
        permissions: { owner: "admin", reader: "read" },
      }),
    ).rejects.toThrow();
  });

  it("keeps ordinary PR validation outside the privileged selected-source admission", async () => {
    await expect(
      runAdmission(step, {
        event: "pull_request",
        actor: "contributor",
        apiError: new Error("PR source must not need collaborator access"),
      }),
    ).resolves.toBeUndefined();
  });
});
