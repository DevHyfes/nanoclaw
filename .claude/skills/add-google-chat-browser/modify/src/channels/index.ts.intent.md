# Intent: Add Google Chat Browser channel import

Add `import './google-chat-browser.js';` to the channel barrel file so the
Google Chat Browser module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved exactly.

The import is placed in the `// google_chat_browser` section (alphabetically
between `// google_chat` and `// slack`).
