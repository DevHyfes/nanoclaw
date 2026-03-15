# Google Drive Workflow Integration — Design Spec

**Date:** 2026-03-11
**Status:** Approved for implementation planning

---

## Overview

Give the agent the ability to read from and write to a shared Google Drive (Sheets, Docs),
send email (Gmail), and execute multi-step administrative workflows. Workflows are defined
in Google Docs, configured in a manifest Sheet, and executed either interactively (editing
mode) or autonomously with human checkpoints (running mode). All communication with
overwatchers happens via Google Chat, with explicit threading rules at each step.

The skill is fully portable — all org-specific values are configuration, not code.

---

## Configuration

All instance-specific values are stamped into the skill at install time. The skill file
is the single source of truth — no external config files required.

**Skill metadata (populated during install):**

```
AGENT_NAME=<display name of the agent, e.g. "Chiron">
AGENT_GOOGLE_ACCOUNT=<agent's Gmail address, e.g. chiron.t606@gmail.com>
AGENT_WORKSPACE_FOLDER_ID=<Google Drive folder ID of the Agent Workspace>
AGENT_WORKSPACE_MANIFEST_NAME=manifest
```

The same skill works for any deployment — install it with different values to point at a
different org, workspace, or test environment.

---

## Authentication

- **Agent account:** configured as `AGENT_GOOGLE_ACCOUNT` at install time
- **Method:** OAuth via `gws auth login`, refresh token stored as a container secret
  (mounted environment variable or credentials file at container startup)
- **GCP project:** A free-tier GCP project registered to the agent's Google account,
  with Drive API, Sheets API, Docs API, and Gmail API enabled
- **Drive access:** The workspace owner shares the Agent Workspace folder with the agent
  account; the agent accesses all files through that share
- **Email:** The agent sends/drafts as `AGENT_GOOGLE_ACCOUNT` via `gws gmail` commands

---

## Agent Workspace Folder Structure

Folder owned by the workspace owner, shared with the agent account:

```
Agent Workspace/
├── manifest.gsheet                        ← process registry (top-level config)
├── membership-lapse/                      ← example process subfolder
│   ├── process.gdoc                       ← step-by-step process doc
│   ├── 2026-03-11_14-22-run/              ← one subfolder per run (YYYY-MM-DD_HH-MM-run)
│   │   ├── log.gdoc                       ← what happened, who approved, timestamps
│   │   └── [artifacts]                    ← files generated or consumed in this run
│   └── 2026-03-18_09-05-run/
│       ├── log.gdoc
│       └── [artifacts]
└── <process-name>/                        ← one subfolder per workflow
    ├── process.gdoc
    └── [run subfolders...]
```

---

## Manifest Sheet

File: `manifest.gsheet` in the root of Agent Workspace.
One row per workflow. Columns:

| Column | Description |
|---|---|
| `process_name` | Human-readable name (e.g., "Membership Lapse Outreach") |
| `status` | `active`, `inactive`, `draft`, or `halt` |
| `mode` | `editing` or `running` |
| `gchat_channel_id` | Google Chat space ID where workflow updates are posted |
| `overwatcher_name` | Display name of the responsible human |
| `overwatcher_gchat_id` | Google Chat user ID for @-mentions |
| `process_folder_id` | Google Drive folder ID for this process's workspace subfolder |
| `doc_link` | URL to the process Google Doc |

**Status values:**
- `active` — process runs normally (on schedule or on demand)
- `inactive` — process exists but is disabled; the agent skips it and logs a note if triggered
- `draft` — process is being built; only runs in editing mode, never scheduled
- `halt` — emergency suspend; the agent refuses all invocations (scheduled or on-demand)
  and notifies the requesting user that the process is halted, until a human changes the status

The agent reads the manifest at the start of every workflow invocation to determine
status, mode, channel, overwatcher, and folder. If `status` is not `active`, the agent
aborts and notifies the requesting user.

---

## Process Doc Format

Each workflow has a `process.gdoc` in its subfolder. Standard sections:

