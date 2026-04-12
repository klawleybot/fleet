/**
 * Fetch NEW comments on Klawley coins.
 *
 * Two modes:
 * - **Our coins** (created by our wallet): reply to ALL new comments
 * - **Held coins** (we own but didn't create): ONLY reply if we're tagged
 *   (mentions @openklaw, our wallet address, or our handle)
 *
 * Reads state from zora-notif-state.json, fetches comments via SDK,
 * deduplicates, and outputs only actionable new comments as JSON.
 *
 * Does NOT update state — caller is responsible for that after processing.
 *
 * Usage:
 *   bun x tsx scripts/fetch-new-comments.ts
 *   bun x tsx scripts/fetch-new-comments.ts --update-state   # also writes state after fetch
 *
 * Output (stdout): JSON array of new comments
 * [
 *   {
 *     "coinAddress": "0x...",
 *     "coinSymbol": "$OPENKLAW",
 *     "commentId": "0x...",
 *     "nonce": "0x...",
 *     "commenterAddress": "0x...",
 *     "commenterHandle": "someuser",
 *     "text": "gm lobster",
 *     "timestamp": "2026-03-05T04:00:00Z",
 *     "isOurCoin": true
 *   }
 * ]
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(__dirname, "../.data/zora-notif-state.json");
const CREATOR_COIN = "0x2e6e49e3f1c76d9b8c7ca0bee2005ed6de0e2046";
const OUR_SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d";

// Coins to ALWAYS monitor for comments, even if not in profile balances.
// Populated at runtime from trend_posts DB + hardcoded pins.
const ALWAYS_MONITOR_HARDCODED: Array<{ address: string; symbol: string }> = [
  { address: "0x4d70f5970b0b6b3edc7c9e6e4ceb69e8b8f9e642", symbol: "$CLAWD" },
];
const OUR_EOA = "0x5149dfcd59489a9b1489278bf79e538026c23a17";
const OUR_ADDRESSES = new Set([OUR_SMART_WALLET, OUR_EOA]);

/** Patterns that indicate a comment is tagging us */
const OUR_MENTION_PATTERNS = [
  "openklaw",
  "klawley",
  OUR_SMART_WALLET,
  OUR_EOA,
  // Zora markdown mention format: [@openklaw](https://zora.co/@...)
  "@openklaw",
];

interface StateFile {
  lastCheckedAt: string;
  repliedCommentIds: string[];
}

interface NewComment {
  coinAddress: string;
  coinSymbol: string;
  commentId: string;
  nonce: string;
  commenterAddress: string;
  commenterHandle: string | null;
  text: string;
  timestamp: string;
  isOurCoin: boolean;
}

