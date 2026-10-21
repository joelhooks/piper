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

**Train:** select eligible pull requests in operator order, build them together, and wait for checks on the exact build head. A green train needs an operator's head-bound GO before it requests a merge. A changed main branch triggers a rebuild. A failed train narrows suspects through probe builds and removes a culprit. Judge rankings order suspects. A timeout earns one retry only when every car has a known probability below 0.2. When every failing check is cancelled, fails to start, or is stale, the train or probe head reruns checks once before triage. Another environment-only red on the same head follows the usual triage or probe narrowing path. A car alone in its group lands without a train when its head already contains main and its own CI has proved every direct check group; it still needs a head-bound GO, and a moved main or refused merge sends it back to a train. Both landings mark their pull request ready for review right before its merge, because GitHub refuses to merge a draft. Every departure records its path, `direct-land`, `lone-board` or `train`, and the reason.

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
| `packages/core/src/plan.ts` | Plan graph schema, `readyNodes`, `waves`, and `conflictPairs` |
| `packages/core/src/metrics.ts` | Pure metrics derived from train and solo ledger facts |
| `packages/core/src/not-red.ts` | `NotRed`, the typed refusal when a solo has no failing check |
| `packages/core/src/candidate.ts` | `decideCandidate`: classifies the range from the live release to main as unchanged, no change, candidate, schema first, desk fire, or unknown |
| `packages/core/src/release-domain.ts` | Release input, plan, expectation, intent, event, and fact schemas |
| `packages/core/src/release-policy.ts` | Pure expectation checker and runway predicate |
| `packages/core/src/release.ts` | Release lifecycle |
| `packages/core/src/release-host.ts` | Scoped release creation, restoration, stepping, and inspection |
| `packages/core/src/config.ts` | `PiperConfigSchema`, `definePiperConfig` and `decodePiperConfig`: one typed home for a repository's settings |
| `packages/core/src/schema-paths.ts` | The path-only schema issue extractor shared by the config, train and release decoders |

The host helpers are storage-independent. They restore with `createEffectActor(machine, { snapshot })`, deliver events, and wait for a mailbox barrier before returning a persisted snapshot. Deadlines and poll times live in context. An integration reads the next alarm time and posts a `tick`; there are no process-local timers to restore.

Repository settings are explicit inputs: `trainLabel`, `ignoredChecks`, and `aggregateChecks`. The synthetic examples use `train`, `branch-current`, and `checks`. These names carry no provider-specific policy. A train input may also list `candidateIgnoredChecks`: checks ignored only when deciding whether a car may board. Use it for a gate that is red by design on pull requests and only means something on the train head, such as a full-suite rollup. The train head is still judged on it. `requireUpToDate: false` lets a car board when its branch is behind main. The train branch merges every car onto main, so the train head's CI still judges the combined code. `candidateRequiredChecks` lists groups of check names: a car may board once every check in any one group has succeeded (skipped does not count), even while its other checks still run. A completed failure on any other check that isn't ignored still refuses the car. Without it, every car check must finish green before boarding. These check rules apply when two or more pull requests share the candidate pool, because one car's red would sink the others. A lone car boards on push: absent and pending checks do not hold it, and only a completed, failed, non-ignored check refuses it. The label, review and up-to-date rules still apply. `directRequiredChecks` lists check groups for the direct path, and is off when absent or empty. A lone car lands without a train only when its head contains main, its own checks on that head are complete and green under `ignoredChecks`, and every check in every group has succeeded. Skipped does not count. Otherwise it boards a train.

## Repository configuration

`@joelhooks/piper/config` gives each repository's settings one typed home. A repository writes `piper.config.ts` with `definePiperConfig`, which only types the object. `decodePiperConfig(value)` decodes it with `PiperConfigSchema` and fills the defaults. It rejects unknown keys at every level. A failure is a `PiperConfigError` that lists every bad path, sorted, and never the rejected value. [`packages/core/examples/piper.config.ts`](packages/core/examples/piper.config.ts) configures a fictional `acme/shop` with three Workers.

