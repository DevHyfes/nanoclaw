import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from '../config.js';
import { getLastMessageTimestamp, getKnownSenderNames, storeChatMetadata, storeMessageDirect, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import { makeThreadJid } from '../thread-jid.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const AUTH_DIR = path.join(STORE_DIR, 'google-chat-browser');
const USER_DATA_DIR = path.join(AUTH_DIR, 'user-data');
const AUTH_PATH = path.join(AUTH_DIR, 'auth.json');
const BOT_USER_ID_PATH = path.join(AUTH_DIR, 'bot-user-id.txt');
const POLL_INTERVAL_MS = 5000;
const CHAT_BASE = 'https://chat.google.com';
const HOME_URL = `${CHAT_BASE}/app/home`;
const PAGE_LOAD_WAIT_MS = 8000;
// How far back to catch up when no prior DB timestamp exists (microseconds)
const DEFAULT_LOOKBACK_MICROS = 24 * 60 * 60 * 1000 * 1000; // 24 hours

// DOM selectors — kept for DOM-based sending only (Phase 2 will remove these)
const SELECTORS = {
  // Main chat input — scoped to c-wiz without a data-topic-id (not a thread pane)
  messageInput: 'c-wiz:not([data-topic-id]) [jsname="yrriRe"][contenteditable="true"]',
  // Thread reply input — scoped to the specific thread's c-wiz by topic ID
  threadInput: (topicId: string) =>
    `c-wiz[data-topic-id="${topicId}"] [jsname="yrriRe"][contenteditable="true"]`,
  spaceName: '.njhDLd',
  messageItem: '.B8q9Gf.qnQFwb',
};

// ─── Pure helper functions ────────────────────────────────────────────────────

function nowMicros(): number {
  return Date.now() * 1000;
}

function isoToMicros(iso: string): number {
  return new Date(iso).getTime() * 1000;
}

function microsToIso(micros: number | string): string {
  const n = typeof micros === 'string' ? parseInt(micros, 10) : micros;
  return new Date(n / 1000).toISOString();
}

/**
 * Build the space reference array used in list_topics request body[7].
 * Space format:  [["SPACEID"]]
 * DM format:     [null, null, ["DMID"]]   (no outer array for DMs)
 */
function buildSpaceRef(spaceId: string, isDm: boolean): any[] {
  return isDm ? [null, null, [spaceId]] : [[spaceId]];
}

/**
 * Build the inline thread space ref used inside thread references.
 * Space: [["SPACEID"]]   DM: [null, null, ["DMID"]]
 */
function buildInlineSpaceRef(spaceId: string, isDm: boolean): any[] {
  return isDm ? [null, null, [spaceId]] : [[spaceId]];
}

/**
 * Build a list_topics request body for all recent messages in a space.
 * `since` is a microsecond timestamp — only messages created after this are returned.
 */
function buildListTopicsBody(spaceRef: any[], since: number): any[] {
  const body: any[] = new Array(100).fill(null);
  body[1] = 50;
  body[3] = [since];
  body[4] = [3, 1, 4];
  body[5] = 1000;
  body[6] = 50;
  body[7] = spaceRef;
  body[8] = [nowMicros()];
  body[9] = [since];
  body[10] = 2;
  return body;
}

/**
 * Build a list_topics request body filtered to a specific thread.
 * Used to back-fill history of a thread we haven't seen before.
 */
function buildThreadListTopicsBody(
  spaceRef: any[],
  spaceId: string,
  isDm: boolean,
  threadAlphaId: string,
  since: number,
): any[] {
  const body: any[] = new Array(100).fill(null);
  const inlineRef = buildInlineSpaceRef(spaceId, isDm);
  body[1] = 50;
  body[3] = [null, null, [[[null, threadAlphaId, inlineRef]]]];
  body[4] = [3, 1, 4];
  body[5] = 1000;
  body[6] = 50;
  body[7] = spaceRef;
  body[8] = [nowMicros()];
  body[9] = since ? [since] : null;
  body[10] = 2;
  return body;
}

interface ParsedMsg {
  msgId: string;         // numeric string, e.g. "1772862943193823"
  msgAlphaId: string;    // this message's own alphanumeric ID (unique per message)
  threadAlphaId: string; // thread ROOT alpha ID (= msgAlphaId when this IS the root)
  isThreadRoot: boolean; // true when msgAlphaId === threadAlphaId
  spaceId: string;
  isDm: boolean;
  senderUserId: string;
  senderName: string;
  text: string;
  timestamp: string;    // ISO derived from msgId
}

/**
 * Extract the thread alpha ID and space info from a thread ref array.
 * Handles two formats observed in the HAR:
 *   3-element: [null, "alphaId", [spaceRef]]
 *   4-element: [null, null, null, [null, "alphaId", [spaceRef]]]
 */
function extractThreadInfo(
  ref: any[],
): { alphaId: string; spaceId: string; isDm: boolean } | null {
  if (!Array.isArray(ref)) return null;

  // 3-element: [null, "alphaId", [spaceRef]]
  if (ref.length >= 3 && typeof ref[1] === 'string' && Array.isArray(ref[2])) {
    return resolveSpaceRef(ref[1], ref[2]);
  }

  // 4-element: [null, null, null, [null, "alphaId", [spaceRef]]]
  if (ref.length >= 4 && Array.isArray(ref[3])) {
    const inner = ref[3];
    if (typeof inner[1] === 'string' && Array.isArray(inner[2])) {
      return resolveSpaceRef(inner[1], inner[2]);
    }
  }

  return null;
}

function resolveSpaceRef(
  alphaId: string,
  spaceRef: any[],
): { alphaId: string; spaceId: string; isDm: boolean } {
  // Space: [["SPACEID"]]   DM: [null, null, ["DMID"]]
  if (Array.isArray(spaceRef[0])) {
    return { alphaId, spaceId: spaceRef[0][0] ?? '', isDm: false };
  }
  return { alphaId, spaceId: spaceRef[2]?.[0] ?? '', isDm: true };
}

/**
 * Parse a Google BrowserChannel (WebChannel VER=8) response body into individual
 * events. Format: <length>\n<json>[<length>\n<json>...]
 * Each json chunk is [[seqno, data], ...].
 * Returns array of [seqno, data] pairs.
 */
function parseBrowserChannelBody(body: string): Array<[number, any]> {
  const events: Array<[number, any]> = [];
  let i = 0;
  while (i < body.length) {
    const nl = body.indexOf('\n', i);
    if (nl === -1) break;
    const lenStr = body.slice(i, nl).trim();
    const len = parseInt(lenStr, 10);
    if (isNaN(len) || len <= 0) { i = nl + 1; continue; }
    const start = nl + 1;
    const end = start + len;
    if (end > body.length) break;
    const chunk = body.slice(start, end);
    try {
      const parsed = JSON.parse(chunk);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (Array.isArray(item) && item.length >= 2) {
            events.push([item[0] as number, item[1]]);
          }
        }
      }
    } catch { /* skip malformed chunks */ }
    // Next chunk starts immediately after the JSON bytes (no separator)
    i = end;
  }
  return events;
}

