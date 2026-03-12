# Google Drive Workflow Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the container agent the ability to read/write Google Drive (Sheets, Docs), send Gmail, and execute multi-step administrative workflows defined in Google Docs and configured in a manifest Sheet — invoked via `/gdrive-process <name>` in Google Chat.

**Architecture:** Three deliverables: (1) `gws` CLI installed in the container image, (2) OAuth credentials mounted read-only into the container at a fixed path, (3) a `gdrive-process` container skill (SKILL.md) that tells the agent exactly how to read the manifest, execute editing/running mode, handle checkpoints, thread correctly, and log runs. No host-side routing changes — the agent reads the skill and drives itself.

**Tech Stack:** `@googleworkspace/cli` (gws), vitest (existing tests), Docker, TypeScript (container-runner.ts)

**Spec:** `docs/superpowers/specs/2026-03-11-google-drive-workflow-design.md`

---

## Prerequisite: Verify gws CLI package

Before writing any code, confirm the package name and command syntax.

- [ ] Run `npm show @googleworkspace/cli` and check it exists and has a `gws` bin
- [ ] If the package name is wrong, find the correct one (try `npx @google/workspace-cli --help`, search npmjs.com for "google workspace cli gws")
- [ ] Note the exact command syntax for: auth login, sheets read, drive list/mkdir, docs get/append, gmail send/draft
- [ ] Record findings here: _____ (fill in before proceeding)

> **If no `gws` CLI exists:** implement the same skill using the `googleapis` Node.js library via a thin helper script (`container/gws-helper.js`) that mimics the same interface. Surface this to the user before proceeding.

---

## Chunk 1: Container Infrastructure

### Task 1: Add gws CLI to Dockerfile

**Files:**
- Modify: `container/Dockerfile`

- [ ] **Step 1: Add gws install to Dockerfile**

In `container/Dockerfile`, find the existing `npm install -g` line and add `@googleworkspace/cli`:

```dockerfile
# Install agent-browser, claude-code, and gws globally
RUN npm install -g agent-browser @anthropic-ai/claude-code @googleworkspace/cli
```

- [ ] **Step 2: Rebuild container and verify**

```bash
./container/build.sh
docker run --rm nanoclaw-agent:latest gws --version
```

Expected: version string printed without error.

- [ ] **Step 3: Commit**

```bash
git add container/Dockerfile
git commit -m "feat: install gws CLI in agent container"
```

---

### Task 2: Mount Google credentials into container

**Files:**
- Modify: `src/container-runner.ts` (function `buildVolumeMounts`, ~line 60)
- Modify: `src/container-runner.test.ts`

The container needs the gws OAuth credentials file at a predictable path. The host's `.env` provides `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` (an absolute path to the JSON credentials file — name matches the spec). If set, mount it read-only into the container at `/home/node/.config/gws/credentials.json` and pass `GWS_CREDENTIALS_FILE` as an env var inside the container.

**Two separate edits required in two separate functions:**
- `buildVolumeMounts` → adds the volume mount entry
- `buildContainerArgs` → adds the `-e GWS_CREDENTIALS_FILE=...` env var

**Background:** `buildVolumeMounts` already handles conditional mounts (e.g., the `.env` shadow and global dir). Follow the same pattern: check env var, push a mount entry. The credential proxy pattern ensures secrets never travel through prompts — same philosophy applies here.

- [ ] **Step 1: Write the failing tests**

Import both test exports at the top of `src/container-runner.test.ts` alongside the existing `runContainerAgent` import (top-level, not inside `it` blocks — vitest module caching means dynamic re-imports inside tests return stale instances):

```typescript
import { runContainerAgent, buildVolumeMountsForTest, buildContainerArgsForTest } from './container-runner.js';
```

Then add a new describe block:

```typescript
describe('Google credentials mount', () => {
  const credPath = '/home/hbramlet/.config/gws/creds.json';

  beforeEach(() => {
    delete process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
    vi.mocked(fs.default.existsSync).mockReturnValue(false);
  });

  it('mounts credentials file when GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE is set', () => {
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = credPath;
    vi.mocked(fs.default.existsSync).mockImplementation(
      (p) => p === credPath,
    );

    const mounts = buildVolumeMountsForTest(
      { folder: 'test', name: 'Test' } as RegisteredGroup,
      false,
    );

    const credMount = mounts.find(
      (m) => m.containerPath === '/home/node/.config/gws/credentials.json',
    );
    expect(credMount).toBeDefined();
    expect(credMount?.hostPath).toBe(credPath);
    expect(credMount?.readonly).toBe(true);
  });

  it('skips credentials mount when GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE is not set', () => {
    const mounts = buildVolumeMountsForTest(
      { folder: 'test', name: 'Test' } as RegisteredGroup,
      false,
    );

    const credMount = mounts.find(
      (m) => m.containerPath === '/home/node/.config/gws/credentials.json',
    );
    expect(credMount).toBeUndefined();
  });

  it('passes GWS_CREDENTIALS_FILE env var to container args when credentials are set', () => {
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = credPath;

    const args = buildContainerArgsForTest([], 'test-container');

    expect(args).toContain('GWS_CREDENTIALS_FILE=/home/node/.config/gws/credentials.json');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --reporter=verbose src/container-runner.test.ts
```

Expected: FAIL — `buildVolumeMountsForTest` and `buildContainerArgsForTest` not exported.

- [ ] **Step 3: Edit `buildVolumeMounts` in `src/container-runner.ts`**

Add the credentials mount logic inside `buildVolumeMounts` (after the `additionalMounts` block, before `return mounts`):

```typescript
// Mount Google Workspace credentials if configured
const gwsCreds = process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
if (gwsCreds && fs.existsSync(gwsCreds)) {
  mounts.push({
    hostPath: gwsCreds,
    containerPath: '/home/node/.config/gws/credentials.json',
    readonly: true,
  });
}
```

Then export both functions for testing at module level (after both function definitions):

```typescript
// Exported for testing only
export { buildVolumeMounts as buildVolumeMountsForTest };
export { buildContainerArgs as buildContainerArgsForTest };
```

- [ ] **Step 4: Edit `buildContainerArgs` in `src/container-runner.ts` — separate edit**

This is a distinct change to a different function. Find where `TZ` and `ANTHROPIC_BASE_URL` are pushed (around line 220) and add alongside them:

```typescript
// Expose gws credentials path inside the container
const gwsCreds = process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
if (gwsCreds) {
  args.push('-e', 'GWS_CREDENTIALS_FILE=/home/node/.config/gws/credentials.json');
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test -- --reporter=verbose src/container-runner.test.ts
```

Expected: PASS for both new tests.

- [ ] **Step 6: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat: mount Google Workspace credentials into agent container"
```

---

## Chunk 2: gdrive-process Agent Skill

### Task 3: Write the gdrive-process container skill

**Files:**
- Create: `container/skills/gdrive-process/SKILL.md`

This is the agent's complete operating manual for `/gdrive-process`. It must be self-contained — the agent has no other knowledge of the workflow system.

- [ ] **Step 1: Create the skill directory**

```bash
mkdir -p container/skills/gdrive-process
```

- [ ] **Step 2: Write SKILL.md**

Create `container/skills/gdrive-process/SKILL.md` with the content below. Read the spec at `docs/superpowers/specs/2026-03-11-google-drive-workflow-design.md` in full before writing.

````markdown
---
name: gdrive-process
description: Execute and manage administrative workflows defined in Google Drive. Use when the user invokes /gdrive-process <name>, wants to run, edit, or check the status of a workflow. Handles manifest reading, editing mode, running mode, checkpoints, threading, and run logging.
allowed-tools: Bash(gws:*), Bash(mkdir:*), Bash(date:*)
---

# Google Drive Workflow Agent Skill

You operate workflows defined in Google Drive. Each workflow has:
- A row in the **manifest Sheet** (the process registry)
- A **process.gdoc** (step-by-step instructions)
- A **run subfolder** created fresh each time (timestamped, with a log.gdoc inside)

All configuration is stamped into this skill at install time:

```
AGENT_NAME=<agent display name>
AGENT_GOOGLE_ACCOUNT=<agent Gmail address>
AGENT_WORKSPACE_FOLDER_ID=<Drive folder ID of Agent Workspace>
AGENT_WORKSPACE_MANIFEST_NAME=manifest
```

---

## Authentication

Credentials are pre-mounted at `/home/node/.config/gws/credentials.json`.
The `gws` CLI reads them automatically — no explicit auth step needed per run.

If you get an auth error, run:
```bash
gws auth status
```
and report the error to the user.

---

## Step 0: Read the Manifest

Every invocation starts here. The manifest Sheet is named `AGENT_WORKSPACE_MANIFEST_NAME`
inside `AGENT_WORKSPACE_FOLDER_ID`.

```bash
# Find the manifest file ID
gws drive list --parent AGENT_WORKSPACE_FOLDER_ID --name AGENT_WORKSPACE_MANIFEST_NAME