| Section | Fields and defaults |
| --- | --- |
| `repo` | `owner`, `name` and `base`. The base branch has no default, as in the train admission. |
| `mergeLine` | `approval` says where GO rows come from: `{ _tag: "File", path }`. `labels.train` (`train`), `labels.hold` (`hold`) and `labels.fullCi` (`full-ci`) must differ. `checks.train`, `checks.direct`, `checks.ignored` and `checks.ignoredAtBoarding` are core's `candidateRequiredChecks`, `directRequiredChecks`, `ignoredChecks` and `candidateIgnoredChecks`; each defaults to empty. `maxCars` defaults to 8, `pollMs` to 90 seconds, `ciTimeoutMs` to one hour and `requireUpToDate` to true. These four reuse core's train input schemas, so the ten-second poll floor is the same rule. `excluded` lists PR numbers and defaults to none. |
| `deploy` | `paths.include` is required; `paths.exclude` and `migrations` default to none. `codeOnly` defaults to true. `ship` is `{ _tag: "Command", command, args }` or `{ _tag: "Workflow", workflow, ref }`. `lock` and `prep` are optional commands. `reviewCriteria` is an optional `{ _tag: "File", path }`. Paths are relative to the repository root and contain no `..`. |
| `units` | Deployable Workers: a logical `name`, a Worker `script`, and `primary` and `scheduled`, both false by default. Names and scripts are distinct. At most one unit is primary. |
| `observe` | `checks` lists `{ name, onFail: "escalate" \| "restore" \| "alarm" }` with distinct names. `cadence` defaults to `minMs` 15 seconds and `maxMs` 15 minutes; `minMs` cannot exceed `maxMs`. `timeoutMs` is required. The optional `canary` is `{ url, secret }` with an https URL. |
| `alarms` | Alarm-only signals: `StartupCpuJump { unit, ratio }` against the last release, and `OutsideWindows { timeZone, windows }`. No alarm can refuse a release. The type has no refusing variant or field. |
| `contacts` | `owner` is required. `alerts` and `cc` default to none, and `sender` to `Piper`. |

Secrets are references, never values. `SecretRefSchema` accepts `{ _tag: "Env", name }`, `{ _tag: "Store", store, name }` or `{ _tag: "CloudflareSecret", name }`. Every free-text field rejects text that looks like an inline credential. That covers known token prefixes, private-key blocks, JWTs, bearer headers, passwords in URLs, `token=`-style assignments and long mixed-case alphanumeric runs. Build tagged values with their schema, for example `SecretRefSchema.cases.Env.make({ name: "SHOP_CANARY_TOKEN" })`.

Today only the train admission reads a config, through `trainAdmission` in `@joelhooks/piper-executor/train-config`. See [the train admission contract](packages/executor/TRAIN.md). The deploy, units, observe, alarms and contacts sections are typed for later steps.

## Packages

| Package | Owns | Run |
| --- | --- | --- |
| `packages/core` (`@joelhooks/piper`) | Machines, policy, host helpers, plan graph, metrics, release, candidate decision, repository config | `pnpm test` |
| `packages/worker` (`@joelhooks/piper-worker`) | HTTP host: Durable Objects, SQLite storage, auth, routes, `/metrics`, Alchemy declaration | `pnpm worker:plan` |
| `packages/executor` (`@joelhooks/piper-executor`) | Drains train, solo and release jobs; admitted train and release drivers; the claim journal. Bin `piper-executor` | `pnpm executor --repo <owner/repo> --api <url>` |
| `packages/shadow` (`@joelhooks/piper-shadow`) | Dry-run train comparison against an operator trace. Bin `piper-shadow` | `pnpm shadow --repo <owner/repo> --since <time> --replay <dir>` |
| `packages/observe` (`@joelhooks/piper-observe`) | Release observation checks for a Vercel project with Axiom logs. Bin `piper-observe` | `pnpm observe --config <file> --check <name> [--baseline]` |

Details for each package follow in its section below.

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

