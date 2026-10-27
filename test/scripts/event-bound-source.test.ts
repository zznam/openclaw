import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { evaluateWorkflowExpression } from "./ci-workflow.test-support.js";

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
  ["qa-live-transports-convex", "validate_selected_ref"],
] as const;

const eventSha = "a".repeat(40);
const calleeSha = "b".repeat(40);
const otherSha = "c".repeat(40);

describe.each(owners)("%s event-bound source", (workflow, job) => {
  const document = parse(readFileSync(`.github/workflows/${workflow}.yml`, "utf8")) as {
    jobs: Record<
      string,
      { steps?: { name?: string; uses?: string; with?: { script?: string } }[] }
    >;
  };
  const steps = document.jobs[job]!.steps!;
  const admission = steps.find((step) => step.name === "Bind source to native event commit");
  async function run(
    env: Record<string, string | undefined> = {},
    sha: string | undefined = eventSha,
    apiError?: Error,
    eventName = "workflow_dispatch",
  ) {
    expect(admission).toBeDefined();
    await runInNewContext(`(async () => { ${admission!.with!.script} })()`, {
      context: { sha, eventName, repo: { owner: "owner", repo: "fork" } },
      process: {
        env: {
          CALLED_WORKFLOW_SHA: calleeSha,
          CALLED_WORKFLOW_REPOSITORY: "canonical/repo",
          ...env,
        },
      },
      github: {
        rest: {
          repos: {
            getCommit: async ({ ref }: { ref: string }) => {
              if (apiError) {
                throw apiError;
              }
              return {
                data: {
                  sha: ["main", "feature", "refs/tags/v1", eventSha].includes(ref)
                    ? eventSha
                    : otherSha,
                },
              };
            },
          },
        },
      },
    });
  }

  it("admits only requested revisions that resolve to the native event SHA", async () => {
    await expect(run()).resolves.toBeUndefined();
    await expect(
      run({ REQUESTED_SOURCE_REF: "main", REQUESTED_SOURCE_SHA: eventSha }),
    ).resolves.toBeUndefined();
    await expect(run({ REQUESTED_SOURCE_REF: "feature" })).resolves.toBeUndefined();
    await expect(run({ REQUESTED_SOURCE_REF: "refs/tags/v1" })).resolves.toBeUndefined();
    await expect(run({ REQUESTED_SOURCE_REF: "other" })).rejects.toThrow("--ref");
    await expect(run({ REQUESTED_SOURCE_REF: "moved" })).rejects.toThrow("--ref");
    await expect(run({ REQUESTED_SOURCE_SHA: otherSha })).rejects.toThrow("--ref");
    await expect(
      run({ REQUESTED_SOURCE_REF: "main" }, eventSha, new Error("lookup unavailable")),
    ).rejects.toThrow("lookup unavailable");
    await expect(run({}, "")).rejects.toThrow("Native workflow event SHA");
  });

  it("keeps ordinary PR head selection independent of the merge event SHA", async () => {
    await expect(
      run(
        { REQUESTED_SOURCE_REF: otherSha },
        eventSha,
        new Error("PR head does not need a native-event lookup"),
        "pull_request",
      ),
    ).resolves.toBeUndefined();
    for (const event of ["pull_request_target", "workflow_run", "schedule"]) {
      await expect(
        run({ REQUESTED_SOURCE_REF: otherSha }, eventSha, undefined, event),
      ).rejects.toThrow("--ref");
    }
  });

  it("preserves the callee identity independently of the caller event revision", async () => {
    await expect(
      run({ REQUESTED_HARNESS_SHA: calleeSha, REQUESTED_HARNESS_REPOSITORY: "canonical/repo" }),
    ).resolves.toBeUndefined();
    await expect(run({ REQUESTED_HARNESS_SHA: eventSha })).rejects.toThrow("called workflow SHA");
    await expect(run({ REQUESTED_HARNESS_REPOSITORY: "other/repo" })).rejects.toThrow(
      "called workflow repository",
    );
    await expect(run({ CALLED_WORKFLOW_SHA: undefined })).rejects.toThrow(
      "identity is unavailable",
    );
  });

  it("binds inputs before checking out any executable repository content", () => {
    const admissionIndex = steps.indexOf(admission!);
    const checkoutIndex = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
    expect(admissionIndex).toBeGreaterThanOrEqual(0);
    if (checkoutIndex >= 0) {
      expect(admissionIndex).toBeLessThan(checkoutIndex);
    }
  });
});

