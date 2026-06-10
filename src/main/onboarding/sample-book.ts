import { type Zippable, strToU8, zipSync } from "fflate";
import type { UILanguage } from "@shared/i18n/language";

/**
 * 一种语言的整本样书内容（书名 + dc:language + 3 章）。
 * 注意：以下字段直接插入 XML（OPF/nav/xhtml）不做转义——值必须为纯静态、不含 XML 特殊字符（< > & "）。
 */
interface SampleContent {
  identifier: string;
  bookTitle: string;
  /** OPF dc:language 值。 */
  lang: string;
  navTitle: string;
  chapters: { id: string; title: string; bodyHtml: string }[];
}

const EN: SampleContent = {
  identifier: "urn:uuid:marginalia-sample-en",
  bookTitle: "The Margin — A Sample Reader",
  lang: "en",
  navTitle: "Contents",
  chapters: [
    {
      id: "ch1",
      title: "I. On Reading in the Margins",
      bodyHtml:
        "<h1>I. On Reading in the Margins</h1>" +
        "<p>A book is never quite finished on the day it is printed. It waits, patiently, for a reader who will argue with it, underline it, and scribble in the white space along its edges. Those edges have a name: the margins. For centuries they were where readers kept their truest thoughts.</p>" +
        "<p>To read in the margins is to refuse to be a passive guest. You stop, you doubt, you ask a question the author never anticipated. The page becomes a conversation rather than a lecture, and the conversation can last for years.</p>" +
        "<p>Try it now. Choose any sentence on this page that interests you, and ask what it assumes, what it leaves out, or what it would mean if it were false. The smallest question, asked honestly, can unlock the whole paragraph.</p>" +
        "<p>The best marginalia are not summaries. They are surprises — the moment you notice that two distant ideas secretly rhyme, or that a confident claim rests on a quiet, unexamined leap. Keep your pencil close. The next surprise is usually one sentence away.</p>",
    },
    {
      id: "ch2",
      title: "II. A Question Worth Keeping",
      bodyHtml:
        "<h1>II. A Question Worth Keeping</h1>" +
        "<p>Not every question deserves an answer on the spot. Some are worth keeping — carried from page to page, turned over in the dark, allowed to ripen. A good reader collects questions the way others collect quotations.</p>" +
        "<p>When a sentence resists you, that resistance is information. Do not rush to resolve it. Ask it aloud, write it in the margin, and let it travel with you into the next chapter, where the book may answer it without meaning to.</p>" +
        "<p>The strange thing about a kept question is how it changes what you notice. Once you are genuinely curious whether the author is right, every example becomes evidence and every aside a clue. The book stops washing over you and starts arguing back.</p>" +
        "<p>So when something here puzzles you, resist the urge to move on. Select it, and hold it up to the light. The question you keep today is the understanding you earn tomorrow.</p>",
    },
    {
      id: "ch3",
      title: "III. The Lamplighter's Question",
      bodyHtml:
        "<h1>III. The Lamplighter's Question</h1>" +
        "<p>In a town that had forgotten the stars, there lived a lamplighter who climbed the same hill every dusk to light a single lamp. No one had asked him to. The lamp lit nothing but a bend in an empty road.</p>" +
        "<p>One evening a child followed him up and asked why he bothered, since no traveler ever came. The lamplighter thought for a long moment. “I light it,” he said, “so that if someone comes, the dark will not have the last word.”</p>" +
        "<p>The child returned the next night, and the next, until lighting the lamp became something the two of them did together. In time others climbed the hill as well, not because the road had changed, but because a small, stubborn light had given them a reason to look up.</p>" +
        "<p>Years later the town remembered the lamp long after it remembered the darkness. That is the strange arithmetic of small, faithful acts: they are easy to dismiss while they happen, and impossible to forget once they are done.</p>",
    },
  ],
};

