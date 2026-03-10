---
name: add-google-chat-browser
description: Add Google Chat as a channel via Playwright browser automation. Drives chat.google.com headlessly so no Google Workspace API is required. Also mounts the auth session into agent containers for HTML bot-response testing.
---

# Add Google Chat Browser Channel

This skill adds a Google Chat channel to NanoClaw by automating `chat.google.com` via
Playwright. One-time headed login → saved session → headless polling in production.

---

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `google_chat_browser` is in `applied_skills`, skip to
Phase 5 (Auth Capture — unless `store/google-chat-browser/auth.json` already exists,
in which case skip to Phase 6).

### Check Playwright

```bash
node -e "require('playwright')" 2>/dev/null && echo "installed" || echo "missing"
```

If missing, proceed to Phase 2. If installed, skip to Phase 3.

---

## Phase 2: Install Playwright

```bash
npm install playwright
npx playwright install chromium
```

Confirm the install completed without errors before continuing.

---

## Phase 3: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-google-chat-browser
```

This deterministically:
- Adds `src/channels/google-chat-browser.ts` (GoogleChatBrowserChannel with self-registration)
- Adds `src/channels/google-chat-browser.test.ts` (unit tests)
- Adds `setup/google-chat-browser-auth.ts` (interactive auth capture step)
- Appends `import './google-chat-browser.js'` to `src/channels/index.ts`
- Adds `'google-chat-browser-auth'` step to `setup/index.ts`
- Installs the `playwright` npm dependency
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/channels/index.ts.intent.md`
- `modify/setup/index.ts.intent.md`

---

## Phase 4: Build

```bash
npm run build
```

The build must succeed before proceeding. If tests are available:

```bash
npx vitest run src/channels/google-chat-browser.test.ts
```

---

## Phase 5: Auth Capture

> Skip this phase if `store/google-chat-browser/auth.json` already exists and is valid.

This step opens a **headed** (visible) browser so you can log in to Google Chat.
The session is then saved and used headlessly at runtime.

```bash
npx tsx setup/index.ts --step google-chat-browser-auth
```

A browser window will open. Log in to your Google account when prompted. Once you
reach `chat.google.com` successfully, the script automatically saves the session and
closes the browser.

The session is saved to `store/google-chat-browser/auth.json`.

**Note**: If you are on a headless machine (no display), you need to run this step
from a machine with a screen, copy the resulting `auth.json` to the server, and place
it at `store/google-chat-browser/auth.json`.

---

## Phase 6: List Available Spaces

Run this inline Node script to discover your Google Chat spaces and their room IDs:

```bash
node --input-type=module <<'EOF'
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: 'store/google-chat-browser/auth.json',
});
const page = await context.newPage();
await page.goto('https://chat.google.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);

// Google Chat (2024+) uses /app/chat/{id} URLs.
// We navigate to the DMs section and click each entry to discover IDs.
const ids = new Set();
const results = [];

// Collect any visible conversation items in the sidebar by clicking them
const dmItems = await page.$$('[role="list"] [role="listitem"], [data-world-section-type] [tabindex="0"]');
for (const item of dmItems.slice(0, 20)) {
  const text = await item.textContent().catch(() => '');
  if (!text?.trim()) continue;
  try {
    await item.click({ timeout: 2000 });
    await page.waitForTimeout(1000);
    const url = page.url();
    const match = url.match(/\/(?:app\/chat|room|dm)\/([^/?#]+)/);
    if (match && !ids.has(match[1])) {
      ids.add(match[1]);
      results.push({ name: text.trim().replace(/\n.*/s, '').slice(0, 50), id: match[1] });
    }
  } catch {}
}

console.log('\nAvailable Google Chat conversations:\n');
if (results.length === 0) {
  console.log('  None found. Open Google Chat in your browser, navigate to a space or DM,');
  console.log('  note the ID from the URL (e.g. chat.google.com/app/chat/ABC123), then');
  console.log('  register with: gchat:ABC123');
} else {
  for (const r of results) {
    console.log(`  Name: ${r.name}`);
    console.log(`  JID:  gchat:${r.id}`);
    console.log('');
  }
}

await browser.close();
EOF
```

If the script finds no results, navigate to the space in your regular browser, copy the ID from the URL (e.g., `chat.google.com/app/chat/AAAAbcDeFg` → ID is `AAAAbcDeFg`), and use `gchat:AAAAbcDeFg`.

Note the `gchat:{roomId}` value for the space you want to register.

---

## Phase 7: Register a Space

Ask the user which space they want to register. Use `AskUserQuestion` if the skill
is being run interactively.

Then register it:

```bash
npx tsx setup/index.ts --step register \
  --jid "gchat:{ROOM_ID}" \
  --name "{SPACE_NAME}" \
  --container-config '{"additionalMounts":[{"hostPath":"store/google-chat-browser","containerPath":"google-chat-browser","readonly":true}]}'
```

The `additionalMounts` entry mounts the auth directory read-only into the agent
container so agents can open authenticated Google Chat for HTML bot-response testing:

```bash
# Inside the agent container:
agent-browser load-auth /workspace/extra/google-chat-browser/auth.json
agent-browser open https://chat.google.com/room/{ROOM_ID}
```

Repeat this phase for additional spaces.

---

## Phase 8: Sync Environment + Restart

```bash
mkdir -p data/env && cp .env data/env/env
systemctl --user restart nanoclaw
```

On macOS, use:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

## Phase 9: Verify

1. In the registered Google Chat space, send: `@Chiron hello`
2. Expect a response within ~15 seconds (5s poll cycle + processing)
3. Check logs: `tail -f logs/nanoclaw.log`
   - Look for: `Google Chat Browser: page initialised` on startup
   - Look for: `Google Chat Browser: message sent` when Chiron replies

---

## Troubleshooting

### Auth expired

Symptoms: `auth expired — navigated to Google login` in logs.

Fix: Re-run Phase 5 to capture a fresh session.

### Wrong selectors (Google changed DOM)

Symptoms: No messages delivered, send fails.

Fix:
1. Use `agent-browser snapshot https://chat.google.com/room/{ID}` to capture a DOM snapshot
2. Open the snapshot HTML and search for the message container and input elements
3. Update `SELECTORS` in `src/channels/google-chat-browser.ts`
4. Run `npm run build && systemctl --user restart nanoclaw`

### Google detecting automation

Symptoms: CAPTCHA or bot detection page shown.

Fix: Add `playwright-extra` with the stealth plugin:

```bash
npm install playwright-extra puppeteer-extra-plugin-stealth
```

Then update `connect()` to use `chromium.use(stealth())` (requires `playwright-extra`).

### Space not found in Phase 6 list

If the space sidebar is collapsed or the space hasn't been opened recently:
1. Open Google Chat in a real browser
2. Navigate to the space directly
3. Re-run Phase 6 — spaces you've visited recently appear in the sidebar

### Headless environment (no display for Phase 5)

Run auth capture on a local machine:
```bash
npx tsx setup/index.ts --step google-chat-browser-auth
```
Then copy `store/google-chat-browser/auth.json` to your server.