/**
 * Extract new messages from a single WebChannel event (one [seqno, data] pair).
 *
 * Room event layout:
 *   data[0][0]    = room array
 *   roomArr[0]    = space ref: [null,null,["spaceId"]] for DM  or [["spaceId"]] for Space
 *   roomArr[7]    = array of inner events
 *
 * Inner event type-6 (new message content):
 *   innerEvt[11]  === 6
 *   innerEvt[5]   = [msgData, null, null, "0", "0", 1, 1]
 *   msgData[0]    = [threadRef4Elem, alphaId]  → alphaId at [1]
 *   msgData[1]    = [["userId"]]
 *   msgData[2]    = numeric message ID string
 *   msgData[9]    = message text
 */
function extractWebChannelMessages(data: any): ParsedMsg[] {
  const results: ParsedMsg[] = [];

  // data[0][0] = room array (type-6 room events have 3 levels of wrapping)
  if (!Array.isArray(data) || !Array.isArray(data[0]) || !Array.isArray(data[0][0])) return results;
  const roomArr = data[0][0];

  // Space ref at roomArr[0]
  const spaceRef = roomArr[0];
  if (!Array.isArray(spaceRef)) return results;

  let spaceId: string;
  let isDm: boolean;

  // DM: [null, null, ["spaceId"]]
  if (spaceRef[0] === null && Array.isArray(spaceRef[2]) && typeof spaceRef[2][0] === 'string') {
    spaceId = spaceRef[2][0];
    isDm = true;
  }
  // Space: [["spaceId"]]
  else if (Array.isArray(spaceRef[0]) && typeof spaceRef[0][0] === 'string') {
    spaceId = spaceRef[0][0];
    isDm = false;
  }
  else {
    return results;
  }

  if (!spaceId) return results;

  // Inner events at roomArr[7]
  const innerEvents = roomArr[7];
  if (!Array.isArray(innerEvents)) return results;

  for (const innerEvt of innerEvents) {
    if (!Array.isArray(innerEvt) || innerEvt.length < 12) continue;
    if (innerEvt[11] !== 6) continue; // only type-6 = new message content

    const msgContent = innerEvt[5];
    if (!Array.isArray(msgContent) || !Array.isArray(msgContent[0])) continue;

    const msgData = msgContent[0];
    if (!Array.isArray(msgData) || msgData.length < 10) continue;

    // msgData[0] = [threadRef4Elem, msgOwnAlphaId]
    //   threadRef4Elem: [null,null,null,[null,"THREAD_ROOT_ALPHA_ID",spaceRef]]
    //   msgOwnAlphaId:  this message's own unique alpha ID
    const threadRefPair = msgData[0];
    if (!Array.isArray(threadRefPair)) continue;
    // Message's own alpha ID — unique per message
    const msgAlphaId = typeof threadRefPair[1] === 'string' ? threadRefPair[1] : '';
    // Thread ROOT alpha ID — from the 4-element ref inside threadRefPair[0]
    const threadRootInfo = Array.isArray(threadRefPair[0])
      ? extractThreadInfo(threadRefPair[0])
      : null;
    const threadAlphaId = threadRootInfo?.alphaId ?? msgAlphaId;
    if (!threadAlphaId) continue;

    // Sender: msgData[1] = [["userId"]]
    const senderArr = msgData[1];
    const senderUserId =
      Array.isArray(senderArr) && Array.isArray(senderArr[0]) ? (senderArr[0][0] ?? '') : '';

    // Message ID: msgData[2]
    const rawMsgId = typeof msgData[2] === 'string' ? msgData[2] : '';
    if (!rawMsgId || !/^\d{14,19}$/.test(rawMsgId)) continue;

    // Text: msgData[9]
    const text = typeof msgData[9] === 'string' ? msgData[9].trim() : '';
    if (!text) continue;

    results.push({
      msgId: rawMsgId,
      msgAlphaId,
      threadAlphaId,
      isThreadRoot: msgAlphaId === threadAlphaId,
      spaceId,
      isDm,
      senderUserId,
      senderName: '',
      text,
      timestamp: microsToIso(parseInt(rawMsgId, 10)),
    });
  }

  return results;
}

/**
 * Extract sender display names from type-12 inner events (the "full" version of a
 * new message event that includes the sender's display name and photo).
 *
 * type-12 inner event layout:
 *   innerEvt[11]   === 12
 *   innerEvt[9]    = [[[msgData, senderName, photoUrl, null, 3], 2, null, [2]], null, 12]
 *   msgData[2]     = numeric message ID
 *
 * Returns a Map from msgId → senderName.
 */
function extractWebChannelSenderNames(data: any): Map<string, string> {
  const names = new Map<string, string>();
  if (!Array.isArray(data) || !Array.isArray(data[0]) || !Array.isArray(data[0][0])) return names;
  const roomArr = data[0][0];
  const innerEvents = roomArr[7];
  if (!Array.isArray(innerEvents)) return names;

  for (const innerEvt of innerEvents) {
    if (!Array.isArray(innerEvt) || innerEvt.length < 12) continue;
    if (innerEvt[11] !== 12) continue;

    // Historical batch replays: innerEvt[9] = [[[MSG_DATA, senderName, photo, null, 3], 2, null, [2]], null, 12]
    // Live real-time events: innerEvt[9] = [[MSG_DATA]] — no sender name
    const content = innerEvt[9];
    if (!Array.isArray(content) || !Array.isArray(content[0])) continue;
    const msgWithMetaOuter = content[0];
    if (!Array.isArray(msgWithMetaOuter[0])) continue;
    const msgWithMeta = msgWithMetaOuter[0];
    // Historical format has [MSG_DATA, senderName, photo, ...]; live format has MSG_DATA directly
    const msgData = msgWithMeta[0];
    const senderName = typeof msgWithMeta[1] === 'string' ? msgWithMeta[1] : '';
    if (!senderName || !Array.isArray(msgData)) continue;
    const msgId = typeof msgData[2] === 'string' ? msgData[2] : '';
    if (!msgId || !/^\d{14,19}$/.test(msgId)) continue;
    names.set(msgId, senderName);
  }
  return names;
}

