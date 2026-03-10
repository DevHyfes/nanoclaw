import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const STORE_DIR = path.join(process.env.HOME!, 'chiron/nanoclaw/store');
const AUTH_DIR = path.join(STORE_DIR, 'google-chat-browser');
const USER_DATA_DIR = path.join(AUTH_DIR, 'user-data');
const CHAT_BASE = 'https://chat.google.com';
const SPACE_ID = 'tgyvmSAAAAE'; // DM space

function nowMicros(): number { return Date.now() * 1000; }

async function main() {
  const lockFile = path.join(USER_DATA_DIR, 'SingletonLock');
  if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: true });

  let xsrfToken = '';
  let accountIndex = '0';

  context.on('request', (req) => {
    const tok = req.headers()['x-framework-xsrf-token'];
    if (tok) xsrfToken = tok;
  });

  const page = await context.newPage();
  console.log('Navigating to home...');
  await page.goto(`${CHAT_BASE}/app/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);

  const finalUrl = page.url();
  const m = finalUrl.match(/\/u\/(\d+)\//);
  accountIndex = m?.[1] ?? '0';
  console.log('Account index:', accountIndex, 'XSRF:', xsrfToken ? xsrfToken.slice(0,10)+'...' : 'NONE');

  const sessionNow = nowMicros();

  // Build list_topics body matching current buildListTopicsBody
  function buildBody(cursor: number, isDm: boolean): any[] {
    const spaceRef = isDm ? [null, null, [SPACE_ID]] : [[SPACE_ID]];
    const body: any[] = new Array(100).fill(null);
    body[1] = 30;
    body[3] = [cursor];
    body[4] = [3, 4];          // current (changed from [3,1,4])
    body[5] = 1000;
    body[6] = 20;
    body[7] = spaceRef;
    body[8] = [sessionNow];
    body[9] = [sessionNow];
    body[10] = 2;
    return body;
  }

  // Also build the OLD version for comparison
  function buildBodyOld(cursor: number, isDm: boolean): any[] {
    const spaceRef = isDm ? [null, null, [SPACE_ID]] : [[SPACE_ID]];
    const body: any[] = new Array(100).fill(null);
    body[1] = 50;
    body[3] = [cursor];
    body[4] = [3, 1, 4];       // old (had the '1')
    body[5] = 1000;
    body[6] = 50;
    body[7] = spaceRef;
    body[8] = [sessionNow];
    body[9] = [sessionNow];
    body[10] = 2;
    return body;
  }

  async function callListTopics(body: any[], label: string): Promise<any> {
    const url = `${CHAT_BASE}/u/${accountIndex}/api/list_topics`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'origin': CHAT_BASE,
      'referer': `${CHAT_BASE}/`,
    };
    if (xsrfToken) headers['x-framework-xsrf-token'] = xsrfToken;
    headers['x-goog-chat-space-id'] = SPACE_ID;

    console.log(`Calling list_topics [${label}]...`);
    const resp = await context.request.post(url, { headers, data: JSON.stringify(body) });
    const text = await resp.text();
    const cleaned = text.replace(/^\)\]\}'\s*\n?/, '');
    const parsed = JSON.parse(cleaned);
    return parsed;
  }

  const isDm = true; // tgyvmSAAAAE is a DM

  // Call with CURRENT body (body[4]=[3,4])
  const currentBody = buildBody(sessionNow, isDm);
  const currentResult = await callListTopics(currentBody, 'current [3,4]');

  // Call with OLD body (body[4]=[3,1,4])
  const oldBody = buildBodyOld(sessionNow, isDm);
  const oldResult = await callListTopics(oldBody, 'old [3,1,4]');

  // Dump both to files
  fs.writeFileSync('/tmp/list-topics-current.json', JSON.stringify(currentResult, null, 2));
  fs.writeFileSync('/tmp/list-topics-old.json', JSON.stringify(oldResult, null, 2));
  console.log('Dumped to /tmp/list-topics-current.json and /tmp/list-topics-old.json');

  // Quick summary: how many topics, and do any have sender names?
  for (const [label, result] of [['current', currentResult], ['old', oldResult]] as [string,any][]) {
    const header = result?.[0];
    const topics = Array.isArray(header?.[1]) ? header[1] : [];
    console.log(`\n[${label}] topics: ${topics.length}`);
    let namesFound = 0;
    for (const topic of topics.slice(0, 3)) {
      const msgs = topic[6] ?? [];
      for (const msg of msgs.slice(0, 2)) {
        const senderName = msg[1]?.[1] ?? msg[1]?.[0]?.[1] ?? '';
        if (senderName) namesFound++;
        console.log(`  msgId=${msg[2]}, senderName="${senderName}", text="${String(msg[9]).slice(0,40)}"`);
      }
    }
    console.log(`  sender names found in first 3 topics: ${namesFound}`);
  }

  await context.close();
}

main().catch(console.error);
