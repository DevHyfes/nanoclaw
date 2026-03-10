# Job Architecture

## Overview

Chiron shifts from a reactive chat bot to an **inbox-driven job manager**. New messages
are not immediately acted on — they are classified, assigned to a Job, and then the agent
processes jobs that need attention. A Job is the primary unit of work, persistence, and
context.

---

## Message Routing Pipeline

### Every incoming message
1. Write to DB (always, all channels, regardless of trigger)
2. Determine routing path:

| Source | Condition | Action |
|--------|-----------|--------|
| DM (authorized) | always | treated as triggered |
| Main chat | has `!<persona>` | run classifier |
| Main chat | no trigger | stored only — classifier reads it as context later |
| Watched thread | any message | attach to job → mark `needs_attention` |

### Trigger format
`!Chiron`, `!Grams`, `!Scout` — replaces `@mention`. The `!` prefix avoids activating
platform user selectors and supports multiple personas.

### After any routing event
Iterate through all jobs with status `needs_attention` and run the appropriate skill.

---

## The Classifier

A lightweight, **silent** agent that runs when a main-chat trigger fires or a DM arrives.

**Inputs:**
- The triggering message
- Last 20 messages from that chat (for context)
- List of open jobs with brief summaries

**Output (internal, never posted):**
- Assign message to an existing job, OR
- Create a new job with a proposed name, job type, and skill list
- Set status to `needs_attention`

**If insufficient information to classify:**
Creates a job with `job_type = "needs_info"`. The bot asks clarifying questions in a
thread off the triggering message. That thread becomes the job's first watched thread.
As the conversation develops, the agent promotes the job to a proper job type.

**The reply thread rule:**
When the classifier (or job agent) first responds, it replies in a thread off the
triggering message. That thread is immediately registered as a watched thread for the
job. All future replies in that thread auto-route to the job — no trigger needed.

---

## Job Object

```typescript
interface Job {
  id: string;
  name: string;                    // "Spring Campout Planning"
  job_type: string;                // "needs_info" | "general_task" | "campout_planning" | ...
  skills: string[];                // ["job-campout-planning", "job-handling"] — array, multiple skills
  persona: string;                 // which persona handles this job
  status: JobStatus;
  watched_threads: string[];       // JIDs — messages here auto-route to this job
  participants: string[];          // user IDs involved
  context: string;                 // persistent markdown: decisions made, open questions, next steps
  inbox: JobMessage[];             // unprocessed messages, cleared after agent processes
  metadata: Record<string, any>;   // skill-specific state
  next_action: string | null;      // what the agent intends to do or is waiting for
  follow_up_at: string | null;     // ISO timestamp: when to next check in if nothing has happened
  created_at: string;
  updated_at: string;
}
```

### Status Definitions

| Status | Meaning | Who sets it |
|--------|---------|------------|
| `needs_attention` | Agent should process this job. Set whenever action is needed. | Routing pipeline, timers, external events |
| `in_progress` | Users are doing work; agent is waiting on them. Follow up if silent too long. | Agent, after responding |
| `blocked` | Users cannot continue. Agent actively follows up, tries to find someone who can help. | Agent |
| `complete` | Work is done. Job is still "warm" — visible, referenceable, could receive follow-ups. | Agent or human |
| `archived` | Cold storage. Hidden from active lists. Classifier will not match new messages to it. | Human |

**Complete vs Archived:** Complete means recently finished and still live. Archived means
explicitly dismissed — it will never surface again unless manually retrieved.

**`needs_attention` is the universal trigger.** It can be set by:
- The routing/classifying pipeline (new message arrived)
- A follow-up timer (`follow_up_at` timestamp reached)
- Any future external event (webhook, scheduled task, etc.)

### Job Types

Job type is distinct from status. It determines which skills are applied and informs
persona affinity. Built-in types:

| Type | Description |
|------|-------------|
| `needs_info` | Insufficient context to classify — bot asks clarifying questions |
| `general_task` | Catch-all for tasks that don't fit a specialized type |
| `campout_planning` | Guided by `/job-campout-planning` skill |
| _(more added as skills are created)_ | |

Job type can be promoted as context accumulates (e.g., `needs_info` → `campout_planning`).

---

## Skills

### `/job-handling`
The base skill that all job agents follow. Defines:
- Status transition rules (when to move from `in_progress` to `blocked`, etc.)
- When the agent is **obligated to respond** vs when it should **stay silent**
- Follow-up cadence for `in_progress` and `blocked` jobs
- How to handle off-topic messages in a watched thread (forward to main chat, create new job)
- Escalation etiquette

### Specialized job skills (examples)
- `/job-campout-planning` — agenda building, RSVP tracking, permission slips, equipment lists
- `/job-merit-badge` — per-scout per-badge progress tracking
- `/job-meeting-planning` — agenda, action items, minutes

Multiple skills can be applied to a single job (`skills` is an array).

---

## Persona → Skill Affinity

Defined in the main agent CLAUDE.md (or equivalent global config). Format:

```markdown
## Personas and Skills

| Persona | Skills |
|---------|--------|
| Chiron  | job-handling, job-campout-planning, job-meeting-planning |
| Grams   | job-merit-badge, job-handling |
| Scout   | general_task, job-handling |
```

The classifier assigns a `job_type` and initial `skills[]`. The persona with the
strongest affinity for those skills is assigned to the job.

---

## Manage-Jobs Sweep

After any routing event (new trigger or watched-thread message), the infrastructure
iterates all `needs_attention` jobs and runs each one's assigned skill.

Additionally, once per hour, the same sweep runs as a backstop — catching any jobs
that were missed, follow-up timers that fired, or `in_progress` jobs that have gone
silent.

---

## Thread Ownership Rule

**A thread can be associated with at most one Job.**

If the agent detects that a message in a watched thread is unrelated to the job, it:
1. Responds in the thread redirecting the conversation
2. Forwards the message to the main chat as a new trigger
3. The classifier handles it as a new item from there

---

## DM Rules

- DMs are always treated as triggered (the `!persona` is implied)
- DMs must be explicitly authorized by the administrator before routing is active
- Unauthorized DMs are stored in DB but not classified or acted on

---

## What Is Not Designed Yet

- **Job creation UI**: how a human explicitly creates a job (vs classifier inferring one)
- **Job dashboard**: how to view/manage jobs from outside the chat
- **Sub-jobs / parent-child hierarchy**: flat for now
- **Multi-agent parallelism**: one job processed at a time for now
- **Skill authoring guide**: how to write a new job skill
- **`/job-campout-planning` and other specialized skills**: content TBD
