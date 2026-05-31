# ePub AI Reader — Project Spec

## Overview

A cross-platform desktop ePub reader built with Electron + React, featuring a continuous scroll reading experience and deep AI integration. The core differentiator is a selection-triggered AI workflow: users highlight text, choose an AI action from a toolbar, and interact with a context-aware assistant in a side panel. The AI can also operate on user-authorized external directories via sandboxed file tools.

---

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Shell | Electron | Mature ecosystem, consistent Chromium rendering, native Node.js FS access |
| UI Framework | React + TypeScript | Ecosystem maturity, broad community examples |
| Styling | Tailwind CSS | Utility-first, fast iteration |
| ePub Rendering | epub.js (`flow: "scrolled"`) | Best-in-class scrolled ePub support |
| Database | better-sqlite3 | Sync API, single-file DB, no ORM needed for this scale |
| AI SDK | Vercel AI SDK | Multi-provider support, streaming, native tool call support |
| Build / Package | electron-builder | Cross-platform packaging |

---

## Core Concepts

### Assistant
Inspired by Cherry Studio's assistant model. An Assistant is a named configuration consisting of:
- System prompt
- Model + provider configuration
- Default context chip preferences (`includeGlobal`, `includeChapter`)

Users can create multiple Assistants (e.g. "Literary Analysis", "Language Learning", "Philosophy Discussion") and select which one to use per conversation. Assistants are stored in SQLite.

### Context Chips
When the user triggers an AI action after selecting text, the input bar is pre-populated with context chips. Each chip is a discrete, labeled piece of context that the user can inspect and toggle.

| Chip | Content | Required | Default |
|---|---|---|---|
| `selection` | The exact selected text | ✅ Yes | Always on |
| `paragraph` | Selected paragraph + 1–2 surrounding paragraphs (verbatim) | ✅ Yes | Always on |
| `chapter` | AI-generated chapter summary | No | Configurable per Assistant |
| `global` | AI-generated book summary + TOC | No | Configurable per Assistant |

Chips that are not required can be toggled on/off by the user in the input bar. Each chip displays an estimated token count. The `chapter` and `global` chips are only available if the summaries have been successfully generated (see Context Generation below).

### Context Generation
Upon book import, the app optionally generates AI summaries for global and chapter contexts:
- **TOC / outline**: parsed directly from ePub NCX/OPF — no AI needed
- **Book summary**: AI-generated, covers themes, characters, structure
- **Chapter summaries**: AI-generated per chapter, lazy but triggered at import time

The user can opt out of automatic generation at import. Context availability is tracked per-book and per-chapter in SQLite with explicit status fields (`pending | generating | ready | unavailable`). The AI panel gracefully degrades when context is unavailable — chips are shown as disabled with a tooltip explaining why.

Generation runs in a background queue and does not block the reading experience.

---

## Database Schema

```sql
-- Books
CREATE TABLE books (
  id TEXT PRIMARY KEY,           -- ePub unique identifier
  path TEXT NOT NULL,
  title TEXT,
  author TEXT,
  cover BLOB,
  global_summary TEXT,
  global_summary_status TEXT DEFAULT 'pending',  -- pending|generating|ready|unavailable
  toc TEXT,                      -- JSON, parsed from NCX/OPF
  added_at INTEGER
);

-- Chapters
CREATE TABLE chapters (
  id TEXT PRIMARY KEY,           -- spine item id
  book_id TEXT NOT NULL,
  title TEXT,
  order_index INTEGER,
  summary TEXT,
  summary_status TEXT DEFAULT 'pending',
  FOREIGN KEY (book_id) REFERENCES books(id)
);

-- Reading Progress
CREATE TABLE progress (
  book_id TEXT PRIMARY KEY,
  cfi TEXT NOT NULL,             -- epub.js CFI location
  updated_at INTEGER
);

-- Assistants
CREATE TABLE assistants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  system_prompt TEXT,
  provider TEXT,                 -- e.g. 'openai', 'anthropic', 'google'
  model TEXT,
  include_global_default INTEGER DEFAULT 1,
  include_chapter_default INTEGER DEFAULT 1,
  created_at INTEGER
);

-- Conversations
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  book_id TEXT,
  assistant_id TEXT,
  created_at INTEGER,
  FOREIGN KEY (book_id) REFERENCES books(id),
  FOREIGN KEY (assistant_id) REFERENCES assistants(id)
);

-- Messages
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,            -- 'user' | 'assistant' | 'tool'
  content TEXT NOT NULL,        -- JSON (supports multi-part content)
  context_chips TEXT,           -- JSON snapshot of chips sent with this message
  created_at INTEGER,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

-- Authorized Directories (for file tools)
CREATE TABLE authorized_dirs (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  label TEXT,                   -- user-defined nickname
  granted_at INTEGER
);
```

---

## Application Layout

```
┌─────────────────────────────────────────────────────────┐
│  Sidebar          │  Reader                │  AI Panel  │
│  ─────────────    │  ──────────────────    │  ────────  │
│  Book library     │  epub.js scrolled      │  Assistant │
│  TOC (current     │  render                │  selector  │
│  book)            │                        │            │
│  Conversations    │  [Selection toolbar    │  Message   │
│                   │   appears on select]   │  history   │
│                   │                        │            │
│                   │                        │  Input bar │
│                   │                        │  [chips]   │
│                   │                        │  [textarea]│
└─────────────────────────────────────────────────────────┘
```

