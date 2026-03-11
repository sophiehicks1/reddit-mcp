/**
 * Credential loading with OS keychain as the primary store.
 *
 * Resolution order (highest priority first):
 *  1. OS keychain via keytar (macOS Keychain, Windows Credential Manager,
 *     Linux Secret Service / libsecret)
 *  2. Environment variables (REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, …)
 *  3. .env file in the current working directory (loaded via dotenv)
 *
 * This means credentials are *never* required to appear in any config file
 * that could accidentally be committed to version control.  Run
 * `npm run setup` once to store credentials in the OS keychain.
 */

import * as dotenv from "dotenv";

// The keychain service name used for all stored credentials.
export const KEYCHAIN_SERVICE = "reddit-mcp";

// Canonical keychain account names for each credential.
const ACCOUNT = {
  clientId: "client_id",
  clientSecret: "client_secret",
  username: "username",
  password: "password",
  userAgent: "user_agent",
} as const;

export interface Credentials {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  userAgent: string;
}

// ---------------------------------------------------------------------------
// Keychain helpers (keytar is loaded dynamically so the server starts even
// when libsecret / the Secret Service daemon is unavailable).
// ---------------------------------------------------------------------------

type Keytar = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

/**
 * Try to load the keytar module.  Returns null when keytar's native addon
 * cannot be loaded (e.g. libsecret not installed on Linux, or running in a
 * headless CI environment).
 */
function tryLoadKeytar(): Keytar | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("keytar") as Keytar;
  } catch {
    return null;
  }
}

/**
 * Attempt to load all credentials from the OS keychain.
 * Returns null if keytar is unavailable or any required credential is missing.
 */
async function loadFromKeychain(): Promise<Credentials | null> {
  const keytar = tryLoadKeytar();
  if (!keytar) return null;

  try {
    const [clientId, clientSecret, username, password, userAgentStored] =
      await Promise.all([
        keytar.getPassword(KEYCHAIN_SERVICE, ACCOUNT.clientId),
        keytar.getPassword(KEYCHAIN_SERVICE, ACCOUNT.clientSecret),
        keytar.getPassword(KEYCHAIN_SERVICE, ACCOUNT.username),
        keytar.getPassword(KEYCHAIN_SERVICE, ACCOUNT.password),
        keytar.getPassword(KEYCHAIN_SERVICE, ACCOUNT.userAgent),
      ]);

    if (!clientId || !clientSecret || !username || !password) {
      return null;
    }

    const userAgent =
      userAgentStored ||
      `node:reddit-mcp:v1.0.0 (by /u/${username})`;

    return { clientId, clientSecret, username, password, userAgent };
  } catch {
    return null;
  }
}

/**
 * Load credentials from environment variables (falls back to .env file via
 * dotenv).  Returns null if any required variable is absent.
 */
function loadFromEnv(): Credentials | null {
  dotenv.config();

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const username = process.env.REDDIT_USERNAME;
  const password = process.env.REDDIT_PASSWORD;

  if (!clientId || !clientSecret || !username || !password) {
    return null;
  }

  const userAgent =
    process.env.REDDIT_USER_AGENT ||
    `node:reddit-mcp:v1.0.0 (by /u/${username})`;

  return { clientId, clientSecret, username, password, userAgent };
}

/**
 * Load credentials using the resolution order described at the top of this
 * file.  Throws an informative error if no credentials are found anywhere.
 */
export async function loadCredentials(): Promise<Credentials> {
  const fromKeychain = await loadFromKeychain();
  if (fromKeychain) return fromKeychain;

  const fromEnv = loadFromEnv();
  if (fromEnv) return fromEnv;

  throw new Error(
    "No Reddit credentials found.\n" +
      "Run `npm run setup` to store credentials securely in the OS keychain, or\n" +
      "copy .env.example to .env and fill in your credentials."
  );
}

/**
 * Store all credentials in the OS keychain.
 * Throws if keytar is not available.
 */
export async function saveToKeychain(creds: Credentials): Promise<void> {
  const keytar = tryLoadKeytar();
  if (!keytar) {
    throw new Error(
      "The OS keychain is not available in this environment " +
        "(keytar could not load its native addon).\n" +
        "On Linux, make sure libsecret is installed: " +
        "`sudo apt install libsecret-1-0` or equivalent."
    );
  }

  await Promise.all([
    keytar.setPassword(KEYCHAIN_SERVICE, ACCOUNT.clientId, creds.clientId),
    keytar.setPassword(KEYCHAIN_SERVICE, ACCOUNT.clientSecret, creds.clientSecret),
    keytar.setPassword(KEYCHAIN_SERVICE, ACCOUNT.username, creds.username),
    keytar.setPassword(KEYCHAIN_SERVICE, ACCOUNT.password, creds.password),
    keytar.setPassword(KEYCHAIN_SERVICE, ACCOUNT.userAgent, creds.userAgent),
  ]);
}

/**
 * Check whether any credentials are stored in the keychain.
 */
export async function keychainHasCredentials(): Promise<boolean> {
  const keytar = tryLoadKeytar();
  if (!keytar) return false;
  try {
    const clientId = await keytar.getPassword(KEYCHAIN_SERVICE, ACCOUNT.clientId);
    return clientId !== null && clientId !== "";
  } catch {
    return false;
  }
}
