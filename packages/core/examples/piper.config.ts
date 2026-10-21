import {
  AlarmSchema,
  ApprovalSourceSchema,
  definePiperConfig,
  ReviewSourceSchema,
  SecretRefSchema,
  ShipPortSchema,
} from "@joelhooks/piper/config";

export default definePiperConfig({
  alarms: [
    AlarmSchema.cases.StartupCpuJump.make({ ratio: 1.5, unit: "storefront" }),
    AlarmSchema.cases.OutsideWindows.make({
      timeZone: "America/New_York",
      windows: [
        { days: ["mon", "tue", "wed", "thu"], end: "16:00", start: "09:00" },
      ],
    }),
  ],
  contacts: {
    alerts: ["oncall@shop.example"],
    cc: ["release-notes@shop.example"],
    owner: "release-owner@shop.example",
  },
  deploy: {
    lock: { args: ["release:lock"], command: "pnpm" },
    migrations: ["db/migrations"],
    paths: {
      default: "deploy",
      rules: [
        { deploy: true, glob: "**/{package.json,pnpm-lock.yaml}" },
        { deploy: false, glob: "{docs,.github}/**" },
        { deploy: false, glob: "**/{test,tests}/**" },
        { deploy: false, glob: "**/*.{md,test.ts}" },
      ],
    },
    prep: { args: ["release:prep"], command: "pnpm" },
    reviewCriteria: ReviewSourceSchema.cases.File.make({
      path: "docs/release-review.md",
    }),
    ship: ShipPortSchema.cases.Command.make({
      args: ["release:ship"],
      command: "pnpm",
    }),
  },
  mergeLine: {
    approval: ApprovalSourceSchema.cases.File.make({ path: ".piper/go.tsv" }),
    checks: {
      direct: [["unit", "types"]],
      ignored: ["preview"],
      train: [["unit"]],
    },
    excluded: [101],
    maxCars: 4,
    pollMs: 15_000,
  },
  observe: {
    canary: {
      secret: SecretRefSchema.cases.Env.make({ name: "SHOP_CANARY_TOKEN" }),
      url: "https://shop.example/canary",
    },
    checks: [
      { name: "readback", onFail: "restore" },
      { name: "errors", onFail: "escalate" },
      { name: "latency", onFail: "alarm" },
    ],
    timeoutMs: 1_800_000,
  },
  repo: { base: "main", name: "shop", owner: "acme" },
  units: [
    { name: "storefront", primary: true, script: "shop-storefront" },
    { name: "api", script: "shop-api" },
    { name: "jobs", scheduled: true, script: "shop-jobs" },
  ],
});
