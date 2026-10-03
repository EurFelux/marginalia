---
"marginalia": minor
---

The AI can now run shell commands on your computer, so it can work with your own scripts and other tools. It's on by default, and no command runs without your say-so: each one waits for your approval in the conversation, where you can allow it once, allow commands that start the same way for the rest of the conversation, or always allow them as a saved rule. Deny a command, optionally with a reason, and the AI won't retry it. Commands with `;`, `|`, `&&` and similar always ask unless you turn on "Always approve", and deny rules you add block a command even then. Commands run in a workspace folder you can change, see the same tools as your terminal (Homebrew, nvm, mise and so on), and stop after a timeout or when you press Stop. You can turn all of this off in Settings › Commands.
