import { describe, expect, it } from "vitest";
import { parseSkillMd } from "@main/skills/skill-file";

const md = (front: string, body = "# Title\n\nDo the thing.\n") => `---\n${front}\n---\n\n${body}`;

describe("parseSkillMd", () => {
  it("reads name, description and the body", () => {
    expect(parseSkillMd(md("name: export-notes\ndescription: Export notes to Obsidian."))).toEqual({
      ok: true,
      name: "export-notes",
      description: "Export notes to Obsidian.",
      manualOnly: false,
      body: "# Title\n\nDo the thing.\n",
    });
  });

  it("handles a BOM, CRLF line endings and quoted values", () => {
    const text = "﻿---\r\nname: \"a-b\"\r\ndescription: 'x: y'\r\n---\r\nbody";
    expect(parseSkillMd(text)).toMatchObject({
      ok: true,
      name: "a-b",
      description: "x: y",
      body: "body",
    });
  });

  it("marks manual-only skills", () => {
    expect(
      parseSkillMd(md("name: a\ndescription: d\ndisable-model-invocation: true")),
    ).toMatchObject({
      ok: true,
      manualOnly: true,
    });
  });

  it("ignores fields that would grant permissions or change invocation", () => {
    const parsed = parseSkillMd(
      md("name: a\ndescription: d\nallowed-tools: Bash(rm *)\nuser-invocable: false\nlicense: MIT"),
    );
    expect(parsed).toEqual({
      ok: true,
      name: "a",
      description: "d",
      manualOnly: false,
      body: expect.any(String),
    });
  });

  it.each([
    ["no frontmatter", "# Just markdown", "missingFrontmatter"],
    ["unterminated frontmatter", "---\nname: a\ndescription: d\n", "missingFrontmatter"],
    ["broken yaml", md("name: [a\ndescription: d"), "badYaml"],
    ["yaml list", md("- a\n- b"), "badYaml"],
    ["missing name", md("description: d"), "missingName"],
    ["uppercase name", md("name: Export\ndescription: d"), "badName"],
    ["double hyphen", md("name: a--b\ndescription: d"), "badName"],
    ["leading hyphen", md("name: -a\ndescription: d"), "badName"],
    ["too long name", md(`name: ${"a".repeat(65)}\ndescription: d`), "badName"],
    ["missing description", md("name: a"), "missingDescription"],
    ["blank description", md("name: a\ndescription: '  '"), "missingDescription"],
    ["too long description", md(`name: a\ndescription: ${"d".repeat(1025)}`), "descriptionTooLong"],
  ])("rejects %s", (_label, text, error) => {
    expect(parseSkillMd(text)).toMatchObject({ ok: false, error });
  });
});
