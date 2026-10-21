const depthChange = new Map([
  ["{", 1],
  ["}", -1],
]);

const notGlobSyntax = /[!?[\\\]]/u;

const closingBrace = (text: string, open: number) => {
  let depth = 0;

  for (let index = open; index < text.length; index += 1) {
    depth += depthChange.get(text.charAt(index)) ?? 0;

    if (depth === 0) {
      return index;
    }
  }

  return -1;
};

const topLevelAlternatives = (body: string) => {
  const alternatives: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    depth += depthChange.get(char) ?? 0;

    if (char === "," && depth === 0) {
      alternatives.push(body.slice(start, index));
      start = index + 1;
    }
  }

  return [...alternatives, body.slice(start)];
};

const expand = (glob: string): readonly string[] => {
  const open = glob.indexOf("{");

  if (open === -1) {
    return [glob];
  }

  const close = closingBrace(glob, open);

  if (close === -1) {
    return [glob];
  }

  return topLevelAlternatives(glob.slice(open + 1, close)).flatMap(
    (alternative) =>
      expand(`${glob.slice(0, open)}${alternative}${glob.slice(close + 1)}`)
  );
};

const balanced = (text: string) => {
  let depth = 0;

  for (const char of text) {
    depth += depthChange.get(char) ?? 0;

    if (depth < 0) {
      return false;
    }
  }

  return depth === 0;
};

const isSegment = (segment: string) =>
  segment !== "" &&
  segment !== "." &&
  segment !== ".." &&
  (segment === "**" || !segment.includes("**"));

export const isGlob = (text: string) =>
  !notGlobSyntax.test(text) &&
  balanced(text) &&
  expand(text).every((alternative) => alternative.split("/").every(isSegment));

const matchesSegment = (pattern: string, segment: string) => {
  const [first = "", ...rest] = pattern.split("*");
  const last = rest.at(-1);

  if (last === undefined) {
    return pattern === segment;
  }

  if (
    segment.length < first.length + last.length ||
    !segment.startsWith(first) ||
    !segment.endsWith(last)
  ) {
    return false;
  }

  const inner = segment.slice(first.length, segment.length - last.length);
  let cursor = 0;

  for (const part of rest.slice(0, -1)) {
    const found = inner.indexOf(part, cursor);

    if (found === -1) {
      return false;
    }

    cursor = found + part.length;
  }

  return true;
};

const matchesSegments = (
  patterns: readonly string[],
  segments: readonly string[]
): boolean => {
  const [pattern, ...patternRest] = patterns;

  if (pattern === undefined) {
    return segments.length === 0;
  }

  if (pattern === "**") {
    return Array.from({ length: segments.length + 1 }, (_, skipped) =>
      segments.slice(skipped)
    ).some((tail) => matchesSegments(patternRest, tail));
  }

  const [segment, ...segmentRest] = segments;

  return (
    segment !== undefined &&
    matchesSegment(pattern, segment) &&
    matchesSegments(patternRest, segmentRest)
  );
};

export const matchesGlob = (glob: string, path: string) => {
  const segments = path.split("/");

  return expand(glob).some((alternative) =>
    matchesSegments(alternative.split("/"), segments)
  );
};