const ZH: SampleContent = {
  identifier: "urn:uuid:marginalia-sample-zh",
  bookTitle: "页边 · 示例读本",
  lang: "zh-CN",
  navTitle: "目录",
  chapters: [
    {
      id: "ch1",
      title: "一、在书页的边缘阅读",
      bodyHtml:
        "<h1>一、在书页的边缘阅读</h1>" +
        "<p>读书最孤独也最自由的时刻，往往不在正文之内，而在页边那一道窄窄的空白里。那里没有作者的声音，只有你自己的疑问、反驳与忽然亮起的联想。把它们写下来，一本书才真正属于你。</p>" +
        "<p>边缘不是次要的地方。许多伟大的思想，最初都只是某个读者在页脚潦草写下的一句「真的是这样吗？」。怀疑不是对作者的不敬，而是阅读最诚实的姿态。</p>" +
        "<p>现在不妨试试：在这一段里挑一句你最不确定的话，问问它依赖了什么前提，又回避了什么。一个足够小的问题，常常能撬动一整页的意义。</p>" +
        "<p>真正好的批注从不只是复述。它是一种发现——你忽然看见两个相隔很远的念头其实在暗暗押韵，或是一个笃定的断言底下，藏着一处无人追问的轻轻一跃。把铅笔握紧，下一个发现往往就在一句话之外。</p>",
    },
    {
      id: "ch2",
      title: "二、值得留住的疑问",
      bodyHtml:
        "<h1>二、值得留住的疑问</h1>" +
        "<p>不是每个问题都该当场得到答案。有些值得留住——从这一页带到那一页，在夜里反复掂量，任它慢慢成熟。好的读者收集疑问，就像别人收集警句。</p>" +
        "<p>当一句话让你卡住，那份卡顿本身就是信息。别急着把它抹平。把它念出声，写在页边，让它随你走进下一章——书也许会在无意之间替你回答。</p>" +
        "<p>留住的疑问最奇妙之处，在于它改变你所看见的东西。一旦你真心想知道作者是否正确，每个例子都成了证据，每句旁白都成了线索。书不再从你身上漫过，而是开始与你争辩。</p>" +
        "<p>所以当这里有什么让你困惑，别急着翻过去。选中它，举到光下细看。你今天留住的疑问，正是你明天挣得的理解。</p>",
    },
    {
      id: "ch3",
      title: "三、点灯人的问题",
      bodyHtml:
        "<h1>三、点灯人的问题</h1>" +
        "<p>在一座忘记了星辰的小镇上，住着一个点灯人。每到黄昏，他都爬上同一座山岗，点亮一盏灯。没有人请他这么做。那盏灯照亮的，不过是空荡荡路上的一个弯。</p>" +
        "<p>一天傍晚，一个孩子跟着他上了山，问他何必如此——从没有旅人经过。点灯人想了很久，说：「我点上它，是为了万一有人来时，黑暗不至于说了最后一句话。」</p>" +
        "<p>第二天孩子又来了，之后每天都来，直到点灯成了他俩一起做的事。渐渐地，别的人也爬上山岗——不是因为路变了，而是因为一簇小小的、固执的光，给了他们抬头的理由。</p>" +
        "<p>许多年后，小镇记住那盏灯的时间，远比记住黑暗的时间长。这正是微小而忠实之举古怪的算术：它们发生时容易被轻视，做成了却再难被忘记。</p>",
    },
  ],
};

function contentFor(language: UILanguage): SampleContent {
  switch (language) {
    case "zh-CN":
      return ZH;
    case "en":
      return EN;
    default:
      return EN;
  }
}

/** 按语言代码内构建一本合法 EPUB3 样书字节（无打包资源）。纯函数。 */
export function buildSampleEpub(language: UILanguage): Uint8Array {
  const c = contentFor(language);

  const container =
    '<?xml version="1.0"?>\n' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
    '  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n' +
    "</container>";

  const manifestItems = c.chapters
    .map((ch) => `<item id="${ch.id}" href="${ch.id}.xhtml" media-type="application/xhtml+xml"/>`)
    .join("\n    ");
  const spineItems = c.chapters.map((ch) => `<itemref idref="${ch.id}"/>`).join("\n    ");

  const opf =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n' +
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
    `    <dc:identifier id="bookid">${c.identifier}</dc:identifier>\n` +
    `    <dc:title>${c.bookTitle}</dc:title>\n` +
    "    <dc:creator>Marginalia</dc:creator>\n" +
    `    <dc:language>${c.lang}</dc:language>\n` +
    "  </metadata>\n" +
    "  <manifest>\n" +
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n' +
    `    ${manifestItems}\n` +
    "  </manifest>\n" +
    "  <spine>\n" +
    `    ${spineItems}\n` +
    "  </spine>\n" +
    "</package>";

  const navList = c.chapters
    .map((ch) => `<li><a href="${ch.id}.xhtml">${ch.title}</a></li>`)
    .join("\n    ");
  const nav =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n' +
    `  <head><title>${c.navTitle}</title></head>\n` +
    `  <body><nav epub:type="toc"><ol>\n    ${navList}\n  </ol></nav></body>\n` +
    "</html>";

  const chapterFiles: Zippable = {};
  for (const ch of c.chapters) {
    const xhtml =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${ch.title}</title></head><body>${ch.bodyHtml}</body></html>`;
    chapterFiles[`OEBPS/${ch.id}.xhtml`] = strToU8(xhtml);
  }

  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(container),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/nav.xhtml": strToU8(nav),
    ...chapterFiles,
  });
}
