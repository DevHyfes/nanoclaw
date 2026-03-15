---
name: gdrive-process
description: Execute and manage administrative workflows defined in Google Drive. Use when the user invokes /gdrive-process <name>, wants to run, edit, or check the status of a workflow.
allowed-tools: Bash(gws:*)
---

# /gdrive-process — Google Drive Workflow Execution

## Prerequisites

Read all of the following skills before executing any commands in this skill:

- `../gws-shared/SKILL.md` — auth, global flags, security rules, shell escaping
- `../gws-drive/SKILL.md` — Drive file listing and folder creation
- `../gws-docs/SKILL.md` — Docs read
- `../gws-docs-write/SKILL.md` — Docs append
- `../gws-sheets/SKILL.md` — Sheets overview
- `../gws-sheets-read/SKILL.md` — Sheets read
- `../gws-gmail/SKILL.md` — Gmail overview
- `../gws-gmail-send/SKILL.md` — Gmail send and draft

---

## Configuration

These values are stamped at install time. Do not change them at runtime.

```
AGENT_NAME=Chiron
AGENT_GOOGLE_ACCOUNT=chiron.t606@gmail.com
AGENT_WORKSPACE_FOLDER_ID=1Cb4TPxQCt0TveS526ZJXCZP7Mlqk_kvE
AGENT_WORKSPACE_MANIFEST_NAME=manifest
```

---

## Authentication

Credentials are pre-mounted at `/home/node/.config/gws/credentials.json`.
See `../gws-shared/SKILL.md` for the full auth reference.

The `gws` CLI discovers credentials automatically from the mounted file.
No explicit `gws auth login` is needed at runtime.

---

## Invocation

```
/gdrive-process <process-name>
```

`<process-name>` is the value to look up in the manifest's `process_name` column
(case-insensitive substring match is acceptable; exact match is preferred).

---

## Step 0: Read the Manifest

### 0a. Find the manifest sheet ID

List files in the Agent Workspace folder, filtered to the manifest by name:

```bash
gws drive files list --params '{"q": "'\''AGENT_WORKSPACE_FOLDER_ID'\'' in parents and name = '\''manifest'\'' and trashed = false", "fields": "files(id,name,mimeType)"}'
```

Extract the `id` field from the returned JSON. This is `MANIFEST_ID`.

### 0b. Read all rows from the manifest

```bash
gws sheets +read --spreadsheet MANIFEST_ID --range "Sheet1"
```

The first row is the header. Columns (in order from the spec):

| Index | Column |
|-------|--------|
| 0 | `process_name` |
| 1 | `status` |
| 2 | `mode` |
| 3 | `gchat_channel_id` |
| 4 | `overwatcher_name` |
| 5 | `overwatcher_gchat_id` |
| 6 | `process_folder_id` |
| 7 | `doc_link` |

### 0c. Locate the requested process row

Match `<process-name>` against the `process_name` column (case-insensitive).

**If no match is found**, reply with this exact message and stop:

> "I don't see *[name]* in the manifest. The manifest is here: https://docs.google.com/spreadsheets/d/MANIFEST_ID. Add a row for *[name]* with `status=draft` and `mode=editing`, create a subfolder in the workspace, then try again and I'll help you build it out."

If a match is found, extract all columns into variables:
`PROCESS_NAME`, `STATUS`, `MODE`, `GCHAT_CHANNEL_ID`, `OVERWATCHER_NAME`,
`OVERWATCHER_GCHAT_ID`, `PROCESS_FOLDER_ID`, `DOC_LINK`

---

## Step 1: Check Status

Apply the following table before doing anything else:

| `status` value | Action |
|---------------|--------|
| `halt` | Reply: "The *[PROCESS_NAME]* process is halted. No action will be taken until a human changes the status in the manifest." Stop immediately. |
| `inactive` | Reply: "The *[PROCESS_NAME]* process is currently inactive. Update `status` in the manifest to `active` or `draft` to enable it." Stop immediately. |
| `draft` | Continue only if `mode=editing`. If `mode=running`, treat as inactive. |
| `active` | Continue. Mode determines editing vs. running behavior (Step 3+). |

For `status=draft` with `mode=running`: reply "The *[PROCESS_NAME]* process is in draft status and cannot be run autonomously. Switch `mode` to `editing` to work on it." Stop.

---

## Step 2: Read the Process Doc

### 2a. Find the process doc file ID

The `doc_link` column contains a URL like `https://docs.google.com/document/d/FILE_ID/edit`.
Extract `FILE_ID` from the URL directly — no Drive API call needed. Assign it to `PROCESS_DOC_ID`.

If `doc_link` is empty or blank, find it by name inside the process folder (substitute the real
folder ID for `PROCESS_FOLDER_ID`):

```bash
gws drive files list --params '{"q": "'\''PROCESS_FOLDER_ID'\'' in parents and name = '\''process'\'' and trashed = false", "fields": "files(id,name,mimeType)"}'
```

Extract the `id` field and assign it to `PROCESS_DOC_ID`.