# Read all rows
gws sheets get --id <manifest-file-id>
```

Find the row where `process_name` matches the requested process (case-insensitive).

**If no matching row:**
Reply (in thread where command was sent):
> "I don't see *[name]* in the manifest. The manifest is here: [link]. Add a row for
> *[name]* with `status=draft` and `mode=editing`, create a subfolder in the workspace,
> then try again and I'll help you build it out."

Stop. Do nothing else.

**If row found**, read these columns: `status`, `mode`, `gchat_channel_id`,
`overwatcher_name`, `overwatcher_gchat_id`, `process_folder_id`, `doc_link`.

---

## Step 1: Check Status

| Status | Action |
|---|---|
| `halt` | Reply: "The *[name]* process is currently halted. No action will be taken until a human updates the manifest status." Stop. |
| `inactive` | Reply: "The *[name]* process is inactive. No action taken." Stop. |
| `draft` or `active` | Continue to Step 2. |

---

## Step 2: Read the Process Doc

First look up the doc's file ID by name within the process folder, then fetch its content:

```bash
# Get the process doc's file ID
gws drive list --parent <process_folder_id> --name process

# Then read it using the returned file ID
gws docs get --id <process-doc-file-id>
```

If no file is returned from the `drive list`, the doc doesn't exist yet — note it and continue to editing mode where you'll create/populate it.

---

## Step 3: Create Run Folder and Log

**Every run (editing or running) creates a timestamped subfolder:**

```bash
TIMESTAMP=$(date +%Y-%m-%d_%H-%M)
gws drive mkdir --parent <process_folder_id> --name "${TIMESTAMP}-run"
# Note the returned folder ID as RUN_FOLDER_ID

gws docs create --parent <RUN_FOLDER_ID> --name log
# Note the returned doc ID as LOG_DOC_ID
```

**Write the run header to the log:**
```bash
gws docs append --id <LOG_DOC_ID> --text "Run started: $(date)
Mode: <editing|running>
Overwatcher: <overwatcher_name>
Process doc: <doc_link>
---
"
```

---

## Editing Mode

Used when `mode=editing` (any status except `halt`/`inactive`).

The human drives in the browser. You observe, record, and ask before proceeding.

**Open the editing session thread:**
Post in the thread where the command was received:
> "Starting editing session for *[Process Name]*. I'll post updates here.
> Process doc: [link]"

**Each turn:**
1. Ask the human what they just did or want to do next
2. Record it in the process doc AND the log
3. Post in the same thread:
   > "[AGENT_NAME]: I've recorded: [what just happened]. Next step in the doc is: [X].
   > Should I proceed, or do you want to change anything first?"

**Updating the process doc:**
```bash
gws docs append --id <process-doc-id> --text "<new content>"
```

Use `gws docs get` first to see current content before appending or replacing sections.

**Session end:**
When the human says they're done, post a summary in the thread:
> "Editing session complete for *[Process Name]*.
> Changes made: [bullet list of what was added/changed]
> Process doc: [link] | Run log: [link]"

Write the session summary to the log doc.

---

## Running Mode

Used when `mode=running` and `status=active`.

Execute steps in the process doc sequentially. Non-checkpoint steps run silently.
At each `[CHECKPOINT]` step, pause and wait for overwatcher approval before continuing.

**Threading rule — user-initiated run:**
All updates are replies in the thread where `/gdrive-process` was sent.

**Threading rule — scheduled/proactive run:**
Open a new top-level thread in `gchat_channel_id`:
> "@[overwatcher_name] I'm starting *[Process Name]*. I'll post updates here.
> Process doc: [link]"
All subsequent updates reply to that thread.

**Checkpoint message format:**
> "@[overwatcher_name] — Checkpoint reached in *[Process Name]*
>
> **What I've done so far:** [summary of completed steps]
> **What I'm about to do:** [next action]
> **Process doc:** [link]
>
> Reply 'yes' to proceed, or tell me to stop or change course."

Wait for the overwatcher's reply. If they say 'yes' or equivalent, continue.
If they ask for changes, update the process doc and log, then continue.
If they say stop, write a "Run halted at checkpoint" entry to the log and stop.

**Log each step:**
```bash
gws docs append --id <LOG_DOC_ID> --text "Step N: [description]
Result: [outcome]
$(date)
"
```

**Final summary:**
Post in the run thread:
> "*[Process Name]* run complete.
> [2-3 sentence summary of what was done]
> Run log: [link to log doc]"

Write the final summary to the log doc.

---

## Email Handling

**Drafting (editing mode / first run):**
```bash
gws gmail draft --to "<recipient>" --subject "<subject>" --body "<body>"
```

Save draft text to the process doc under "Email Templates".
Save the Draft ID to the log doc.

**Sending (running mode — always a CHECKPOINT):**
Show the overwatcher the recipient list and template text before sending.
Only send after explicit approval.

```bash
gws gmail send --to "<recipient>" --subject "<subject>" --body "<body>"
```

Log each sent email (recipient, timestamp, subject) in the log doc.

---

## gws Command Reference

```bash
# Auth
gws auth status                        # Check auth state
gws auth login                         # Re-authenticate (interactive)

