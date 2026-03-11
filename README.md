# reddit-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives Claude Code **read-only access to Reddit** via the official Reddit OAuth2 API.  
You authenticate as your own Reddit account so that Claude can browse your personalized front page, search posts, read threads, and look up user and subreddit information—all without writing a single post or comment.

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
| Hot posts in a subreddit | `get_hot_posts` |
| New posts in a subreddit | `get_new_posts` |
| Top posts in a subreddit | `get_top_posts` |
| Rising posts in a subreddit | `get_rising_posts` |
| Site-wide or subreddit search | `search_reddit` |
| Full post + comments | `get_post_details` |
| Subreddit metadata | `get_subreddit_info` |
| User profile & karma | `get_user_profile` |
| Posts submitted by a user | `get_user_posts` |
| Authenticated front page feed | `get_frontpage` |

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

Copy the example environment file and fill in your credentials:

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

---

## Credential security

Credentials are handled securely in the following ways:

- **Environment variables only** – credentials are loaded from the `.env` file (or the process environment) at runtime. They are never written to disk by the server itself.
- **`.env` is gitignored** – the `.gitignore` file explicitly excludes `.env` to prevent accidental commits to version control.
- **`.env.example` contains no real secrets** – only placeholder values are committed to the repository.
- **Tokens are short-lived** – OAuth2 access tokens (obtained with the `password` grant for script-type apps) expire after 1 hour and are refreshed automatically in-memory. They are never written to disk.
- **Read-only scope** – the OAuth2 flow requests only the `read` permission; the token cannot be used to post, vote, or modify any Reddit content.
- **Principle of least privilege** – if you want extra isolation, run the server in a dedicated OS user account or a container with minimal permissions.

---

## Adding to Claude Code

After building the project, register the MCP server with Claude Code.

### Option A – Claude Code CLI

```bash
claude mcp add reddit-mcp -- node /absolute/path/to/reddit-mcp/dist/index.js
```

Then set the required environment variables in the Claude Code MCP configuration or export them in your shell before launching Claude Code.

### Option B – `claude_desktop_config.json` (Claude Desktop)

Add the server to your MCP configuration file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

> **Tip**: Store sensitive values as OS-level environment variables and reference them from your shell profile rather than pasting them directly into the JSON file.

---

## Available tools

### `get_hot_posts`

Returns the current hot posts in a subreddit.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `subreddit` | string | ✅ | Subreddit name (without `r/`) |
| `limit` | number | | Posts to return, 1–100 (default 25) |

---

### `get_new_posts`

Returns the most recent posts in a subreddit.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `subreddit` | string | ✅ | Subreddit name (without `r/`) |
| `limit` | number | | Posts to return, 1–100 (default 25) |

---

### `get_top_posts`

Returns the top-scoring posts in a subreddit over a given time window.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `subreddit` | string | ✅ | Subreddit name (without `r/`) |
| `time` | string | | `hour` \| `day` \| `week` \| `month` \| `year` \| `all` (default `day`) |
| `limit` | number | | Posts to return, 1–100 (default 25) |

---

### `get_rising_posts`

Returns trending/rising posts in a subreddit.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `subreddit` | string | ✅ | Subreddit name (without `r/`) |
| `limit` | number | | Posts to return, 1–100 (default 25) |

---

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

Fetches the full body text of a post and its comments (up to 5 levels deep).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `post_id` | string | ✅ | Reddit post ID (alphanumeric, e.g. `15abc12`) |
| `subreddit` | string | | Subreddit the post belongs to (speeds up the API call) |
| `comment_limit` | number | | Max top-level comments to return (default 20) |

The post ID can be found in the URL:  
`reddit.com/r/python/comments/**15abc12**/my_post_title/`

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

Returns posts recently submitted by a user.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `username` | string | ✅ | Reddit username (without `u/`) |
| `sort` | string | | `new` \| `hot` \| `top` \| `controversial` (default `new`) |
| `limit` | number | | Posts to return, 1–100 (default 25) |

---

### `get_frontpage`

Returns posts from the authenticated user's personalized front page (based on their subscribed subreddits).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sort` | string | | `hot` \| `new` \| `top` \| `rising` (default `hot`) |
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
