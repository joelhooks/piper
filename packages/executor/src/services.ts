import type { Mode } from "./domain.js";

export interface Settings {
  readonly mode: Mode;
  readonly baseBranch: string;
  readonly baselineWorkflows: Readonly<Record<string, string>>;
}
