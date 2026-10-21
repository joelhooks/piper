import type { DeparturePath, Fact, SoloFact, SoloOutcome } from "./domain.js";

export interface LiveAt {
  readonly mergeSha: string;
  readonly at: number;
}

export interface MetricsOptions {
  readonly since?: number;
  readonly liveAt?: readonly LiveAt[];
}

const rebuildCounts = () => ({
  bisected: 0,
  conflict: 0,
  "main-moved": 0,
  "merge-refused": 0,
});

const departureCounts = (): Record<DeparturePath, number> => ({
  "direct-land": 0,
  "lone-board": 0,
  train: 0,
});

const paths: readonly DeparturePath[] = ["direct-land", "lone-board", "train"];

const outcomeCounts = (): Record<SoloOutcome, number> => ({
  baseRed: 0,
  dismissed: 0,
  flake: 0,
  infra: 0,
  regression: 0,
  superseded: 0,
  unknown: 0,
});

const causes: readonly (keyof ReturnType<typeof rebuildCounts>)[] = [
  "main-moved",
  "merge-refused",
  "bisected",
  "conflict",
];

const outcomeNames: readonly SoloOutcome[] = [
  "baseRed",
  "dismissed",
  "flake",
  "infra",
  "regression",
  "superseded",
  "unknown",
];

const byName = (a: { readonly name: string }, b: { readonly name: string }) => {
  if (a.name === b.name) {
    return 0;
  }

  return a.name < b.name ? -1 : 1;
};

const included = (at: number, options: MetricsOptions) =>
  options.since === undefined || at >= options.since;

const latestGreen = (
  facts: readonly Fact[],
  merged: Extract<Fact, { readonly kind: "merged" }>
) => {
  let green = -Infinity;

  for (const fact of facts) {
    if (
      fact.kind === "verdict" &&
      fact.purpose === "train" &&
      fact.head === merged.head &&
      fact.outcome === "green" &&
      fact.at <= merged.at
    ) {
      green = Math.max(green, fact.at);
    }
  }

  return green;
};

export const trainMetrics = (
  facts: readonly Fact[],
  options: MetricsOptions = {}
) => {
  const result = {
    bisects: 0,
    ciRuns: 0,
    culprits: 0,
    departures: departureCounts(),
    greenToMerged: new Array<number>(),
    landed: 0,
    mergeToLive: new Array<number>(),
    rebuilds: rebuildCounts(),
  };

  for (const fact of facts) {
    if (!included(fact.at, options)) {
      continue;
    }

    switch (fact.kind) {
      case "built":
      case "rerun": {
        result.ciRuns += 1;
        break;
      }

      case "rebuild": {
        result.rebuilds[fact.cause] += 1;
        break;
      }

      case "departed": {
        result.departures[fact.path] += 1;
        break;
      }

      case "dropped": {
        result.culprits += Number(fact.reason === "culprit");
        break;
      }

      case "judged": {
        result.bisects += Number(
          !facts.some(
            (other) =>
              other.kind === "rerun" &&
              other.head === fact.head &&
              other.at === fact.at
          )
        );
        break;
      }

      case "merged": {
        result.landed += new Set(fact.cars).size;

        const green = latestGreen(facts, fact);

        if (Number.isFinite(green)) {
          result.greenToMerged.push((fact.at - green) / 60_000);
        }

        let live = Infinity;

        for (const other of options.liveAt ?? []) {
          if (other.mergeSha === fact.mergeSha && other.at >= fact.at) {
            live = Math.min(live, other.at);
          }
        }

        if (Number.isFinite(live)) {
          result.mergeToLive.push((live - fact.at) / 60_000);
        }

        break;
      }

      case "abandoned":
      case "go":
      case "verdict": {
        break;
      }

      default: {
        return fact satisfies never;
      }
    }
  }

  result.greenToMerged.sort((a, b) => a - b);
  result.mergeToLive.sort((a, b) => a - b);

  return result;
};

const checkCounts = (name: string) => ({
  attempts: { baseline: 0, original: 0, rerun: 0 },
  name,
  outcomes: outcomeCounts(),
});

