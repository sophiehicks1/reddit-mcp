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
    throw new Error(`Reddit OAuth2 error ${response.status}: ${text}`);
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

async function redditGet<T>(
  path: string,
  params?: Record<string, string>
): Promise<T> {
  const token = await getAccessToken();
  const { userAgent } = await getCredentials();

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
// Post formatting helper
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

// ---------------------------------------------------------------------------
// Full comment-tree fetching
//
// Reddit returns "more" objects wherever it has truncated the thread, both
// for breadth (too many siblings) and depth (reply chain too deep).  We must
// resolve them iteratively via GET /api/morechildren until none remain.
//
// Strategy:
//  1. Fetch the initial post+comments response (high limit, no depth cap).
//  2. Walk the tree: store every t1 comment in a flat map keyed by ID; collect
//     every "more" stub into a pending queue.
//  3. Loop: batch the pending IDs (≤100 per API call), call /api/morechildren,
//     add resulting t1 comments to the flat map, queue any new "more" stubs.
//  4. When the queue is empty, reconstruct the nested tree from the flat map
//     using parent_id links and the insertion-order maps built in steps 2–3.
// ---------------------------------------------------------------------------

/** Flat representation of a single comment used during tree construction. */
interface FlatComment {
  id: string;
  author: string;
  body: string;
  score: number;
  created_utc: number;
  depth: number;
  parent_id: string; // full Reddit name, e.g. "t1_abc" or "t3_xyz"
}

/** A "more" stub: a list of comment IDs that still need to be fetched. */
interface MoreStub {
  ids: string[];
  parent_id: string; // full Reddit name of the parent
}

/** The output comment shape returned to the caller. */
interface RedditComment {
  id: string;
  author: string;
  body: string;
  score: number;
  created_utc: number;
  depth: number;
  replies: RedditComment[];
}

/**
 * Recursively walk one Listing node from the initial API response, populating
 * commentMap / replyOrder and collecting any "more" stubs.
 */
function walkListing(
  listing: unknown,
  commentMap: Map<string, FlatComment>,
  replyOrder: Map<string, string[]>,
  pending: MoreStub[]
): void {
  if (!listing || typeof listing !== "object") return;
  const l = listing as { kind?: string; data?: { children?: unknown[] } };
  if (l.kind !== "Listing" || !Array.isArray(l.data?.children)) return;

  for (const child of l.data!.children!) {
    const c = child as { kind?: string; data?: Record<string, unknown> };
    if (!c.data) continue;

    if (c.kind === "t1") {
      const d = c.data;
      const id = String(d.id ?? "");
      const parentFullId = String(d.parent_id ?? "");

      commentMap.set(id, {
        id,
        author: String(d.author ?? "[deleted]"),
        body: String(d.body ?? ""),
        score: Number(d.score ?? 0),
        created_utc: Number(d.created_utc ?? 0),
        depth: Number(d.depth ?? 0),
        parent_id: parentFullId,
      });

      // Record this comment under its parent's ordered reply list.
      const parentId = parentFullId.replace(/^t\d+_/, "");
      if (!replyOrder.has(parentId)) replyOrder.set(parentId, []);
      replyOrder.get(parentId)!.push(id);

      // Recurse into inline replies.
      if (
        d.replies &&
        typeof d.replies === "object" &&
        (d.replies as Record<string, unknown>).kind === "Listing"
      ) {
        walkListing(d.replies, commentMap, replyOrder, pending);
      }
    } else if (c.kind === "more") {
      const d = c.data;
      const ids = Array.isArray(d.children) ? d.children.map(String) : [];
      if (ids.length > 0) {
        pending.push({
          ids,
          parent_id: String(d.parent_id ?? ""),
        });
      }
    }
  }
}

/**
 * Maximum number of /api/morechildren API calls to issue for a single
 * get_post_details request.
 *
 * Each call fetches up to BATCH_SIZE (100) comment IDs. At Reddit's OAuth
 * rate limit of 60 requests/minute, 100,000 calls equates to roughly 28 hours
 * of API time and up to ~10m comments in the best case (fewer when
 * comments are deleted or batches are smaller), so this limit is essentially
 * infinite. Posts that still have unresolved stubs after this cap will include
 * a warning in the response.
 */
const MAX_MORE_CALLS = 100000;

/**
 * Resolve all "more" stubs by iteratively calling /api/morechildren.
 * Returns true when the tree is fully resolved, false when the call cap was
 * reached, a batch failed, or some stubs remain unresolved.
 */
async function resolveAllMore(
  postFullName: string,
  commentMap: Map<string, FlatComment>,
  replyOrder: Map<string, string[]>,
  initialPending: MoreStub[]
): Promise<boolean> {
  const BATCH_SIZE = 100;
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1000;
  let pending = initialPending;
  let callCount = 0;
  let fullyResolved = true;

  while (pending.length > 0) {
    const nextRound: MoreStub[] = [];

    for (const stub of pending) {
      for (let i = 0; i < stub.ids.length; i += BATCH_SIZE) {
        if (callCount >= MAX_MORE_CALLS) {
          fullyResolved = false;
          break;
        }

        const batch = stub.ids.slice(i, i + BATCH_SIZE);
        callCount++;

        let success = false;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            const result = await redditGet<{
              json: {
                data: {
                  things: Array<{
                    kind: string;
                    data: Record<string, unknown>;
                  }>;
                };
              };
            }>("/api/morechildren", {
              link_id: postFullName,
              children: batch.join(","),
              api_type: "json",
            });

            const things = result?.json?.data?.things ?? [];

            for (const thing of things) {
              if (thing.kind === "t1") {
                const d = thing.data;
                const id = String(d.id ?? "");
                const parentFullId = String(d.parent_id ?? stub.parent_id);

                commentMap.set(id, {
                  id,
                  author: String(d.author ?? "[deleted]"),
                  body: String(d.body ?? ""),
                  score: Number(d.score ?? 0),
                  created_utc: Number(d.created_utc ?? 0),
                  depth: Number(d.depth ?? 0),
                  parent_id: parentFullId,
                });

                const parentId = parentFullId.replace(/^t\d+_/, "");
                if (!replyOrder.has(parentId)) replyOrder.set(parentId, []);
                replyOrder.get(parentId)!.push(id);
              } else if (thing.kind === "more") {
                const d = thing.data;
                const ids = Array.isArray(d.children)
                  ? d.children.map(String)
                  : [];
                if (ids.length > 0) {
                  nextRound.push({
                    ids,
                    parent_id: String(d.parent_id ?? stub.parent_id),
                  });
                }
              }
            }

            success = true;
            break;
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const isRetryable = /\b(429|5\d{2})\b/.test(errMsg);
            if (isRetryable && attempt < MAX_RETRIES - 1) {
              const delay = BASE_DELAY_MS * Math.pow(2, attempt);
              await new Promise((resolve) => setTimeout(resolve, delay));
              continue;
            }
            // Final attempt failed or non-retryable error — log and continue.
            console.error(
              `morechildren batch failed (${batch.length} ids, attempt ${attempt + 1}): ${err}`
            );
          }
        }

        if (!success) {
          fullyResolved = false;
        }
      }

      if (!fullyResolved) break;
    }

    pending = nextRound;
    if (!fullyResolved) break;
  }

  return fullyResolved;
}

