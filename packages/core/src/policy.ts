import { Data, Predicate } from "effect";

import type {
  Candidate,
  Car,
  CheckRun,
  DeparturePath,
  Rank,
  SharedBoarding,
} from "./domain.js";
import type { Plan } from "./plan.js";
import { conflictPairs, readyNodes } from "./plan.js";

export const MAX_CARS = 12;

export const DEFAULT_CARS = 8;

export const DEFAULT_POLL_MS = 90_000;

export const DEFAULT_CI_TIMEOUT_MS = 3_600_000;

export const DEFAULT_TRAIN_LABEL = "train";

export interface RepoRules {
  readonly trainLabel: string;

  readonly ignoredChecks: readonly string[];

  readonly candidateIgnoredChecks?: readonly string[];

  readonly candidateRequiredChecks?: readonly (readonly string[])[];

  readonly directRequiredChecks?: readonly (readonly string[])[];

  readonly requireUpToDate?: boolean;

  readonly sharedBoarding?: SharedBoarding;
}

export const RERUN_BELOW_P = 0.2;

const GREEN: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

export const INFRA: ReadonlySet<string> = new Set([
  "cancelled",
  "startup_failure",
  "stale",
]);

export const isGreen = (run: CheckRun): boolean =>
  run.status === "completed" &&
  run.conclusion !== null &&
  GREEN.has(run.conclusion);

export const isFailed = (run: CheckRun): boolean =>
  run.status === "completed" && !isGreen(run);

export const isInfra = (run: CheckRun): boolean =>
  run.status === "completed" &&
  run.conclusion !== null &&
  INFRA.has(run.conclusion);

export const infraOnly = (failing: readonly CheckRun[]): boolean =>
  failing.length > 0 && failing.every(isInfra);

export const attemptOf = (run: CheckRun): number => run.attempt ?? 1;

export const isLaterAttempt = (run: CheckRun, earlier: CheckRun): boolean =>
  attemptOf(run) > attemptOf(earlier) ||
  (attemptOf(run) === attemptOf(earlier) &&
    run.id !== undefined &&
    earlier.id !== undefined &&
    run.id > earlier.id);

export const latestRuns = (
  checks: readonly CheckRun[]
): readonly CheckRun[] => {
  const latest = new Map<string, CheckRun>();

  for (const run of checks) {
    const key = `${run.headSha}\u0000${run.name}`;
    const held = latest.get(key);

    if (held === undefined || !isLaterAttempt(held, run)) {
      latest.set(key, run);
    }
  }

  return [...latest.values()];
};

export type CiVerdict =
  | { readonly _tag: "Green" }
  | { readonly _tag: "Pending" }
  | {
      readonly _tag: "Red";
      readonly kind: "failure" | "timeout";
      readonly failing: readonly CheckRun[];
    };

const Verdict = Data.taggedEnum<CiVerdict>();

export const verdictOn = (
  head: string,
  checks: readonly CheckRun[],
  ignoredChecks: readonly string[]
): CiVerdict => {
  const runs = latestRuns(checks).filter(
    (run) => run.headSha === head && !ignoredChecks.includes(run.name)
  );

  const failing = runs.filter(isFailed);

  if (failing.length > 0) {
    return Verdict.Red({
      failing,
      kind: failing.every((run) => run.conclusion === "timed_out")
        ? "timeout"
        : "failure",
    });
  }

  return runs.length > 0 && runs.every((run) => run.status === "completed")
    ? Verdict.Green()
    : Verdict.Pending();
};

const runsOn = (candidate: Candidate) =>
  latestRuns(candidate.checks).filter(
    (run) => run.headSha === candidate.headSha
  );

const succeeded = (runs: readonly CheckRun[], name: string) =>
  runs.some(
    (run) =>
      run.name === name &&
      run.status === "completed" &&
      (run.conclusion === "success" || run.conclusion === "neutral")
  );

const boardingIgnored = (rules: RepoRules) => [
  ...rules.ignoredChecks,
  ...(rules.candidateIgnoredChecks ?? []),
];

const knownRed = (candidate: Candidate, rules: RepoRules): boolean => {
  const ignored = boardingIgnored(rules);

  return runsOn(candidate).some(
    (run) => !ignored.includes(run.name) && isFailed(run)
  );
};

const boardingGreen = (candidate: Candidate, rules: RepoRules): boolean => {
  const required = rules.candidateRequiredChecks ?? [];

  if (required.length === 0) {
    return Predicate.isTagged(
      verdictOn(candidate.headSha, candidate.checks, boardingIgnored(rules)),
      "Green"
    );
  }

  const runs = runsOn(candidate);

  return (
    required.some(
      (group) =>
        group.length > 0 && group.every((name) => succeeded(runs, name))
    ) && !knownRed(candidate, rules)
  );
};

const groupSize = (pool: readonly Candidate[]) =>
  new Set(pool.map((candidate) => candidate.number)).size;

export const isLone = (pool: readonly Candidate[]): boolean =>
  groupSize(pool) === 1;

export const isEligible = (
  candidate: Candidate,
  rules: RepoRules,
  lone = false
): boolean =>
  candidate.labels.includes(rules.trainLabel) &&
  candidate.operatorReviewed &&
  (rules.requireUpToDate === false || candidate.upToDate) &&
  (lone || rules.sharedBoarding === "notKnownRed"
    ? !knownRed(candidate, rules)
    : boardingGreen(candidate, rules));

