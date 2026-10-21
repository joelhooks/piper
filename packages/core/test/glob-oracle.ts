const innermostBraces = /\{(?<body>[^{}]*)\}/u;

const expandBraces = (text: string): readonly string[] => {
  const found = innermostBraces.exec(text);

  if (found === null) {
    return [text];
  }

  const before = text.slice(0, found.index);
  const after = text.slice(found.index + found[0].length);

  return (found.groups?.body ?? "")
    .split(",")
    .flatMap((alternative) => expandBraces(`${before}${alternative}${after}`));
};

const escapeRegExp = (text: string) =>
  text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

const segmentPattern = (segment: string) =>
  segment === "**"
    ? "(?:/[^/]*)*"
    : `/${segment.split("*").map(escapeRegExp).join("[^/]*")}`;

export const oracleMatches = (text: string, path: string) =>
  expandBraces(text).some((alternative) =>
    new RegExp(
      `^${alternative.split("/").map(segmentPattern).join("")}$`,
      "u"
    ).test(`/${path}`)
  );
