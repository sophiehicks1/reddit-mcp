#!/usr/bin/env node
/**
 * Reddit MCP Server
 *
 * Provides Claude Code with read-only access to Reddit via the official Reddit
 * OAuth2 API.  Credentials are loaded from the OS keychain (set up with
 * `npm run setup`) and never need to appear in any file or shell config.
 * Environment variables / a local .env file are accepted as a fallback for
 * headless/CI environments.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { loadCredentials } from "./credentials";
import type { Credentials } from "./credentials";

// ---------------------------------------------------------------------------
// Reddit OAuth2 client
// ---------------------------------------------------------------------------

interface RedditToken {
  access_token: string;
  expires_at: number; // epoch ms
}

let cachedToken: RedditToken | null = null;
let cachedCredentials: Credentials | null = null;

async function getCredentials(): Promise<Credentials> {
  if (!cachedCredentials) {
    cachedCredentials = await loadCredentials();
  }
  return cachedCredentials;
}

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with a 60 s buffer)
  if (cachedToken && cachedToken.expires_at > Date.now() + 60_000) {
    return cachedToken.access_token;
  }

  const { clientId, clientSecret, username, password, userAgent } =
    await getCredentials();

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64"
  );

  const body = new URLSearchParams({
    grant_type: "password",
    username,
    password,
  });

  const response = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Reddit OAuth2 error ${response.status}: ${text}`
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    error?: string;
  };

  if (data.error) {
    throw new Error(`Reddit OAuth2 error: ${data.error}`);
  }

  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };

  return cachedToken.access_token;
}

async function redditGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const token = await getAccessToken();
  const userAgent = requireEnv("REDDIT_USER_AGENT");

  const url = new URL(`https://oauth.reddit.com${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": userAgent,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new McpError(
      ErrorCode.InternalError,
      `Reddit API error ${response.status}: ${text}`
    );
  }

  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

interface RedditPost {
  id: string;
  title: string;
  author: string;
  subreddit: string;
  score: number;
  upvote_ratio: number;
  num_comments: number;
  url: string;
  selftext: string;
  is_self: boolean;
  created_utc: number;
  permalink: string;
  flair_text: string | null;
  over_18: boolean;
  stickied: boolean;
}

interface RedditComment {
  id: string;
  author: string;
  body: string;
  score: number;
  created_utc: number;
  depth: number;
  replies?: RedditComment[];
}

function formatPost(data: RedditPost): Record<string, unknown> {
  return {
    id: data.id,
    title: data.title,
    author: data.author,
    subreddit: data.subreddit,
    score: data.score,
    upvote_ratio: data.upvote_ratio,
    num_comments: data.num_comments,
    url: data.url,
    selftext: data.selftext ? data.selftext.slice(0, 2000) : "",
    is_self: data.is_self,
    created_utc: data.created_utc,
    permalink: `https://www.reddit.com${data.permalink}`,
    flair: data.flair_text,
    nsfw: data.over_18,
    stickied: data.stickied,
  };
}

function extractComments(listing: unknown, maxDepth = 5): RedditComment[] {
  if (!listing || typeof listing !== "object") return [];
  const l = listing as { kind?: string; data?: { children?: unknown[] } };
  if (l.kind !== "Listing" || !l.data?.children) return [];

  return l.data.children
    .map((child: unknown) => {
      const c = child as { kind?: string; data?: Record<string, unknown> };
      if (c.kind !== "t1" || !c.data) return null;
      const d = c.data;
      const comment: RedditComment = {
        id: String(d.id ?? ""),
        author: String(d.author ?? "[deleted]"),
        body: String(d.body ?? ""),
        score: Number(d.score ?? 0),
        created_utc: Number(d.created_utc ?? 0),
        depth: Number(d.depth ?? 0),
      };
      if (
        maxDepth > 0 &&
        d.replies &&
        typeof d.replies === "object" &&
        (d.replies as Record<string, unknown>).kind === "Listing"
      ) {
        comment.replies = extractComments(d.replies, maxDepth - 1);
      }
      return comment;
    })
    .filter((c): c is RedditComment => c !== null);
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "reddit-mcp", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ---- List tools -----------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_hot_posts",
      description:
        "Get the current hot posts from a subreddit. Returns post titles, scores, comment counts, and URLs.",
      inputSchema: {
        type: "object",
        properties: {
          subreddit: {
            type: "string",
            description: "Subreddit name without the r/ prefix (e.g. 'python').",
          },
          limit: {
            type: "number",
            description: "Number of posts to return (1–100, default 25).",
          },
        },
        required: ["subreddit"],
      },
    },
    {
      name: "get_new_posts",
      description: "Get the newest posts from a subreddit.",
      inputSchema: {
        type: "object",
        properties: {
          subreddit: {
            type: "string",
            description: "Subreddit name without the r/ prefix.",
          },
          limit: {
            type: "number",
            description: "Number of posts to return (1–100, default 25).",
          },
        },
        required: ["subreddit"],
      },
    },
    {
      name: "get_top_posts",
      description: "Get the top posts from a subreddit over a given time period.",
      inputSchema: {
        type: "object",
        properties: {
          subreddit: {
            type: "string",
            description: "Subreddit name without the r/ prefix.",
          },
          time: {
            type: "string",
            enum: ["hour", "day", "week", "month", "year", "all"],
            description: "Time period (default 'day').",
          },
          limit: {
            type: "number",
            description: "Number of posts to return (1–100, default 25).",
          },
        },
        required: ["subreddit"],
      },
    },
    {
      name: "get_rising_posts",
      description: "Get the rising (trending) posts from a subreddit.",
      inputSchema: {
        type: "object",
        properties: {
          subreddit: {
            type: "string",
            description: "Subreddit name without the r/ prefix.",
          },
          limit: {
            type: "number",
            description: "Number of posts to return (1–100, default 25).",
          },
        },
        required: ["subreddit"],
      },
    },
    {
      name: "search_reddit",
      description:
        "Search Reddit for posts matching a query. Can be restricted to a specific subreddit or search site-wide.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query string.",
          },
          subreddit: {
            type: "string",
            description:
              "Optional subreddit to restrict the search to (without r/ prefix). Omit to search all of Reddit.",
          },
          sort: {
            type: "string",
            enum: ["relevance", "hot", "top", "new", "comments"],
            description: "Sort order for results (default 'relevance').",
          },
          time: {
            type: "string",
            enum: ["hour", "day", "week", "month", "year", "all"],
            description: "Time filter (default 'all').",
          },
          limit: {
            type: "number",
            description: "Number of results to return (1–100, default 25).",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_post_details",
      description:
        "Get full details for a Reddit post including its body text and top-level comments.",
      inputSchema: {
        type: "object",
        properties: {
          post_id: {
            type: "string",
            description:
              "The Reddit post ID (the alphanumeric part of the permalink, e.g. '15abc12').",
          },
          subreddit: {
            type: "string",
            description:
              "The subreddit the post belongs to (without r/ prefix). If omitted, a generic path is used.",
          },
          comment_limit: {
            type: "number",
            description: "Maximum number of top-level comments to return (default 20).",
          },
        },
        required: ["post_id"],
      },
    },
    {
      name: "get_subreddit_info",
      description:
        "Get metadata about a subreddit: description, subscriber count, creation date, and NSFW status.",
      inputSchema: {
        type: "object",
        properties: {
          subreddit: {
            type: "string",
            description: "Subreddit name without the r/ prefix.",
          },
        },
        required: ["subreddit"],
      },
    },
    {
      name: "get_user_profile",
      description:
        "Get public profile information for a Reddit user: karma, account age, and trophy list.",
      inputSchema: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "Reddit username (without the u/ prefix).",
          },
        },
        required: ["username"],
      },
    },
    {
      name: "get_user_posts",
      description: "Get recent posts submitted by a Reddit user.",
      inputSchema: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "Reddit username (without the u/ prefix).",
          },
          limit: {
            type: "number",
            description: "Number of posts to return (1–100, default 25).",
          },
          sort: {
            type: "string",
            enum: ["new", "hot", "top", "controversial"],
            description: "Sort order (default 'new').",
          },
        },
        required: ["username"],
      },
    },
    {
      name: "get_frontpage",
      description:
        "Get the authenticated user's personalized Reddit frontpage (their subscribed subreddits feed).",
      inputSchema: {
        type: "object",
        properties: {
          sort: {
            type: "string",
            enum: ["hot", "new", "top", "rising"],
            description: "Feed sort order (default 'hot').",
          },
          limit: {
            type: "number",
            description: "Number of posts to return (1–100, default 25).",
          },
        },
      },
    },
  ],
}));

// ---- Call tool ------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  function clampLimit(raw: unknown, def = 25): number {
    const n = typeof raw === "number" ? Math.round(raw) : def;
    return Math.min(100, Math.max(1, n));
  }

  try {
    switch (name) {
      // ---- Listing tools ---------------------------------------------------

      case "get_hot_posts":
      case "get_new_posts":
      case "get_rising_posts": {
        const subreddit = String(args.subreddit ?? "");
        if (!subreddit) throw new McpError(ErrorCode.InvalidParams, "subreddit is required");
        const sortMap: Record<string, string> = {
          get_hot_posts: "hot",
          get_new_posts: "new",
          get_rising_posts: "rising",
        };
        const sort = sortMap[name];
        const limit = clampLimit(args.limit);
        const data = await redditGet<{ data: { children: { data: RedditPost }[] } }>(
          `/r/${subreddit}/${sort}`,
          { limit: String(limit) }
        );
        const posts = data.data.children.map((c) => formatPost(c.data));
        return {
          content: [{ type: "text", text: JSON.stringify(posts, null, 2) }],
        };
      }

      case "get_top_posts": {
        const subreddit = String(args.subreddit ?? "");
        if (!subreddit) throw new McpError(ErrorCode.InvalidParams, "subreddit is required");
        const time = String(args.time ?? "day");
        const limit = clampLimit(args.limit);
        const data = await redditGet<{ data: { children: { data: RedditPost }[] } }>(
          `/r/${subreddit}/top`,
          { limit: String(limit), t: time }
        );
        const posts = data.data.children.map((c) => formatPost(c.data));
        return {
          content: [{ type: "text", text: JSON.stringify(posts, null, 2) }],
        };
      }

      // ---- Search ----------------------------------------------------------

      case "search_reddit": {
        const query = String(args.query ?? "");
        if (!query) throw new McpError(ErrorCode.InvalidParams, "query is required");
        const sort = String(args.sort ?? "relevance");
        const time = String(args.time ?? "all");
        const limit = clampLimit(args.limit);
        const params: Record<string, string> = {
          q: query,
          sort,
          t: time,
          limit: String(limit),
          type: "link",
        };
        const path = args.subreddit
          ? `/r/${String(args.subreddit)}/search`
          : "/search";
        if (args.subreddit) params.restrict_sr = "true";

        const data = await redditGet<{ data: { children: { data: RedditPost }[] } }>(
          path,
          params
        );
        const posts = data.data.children.map((c) => formatPost(c.data));
        return {
          content: [{ type: "text", text: JSON.stringify(posts, null, 2) }],
        };
      }

      // ---- Post details ----------------------------------------------------

      case "get_post_details": {
        const postId = String(args.post_id ?? "");
        if (!postId) throw new McpError(ErrorCode.InvalidParams, "post_id is required");
        const commentLimit = clampLimit(args.comment_limit, 20);
        const sub = args.subreddit ? `/r/${String(args.subreddit)}` : "";
        const path = `${sub}/comments/${postId}`;

        const data = await redditGet<unknown[]>(path, {
          limit: String(commentLimit),
          depth: "5",
        });

        if (!Array.isArray(data) || data.length < 1) {
          throw new McpError(ErrorCode.InternalError, "Unexpected response from Reddit API");
        }

        // First element is the post listing
        const postListing = data[0] as { data: { children: { data: RedditPost }[] } };
        const postData = postListing.data.children[0]?.data;
        if (!postData) {
          throw new McpError(ErrorCode.InternalError, "Post not found");
        }
        const post = formatPost(postData);

        // Second element is the comment listing
        const comments = data.length > 1 ? extractComments(data[1]) : [];

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ post, comments }, null, 2),
            },
          ],
        };
      }

      // ---- Subreddit info --------------------------------------------------

      case "get_subreddit_info": {
        const subreddit = String(args.subreddit ?? "");
        if (!subreddit) throw new McpError(ErrorCode.InvalidParams, "subreddit is required");

        const data = await redditGet<{
          data: {
            display_name: string;
            title: string;
            public_description: string;
            description: string;
            subscribers: number;
            active_user_count: number;
            created_utc: number;
            over18: boolean;
            url: string;
            community_icon: string;
          };
        }>(`/r/${subreddit}/about`);

        const d = data.data;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  name: d.display_name,
                  title: d.title,
                  description: d.public_description,
                  subscribers: d.subscribers,
                  active_users: d.active_user_count,
                  created_utc: d.created_utc,
                  nsfw: d.over18,
                  url: `https://www.reddit.com${d.url}`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ---- User profile ----------------------------------------------------

      case "get_user_profile": {
        const username = String(args.username ?? "");
        if (!username) throw new McpError(ErrorCode.InvalidParams, "username is required");

        const data = await redditGet<{
          data: {
            name: string;
            link_karma: number;
            comment_karma: number;
            total_karma: number;
            created_utc: number;
            is_gold: boolean;
            verified: boolean;
            icon_img: string;
          };
        }>(`/user/${username}/about`);

        const d = data.data;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  username: d.name,
                  link_karma: d.link_karma,
                  comment_karma: d.comment_karma,
                  total_karma: d.total_karma,
                  created_utc: d.created_utc,
                  gold: d.is_gold,
                  verified: d.verified,
                  profile_image: d.icon_img,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ---- User posts ------------------------------------------------------

      case "get_user_posts": {
        const username = String(args.username ?? "");
        if (!username) throw new McpError(ErrorCode.InvalidParams, "username is required");
        const sort = String(args.sort ?? "new");
        const limit = clampLimit(args.limit);

        const data = await redditGet<{ data: { children: { data: RedditPost }[] } }>(
          `/user/${username}/submitted`,
          { sort, limit: String(limit) }
        );

        const posts = data.data.children.map((c) => formatPost(c.data));
        return {
          content: [{ type: "text", text: JSON.stringify(posts, null, 2) }],
        };
      }

      // ---- Frontpage -------------------------------------------------------

      case "get_frontpage": {
        const sort = String(args.sort ?? "hot");
        const limit = clampLimit(args.limit);

        const validSorts = ["hot", "new", "top", "rising"];
        const safeSortInput = validSorts.includes(sort) ? sort : "hot";

        const data = await redditGet<{ data: { children: { data: RedditPost }[] } }>(
          `/${safeSortInput}`,
          { limit: String(limit) }
        );

        const posts = data.data.children.map((c) => formatPost(c.data));
        return {
          content: [{ type: "text", text: JSON.stringify(posts, null, 2) }],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new McpError(ErrorCode.InternalError, message);
  }
});

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Reddit MCP server started (stdio transport)");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
