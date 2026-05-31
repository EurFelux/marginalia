import { strFromU8, unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { parse as parseHtml } from "node-html-parser";
import type { ParsedEpub, SpineItem, TocNode } from "./types";

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  // Keep all tag values as strings — prevents '42'/'true' metadata being auto-coerced to numbers/booleans.
  parseTagValue: false,
  isArray: (name) => ["item", "itemref", "navPoint", "rootfile"].includes(name),
});

function resolveHref(baseDir: string, href: string): string {
  const stack = baseDir ? baseDir.split("/") : [];
  for (const seg of href.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return stack.join("/");
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function textOf(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "#text" in v)
    return String((v as { "#text": unknown })["#text"]);
  return undefined;
}

export function parseEpub(bytes: Uint8Array): ParsedEpub {
  const files = unzipSync(bytes);
  const text = (p: string): string => {
    const b = files[p];
    if (!b) throw new Error(`epub: missing entry ${p}`);
    return strFromU8(b);
  };

  const container = xml.parse(text("META-INF/container.xml"));
  const opfPath: string | undefined = asArray(container?.container?.rootfiles?.rootfile)[0]?.[
    "@_full-path"
  ];
  if (!opfPath) throw new Error("epub: cannot locate OPF rootfile");
  const opfDir = dirOf(opfPath);

  const pkg = xml.parse(text(opfPath)).package;
  if (pkg === undefined || typeof pkg !== "object") {
    throw new Error(`epub: OPF at "${opfPath}" has no <package> root element`);
  }
  const meta = pkg.metadata ?? {};
  const uniqueId: string | undefined = pkg["@_unique-identifier"];

  const identifiers = asArray(meta.identifier);
  const uid =
    textOf(identifiers.find((i) => typeof i === "object" && i?.["@_id"] === uniqueId)) ??
    textOf(identifiers[0]) ??
    null;
  const title = textOf(asArray(meta.title)[0]);
  const author = textOf(asArray(meta.creator)[0]);

  const manifest = new Map<string, { href: string; properties: string }>();
  for (const it of asArray(pkg.manifest?.item)) {
    manifest.set(it["@_id"], {
      href: resolveHref(opfDir, it["@_href"]),
      properties: it["@_properties"] ?? "",
    });
  }

  const spine: SpineItem[] = asArray(pkg.spine?.itemref)
    .map((ref) => {
      const id = ref["@_idref"];
      const m = manifest.get(id);
      return m ? { id, href: m.href } : undefined;
    })
    .filter((s): s is SpineItem => s !== undefined);

  let coverHref: string | undefined;
  coverHref = manifest
    .values()
    .find((m) => m.properties.split(/\s+/).includes("cover-image"))?.href;
  if (!coverHref) {
    const coverId = asArray(meta.meta).find((m) => m?.["@_name"] === "cover")?.["@_content"];
    if (coverId) coverHref = manifest.get(coverId)?.href;
  }
  const cover = coverHref ? files[coverHref] : undefined;

  const toc = readToc(pkg, manifest, text);
  return { uid, title, author, cover, spine, toc };
}

function readToc(
  pkg: { spine?: { "@_toc"?: string } },
  manifest: Map<string, { href: string; properties: string }>,
  text: (p: string) => string,
): TocNode[] {
  // EPUB3 nav
  for (const [, m] of manifest) {
    if (m.properties.split(/\s+/).includes("nav")) {
      const root = parseHtml(text(m.href));
      const navs = root.querySelectorAll("nav");
      const navEl = navs.find((n) => n.getAttribute("epub:type") === "toc") ?? navs[0] ?? root;
      const ol = navEl.querySelector("ol");
      const navDir = dirOf(m.href);

      type HtmlEl = ReturnType<typeof root.querySelector>;
      const walk = (listEl: HtmlEl): TocNode[] => {
        if (!listEl) return [];
        return listEl
          .querySelectorAll("li")
          .filter((li) => li.parentNode === listEl)
          .map((li) => {
            // 已知限制：<li><span>分组</span><ol>…</ol></li> 这类无 <a> 的分组节点会取到嵌套后代的 <a>；当前只支持 <a> 直接子节点的常见结构。
            const a = li.querySelector("a");
            const childOls = li.querySelectorAll("ol");
            const childOl = childOls.find((o) => o.parentNode === li) ?? null;
            const href = a?.getAttribute("href")?.split("#")[0] ?? "";
            const node: TocNode = {
              label: (a?.text ?? "").trim(),
              href: href ? resolveHref(navDir, href) : "",
            };
            const children = walk(childOl);
            if (children.length) node.children = children;
            return node;
          })
          .filter((n) => n.label || n.href);
      };
      return walk(ol);
    }
  }

  // EPUB2 NCX
  const ncxId = pkg.spine?.["@_toc"];
  const ncx = ncxId ? manifest.get(ncxId) : undefined;
  if (ncx) {
    const doc = xml.parse(text(ncx.href));
    const ncxDir = dirOf(ncx.href);
    type NavPoint = {
      navLabel?: { text?: string };
      content?: { "@_src"?: string };
      navPoint?: NavPoint | NavPoint[];
    };
    const toNode = (np: unknown): TocNode => {
      const p = np as NavPoint;
      const src = p.content?.["@_src"]?.split("#")[0] ?? "";
      const node: TocNode = {
        label: (p.navLabel?.text ?? "").toString().trim(),
        href: src ? resolveHref(ncxDir, src) : "",
      };
      const kids = asArray(p.navPoint).map(toNode);
      if (kids.length) node.children = kids;
      return node;
    };
    return asArray(doc.ncx?.navMap?.navPoint)
      .map(toNode)
      .filter((n) => n.label || n.href);
  }
  return [];
}
