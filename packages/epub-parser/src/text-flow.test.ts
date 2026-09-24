import { describe, expect, it } from "vitest";
import { buildTextFlow, type FlowAdapter } from "./text-flow";

/** 极简测试树：字符串 = 文本节点；对象 = 元素。 */
type Node = string | { tag: string; id?: string; children: Node[] };
const adapter: FlowAdapter<Node> = {
  children: (n) => (typeof n === "string" ? [] : n.children),
  text: (n) => (typeof n === "string" ? n : null),
  tag: (n) => (typeof n === "string" ? null : n.tag),
  id: (n) => (typeof n === "string" ? null : (n.id ?? null)),
};
const el = (tag: string, children: Node[], id?: string): Node => ({ tag, id, children });

describe("buildTextFlow", () => {
  it("concatenates text nodes in document order with offsets", () => {
    const flow = buildTextFlow(
      el("body", [el("p", ["Hello ", el("em", ["brave"]), " world"])]),
      adapter,
    );
    expect(flow.text).toBe("Hello brave world");
    expect(flow.segments.map((s) => [s.node, s.start])).toEqual([
      ["Hello ", 0],
      ["brave", 6],
      [" world", 11],
    ]);
  });

  it("records a break at each block boundary but not around inline elements", () => {
    const flow = buildTextFlow(
      el("body", [
        el("h1", ["Title"]),
        el("p", ["One", el("span", ["Two"])]),
        el("div", ["Three"]),
      ]),
      adapter,
    );
    expect(flow.text).toBe("TitleOneTwoThree");
    expect(flow.breaks).toEqual([0, 5, 11, 16]);
  });

  it("treats br as a break", () => {
    const flow = buildTextFlow(el("p", ["line one", el("br", []), "line two"]), adapter);
    expect(flow.breaks).toContain(8);
  });

  it("skips script, style, template and noscript subtrees", () => {
    const flow = buildTextFlow(
      el("body", [
        el("style", ["p{}"]),
        el("p", ["kept"]),
        el("script", ["var x"]),
        el("noscript", ["no"]),
        el("template", ["tpl"]),
      ]),
      adapter,
    );
    expect(flow.text).toBe("kept");
  });

  it("maps element ids to the flow offset where the element starts", () => {
    const flow = buildTextFlow(
      el("body", [el("p", ["Intro"], "top"), el("h2", ["Chapter"], "ch2"), el("p", ["Body"])]),
      adapter,
    );
    expect(flow.anchors.get("top")).toBe(0);
    expect(flow.anchors.get("ch2")).toBe(5);
  });
});
