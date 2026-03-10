export const THREAD_SEP = ':thread:';

export function makeThreadJid(parentJid: string, threadRootId: string): string {
  return `${parentJid}${THREAD_SEP}${threadRootId}`;
}

export function isThreadJid(jid: string): boolean {
  return jid.includes(THREAD_SEP);
}

export function parseThreadJid(jid: string): { parentJid: string; threadRootId: string } {
  const idx = jid.lastIndexOf(THREAD_SEP);
  return {
    parentJid: jid.slice(0, idx),
    threadRootId: jid.slice(idx + THREAD_SEP.length),
  };
}