/** Check if comment text mentions us */
function mentionsUs(text: string): boolean {
  const lower = text.toLowerCase();
  return OUR_MENTION_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

function loadState(): StateFile {
  if (!existsSync(STATE_PATH)) {
    return { lastCheckedAt: new Date(0).toISOString(), repliedCommentIds: [] };
  }
  return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
}

function saveState(state: StateFile) {
  // Keep only last 500 IDs
  state.repliedCommentIds = state.repliedCommentIds.slice(-500);
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

interface CoinInfo {
  address: string;
  symbol: string;
  isOurs: boolean; // true = we created it, false = we just hold it
}

type CoinsSdkModule = typeof import("@zoralabs/coins-sdk");

interface CommentNode {
  id?: string;
  txHash?: string;
  nonce?: string;
  userAddress?: string;
  userProfile?: {
    handle?: string | null;
  };
  comment?: string;
  timestamp?: string | number;
  createdAt?: string;
}

interface CommentEdge {
  node: CommentNode;
}

async function discoverCoins(): Promise<CoinInfo[]> {
  const sdk = (await import("@zoralabs/coins-sdk")) as CoinsSdkModule;
  if (process.env.ZORA_API_KEY && sdk.setApiKey) {
    sdk.setApiKey(process.env.ZORA_API_KEY);
  }

  const coins: CoinInfo[] = [];
  const seen = new Set<string>();

  // Always include creator coin (ours by definition)
  coins.push({ address: CREATOR_COIN, symbol: "$openklaw", isOurs: true });
  seen.add(CREATOR_COIN);

  // Always include hardcoded pins
  for (const pinned of ALWAYS_MONITOR_HARDCODED) {
    if (!seen.has(pinned.address)) {
      coins.push({ address: pinned.address, symbol: pinned.symbol, isOurs: true });
      seen.add(pinned.address);
    }
  }

  // Include all coins we created from the DB (daily content coins + trend coins + any others)
  try {
    const Database = (await import("better-sqlite3")).default;
    const dbPath = resolve(__dirname, "../.data/zora-intelligence.db");
    const db = new Database(dbPath, { readonly: true });

    // All coins where we are the creator (catches daily drops, trend content, everything)
    const ourCreatedCoins = db.prepare(
      `SELECT address, symbol FROM coins
       WHERE LOWER(creator_address) IN (${[...OUR_ADDRESSES].map(a => `'${a}'`).join(",")})
       ORDER BY indexed_at DESC`
    ).all() as Array<{ address: string; symbol: string }>;
    let addedFromCoinsTable = 0;
    for (const oc of ourCreatedCoins) {
      const addr = oc.address.toLowerCase();
      if (!seen.has(addr)) {
        coins.push({ address: addr, symbol: `$${oc.symbol}`, isOurs: true });
        seen.add(addr);
        addedFromCoinsTable++;
      }
    }
    console.error(`[fetch-new-comments] Added ${addedFromCoinsTable} coins from coins table (our creations)`);

    // Also include deployed trend content coins (in case they're not in coins table yet)
    const trendCoins = db.prepare(
      "SELECT content_coin_address, symbol FROM trend_posts WHERE content_coin_address IS NOT NULL AND status IN ('deployed', 'partial_sold')"
    ).all() as Array<{ content_coin_address: string; symbol: string }>;
    let addedFromTrend = 0;
    for (const tc of trendCoins) {
      const addr = tc.content_coin_address.toLowerCase();
      if (!seen.has(addr)) {
        coins.push({ address: addr, symbol: `$${tc.symbol}`, isOurs: true });
        seen.add(addr);
        addedFromTrend++;
      }
    }
    if (addedFromTrend > 0) {
      console.error(`[fetch-new-comments] Added ${addedFromTrend} additional trend coins from trend_posts`);
    }

    db.close();
  } catch (err) {
    console.error("[fetch-new-comments] Failed to load coins from DB:", err);
  }

  // Get profile balances — includes creatorAddress so we can classify
  try {
    const result = await sdk.getProfileBalances({
      identifier: "openklaw",
      count: 50,
    });
    const edges = result?.data?.profile?.coinBalances?.edges ?? [];
    for (const edge of edges) {
      const coin = edge.node?.coin;
      const addr = (coin?.address ?? "").toLowerCase();
      const sym = coin?.symbol ?? "???";
      const creator = (coin?.creatorAddress ?? "").toLowerCase();
      if (addr && !seen.has(addr)) {
        const isOurs = OUR_ADDRESSES.has(creator);
        coins.push({ address: addr, symbol: `$${sym}`, isOurs });
        seen.add(addr);
      }
    }
  } catch (err) {
    console.error("[fetch-new-comments] Failed to fetch profile balances:", err);
  }

  const ourCount = coins.filter(c => c.isOurs).length;
  const heldCount = coins.filter(c => !c.isOurs).length;
  console.error(`[fetch-new-comments] ${ourCount} created coins, ${heldCount} held coins`);

  return coins;
}

async function fetchComments(
  coinAddress: string,
  limit = 20,
): Promise<Array<{
  id: string;
  nonce: string;
  userAddress: string;
  userHandle: string | null;
  comment: string;
  timestamp: string;
}>> {
  const sdk = (await import("@zoralabs/coins-sdk")) as CoinsSdkModule;

  try {
    const result = await sdk.getCoinComments({
      address: coinAddress,
      chain: 8453,
      count: limit,
    });

    const edges = result?.data?.zora20Token?.zoraComments?.edges ?? [];
    return (edges as CommentEdge[]).map((e) => {
      const node = e.node;
      return {
        id: node.id ?? node.txHash ?? "",
        nonce: node.nonce ?? "",
        userAddress: (node.userAddress ?? "").toLowerCase(),
        userHandle: node.userProfile?.handle ?? null,
        comment: node.comment ?? "",
        timestamp: node.timestamp
          ? new Date(Number(node.timestamp) * 1000).toISOString()
          : node.createdAt ?? "",
      };
    });
  } catch (err) {
    console.error(`[fetch-new-comments] Failed to fetch comments for ${coinAddress}:`, err);
    return [];
  }
}

async function main() {
  const updateState = process.argv.includes("--update-state");
  const state = loadState();
  const repliedSet = new Set(state.repliedCommentIds);
  const lastChecked = new Date(state.lastCheckedAt).getTime();

  // Step 1: Discover coins
  const coins = await discoverCoins();
  console.error(`[fetch-new-comments] Discovered ${coins.length} coins`);

  // Step 2: Fetch comments for each coin
  const newComments: NewComment[] = [];

  for (const coin of coins) {
    const comments = await fetchComments(coin.address, 20);

    for (const c of comments) {
      // Skip our own comments
      if (OUR_ADDRESSES.has(c.userAddress)) continue;

      // Skip already-replied comments
      if (repliedSet.has(c.id) || repliedSet.has(c.nonce)) continue;

      // Skip comments older than last check (optimization: stop early since newest-first)
      const commentTime = new Date(c.timestamp).getTime();
      if (commentTime && commentTime < lastChecked) {
        break;
      }

      // For coins we DON'T own: only include if we're tagged
      if (!coin.isOurs && !mentionsUs(c.comment)) {
        continue;
      }

      newComments.push({
        coinAddress: coin.address,
        coinSymbol: coin.symbol,
        commentId: c.id,
        nonce: c.nonce,
        commenterAddress: c.userAddress,
        commenterHandle: c.userHandle,
        text: c.comment,
        timestamp: c.timestamp,
        isOurCoin: coin.isOurs,
      });
    }

    // Small rate limit delay between coins
    await new Promise(r => setTimeout(r, 150));
  }

  // Sort by timestamp (newest first)
  newComments.sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  // Output
  console.log(JSON.stringify(newComments, null, 2));

  if (newComments.length > 0) {
    console.error(`[fetch-new-comments] Found ${newComments.length} new comment(s)`);
  } else {
    console.error(`[fetch-new-comments] No new comments`);
  }

  // Optionally update state
  if (updateState) {
    state.lastCheckedAt = new Date().toISOString();
    for (const c of newComments) {
      if (c.commentId && !repliedSet.has(c.commentId)) {
        state.repliedCommentIds.push(c.commentId);
      }
      if (c.nonce && !repliedSet.has(c.nonce)) {
        state.repliedCommentIds.push(c.nonce);
      }
    }
    saveState(state);
    console.error(`[fetch-new-comments] State updated`);
  }
}

main().catch((err) => {
  console.error("[fetch-new-comments] Fatal:", err);
  process.exit(1);
});