1. **Purpose** — what this process does and why
2. **Data Sources** — descriptions of the artifacts this process uses, not static IDs.
   Each entry describes:
   - What the artifact is (e.g., "renewal report — a spreadsheet of members whose
     memberships are lapsing")
   - How it is obtained for each run. One of:
     - **Static** — a permanent file in Drive; referenced by name/location in the steps
     - **Provided** — the overwatcher or user supplies it at run time (e.g., uploads a
       file, pastes a link in chat, or drops a file in the process folder)
     - **Generated** — the agent produces it during the run (e.g., downloads a report,
       synthesizes data from other sources)
   - Where it lives during the run (e.g., "uploaded to the process folder by the
     overwatcher before the agent begins")
   Static files may include a Drive link for convenience, but the description is the
   canonical reference — steps should not depend on IDs that may change.
3. **Steps** — numbered steps with:
   - Action description
   - Whether this step is an overwatcher checkpoint (`[CHECKPOINT]`)
   - Expected output or artifact
4. **Email Templates** — draft text for any outgoing emails
5. **Decision Logic** — matching rules, thresholds, edge cases

The agent treats the process doc as the authoritative source of truth. In editing mode,
the agent updates the doc in real time. In running mode, the agent reads and follows it.

The process doc is never used for logging — it contains only the durable process
definition. All run history lives in run subfolders.

---

## Modes

### Editing Mode

Used when building or refining a workflow collaboratively.

- The human drives the work in the browser; the agent observes via Chrome DevTools
- After each step, the agent posts in the active thread:
  > "[Agent name]: I've recorded: [what just happened]. Next step in the doc is: [X].
  > Should I proceed, or do you want to change anything first?"
- If the human describes a change, the agent updates the process doc before moving on
- The agent does not take autonomous action — it narrates, records, and asks

**Threading rule (editing mode):**
All editing-session messages are posted as replies in a single thread, started when the
session begins. Thread opener:
> "Starting editing session for *[Process Name]*. I'll post updates here.
> Process doc: [link]"

### Running Mode

Used for autonomous workflow execution.

- The agent reads the manifest and process doc, then executes steps in order
- At each `[CHECKPOINT]` step, the agent pauses and posts to the overwatcher channel
- The agent does not proceed past a checkpoint until the overwatcher responds with approval
- Non-checkpoint steps execute silently; a summary is posted at the end of the run

**Threading rule (running mode — user-initiated):**
When a user requests that a process starts (via Google Chat message to the agent), the
agent replies in-thread to that message for all subsequent updates in that run. All status
updates, checkpoint requests, and the final summary are replies in that same thread.

**Threading rule (running mode — scheduled/proactive runs):**
When the agent initiates a run on a schedule (not triggered by a user message), it opens
a new thread in the configured `gchat_channel_id` for that process:
> "@[Overwatcher] I'm starting *[Process Name]*. I'll post updates here.
> Process doc: [link]"
All subsequent updates for that run are replies in that thread.

**Checkpoint message format:**
> "@[Overwatcher Name] — Checkpoint reached in *[Process Name]*
>
> **What I've done so far:** [summary]
> **What I'm about to do:** [next action]
> **Process doc:** [link]
>
> Reply 'yes' to proceed, or tell me to stop or change course."

---

## Run Folders and Logs

At the start of every run (editing or running mode), the agent creates a timestamped
subfolder inside the process folder: `YYYY-MM-DD_HH-MM-run/`. Inside it, the agent
creates `log.gdoc` and writes to it throughout the run:
- Run start time, mode, overwatcher
- Each step taken and its outcome
- Checkpoint decisions (who approved, what they said)
- Any artifacts generated (with Drive links)
- Run end time and final status

Any files generated or consumed during the run (exported CSVs, draft emails saved as
Docs, downloaded reports) are placed in the same run subfolder. This keeps each run
self-contained and auditable.

---

## Email Handling

- **First run (editing mode):** The agent generates draft email text and saves it to the
  process doc under "Email Templates." Drafts are also created in Gmail (as
  `AGENT_GOOGLE_ACCOUNT`) for review. No emails are sent.
- **Subsequent runs (running mode):** Sending emails is a `[CHECKPOINT]` step. The agent
  shows the overwatcher the recipient list and template before sending.
- **Sending:** The agent sends as `AGENT_GOOGLE_ACCOUNT` via `gws gmail` commands.

---

## `/gdrive-process` Skill

A single NanoClaw skill that handles all workflow interactions. Installed via the
standard NanoClaw skill installation process (configured once with the workspace folder
ID and OAuth credentials). Invoked via Google Chat:

```
/gdrive-process <process-name>
```

**Behavior by manifest state:**

| Manifest state | What the agent does |
|---|---|
| Process not found | Tells the user the manifest location and instructs them to add a row and create the process subfolder. Does nothing else. |
| `status=halt` | Notifies user the process is halted; no action taken until status changes. |
| `status=inactive` | Notifies user the process is inactive. |
| `status=draft`, `mode=editing` | Opens an editing session to build or refine the process doc. Human drives; agent records. |
| `status=active`, `mode=editing` | Opens an editing session to refine an existing process interactively. |
| `status=active`, `mode=running` | Executes the process autonomously, pausing at `[CHECKPOINT]` steps for overwatcher approval. |

**Process not found response:**
> "I don't see *[name]* in the manifest. The manifest is here: [link]. Add a row for
> *[name]* with `status=draft` and `mode=editing`, create a subfolder in the workspace,
> then try again and I'll help you build it out."

**Editing session flow:**
1. Agent reads the process doc (or notes it is blank if new)
2. Creates a run subfolder and log doc
3. Opens a thread: "Starting editing session for *[name]*. Process doc: [link]"
4. Human drives; agent records each step, updates the doc, and asks before proceeding
5. At session end, agent summarizes what was added/changed in the thread

**Running flow:**
1. Agent creates a run subfolder (`YYYY-MM-DD_HH-MM-run/`) and opens `log.gdoc`
2. Executes steps in order per the process doc
3. At each `[CHECKPOINT]`, posts to the overwatcher channel and waits for approval
4. All run updates are replies in the thread where `/gdrive-process` was invoked
   (or a new thread if invoked in main chat)
5. Final summary posted in the same thread with a link to the run folder

**Threading rule:**
All messages for a `/gdrive-process` invocation are replies in the thread where the
command was sent. If sent in main chat, the agent opens a new thread for that run.

---

## Technical Implementation

### gws CLI

`gws` (`@googleworkspace/cli`) is installed in the agent container via
`npm install -g @googleworkspace/cli` (added to `container/Dockerfile`). The OAuth
credentials for `AGENT_GOOGLE_ACCOUNT` are stored as a file mounted into the container
at startup (same pattern as other secrets in NanoClaw), referenced via the
`GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` environment variable.

### Container Skills

The relevant `gws-*` SKILL.md files from the googleworkspace/cli repo are added to the
container's skills directory, giving the agent Bash-invocable instructions for Drive,
Sheets, Docs, and Gmail operations.

The `/gdrive-process` skill (`gdrive-process.md`) is added to the container skills,
covering:
- How to read the manifest (status, mode, channel, overwatcher, folder)
- How to create and write to a run subfolder and log doc at run start
- Editing mode behavior and doc update protocol
- Running mode behavior and checkpoint protocol
- Threading rules for Google Chat messages
- Artifact naming conventions (files go in the run subfolder)

### Scheduling

Proactive (scheduled) workflow runs are configured via NanoClaw's existing task scheduler.
Each scheduled process reads the manifest to confirm `status=active` and `mode=running`
before executing — if the manifest shows `editing`, `draft`, `inactive`, or `halt`, the
scheduler skips that run and logs a note.

---

## Initial Workflows (Troop 606)

These are the first two processes to be built using the skill. Specific sheet column
names, IDs, and email templates will be determined during the first editing session for
each.

### 1. Membership Lapse Outreach

**Purpose:** Identify members whose renewals are lapsing and notify them and their
contacts before they are dropped.

**Data sources (TBD during editing session):**
- Provided: lapsing-membership report (spreadsheet of at-risk members)
- Static: member contact info sheet

**Process (high-level):**
1. Read lapsing-membership report → list of at-risk members
2. Read contact sheet → match by member name/ID
3. Identify members with complete contact info vs. missing info
4. `[CHECKPOINT]` — show overwatcher the matched list before proceeding
5. Generate emails to members and contacts using template
6. `[CHECKPOINT]` — show overwatcher draft emails + recipient list before sending
7. Send emails
8. Write run summary to log doc

### 2. Training Compliance Outreach

**Purpose:** Identify adults who have not completed mandatory training requirements and
send reminders.

**Data sources (TBD during editing session):**
- Provided or generated: training accomplishments report (per-adult completion data)
- Static: adult roster with contact info
- Static: mandatory training requirements doc

**Process (high-level):**
1. Read requirements doc → list of mandatory trainings
2. Read accomplishments report → per-adult completion status
3. Read adult roster → match contacts
4. Synthesize: list of adults missing one or more mandatory trainings
5. `[CHECKPOINT]` — show overwatcher the non-compliance list before proceeding
6. Generate reminder emails using template
7. `[CHECKPOINT]` — show overwatcher draft emails + recipient list before sending
8. Send emails
9. Write run summary to log doc

---

## Out of Scope (for this phase)

- Automatic creation of new workflow folders/docs (done manually or in editing session)
- Multi-agent parallel workflow execution
- Non-Gmail email providers
- Editing the manifest from within the agent (humans edit it in Drive)
