import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/package-acceptance.yml", "utf8"));
const steps = workflow.jobs.resolve_package.steps;
const native = "a".repeat(40);
const foreign = "b".repeat(40);
const guardName = "Bind package inputs to default cache scope";

function step(name: string) {
  const found = steps.find((entry: { name?: string }) => entry.name === name);
  if (!found) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return found;
}

const script: string = step(guardName).with.script;

async function admit(
  options: {
    stage?: string;
    source?: string;
    sourceSha?: string;
    packageRef?: string;
    ref?: string | null;
    eventSha?: string;
    eventName?: string;
    branch?: unknown;
  } = {},
) {
  const env = {
    CACHE_SCOPE_STAGE: options.stage ?? "declared",
    PACKAGE_SOURCE_KIND: options.source ?? "ref",
    PACKAGE_SOURCE_SHA: options.sourceSha ?? native,
    // These claims must never authenticate external executable bytes.
    PACKAGE_BUILD_SOURCE_SHA: native,
    ARTIFACT_PRODUCER_HEAD_SHA: native,
    PACKAGE_REF: options.packageRef ?? "independent-package-ref",
  };
  const context = {
    eventName: options.eventName ?? "workflow_dispatch",
    sha: options.eventSha ?? native,
    ref: options.ref === undefined ? "refs/heads/main" : options.ref,
    payload: {
      repository: { default_branch: options.branch === undefined ? "main" : options.branch },
    },
  };
  await runInNewContext(
    `(async () => { ${script}\n})()`,
    { context, process: { env } },
    { timeout: 1000 },
  );
  return env;
}

