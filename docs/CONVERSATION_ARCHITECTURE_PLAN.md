# Conversation-Aware Architecture Plan

## Overview

Shift nanoclaw from a **reactive** model (respond to each message immediately) to a
**deliberative** model (understand the landscape, sort into conversations, then decide
what needs attention). This enables proper context management, cross-thread continuity,
offline catch-up, privacy-aware cross-space references, and scheduled followups.

---

## Core Concepts

### Messages
Raw chat data. One row per message per conversation thread. Identified by a **numeric
timestamp ID** (e.g., `1772862943193823`) which is unique per message globally and
used as the deduplication key. Thread membership is encoded in `chat_jid`:
- `gchat:SPACEID` — main chat message (also the root of a potential thread)
- `gchat:SPACEID:thread:ALPHAID` — a reply within a specific thread

### Conversations
AI-derived groupings of messages with intent and plan metadata. A conversation is a
purpose-driven exchange — it may span multiple threads or even multiple spaces.
Conversations have an array of **involved personas** so the action agent knows which
AI identities are relevant to the exchange.

### Privacy Model
DM conversations may *reference* public conversations (so the AI can see the full
picture when working in the DM). Public conversations never include the content of
conversations that reference them — only the reference title and relationship are
visible from the public side.

---

## Database Schema Additions

### `conversations`
```sql
CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,   -- UUID
  title       TEXT,               -- AI-derived short title
  status      TEXT DEFAULT 'active', -- active | resolved | watching
  notes       TEXT,               -- AI-derived intent/plan notes
  personas    TEXT,               -- JSON array of persona IDs e.g. ["chiron","scout_leader"]
  last_activity TEXT,             -- ISO timestamp of most recent message
  created_at  TEXT
);
```

### `conversation_messages`
```sql
CREATE TABLE conversation_messages (
  conversation_id TEXT,
  message_id      TEXT,
  chat_jid        TEXT,
  PRIMARY KEY (conversation_id, message_id, chat_jid),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (message_id, chat_jid) REFERENCES messages(id, chat_jid)
);
```

### `conversation_references`
Links conversations without exposing private message content across privacy boundaries.
```sql
CREATE TABLE conversation_references (
  referencing_conversation_id TEXT,
  referenced_conversation_id  TEXT,
  relationship                TEXT, -- 'regarding' | 'spawned_from' | 'related'
  PRIMARY KEY (referencing_conversation_id, referenced_conversation_id)
);
```

### `conversation_followups`
Drives scheduled check-ins and reminders the AI commits to.
```sql
CREATE TABLE conversation_followups (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT,
  scheduled_for   TEXT,              -- ISO timestamp
  reason          TEXT,              -- why the AI wants to follow up
  status          TEXT DEFAULT 'pending', -- pending | done | cancelled
  created_at      TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
```

---

## Implementation Phases

### Phase 1 — API-based message ingestion
**Goal:** Chiron reliably sees every message. No DOM parsing.
**No AI required. Fully testable by logging in as Chiron.**

- Intercept WebChannel responses via `page.on('response', ...)` instead of polling DOM
- Parse type-20 "new message" events from the JSON stream
- Store messages: numeric ID, correct thread JID, sender user ID, `is_bot_message` flag
- **Startup catch-up:** call `list_topics` for each registered space using the last DB
  timestamp as the "since" cursor — recovers all messages missed while offline
- **Thread history fetch:** when a thread JID is seen for the first time, call
  `list_topics` filtered to that thread to backfill full history before processing

**Test:** Send messages across main chat, threads, and old threads. Verify DB has every
message exactly once, correct JID, correct sender, no duplicates.

---

### Phase 2 — API-based sending
**Goal:** Chiron sends reliably. No DOM keyboard simulation.
**No AI required. Testable via manual trigger.**

- Replace `sendMessage()` with `page.evaluate(() => fetch('/u/0/api/create_message', ...))`
- Replace `sendThreadReply()` with same — thread root alphanumeric ID parsed from JID
- Extract XSRF token from page at startup; refresh on 401
- Track sent message numeric IDs in memory so incoming WebChannel echoes are immediately
  marked `is_bot_message = 1`