const listed = (names: readonly string[]) =>
  [...new Set(names)].toSorted().join(", ");

const directGap = (
  candidate: Candidate,
  rules: RepoRules
): string | undefined => {
  const required = rules.directRequiredChecks ?? [];

  if (required.length === 0) {
    return "direct landing is off without directRequiredChecks";
  }

  if (!candidate.upToDate) {
    return "its head does not contain main";
  }

  const verdict = verdictOn(
    candidate.headSha,
    candidate.checks,
    rules.ignoredChecks
  );

  if (Predicate.isTagged(verdict, "Red")) {
    return `its own CI is red on ${listed(verdict.failing.map((run) => run.name))}`;
  }

  if (Predicate.isTagged(verdict, "Pending")) {
    return "its own CI has not finished";
  }

  const runs = runsOn(candidate);

  const missing = required.flat().filter((name) => !succeeded(runs, name));

  return missing.length === 0
    ? undefined
    : `its own CI has no success for ${listed(missing)}`;
};

const selectCandidates = (
  pool: readonly Candidate[],
  maxCars: number,
  rules: RepoRules,
  plan?: Plan,
  landed: ReadonlySet<string> = new Set()
): readonly Candidate[] => {
  const seen = new Set<number>();
  const lone = isLone(pool);
  const cars: Candidate[] = [];

  const nodes = new Map(
    plan?.nodes.flatMap((node) =>
      node.pr === undefined ? [] : [[node.pr, node] as const]
    )
  );

  const ready = new Set(
    plan === undefined ? [] : readyNodes(plan, landed).map((node) => node.id)
  );

  const conflicts = plan === undefined ? [] : conflictPairs(plan);
  const boarded = new Set<string>();

  const ordered =
    plan === undefined || plan.nodes.length === 0
      ? pool
      : pool.toSorted(
          (left, right) =>
            (nodes.get(left.number)?.priority ?? 0) -
            (nodes.get(right.number)?.priority ?? 0)
        );

  for (const candidate of ordered) {
    if (cars.length >= Math.min(maxCars, MAX_CARS)) {
      break;
    }

    const node = nodes.get(candidate.number);

    if (
      node !== undefined &&
      (!ready.has(node.id) ||
        landed.has(node.id) ||
        conflicts.some(
          ([left, right]) => left === node.id && boarded.has(right)
        ))
    ) {
      continue;
    }

    if (!seen.has(candidate.number) && isEligible(candidate, rules, lone)) {
      seen.add(candidate.number);

      if (node !== undefined) {
        boarded.add(node.id);
      }

      cars.push(candidate);
    }
  }

  return cars;
};

const carOf = ({ headSha, number, owner }: Candidate): Car => ({
  headSha,
  number,
  owner,
});

export const selectCars = (
  pool: readonly Candidate[],
  maxCars: number,
  rules: RepoRules,
  plan?: Plan,
  landed: ReadonlySet<string> = new Set()
): readonly Car[] =>
  selectCandidates(pool, maxCars, rules, plan, landed).map(carOf);

export interface Departure {
  readonly cars: readonly Car[];
  readonly path: DeparturePath;
  readonly reason: string;
}

export const departure = (
  pool: readonly Candidate[],
  maxCars: number,
  rules: RepoRules,
  plan?: Plan,
  landed: ReadonlySet<string> = new Set()
): Departure | undefined => {
  const boarding = selectCandidates(pool, maxCars, rules, plan, landed);
  const cars = boarding.map(carOf);
  const [lead] = boarding;

  if (lead === undefined) {
    return undefined;
  }

  if (!isLone(pool)) {
    return {
      cars,
      path: "train",
      reason:
        rules.sharedBoarding === "notKnownRed"
          ? `${cars.length} of ${groupSize(pool)} cars in the group have no known red; shared boarding notKnownRed skips the wait for each car's own CI, so the train's CI is their proof`
          : `${cars.length} of ${groupSize(pool)} cars in the group passed their boarding checks; shared boarding ownCiGreen waits for each car's own CI`,
    };
  }

  const gap = directGap(lead, rules);

  return gap === undefined
    ? {
        cars,
        path: "direct-land",
        reason:
          "it rides alone, its head contains main and its own CI is green on every direct check group",
      }
    : {
        cars,
        path: "lone-board",
        reason: `it rides alone, so boarding skips the wait for its own CI; it takes a train because ${gap}`,
      };
};

export const suspectOrder = (
  cars: readonly Car[],
  ranks: readonly Rank[]
): readonly number[] => {
  const p = new Map(
    ranks.flatMap((rank) =>
      rank.p === "unknown" ? [] : [[rank.pr, rank.p] as const]
    )
  );

  return cars
    .map((car, index) => ({ index, number: car.number, p: p.get(car.number) }))
    .toSorted((a, b) => (b.p ?? -1) - (a.p ?? -1) || a.index - b.index)
    .map((entry) => entry.number);
};

export const probeHalf = (suspects: readonly number[]): readonly number[] =>
  suspects.slice(0, Math.ceil(suspects.length / 2));

export const excerptOf = (failing: readonly CheckRun[]): string =>
  failing.length === 0
    ? "CI did not finish before the train's deadline."
    : failing
        .map(
          (run) =>
            `${run.name}: ${run.conclusion ?? "failed"}${run.excerpt === undefined ? "" : `\n${run.excerpt}`}`
        )
        .join("\n\n");
