import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = readFileSync("package.json", "utf-8");

const stepForms = [
  {
    checker: "effect-tsrs",
    pattern: /^effect-tsrs diagnostics --project (?<project>\S+) --strict$/u,
  },
  {
    checker: "tsrs",
    pattern: /^tsrs --noEmit -p (?<project>\S+)$/u,
  },
  {
    checker: "tsc",
    pattern: /^tsc --noEmit -p (?<project>\S+)$/u,
  },
];

const refuse = (reason) => {
  process.stderr.write(`Typecheck parity refused: ${reason}\n`);
  process.exit(1);
};

const stepsOf = (name) => {
  const command =
    new RegExp(`"${String(name)}": "(?<command>[^"]*)"`, "u").exec(manifest)
      ?.groups?.command ?? "";

  return command.split(" && ").map((step) => {
    const form = stepForms.find(({ pattern }) => pattern.test(step));
    const project = form ? form.pattern.exec(step)?.groups?.project : "";

    if (form === undefined || project === undefined || project === "") {
      return refuse(`${name} has an unrecognized step: ${step}`);
    }

    return { checker: form.checker, project };
  });
};

const gateSteps = stepsOf("typecheck");

const backstopSteps = stepsOf("typecheck:tsc");

const fastSteps = stepsOf("typecheck:fast");

const gateProjects = gateSteps.map(({ project }) => project).join("\n");

if (
  gateSteps.some(({ checker }) => checker === "tsc") ||
  backstopSteps.some(({ checker }) => checker !== "tsc") ||
  fastSteps.some(({ checker }) => checker !== "tsrs") ||
  backstopSteps.map(({ project }) => project).join("\n") !== gateProjects ||
  fastSteps.map(({ project }) => project).join("\n") !== gateProjects
) {
  refuse(
    "typecheck, typecheck:tsc, and typecheck:fast must list the same tsconfigs with their own checkers."
  );
}

const repoPrefix = `${process.cwd()}/`;

const diagnosticLine =
  /^(?<file>.+)\((?<line>\d+),\d+\): (?<severity>error|warning|suggestion|message) TS(?<code>\d+):/gmu;

const run = (checkerName, projectName) => {
  const checker = String(checkerName);
  const project = String(projectName);

  const args =
    checker === "effect-tsrs"
      ? ["diagnostics", "--project", project, "--strict"]
      : ["--noEmit", "-p", project, "--pretty", "false"];

  const result = spawnSync("pnpm", ["exec", checker, ...args], {
    encoding: "utf-8",
  });

  const output = `${result.stdout}${result.stderr}`;

  const diagnostics = Array.from(output.matchAll(diagnosticLine), (match) => {
    const {
      file = "",
      line = "",
      severity = "",
      code = "",
    } = match.groups ?? {};

    const relative = file.startsWith(repoPrefix)
      ? file.slice(repoPrefix.length)
      : file;

    return {
      effect: code.startsWith("377") && code.length === 6,
      key: `${relative}:${line}:TS${code}`,
      severity,
    };
  });

  const failing = diagnostics.some(
    ({ severity }) => severity === "error" || severity === "warning"
  );

  if (
    result.error !== undefined ||
    result.status === null ||
    (checker === "effect-tsrs" && result.status === 2) ||
    (result.status !== 0 && !failing)
  ) {
    process.stderr.write(output);

    return refuse(`${checker} failed without diagnostics on ${project}.`);
  }

  const errors = diagnostics.filter(({ severity }) => severity === "error");

  return {
    checker,
    errors: [...new Set(errors.map(({ key }) => key))].toSorted(),
    passed: result.status === 0,
    typeErrors: [
      ...new Set(errors.filter(({ effect }) => !effect).map(({ key }) => key)),
    ].toSorted(),
  };
};

const verdict = (passed) => (passed === true ? "pass" : "fail");

const disagreements = gateSteps.flatMap(({ checker, project }) => {
  const gate = run(checker, project);
  const backstop = run("tsc", project);
  const fast = checker === "tsrs" ? gate : run("tsrs", project);

  process.stdout.write(
    `${project}: ${checker} ${verdict(gate.passed)}, tsc ${verdict(backstop.passed)}, tsrs ${verdict(fast.passed)}\n`
  );

  const pairs = [
    {
      label: `${checker} and tsc`,
      left: gate,
      leftErrors: gate.errors,
      rightErrors: backstop.errors,
      verdictsAgree: gate.passed === backstop.passed,
    },
    ...(checker === "tsrs"
      ? []
      : [
          {
            label: "tsrs and tsc outside TS377xxx",
            left: fast,
            leftErrors: fast.typeErrors,
            rightErrors: backstop.typeErrors,
            verdictsAgree: true,
          },
        ]),
  ];

  return pairs.flatMap(
    ({ label, left, leftErrors, rightErrors, verdictsAgree }) => {
      const onlyLeft = leftErrors.filter((key) => !rightErrors.includes(key));
      const onlyRight = rightErrors.filter((key) => !leftErrors.includes(key));

      if (onlyLeft.length === 0 && onlyRight.length === 0 && verdictsAgree) {
        return [];
      }

      return [
        [
          `${project}: ${label} disagree`,
          `  ${left.checker} ${verdict(left.passed)}, tsc ${verdict(backstop.passed)}`,
          ...onlyLeft.map((key) => `  only ${left.checker}: ${key}`),
          ...onlyRight.map((key) => `  only tsc: ${key}`),
        ].join("\n"),
      ];
    }
  );
});

if (disagreements.length > 0) {
  process.stderr.write(`${disagreements.join("\n")}\n`);
  process.stderr.write("Typecheck parity refused: the checkers disagree.\n");
  process.exitCode = 1;
}