Train opening accepts `{ train?, maxCars?, pollMs?, ciTimeoutMs? }`. Solo opening accepts `{ pr, head, owner, base, checks, at?, pollMs?, ciTimeoutMs? }`. `pollMs` ranges from 10,000 to 120,000 milliseconds and defaults to 90,000. Event posts accept one tagged event or an array. Missing timestamps default to receipt time. All write bodies pass through Effect schemas before mutation. Candidate posts also open solo triage for failed checks with a recorded base.

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
| `departuresByPath` | Departure facts by path: `direct-land`, `lone-board` and `train`. A direct landing that falls back adds a `train` departure. A direct landing lands its car without a CI run. |
| `culpritsPerBisect` | Culprit drop facts divided by bisect decisions. A judged fact starts a bisect unless a rerun fact has the same head and timestamp. Missing judges still count. Unfinished bisects stay in the denominator. |
| `solo.outcomes` | Counts of the seven recorded solo outcomes. Attempts and judgments are not outcomes. |
| `solo.checks` | Sorted check names, attempt counts by `original`, `rerun` and `baseline`, outcome counts, and `flakeRate`. The rate is flake outcomes divided by all recorded outcomes naming that check, including unknown, dismissed and superseded outcomes. Pending triage has no outcome denominator. Duplicate names within one outcome count once. This is a triage-outcome rate, not a claim about all CI executions. |

Timing summaries contain `samples`, `median` and `p90`. The median averages the middle pair for even populations. P90 uses the nearest rank. Missing timing samples and zero-denominator rates are `null`, not zero. A merged train without a green verdict still contributes landed cars, but no green-to-merged sample.

`@joelhooks/piper/metrics` exports the pure `metrics(trains, solos, options?)` function. Each input collection contains fact arrays, one per train or solo. Options accept `since` and optional `liveAt: [{ mergeSha, at }]` observations. `trainMetrics`, `soloMetrics` and `summarizeMetrics` support per-cell projection and aggregation without transporting entire ledgers. Machines remain the only writers of ledger facts.

## Release

Release owns a separate authority for an accepted main commit moving to production. Train and Solo behavior stays unchanged. `@joelhooks/piper/release-domain` exports the input, plan, expectation, intent, event, and fact schemas. `release-policy` exports the pure expectation checker and runway predicate. `release` exports the machine. `release-host` exports `openRelease`, `stepRelease`, `readRelease`, and `viewRelease`; hosts restore actors with `createEffectActor`, not transition replay.

The lifecycle is `planned → expectationCheck → review → armed → fired → observing → accepted`, `observing → escalated`, or `restoring → restored`. Policy mismatches, unavailable review, planning failures, and failed restoration finish `held`. A review hold enters `reviewHeld` when an override identity is configured; otherwise it finishes `held`. An operator can `reject` before deployment. Each state transition appends a fact. Rejected, stale, or irrelevant events do not grant authority.

`ReleaseInputSchema` requires a unique `runId`, `target`, `previousTarget`, opening time `at`, `expectation`, `docs: { spec, diff }`, nonempty `checks: [{ name, onFail: "restore" | "escalate" }]`, positive `observationTimeoutMs`, `minimumRunwayMs`, `windowEndsAt`, `blackoutUntil`, and `allowAbsentReview`. Optional `overrideBy` names the single release owner allowed to override a review hold. Without it, overrides are never accepted. Times are nonnegative epoch milliseconds. Supply window and blackout facts using `window { at, windowEndsAt, blackoutUntil }`. Event times must not precede the last accepted fact. The host must authenticate operator and reviewer identities and supply trusted clock facts.

Opening emits `PlanRelease { target }`. Post `planned { at, rows }` after obtaining the plan. The pure checker holds any stop row, unmatched row, or unsatisfied required count. Empty plans hold unless explicitly permitted. The view and held fact preserve reason-tagged violations, including missing rows that cannot supply a row value. A passing plan emits `RequestReview { runId, plan, docs }`. The review port submits this payload asynchronously; its private adapter later posts `reviewed { at, verdict: "approve" | "hold", by }`. No reviewer means `reviewUnavailable`, which holds by default. Explicit `allowAbsentReview: true` permits arming without a reviewer, records that absence, and never creates an approval verdict.