/**
 * Build the nested RedditComment tree from the flat maps gathered during
 * tree traversal.  Comments whose parent is missing (e.g. deleted parents or
 * partial fetches) are surfaced as additional top-level entries so they are
 * not silently dropped.
 */
function buildCommentTree(
  rootId: string,
  commentMap: Map<string, FlatComment>,
  replyOrder: Map<string, string[]>
): RedditComment[] {
  function build(id: string): RedditComment | null {
    const flat = commentMap.get(id);
    if (!flat) return null;

    const childIds = replyOrder.get(id) ?? [];
    const replies = childIds
      .map(build)
      .filter((c): c is RedditComment => c !== null);

    return {
      id: flat.id,
      author: flat.author,
      body: flat.body,
      score: flat.score,
      created_utc: flat.created_utc,
      depth: flat.depth,
      replies,
    };
  }

  // Track which comments are reachable from the true root subtree.
  const visited = new Set<string>();
  function markReachable(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    const childIds = replyOrder.get(id) ?? [];
    for (const childId of childIds) {
      markReachable(childId);
    }
  }

  // Start with the normal top-level replies to the post/root.
  const topLevelIds = replyOrder.get(rootId) ?? [];
  for (const id of topLevelIds) {
    markReachable(id);
  }

  // Surface comments whose parent is missing (e.g. deleted/removed parents
  // or partial fetches) as additional top-level roots so they aren't dropped.
  const orphanRootIds: string[] = [];
  for (const flat of commentMap.values()) {
    if (visited.has(flat.id)) continue;

    const parentId = flat.parent_id.replace(/^t\d+_/, "");
    const parentMissing =
      !parentId || (parentId !== rootId && !commentMap.has(parentId));

    if (parentMissing) {
      orphanRootIds.push(flat.id);
      markReachable(flat.id);
    }
  }

  const allRootIds = [...topLevelIds, ...orphanRootIds];
  return allRootIds
    .map(build)
    .filter((c): c is RedditComment => c !== null);
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "reddit-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---- List tools -----------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
        "Get the full body text and complete comment tree for a Reddit post. " +
        "All comments at every depth level are returned — the server transparently " +
        "resolves Reddit's pagination tokens so you always get the full discussion.",
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
              "The subreddit the post belongs to (without r/ prefix). Optional but speeds up the request.",
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
        "Get public profile information for a Reddit user: karma, account age, and verification status.",
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
      description: "Get posts submitted by a Reddit user.",
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
  ],
}));