export const soloMetrics = (
  facts: readonly SoloFact[],
  options: MetricsOptions = {}
) => {
  const outcomes = outcomeCounts();
  const checks = new Map<string, ReturnType<typeof checkCounts>>();

  const check = (name: string) => {
    const counts = checks.get(name) ?? checkCounts(name);
    checks.set(name, counts);

    return counts;
  };

  for (const fact of facts) {
    if (!included(fact.at, options)) {
      continue;
    }

    if (fact.kind === "attempt") {
      check(fact.check).attempts[fact.role] += 1;
    } else if (fact.kind === "outcome") {
      outcomes[fact.outcome] += 1;

      for (const name of new Set(fact.checks)) {
        check(name).outcomes[fact.outcome] += 1;
      }
    }
  }

  return {
    checks: [...checks.values()].toSorted(byName),
    outcomes,
  };
};

export type TrainMetrics = Omit<
  ReturnType<typeof trainMetrics>,
  "greenToMerged" | "mergeToLive"
> & {
  readonly greenToMerged: readonly number[];
  readonly mergeToLive: readonly number[];
};

export interface SoloMetrics {
  readonly checks: readonly ReturnType<typeof checkCounts>[];
  readonly outcomes: Record<SoloOutcome, number>;
}

const ratio = (numerator: number, denominator: number) =>
  denominator === 0 ? null : numerator / denominator;

export const timing = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  const lower = sorted[middle - 1];

  let median = upper ?? null;

  if (upper !== undefined && lower !== undefined && sorted.length % 2 === 0) {
    median = (lower + upper) / 2;
  }

  return {
    median,
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1] ?? null,
    samples: sorted.length,
  };
};

export const summarizeMetrics = (
  trains: readonly TrainMetrics[],
  solos: readonly SoloMetrics[]
) => {
  const total = trainMetrics([]);

  for (const train of trains) {
    total.ciRuns += train.ciRuns;
    total.landed += train.landed;
    total.bisects += train.bisects;
    total.culprits += train.culprits;
    total.greenToMerged.push(...train.greenToMerged);
    total.mergeToLive.push(...train.mergeToLive);

    for (const cause of causes) {
      total.rebuilds[cause] += train.rebuilds[cause];
    }

    for (const path of paths) {
      total.departures[path] += train.departures[path];
    }
  }

  const outcomes = outcomeCounts();
  const checks = new Map<string, ReturnType<typeof checkCounts>>();

  for (const solo of solos) {
    for (const outcome of outcomeNames) {
      outcomes[outcome] += solo.outcomes[outcome];
    }

    for (const entry of solo.checks) {
      const counts = checks.get(entry.name) ?? checkCounts(entry.name);

      for (const outcome of outcomeNames) {
        counts.outcomes[outcome] += entry.outcomes[outcome];
      }

      counts.attempts.original += entry.attempts.original;
      counts.attempts.rerun += entry.attempts.rerun;
      counts.attempts.baseline += entry.attempts.baseline;
      checks.set(entry.name, counts);
    }
  }

  return {
    culpritsPerBisect: {
      bisects: total.bisects,
      culprits: total.culprits,
      rate: ratio(total.culprits, total.bisects),
    },
    departuresByPath: total.departures,
    greenToMergedMinutes: timing(total.greenToMerged),
    mergeToLiveMinutes: timing(total.mergeToLive),
    prsLandedPerCiRun: {
      ciRuns: total.ciRuns,
      landed: total.landed,
      rate: ratio(total.landed, total.ciRuns),
    },
    rebuildsByCause: total.rebuilds,
    solo: {
      checks: [...checks.values()].toSorted(byName).map((entry) => ({
        ...entry,
        flakeRate: ratio(
          entry.outcomes.flake,
          Object.values(entry.outcomes).reduce((a, b) => a + b, 0)
        ),
      })),
      outcomes,
    },
  };
};

export const metrics = (
  trains: readonly (readonly Fact[])[],
  solos: readonly (readonly SoloFact[])[],
  options: MetricsOptions = {}
) =>
  summarizeMetrics(
    trains.map((facts) => trainMetrics(facts, options)),
    solos.map((facts) => soloMetrics(facts, options))
  );
