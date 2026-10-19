# Piper shadow

The shadow runs the existing scoped train host and dry-run executor. It records the executor's actual would-do journal, projects its payloads into comparable actions, and compares those actions with independent operator observations. The writer service rejects every call. There is no live-mode option and no admission flag to set.

## Run

From the workspace root:

```sh
pnpm shadow --repo sample/project --since 2026-01-01T00:00:00Z \
  --replay test/fixtures/clean
```

The root script runs in `packages/shadow`. Use absolute paths for private recordings and inputs. Replay requires an exact repository and `since` match. It reads only recording files; it does not construct a token provider or HTTP client.

For observation, supply `GITHUB_TOKEN` and `PIPER_GITHUB_TOKEN_EXPIRES_AT` through the environment. The latter is an epoch-millisecond expiry within one hour, matching the executor's token contract. Start before the operator departs; current GitHub state cannot reconstruct candidate eligibility at an earlier departure.

```sh
pnpm shadow --repo sample/project --since 2026-01-01T00:00:00Z \
  --record /var/tmp/synthetic-shadow-run \
  --read-interval-ms 2000 --min-rate-fraction 0.2
```

### Renewable observation tokens

For long observations, use `--token-command /absolute/path/to/executable` instead of `GITHUB_TOKEN`. The executable receives no arguments and runs directly, without a shell. It must exit successfully and write only the token to stdout. Leading and trailing whitespace is removed. Stdin and stderr are ignored. Give the command read-only repository access; the observer still uses GET only.

The token stays in memory. Its assumed lifetime defaults to 50 minutes. `--token-ttl-ms <positive-integer>` overrides that lifetime; choose a value no longer than the issuer's actual lifetime. The next read renews the token once 90% of the lifetime has elapsed, before sending a request. Idle observations do not start a background renewal process. Concurrent reads share one mint. A failed, unsuccessful, or empty mint stops the run with a typed error; it does not fall back to an older token. Successful reads and existing train recordings remain preserved by the normal interrupted-run path.

Do not set `GITHUB_TOKEN` with `--token-command`. The expiry environment variable applies only to environment tokens. Neither tokens nor the command path enter recordings or provider error messages. Replay never constructs or invokes a token command.

The record directory must be new. Its parent must exist. The recorder resolves symlinks in the parent and rejects a `.git` ancestor, including worktrees. It creates the directory with mode `0700` and train JSON files with mode `0600`. Do not commit real recordings, trace files, CLI output, or event files. The CLI writes structured reports to stdout, which is private too.

Polling starts once and then waits 60 seconds after each pass. All HTTP reads share a minimum interval, default 2000 milliseconds. A small XState machine owns read, backoff and completion; Effect owns HTTP, time, tokens and recording. It honours numeric and HTTP-date `Retry-After` values on 403/429, with a 60-second fallback and at most four attempts. Exhaustion exits nonzero. When `x-ratelimit-remaining / x-ratelimit-limit` falls below `--min-rate-fraction`, default `0.2`, it stops without retrying. The last successful response is retained before that stop. `partial.json` preserves successful network reads so far. Existing train files retain their last completed frame. A first partial train has an empty frame list and cannot earn a match.

The observer uses GET only. Repository paths are validated and tokens are passed only as authorization headers. Recordings contain response values and repository-relative paths, never request headers or environment values.

## Three separate seams

- `GitHubFeed` owns observations supplied to the train. The GitHub layer reads labelled, non-train pull requests in creation order, their heads, exact-head check runs and merge-base ancestry against main. Defaults are label `train`, review label `reviewed`, five cars, a 60-second poll and a 30-minute CI timeout. Programmatic callers supply `TrainInput` and can replace the feed layer.
- `OperatorTrace` owns independent operator facts. Its GitHub layer reads train pull requests, first-parent merge chains, ready events, merge parents, label removals and workflow attempts. Private adapters implement the same port. `combineSources` runs several adapters; `mergeTraces` retains every observation without choosing a winner.
- `compare` is pure. Its input is a projection of actual would-do payloads plus a normalized trace. `projectWouldDo` decodes build, open, merge and label payloads rather than treating a machine intent as proof that the executor would send it. PR identity for ready/notification actions comes from the executed intent because GitHub's GraphQL node ID does not encode a PR number.

