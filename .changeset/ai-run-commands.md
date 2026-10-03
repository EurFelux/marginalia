---
"marginalia": minor
---

The AI can now run shell commands on your computer, so it can work with your own scripts and other tools. Turn it on in Settings › Commands (it's off by default). Every command waits for your approval in the conversation: allow it once, allow commands starting the same way for the rest of the conversation, or always allow them as a saved rule; deny it with an optional reason and the AI won't retry it. Commands with `;`, `|`, `&&` and similar always ask unless you turn on "Always approve", and deny rules you add block a command even then. Commands run in a workspace folder you can change, see the same tools as your terminal (Homebrew, nvm, mise and so on), and are stopped after a timeout or when you press Stop.