### 2b. Fetch the process doc content

```bash
gws docs documents get --params '{"documentId": "PROCESS_DOC_ID"}'
```

Parse the returned document body to extract the full text. Note whether the doc is blank
(no body content) or populated.

**If the doc is missing** (file not found): reply "I couldn't find the process doc for *[PROCESS_NAME]*. Please create a Google Doc named `process` in the process folder at https://drive.google.com/drive/folders/PROCESS_FOLDER_ID and try again." Stop.

---

## Step 3: Create Run Folder and Log

At the start of every run — whether editing or running mode — create a timestamped
run subfolder and log doc. Do this before taking any other action.

### 3a. Determine the timestamp

Use the current UTC time formatted as `YYYY-MM-DD_HH-MM`. Example: `2026-03-15_09-30`.

### 3b. Create the run subfolder

Substitute the actual timestamp computed in Step 3a for `YYYY-MM-DD_HH-MM`, and the real
folder ID for `PROCESS_FOLDER_ID`:

```bash
gws drive files create --json '{"name": "YYYY-MM-DD_HH-MM-run", "mimeType": "application/vnd.google-apps.folder", "parents": ["PROCESS_FOLDER_ID"]}'
```

Extract the `id` from the response. This is `RUN_FOLDER_ID`.

### 3c. Create the log doc inside the run folder

```bash
gws drive files create --json '{"name": "log", "mimeType": "application/vnd.google-apps.document", "parents": ["RUN_FOLDER_ID"]}'
```

Extract the `id` from the response. This is `LOG_DOC_ID`.

### 3d. Write the run header to the log doc

```bash
gws docs +write --document LOG_DOC_ID --text "Run: YYYY-MM-DD HH:MM UTC
Process: PROCESS_NAME
Mode: MODE
Overwatcher: OVERWATCHER_NAME
Status at start: STATUS
---
"
```

---

## Step 4: Dispatch by Mode

After completing Steps 0–3, dispatch based on `MODE`:

- `editing` → **Editing Mode** (below)
- `running` → **Running Mode** (below)

---

## Editing Mode

Used when building or refining a workflow collaboratively (`status=draft` or
`status=active`, `mode=editing`).

### Threading rule

All editing-session messages are posted as replies in a single thread.
Open the thread with:

> "Starting editing session for *[PROCESS_NAME]*. I'll post updates here.
> Process doc: [DOC_LINK]"

If the `/gdrive-process` command was sent in a thread, reply in that thread.
If sent in main chat, open a new thread with the opener above.

Log the thread-open message to the log doc:

```bash
gws docs +write --document LOG_DOC_ID --text "[HH:MM UTC] Editing session started. Thread opened."
```

### Per-turn behavior

The human drives all work in the browser. The agent does not take autonomous action.

After each step the human describes or takes:

1. Record what happened in the log doc:
   ```bash
   gws docs +write --document LOG_DOC_ID --text "[HH:MM UTC] Step recorded: [WHAT HAPPENED]"
   ```

2. Update the process doc to reflect the new/changed content:
   ```bash
   gws docs +write --document PROCESS_DOC_ID --text "[NEW OR UPDATED SECTION TEXT]"
   ```
   For structured edits (replacing sections), use `gws docs documents batchUpdate`
   with the appropriate `replaceAllText` or `deleteContentRange`/`insertText` requests.
   Check the schema first:
   ```bash
   gws schema docs.documents.batchUpdate
   ```

3. Post in the active thread:
   > "[AGENT_NAME]: I've recorded: [what just happened]. Next step in the doc is: [X].
   > Should I proceed, or do you want to change anything first?"

If the human describes a change, update the process doc before asking about the next step.

### Email drafting in editing mode

When the process requires outgoing emails, generate draft email text and:
1. Append the draft under an "Email Templates" section in the process doc.
2. Create a Gmail draft for review (do **not** send):
   ```bash
   gws gmail users drafts create --params '{"userId": "me"}' --json '{"message": {"raw": "BASE64_RFC2822_MESSAGE"}}'
   ```
   (Build the RFC 2822 message manually and base64url-encode it before passing as `raw`.)

   Log the draft creation:
   ```bash
   gws docs +write --document LOG_DOC_ID --text "[HH:MM UTC] Gmail draft created for review. Subject: SUBJECT"
   ```

### Session end summary

When the human ends the session (or signals they are done), post in the thread:

> "[AGENT_NAME]: Editing session complete for *[PROCESS_NAME]*.
> **What I added/changed:** [bullet list]
> **Process doc:** [DOC_LINK]
> **Run log:** https://docs.google.com/document/d/LOG_DOC_ID"

Log the session end:
```bash
gws docs +write --document LOG_DOC_ID --text "[HH:MM UTC] Editing session ended. Summary: [SUMMARY]"
```

---

## Running Mode

Used for autonomous workflow execution (`status=active`, `mode=running`).

### Threading rule — user-initiated run

When a user sends `/gdrive-process <name>` in Google Chat, reply in the same thread
for all subsequent updates (checkpoint requests, status messages, final summary).