describe("package execution cache scope", () => {
  it("admits the actual default-main dispatch inputs without changing the package ref", async () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs.source.default).toBe("ref");
    expect(inputs.package_ref.default).toBe("main");
    for (const stage of ["declared", "known", "resolved"]) {
      const env = await admit({
        stage,
        source: inputs.source.default,
        packageRef: inputs.package_ref.default,
      });
      expect(env).toMatchObject({
        PACKAGE_SOURCE_KIND: "ref",
        PACKAGE_SOURCE_SHA: native,
        PACKAGE_REF: "main",
      });
    }
  });

  it.each(["declared", "known", "resolved"])("admits native ref packing at %s", async (stage) => {
    await expect(admit({ stage })).resolves.toHaveProperty("PACKAGE_SOURCE_SHA", native);
  });

  it.each(["artifact", "npm", "url", "trusted-url"])(
    "rejects default-branch %s bytes even when build-info claims the native SHA",
    async (source) => {
      await expect(admit({ source, sourceSha: native })).rejects.toThrow(
        /only native ref packing/u,
      );
    },
  );

  it("rejects an arbitrary artifact producer even when its run claims the native head", async () => {
    await expect(admit({ source: "artifact", sourceSha: native })).rejects.toThrow(
      /arbitrary producer metadata/u,
    );
  });

  it.each(["known", "resolved"])("rejects an off-event actual source at %s", async (stage) => {
    await expect(admit({ stage, sourceSha: foreign })).rejects.toThrow(/native event commit/u);
    await expect(admit({ stage, sourceSha: "" })).rejects.toThrow(/native event commit/u);
  });

  for (const ref of ["refs/heads/package-proof", "refs/tags/package-proof", "refs/pull/42/merge"]) {
    it.each(["ref", "artifact", "npm", "url", "trusted-url"])(
      `preserves independent %s source identity in ${ref}`,
      async (source) => {
        for (const stage of ["declared", "known", "resolved"]) {
          const env = await admit({ stage, source, ref, sourceSha: foreign });
          expect(env.PACKAGE_SOURCE_SHA).toBe(foreign);
          expect(env.PACKAGE_REF).toBe("independent-package-ref");
        }
      },
    );
  }

  it.each(["pull_request_target", "workflow_run", "schedule"])(
    "protects the default cache when workflow_call inherits %s",
    async (eventName) => {
      await expect(admit({ eventName, source: "artifact" })).rejects.toThrow(
        /only native ref packing/u,
      );
      await expect(admit({ eventName, stage: "known", sourceSha: foreign })).rejects.toThrow(
        /native event commit/u,
      );
    },
  );

  it("fails closed without native cache scope or event identity", async () => {
    await expect(admit({ branch: null })).rejects.toThrow(/cache scope/u);
    await expect(admit({ branch: { name: "main" } })).rejects.toThrow(/cache scope/u);
    await expect(admit({ ref: null })).rejects.toThrow(/cache scope/u);
    await expect(admit({ eventSha: "" })).rejects.toThrow(/event SHA/u);
    await expect(admit({ stage: "unknown" })).rejects.toThrow(/admission stage/u);
  });

  it("places the real guards before each package execution boundary", () => {
    const index = (name: string) => {
      const result = steps.findIndex((entry: { name?: string }) => entry.name === name);
      expect(result, name).toBeGreaterThanOrEqual(0);
      return result;
    };
    expect(index("Bind source to native event commit")).toBeLessThan(index(guardName));
    expect(index(guardName)).toBeLessThan(index("Setup supported Node runtime"));
    expect(index(guardName)).toBeLessThan(index("Download package artifact input"));
    expect(index("Resolve known package source")).toBeLessThan(
      index("Bind known package source to default cache scope"),
    );
    expect(index("Bind known package source to default cache scope")).toBeLessThan(
      index("Acquire known package source"),
    );
    expect(index("Acquire known package source")).toBeLessThan(index("Resolve package candidate"));
    expect(index("Resolve package candidate")).toBeLessThan(
      index("Bind resolved package source to default cache scope"),
    );
    expect(index("Bind resolved package source to default cache scope")).toBeLessThan(
      index("Plan frozen source admission"),
    );

    for (const [name, stage, sha] of [
      [guardName, "declared", "${{ inputs.package_source_sha }}"],
      [
        "Bind known package source to default cache scope",
        "known",
        "${{ steps.known_source.outputs.sha }}",
      ],
      [
        "Bind resolved package source to default cache scope",
        "resolved",
        "${{ steps.resolve.outputs.package_source_sha }}",
      ],
    ]) {
      expect(step(name).uses).toBe(
        "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
      );
      expect(step(name).with.script).toBe(script);
      expect(step(name).env).toMatchObject({
        CACHE_SCOPE_STAGE: stage,
        PACKAGE_SOURCE_KIND: "${{ inputs.source }}",
        PACKAGE_SOURCE_SHA: sha,
      });
    }
    expect(step("Bind known package source to default cache scope").if).toBe(
      "inputs.source == 'ref'",
    );
    expect(step("Resolve known package source").env.PACKAGE_REF).toBe("${{ inputs.package_ref }}");
    expect(step("Acquire known package source").with.ref).toBe(
      "${{ steps.known_source.outputs.sha }}",
    );
    expect(step("Resolve package candidate").env.PACKAGE_REF).toBe(
      "${{ steps.known_source.outputs.sha || inputs.package_ref }}",
    );
    expect(step("Acquire resolved package source").with.ref).toBe(
      "${{ steps.resolve.outputs.package_source_sha }}",
    );
  });

  it("keeps a blank workflow identity assertion optional and receipts native", () => {
    expect(workflow.on.workflow_dispatch.inputs.workflow_ref.default).toBe("");
    expect(workflow.on.workflow_call.inputs.workflow_ref.default).toBe("");
    expect(step("Resolve called package tooling identity").env.WORKFLOW_REF).toBe(
      "${{ inputs.workflow_ref || job.workflow_sha }}",
    );
    expect(step("Summarize package candidate").env.WORKFLOW_REF).toBe(
      "${{ inputs.workflow_ref || job.workflow_sha }}",
    );
    expect(step("Checkout package workflow ref").with.ref).toBe("${{ job.workflow_sha }}");
  });
});
