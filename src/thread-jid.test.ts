import { describe, it, expect } from 'vitest';
import {
  THREAD_SEP,
  makeThreadJid,
  isThreadJid,
  parseThreadJid,
} from './thread-jid.js';

describe('makeThreadJid', () => {
  it('combines parentJid and threadRootId with separator', () => {
    expect(makeThreadJid('gchat:AAA', 'xyz123')).toBe(
      'gchat:AAA:thread:xyz123',
    );
  });

  it('uses THREAD_SEP constant', () => {
    expect(THREAD_SEP).toBe(':thread:');
    expect(makeThreadJid('gchat:BBB', 'abc')).toContain(THREAD_SEP);
  });
});

describe('isThreadJid', () => {
  it('returns true for a thread JID', () => {
    expect(isThreadJid('gchat:AAA:thread:xyz123')).toBe(true);
  });

  it('returns false for a plain channel JID', () => {
    expect(isThreadJid('gchat:AAA')).toBe(false);
    expect(isThreadJid('123456@g.us')).toBe(false);
    expect(isThreadJid('slack:C123')).toBe(false);
  });
});

describe('parseThreadJid', () => {
  it('extracts parentJid and threadRootId', () => {
    const result = parseThreadJid('gchat:AAA:thread:xyz123');
    expect(result.parentJid).toBe('gchat:AAA');
    expect(result.threadRootId).toBe('xyz123');
  });

  it('threadRootId can contain colons (separator appears only once)', () => {
    // If topicId itself contains a colon, it is captured intact in threadRootId
    const result = parseThreadJid('gchat:AAA:thread:part1:part2');
    expect(result.parentJid).toBe('gchat:AAA');
    expect(result.threadRootId).toBe('part1:part2');
  });

  it('round-trips with makeThreadJid', () => {
    const original = makeThreadJid('gchat:CHANNELID', 'THREADROOTID');
    const parsed = parseThreadJid(original);
    expect(parsed.parentJid).toBe('gchat:CHANNELID');
    expect(parsed.threadRootId).toBe('THREADROOTID');
  });
});
