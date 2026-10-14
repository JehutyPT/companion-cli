/**
 * Name patterns, shared by every command that selects items by name (list,
 * find, export). A pattern is a case-sensitive glob over the whole name: `*`
 * matches any run of characters and `?` exactly one. Nothing else is special,
 * so there are no character classes or escapes, and a pattern without `*` or
 * `?` is an exact name. Several patterns match their union; no pattern at all
 * matches every name.
 */
export function matchesNamePatterns(
  name: string,
  patterns: readonly string[],
): boolean {
  return (
    patterns.length === 0 ||
    patterns.some((pattern) => globRegExp(pattern).test(name))
  );
}

function globRegExp(pattern: string): RegExp {
  const source = [...pattern]
    .map((char) =>
      char === "*"
        ? "[^]*"
        : char === "?"
          ? "[^]"
          : char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`, "u");
}
