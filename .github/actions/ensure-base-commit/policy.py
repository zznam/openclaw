import os
import re
import subprocess
import time
from pathlib import PurePosixPath

from ci_git_owner import FetchTimeout, GitFailure, git_output, run_git


local_git_environment = {"GIT_NO_LAZY_FETCH": "1"}


def quiet_git(*arguments):
    try:
        run_git(os.getcwd(), *arguments, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env=local_git_environment)
        return True
    except GitFailure:
        return False


def fetch_attempts(base, ref):
    yield from [
        (
            ["--no-tags", "--depth=1", "origin", base],
            "Base commit missing; fetching exact SHA before branch history.",
            f"::warning title=ensure-base-commit exact fetch failed::Failed to fetch exact base SHA {base}",
            "exact fetch",
        ),
        *[(
            ["--no-tags", f"--deepen={depth}", "origin", "--", ref],
            f"Base commit missing; deepening {ref} by {depth}.",
            f"::warning title=ensure-base-commit fetch failed::Failed to deepen {ref} by {depth} while looking for {base}",
            "deepening",
        ) for depth in (25, 100, 300, 1000)],
    ]
    # Earlier deepening may have completed the checkout. Read its current state
    # only when the final attempt is needed; plain fetch preserves shallow cuts.
    shallow = git_output(os.getcwd(), "rev-parse", "--is-shallow-repository",
                         env=local_git_environment).strip()
    if shallow not in ("true", "false"):
        raise RuntimeError("Git returned an invalid shallow-repository state")
    yield (
        ["--no-tags", *(["--unshallow"] if shallow == "true" else []), "origin", "--", ref],
        f"Base commit still missing; fetching ref {ref}.",
        f"::warning title=ensure-base-commit fetch failed::Failed to fetch ref {ref} while looking for {base}",
        "full ref fetch",
    )


def comparison_history_available(base):
    if not quiet_git("merge-base", "--is-ancestor", base, "HEAD"):
        return False
    if git_output(os.getcwd(), "rev-parse", "--is-shallow-repository",
                  env=local_git_environment).strip() == "false":
        return True
    shallow_path = git_output(os.getcwd(), "rev-parse", "--git-path", "shallow",
                              env=local_git_environment).strip()
    with open(shallow_path, encoding="utf-8") as source:
        boundaries = set(source.read().split())
    interval = set(git_output(os.getcwd(), "rev-list", f"{base}..HEAD",
                             env=local_git_environment).split())
    return not boundaries.intersection(interval)


def hydrate_policy_parent(base):
    ledger = os.environ.get("POLICY_LEDGER_PATH", "")
    paths = os.environ.get("HISTORY_PATHS", "").splitlines()
    paths = [value for value in paths if value]
    for value in [*paths, *([ledger] if ledger else [])]:
        parsed = PurePosixPath(value)
        if parsed.is_absolute() or ".." in parsed.parts or str(parsed) != value:
            raise ValueError("History paths must be canonical relative paths")
    if not ledger and not paths:
        return 0
    pending = set()
    if paths:
        raw = git_output(os.getcwd(), "log", "--raw", "--no-abbrev", "--format=",
                         "--full-history", "--diff-merges=separate", f"{base}..HEAD", "--", *paths,
                         env=local_git_environment)
        for line in raw.splitlines():
            if line.startswith(":"):
                pending.update(value for value in line.split()[2:4]
                               if re.fullmatch("[0-9a-f]{40}", value) and value != "0" * 40)
    parent = None
    if ledger and not git_output(os.getcwd(), "ls-tree", "--name-only", base, "--", ledger,
                                 env=local_git_environment).strip():
        introductions = git_output(os.getcwd(), "log", "--reverse", "--topo-order",
                                   "--diff-filter=A", "--format=%H", f"{base}..HEAD", "--", ledger,
                                   env=local_git_environment).split()
        if len(introductions) == 1:
            parents = git_output(os.getcwd(), "show", "-s", "--format=%P", introductions[0],
                                 env=local_git_environment).split()
            if len(parents) == 1:
                parent = parents[0]
        # The guard owns ambiguous or missing policy admission.
    deadline = time.monotonic() + 120
    try:
        while True:
            remaining = deadline - time.monotonic() - 10
            if remaining <= 0:
                raise FetchTimeout()
            if parent:
                objects = git_output(os.getcwd(), "rev-list", "--objects", "--missing=print",
                                     "--no-walk", parent, env=local_git_environment, timeout=remaining)
                pending.update(line[1:] for line in objects.splitlines()
                               if re.fullmatch(r"\?[0-9a-f]{40}", line))
            if not pending:
                if paths:
                    run_git(os.getcwd(), "log", "--full-history", "--diff-merges=separate", "--no-ext-diff", "--no-textconv", "--format=",
                            "--patch", f"{base}..HEAD", "--", *paths, env=local_git_environment,
                            timeout=remaining, stdout=subprocess.DEVNULL)
                print("Historical policy-parent snapshot is available.")
                return 0
            wanted = sorted(pending)
            pending.clear()
            for offset in range(0, len(wanted), 512):
                remaining = deadline - time.monotonic() - 10
                if remaining <= 0:
                    raise FetchTimeout()
                # Existing commits do not imply their promised blobs are local.
                run_git(os.getcwd(), "-c", "protocol.version=2", "-c", "fetch.negotiationAlgorithm=noop", "fetch", "--no-tags",
                        "--no-write-fetch-head", "--no-filter", "origin",
                        *wanted[offset:offset + 512], timeout=remaining,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, reclaim_locks=True)
    except (GitFailure, FetchTimeout):
        print("::error::Could not hydrate historical policy-parent snapshot or metadata within the owned 120-second fetch budget.")
        return 1


