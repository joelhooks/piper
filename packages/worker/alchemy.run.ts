import { DEFAULT_CARS } from "@joelhooks/piper/policy";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { localState } from "alchemy/State";
import { Config, Effect } from "effect";

export interface Settings {
  readonly aggregateChecks?: readonly string[];
  readonly ignoredChecks?: readonly string[];
  readonly maxCars?: number;
  readonly requireReadAuth?: boolean;
  readonly trainLabel?: string;
}

export const infrastructure = (settings: Settings = {}) =>
  Effect.gen(function* declarePiper() {
    const worker = yield* Cloudflare.Worker("Piper", {
      compatibility: { date: "2026-10-15" },
      env: {
        AGGREGATE_CHECKS: (settings.aggregateChecks ?? []).join(","),
        API_TOKEN: Config.Redacted("API_TOKEN"),
        DEPOT: Cloudflare.DurableObject("Depot", { className: "Depot" }),
        IGNORED_CHECKS: (settings.ignoredChecks ?? []).join(","),
        MAX_CARS: String(settings.maxCars ?? DEFAULT_CARS),
        REQUIRE_READ_AUTH: String(settings.requireReadAuth ?? true),
        SOLO: Cloudflare.DurableObject("Solo", { className: "Solo" }),
        TRAIN: Cloudflare.DurableObject("Train", { className: "Train" }),
        TRAIN_LABEL: settings.trainLabel ?? "train",
      },
      main: new URL("src/index.ts", import.meta.url).pathname,
    });

    return { worker };
  });

export default Alchemy.Stack(
  "Piper",
  {
    providers: Cloudflare.providers(),
    state: localState(),
  },
  infrastructure()
);
