// Static scanner fixtures; never executed.
declare const inheritedEnv: Record<string, string>;
declare function resolveEnvironmentValue(env: Record<string, string>, key: string): string;
declare function sanitizeHostExecEnv(input: unknown): unknown;
declare function sanitizeSystemRunEnvOverrides(input: unknown): unknown;

const inheritedValues = {
  // ok: openclaw-dangerous-host-env-override-pivots
  git: resolveEnvironmentValue(inheritedEnv, "GIT_CONFIG_PARAMETERS"),
  // ok: openclaw-dangerous-host-env-override-pivots
  ssh: resolveEnvironmentValue(inheritedEnv, "GIT_SSH_COMMAND"),
};

const directOverrides = {
  // ruleid: openclaw-dangerous-host-env-override-pivots
  ["GIT_CONFIG_PARAMETERS"]: "untrusted",
  // ruleid: openclaw-dangerous-host-env-override-pivots
  ["GIT_SSH_COMMAND"]: "untrusted",
};

const copiedOverride = {
  // ruleid: openclaw-dangerous-host-env-override-pivots
  ["GIT_CONFIG_PARAMETERS"]: resolveEnvironmentValue(inheritedEnv, "GIT_CONFIG_PARAMETERS"),
};

// ruleid: openclaw-dangerous-host-env-override-pivots
sanitizeHostExecEnv({ overrides: { GIT_CONFIG_PARAMETERS: "untrusted" } });
// ruleid: openclaw-dangerous-host-env-override-pivots
sanitizeSystemRunEnvOverrides({ overrides: { GIT_SSH_COMMAND: "untrusted" } });

// ruleid: openclaw-dangerous-host-env-override-pivots
sanitizeHostExecEnv({
  overrides: {
    GIT_CONFIG_PARAMETERS: resolveEnvironmentValue(inheritedEnv, "GIT_CONFIG_PARAMETERS"),
  },
});

export { inheritedValues, directOverrides, copiedOverride };

// Clearing a variable removes its authority rather than overriding host execution.
const cleared = {
  // ok: openclaw-dangerous-host-env-override-pivots
  clearEnv: ["GIT_SSH_COMMAND", ...(enabled ? ["GIT_CONFIG_PARAMETERS"] : [])],
};

const clearedWithDangerousSibling = {
  // ok: openclaw-dangerous-host-env-override-pivots
  clearEnv: ["GIT_CONFIG_PARAMETERS"],
  env: {
    // ruleid: openclaw-dangerous-host-env-override-pivots
    ["GIT_SSH_COMMAND"]: "untrusted",
  },
};

// ruleid: openclaw-dangerous-host-env-override-pivots
sanitizeHostExecEnv({
  clearEnv: ["GIT_CONFIG_PARAMETERS"],
  overrides: { GIT_SSH_COMMAND: "untrusted" },
});

const unsafeAllowlist = {
  // ruleid: openclaw-dangerous-host-env-override-pivots
  allowedEnv: ["GIT_CONFIG_PARAMETERS"],
};