Only `reviewHeld` accepts `override { at, by, reason }`, where `by` must equal `overrideBy`, `reason` must be nonempty, and `at` must not precede the last accepted fact. It resumes the same run in `armed`, exactly like review approval, without emitting deployment or bypassing fire-time window and runway checks. Its fact includes `kind: "override"`, `at`, `by`, and `reason`, alongside the transition cause and state. Other identities, stale overrides, and repeat overrides do nothing. No other hold or rejection can be overridden, even if a provider failure reason says `reviewed`. `reviewHeld` is active and also accepts a non-stale `reject` to finish `rejected` without an override fact; `held` remains final. Persisted snapshots, `stepRelease`'s `ReleaseFinished`, and `viewRelease.status` retain terminal behavior for every non-overridable hold.

Only an explicit `fire { at, by }` in `armed` emits `Baseline { checks }` followed by `Deploy { target }`. The baseline runs each check's existing `Observe:<name>` command with literal `--check <name> --baseline` arguments, through the same command table. It posts `baselined { at, check, outcome: "pass" | "fail" | "unknown" }` per check. Baselines received in `fired` are stored per declared check and recorded as `kind: "baseline"` facts. Stale, unlisted, pre-fire, and post-deploy baseline events do not change the run. Baseline results do not gate deployment; missing or unknown results count as not passed. Command failures, malformed results, and missing command mappings produce unknown baselines in live mode. Dry-run records baseline commands without running them.

Fire checks that `at >= blackoutUntil` and `windowEndsAt - at >= minimumRunwayMs`, including equality. Approval, ticks, and window updates cannot fire. A restored snapshot never re-emits deployment.

After `deployed { at }`, the machine emits `Observe { checks, deadlineAt }` and sets its deadline. Checks retain their declared order for execution, but may report in any order. Every named check must pass before the deadline for acceptance. Post `observed { at, check, outcome: "pass" | "fail" | "unknown" | "breach" }`. A failure counts against the release only when the same check passed its pre-deploy baseline. With that passing baseline, a failed `restore` check emits `Restore { to: previousTarget }` and enters `restoring`; a failed `escalate` check emits `NotifyOwner { cause: "observationFailed", check }` and finishes `escalated`, leaving the new version in place for a forward fix. If the baseline failed, was unknown, or is missing, a failed check instead emits `NotifyOwner { cause: "observationPreexisting", check }` and finishes `escalated`, whatever `onFail` says. It never restores for that failure. Failure still takes precedence over expiry, even at or past the deadline while observing.

A `tick`, `pass`, or `unknown` observation at or past the deadline emits `NotifyOwner { cause: "observationExpired" }` and finishes `escalated`, never restoring. The dedicated `breach` outcome means a hard threshold was crossed: it restores regardless of the check's failure action, even at or past the deadline while still observing. Keeping breach as an observation outcome binds that authority to a declared check rather than adding an unscoped restore command. Unknown keeps observing before the deadline and never counts as healthy. Unlisted checks and stale events are ignored. While observing, `superseded { at, by, evidence }` records that a newer release has taken over the unsettled window. The run finishes `superseded`, with no restore and no owner notification, and keeps the successor and the evidence (for example, partial counts) as a fact. Outcomes that already moved the run out of observing keep their effect. A breach reported after supersession is ignored, because traffic has moved to the successor. Final states accept no further observations. The host must schedule the deadline reported by `viewRelease.alarmAt`. `restored` finishes recovery; `failed { operation: "Restore", reason, at }` holds. A failed deploy emits `NotifyOwner { cause: "deployFailed" }` and finishes `escalated`, keeping the failure reason as a fact. It never restores: a failed apply may have moved some, all or none of the target, and the machine does not act on a state it cannot see. The owner's notify command reads back what moved, and restoring stays the owner's call. Planning failure holds. Commands and restoration strategy belong to adapters, not the machine. The executor maps `NotifyOwner` to a configured command with literal `--cause` and, for a failed check, `--check` arguments. Dry-run records that command without running it. Notification completion emits no release event; delivery failure remains an executor failure and cannot restore the release. Check commands may return the `breach` outcome.

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