/**
 * Extract message IDs from participant delta records in a list_topics response.
 *
 * data[0][6][1] contains participant "last activity" records with format:
 *   [null, lastMsgId, userProfile]
 *
 * These tell us the ID of the last message in threads that had activity since
 * the cursor. When a NEW thread (created after cursor) contains messages, those
 * messages do NOT appear in data[0][1] — only the participant record appears.
 * We use these IDs to detect new messages and trigger a secondary fetch.
 *
 * Returns numeric message IDs that are strictly greater than currentCursor.
 */
function extractDeltaNewMsgIds(raw: any, currentCursor: string): string[] {
  if (!Array.isArray(raw) || !Array.isArray(raw[0])) return [];
  const header = raw[0];
  if (header[0] !== 'dfe.t.lt') return [];
  if (!Array.isArray(header[6]) || !Array.isArray(header[6][1])) return [];

  const result: string[] = [];
  for (const entry of header[6][1]) {
    // Participant record: [null, lastMsgId, userProfile]
    if (!Array.isArray(entry) || typeof entry[1] !== 'string') continue;
    const msgId = entry[1];
    if (!/^\d{14,19}$/.test(msgId)) continue;
    if (!currentCursor || BigInt(msgId) > BigInt(currentCursor)) {
      result.push(msgId);
    }
  }
  return result;
}

/**
 * Parse messages out of a list_topics JSON response.
 *
 * Response layout (header = raw[0]):
 *   header[0] = 'dfe.t.lt'
 *   header[1] = historical topics array (null when there are no historical topics)
 *   header[2] = next-cursor array (e.g. [1772924598268607])
 *   header[3] = prev-cursor array
 *   header[6] = [something, [participantRecords...]]  ← delta: participant last-activity
 *
 * Note: header[6][1] contains participant metadata, NOT message content. New message
 * content for threads created after the cursor is fetched via a secondary call.
 *
 * Returns parsed messages, the max numeric message ID seen in the raw response,
 * AND the API-provided next cursor (header[2][0]) for the subsequent poll.
 */
function parseListTopicsMessages(raw: any): { msgs: ParsedMsg[]; maxRawMsgId: string; apiNextCursor: string; userNames: Map<string, string> } {
  const empty = { msgs: [], maxRawMsgId: '', apiNextCursor: '', userNames: new Map<string, string>() };
  if (!Array.isArray(raw) || !Array.isArray(raw[0])) return empty;
  const header = raw[0];
  if (header[0] !== 'dfe.t.lt') return empty;

  // Only parse historical topics from header[1].
  // header[6][1] contains participant metadata (not message content) — handled separately
  // via extractDeltaNewMsgIds + secondary fetch.
  if (!Array.isArray(header[1])) return empty;
  const topicsArray = header[1];

  // API-provided cursor for the next poll (header[2][0])
  const apiNextCursor =
    Array.isArray(header[2]) && typeof header[2][0] === 'string' && /^\d{14,19}$/.test(header[2][0])
      ? header[2][0]
      : '';

  const results: ParsedMsg[] = [];
  const userNames = new Map<string, string>();
  let maxRawMsgId = '';

  for (const topic of topicsArray) {
    if (!Array.isArray(topic)) continue;

    // topic[0] = thread ref (3 or 4-element format)
    const topicThreadInfo = extractThreadInfo(topic[0]);

    // topic[6] = messages array
    const messagesArr = topic[6];
    if (!Array.isArray(messagesArr)) continue;

    for (const msg of messagesArr) {
      if (!Array.isArray(msg) || msg.length < 10) continue;

      // msg[2] = numeric message ID — track max across ALL messages for cursor advance
      const rawMsgId = typeof msg[2] === 'string' ? msg[2] : '';
      if (rawMsgId && /^\d{14,19}$/.test(rawMsgId)) {
        if (!maxRawMsgId || BigInt(rawMsgId) > BigInt(maxRawMsgId)) {
          maxRawMsgId = rawMsgId;
        }
      }

      // msg[0] = [4-element-threadRef, msgOwnAlphaId]
      //   4-element-threadRef: [null,null,null,[null,"THREAD_ROOT_ALPHA_ID",spaceRef]]
      //   msgOwnAlphaId: this message's own unique alpha ID
      const msgThreadRef = msg[0];
      let threadAlphaId = topicThreadInfo?.alphaId ?? '';
      let spaceId = topicThreadInfo?.spaceId ?? '';
      let isDm = topicThreadInfo?.isDm ?? false;

      // Message's own alpha ID at msgThreadRef[1]
      // Fallback: if msg[0] is wrapped one level deeper, try msgThreadRef[0][1]
      const msgAlphaId: string =
        (typeof msgThreadRef?.[1] === 'string' ? msgThreadRef[1] : null) ??
        (typeof msgThreadRef?.[0]?.[1] === 'string' ? msgThreadRef[0][1] : null) ??
        '';

      // If topicThreadInfo didn't give us space info, extract from the 4-element ref
      if ((!spaceId || !threadAlphaId) && Array.isArray(msgThreadRef)) {
        // Try msgThreadRef[0] as the 4-element ref, then msgThreadRef[0][0]
        const ref4 = Array.isArray(msgThreadRef[0]) && Array.isArray(msgThreadRef[0][0])
          ? msgThreadRef[0][0]
          : msgThreadRef[0];
        const inner = extractThreadInfo(ref4);
        if (inner) {
          if (!threadAlphaId) threadAlphaId = inner.alphaId;
          if (!spaceId) { spaceId = inner.spaceId; isDm = inner.isDm; }
        }
      }

      // msg[1] = sender: [["USER_ID", "Name", ...], ...] or [["USER_ID"], "Name", ...]
      const senderInfo = msg[1];
      let senderUserId = '';
      let senderName = '';
      if (Array.isArray(senderInfo)) {
        if (Array.isArray(senderInfo[0])) {
          senderUserId = senderInfo[0][0] ?? '';
        }
        if (typeof senderInfo[1] === 'string') {
          senderName = senderInfo[1];
        }
      }
      // Accumulate userId → displayName discoveries for the caller's cache
      if (senderUserId && senderName) userNames.set(senderUserId, senderName);

      const msgId = rawMsgId;
      if (!msgId) continue;

      // msg[9] = message text
      const text = typeof msg[9] === 'string' ? msg[9].trim() : '';
      if (!text || !spaceId || !threadAlphaId) continue;

      results.push({
        msgId,
        msgAlphaId,
        threadAlphaId,
        isThreadRoot: !!msgAlphaId && msgAlphaId === threadAlphaId,
        spaceId,
        isDm,
        senderUserId,
        senderName,
        text,
        timestamp: microsToIso(parseInt(msgId, 10)),
      });
    }
  }

  return { msgs: results, maxRawMsgId, apiNextCursor, userNames };
}