// ---- Call tool ------------------------------------------------------------

/**
 * Validate that a string looks like a valid Reddit identifier (subreddit name,
 * username, or post ID).  Reddit identifiers are alphanumeric with underscores
 * and hyphens; they must not contain path separators, query strings, or other
 * characters that could alter the request endpoint.
 */
const REDDIT_ID_RE = /^[A-Za-z0-9_\-]+$/;

function validateRedditId(value: string, label: string): void {
  if (!REDDIT_ID_RE.test(value)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid ${label}: must contain only alphanumeric characters, underscores, or hyphens.`
    );
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  function clampLimit(raw: unknown, def = 25): number {
    const n = typeof raw === "number" ? Math.round(raw) : def;
    return Math.min(100, Math.max(1, n));
  }

  try {
    switch (name) {
      // ---- Search ----------------------------------------------------------

      case "search_reddit": {
        const query = String(args.query ?? "");
        if (!query)
          throw new McpError(ErrorCode.InvalidParams, "query is required");
        if (args.subreddit) validateRedditId(String(args.subreddit), "subreddit");
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

        const data = await redditGet<{
          data: { children: { data: RedditPost }[] };
        }>(path, params);
        const posts = data.data.children.map((c) => formatPost(c.data));
        return {
          content: [{ type: "text", text: JSON.stringify(posts, null, 2) }],
        };
      }

      // ---- Post details (full comment tree) --------------------------------

      case "get_post_details": {
        const postId = String(args.post_id ?? "");
        if (!postId)
          throw new McpError(ErrorCode.InvalidParams, "post_id is required");
        validateRedditId(postId, "post_id");
        if (args.subreddit) validateRedditId(String(args.subreddit), "subreddit");

        const sub = args.subreddit ? `/r/${String(args.subreddit)}` : "";

        // Fetch the post and as many comments as Reddit will return in one go.
        // limit=500 requests the maximum number of top-level comment stubs;
        // omitting depth lets Reddit use its default (which already goes quite
        // deep).  "more" stubs at any level are resolved below.
        const data = await redditGet<unknown[]>(`${sub}/comments/${postId}`, {
          limit: "500",
        });

        if (!Array.isArray(data) || data.length < 1) {
          throw new McpError(
            ErrorCode.InternalError,
            "Unexpected response from Reddit API"
          );
        }

        // --- Parse the post --------------------------------------------------
        const postListing = data[0] as {
          data: { children: { data: RedditPost }[] };
        };
        const postData = postListing.data.children[0]?.data;
        if (!postData) {
          throw new McpError(ErrorCode.InternalError, "Post not found");
        }
        const post = formatPost(postData);
        const postFullName = `t3_${postId}`;

        // --- Walk the initial comment listing --------------------------------
        const commentMap = new Map<string, FlatComment>();
        const replyOrder = new Map<string, string[]>(); // parent id → ordered child ids
        const pending: MoreStub[] = [];

        if (data.length > 1) {
          walkListing(data[1], commentMap, replyOrder, pending);
        }

        // --- Resolve all "more" stubs ----------------------------------------
        const fullyResolved = await resolveAllMore(
          postFullName,
          commentMap,
          replyOrder,
          pending
        );

        // --- Build and return the nested tree --------------------------------
        const comments = buildCommentTree(postId, commentMap, replyOrder);

        const result: Record<string, unknown> = { post, comments };
        if (!fullyResolved) {
          result.warning =
            `This post has an exceptionally large comment section. ` +
            `The server reached the API call budget (${MAX_MORE_CALLS} requests) ` +
            `before the full tree could be fetched; some comments may be missing.`;
        }

        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      }

      // ---- Subreddit info --------------------------------------------------

      case "get_subreddit_info": {
        const subreddit = String(args.subreddit ?? "");
        if (!subreddit)
          throw new McpError(ErrorCode.InvalidParams, "subreddit is required");
        validateRedditId(subreddit, "subreddit");

        const data = await redditGet<{
          data: {
            display_name: string;
            title: string;
            public_description: string;
            subscribers: number;
            active_user_count: number;
            created_utc: number;
            over18: boolean;
            url: string;
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
        if (!username)
          throw new McpError(ErrorCode.InvalidParams, "username is required");
        validateRedditId(username, "username");

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
        if (!username)
          throw new McpError(ErrorCode.InvalidParams, "username is required");
        validateRedditId(username, "username");
        const sort = String(args.sort ?? "new");
        const limit = clampLimit(args.limit);

        const data = await redditGet<{
          data: { children: { data: RedditPost }[] };
        }>(`/user/${username}/submitted`, { sort, limit: String(limit) });

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
