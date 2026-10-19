# Piper

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/piper-map-dark.svg">
  <img alt="Piper drawn as a chewed Tube map: the Run line from Queue through Checks to the Nest, with Gnaw, Sniff, Trail and the Hoard loop" src="docs/piper-map-light.svg">
</picture>

Piper leads your PRs to main in single file. The `@joelhooks/piper` package models a merge train and investigates failed pull-request checks. It keeps decisions in XState machines and runs those machines through Effect. This package computes work requests. It does not call a hosting provider, merge code, or deploy anything. Source: [joelhooks/piper](https://github.com/joelhooks/piper).

## Run the checks

Use Node 24.18 or newer within Node 24, and pnpm 11.3.0. The repository pins both tools in `.nvmrc` and `package.json`.

```sh
corepack pnpm@11.3.0 install --frozen-lockfile
pnpm check
```

`pnpm check` runs the strict TypeScript check, the lint and formatting fence, the lint-exemption ratchet, and all tests. Run `pnpm test` for tests alone. Run `pnpm fix` to apply lint fixes and formatting. Installation patches the TypeScript compiler with `@effect/tsgo` and installs the pre-commit hook.

## What the machines do

**Train:** select eligible pull requests in operator order, build them together, and wait for checks on the exact build head. A green train needs an operator's head-bound GO before it requests a merge. A changed main branch triggers a rebuild. A failed train narrows suspects through probe builds and removes a culprit. Judge rankings order suspects. A timeout earns one retry only when every car has a known probability below 0.2.

**Solo triage:** retry failed checks once in the same workflow context. Checks that remain red run against the original base without the patch. The results distinguish a flake, runner failure, broken base, and patch regression. Judge calls annotate the record. They cannot change the outcome or requested work.

Both machines append intents to an outbox and facts to a ledger. An external executor must carry out each intent and return the resulting event. Use intent IDs to identify work. An integration must supply its own delivery and idempotency guarantees.

## Core modules

| Module | Owns |
| --- | --- |
| `packages/core/src/domain.ts` | Effect schemas, events, intents, and facts |
| `packages/core/src/policy.ts` | Eligibility, latest check attempts, verdicts, and suspect ordering |
| `packages/core/src/machine.ts` | Train lifecycle |
| `packages/core/src/solo.ts` | Solo-triage lifecycle |
| `packages/core/src/host.ts` | Scoped train creation, restoration, stepping, and inspection |
| `packages/core/src/solo-host.ts` | Scoped solo creation, restoration, stepping, and inspection |
| `packages/core/src/vocabulary.ts` | Display vocabulary presets, schema, and pure notification rendering |

The host helpers are storage-independent. They restore with `createEffectActor(machine, { snapshot })`, deliver events, and wait for a mailbox barrier before returning a persisted snapshot. Deadlines and poll times live in context. An integration reads the next alarm time and posts a `tick`; there are no process-local timers to restore.

Repository settings are explicit inputs: `trainLabel`, `ignoredChecks`, and `aggregateChecks`. The synthetic examples use `train`, `branch-current`, and `checks`. These names carry no provider-specific policy.

## Plan graph

`@joelhooks/piper/plan` exports `PlanSchema`, `decodePlan`, `readyNodes`, `conflictPairs`, and `waves`. Nodes have a unique `id`, optional unique `pr`, optional `files`, and optional integer `priority`. Lower priorities board first. Edges use `{ before, after }` node IDs.

`decodePlan` returns an Effect `Result` with typed structural or graph errors. Graph errors distinguish duplicate IDs, ambiguous PR assignments, unknown references, and cycles. `PlanSchema` also rejects invalid graphs when nested in another schema.

`readyNodes(plan, landed)` reads a set of landed node IDs and returns nodes whose direct prerequisites have landed, including already-landed nodes. `waves(plan)` returns dependency layers in input order. Layers do not separate file conflicts. `conflictPairs(plan)` returns both directions of every pair sharing an exact file string. Files are not normalized and missing file lists imply no known conflicts.

The graph is pure data, not another lifecycle. This module does not query a provider or infer landing from a missing candidate.

Post `{ _tag: "plan", at, plan, landed }` through `PostedEventSchema`. `landed` is a complete list of node IDs confirmed on main by the caller. The event replaces both the plan and those landing facts. Unknown landed IDs are rejected. Repost the plan with updated facts when a prerequisite lands. Nodes without PRs can represent external prerequisites, but they still need explicit landing facts.

At departure, `selectCars(pool, maxCars, rules, plan?, landed?)` holds nodes with unlanded prerequisites, skips already-landed nodes, and separates shared-file conflicts. The first conflicting candidate in priority order boards; the other remains in the pool for a later train. Lower integer priorities board first, with operator order breaking ties. Missing priorities and candidates outside the plan use priority zero. Candidates outside the plan retain the existing eligibility rules and operator order relative to each other. No plan, or an empty plan, produces exactly the original selection.

Plan updates do not change a train already building or testing. They govern selection at departure, not the exact-head checks, GO, or main-movement rules. `viewTrain` includes the current plan and landing facts. Both survive JSON snapshot restoration.

## Hosting

`packages/worker` (`@joelhooks/piper-worker`, private) adds a workerd-compatible HTTP host. `Train` and `Solo` Durable Objects each own one machine. `Depot` owns the directory. SQLite stores the snapshot and append-only event log in one transaction. Operator notes stay outside machine context. Requests and alarms share a per-object semaphore. Each alarm restores the actor and derives due work from context deadlines, rather than a process-local timer.

| Route | Purpose |
| --- | --- |
| `GET /` and `GET /health` | Discovery and health |
| `GET /state` | Current train, train summaries, and solo summaries |
| `GET /trains` and `POST /trains` | List or open trains |
| `GET /trains/:n` | Inspect one train |
| `GET /trains/:n/events` and `POST /trains/:n/events` | Read or append events |
| `GET /solos` and `POST /solos` | List or open solo triage |
| `GET /solos/:key` | Inspect one solo, keyed as `pr-<n>@<head>` |
| `GET /solos/:key/events` and `POST /solos/:key/events` | Read or append solo events |
| `POST /solos/:key/operator` | Append `{ action, note?, at? }`, including after triage ends |

Every write requires `Authorization: Bearer <token>`. `API_TOKEN` is a secret binding. Missing or empty bindings, missing headers, and incorrect tokens return 401 before state access. WebCrypto HMAC verification compares token values without a JavaScript string comparison. Durable Objects repeat the auth check at their own boundary. Reads are open unless `REQUIRE_READ_AUTH` is `"true"`; that switch protects discovery and health too.

Train opening accepts `{ train?, maxCars?, pollMs?, ciTimeoutMs? }`. Solo opening accepts `{ pr, head, owner, base, checks, at?, pollMs?, ciTimeoutMs? }`. Event posts accept one tagged event or an array. Missing timestamps default to receipt time. All write bodies pass through Effect schemas before mutation. Candidate posts also open solo triage for failed checks with a recorded base.

Bindings default to `REPO="repository"`, `TRAIN_LABEL="train"`, empty comma-separated `IGNORED_CHECKS` and `AGGREGATE_CHECKS`, and the core's `DEFAULT_CARS` for `MAX_CARS` (8). Polling defaults to 90 seconds and CI timeout to one hour. The Worker only records machine intents. An external executor still owns provider calls and idempotent delivery.

```sh
pnpm worker:plan
```

`packages/worker/alchemy.run.ts` declares the Worker, its three Durable Object bindings, and `Config.Redacted("API_TOKEN")`. It exports `infrastructure(settings)` so a private deploy profile can wrap the same declaration in its own `Alchemy.Stack` with its own account and state. Settings cover `requireReadAuth`, `trainLabel`, `maxCars`, `aggregateChecks`, `ignoredChecks` and `workerName`. The Worker is named `piper` unless `workerName` says otherwise, so every plan targets the same Worker. `apiToken: "external"` leaves `API_TOKEN` out of the declaration and out of Alchemy state. The deploy profile then sets the Worker secret itself after every apply. Until it does, the Worker refuses every authenticated request. Reads require the bearer token unless `requireReadAuth: false` is passed. The command bundles the Worker for a browser runtime and compiles the Alchemy declaration offline using a synthetic token. It prints resource and binding names only. This dry run is not a provider diff or deployment. No account or domain is configured. Deployment requires a separately approved provider profile, a real secret, and review of the provider plan. Keep the SQLite namespaces and storage when rolling back Worker code.

## Metrics

`GET /metrics` derives metrics from every train and solo registered in the Depot. Reads need a bearer token only when `REQUIRE_READ_AUTH="true"`. Nothing derived is stored or fed back into a machine. The request reads each cell in sequence; it is a full-directory read, not an atomic snapshot across cells. A failed cell read fails the request rather than returning a partial total. This endpoint has no pagination or cache.

`?since=<ms>` accepts a nonnegative integer Unix timestamp in milliseconds and includes facts at or after that time. Each count uses its fact's timestamp. Timing samples use the merge timestamp, but retain earlier green evidence for the same head. A window can contain a merge without its CI run, so windowed ratios need not match lifetime ratios. Invalid timestamps return 400.

| Field | Definition |
| --- | --- |
| `prsLandedPerCiRun` | Landed cars from merge facts divided by built facts plus rerun facts. Train builds, probe builds and explicit retries each cost one run. Includes `landed`, `ciRuns` and `rate`. |
| `greenToMergedMinutes` | Time from the latest green train verdict on the exact head to its merge. Probe verdicts, other heads and future verdicts do not qualify. |
| `mergeToLiveMinutes` | Time from merge to the first supplied live observation for that merge SHA. The Worker has no live observations, so this has no samples there. |
| `rebuildsByCause` | Counts for `main-moved`, `merge-refused`, `bisected` and `conflict`. |
| `culpritsPerBisect` | Culprit drop facts divided by bisect decisions. A judged fact starts a bisect unless a rerun fact has the same head and timestamp. Missing judges still count. Unfinished bisects stay in the denominator. |
| `solo.outcomes` | Counts of the seven recorded solo outcomes. Attempts and judgments are not outcomes. |
| `solo.checks` | Sorted check names, attempt counts by `original`, `rerun` and `baseline`, outcome counts, and `flakeRate`. The rate is flake outcomes divided by all recorded outcomes naming that check, including unknown, dismissed and superseded outcomes. Pending triage has no outcome denominator. Duplicate names within one outcome count once. This is a triage-outcome rate, not a claim about all CI executions. |

Timing summaries contain `samples`, `median` and `p90`. The median averages the middle pair for even populations. P90 uses the nearest rank. Missing timing samples and zero-denominator rates are `null`, not zero. A merged train without a green verdict still contributes landed cars, but no green-to-merged sample.

`@joelhooks/piper/metrics` exports the pure `metrics(trains, solos, options?)` function. Each input collection contains fact arrays, one per train or solo. Options accept `since` and optional `liveAt: [{ mergeSha, at }]` observations. `trainMetrics`, `soloMetrics` and `summarizeMetrics` support per-cell projection and aggregation without transporting entire ledgers. Machines remain the only writers of ledger facts.

## Release

Release owns a separate authority for an accepted main commit moving to production. Train and Solo behavior stays unchanged. `@joelhooks/piper/release-domain` exports the input, plan, expectation, intent, event, and fact schemas. `release-policy` exports the pure expectation checker and runway predicate. `release` exports the machine. `release-host` exports `openRelease`, `stepRelease`, `readRelease`, and `viewRelease`; hosts restore actors with `createEffectActor`, not transition replay.

The lifecycle is `planned → expectationCheck → review → armed → fired → observing → accepted`, or `restoring → restored`. Policy mismatches, unavailable review, review holds, and failed restoration finish `held`. An operator can `reject` before deployment. Each state transition appends a fact. Rejected, stale, or irrelevant events do not grant authority.

`ReleaseInputSchema` requires a unique `runId`, `target`, `previousTarget`, opening time `at`, `expectation`, `docs: { spec, diff }`, nonempty named `checks`, positive `observationTimeoutMs`, `minimumRunwayMs`, `windowEndsAt`, `blackoutUntil`, and `allowAbsentReview`. Times are nonnegative epoch milliseconds. Supply window and blackout facts using `window { at, windowEndsAt, blackoutUntil }`. Event times must not precede the last accepted fact. The host must authenticate operator and reviewer identities and supply trusted clock facts.

Opening emits `PlanRelease { target }`. Post `planned { at, rows }` after obtaining the plan. The pure checker holds any stop row, unmatched row, or unsatisfied required count. Empty plans hold unless explicitly permitted. The view and held fact preserve reason-tagged violations, including missing rows that cannot supply a row value. A passing plan emits `RequestReview { runId, plan, docs }`. The review port submits this payload asynchronously; its private adapter later posts `reviewed { at, verdict: "approve" | "hold", by }`. No reviewer means `reviewUnavailable`, which holds by default. Explicit `allowAbsentReview: true` permits arming without a reviewer, records that absence, and never creates an approval verdict.

Only an explicit `fire { at, by }` in `armed` can emit `Deploy { target }`. Fire checks that `at >= blackoutUntil` and `windowEndsAt - at >= minimumRunwayMs`, including equality. Approval, ticks, and window updates cannot fire. A restored snapshot never re-emits deployment. After `deployed { at }`, the machine emits `Observe { checks, deadlineAt }` and sets its deadline. Named `observed { at, check, outcome: "pass" | "fail" | "unknown" }` events all need to pass before the deadline. Any failure, or a `tick` at or past the deadline with incomplete checks, emits `Restore { to: previousTarget }`. The host must schedule the deadline reported by `viewRelease.alarmAt`. Unknown is never healthy. `restored` finishes recovery; `failed { operation: "Restore", reason, at }` holds. Deployment failure starts recovery; planning failure holds. Commands and restoration strategy belong to adapters, not the machine.

### Plan and expectation JSON

Plans are arrays of opaque records. Map private provider output into this public shape before posting it:

```json
[
  {
    "id": "resource-a",
    "kind": "resource",
    "action": "update",
    "attributes": { "from": "before", "to": "after" }
  },
  { "id": "value-a", "kind": "computed", "action": "read" },
  { "id": "output-a", "kind": "deferred", "action": "read" }
]
```

```json
{
  "allowEmpty": false,
  "allowed": [
    { "kind": "resource", "action": "update", "attributes": { "to": "after" } },
    { "kind": "computed" },
    { "idPrefix": "output-", "kind": "deferred" }
  ],
  "stop": [{ "action": "delete" }],
  "required": [
    {
      "match": {
        "id": "resource-a",
        "attributes": { "from": "before", "to": "after" }
      },
      "max": 1
    },
    { "match": { "kind": "computed" }, "min": 1, "max": 1 },
    { "match": { "kind": "deferred" }, "min": 1, "max": 1 }
  ]
}
```

Rows may carry `attributes: Record<string, string>`. A matcher may contain `id`, `idPrefix`, `kind`, `action`, and `attributes`. Supplied fields are conjunctive; strings compare exactly, except `idPrefix`. Every supplied attribute key must exist with its exact value. Missing or unequal attributes do not match. Additional row attributes are permitted. Allowed matchers form a union. Stop wins even when allowed also matches. An empty matcher `{}` explicitly matches every row; an empty allowed list permits no rows. No provider-specific meaning is attached to any field.

`required` is an optional array of `{ match, min?, max? }` constraints. Each counts all rows matching its matcher. An omitted minimum means one; an omitted maximum is unbounded. Counts must be nonnegative integers, and a supplied maximum cannot be below the effective minimum. Set both bounds to the same count for an exact set size. Set `min: 0` explicitly when zero matches are valid. Required matchers constrain presence and counts; they do not implicitly allow rows. Omitting `required` means no additional count constraints.

An empty plan holds by default, independently of allowed and required matchers. Only `allowEmpty: true` removes that empty-plan restriction; required constraints still apply. Violations have shape `{ row?, reason, matcher? }`. Reasons are `stop`, `unmatched`, `requiredMissing` for a count below its minimum, and `countOutOfRange` for a count above its maximum. Stop violations include their row and matcher; unmatched violations include their row. Count violations include their matcher but no invented row. The empty-plan refusal is `requiredMissing` with neither row nor matcher. `viewRelease.offending` and the held fact's `offending` array retain these entries.

The private fixture harness reads `PIPER_RELEASE_FIXTURES`, a directory containing `plan.json` and `expectation.json` in these shapes. The captured plan must include at least one stop row. After removing stop rows, all remaining rows must satisfy attribute matches and required count constraints in the richer expectation shape. The harness proves the full plan holds and the plan without stop rows reaches review. It skips with a clear message when the variable is unset. Keep the directory outside the repository; nothing copies or persists its contents. Run it with `PIPER_RELEASE_FIXTURES=/private/fixtures pnpm exec vitest run packages/executor/test/release-private-fixtures.test.ts`.

## Executor

`packages/executor` is the private `@joelhooks/piper-executor` package. It drains train, solo, and release jobs through Effect service Layers. The machines remain the only decision-makers. Its XState lifecycle recovers durable claims, drains once, and finishes. The CLI repeats this lifecycle every 30 seconds.

```sh
pnpm executor --repo sample/project --api https://worker.invalid --mode dry-run
```

`dry-run` is the default. GitHub requests use GET only. No live write Layer is constructed. A proposed write appends a `would-do` entry to the journal, containing `{ intentId, kind, repo, head, wouldDo }`. The head is an exact SHA from the intent or the observed machine state. `wouldDo` lists HTTP methods, provider paths, and request bodies. A proposed build records the base SHA and each car SHA; it never invents a resulting merge SHA. Dry-run does not fabricate `built`, `prOpened`, or `merged` events.

Read-derived check observations and advisory judge failures still go back to the Worker using authenticated event POSTs. **This means dry-run is read-only against GitHub, not against Piper.** Use a separate shadow Worker if its authoritative machine must remain untouched. Compare the journal with the human operator's actions. This package has not been qualified against a real GitHub repository.

### Configuration and ports

- `GITHUB_TOKEN`: a short-lived installation token. `PIPER_GITHUB_TOKEN_EXPIRES_AT` declares its expiration as epoch milliseconds. Empty, expired, undeclared, or over-one-hour leases fail closed. The supplied Layer rechecks expiry on every GitHub call. Restart with a fresh lease when it expires; a custom `TokenProvider` Layer can renew leases per call. No private key or token is persisted or logged.
- `PIPER_API_TOKEN`: the Worker's bearer token. Keep this separate from the GitHub token.
- `--state`: journal directory, default `.piper-executor` inside the executor package when using `pnpm executor`. That default is ignored by Git. Explicit state paths need equivalent protection. Use one writer per directory and preserve this directory across restarts and mode changes.
- `--read-interval-ms`: minimum spacing between provider requests, default 1000. Calls serialize, including bursts. A 403 or 429 delays subsequent requests by the greater of 60 seconds and `Retry-After` seconds. Failed writes are never automatically retried.
- `--base-branch`: target branch for train PRs, default `main`. The intent's base SHA remains the build input; it is not a branch name.
- `PIPER_BASELINE_WORKFLOWS`: JSON mapping from check names to workflow filenames, such as `{"unit":"unit.yml"}`. Completed checks on the exact base are reused. Otherwise the executor creates an exact-base branch and dispatches configured workflows there. Missing mappings fail closed. The baseline branch remains for operator cleanup. Polls of a solo's base SHA emit `baseline`, not patch-head `checks`.
- `GitHub`, `GitHubWrites`, `TokenProvider`, `Transport`, `Recorder`, `Journal`, `Outbox`, and advisory `Judge` are replaceable ports. Effect's `Clock` owns time. The default Judge is absent and emits `rankFailed`; it cannot grant merge authority. Provider responses pass through schemas. Check reads paginate up to 1000 checks and refuse incomplete observations; workflow run reads refuse more than 100 results. Worker reads refuse over 1000 cells or 10,000 intents per cell. These are conservative, unmeasured safety bounds, not measured capacity claims.

`--mode live` also requires `PIPER_LIVE_ADMITTED_REPO` to equal `--repo` exactly; otherwise it fails before reading a token or constructing any executor Layer. Dry-run ignores this variable.

`--mode live` explicitly constructs the live write Layer. It builds only reserved `train/<number>` branches with refs and REST merges, opens draft PRs, reruns workflows or named check runs, dispatches baselines, edits labels, comments, closes PRs, and merges with the tested `sha` precondition. Marking a draft ready uses GitHub's GraphQL mutation because REST does not expose that operation. A changed head or a refused guarded merge produces `mergeRefused`. No live mode invocation is authorized by the default dry-run command.

### Release commands and review

`PIPER_RELEASE_COMMANDS` configures named commands as JSON, for example:

```json
{
  "PlanRelease": { "command": "release-plan", "args": [] },
  "Deploy": { "command": "release-apply", "args": [] },
  "Restore": { "command": "release-restore", "args": [] },
  "Observe:availability": { "command": "release-check", "args": [] }
}
```

Plan and deploy append `["--target", target]`; restore appends `["--target", to]`; each named observation appends `["--check", check]`. The executor passes a command name and literal argv with `shell: false`. It never turns row values into a shell command or command arguments. Missing mappings fail closed. Plan stdout must be a JSON row array. Check stdout must be `{ "outcome": "pass" | "fail" | "unknown" }`. A nonzero exit or malformed check response is unknown, not pass. The observation deadline interrupts a hung check and prevents later checks from starting after the deadline. Deploy and restore require zero exit status before emitting their completion events. The executor never retries commands automatically.

Release dry-run executes no commands, constructs no live command Layer, submits no review job, and fabricates no release events. Its journal records each command name and argv using `wouldDo` entries with `path: command`, `method: "POST"`, and `body: { args }`. Review proposals use `path: "RequestReview"` and the complete submission payload. Live commands require the existing exact repository admission gate. The CLI constructs the Node spawner only in live mode. `ReleaseCommandConfig`, `ReleaseCommands`, and `ReleaseReviewer` are replaceable ports. The default reviewer is absent; a private adapter implements asynchronous submission and separately posts a schema-checked verdict. No customer adapter or doctrine ships here.

Release jobs use `_tag: "release"` and the same journal claim identity and delivery protocol as other machines. A host supplies these jobs through `Outbox` and translates tagged posted events with `toReleaseEvent`. This change adds no Release routes to the existing Worker. A private or future public host must own storage, routing, trusted clocks, review callbacks, and operator authentication before enabling release execution.

### Claims, outcomes, and recovery

The append-only `journal.jsonl` is the authority for executor progress. It is separate from the machines' authoritative outboxes and ledgers. Every record is schema-validated and fsynced. A stable identity combines repo, machine kind, target, and intent ID. `claimed` is persisted **before** execution; `settled` stores exactly one execution outcome: `done`, `failed` with a typed error, or `recorded-would-do`. The set of durable claims is the cursor. New reads may include old outbox rows, but those rows never execute again.

A recovered claim without a settlement becomes a typed `interrupted` failure. It is never replayed, even if the provider may have accepted it before the crash. This is at-most-once execution, not a promise of distributed exactly-once delivery. An interruption can require manual provider reconciliation and a new machine intent. Defects remain defects during the running invocation.

Events are saved with the outcome before delivery. `delivering` is persisted before the Worker POST, and `delivered` after success. A crash or ambiguous response between those records leaves an **unconfirmed delivery**, not permission to POST again. Inspect those entries and the Worker's event history before reconciling manually. The current Worker API has no intent-ID delivery receipt, so automatic exactly-once event delivery is not available.

The file adapter holds an exclusive `writer.lock` containing `{ pid, startedAt, cursor }`, with no hostname. `cursor` is the last settled intent ID observed when the writer acquired its lock. A graceful stop releases it. A refused restart prints those holder fields and the exact lock path. After an ungraceful stop, verify that the named process is dead, then remove only that lock before restarting. Never delete, truncate, or replace the journal to clear a lock. A malformed or over-32-MiB journal stops execution for operator inspection. File fsyncs cover process-crash recovery; power-loss and remote-filesystem durability remain unqualified.

Changing from dry-run to live does not replay previously recorded proposals. Use the same claims and reconcile the shadow run before cutover. Start live only with explicit authorization and reconciled outbox history. Roll back by stopping the executor or returning to dry-run while preserving its journal. No deployment or GitHub write is needed to test this package.

### Landed credit

A CI pass or an `accepted` Release health result is an observation, never landed plan credit. `OperatorAcceptanceSchema` accepts explicit operator facts `{ kind: "operator-acceptance", by, at, nodes }`; `landedNodes` derives only those accepted node IDs. An operator may supply those IDs when posting a plan event. The executor never emits GO, plan acceptance, or landed-credit facts from a check result or a provider merge response.

## Shadow

`packages/shadow` is the private `@joelhooks/piper-shadow` package. It runs the train host and executor in-process, always in dry-run, and compares the executor's recorded operations with an operator trace. It has no live writer. `GitHubFeed` reads candidates and exact-head checks. `OperatorTrace` accepts GitHub observations and additional private adapters. The pure comparator preserves source conflicts and reports missing, extra, different-head, different-car, and ordering differences.

```sh
pnpm shadow --repo sample/project --since 2026-01-01T00:00:00Z \
  --replay ../../packages/shadow/test/fixtures/clean
```

Replay needs no token and never calls GitHub. Live observation uses `--record <new-private-directory>` outside every Git checkout. Requests default to at least two seconds apart; 403/429 responses trigger bounded backoff. `--min-rate-fraction` defaults to `0.2`. A low shared rate budget stops the process with a nonzero exit and saves successful reads so far. Tokens come only from the environment and are never recorded.

A merge alone does not count as acceptance. A matching train needs a separate head-bound input containing the executor's `OperatorAcceptanceSchema`, complete operator history, and matching actions. Otherwise it remains `pending` or reports a `diff`. Three synthetic matching scenarios are tests, not evidence of three real matching trains. See [the shadow contract](packages/shadow/README.md) for recording, source provenance, explicit GO/plan inputs, and the limits of GitHub history.

## Tests and development fence

The property suites generate event traces and check the rules at each step. They cover the car cap, exact-head green plus GO, bisect progress, main movement, retry accounting, attempt retention, and owner notifications. Both suites compare an uninterrupted run with a JSON snapshot restored at an arbitrary cut. The solo suite also drops and scrambles judge calls and compares outcomes, attempt facts, and intents. Both suites replay generated traces while rendering notifications with arbitrary decodable vocabularies and verify unchanged machine state, intents, and facts. Fixed-seed coverage checks verify that generated traces reach the outcomes they claim to test. All fixtures use synthetic contributors, revisions, checks, and pull-request numbers.

Oxlint and Ultracite enforce the no-comments rule, anti-slop rules, XState/Effect boundaries, and Effect-native tests. The lint-exemption baseline is zero. Lefthook runs the gate before a commit. Agent hooks reject hook-bypass commands. See [AGENTS.md](AGENTS.md) for the contribution gate and [PROVENANCE.md](PROVENANCE.md) for sources and adaptations.

## Glossary

The code and API keep plain domain names. The glossary is the default `rat` display preset. `@joelhooks/piper/vocabulary` exports `VocabularySchema`, `rat`, `plain`, and `renderNotification`. To supply your own, decode a complete record with `Schema.decodeUnknownSync(VocabularySchema)` and pass it as the renderer's second argument. Missing keys are rejected. Vocabulary never enters the machines, events, policy, intents, or ledger.

| Rat voice  | Domain term                                              |
| ---------- | -------------------------------------------------------- |
| run        | train                                                    |
| rat        | pull request or car                                      |
| gnaw       | bisect                                                   |
| sniff test | solo triage; a whiff is a flake, a stink is a regression |
| whiskers   | judge; suggests, never decides                           |
| hoard      | ledger                                                   |
| nest       | main                                                     |
| rat king   | conflict                                                 |
| maze       | invariants no configuration can change                   |

## Scope

This first stage contains only core machines, policies, host helpers, tests, and development tooling. Provider executors, Workers, durable storage, authentication, and infrastructure belong in later stages.

MIT. See [LICENSE](LICENSE).
