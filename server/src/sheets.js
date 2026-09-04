import fs from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from './config.js';

/**
 * Google Sheets, as a place for a bot to put what it collected.
 *
 * Authentication is a service account rather than OAuth, because the thing
 * writing the row is a server with nobody sitting in front of it — there is no
 * one to click "allow" when a token expires at three in the morning. The
 * trade-off is a one-off setup step: the sheet has to be shared with the
 * service account's email address, exactly as it would be with a colleague.
 */

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

let client = null;
let loadError = null;

/** The service account, from a file path or from the JSON itself. */
function credentials() {
  const { serviceAccountJson, serviceAccountFile } = config.sheets;

  if (serviceAccountJson) return JSON.parse(serviceAccountJson);
  if (serviceAccountFile) {
    if (!fs.existsSync(serviceAccountFile)) {
      throw new Error(`No service account file at ${serviceAccountFile}`);
    }
    return JSON.parse(fs.readFileSync(serviceAccountFile, 'utf8'));
  }
  throw new Error(
    'Google Sheets is not set up — put the service account JSON at the path in '
    + 'GOOGLE_SERVICE_ACCOUNT_FILE, or inline in GOOGLE_SERVICE_ACCOUNT_JSON.',
  );
}

/**
 * The authorised client, built once and reused.
 *
 * A failure is remembered too: without that, every message from every person
 * in a broken flow would retry the same hopeless handshake.
 */
function auth() {
  if (client) return client;
  if (loadError) throw loadError;

  try {
    const key = credentials();
    client = new JWT({ email: key.client_email, key: key.private_key, scopes: [SCOPE] });
    console.log(`[sheets] signed in as ${key.client_email}`);
    return client;
  } catch (err) {
    loadError = err;
    throw err;
  }
}

/** Whether a sheets step can run at all, without throwing at the caller. */
export function sheetsReady() {
  try {
    auth();
    return { ready: true, account: JSON.parse(
      config.sheets.serviceAccountJson || fs.readFileSync(config.sheets.serviceAccountFile, 'utf8'),
    ).client_email };
  } catch (err) {
    return { ready: false, error: err.message };
  }
}

/**
 * Add one row to the bottom of a sheet.
 *
 * `USER_ENTERED` so a date or a number arrives as a date or a number rather
 * than as text that later refuses to sort.
 */
export async function appendRow({ spreadsheetId, sheetName, row }) {
  if (!spreadsheetId) throw new Error('This step has no spreadsheet chosen');

  const range = `${sheetName || 'Sheet1'}!A1`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`
    + `/values/${encodeURIComponent(range)}:append`
    + '?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS';

  const res = await auth().request({
    url,
    method: 'POST',
    data: { values: [row] },
  }).catch((err) => {
    // The Google error body is far more useful than the status line, and this
    // message ends up in front of whoever built the flow.
    const detail = err?.response?.data?.error?.message ?? err.message;
    throw new Error(detail);
  });

  return { updatedRange: res.data?.updates?.updatedRange ?? null };
}

/** Read the first row, so the builder can offer real column names. */
export async function readHeaders({ spreadsheetId, sheetName }) {
  if (!spreadsheetId) throw new Error('Choose a spreadsheet first');

  const range = `${sheetName || 'Sheet1'}!1:1`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`
    + `/values/${encodeURIComponent(range)}`;

  const res = await auth().request({ url }).catch((err) => {
    throw new Error(err?.response?.data?.error?.message ?? err.message);
  });

  return res.data?.values?.[0] ?? [];
}

/**
 * A spreadsheet id out of whatever someone pasted.
 *
 * People paste the whole browser URL far more often than the bare id, and
 * silently storing a URL as an id produces a 404 much later.
 */
export function toSpreadsheetId(input) {
  const said = String(input ?? '').trim();
  const fromUrl = said.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return fromUrl ? fromUrl[1] : said;
}
