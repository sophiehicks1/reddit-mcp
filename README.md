# reddit-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives Claude Code **read-only access to Reddit** for research purposes via the official Reddit OAuth2 API.  
You authenticate as your own Reddit account so that Claude can search posts, read full discussions, and look up subreddit and user information—all without writing a single post or comment.

---

## Table of contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Reddit app setup](#reddit-app-setup)
- [Configuration](#configuration)
- [Credential security](#credential-security)
- [Adding to Claude Code](#adding-to-claude-code)
- [Available tools](#available-tools)
- [Development](#development)

---

## Features

| Capability | Tool name |
|---|---|
| Site-wide or subreddit search | `search_reddit` |
| Full post + **complete** comment tree | `get_post_details` |
| Subreddit metadata | `get_subreddit_info` |
| User profile & karma | `get_user_profile` |
| Posts submitted by a user | `get_user_posts` |

All operations are **read-only**—the server requests only the `read` OAuth scope and never writes to Reddit.

---

## Prerequisites

- **Node.js ≥ 18** (built-in `fetch` is required; Node 24 recommended)
- **npm ≥ 9**
- A Reddit account
- A Reddit "script" OAuth2 application (free, takes ~2 minutes to create)

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/sophiehicks1/reddit-mcp.git
cd reddit-mcp

# 2. Install dependencies
npm install

# 3. Build the TypeScript source
npm run build
```

---

## Reddit app setup

You need a **"script"** type Reddit OAuth2 application to authenticate as yourself:

1. Go to <https://www.reddit.com/prefs/apps> and click **"create another app…"**
2. Fill in the form:
   - **Name**: anything you like (e.g. `my-claude-mcp`)
   - **Type**: select **script**
   - **Redirect URI**: `http://localhost` (required by the form; not actually used)
3. Click **Create app**.
4. Note the values you will need:
   - **Client ID** – the short alphanumeric string shown *under* the app name (just below "personal use script")
   - **Client Secret** – the longer string next to the "secret" label

---

## Configuration

The recommended way to configure credentials is via the **OS keychain**:

```bash
npm run setup
```

This interactive command prompts for your Reddit app credentials and stores them
securely in the OS keychain (macOS Keychain, Windows Credential Manager, or
Linux Secret Service via libsecret).  No files are written to disk and no
environment variables are needed.

### Fallback: `.env` file

If the OS keychain is not available (e.g. headless servers, CI), the setup
script will fall back to writing a `.env` file with restrictive permissions
(`600`).  You can also create one manually:

```bash
cp .env.example .env
```

Edit `.env`:

```dotenv
# Reddit OAuth2 application credentials
REDDIT_CLIENT_ID=your_client_id_here
REDDIT_CLIENT_SECRET=your_client_secret_here

# Your Reddit account credentials
REDDIT_USERNAME=your_reddit_username
REDDIT_PASSWORD=your_reddit_password

# User-agent string (Reddit API requirement)
# Format: <platform>:<app_id>:<version> (by /u/<username>)
REDDIT_USER_AGENT=node:reddit-mcp:v1.0.0 (by /u/your_reddit_username)
```

> **Never share or commit your `.env` file.**  
> The file is already listed in `.gitignore` to prevent accidental commits.

### Fallback: environment variables

You can also export the variables directly in your shell or pass them through
your MCP host configuration.  See the [environment variable reference](#environment-variable-reference) for the full list.

---

## Credential security

Credentials are resolved at runtime in the following order (highest priority first):

1. **OS keychain** (recommended) – stored via `npm run setup` in macOS Keychain, Windows Credential Manager, or Linux Secret Service.  Credentials never touch the filesystem and are protected by OS-level access controls.
2. **Environment variables** – `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, etc. can be set in the process environment.  Useful for CI or container deployments.
3. **`.env` file** – loaded via [dotenv](https://github.com/motdotla/dotenv) from the project root.  Created with `600` permissions by the setup script when the keychain is unavailable.

Additional safeguards:

- **`.env` is gitignored** – the `.gitignore` file explicitly excludes `.env` to prevent accidental commits to version control.
- **`.env.example` contains no real secrets** – only placeholder values are committed to the repository.
- **Tokens are short-lived** – OAuth2 access tokens (obtained with the `password` grant for script-type apps) expire after 1 hour and are refreshed automatically in-memory. They are never written to disk.
- **Read-only scope** – the OAuth2 flow requests only the `read` permission; the token cannot be used to post, vote, or modify any Reddit content.
- **Principle of least privilege** – if you want extra isolation, run the server in a dedicated OS user account or a container with minimal permissions.

---

## Adding to Claude Code

After building the project, register the MCP server with Claude Code.

If you ran `npm run setup` to store credentials in the OS keychain, no
environment variables need to be configured — the server loads them
automatically.

### Option A – Claude Code CLI

```bash
claude mcp add reddit-mcp -- node /absolute/path/to/reddit-mcp/dist/index.js
```

If you are **not** using the keychain, set the required environment variables in
the Claude Code MCP configuration or export them in your shell before launching
Claude Code.

### Option B – `claude_desktop_config.json` (Claude Desktop)

Add the server to your MCP configuration file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS).

With **keychain credentials** (recommended — no `env` block needed):

```json
{
  "mcpServers": {
    "reddit-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/reddit-mcp/dist/index.js"]
    }
  }
}
```

With **environment variables** (fallback for headless/CI environments):

```json
{
  "mcpServers": {
    "reddit-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/reddit-mcp/dist/index.js"],
      "env": {
        "REDDIT_CLIENT_ID": "your_client_id_here",
        "REDDIT_CLIENT_SECRET": "your_client_secret_here",
        "REDDIT_USERNAME": "your_reddit_username",
        "REDDIT_PASSWORD": "your_reddit_password",
        "REDDIT_USER_AGENT": "node:reddit-mcp:v1.0.0 (by /u/your_reddit_username)"
      }
    }
  }
}
```

> **Tip**: Prefer `npm run setup` (OS keychain) over pasting secrets into JSON config files.

---

## Available tools

### `search_reddit`

Searches Reddit for posts matching a query, optionally restricted to a single subreddit.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✅ | Search query |
| `subreddit` | string | | Restrict to this subreddit (without `r/`) |
| `sort` | string | | `relevance` \| `hot` \| `top` \| `new` \| `comments` (default `relevance`) |
| `time` | string | | `hour` \| `day` \| `week` \| `month` \| `year` \| `all` (default `all`) |
| `limit` | number | | Results to return, 1–100 (default 25) |

---

### `get_post_details`

Fetches the full body text of a post and its **complete** comment tree.

Reddit's API paginates large threads using continuation tokens ("more" objects).
This tool transparently resolves all such tokens — issuing as many follow-up
requests as needed — so the entire discussion is returned in a single call.
You never need to think about pagination or depth limits.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `post_id` | string | ✅ | Reddit post ID (alphanumeric, e.g. `15abc12`) |
| `subreddit` | string | | Subreddit the post belongs to (optional, speeds up the request) |

The post ID can be found in the URL:  
`reddit.com/r/python/comments/**15abc12**/my_post_title/`

> **Note**: For posts with very large comment sections (tens of thousands of
> comments) the tool will include a `warning` field in the response if the
> complete tree could not be fetched within the API call budget.

---

### `get_subreddit_info`

Returns metadata about a subreddit: title, description, subscriber count, active users, creation date, and NSFW status.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `subreddit` | string | ✅ | Subreddit name (without `r/`) |

---

### `get_user_profile`

Returns public profile information for a Reddit user: karma breakdown, account age, gold status, and verification status.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `username` | string | ✅ | Reddit username (without `u/`) |

---

### `get_user_posts`

Returns posts submitted by a user.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `username` | string | ✅ | Reddit username (without `u/`) |
| `sort` | string | | `new` \| `hot` \| `top` \| `controversial` (default `new`) |
| `limit` | number | | Posts to return, 1–100 (default 25) |

---

## Development

```bash
# Watch-compile TypeScript
npx tsc --watch

# Run directly with ts-node (no build step)
npm run dev
```

### Environment variable reference

| Variable | Description |
|---|---|
| `REDDIT_CLIENT_ID` | OAuth2 client ID from your Reddit app |
| `REDDIT_CLIENT_SECRET` | OAuth2 client secret from your Reddit app |
| `REDDIT_USERNAME` | Your Reddit username |
| `REDDIT_PASSWORD` | Your Reddit password |
| `REDDIT_USER_AGENT` | Unique user-agent string (required by Reddit API) |
