import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = readFileSync("package.json", "utf-8");

const projectsOf = (checker) =>
  Array.from(
    manifest.matchAll(new RegExp(`${checker} --noEmit -p ([^\\s"]+)`, "gu")),
    (match) => match[1]
  );

const gateProjects = projectsOf("tsc");

const fastProjects = projectsOf("tsrs");

if (gateProjects.join("\n") !== fastProjects.join("\n")) {
  process.stderr.write(
    "Typecheck parity refused: typecheck and typecheck:fast list different tsconfigs.\n"
  );
  process.exit(1);
}

const passes = (checker, project) =>
  spawnSync("pnpm", ["exec", checker, "--noEmit", "-p", project], {
    stdio: "ignore",
  }).status === 0;

const disagreements = gateProjects.flatMap((project) => {
  const gate = passes("tsc", project);
  const fast = passes("tsrs", project);
  process.stdout.write(
    `${project}: tsc ${gate ? "pass" : "fail"}, tsrs ${fast ? "pass" : "fail"}\n`
  );

  return gate === fast ? [] : [project];
});

if (disagreements.length > 0) {
  process.stderr.write(
    `Typecheck parity refused: tsc and tsrs disagree on ${disagreements.join(", ")}.\n`
  );
  process.exitCode = 1;
}
