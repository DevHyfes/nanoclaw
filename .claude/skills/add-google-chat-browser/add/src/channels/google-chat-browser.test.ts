import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks (must be before imports) ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../config.js', () => ({
  STORE_DIR: '/fake/store',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...(actual as any).default,
      existsSync: vi.fn().mockReturnValue(false), // no SingletonLock by default
      mkdirSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// --- Playwright mock ---

const mockLocator = vi.hoisted(() => ({
  click: vi.fn().mockResolvedValue(undefined),
  fill: vi.fn().mockResolvedValue(undefined),
  first: vi.fn(),
}));
// first() returns itself so chaining works
mockLocator.first.mockReturnValue(mockLocator);

const mockPage = vi.hoisted(() => ({
  goto: vi.fn().mockResolvedValue(undefined),
  url: vi.fn().mockReturnValue('https://chat.google.com/room/AAAtest'),
  waitForSelector: vi.fn().mockResolvedValue(undefined),
  waitForTimeout: vi.fn().mockResolvedValue(undefined),
  $$eval: vi.fn().mockResolvedValue([]),
  $eval: vi.fn().mockResolvedValue(''),
  evaluate: vi.fn().mockResolvedValue(true),
  click: vi.fn().mockResolvedValue(undefined),
  fill: vi.fn().mockResolvedValue(undefined),
  locator: vi.fn().mockReturnValue(mockLocator),
  keyboard: { press: vi.fn().mockResolvedValue(undefined) },
  isClosed: vi.fn().mockReturnValue(false),
  close: vi.fn().mockResolvedValue(undefined),
  getByRole: vi.fn().mockReturnValue({
    isVisible: vi.fn().mockResolvedValue(false),
    click: vi.fn().mockResolvedValue(undefined),
  }),
}));

const mockContext = vi.hoisted(() => ({
  newPage: vi.fn().mockResolvedValue(mockPage),
  storageState: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
}));

const mockBrowser = vi.hoisted(() => ({
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mockBrowser),
    launchPersistentContext: vi.fn().mockResolvedValue(mockContext),
  },
}));

// --- Test setup ---

import { GoogleChatBrowserChannel } from './google-chat-browser.js';
import { registerChannel } from './registry.js';
import { updateChatName } from '../db.js';
import { chromium } from 'playwright';
import fs from 'fs';

// Capture the factory registered at module import time (before vi.clearAllMocks() runs)
const registeredFactory = vi.mocked(registerChannel).mock.calls[0]?.[1] ?? null;
const registeredName = vi.mocked(registerChannel).mock.calls[0]?.[0] ?? null;

const makeOpts = (groups: Record<string, any> = {}) => ({
  onMessage: vi.fn(),
  onChatMetadata: vi.fn(),
  registeredGroups: vi.fn().mockReturnValue(groups),
});

const testGroup = (name = 'Room A') => ({
  name,
  folder: 'room-a',
  trigger: '@Chiron',
  added_at: '',
});

