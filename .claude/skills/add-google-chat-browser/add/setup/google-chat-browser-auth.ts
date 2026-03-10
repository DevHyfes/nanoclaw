/**
 * Step: google-chat-browser-auth
 *
 * Opens a headed Chromium browser so the user can log in to Google Chat.
 * On success, the full Chromium user-data directory is kept at
 * store/google-chat-browser/user-data/ so the headless channel reuses the
 * *exact same browser profile* on every restart — preserving IndexedDB,
 * ServiceWorker state, and all other storage that Google Chat uses for
 * session validation (not just cookies/localStorage).
 *
 * Usage:
 *   npx tsx setup/index.ts --step google-chat-browser-auth
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from '../src/config.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

const AUTH_DIR = path.join(STORE_DIR, 'google-chat-browser');
const USER_DATA_DIR = path.join(AUTH_DIR, 'user-data');
const CHAT_URL = 'https://chat.google.com/app/home';
const LOGIN_POLL_MS = 2000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(_args: string[]): Promise<void> {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  emitStatus('GOOGLE_CHAT_BROWSER_AUTH', {
    STATUS: 'starting',
    MESSAGE: 'Opening browser — log in to Google Chat then close the browser window.',
  });

  logger.info({ userDataDir: USER_DATA_DIR }, 'Launching headed Chromium for Google Chat auth capture');
  // Use a persistent context so the full browser profile (including IndexedDB)
  // is written directly to USER_DATA_DIR — no separate storageState save needed.
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
  });
  const page = await context.newPage();

  await page.goto(CHAT_URL);

  // Poll until the page is on chat.google.com (not the Google login page)
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let authenticated = false;

  while (Date.now() < deadline) {
    const url = page.url();
    if (!url.includes('accounts.google.com') && url.includes('chat.google.com')) {
      // Extra wait to let post-login JS settle and write its state to disk
      await sleep(5000);
      authenticated = true;
      break;
    }
    await sleep(LOGIN_POLL_MS);
  }

  await context.close();

  if (!authenticated) {
    emitStatus('GOOGLE_CHAT_BROWSER_AUTH', {
      STATUS: 'failed',
      ERROR: 'timeout — login not completed within 5 minutes',
    });
    logger.error('Google Chat auth capture timed out');
    process.exit(1);
  }

  emitStatus('GOOGLE_CHAT_BROWSER_AUTH', {
    STATUS: 'success',
    USER_DATA_DIR,
    MESSAGE: 'Session saved. Run the next setup phase to list your spaces.',
  });

  logger.info({ userDataDir: USER_DATA_DIR }, 'Google Chat Browser auth captured successfully');
}