// ─── Channel class ────────────────────────────────────────────────────────────

export interface GoogleChatBrowserChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class GoogleChatBrowserChannel implements Channel {
  name = 'google_chat_browser';

  private context: BrowserContext | null = null;
  // One page kept open for XSRF token capture; also used as fallback for DOM ops
  private homePage: Page | null = null;
  // Pages opened lazily for DOM-based sending (Phase 2 will remove these)
  private pages = new Map<string, Page>();
  private _connected = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private sending = false;

  private accountIndex = '0';
  private xsrfToken = '';
  private botUserId = '';
  private botDisplayName = '';
  // XSRF tokens expire; reload the home page every 20 minutes to refresh
  private lastTokenRefresh = Date.now();
  private static TOKEN_REFRESH_INTERVAL_MS = 20 * 60 * 1000;

  // last numeric message ID seen per JID (gchat:SPACEID or gchat:SPACEID:thread:ALPHA)
  private lastSeenMsgIds = new Map<string, string>();
  // numeric IDs of messages we sent — skip when seen in poll results
  private sentMsgIds = new Set<string>();
  // numeric IDs delivered via WebChannel real-time — prevent poll double-delivery
  private webChannelDeliveredIds = new Set<string>();
  // userId → displayName cache — populated from list_topics and DB; consulted for WebChannel messages
  private userNameCache = new Map<string, string>();
  // cached format per space ID
  private spaceFormats = new Map<string, 'space' | 'dm'>();
  // thread JIDs we've already back-filled history for
  private threadHistoryFetched = new Set<string>();

  private opts: GoogleChatBrowserChannelOpts;

  constructor(opts: GoogleChatBrowserChannelOpts) {
    this.opts = opts;
  }

  // ── Public interface ──────────────────────────────────────────────────────

