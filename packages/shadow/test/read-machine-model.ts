import { ExecutorError } from "@joelhooks/piper-executor/domain";
import { Result } from "effect";

export const READ_LIMIT = 4;

export type ReadOutcome = Result.Result<unknown, ExecutorError>;

export type Rule =
  | "succeeded"
  | "backed-off"
  | "capped"
  | "unhinted"
  | "not-retryable";

export const RULES: readonly Rule[] = [
  "succeeded",
  "backed-off",
  "capped",
  "unhinted",
  "not-retryable",
];

export interface ReadView {
  readonly attempts: number;
  readonly delay: number;
  readonly result: ReadOutcome;
  readonly value: "backoff" | "done" | "reading";
}

export interface ReadStep {
  readonly after: ReadView;
  readonly outcome: ReadOutcome;
  readonly rule: Rule;
}

export const openView = (): ReadView => ({
  attempts: 0,
  delay: 0,
  result: Result.fail(
    new ExecutorError({ code: "interrupted", message: "Read did not finish" })
  ),
  value: "reading",
});

const ruleOf = (outcome: ReadOutcome, attempt: number): Rule => {
  if (Result.isSuccess(outcome)) {
    return "succeeded";
  }

  if (outcome.failure.code !== "secondary-limit") {
    return "not-retryable";
  }

  if (outcome.failure.retryAfterMs === undefined) {
    return "unhinted";
  }

  return attempt >= READ_LIMIT ? "capped" : "backed-off";
};

export const answerAt = (
  outcomes: readonly ReadOutcome[],
  index: number
): ReadOutcome => outcomes[index] ?? Result.succeed(`fallback read ${index}`);

export const modelReads = (outcomes: readonly ReadOutcome[]) => {
  const steps: ReadStep[] = [];
  let view = openView();

  while (view.value !== "done") {
    const outcome = answerAt(outcomes, steps.length);
    const attempts = view.attempts + 1;
    const rule = ruleOf(outcome, attempts);

    const delay =
      rule === "backed-off" && Result.isFailure(outcome)
        ? (outcome.failure.retryAfterMs ?? 0)
        : view.delay;

    view = {
      attempts,
      delay,
      result: outcome,
      value: rule === "backed-off" ? "backoff" : "done",
    };
    steps.push({ after: view, outcome, rule });
  }

  return steps;
};
