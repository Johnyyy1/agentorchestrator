# Jonas OS

Tasks and execution runs are stored in PostgreSQL. `createTask()` persists a task and enqueues only its ID; `npm run worker` runs the background consumer on `jonas-os.tasks.execute`.

## Repository coding tasks

Add `repository: { path: "/absolute/path/to/repository", baseBranch: "main" }` to a coding `TaskSpec`. The base branch defaults to the local `main` branch. The source must be a clean Git working tree with a committed base branch. Missing paths, invalid branches, dirty sources and external Git clean/smudge/process filters are rejected.

Each task gets branch `jonas-os/task-<task-id>` and a linked worktree at `~/.jonas-os/worktrees/<task-id>`. Set `JONAS_OS_WORKTREE_DIR` to an absolute directory to change that root; it must remain outside the source repository. Existing task branches or paths are never overwritten.

The run's nullable `workspace` JSON records the source repository, worktree path, branch, base branch and base commit before Codex starts. The task's nullable `repository` JSON retains execution context. Existing tasks remain valid.

Codex defaults to `read-only`. Repository coding explicitly selects `workspace-write` after validating the managed worktree and its Git registration. Extra writable roots, network access and writable system temporary directories are disabled; sandbox escalation is disabled. User configuration and execpolicy rules are ignored for this write invocation. Git checkout hooks are disabled by the worktree manager. Jonas OS does not commit, merge, push or deploy changes.

## Verification and results

After Codex returns, verification detects npm, pnpm or yarn from `packageManager` or lockfiles and runs the available `test`, `typecheck`, `lint` and `build` scripts in that order. Missing scripts are explicitly skipped; if none exist, the result contains only skipped checks. Dependencies are never installed automatically. A freshly created worktree therefore needs dependencies provisioned explicitly if its checks require them.

Verification uses the installed Codex CLI's **local `codex sandbox` command launcher**, which does not call an AI model. Commands have ignored stdin, `CI=true`, disabled network access, an isolated environment and worktree-local temporary/cache directories. Each check has a 60-second limit, bounded output and process-group cleanup on Unix. A sandbox or command failure fails verification rather than falling back to unrestricted execution. The sandbox launcher must be supported by the installed CLI/OS; it is validated on the current macOS host.

The execution result includes the Codex result, verification checks (exit codes, output, timings and skips), workspace metadata, `git status --short`, changed paths, bounded `git diff --stat` and dirty/truncation flags. Completion requires Codex success and every discovered check passing. Repository coding jobs disable queue retries so a failed check never automatically invokes Codex again; other tasks retain existing queue behavior.

## Explicit cleanup

Successful and failed worktrees remain available for inspection. Call `removeTaskWorktree(run.workspace)` explicitly to remove a clean worktree. It validates the controlled root, task UUID, path, branch, linked-worktree registration and repository identity before using `git worktree remove`. Dirty work requires the explicit option `{ force: true }`, which discards its uncommitted changes. The branch is retained. Task-supplied arbitrary paths, symlinked worktrees and original checkouts cannot be used as cleanup targets.

## Local commands

```sh
npm run db:migrate
npm run worker
```

Verification:

```sh
npm run typecheck
npm run router:test
npm run db:test
npm run queue:test
npm run worktree:test
```

Queue and worktree tests use fake executors; the CLI permission/parser check uses a fake executable. The worktree test creates a disposable repository and baseline commit, tests successful and failed verification, protects the original checkout, tests timeout/sandbox/cleanup guards, and explicitly removes its fixtures. These tests consume no AI subscription quota.
# orchestrator