  async connect(): Promise<void> {
    logger.info({ userDataDir: USER_DATA_DIR }, 'Google Chat Browser: launching');
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });

    // Remove stale lock file
    const lockFile = path.join(USER_DATA_DIR, 'SingletonLock');
    if (fs.existsSync(lockFile)) {
      try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
    }

    this.context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: true,
    });

    // Capture XSRF token from every outgoing request automatically
    this.context.on('request', (req) => {
      const tok = req.headers()['x-framework-xsrf-token'];
      if (tok) this.xsrfToken = tok;
    });

    // Intercept WebChannel responses for real-time (sub-second) message delivery.
    // This fires for each completed HTTP response to /webchannel/events, which is
    // the BrowserChannel VER=8 long-polling transport Google Chat uses.
    this.context.on('response', async (response) => {
      try {
        const url = response.url();
        if (!url.includes('/webchannel/events') || !url.includes('VER=8')) return;
        const body = await response.text().catch(() => '');
        if (!body) return;
        const chunkEvents = parseBrowserChannelBody(body);

        // First pass: collect sender names from type-12 events (they arrive in the
        // same response as type-6 events and carry the display name).
        const senderNames = new Map<string, string>();
        for (const [, data] of chunkEvents) {
          for (const [msgId, name] of extractWebChannelSenderNames(data)) {
            senderNames.set(msgId, name);
          }
        }
        // Second pass: deliver messages, filling in sender names where available.
        for (const [, data] of chunkEvents) {
          const msgs = extractWebChannelMessages(data);
          for (const msg of msgs) {
            if (!msg.senderName && senderNames.has(msg.msgId)) {
              msg.senderName = senderNames.get(msg.msgId)!;
            }
            await this.handleRealtimeMessage(msg);
          }
        }
      } catch (err) {
        logger.debug({ err }, 'Google Chat Browser: WebChannel intercept error');
      }
    });

    // Intercept create_message and create_topic HTTP responses to immediately seed
    // the DB with the bot's outbound message, so the agent context is up-to-date
    // without waiting ~60s for WebChannel loop-back.
    //
    // create_message response: [["dfe.m.cm", MSG], ...]  → msg = data[0][1]
    // create_topic   response: [["dfe.t.ct", TOPIC], ...] → msg = data[0][1][6][0]
    // In both cases: msg[2]=msgId, msg[9]=text, msg[1][0][0]=senderUserId,
    //                msg[0][0][3][1]=threadAlphaId, msg[0][0][3][2]=spaceRef
    this.context.on('response', async (response) => {
      try {
        const url = response.url();
        const isSend = url.includes('/api/create_message') || url.includes('/api/create_topic');
        if (!isSend) return;
        logger.info({ url: url.replace(/[?&].*/, '') }, 'Google Chat Browser: send response intercepted');
        const raw = await response.text().catch(() => '');
        if (!raw) return;
        const cleaned = raw.replace(/^\)\]\}'\s*\n?/, '');
        const data = JSON.parse(cleaned);
        if (!Array.isArray(data) || !Array.isArray(data[0])) return;

        const eventName: string = data[0][0];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let msg: any;
        if (eventName === 'dfe.m.cm') {
          msg = data[0][1];
        } else if (eventName === 'dfe.t.ct') {
          msg = data[0][1]?.[6]?.[0]; // first message inside the new topic
        } else {
          return;
        }
        if (!Array.isArray(msg)) return;

        const msgId: string = msg[2] ?? '';
        const senderUserId: string = msg[1]?.[0]?.[0] ?? '';
        const text: string = msg[9] ?? '';
        const threadAlphaId: string = msg[0]?.[0]?.[3]?.[1] ?? '';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const spaceRef: any = msg[0]?.[0]?.[3]?.[2];
        let spaceId = '';
        if (Array.isArray(spaceRef)) {
          if (Array.isArray(spaceRef[0])) spaceId = spaceRef[0][0] ?? '';        // space: [["ID"]]
          else if (Array.isArray(spaceRef[2])) spaceId = spaceRef[2][0] ?? '';   // DM: [null,null,["ID"]]
        }

        if (!msgId || !spaceId || !threadAlphaId) return;
        if (senderUserId !== this.botUserId) return;

        const parentJid = `gchat:${spaceId}`;
        const threadJid = makeThreadJid(parentJid, threadAlphaId);
        const timestamp = new Date(Number(BigInt(msgId) / 1000n)).toISOString();

        // Ensure chat row exists (FK required by messages table)
        storeChatMetadata(threadJid, timestamp, undefined, 'google_chat_browser');

        storeMessageDirect({
          id: msgId,
          chat_jid: threadJid,
          sender: senderUserId,
          sender_name: this.botDisplayName,
          content: text,
          timestamp,
          is_from_me: true,
          is_bot_message: true,
          alpha_id: threadAlphaId || undefined,
        });
        this.webChannelDeliveredIds.add(msgId);
        this.sentMsgIds.add(msgId);
        if (this.webChannelDeliveredIds.size > 500) {
          this.webChannelDeliveredIds.delete(this.webChannelDeliveredIds.values().next().value!);
        }
        // Advance cursor so the poll loop doesn't keep re-detecting this message
        const prevCursor = this.lastSeenMsgIds.get(parentJid) ?? '';
        if (!prevCursor || BigInt(msgId) > BigInt(prevCursor)) {
          this.lastSeenMsgIds.set(parentJid, msgId);
        }
        logger.info({ threadJid, msgId, event: eventName }, 'Google Chat Browser: outbound message seeded to DB');
      } catch (err) {
        logger.warn({ err }, 'Google Chat Browser: send response intercept error');
      }
    });

    // Load bot user ID
    if (process.env.GCHAT_BOT_USER_ID) {
      this.botUserId = process.env.GCHAT_BOT_USER_ID.trim();
    } else if (fs.existsSync(BOT_USER_ID_PATH)) {
      this.botUserId = fs.readFileSync(BOT_USER_ID_PATH, 'utf8').trim();
    }

    // Pre-populate user name cache from DB (past messages already have display names)
    try {
      const known = getKnownSenderNames();
      for (const [userId, name] of known) this.userNameCache.set(userId, name);
      logger.info({ count: known.size }, 'Google Chat Browser: loaded sender names from DB');
    } catch { /* non-fatal */ }

    // Open home page — detects account index, captures XSRF, checks auth
    this.homePage = await this.context.newPage();
    await this.homePage.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.homePage.waitForTimeout(PAGE_LOAD_WAIT_MS);

    if (await this.isAuthExpired(this.homePage)) {
      logger.error('Google Chat Browser: auth expired — re-run auth capture.');
      return;
    }

    // Detect /u/N/ account index from the redirected URL
    const finalUrl = this.homePage.url();
    const idxMatch = finalUrl.match(/\/u\/(\d+)\//);
    this.accountIndex = idxMatch?.[1] ?? '0';
    logger.info({ accountIndex: this.accountIndex }, 'Google Chat Browser: account index detected');

    // Detect bot display name
    this.botDisplayName = await this.detectBotName();
    logger.info({ botDisplayName: this.botDisplayName }, 'Google Chat Browser: bot name detected');

    // Detect space format and catch up for each registered group
    const groups = this.opts.registeredGroups();
    for (const jid of Object.keys(groups)) {
      if (!jid.startsWith('gchat:') || jid.includes(':thread:')) continue;
      const spaceId = jid.replace('gchat:', '');
      const fmt = await this.detectSpaceFormat(spaceId);
      this.spaceFormats.set(spaceId, fmt);
      logger.info({ jid, fmt }, 'Google Chat Browser: space format detected');
      await this.catchUpSpace(jid).catch((err) =>
        logger.warn({ err, jid }, 'Google Chat Browser: catch-up failed'),
      );
    }

    this._connected = true;
    this.pollTimer = setInterval(() => {
      this.pollSpaces().catch((err) =>
        logger.error({ err }, 'Google Chat Browser: poll error'),
      );
    }, POLL_INTERVAL_MS);

    logger.info('Google Chat Browser: connected');
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    await this.homePage?.close().catch(() => {});
    this.homePage = null;
    for (const page of this.pages.values()) await page.close().catch(() => {});
    this.pages.clear();
    await this.context?.close();
    this.context = null;
    logger.info('Google Chat Browser: disconnected');
  }

  isConnected(): boolean { return this._connected; }

  ownsJid(jid: string): boolean { return jid.startsWith('gchat:'); }

  async addSpace(jid: string): Promise<void> {
    if (!this._connected || !this.context) return;
    const spaceId = jid.replace('gchat:', '');
    if (!this.spaceFormats.has(spaceId)) {
      const fmt = await this.detectSpaceFormat(spaceId);
      this.spaceFormats.set(spaceId, fmt);
    }
    await this.catchUpSpace(jid).catch((err) =>
      logger.warn({ err, jid }, 'Google Chat Browser: addSpace catch-up failed'),
    );
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  async sendMessage(jid: string, text: string): Promise<void> {
    this.sending = true;
    const page = await this.getOrOpenPage(jid);
    try {
      const result = await page.evaluate(
        ({ sel, t }: { sel: string; t: string }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const doc = (globalThis as any).document;
          const el = doc.querySelector(sel);
          if (!el) return 'no-input';
          el.focus();
          doc.execCommand('insertText', false, t);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const KbEvent = (globalThis as any).KeyboardEvent;
          const dispatch = (type: string) =>
            el.dispatchEvent(new KbEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
          dispatch('keydown');
          dispatch('keypress');
          dispatch('keyup');
          return 'sent';
        },
        { sel: SELECTORS.messageInput, t: text },
      );
      if (result === 'no-input') throw new Error('Message input not found');
      await page.waitForTimeout(1500);
      logger.info({ jid, length: text.length }, 'Google Chat Browser: message sent');
    } finally {
      this.sending = false;
    }
  }

  async sendThreadReply(jid: string, text: string, threadRootId: string): Promise<void> {
    this.sending = true;
    const spaceId = jid.replace('gchat:', '');
    const url = this.threadUrl(spaceId, threadRootId);
    const page = await this.getOrOpenPage(jid);
    try {
      // Navigate directly to canonical thread URL (skips client-side redirect)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for SPA navigation to settle on the topic path
      await page.waitForURL(`**/topic/${threadRootId}**`, { timeout: 10000 });

      // Wait for the editable reply div inside the thread pane — generous timeout
      // because thread content loads asynchronously after the SPA navigation
      const inputSel = SELECTORS.threadInput(threadRootId);
      await page.waitForSelector(inputSel, { timeout: 15000, state: 'visible' });

      await page.click(inputSel);
      await page.keyboard.type(text, { delay: 20 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      logger.info({ jid, threadRootId, length: text.length }, 'Google Chat Browser: thread reply sent');

      // Navigate back to space root so the page is ready for future sends
      await page.goto(this.roomUrl(jid), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    } catch (err) {
      logger.error({ err, jid, threadRootId }, 'Google Chat Browser: thread reply failed, falling back');
      await page.goto(this.roomUrl(jid), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await this.sendMessage(jid, text).catch((e) =>
        logger.error({ e, jid }, 'Google Chat Browser: fallback sendMessage also failed'),
      );
    } finally {
      this.sending = false;
    }
  }

  // ── API layer ─────────────────────────────────────────────────────────────

  /**
   * Make an authenticated POST to the Google Chat API.
   * Uses context.request which shares cookies with the browser context.
   */
  private async apiPost(endpoint: string, body: any[], spaceId?: string): Promise<any> {
    if (!this.context) throw new Error('Not connected');
    const url = `${CHAT_BASE}/u/${this.accountIndex}/api/${endpoint}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'origin': CHAT_BASE,
      'referer': `${CHAT_BASE}/`,
    };
    if (this.xsrfToken) headers['x-framework-xsrf-token'] = this.xsrfToken;
    if (spaceId) headers['x-goog-chat-space-id'] = spaceId;

    const resp = await this.context.request.post(url, {
      headers,
      data: JSON.stringify(body),
    });

    const text = await resp.text();
    // Google APIs prefix responses with )]}'\n to prevent JSON hijacking
    const cleaned = text.replace(/^\)\]\}'\s*\n?/, '');
    try {
      return JSON.parse(cleaned);
    } catch {
      logger.debug({ endpoint, text: text.slice(0, 200) }, 'Google Chat Browser: failed to parse API response');
      return null;
    }
  }

  /**
   * Detect whether a space uses "space" or "dm" format for list_topics.
   * Tries space format first; falls back to dm format.
   */
  private async detectSpaceFormat(spaceId: string): Promise<'space' | 'dm'> {
    if (this.spaceFormats.has(spaceId)) return this.spaceFormats.get(spaceId)!;
    // Try space format with a timestamp far in the past so we get at least one result
    const pastMicros = nowMicros() - DEFAULT_LOOKBACK_MICROS;
    try {
      const spaceRef = buildSpaceRef(spaceId, false);
      const body = buildListTopicsBody(spaceRef, pastMicros);
      const data = await this.apiPost('list_topics', body, spaceId);
      if (Array.isArray(data?.[0]) && data[0][0] === 'dfe.t.lt') {
        logger.debug({ spaceId, fmt: 'space' }, 'Google Chat Browser: space format confirmed');
        return 'space';
      }
    } catch { /* fall through */ }

    logger.debug({ spaceId, fmt: 'dm' }, 'Google Chat Browser: using dm format');
    return 'dm';
  }

  // ── Polling via list_topics API ───────────────────────────────────────────

  private async refreshXsrfToken(): Promise<void> {
    if (!this.homePage || !this.context) return;
    try {
      await this.homePage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.homePage.waitForTimeout(3000);
      this.lastTokenRefresh = Date.now();
      logger.info({ accountIndex: this.accountIndex }, 'Google Chat Browser: XSRF token refreshed');
    } catch (err) {
      logger.warn({ err }, 'Google Chat Browser: XSRF token refresh failed');
    }
  }

  private async pollSpaces(): Promise<void> {
    if (this.sending) return;

    // Refresh XSRF token periodically
    if (Date.now() - this.lastTokenRefresh > GoogleChatBrowserChannel.TOKEN_REFRESH_INTERVAL_MS) {
      await this.refreshXsrfToken();
    }

    const groups = this.opts.registeredGroups();
    for (const jid of Object.keys(groups)) {
      if (!jid.startsWith('gchat:') || jid.includes(':thread:')) continue;
      await this.pollSpaceViaApi(jid).catch((err) =>
        logger.warn({ err, jid }, 'Google Chat Browser: poll error'),
      );
    }
  }

  private async pollSpaceViaApi(jid: string): Promise<void> {
    const spaceId = jid.replace('gchat:', '');
    const isDm = (this.spaceFormats.get(spaceId) ?? 'space') === 'dm';
    const spaceRef = buildSpaceRef(spaceId, isDm);

    // Use the last seen message ID as the since cursor
    const lastSeenId = this.lastSeenMsgIds.get(jid) ?? '';
    const since = lastSeenId ? parseInt(lastSeenId, 10) : nowMicros() - DEFAULT_LOOKBACK_MICROS;

    const data = await this.apiPost('list_topics', buildListTopicsBody(spaceRef, since), spaceId);
    if (!data) return;

    const { msgs, maxRawMsgId, apiNextCursor, userNames } = parseListTopicsMessages(data);
    for (const [uid, name] of userNames) this.userNameCache.set(uid, name);
    logger.info({ jid, count: msgs.length, maxRawMsgId, apiNextCursor, isDm, since: since.toString(), lastSeenId }, 'Google Chat Browser: list_topics returned messages');

    // Step 2: detect new messages not in data[0][1].
    // New threads created after `since` only appear in participant delta records (data[0][6][1]).
    // For each participant entry with a last-message ID > cursor, fetch the actual content.
    const deltaNewIds = extractDeltaNewMsgIds(data, lastSeenId);
    let secondaryMsgs: ParsedMsg[] = [];
    let secondaryApiNextCursor = '';
    let secondaryMaxRawMsgId = '';

    if (deltaNewIds.length > 0) {
      const minNewId = deltaNewIds.reduce((a, b) => BigInt(a) < BigInt(b) ? a : b);
      const secondarySince = (BigInt(minNewId) - 1n).toString();
      logger.info({ jid, deltaNewIds, secondarySince }, 'Google Chat Browser: new participant delta IDs detected — secondary fetch');
      const secondaryData = await this.apiPost(
        'list_topics',
        buildListTopicsBody(spaceRef, parseInt(secondarySince, 10)),
        spaceId,
      );
      if (secondaryData) {
        const parsed = parseListTopicsMessages(secondaryData);
        secondaryMsgs = parsed.msgs;
        secondaryApiNextCursor = parsed.apiNextCursor;
        secondaryMaxRawMsgId = parsed.maxRawMsgId;
        for (const [uid, name] of parsed.userNames) this.userNameCache.set(uid, name);
        logger.info(
          { jid, secondaryCount: secondaryMsgs.length, secondaryMaxRawMsgId },
          'Google Chat Browser: secondary fetch complete',
        );
      }
    }

    // Deliver all messages (primary + secondary), deduplicating by msgId
    const deliveredIds = new Set<string>();
    for (const msg of [...msgs, ...secondaryMsgs]) {
      if (deliveredIds.has(msg.msgId)) continue;
      deliveredIds.add(msg.msgId);

      // Skip messages older than or equal to last seen, or already delivered via WebChannel
      if (lastSeenId && BigInt(msg.msgId) <= BigInt(lastSeenId)) continue;
      if (this.webChannelDeliveredIds.has(msg.msgId)) continue;

      const threadJid = makeThreadJid(jid, msg.threadAlphaId);
      const isBotMsg =
        this.sentMsgIds.has(msg.msgId) ||
        (this.botUserId !== '' && msg.senderUserId === this.botUserId) ||
        (this.botDisplayName !== '' && msg.senderName === this.botDisplayName);

      if (this.sentMsgIds.has(msg.msgId)) this.sentMsgIds.delete(msg.msgId);

      // Back-fill thread history on first contact with this thread
      if (!isBotMsg && !this.threadHistoryFetched.has(threadJid)) {
        this.threadHistoryFetched.add(threadJid);
        await this.fetchAndStoreThreadHistory(jid, spaceId, isDm, msg.threadAlphaId).catch(
          (err) => logger.warn({ err, threadJid }, 'Google Chat Browser: thread history fetch failed'),
        );
      }

      logger.info(
        { jid: threadJid, msgId: msg.msgId, sender: msg.senderName, isBotMsg, text: msg.text.slice(0, 120) },
        'Google Chat Browser: new message',
      );

      this.opts.onMessage(threadJid, {
        id: msg.msgId,
        chat_jid: threadJid,
        sender: msg.senderUserId,
        sender_name: msg.senderName,
        content: msg.text,
        timestamp: msg.timestamp,
        is_from_me: isBotMsg,
        is_bot_message: isBotMsg,
        alpha_id: msg.msgAlphaId || undefined,
        is_thread_root: msg.isThreadRoot,
      });
    }

    // Advance cursor ONLY based on maxRawMsgId from parsed header[1] content (primary + secondary).
    // We intentionally do NOT use apiNextCursor or deltaNewIds here — those can overshoot past
    // messages that haven't yet propagated into list_topics header[1]. Once the messages appear
    // in header[1] (typically within 1-2 poll cycles), maxRawMsgId will include them and the
    // cursor will advance naturally after delivery.
    const nextCursorCandidates = [maxRawMsgId, secondaryMaxRawMsgId].filter(Boolean);
    const nextCursor = nextCursorCandidates.reduce((max, id) =>
      !max || BigInt(id) > BigInt(max) ? id : max, '');
    if (nextCursor && (!lastSeenId || BigInt(nextCursor) > BigInt(lastSeenId))) {
      this.lastSeenMsgIds.set(jid, nextCursor);
    }
  }

  /**
   * Deliver a message received via real-time WebChannel interception.
   * Updates the cursor immediately so the background poll won't re-deliver it.
   */
  private async handleRealtimeMessage(msg: ParsedMsg): Promise<void> {
    const jid = `gchat:${msg.spaceId}`;
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return; // only deliver for registered spaces

    // Dedup: skip if already delivered via WebChannel or older than cursor
    if (this.webChannelDeliveredIds.has(msg.msgId)) return;
    const lastSeenId = this.lastSeenMsgIds.get(jid) ?? '';
    if (lastSeenId && BigInt(msg.msgId) <= BigInt(lastSeenId)) return;

    // Mark delivered immediately so the poll won't double-deliver
    this.webChannelDeliveredIds.add(msg.msgId);
    if (this.webChannelDeliveredIds.size > 500) {
      this.webChannelDeliveredIds.delete(this.webChannelDeliveredIds.values().next().value!);
    }
    // Also advance cursor so poll skips this message
    this.lastSeenMsgIds.set(jid, msg.msgId);

    // Update space format cache from real-time data
    if (!this.spaceFormats.has(msg.spaceId)) {
      this.spaceFormats.set(msg.spaceId, msg.isDm ? 'dm' : 'space');
    }

    const threadJid = makeThreadJid(jid, msg.threadAlphaId);
    const isBotMsg =
      this.sentMsgIds.has(msg.msgId) ||
      (this.botUserId !== '' && msg.senderUserId === this.botUserId);

    if (this.sentMsgIds.has(msg.msgId)) this.sentMsgIds.delete(msg.msgId);

    // Back-fill thread history on first contact with this thread.
    // Also schedule a retry 5 minutes later so sender_name gets populated once
    // the message propagates into list_topics (real-time events omit display names).
    if (!isBotMsg && !this.threadHistoryFetched.has(threadJid)) {
      this.threadHistoryFetched.add(threadJid);
      await this.fetchAndStoreThreadHistory(jid, msg.spaceId, msg.isDm, msg.threadAlphaId).catch(
        (err) => logger.warn({ err, threadJid }, 'Google Chat Browser: thread history fetch failed'),
      );
      // Retry after propagation delay to fill in sender names
      setTimeout(() => {
        this.fetchAndStoreThreadHistory(jid, msg.spaceId, msg.isDm, msg.threadAlphaId).catch(
          (err) => logger.debug({ err, threadJid }, 'Google Chat Browser: thread history retry failed'),
        );
      }, 5 * 60 * 1000);
    }

    // Resolve display name from cache if not present in real-time event
    if (!msg.senderName && this.userNameCache.has(msg.senderUserId)) {
      msg.senderName = this.userNameCache.get(msg.senderUserId)!;
    }

    logger.info(
      { jid: threadJid, msgId: msg.msgId, sender: msg.senderUserId, senderName: msg.senderName, isBotMsg, text: msg.text.slice(0, 120) },
      'Google Chat Browser: real-time message via WebChannel',
    );

    this.opts.onMessage(threadJid, {
      id: msg.msgId,
      chat_jid: threadJid,
      sender: msg.senderUserId,
      sender_name: msg.senderName,
      content: msg.text,
      timestamp: msg.timestamp,
      is_from_me: isBotMsg,
      is_bot_message: isBotMsg,
      alpha_id: msg.msgAlphaId || undefined,
      is_thread_root: msg.isThreadRoot,
    });
  }

  /**
   * Fetch full history of a thread and deliver each message via onMessage.
   * Called once per thread JID on first contact, so the agent has full context.
   */
  private async fetchAndStoreThreadHistory(
    parentJid: string,
    spaceId: string,
    isDm: boolean,
    threadAlphaId: string,
  ): Promise<void> {
    const threadJid = makeThreadJid(parentJid, threadAlphaId);
    const spaceRef = buildSpaceRef(spaceId, isDm);
    const since = 0; // fetch entire thread history

    const data = await this.apiPost(
      'list_topics',
      buildThreadListTopicsBody(spaceRef, spaceId, isDm, threadAlphaId, since),
      spaceId,
    );
    if (!data) return;

    const { msgs, userNames } = parseListTopicsMessages(data);
    for (const [uid, name] of userNames) this.userNameCache.set(uid, name);
    logger.info({ threadJid, historyCount: msgs.length }, 'Google Chat Browser: fetched thread history');

    for (const msg of msgs) {
      const isBotMsg =
        (this.botUserId !== '' && msg.senderUserId === this.botUserId) ||
        (this.botDisplayName !== '' && msg.senderName === this.botDisplayName);

      this.opts.onMessage(threadJid, {
        id: msg.msgId,
        chat_jid: threadJid,
        sender: msg.senderUserId,
        sender_name: msg.senderName,
        content: msg.text,
        timestamp: msg.timestamp,
        is_from_me: isBotMsg,
        is_bot_message: isBotMsg,
        alpha_id: msg.msgAlphaId || undefined,
        is_thread_root: msg.isThreadRoot,
      });
    }
  }

  /**
   * Catch up on all messages missed while offline for a registered space JID.
   * Reads the last stored timestamp from the DB and fetches everything since then.
   */
  private async catchUpSpace(jid: string): Promise<void> {
    const spaceId = jid.replace('gchat:', '');
    const isDm = (this.spaceFormats.get(spaceId) ?? 'space') === 'dm';
    const spaceRef = buildSpaceRef(spaceId, isDm);

    // Find the last message we stored for this space (any thread under it)
    const lastIso = getLastMessageTimestamp(jid);
    const since = lastIso
      ? isoToMicros(lastIso)
      : nowMicros() - DEFAULT_LOOKBACK_MICROS;

    logger.info({ jid, since: lastIso ?? 'default lookback' }, 'Google Chat Browser: catching up');

    const data = await this.apiPost('list_topics', buildListTopicsBody(spaceRef, since), spaceId);
    if (!data) return;

    const { msgs, maxRawMsgId, apiNextCursor, userNames } = parseListTopicsMessages(data);
    for (const [uid, name] of userNames) this.userNameCache.set(uid, name);
    logger.info({ jid, count: msgs.length, maxRawMsgId, apiNextCursor }, 'Google Chat Browser: catch-up messages found');

    for (const msg of msgs) {
      const threadJid = makeThreadJid(jid, msg.threadAlphaId);
      const isBotMsg =
        (this.botUserId !== '' && msg.senderUserId === this.botUserId) ||
        (this.botDisplayName !== '' && msg.senderName === this.botDisplayName);

      try {
        this.opts.onMessage(threadJid, {
          id: msg.msgId,
          chat_jid: threadJid,
          sender: msg.senderUserId,
          sender_name: msg.senderName,
          content: msg.text,
          timestamp: msg.timestamp,
          is_from_me: isBotMsg,
          is_bot_message: isBotMsg,
          alpha_id: msg.msgAlphaId || undefined,
          is_thread_root: msg.isThreadRoot,
        });
      } catch (err) {
        logger.warn({ err, msgId: msg.msgId, threadJid }, 'Google Chat Browser: onMessage error during catch-up (continuing)');
      }
    }

    // Advance cursor: use only maxRawMsgId (apiNextCursor can overshoot past current messages)
    const nextCursor = maxRawMsgId;
    const curBefore = this.lastSeenMsgIds.get(jid) ?? '';
    if (nextCursor && (!curBefore || BigInt(nextCursor) > BigInt(curBefore))) {
      this.lastSeenMsgIds.set(jid, nextCursor);
    }
  }

  // ── Auth helpers ──────────────────────────────────────────────────────────

  private async isAuthExpired(page: Page): Promise<boolean> {
    if (page.url().includes('accounts.google.com')) return true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bodyText = await page.$eval('body', (el: any) => el.innerText ?? '');
      if (bodyText.includes('Choose an account') || bodyText.includes('Signed out')) return true;
    } catch { /* ignore */ }
    return false;
  }

  private async detectBotName(): Promise<string> {
    if (!this.homePage) return '';
    try {
      const label = await this.homePage
        .$eval('[aria-label^="Google Account:"]', (el) => el.getAttribute('aria-label') ?? '')
        .catch(() => '');
      return label.replace('Google Account:', '').trim().split('\n')[0].trim();
    } catch { return ''; }
  }

  // ── DOM helpers — used by Phase-1 DOM-based sending only ─────────────────

  private roomUrl(jid: string): string {
    return `${CHAT_BASE}/app/chat/${jid.replace('gchat:', '').split(':')[0]}`;
  }

  private threadUrl(spaceId: string, threadAlphaId: string): string {
    // Use the canonical app/chat URL directly — avoids the client-side redirect
    // that /dm/ and /app/home/ deep-links go through before landing here.
    return `${CHAT_BASE}/app/chat/${spaceId}/topic/${threadAlphaId}`;
  }

  private async getOrOpenPage(jid: string): Promise<Page> {
    // Use base space JID (strip thread suffix) for the page
    const baseJid = jid.includes(':thread:') ? jid.split(':thread:')[0] : jid;
    const existing = this.pages.get(baseJid);
    if (existing && !existing.isClosed()) return existing;
    return this.initPageForSending(baseJid);
  }

  private async initPageForSending(jid: string): Promise<Page> {
    const page = await this.context!.newPage();
    await page.goto(this.roomUrl(jid), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(PAGE_LOAD_WAIT_MS);
    if (await this.isAuthExpired(page)) {
      await page.close();
      throw new Error('Google Chat Browser auth expired');
    }
    try {
      await page.waitForSelector(SELECTORS.messageInput, { timeout: 8000 });
    } catch {
      logger.warn({ jid }, 'Google Chat Browser: message input not found on send page');
    }
    // Try to get space name
    const spaceName = await page.$eval(SELECTORS.spaceName, (el) => el.textContent?.trim() ?? '').catch(() => '');
    if (spaceName) {
      updateChatName(jid, spaceName);
      this.opts.onChatMetadata(jid, new Date().toISOString(), spaceName, 'google_chat_browser', true);
    }
    this.pages.set(jid, page);
    logger.info({ jid, spaceName }, 'Google Chat Browser: send page opened');
    return page;
  }

  private async getLastMessageIdFromDom(page: Page): Promise<string> {
    return page
      .$$eval(SELECTORS.messageItem, (els) => {
        const last = els[els.length - 1];
        if (!last) return '';
        const jslog = last.getAttribute('jslog') ?? '';
        const m = jslog.match(/7:([^|]+)\|/);
        return m?.[1] ?? '';
      })
      .catch(() => '');
  }
}

registerChannel('google_chat_browser', (opts: ChannelOpts) => {
  if (!fs.existsSync(USER_DATA_DIR) && !fs.existsSync(AUTH_PATH)) {
    logger.debug({ USER_DATA_DIR }, 'Google Chat Browser: no auth found, skipping channel');
    return null;
  }
  if (!fs.existsSync(USER_DATA_DIR) && fs.existsSync(AUTH_PATH)) {
    logger.warn(
      'Google Chat Browser: legacy auth.json found but user-data dir is missing. ' +
      'Re-run auth capture: npx tsx setup/index.ts --step google-chat-browser-auth',
    );
    return null;
  }
  return new GoogleChatBrowserChannel(opts);
});