# Drive
gws drive list --parent <folder-id>    # List files in folder
gws drive list --parent <id> --name <n> # Find by name
gws drive mkdir --parent <id> --name <n> # Create subfolder
gws drive get --id <file-id>           # Get file metadata

# Docs
gws docs get --id <doc-id>            # Read doc content
gws docs create --parent <id> --name <n> # Create new doc
gws docs append --id <id> --text "<t>" # Append text to doc

# Sheets
gws sheets get --id <sheet-id>         # Read all rows as JSON
gws sheets append --id <id> --row "<json>" # Append a row

# Gmail
gws gmail draft --to <addr> --subject <s> --body <b>
gws gmail send  --to <addr> --subject <s> --body <b>
```

> **Note:** Verify exact flags with `gws <command> --help` if you get errors.
> The flags above reflect the spec's intent; actual CLI flags may differ slightly.

---

## Error Handling

- If any gws command fails, log the error and post in the active thread:
  > "I ran into an error at step [N]: [error message]. I've stopped the run. Run log: [link]"
- Do not silently continue past errors.
- If auth fails, tell the user to check `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` in `.env` and re-run `gws auth login`.
````

- [ ] **Step 3: Verify the skill directory structure**

```bash
ls container/skills/gdrive-process/
```

Expected: `SKILL.md`

- [ ] **Step 4: Commit**

```bash
git add container/skills/gdrive-process/SKILL.md
git commit -m "feat: add gdrive-process container skill"
```

---

## Chunk 3: Setup and Verification

### Task 4: OAuth credential setup and smoke test

These steps are run once per deployment. They are not automated.

- [ ] **Step 1: Ensure a GCP project is configured for the agent account**

In the GCP console logged in as `AGENT_GOOGLE_ACCOUNT`:
- Enable: Drive API, Sheets API, Docs API, Gmail API
- Create OAuth 2.0 credentials (Desktop app type)
- Download the credentials JSON

- [ ] **Step 2: Run gws auth login inside the container**

```bash
docker run --rm -it \
  -v /path/to/downloaded-creds.json:/home/node/.config/gws/credentials.json:ro \
  nanoclaw-agent:latest \
  gws auth login
```

Complete the OAuth flow. This stores the refresh token in the credentials file.

- [ ] **Step 3: Add to .env**

In `~/chiron/nanoclaw/.env`:
```
GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/absolute/path/to/gws-credentials.json
```

- [ ] **Step 4: Restart nanoclaw**

```bash
systemctl --user restart nanoclaw
```

- [ ] **Step 5: Smoke test**

Send Chiron a message:
```
/gdrive-process test-process
```

Expected: Agent replies that it can't find "test-process" in the manifest, and provides a link to the manifest.

---

### Task 5: Update global CLAUDE.md with gdrive-process capability

**Files:**
- Modify: `groups/global/CLAUDE.md`

- [ ] **Step 1: Add gdrive-process to the capabilities section**

In `groups/global/CLAUDE.md`, find the capabilities list and add:

```markdown
- **Manage Drive workflows** with `/gdrive-process <name>` — read the manifest Sheet, execute editing or running mode, handle checkpoints, log runs to Drive
```

- [ ] **Step 2: Commit**

```bash
git add groups/global/CLAUDE.md
git commit -m "docs: document gdrive-process capability in agent CLAUDE.md"
```

---

## Done

After all tasks complete:
1. Container image has `gws` CLI
2. Agent containers receive credentials at `/home/node/.config/gws/credentials.json`
3. Agent has a complete operating manual in `container/skills/gdrive-process/SKILL.md`
4. `/gdrive-process <name>` works end-to-end from Google Chat

**Next:** Set up the Agent Workspace folder in Drive, create the manifest Sheet, and run the first editing session for "Membership Lapse Outreach".