it.each([
  ["openclaw-live-and-e2e-checks-reusable", "ref"],
  ["openclaw-release-checks", "ref"],
  ["plugin-npm-release", "ref"],
  ["qa-live-transports-convex", "ref"],
  ["package-acceptance", "workflow_ref"],
])("%s native branch and tag dispatches do not inherit a main assertion", (workflow, input) => {
  const document = parse(readFileSync(`.github/workflows/${workflow}.yml`, "utf8")) as {
    on: { workflow_dispatch: { inputs: Record<string, { required?: boolean; default?: string }> } };
  };
  const declaration = document.on.workflow_dispatch.inputs[input]!;
  expect(declaration.required).toBe(false);
  expect(declaration.default ?? "").toBe("");
});

it("records the tested repo-E2E PR head independently of the merge SHA", () => {
  const workflow = parse(
    readFileSync(".github/workflows/openclaw-repo-e2e-reusable.yml", "utf8"),
  ) as {
    env: { OPENCLAW_SELECTED_SHA: string };
  };
  for (const eventName of ["pull_request", "workflow_dispatch"] as const) {
    expect(
      evaluateWorkflowExpression(workflow.env.OPENCLAW_SELECTED_SHA, {
        eventName,
        repository: "owner/fork",
        runAttempt: 1,
        sha: eventSha,
        inputs: { ref: otherSha },
      }),
    ).toBe(eventName === "pull_request" ? otherSha : eventSha);
  }
});

it.each([
  ["install-smoke-reusable", "preflight", "Checkout"],
  ["openclaw-live-and-e2e-checks-reusable", "validate_special_e2e", "Checkout selected ref"],
  ["openclaw-repo-e2e-reusable", "build", "Checkout selected ref"],
  ["qa-live-transports-convex", "validate_selected_ref", "Checkout selected ref"],
])(
  "%s checks out the requested PR head but only the native commit in other events",
  (workflow, job, name) => {
    const document = parse(readFileSync(`.github/workflows/${workflow}.yml`, "utf8")) as {
      jobs: Record<string, { steps: { name?: string; with?: { ref?: string } }[] }>;
    };
    const expression = document.jobs[job]!.steps.find((step) => step.name === name)!.with!.ref;
    const evaluate = (
      eventName:
        | "pull_request"
        | "workflow_dispatch"
        | "schedule"
        | "pull_request_target"
        | "workflow_run",
    ) =>
      evaluateWorkflowExpression(expression, {
        eventName,
        repository: "owner/fork",
        runAttempt: 1,
        sha: eventSha,
        inputs: { ref: otherSha },
        additionalNeeds: { validate_selected_ref: { outputs: { selected_sha: otherSha } } },
      });
    expect(evaluate("pull_request")).toBe(otherSha);
    for (const event of [
      "workflow_dispatch",
      "schedule",
      "pull_request_target",
      "workflow_run",
    ] as const) {
      expect(evaluate(event)).toBe(eventSha);
    }
  },
);

