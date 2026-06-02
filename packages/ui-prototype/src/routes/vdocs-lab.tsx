import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { VirtualDocs, type VirtualDocsHandle } from "@marginalia/virtual-docs";

export const Route = createFileRoute("/vdocs-lab")({
  component: VDocsLab,
});

// 合成变高 section：不同段数的 lorem + 第 3 节插一张图
const COUNT = 200;
const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";

function makeHtml(i: number): string {
  const paras = 3 + (i % 7); // 3~9 段，制造变高
  const body = Array.from(
    { length: paras },
    (_, p) => `<p>[${i}.${p}] ${LOREM.repeat(2 + (p % 3))}</p>`,
  ).join("");
  const img =
    i % 5 === 3
      ? `<img src="https://placehold.co/600x300?text=section+${i}" style="max-width:100%"/>`
      : "";
  return `<h2>Section ${i}</h2>${img}${body}`;
}

function VDocsLab() {
  const ref = useRef<VirtualDocsHandle | null>(null);
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: 8, borderBottom: "1px solid #ccc", display: "flex", gap: 8 }}>
        <button onClick={() => ref.current?.scrollToIndex(0)}>顶部</button>
        <button onClick={() => ref.current?.scrollToIndex(100)}>跳到 100</button>
        <button onClick={() => ref.current?.scrollToIndex(COUNT - 1)}>末尾</button>
        <span id="top-index">top: ?</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <VirtualDocs
          ref={ref}
          count={COUNT}
          loadSection={async (i) => makeHtml(i)}
          styleCss="body{font-family:sans-serif;line-height:1.6;max-width:680px;margin:0 auto;padding:16px}"
          onTopIndexChange={(i) => {
            const el = document.getElementById("top-index");
            if (el) el.textContent = `top: ${i}`;
          }}
          onSelect={(e) =>
            console.log("selected", e.index, JSON.stringify(e.rect), e.text.slice(0, 40))
          }
          onSelectionCleared={() => console.log("selection cleared")}
        />
      </div>
    </div>
  );
}