### One admitted train

`pnpm executor train <admission.json> <state-dir>` runs one admitted car in-process, without a Worker. It uses a separate `polling`/`draining` machine, requires an explicit base branch, refuses automatic resumption after possible writes, and preserves the queue driver's JSON lines. Dry-run ends after the proposed build. See [the train admission, state and line contract](packages/executor/TRAIN.md).

`pnpm executor release ready|fire <config>` drives a release in-process. Preparation writes a commit-and-plan-bound READY record. Fire uses explicit operator words, per-check actors, a durable attempt log and live-fire-only message and verdict layers. See [the release configuration, records and safety boundary](packages/executor/RELEASE.md).

### Configuration and ports

- `GITHUB_TOKEN`: a short-lived installation token. `PIPER_GITHUB_TOKEN_EXPIRES_AT` declares its expiration as epoch milliseconds. Empty, expired, undeclared, or over-one-hour leases fail closed. The supplied Layer rechecks expiry on every GitHub call. Restart with a fresh lease when it expires; a custom `TokenProvider` Layer can renew leases per call. No private key or token is persisted or logged.
- `PIPER_API_TOKEN`: the Worker's bearer token. Keep this separate from the GitHub token.
- `--state`: journal directory, default `.piper-executor` inside the executor package when using `pnpm executor`. That default is ignored by Git. Explicit state paths need equivalent protection. Use one writer per directory and preserve this directory across restarts and mode changes.
- `--read-interval-ms`: minimum spacing between provider requests, default 1000. Calls serialize, including bursts. A 403 or 429 delays subsequent requests by the greater of 60 seconds and `Retry-After` seconds. Failed writes are never automatically retried.
- `--base-branch`: target branch for train PRs, default `main`. The intent's base SHA remains the build input; it is not a branch name.
- `PIPER_BASELINE_WORKFLOWS`: JSON mapping from check names to workflow filenames, such as `{"unit":"unit.yml"}`. Completed checks on the exact base are reused. Otherwise the executor creates an exact-base branch and dispatches configured workflows there. Missing mappings fail closed. The baseline branch remains for operator cleanup. Polls of a solo's base SHA emit `baseline`, not patch-head `checks`.
- `GitHub`, `GitHubWrites`, `TokenProvider`, `Transport`, `Recorder`, `Journal`, `Outbox`, and advisory `Judge` are replaceable ports. Effect's `Clock` owns time. The default Judge is absent and emits `rankFailed`; it cannot grant merge authority. Provider responses pass through schemas. Check reads paginate up to 1000 checks and refuse incomplete observations; workflow run reads refuse more than 100 results. Worker reads refuse over 1000 cells or 10,000 intents per cell. These are conservative, unmeasured safety bounds, not measured capacity claims.

`--mode live` also requires `PIPER_LIVE_ADMITTED_REPO` to equal `--repo` exactly; otherwise it fails before reading a token or constructing any executor Layer. Dry-run ignores this variable.

`--mode live` explicitly constructs the live write Layer. It builds only reserved `train/<number>` branches with refs and REST merges, opens draft PRs, reruns workflows or named check runs, dispatches baselines, edits labels, comments, closes PRs, and merges with the tested `sha` precondition. Marking a draft ready uses GitHub's GraphQL mutation because REST does not expose that operation. A pull request that is already ready gets no write. A changed head or a refused guarded merge produces `mergeRefused`. No live mode invocation is authorized by the default dry-run command.

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

Worker-outbox release-job dry-run executes no commands, constructs no live command Layer, submits no review job, and fabricates no release events. Its journal records each command name and argv using `wouldDo` entries with `path: command`, `method: "POST"`, and `body: { args }`. Review proposals use `path: "RequestReview"` and the complete submission payload. Live commands require the existing exact repository admission gate. The CLI constructs the Node spawner only in live mode. `ReleaseCommandConfig`, `ReleaseCommands`, and `ReleaseReviewer` are replaceable ports. The default reviewer is absent; a private adapter implements asynchronous submission and separately posts a schema-checked verdict. No customer adapter or doctrine ships here.