**Test:** Trigger a reply manually. Verify it lands in the correct thread (not main chat).
Verify no echo loop.

---

### Phase 3 — Conversation schema
**Goal:** Database is ready for AI-managed conversations.
**No AI required. Just migration + verification.**

Add the four tables above: `conversations`, `conversation_messages`,
`conversation_references`, `conversation_followups`.

**Test:** Manually insert records. Verify foreign keys, indexes, and the privacy model
(a DM conversation can reference a public one; the public side only sees the reference
title, not the DM messages).

---

### Phase 4 — AI triage agent
**Goal:** Chiron sorts incoming messages into conversations. Does not respond yet.

When new messages arrive, run a triage agent before the response agent. The triage
agent receives:
- The new messages (sender, thread JID, content, timestamp)
- Existing active conversations for this space (titles, statuses, involved personas)

The triage agent's responsibilities:
- Assign each message to an existing conversation or create a new one
- Assign relevant personas to the conversation (`personas` array)
- Set `followup_needed` true/false with a reason note
- Optionally schedule a followup in `conversation_followups`

The triage agent has **no send tool** — it cannot reply, only classify.

**Test:** Messages arrive, verify `conversations` and `conversation_messages` tables
reflect sensible groupings. Chiron stays completely silent.

---

### Phase 5 — AI action agent
**Goal:** Chiron responds based on conversation state, not raw message queue.
**Replaces the current direct message→response loop.**

After triage, iterate over conversations where `followup_needed = true`:
- Build context: conversation messages + referenced conversation titles (not content)
  + relevant persona instructions
- Run the action agent — it can reply, wait, mark resolved, or schedule a followup
- Skip conversations where the most recent message is already from Chiron

**Test:** Chiron responds to a direct question. Chiron stays silent when scouts are
resolving something on their own. Chiron follows up when a question was asked but
not answered.

---

### Phase 6 — Scheduled followups
**Goal:** Chiron keeps commitments made in conversations.

Extend the existing task scheduler to also check:
```sql
SELECT * FROM conversation_followups
WHERE status = 'pending' AND scheduled_for <= datetime('now')
```

When due, run the action agent with the conversation context and `reason` as the trigger.

**Test:** Triage agent schedules a followup 2 minutes out. Verify Chiron posts at the
right time in the right thread.

---

### Phase 7 — Cross-space conversation references
**Goal:** Private context stays private; Chiron can connect related conversations.

When the triage agent creates a DM conversation about a topic discussed publicly, it
adds a `conversation_references` record. When building action agent context for the
public conversation, referenced conversations contribute only their title and
relationship type — never their messages.

**Test:** A parent DMs Chiron about a child's medication. Verify the medication message
never appears in the action agent's context when responding in the public campout thread.

---

## Message ID Notes

| Format | Example | Where used |
|--------|---------|-----------|
| Numeric (microsecond timestamp) | `1772862943193823` | DB `id` column, dedup key, API cursors |
| Alphanumeric (base64-like) | `JzA5rc2FagU` | Thread root reference in `create_message` API, encoded in `chat_jid` |

The alphanumeric thread root ID is embedded in the `chat_jid`
(`gchat:SPACEID:thread:ALPHAID`), so no separate column is needed. Sending a thread
reply just parses the ID out of the JID.

## Deduplication

Primary key on `messages` is `(id, chat_jid)`. The same message arriving from multiple
surfaces (Home feed, Mentions, Space view, WebChannel) will always have the same numeric
ID and same thread JID — `INSERT OR IGNORE` silently discards duplicates.

Bot echo prevention: when `create_message` returns, the new message's numeric ID is
added to an in-memory `sentMessageIds` set. Any WebChannel event carrying that ID is
stored with `is_bot_message = 1` and excluded from the action agent's input.

## Current Status

- Phase 1 and 2: **Not yet started** (blocked on switching from DOM to API approach)
- Phases 3–7: **Design complete, not yet implemented**
- nanoclaw is currently **stopped** pending Phase 1 implementation