describe("performance executable cache scope", () => {
  const workflow = parse(readFileSync(".github/workflows/openclaw-performance.yml", "utf8")) as {
    env: Record<string, string>;
    jobs: Record<string, { steps: { name?: string; with?: { script?: string; ref?: string } }[] }>;
  };
  const admission = workflow.jobs.resolve_target!.steps.find(
    (step) => step.name === "Bind auxiliary executables to cache scope",
  )!;
  const baseline = workflow.jobs.vitest_pair!.steps.find(
    (step) => step.name === "Checkout Vitest pair baseline",
  )!;
  async function run(
    env: Record<string, string>,
    ref = "refs/heads/main",
    branch: string | undefined = "main",
  ) {
    await runInNewContext(`(async () => { ${admission.with!.script} })()`, {
      context: {
        sha: eventSha,
        ref,
        eventName: "workflow_dispatch",
        repo: { owner: "owner", repo: "fork" },
        payload: { repository: { default_branch: branch } },
      },
      process: { env: { ...workflow.env, ...env } },
      github: {
        rest: {
          repos: {
            getCommit: async ({ ref: requested }: { ref: string }) => ({
              data: { sha: requested },
            }),
          },
        },
      },
    });
  }

  it("rejects different default-branch baselines without replacing the requested comparison", async () => {
    expect(baseline.with!.ref).toBe("${{ inputs.baseline_ref }}");
    await expect(run({ PERFORMANCE_MODE: "vitest-pair", BASELINE_REF: otherSha })).rejects.toThrow(
      "non-default branch",
    );
    await expect(
      run({ PERFORMANCE_MODE: "vitest-pair", BASELINE_REF: eventSha }),
    ).resolves.toBeUndefined();
    await expect(
      run({ PERFORMANCE_MODE: "vitest-pair", BASELINE_REF: otherSha }, "refs/heads/feature"),
    ).resolves.toBeUndefined();
    await expect(
      run({ PERFORMANCE_MODE: "vitest-pair", BASELINE_REF: eventSha }, ""),
    ).rejects.toThrow("scope is unavailable");
  });

  it("keeps reviewed Kova defaults and scopes custom executable producers to non-default runs", async () => {
    await expect(
      run({ PERFORMANCE_MODE: "kova", KOVA_REF: workflow.env.KOVA_CANONICAL_CONFIG_REF! }),
    ).resolves.toBeUndefined();
    await expect(run({ PERFORMANCE_MODE: "kova", KOVA_REF: "custom" })).rejects.toThrow(
      "reviewed immutable Kova",
    );
    await expect(
      run({ PERFORMANCE_MODE: "kova", KOVA_REF: "custom" }, "refs/heads/feature"),
    ).resolves.toBeUndefined();
  });
});

it.each([
  "openclaw-performance",
  "openclaw-release-checks",
  "plugin-clawhub-release",
  "plugin-npm-release",
])("%s has no PR caller graph and checks out native source directly", (workflow) => {
  const document = parse(readFileSync(`.github/workflows/${workflow}.yml`, "utf8")) as {
    on: Record<string, unknown>;
    jobs: Record<string, { steps?: { uses?: string; with?: { ref?: string } }[] }>;
  };
  expect(document.on.pull_request).toBeUndefined();
  expect(document.on.workflow_call).toBeUndefined();
  for (const job of Object.values(document.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith("actions/checkout@")) {
        expect([
          undefined,
          "${{ github.sha }}",
          "${{ job.workflow_sha }}",
          "${{ inputs.baseline_ref }}",
        ]).toContain(step.with?.ref);
      }
    }
  }
});

describe("provided executable cache scope", () => {
  const workflow = parse(
    readFileSync(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml", "utf8"),
  ) as {
    jobs: Record<string, { steps: { name?: string; with?: { script?: string } }[] }>;
  };
  const admission = workflow.jobs.validate_selected_ref!.steps.find(
    (step) => step.name === "Bind provided executables to native cache scope",
  )!;
  async function run(
    inputs: Record<string, unknown>,
    ref = "refs/heads/main",
    eventName = "workflow_dispatch",
  ) {
    await runInNewContext(`(async () => { ${admission.with!.script} })()`, {
      context: { ref, eventName, payload: { repository: { default_branch: "main" } } },
      process: { env: { SOURCE_INPUTS: JSON.stringify(inputs) } },
    });
  }

  it("builds native inputs internally and rejects self-declared executable bytes on main", async () => {
    await expect(run({})).resolves.toBeUndefined();
    await expect(run({ prepared_npm_bundle_json: "[]" })).resolves.toBeUndefined();
    for (const inputs of [
      { package_artifact_id: "123", package_source_sha: eventSha },
      { prepublish_plugin_registry_artifact_name: "registry" },
      { docker_e2e_bare_image: "unproved:latest" },
      { shared_image_artifact_id: "123" },
      { prepared_npm_bundle_json: JSON.stringify({ sourceSha: eventSha }) },
    ]) {
      for (const event of [
        "workflow_dispatch",
        "schedule",
        "pull_request_target",
        "workflow_run",
      ]) {
        await expect(run(inputs, "refs/heads/main", event)).rejects.toThrow("--ref");
      }
    }
    await expect(run({ package_artifact_id: "123" }, "")).rejects.toThrow("scope is unavailable");
  });

  it("preserves provided package/image selection for scoped PR and non-default runs", async () => {
    const inputs = {
      package_artifact_id: "123",
      package_source_sha: otherSha,
      docker_e2e_bare_image: "requested:image",
    };
    await expect(run(inputs, "refs/heads/feature")).resolves.toBeUndefined();
    await expect(run(inputs, "refs/pull/1/merge", "pull_request")).resolves.toBeUndefined();
  });
});
