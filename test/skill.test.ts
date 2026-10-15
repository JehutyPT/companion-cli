import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { HELP } from "../src/cli.ts";
import { ACTION_KINDS } from "../src/writers/actions.ts";
import { CONDITION_KINDS, FEEDBACK_KINDS } from "../src/writers/feedbacks.ts";
import { EVENT_KINDS } from "../src/writers/trigger.ts";

const SKILL = readFileSync(
  fileURLToPath(new URL("../skills/companion-cli/SKILL.md", import.meta.url)),
  "utf8",
);

/** The front matter between the leading `---` lines, and the body after it. */
function splitFrontMatter(text: string): { frontMatter: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, "SKILL.md starts with a --- front matter block");
  return { frontMatter: match[1] as string, body: match[2] as string };
}

/** Every inline code span's content, fenced blocks included line by line. */
function codeSpans(text: string): string[] {
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);
  const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].flatMap((m) =>
    (m[1] as string).split("\n"),
  );
  return [...spans, ...fenced];
}

/**
 * The commands the CLI's usage lists: the first word of each synopsis line in
 * HELP (alternatives split on `|`), with the second word for the commands
 * that take a sub-command or kind, and every `--flag` any synopsis names.
 * `--help` counts as both: the CLI takes it, though no synopsis names it.
 */
function usage(): { commands: Map<string, Set<string>>; flags: Set<string> } {
  const commands = new Map<string, Set<string>>();
  const flags = new Set<string>();
  const lines = HELP.split("\n")
    .filter((line) => line.startsWith("  companion-cli "))
    .map((line) => line.slice("  companion-cli ".length));
  assert.ok(lines.length > 0, "HELP lists synopses");
  for (const line of lines) {
    const [first, second] = line.split(" ");
    for (const name of (first as string).split("|")) {
      const subs = commands.get(name) ?? new Set<string>();
      if (second !== undefined && /^[a-z|]+$/.test(second)) {
        for (const sub of second.split("|")) subs.add(sub);
      }
      commands.set(name, subs);
    }
    for (const flag of line.matchAll(/--[a-z][a-z-]*/g)) flags.add(flag[0]);
  }
  commands.set("--help", new Set());
  flags.add("--help");
  return { commands, flags };
}

/** Commands whose second word must be one the usage lists. */
const WITH_SUB = new Set(["list", "export", "variable", "surface"]);

describe("the agent skill", () => {
  const { frontMatter, body } = splitFrontMatter(SKILL);

  it("has name and description front matter and a short body", () => {
    assert.match(frontMatter, /^name: companion-cli$/m);
    assert.match(frontMatter, /^description: \S/m);
    const lines = body.trimEnd().split("\n").length;
    assert.ok(lines <= 90, `the body has ${lines} lines; at most 90`);
  });

  it("names only commands, sub-commands and flags the usage lists", () => {
    const { commands, flags } = usage();
    // Commands are named in code spans; prose may say "companion-cli" alone.
    const mentioned = codeSpans(body).flatMap((span) => [
      ...span.matchAll(/companion-cli\s+([a-z-]+)(?:\s+([a-z-]+))?/g),
    ]);
    assert.ok(mentioned.length > 0, "the skill names commands");
    for (const [text, command, sub] of mentioned) {
      const subs = commands.get(command as string);
      assert.ok(subs, `${text}: "${command}" is not a command in the usage`);
      if (WITH_SUB.has(command as string)) {
        assert.ok(
          sub !== undefined && subs.has(sub),
          `${text}: "${sub}" is not a ${command} sub-command in the usage`,
        );
      }
    }
    for (const [flag] of body.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)) {
      assert.ok(flags.has(flag), `${flag} is not a flag in the usage`);
    }
  });

  it("names no action, feedback, condition or event kind", () => {
    const kinds = new Set([
      ...Object.keys(ACTION_KINDS),
      ...Object.keys(FEEDBACK_KINDS),
      ...Object.keys(CONDITION_KINDS),
      ...Object.keys(EVENT_KINDS),
    ]);
    const tagged = new RegExp(
      `\\b(action|feedback|condition|event)\\s*:\\s*(${[...kinds].join("|")})\\b`,
    );
    for (const span of codeSpans(body)) {
      assert.ok(!kinds.has(span.trim()), `the code span \`${span}\` is a kind`);
      assert.doesNotMatch(
        span,
        tagged,
        `the code span \`${span}\` names a kind`,
      );
    }
    assert.doesNotMatch(body, tagged);
    // Event kinds that are not plain English words: none may appear at all.
    for (const kind of Object.keys(EVENT_KINDS)) {
      if (/[_A-Z]/.test(kind)) {
        assert.ok(
          !new RegExp(`\\b${kind}\\b`).test(body),
          `the skill names the event kind ${kind}`,
        );
      }
    }
  });

  it("has no YAML example of the description format", () => {
    assert.doesNotMatch(body, /```ya?ml/);
    assert.doesNotMatch(body, /^\s*kind:\s*\w+/m);
  });
});