The AI Panel can be collapsed. When collapsed, the selection toolbar still appears but clicking an AI action opens the panel.

---

## Key Interactions

### Book Import Flow
1. User opens ePub file via file dialog
2. App parses metadata and TOC from OPF/NCX (synchronous, fast)
3. Book appears in library immediately
4. If auto-generate is enabled: background queue starts generating global summary, then chapter summaries in spine order
5. Status indicators visible in library and AI panel chips

### Selection → AI Flow
1. User selects text in epub.js rendition
2. Floating toolbar appears near selection with actions: **Copy**, **AI Ask**, **Highlight** (future), **...more**
3. User clicks **AI Ask**
4. AI Panel opens (if collapsed)
5. Input bar pre-populated with chips: `selection` + `paragraph` (always), `chapter` + `global` (per Assistant defaults, disabled if unavailable)
6. User can: toggle optional chips, inspect chip content by clicking chip, edit the textarea to add their question
7. User submits → streaming response in panel
8. Conversation persisted to SQLite

### Context Chip Inspection
Clicking a chip expands it inline (or in a popover) to show the full content that will be sent to the AI. This is important for transparency — users should always know what context is being included.

---

## AI Tool System

Tools are implemented in-process (no MCP, no separate service). All tools are available to the AI during a conversation.

### Book Context Tools (always available)

```typescript
getBookSummary(bookId: string): string
getChapterSummary(bookId: string, chapterId: string): string
getToc(bookId: string): TocNode[]
```

### File System Tools (available when directories are authorized)

All file tools validate that the resolved path is within an authorized root before executing. Path traversal attempts throw an error.

```typescript
readFile(path: string): string
writeFile(path: string, content: string): void
appendFile(path: string, content: string): void
listDirectory(path: string): FileEntry[]
createDirectory(path: string): void
deleteFile(path: string): void          // requires explicit user confirmation in UI
```

Authorization is managed in Settings. Users can add/remove authorized directories at any time. The AI panel shows a persistent indicator of which directories are currently accessible.

---

## Prompt Assembly

Messages sent to the AI follow this structure:

```
[System prompt from Assistant]

---

[If global chip enabled and ready]
## Book Overview
{book summary}

## Table of Contents
{toc as markdown}

---

[If chapter chip enabled and ready]
## Current Chapter: {chapter title}
{chapter summary}

---

## Surrounding Context
{paragraph before + current paragraph + paragraph after}

---

## Selected Text
{exact selection}

---

[User's message text]
```

Context is ordered macro → micro. Disabled or unavailable chips are omitted entirely from the prompt.

---

## Settings

- **Providers & Models**: API keys and base URLs per provider (OpenAI, Anthropic, Google, custom OpenAI-compatible endpoints)
- **Assistants**: Create, edit, delete Assistants
- **Context Generation**: Default behavior on book import (auto-generate / ask / never)
- **Authorized Directories**: List of directories the AI can read/write, with add/remove controls
- **Reader**: Font size, line height, max content width (injected as CSS overrides into epub.js)

---

## epub.js Integration Notes

- Use `flow: "scrolled"` and `spread: "none"`
- Serve ePub assets via a custom `WKURLSchemeHandler` equivalent — in Electron, use a custom protocol registered with `protocol.registerFileProtocol` or serve from a local Express instance to avoid CSP issues
- Hook `rendition.on("selected", ...)` for selection events; extract surrounding paragraphs by walking the DOM from the selection anchor
- Save/restore reading position using `rendition.on("relocated", ...)` and `rendition.display(cfi)`
- Chapter id for context lookup: derive from the current CFI or from `rendition.currentLocation().start.href`

---

## Out of Scope (MVP)

- Highlights and annotations persistence
- Multi-device sync
- DRM support
- PDF support
- Mobile / web versions
- Export to specific apps (Obsidian, Notion, etc.) — the file tools cover this generically
- Offline AI (local models)

---

## Directory Structure (suggested)

```
src/
├── main/                   # Electron main process
│   ├── db/                 # better-sqlite3 setup, migrations, query functions
│   ├── epub/               # EpubSkill: parse, extract, summary generation
│   ├── ai/                 # Tool definitions, prompt assembly
│   ├── files/              # Sandboxed file tools, authorization checks
│   └── ipc/                # IPC handlers bridging main ↔ renderer
├── renderer/               # React app
│   ├── components/
│   │   ├── Reader/         # epub.js wrapper, selection toolbar
│   │   ├── AIPanel/        # Conversation UI, input bar, chips
│   │   ├── Library/        # Book grid, import flow
│   │   ├── Sidebar/        # TOC, conversation list
│   │   └── Settings/       # Provider config, assistants, authorized dirs
│   ├── hooks/
│   └── store/              # UI state (Zustand or similar)
└── shared/                 # Types shared between main and renderer
```

---

## Open Questions (decide before implementation)

1. **Conversation scope**: one conversation per book, or multiple conversations per book (each selection spawns a new one, or continues existing)? Suggest: one persistent conversation per book+assistant pair, with the ability to start fresh.
2. **AI action on toolbar**: is "AI Ask" the only AI action, or are there preset actions ("Explain", "Translate", "Summarize selection") that skip the editable input and fire directly? Preset actions could use a fixed prompt template with the chips, bypassing the input bar.
3. **better-sqlite3 rebuild**: confirm electron-rebuild is in the dev setup from day one to avoid late-stage packaging pain.