Release jobs use `_tag: "release"` and the same journal claim identity and delivery protocol as other machines. A host supplies these jobs through `Outbox` and translates tagged posted events with `toReleaseEvent`. This change adds no Release routes to the existing Worker. The dedicated release host owns its READY store, run log, observation clock and operator admission records. Applications must authenticate operator inputs before invoking it. Worker routing and asynchronous review callbacks remain separate adapters.

### Observe checks for a Vercel project with Axiom logs

`packages/observe` ships `piper-observe`, a generic check command for an app that deploys to a Vercel project and logs requests to an Axiom dataset. Map each check through the command table:

```json
{
  "Observe:readback": {
    "command": "piper-observe",
    "args": ["--config", "observe.json"]
  },
  "Observe:errors": {
    "command": "piper-observe",
    "args": ["--config", "observe.json"]
  },
  "Observe:canary": {
    "command": "piper-observe",
    "args": ["--config", "observe.json"]
  }
}
```

The host appends `--check <name>`, and `--baseline` for the pre-deploy sample. The config file is decoded strictly; a missing or unknown field exits nonzero and names the field:

```json
{
  "sha": "<full git sha being released>",
  "vercel": { "projectId": "prj_…", "teamId": "team_…" },
  "axiom": {
    "dataset": "…",
    "filter": "project == 'x' and env == 'production'",
    "statusField": "request.statusCode",
    "windowMinutes": 15,
    "minRequests": 1000,
    "maxRateRatio": 2,
    "hardFloorErrors": 0
  },
  "canary": [{ "url": "https://…", "status": 200, "contains": "…" }]
}
```

Tokens come only from `VERCEL_TOKEN`, `AXIOM_TOKEN`, and the optional `AXIOM_ORG_ID`, and are never printed. `AXIOM_ORG_ID` is required for personal access tokens; when set, it is sent as the `x-axiom-org-id` header. API tokens need no org header. A missing token, provider error, or unexpected response prints `unknown` with a `reason`. Every check prints one JSON line and exits 0.

| Check | pass | fail / breach | unknown | `--baseline` |
| --- | --- | --- | --- | --- |
| `readback` | The newest production deployment of `sha` is READY and is the project's current production deployment | `fail` when it is ERROR or CANCELED | Not found, building, queued, or not yet serving | pass when current production is READY |
| `errors` | Otherwise | `breach` when after-window errors exceed `hardFloorErrors` and the after rate exceeds `max(beforeRate × maxRateRatio, 1 / minRequests)` | After window still open, or fewer than `minRequests` after requests | pass when the before-window query succeeds |
| `canary` | Every URL returns `status` and its body contains `contains` | `fail` naming each mismatched URL | A network error | the same checks |

The errors windows are `windowMinutes` long on either side of the release's `readyAt`, which is read back from Vercel on every run. Only statuses of 500 and above count as errors. Canary requests are cookie-free GETs.

### Claims, outcomes, and recovery

The append-only `journal.jsonl` is the authority for executor progress. It is separate from the machines' authoritative outboxes and ledgers. Every record is schema-validated and fsynced. A stable identity combines repo, machine kind, target, and intent ID. `claimed` is persisted **before** execution; `settled` stores exactly one execution outcome: `done`, `failed` with a typed error, or `recorded-would-do`. The set of durable claims is the cursor. New reads may include old outbox rows, but those rows never execute again.

A recovered claim without a settlement becomes a typed `interrupted` failure. It is never replayed, even if the provider may have accepted it before the crash. This is at-most-once execution, not a promise of distributed exactly-once delivery. An interruption can require manual provider reconciliation and a new machine intent. Defects remain defects during the running invocation.

Events are saved with the outcome before delivery. `delivering` is persisted before the Worker POST, and `delivered` after success. A crash or ambiguous response between those records leaves an **unconfirmed delivery**, not permission to POST again. Inspect those entries and the Worker's event history before reconciling manually. The current Worker API has no intent-ID delivery receipt, so automatic exactly-once event delivery is not available.