describe('GoogleChatBrowserChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPage.url.mockReturnValue('https://chat.google.com/room/AAAtest');
    mockPage.isClosed.mockReturnValue(false);
    mockPage.$$eval.mockResolvedValue([]);
    mockPage.$eval.mockResolvedValue('');
    mockPage.waitForTimeout.mockResolvedValue(undefined);
    mockPage.getByRole.mockReturnValue({
      isVisible: vi.fn().mockResolvedValue(false),
      click: vi.fn().mockResolvedValue(undefined),
    });
    mockPage.evaluate.mockResolvedValue(true);
    mockLocator.click.mockResolvedValue(undefined);
    mockLocator.fill.mockResolvedValue(undefined);
    mockLocator.first.mockReturnValue(mockLocator);
    mockPage.locator.mockReturnValue(mockLocator);
  });

  describe('registerChannel', () => {
    it('registers with name google_chat_browser at module load time', () => {
      expect(registeredName).toBe('google_chat_browser');
      expect(typeof registeredFactory).toBe('function');
    });
  });

  describe('ownsJid', () => {
    it('returns true for gchat: jids', () => {
      const ch = new GoogleChatBrowserChannel(makeOpts());
      expect(ch.ownsJid('gchat:AAAAbcDeFg')).toBe(true);
    });

    it('returns false for non-gchat jids', () => {
      const ch = new GoogleChatBrowserChannel(makeOpts());
      expect(ch.ownsJid('123456789@g.us')).toBe(false);
      expect(ch.ownsJid('slack:C123')).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('returns false before connect()', () => {
      const ch = new GoogleChatBrowserChannel(makeOpts());
      expect(ch.isConnected()).toBe(false);
    });

    it('returns true after connect()', async () => {
      const ch = new GoogleChatBrowserChannel(makeOpts());
      await ch.connect();
      expect(ch.isConnected()).toBe(true);
      await ch.disconnect();
    });

    it('returns false after disconnect()', async () => {
      const ch = new GoogleChatBrowserChannel(makeOpts());
      await ch.connect();
      await ch.disconnect();
      expect(ch.isConnected()).toBe(false);
    });
  });

  describe('connect()', () => {
    it('launches headless Chromium with persistent context', async () => {
      const ch = new GoogleChatBrowserChannel(makeOpts());
      await ch.connect();
      expect(chromium.launchPersistentContext).toHaveBeenCalledWith(
        expect.stringContaining('user-data'),
        { headless: true },
      );
      await ch.disconnect();
    });

    it('opens a page for each registered gchat: group plus home page', async () => {
      const groups = {
        'gchat:AAA': testGroup('Room A'),
        'gchat:BBB': testGroup('Room B'),
        '12345@g.us': testGroup('WA'),
      };
      const ch = new GoogleChatBrowserChannel(makeOpts(groups));
      await ch.connect();
      // detectBotName (temp page, closed) + 2 gchat spaces + 1 home page = 4 newPage calls
      expect(mockContext.newPage).toHaveBeenCalledTimes(4);
      await ch.disconnect();
    });

    it('does not set connected=true if page navigates to Google login', async () => {
      mockPage.url.mockReturnValue('https://accounts.google.com/signin');
      const groups = { 'gchat:AAA': testGroup() };
      const ch = new GoogleChatBrowserChannel(makeOpts(groups));
      await ch.connect(); // returns early, no throw
      expect(ch.isConnected()).toBe(false);
    });
  });

  describe('sendMessage()', () => {
    it('clicks input, fills text, and presses Enter', async () => {
      const groups = { 'gchat:AAA': testGroup() };
      const ch = new GoogleChatBrowserChannel(makeOpts(groups));
      await ch.connect();
      await ch.sendMessage('gchat:AAA', 'Hello world');
      expect(mockPage.evaluate).toHaveBeenCalled();
      await ch.disconnect();
    });
  });

  describe('disconnect()', () => {
    it('clears poll timer and closes context', async () => {
      const mockClose = vi.fn().mockResolvedValue(undefined);
      (mockContext as any).close = mockClose;
      const ch = new GoogleChatBrowserChannel(makeOpts());
      await ch.connect();
      await ch.disconnect();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe('polling', () => {
    it('delivers new messages after lastSeenId', async () => {
      const onMessage = vi.fn();
      const groups = { 'gchat:AAA': testGroup() };
      const opts = {
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: vi.fn().mockReturnValue(groups),
      };

      // initPage calls: $$eval for lastId → 'msg-001', $eval for spaceName → 'Room A'
      mockPage.$$eval.mockResolvedValueOnce('msg-001');
      mockPage.$eval.mockResolvedValue('Room A');

      const ch = new GoogleChatBrowserChannel(opts);
      await ch.connect();

      // After connect, set up the poll response
      mockPage.$$eval.mockResolvedValueOnce([
        { id: 'msg-002', text: 'Hi Chiron!', sender: 'Alice' },
      ]);

      await (ch as any).pollSpaces();

      expect(onMessage).toHaveBeenCalledWith(
        'gchat:AAA',
        expect.objectContaining({
          id: 'msg-002',
          content: 'Hi Chiron!',
          sender_name: 'Alice',
          chat_jid: 'gchat:AAA',
        }),
      );

      await ch.disconnect();
    });

    it('does not deliver messages to unregistered spaces', async () => {
      const onMessage = vi.fn();
      const opts = {
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: vi.fn().mockReturnValue({}),
      };
      const ch = new GoogleChatBrowserChannel(opts);
      await ch.connect();
      await (ch as any).pollSpaces();
      expect(onMessage).not.toHaveBeenCalled();
      await ch.disconnect();
    });
  });

  describe('room URL', () => {
    it('builds correct URL from jid', () => {
      const ch = new GoogleChatBrowserChannel(makeOpts());
      expect((ch as any).roomUrl('gchat:AAAAbcDeFg')).toBe(
        'https://chat.google.com/app/chat/AAAAbcDeFg',
      );
    });
  });

  describe('sendThreadReply()', () => {
    it('opens thread panel, sends message, and closes panel', async () => {
      const groups = { 'gchat:AAA': testGroup() };
      const ch = new GoogleChatBrowserChannel(makeOpts(groups));
      await ch.connect();

      mockPage.evaluate.mockResolvedValue('sent');
      mockPage.$$eval.mockResolvedValue('msg-thread-001');

      await ch.sendThreadReply('gchat:AAA', 'Hi in thread!', 'threadRoot1');

      expect(mockPage.evaluate).toHaveBeenCalled();
      // Escape should be pressed to close the thread panel
      expect(mockPage.keyboard.press).toHaveBeenCalledWith('Escape');

      await ch.disconnect();
    });

    it('does not advance lastSeenIds after thread reply', async () => {
      const groups = { 'gchat:AAA': testGroup() };
      const ch = new GoogleChatBrowserChannel(makeOpts(groups));
      await ch.connect();

      mockPage.evaluate.mockResolvedValue('sent');

      // Capture the lastSeenId before sending
      const lastIdBefore = (ch as any).lastSeenIds.get('gchat:AAA');

      await ch.sendThreadReply('gchat:AAA', 'reply', 'threadRoot1');

      // lastSeenIds should NOT have changed (no getLastMessageId called after thread reply)
      expect((ch as any).lastSeenIds.get('gchat:AAA')).toBe(lastIdBefore);

      await ch.disconnect();
    });
  });

  describe('pollHome()', () => {
    it('delivers thread messages prefixed with [thread:topicId]', async () => {
      const onMessage = vi.fn();
      const groups = { 'gchat:AAA': testGroup() };
      const opts = { onMessage, onChatMetadata: vi.fn(), registeredGroups: vi.fn().mockReturnValue(groups) };

      const ch = new GoogleChatBrowserChannel(opts);
      await ch.connect();

      // Inject homePage directly
      (ch as any).homePage = mockPage;

      // Pre-seed threadLastSeenIds so the thread is already tracked (skips init path)
      (ch as any).threadLastSeenIds.set('gchat:AAA:thread1', 'msg-001');

      // First $$eval: unread thread listitems from Home feed
      mockPage.$$eval.mockResolvedValueOnce([
        { groupId: 'AAA', topicId: 'thread1' },
      ]);
      // Second $$eval: thread messages from third pane (new message after msg-001)
      mockPage.$$eval.mockResolvedValueOnce([
        { id: 'msg-002', text: 'Thread reply here', sender: 'Bob', isFromBot: false },
      ]);

      await (ch as any).pollHome();

      expect(onMessage).toHaveBeenCalledWith(
        'gchat:AAA',
        expect.objectContaining({
          id: 'msg-002',
          content: '[thread:thread1] Thread reply here',
          sender_name: 'Bob',
        }),
      );

      await ch.disconnect();
    });

    it('initializes threadLastSeenIds on first encounter without delivering', async () => {
      const onMessage = vi.fn();
      const groups = { 'gchat:AAA': testGroup() };
      const opts = { onMessage, onChatMetadata: vi.fn(), registeredGroups: vi.fn().mockReturnValue(groups) };

      const ch = new GoogleChatBrowserChannel(opts);
      await ch.connect();

      (ch as any).homePage = mockPage;
      // No pre-seed — thread is brand new (trackedLastId === undefined)

      // First $$eval: unread thread listitems
      mockPage.$$eval.mockResolvedValueOnce([
        { groupId: 'AAA', topicId: 'thread1' },
      ]);
      // Second $$eval: existing thread messages (should be skipped, not delivered)
      mockPage.$$eval.mockResolvedValueOnce(['msg-existing-id']);

      await (ch as any).pollHome();

      // No messages delivered — just initialization
      expect(onMessage).not.toHaveBeenCalled();
      // But threadLastSeenIds should now be set
      expect((ch as any).threadLastSeenIds.has('gchat:AAA:thread1')).toBe(true);

      await ch.disconnect();
    });

    it('skips threads from unregistered groups', async () => {
      const onMessage = vi.fn();
      const opts = {
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: vi.fn().mockReturnValue({}), // no registered groups
      };

      const ch = new GoogleChatBrowserChannel(opts);
      await ch.connect();

      (ch as any).homePage = mockPage;
      mockPage.$$eval.mockResolvedValueOnce([
        { groupId: 'AAA', topicId: 'thread1' },
      ]);

      await (ch as any).pollHome();

      expect(onMessage).not.toHaveBeenCalled();
      await ch.disconnect();
    });

    it('tracks threadLastSeenIds and skips already-seen messages', async () => {
      const onMessage = vi.fn();
      const groups = { 'gchat:AAA': testGroup() };
      const opts = { onMessage, onChatMetadata: vi.fn(), registeredGroups: vi.fn().mockReturnValue(groups) };

      const ch = new GoogleChatBrowserChannel(opts);
      await ch.connect();

      (ch as any).homePage = mockPage;
      // Seed last seen
      (ch as any).threadLastSeenIds.set('gchat:AAA:thread1', 'msg-002');

      mockPage.$$eval.mockResolvedValueOnce([
        { groupId: 'AAA', topicId: 'thread1' },
      ]);
      // $$eval returns empty (all messages already seen)
      mockPage.$$eval.mockResolvedValueOnce([]);

      await (ch as any).pollHome();

      expect(onMessage).not.toHaveBeenCalled();
      await ch.disconnect();
    });
  });

  describe('updateChatName', () => {
    it('stores space name in DB on init', async () => {
      mockPage.$eval.mockResolvedValue('Engineering Room');
      const groups = { 'gchat:AAA': testGroup() };
      const ch = new GoogleChatBrowserChannel(makeOpts(groups));
      await ch.connect();
      expect(updateChatName).toHaveBeenCalledWith('gchat:AAA', 'Engineering Room');
      await ch.disconnect();
    });
  });
});
