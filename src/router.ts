import { Channel, NewMessage } from './types.js';
import { isThreadJid, parseThreadJid } from './thread-jid.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  if (isThreadJid(jid)) {
    const { parentJid, threadRootId } = parseThreadJid(jid);
    const channel = channels.find(
      (c) => c.ownsJid(parentJid) && c.isConnected(),
    );
    if (!channel) throw new Error(`No channel for parent JID: ${parentJid}`);
    const gcb = channel as {
      sendThreadReply?: (j: string, t: string, id: string) => Promise<void>;
    };
    if (typeof gcb.sendThreadReply === 'function') {
      return gcb.sendThreadReply(parentJid, text, threadRootId);
    }
    return channel.sendMessage(parentJid, text);
  }
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