### Threading rule — scheduled/proactive run

When the agent initiates a run on a schedule (no user message), open a new thread in
`GCHAT_CHANNEL_ID`:

> "@[OVERWATCHER_NAME] I'm starting *[PROCESS_NAME]*. I'll post updates here.
> Process doc: [DOC_LINK]"

All subsequent updates for that run are replies in that thread.

Log the run start:
```bash
gws docs +write --document LOG_DOC_ID --text "[HH:MM UTC] Autonomous run started."
```

### Step execution

Read the process doc steps (from Step 2). Execute each step in order.

For each non-checkpoint step:
1. Execute the action (Drive, Sheets, Docs, Gmail operations as required by the step).
2. Log the outcome:
   ```bash
   gws docs +write --document LOG_DOC_ID --text "[HH:MM UTC] Step N complete: [OUTCOME]"
   ```

Execute silently — do not post to chat for non-checkpoint steps.

### Checkpoint steps

When a step is marked `[CHECKPOINT]`:

1. Log the checkpoint:
   ```bash
   gws docs +write --document LOG_DOC_ID --text "[HH:MM UTC] Checkpoint reached. Waiting for overwatcher approval."
   ```

2. Post the checkpoint message in the active thread:
   > "@[OVERWATCHER_NAME] — Checkpoint reached in *[PROCESS_NAME]*
   >
   > **What I've done so far:** [summary of completed steps]
   > **What I'm about to do:** [next action]
   > **Process doc:** [DOC_LINK]
   >
   > Reply 'yes' to proceed, or tell me to stop or change course."

3. Wait for the overwatcher's reply in the thread before proceeding.
   - Reply is "yes" or equivalent approval → log and continue.
   - Reply requests a stop or change → log the instruction, update the process doc if
     the overwatcher requests a change, and post a confirmation before stopping or adjusting.

   Log the decision:
   ```bash
   gws docs +write --document LOG_DOC_ID --text "[HH:MM UTC] Overwatcher [OVERWATCHER_NAME] approved checkpoint. Said: '[THEIR REPLY]'"
   ```

### Email sending in running mode

Sending emails is always a `[CHECKPOINT]` step. Before sending:
1. Include the full recipient list and rendered email body in the checkpoint message.
2. Wait for explicit approval.
3. On approval, send:
   ```bash
   gws gmail +send --to RECIPIENT_EMAILS --subject "SUBJECT" --body "BODY TEXT"
   ```
4. Log each send:
   ```bash
   gws docs +write --document LOG_DOC_ID --text "[HH:MM UTC] Email sent to: RECIPIENTS. Subject: SUBJECT"
   ```

### Final summary

After all steps complete, post in the active thread:

> "[AGENT_NAME]: *[PROCESS_NAME]* run complete.
>
> **Summary:** [what was done]
> **Artifacts:** [links to any files created in the run folder]
> **Run log:** https://docs.google.com/document/d/LOG_DOC_ID
> **Run folder:** https://drive.google.com/drive/folders/RUN_FOLDER_ID"

Log the run end:
```bash
gws docs +write --document LOG_DOC_ID --text "[HH:MM UTC] Run complete. Final status: SUCCESS"
```

---

## Artifacts

Any files generated or consumed during the run (exported CSVs, downloaded reports,
draft docs) must be placed in the run subfolder (`RUN_FOLDER_ID`), not in the process
folder or workspace root.

To move or create a file in the run folder, include `"parents": ["RUN_FOLDER_ID"]` in
the `files.create` call or use `files.update` to reparent an existing file.

---

## Error Handling

- **Fail loudly.** If any `gws` command returns an error, do not silently continue.
- Log the error immediately:
  ```bash
  gws docs +write --document LOG_DOC_ID --text "[HH:MM UTC] ERROR: [COMMAND] failed. Response: [ERROR DETAIL]"
  ```
- Report to the user/overwatcher in the active thread:
  > "[AGENT_NAME]: I hit an error during *[PROCESS_NAME]* and have stopped.
  > **Error:** [brief description]
  > **Run log:** https://docs.google.com/document/d/LOG_DOC_ID"
- Do not retry automatically unless the error is clearly transient (e.g., rate limit
  with a `Retry-After` header). For transient errors, wait the indicated interval and
  retry once.
- Use `--dry-run` when validating complex write commands before executing.

---

## Scheduling Note

Scheduled runs are configured via NanoClaw's task scheduler. At the start of every
scheduled invocation, re-read the manifest (Step 0) to confirm `status=active` and
`mode=running`. If the manifest shows any other state, skip the run silently — do not
send any chat message and do not create a run folder or log doc. The skip is silent by
design.

---

## Shell Escaping Reminder

- Sheet ranges containing `!` must use double quotes: `"Sheet1!A1:H100"` (not single quotes in zsh)
- `--params` and `--json` values use single quotes to protect inner double quotes
- Folder IDs in Drive query strings must be single-quoted inside the JSON `q` value;
  use shell escaping as shown in Step 0a above