def ensure_history(base):
    required = os.environ.get("REQUIRE_HISTORY", "false")
    if required in ("", "false"):
        return 0
    if required != "true":
        raise ValueError("require-history must be true or false")
    if comparison_history_available(base):
        print("Complete guard comparison history is already available.")
        return hydrate_policy_parent(base)
    head = git_output(os.getcwd(), "rev-parse", "HEAD", env=local_git_environment).strip()
    if not re.fullmatch("[0-9a-f]{40}", head):
        raise RuntimeError("Guard history requires an immutable checked-out head")
    for depth in (25, 100, 300, 1000, None):
        shallow = git_output(os.getcwd(), "rev-parse", "--is-shallow-repository",
                             env=local_git_environment).strip()
        if shallow != "true":
            break
        arguments = [f"--deepen={depth}"] if depth is not None else ["--unshallow"]
        try:
            run_git(os.getcwd(), "-c", "protocol.version=2", "fetch", "--no-tags",
                    "--filter=blob:none", *arguments, "origin", head, base,
                    timeout=120, reclaim_locks=True)
        except (GitFailure, FetchTimeout):
            print("::warning::Could not deepen guard comparison history.")
        if comparison_history_available(base):
            print("Resolved complete guard comparison history.")
            return hydrate_policy_parent(base)
    print("::error title=ensure-base-commit missing history::Guard comparison history is incomplete; fetch reachable base and head ancestry before running history guards.")
    return 1


def ensure_base():
    base = os.environ["BASE_SHA"]
    ref = os.environ["FETCH_REF"]
    if not base or re.fullmatch("0+", base):
        print("No concrete base SHA available; skipping targeted fetch.")
        return 0
    if not re.fullmatch("[0-9a-fA-F]{7,40}", base):
        print(f"::error title=ensure-base-commit invalid base sha::Refusing invalid base SHA: {base}")
        return 2
    if not quiet_git("check-ref-format", "--branch", ref):
        print(f"::error title=ensure-base-commit invalid fetch ref::Refusing invalid fetch ref: {ref}")
        return 2
    if quiet_git("rev-parse", "--verify", f"{base}^{{commit}}"):
        print(f"Base commit already present: {base}")
        return ensure_history(base)

    for arguments, message, warning, resolution in fetch_attempts(base, ref):
        print(message, flush=True)
        try:
            run_git(os.getcwd(), "-c", "protocol.version=2", "fetch", "--filter=blob:none", *arguments,
                    timeout=30, reclaim_locks=True)
        except (GitFailure, FetchTimeout):
            # A failed fetch can still supply the base. Lifecycle failures and
            # cancellation escape this policy before any availability probe.
            print(warning)
        if quiet_git("rev-parse", "--verify", f"{base}^{{commit}}"):
            print(f"Resolved base commit after {resolution}: {base}")
            return ensure_history(base)
    print(f"::error title=ensure-base-commit missing base::Base commit still unavailable after fetch attempts: {base}")
    return 1


raise SystemExit(ensure_base())