The file adapter holds an exclusive `writer.lock` containing `{ pid, startedAt, cursor }`, with no hostname. `cursor` is the last settled intent ID observed when the writer acquired its lock. A graceful stop releases it. A refused restart prints those holder fields and the exact lock path. After an ungraceful stop, verify that the named process is dead, then remove only that lock before restarting. Never delete, truncate, or replace the journal to clear a lock. A malformed or over-32-MiB journal stops execution for operator inspection. File fsyncs cover process-crash recovery; power-loss and remote-filesystem durability remain unqualified.

Changing from dry-run to live does not replay previously recorded proposals. Use the same claims and reconcile the shadow run before cutover. Start live only with explicit authorization and reconciled outbox history. Roll back by stopping the executor or returning to dry-run while preserving its journal. No deployment or GitHub write is needed to test this package.

### Landed credit

A CI pass or an `accepted` Release health result is an observation, never landed plan credit. `OperatorAcceptanceSchema` accepts explicit operator facts `{ kind: "operator-acceptance", by, at, nodes }`; `landedNodes` derives only those accepted node IDs. An operator may supply those IDs when posting a plan event. The Worker-outbox executor never emits GO, plan acceptance, or landed-credit facts from a check result or a provider merge response. The admitted train runner posts head-bound GO using its explicit `goBy` admission; it still emits no plan acceptance or landed-credit facts.

## Shadow

`packages/shadow` is the private `@joelhooks/piper-shadow` package. It runs the train host and executor in-process, always in dry-run, and compares the executor's recorded operations with an operator trace. It has no live writer. `GitHubFeed` reads candidates and exact-head checks. `OperatorTrace` accepts GitHub observations and additional private adapters. The pure comparator preserves source conflicts and reports missing, extra, different-head, different-car, and ordering differences.

```sh
pnpm shadow --repo sample/project --since 2026-01-01T00:00:00Z \
  --replay ../../packages/shadow/test/fixtures/clean
```

Replay needs no token and never calls GitHub. Live observation uses `--record <new-private-directory>` outside every Git checkout. Requests default to at least two seconds apart; 403/429 responses trigger bounded backoff. `--min-rate-fraction` defaults to `0.2`. A low shared rate budget stops the process with a nonzero exit and saves successful reads so far. Tokens come only from the environment and are never recorded.

A merge alone does not count as acceptance. A matching train needs a separate head-bound input containing the executor's `OperatorAcceptanceSchema`, complete operator history, and matching actions. Otherwise it remains `pending` or reports a `diff`. Three synthetic matching scenarios are tests, not evidence of three real matching trains. Use `--auto-go-by <operator>` only when assuming the operator merges when green; it is off by default and does not supply acceptance evidence. Capture checks the train before processing a main move from the same poll. A merge on the same head and PR satisfies an omitted ready step in comparison, while the journal retains that step. See [the shadow contract](packages/shadow/README.md) for recording, source provenance, explicit GO/plan inputs, and the limits of GitHub history.

## Tests and development fence

The property suites generate event traces and check the rules at each step. They cover the car cap, exact-head green plus GO, bisect progress, main movement, retry accounting, attempt retention, and owner notifications. Both suites compare an uninterrupted run with a JSON snapshot restored at an arbitrary cut. The lone-car suite checks every generated car's departure path against an independent oracle. It also checks that a direct merge happens only after GO on the car's own head, while main is unmoved, and right after the car's ready-mark. The train suite checks the same ready-mark before every train merge. The solo suite also drops and scrambles judge calls and compares outcomes, attempt facts, and intents. Both suites replay generated traces while rendering notifications with arbitrary decodable vocabularies and verify unchanged machine state, intents, and facts. Fixed-seed coverage checks verify that generated traces reach the outcomes they claim to test. All fixtures use synthetic contributors, revisions, checks, and pull-request numbers.

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

`@joelhooks/piper` core holds machines, policies, and host helpers with no provider I/O. Provider access, durable storage, authentication, and infrastructure live in the `worker`, `executor`, `shadow`, and `observe` packages. Every workspace package is private.

MIT. See [LICENSE](LICENSE).
