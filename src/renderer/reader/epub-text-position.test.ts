// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  firstReadableTextNode,
  readableTextLength,
  readableTextOffsetAtRange,
  readableTextRangeAtY,
} from "./epub-text-position";

function docOf(body: string): Document {
  return new DOMParser().parseFromString(`<html><body>${body}</body></html>`, "text/html");
}

function pointAt(doc: Document, selector: string, offset = 0): Range {
  const text = doc.querySelector(selector)!.firstChild as Text;
  const range = doc.createRange();
  range.setStart(text, offset);
  range.collapse(true);
  return range;
}

describe("readable EPUB text coordinates", () => {
  it("counts nonblank body text nodes and projects a Range into the same coordinate", () => {
    const doc = docOf("<h1>Title</h1>  <p>Alpha <em>beta</em></p><li>Tail</li>");
    expect(readableTextLength(doc)).toBe(
      "Title".length + "Alpha ".length + "beta".length + "Tail".length,
    );
    expect(readableTextOffsetAtRange(doc, pointAt(doc, "em", 2))).toBe(
      "Title".length + "Alpha ".length + 2,
    );
  });

  it("ignores whitespace-only and explicitly non-readable subtrees", () => {
    const doc = docOf(`
      <p>Visible</p>
      <script>script text</script><style>style text</style><template>template text</template>
      <div hidden>hidden text</div><div aria-hidden="true">aria text</div>
    `);
    expect(readableTextLength(doc)).toBe("Visible".length);
    expect(firstReadableTextNode(doc.body)).toBe(doc.querySelector("p")!.firstChild);
  });

  it("keeps coordinates stable when annotation wrappers or CSS change", () => {
    const doc = docOf('<p id="a">Before</p><p id="b" style="font-size:12px">Target</p>');
    const before = readableTextOffsetAtRange(doc, pointAt(doc, "#b"));
    const target = doc.querySelector("#b")!;
    const text = target.firstChild!;
    const mark = doc.createElement("mark");
    mark.className = "anno";
    target.replaceChild(mark, text);
    mark.appendChild(text);
    target.setAttribute("style", "font-size:48px;line-height:3;width:10px");
    expect(readableTextLength(doc)).toBe("BeforeTarget".length);
    expect(readableTextOffsetAtRange(doc, pointAt(doc, "mark"))).toBe(before);
  });

  it("returns null for foreign or ignored Range starts", () => {
    const doc = docOf("<p>Visible</p><p hidden>Hidden</p>");
    const foreign = docOf("<p>Elsewhere</p>");
    expect(readableTextOffsetAtRange(doc, pointAt(foreign, "p"))).toBeNull();
    expect(readableTextOffsetAtRange(doc, pointAt(doc, "[hidden]"))).toBeNull();
  });

  it("finds readable positions in div, table-cell, and direct-body content", () => {
    const doc = docOf("Direct<div>Panel</div><table><tbody><tr><td>Cell</td></tr></tbody></table>");
    const body = doc.body;
    const div = doc.querySelector("div")!;
    const td = doc.querySelector("td")!;
    vi.spyOn(body, "getBoundingClientRect").mockReturnValue(rect(0, 90));
    vi.spyOn(div, "getBoundingClientRect").mockReturnValue(rect(20, 20));
    vi.spyOn(td, "getBoundingClientRect").mockReturnValue(rect(50, 20));

    const direct = readableTextRangeAtY(doc, 5);
    const panel = readableTextRangeAtY(doc, 25);
    const cell = readableTextRangeAtY(doc, 55);
    expect(direct?.startContainer.textContent).toBe("Direct");
    expect(panel?.startContainer.textContent).toBe("Panel");
    expect(cell?.startContainer.textContent).toBe("Cell");
    expect(readableTextOffsetAtRange(doc, cell!)).toBe("DirectPanel".length);
  });
});

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom: top + height,
    left: 0,
    right: 100,
    width: 100,
    height,
    toJSON: () => ({}),
  };
}