`capturePoll` requires the GitHub, feed and trace ports. The CLI provides read-only GitHub layers. No Worker or external executor process is needed. The train host restores through `createEffectActor(machine, { snapshot })` at each mailbox barrier. Replay pins executor timestamps to each recorded frame and uses only that frame's reads. Missing reads fail closed; there is no network fallback.

## Normalized trace contract

`TraceSchema` contains `actions`, `acceptances`, and `complete`. `complete: true` means a source attests the full action history for this train, not just its member list. Partial sources must keep it false. Every action has:

| Field | Meaning |
| --- | --- |
| `slot` | Zero-based canonical position in the operator's action sequence for this train |
| `at` | Observation timestamp in epoch milliseconds |
| `source` | Adapter/source identifier for every supplied field |
| `kind` | `BuildTrain`, `OpenTrainPr`, `MarkReady`, `Merge`, `RemoveLabels`, `RerunChecks`, `NotifyOwner`, or `CloseTrainPr` |
| `head` | Exact tested head; for `BuildTrain`, the base SHA the reference is reset to |
| `cars` | Ordered car head SHAs, when known |
| `members` | Ordered car PR numbers, when known |
| `prs`, `label` | Targets and label, when applicable |
| `mergeSha` | Actual merge result, when known |

Optional fields mean unknown, not empty. Two sources corroborate an action by supplying the same canonical `slot`. Each keeps its own `source`. One can supply `cars` and the other `members`. The report returns every original observation, so each field's provenance remains visible. Different values for the same field at the same slot produce a `conflict` diff containing both values. A private adapter must align partial GitHub observations with its canonical sequence explicitly; the merge function never guesses that alignment. Conflicts in timestamps alone are not action mismatches.

The comparator reports missing and extra actions, different heads, different cars or targets, and ordering differences. Missing field evidence is pending. A missing merge-result receipt is pending. An incomplete trace is never a match. Mismatches take precedence over pending reasons, which remain in the report.

GitHub alone is deliberately incomplete. Deleted branches, force-updated train histories, car heads changed since departure, notification bodies, and precise historical ready/rerun heads may be unavailable. The GitHub reader does not infer an acceptance, a GO, or the missing head from a later merge. It does not claim complete history. A private adapter can supply missing facts from an operator log, including ordered member numbers, without putting that log or its format in this package. Raw reads remain available to that adapter.

## Explicit inputs

`--trace <directory>` loads a private `train-<number>.json` conforming to `TraceSchema` on every poll and merges it with GitHub evidence. Sources must use the canonical slot contract above. `--events <file>` loads an array of `{ train, event }` values using core `PostedEventSchema`. Use this for configured plans and exact-head operator GO inputs. Plan events precede departure. Other due events follow the current poll's observations. Events are consumed once by timestamp within the observer session; use unique increasing times for successive inputs.

An acceptance entry is `{ head, fact }`. `fact` is the executor's unchanged `OperatorAcceptanceSchema`: `{ kind: "operator-acceptance", at, by, nodes }`. The wrapper binds it to an exact head without changing the shared schema. A nonempty accepted node list is required. A merge, a GO, a removed label, or an absent candidate is not acceptance.

The public schemas and port are the integration boundary. This package includes no adapter for a private log and no real repository data. Private code can also construct a complete `RecordingSchema` and call `runRecording` directly.

## Recording and limits

A version-1 train recording contains `input`, `since`, chronological `frames` and a normalized `trace`. Each frame contains `at`, posted `events` and successful/missing raw `reads` keyed by repository and path. Repeated reads within a poll use the first captured response. This prevents one replay frame from mixing two responses to the same path. Discovery responses are also copied into each active train's frame. `partial.json` is an interrupted read receipt, not a complete train recording.

The observer preserves its frames and reconstructs the machine from them on each poll. Restart by replaying the recording; automatic live resume is not implemented. A new live invocation needs a new private directory. Reads are bounded: listing refuses more than ten pages, candidate check reads refuse truncation, and workflow reads refuse more than 100 runs. The observer exits rather than accepting an incomplete API page as an empty queue. A public API limit can still hide history, so the GitHub trace stays incomplete.

The fixtures cover a three-car train, a red/bisect, a main-moved rebuild, a hand-fix difference, and a different merge head. They run the real core host and executor without GitHub or a token. Three synthetic matches do not satisfy a live three-train acceptance gate. A caller counts distinct train reports with `status: "match"` only after supplying complete real evidence and explicit acceptance.
