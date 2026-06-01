// 假数据 + chip 构建 + token 粗估（原型一次性件）。

import type {
  Annotation,
  Book,
  ChatMessage,
  Chip,
  ConversationMeta,
  HighlightColor,
  PresetId,
  ReaderPrefs,
  SelectionInfo,
} from "#/mock/types";

export const BOOK: Book = {
  id: "book-tideline",
  title: "岸与灯",
  author: "佚名",
  chapters: [
    {
      id: "ch1",
      title: "岸与灯",
      summaryStatus: "ready",
      summary:
        "以盐线、灯塔与归途为意象，叙述者把“方向”从一条具体的路抽象成一种被反复确认的体悟——灯塔之光的意义不在照明，而在让人记得岸的位置。",
      paragraphs: [
        "海退潮的时候，礁石上会留下一圈圈白色的盐线，像谁用指甲在石头上记下的日子。我数过很多次，却从没数到过头。",
        "祖父说，灯塔的光不是为了照亮海，而是为了让人记得岸的位置。我那时不懂，只觉得那束光每隔几秒扫过窗棂，像有人在黑暗里反复确认我还在。",
        "后来我才明白，所谓归途，往往不是一条路，而是一种被反复确认的方向。",
      ],
    },
    {
      id: "ch2",
      title: "潮汐表",
      summaryStatus: "pending",
      summary:
        "渔人世代依凭潮汐表而非天象；父亲读表如读海，而册子的末页留白，暗示无人敢替大海下定论——确定与未知并存。",
      paragraphs: [
        "镇上的渔人都信潮汐表，胜过信天气预报。那是一本被海水泡得发皱的小册子，每一页都写满了只有他们看得懂的数字。",
        "父亲把它摊在膝上，用粗糙的拇指压住某一行，说：「明天三点，水会让出一条路来。」他说这话时，眼睛望着的不是册子，而是窗外尚未亮起的海。",
        "我曾偷偷把那本册子翻到最后，想看看潮水会不会有停下的一天。可最后一页是空的，仿佛编写它的人也不敢替大海下结论。",
      ],
    },
    {
      id: "ch3",
      title: "无人称的信",
      summaryStatus: "unavailable",
      summary:
        "一封没有抬头落款的信，把“等待”交给任何愿意停下的人；叙述者在揣摩他人笔意时，照见的其实是自己。",
      paragraphs: [
        "她留下的信没有抬头，也没有落款，只在中间写了一句：「如果你读到这里，说明你也学会了等待。」",
        "我把信读了又读，试图从笔画的轻重里猜出她写字时的心情，最终却只猜出了自己的。",
        "海风从门缝里钻进来，掀动纸角。我忽然觉得，有些话之所以不写名字，是因为它本就写给任何愿意停下来的人。",
      ],
    },
  ],
  toc: [
    { id: "t1", label: "第一章 · 岸与灯", chapterId: "ch1" },
    { id: "t2", label: "第二章 · 潮汐表", chapterId: "ch2" },
    { id: "t3", label: "第三章 · 无人称的信", chapterId: "ch3" },
  ],
  summary:
    "《岸与灯》是一部以海岸为底色的短章集，借灯塔、潮汐、无人称的信等意象，反复叩问“方向”与“等待”：归途未必是一条路，而是一种被一再确认的朝向。三章互为回声，从个人记忆延伸到对确定性的怀疑。",
  summaryStatus: "ready",
};

// label 走 i18n（t(`preset.${id}`)）；template 是预填正文，留 fixtures（内容，不随 UI 语言变）。
export const PRESETS: { id: PresetId; template: string }[] = [
  { id: "explain", template: "请解释这段文字的含义。" },
  { id: "translate", template: "请把这段文字翻译成英文。" },
  { id: "summarize", template: "请概括这段文字的要点。" },
];

export const DEFAULT_PREFS: ReaderPrefs = { fontScale: 1, lineHeight: 1.9, maxWidth: 640 };

/** token 粗估：按码位数 / 3（仅演示，不镜像 main 的 estimateTokens）。 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Array.from(text).length / 3));
}

/** 由选区构建本轮 chips（selection + paragraph，Phase 1 均必备）。 */
export function buildChips(sel: SelectionInfo): Chip[] {
  return [
    {
      id: "selection",
      labelKey: "chip.selection",
      content: sel.selectionText,
      tokenCount: estimateTokens(sel.selectionText),
      required: true,
      enabled: true,
    },
    {
      id: "paragraph",
      labelKey: "chip.paragraph",
      content: sel.paragraphText,
      tokenCount: estimateTokens(sel.paragraphText),
      required: true,
      enabled: true,
    },
  ];
}

/** 侧栏会话列表（仅视觉演示）。 */
export const SAMPLE_CONVERSATIONS: ConversationMeta[] = [
  { id: "conv-1", title: "关于「灯塔的光」", chapterId: "ch1" },
  { id: "conv-2", title: "潮汐表的隐喻", chapterId: "ch2" },
  { id: "conv-indep", title: "跨章随想", chapterId: null },
];

/** 首屏种子对话：一轮已完成的问答，让面板默认有内容（「新对话」可清空看空态）。 */
export const SEED_MESSAGES: ChatMessage[] = [
  {
    id: "seed-u",
    role: "user",
    text: "这里的“灯塔的光”是什么意思？",
    chips: [
      {
        id: "selection",
        labelKey: "chip.selection",
        content: "灯塔的光不是为了照亮海，而是为了让人记得岸的位置",
        tokenCount: estimateTokens("灯塔的光不是为了照亮海，而是为了让人记得岸的位置"),
        required: true,
        enabled: true,
      },
      {
        id: "paragraph",
        labelKey: "chip.paragraph",
        content: BOOK.chapters[0].paragraphs[1],
        tokenCount: estimateTokens(BOOK.chapters[0].paragraphs[1]),
        required: true,
        enabled: true,
      },
    ],
  },
  {
    id: "seed-a",
    role: "assistant",
    status: "done",
    steps: [
      {
        id: "seed-step",
        label: "读取《岸与灯》",
        detail: "readChapterText(ch1, offset 0)",
        status: "done",
      },
    ],
    text: "这里的“灯塔的光”是一处方向的隐喻：它并不直接改变海，而是给身处黑暗的人一个可被反复确认的参照。叙述者借此把“归途”从一条具体的路，转写成“一种被反复确认的方向”——这也为后文潮汐表的意象埋下了伏笔。",
  },
];

/** 由（章, 段下标, 原文片段）构建一条种子标注，自动算字符偏移。 */
function seedAnno(
  chapterId: string,
  paragraphIndex: number,
  phrase: string,
  color: HighlightColor,
  note: string,
): Annotation {
  const para = BOOK.chapters.find((c) => c.id === chapterId)?.paragraphs[paragraphIndex] ?? "";
  const start = Math.max(0, para.indexOf(phrase));
  return {
    id: `seed-anno-${chapterId}-${paragraphIndex}`,
    color,
    note,
    text: phrase,
    chapterId,
    ranges: [{ chapterId, paragraphIndex, start, end: start + phrase.length }],
    createdAt: 0,
  };
}

/** 首屏种子标注：正文带高亮、标注列表非空、其中一条含笔记。 */
export const SEED_ANNOTATIONS: Annotation[] = [
  seedAnno(
    "ch1",
    1,
    "灯塔的光不是为了照亮海，而是为了让人记得岸的位置",
    "yellow",
    "核心隐喻：灯塔=方向感，而非照明本身。",
  ),
  seedAnno("ch1", 2, "所谓归途，往往不是一条路，而是一种被反复确认的方向", "blue", ""),
];
