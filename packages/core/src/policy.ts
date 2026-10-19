import { Data, Predicate } from "effect";

import type { Candidate, Car, CheckRun, Rank } from "./domain.js";
import type { Plan } from "./plan.js";
import { conflictPairs, readyNodes } from "./plan.js";

export const MAX_CARS = 12;

export const DEFAULT_CARS = 8;

export interface RepoRules {
  readonly trainLabel: string;

  readonly ignoredChecks: readonly string[];

  readonly candidateIgnoredChecks?: readonly string[];

  readonly candidateRequiredChecks?: readonly (readonly string[])[];

  readonly requireUpToDate?: boolean;
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

const boardingGreen = (candidate: Candidate, rules: RepoRules): boolean => {
  const ignored = [
    ...rules.ignoredChecks,
    ...(rules.candidateIgnoredChecks ?? []),
  ];

  const required = rules.candidateRequiredChecks ?? [];

  if (required.length === 0) {
    return Predicate.isTagged(
      verdictOn(candidate.headSha, candidate.checks, ignored),
      "Green"
    );
  }

  const runs = latestRuns(candidate.checks).filter(
    (run) => run.headSha === candidate.headSha
  );

  const passed = (name: string) =>
    runs.some(
      (run) =>
        run.name === name &&
        run.status === "completed" &&
        (run.conclusion === "success" || run.conclusion === "neutral")
    );

  return (
    required.some((group) => group.length > 0 && group.every(passed)) &&
    !runs.some((run) => !ignored.includes(run.name) && isFailed(run))
  );
};

export const isEligible = (candidate: Candidate, rules: RepoRules): boolean =>
  candidate.labels.includes(rules.trainLabel) &&
  candidate.operatorReviewed &&
  (rules.requireUpToDate === false || candidate.upToDate) &&
  boardingGreen(candidate, rules);

export const selectCars = (
  pool: readonly Candidate[],
  maxCars: number,
  rules: RepoRules,
  plan?: Plan,
  landed: ReadonlySet<string> = new Set()
): readonly Car[] => {
  const seen = new Set<number>();
  const cars: Car[] = [];

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

    if (!seen.has(candidate.number) && isEligible(candidate, rules)) {
      seen.add(candidate.number);

      if (node !== undefined) {
        boarded.add(node.id);
      }

      cars.push({
        headSha: candidate.headSha,
        number: candidate.number,
        owner: candidate.owner,
      });
    }
  }

  return cars;
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
