import fs from "node:fs";
import path from "node:path";
import * as zoraSdk from "@zoralabs/coins-sdk";
import { env } from "./config.js";
import { db, getUnsentAlerts, markAlertsSent, upsertCoin } from "./db.js";
import { dedupeAlertRows } from "./alerts-dedupe.js";
import { selectDiverseAlerts } from "./alerts-diversity.js";
import { generateBatchCommentary } from "./commentary.js";
import { uploadToArweave } from "./arweave.js";

const getCoinSwaps = (zoraSdk as any).getCoinSwaps as (args: any) => Promise<any>;
const getCoinsNew = (zoraSdk as any).getCoinsNew as (args: any) => Promise<any>;
const getCoinsTopVolume24h = (zoraSdk as any).getCoinsTopVolume24h as (args: any) => Promise<any>;
const getCoin = (zoraSdk as any).getCoin as (args: any) => Promise<any>;
const setApiKey = (zoraSdk as any).setApiKey as ((apiKey: string) => void) | undefined;

if (env.ZORA_API_KEY && setApiKey) setApiKey(env.ZORA_API_KEY);

type Edge = { node: any; cursor?: string };
const ALERTS_LOG_PATH = "./logs/alerts.log";

function appendAlertLog(line: string) {
  fs.mkdirSync(path.dirname(ALERTS_LOG_PATH), { recursive: true });
  fs.appendFileSync(ALERTS_LOG_PATH, `${line}\n`, "utf8");
}

function edgesFromResponse(r: any): Edge[] {
  return r?.data?.exploreList?.edges ?? [];
}

function normAddress(v: string) {
  return String(v ?? "").trim().toLowerCase();
}

function chainSlug(chainId?: number | null) {
  return Number(chainId) === 84532 ? "base-sepolia" : "base";
}

function coinLink(address?: string | null, chainId?: number | null) {
  const addr = normAddress(address ?? "");
  if (!addr.startsWith("0x")) return null;
  return `https://zora.co/coin/${chainSlug(chainId)}:${addr}`;
}

function addCoinLinkToMessage(message: string, address?: string | null, chainId?: number | null) {
  const link = coinLink(address, chainId);
  if (!link) return message;
  if (message.includes(link)) return message;
  return `${message} <${link}>`;
}

function escapeRegex(v: string) {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanAlertMessage(message: string, entityId?: string | null, link?: string | null) {
  let out = String(message ?? "");
  if (link) {
    const reAngle = new RegExp(`<${escapeRegex(link)}>`, "ig");
    const rePlain = new RegExp(escapeRegex(link), "ig");
    out = out.replace(reAngle, "").replace(rePlain, "");
  }
  if (entityId) {
    const reAddr = new RegExp(escapeRegex(entityId), "ig");
    out = out.replace(reAddr, "");
  }
  out = out.replace(/<https?:\/\/zora\.co\/coin\/[a-z-]+:>/ig, "");
  out = out.replace(/\s{2,}/g, " ").replace(/\s+\)/g, ")").trim();
  out = out.replace(/^[-:;,\s]+/, "").trim();
  return out;
}

export async function syncRecentCoins(count = 100) {
  const r = await getCoinsNew({ count });
  const edges = edgesFromResponse(r);
  for (const edge of edges) upsertCoin(edge.node);
  db.prepare("INSERT INTO sync_runs(source, count, created_at) VALUES (?, ?, ?)")
    .run("getCoinsNew", edges.length, new Date().toISOString());
  return edges.length;
}

export async function syncTopVolumeCoins(count = 100) {
  const r = await getCoinsTopVolume24h({ count });
  const edges = edgesFromResponse(r);
  for (const edge of edges) upsertCoin(edge.node);
  db.prepare("INSERT INTO sync_runs(source, count, created_at) VALUES (?, ?, ?)")
    .run("getCoinsTopVolume24h", edges.length, new Date().toISOString());
  return edges.length;
}

export async function ingestCoinSwapsForTrackedCoins(
  coinLimit = env.TRACKED_COIN_COUNT,
  swapsPerCoin = env.SWAPS_PER_COIN,
) {
  // Top coins by volume
  const topCoins = db.prepare(`
    SELECT address, chain_id
    FROM coins
    ORDER BY volume_24h DESC, datetime(indexed_at) DESC
    LIMIT ?
  `).all(coinLimit) as Array<{ address: string; chain_id: number }>;

  // Always include watchlisted coins regardless of volume rank
  const watchlisted = db.prepare(`
    SELECT c.address, c.chain_id
    FROM coin_watchlist w
    JOIN coins c ON c.address = w.coin_address
    WHERE w.coin_address NOT IN (
      SELECT address FROM coins ORDER BY volume_24h DESC, datetime(indexed_at) DESC LIMIT ?
    )
  `).all(coinLimit) as Array<{ address: string; chain_id: number }>;

  const coins = [...topCoins, ...watchlisted];

  let totalInserted = 0;
  for (const coin of coins) {
    try {
      const res = await getCoinSwaps({
        address: coin.address,
        chain: coin.chain_id || env.ZORA_CHAIN_ID,
        first: swapsPerCoin,
      });
      const edges = res?.data?.zora20Token?.swapActivities?.edges ?? [];
      for (const edge of edges) totalInserted += upsertSwap(coin.address, coin.chain_id || env.ZORA_CHAIN_ID, edge.node);
    } catch (err) {
      console.error(`swap ingestion failed for ${coin.address}:`, err);
    }
  }

  db.prepare("INSERT INTO sync_runs(source, count, created_at) VALUES (?, ?, ?)")
    .run("getCoinSwaps", totalInserted, new Date().toISOString());
  return totalInserted;
}

function upsertSwap(coinAddress: string, chainId: number, swap: any) {
  const sender = String(swap.senderAddress ?? "").toLowerCase();
  const recipient = String(swap.recipientAddress ?? "").toLowerCase();
  const ts = swap.blockTimestamp ?? new Date().toISOString();
  const amountUsdc = Number(swap.currencyAmountWithPrice?.priceUsdc ?? 0);
  const amountDecimal = Number(swap.currencyAmountWithPrice?.currencyAmount?.amountDecimal ?? 0);
  const coinAmount = Number(swap.coinAmount ?? 0);
  const result = db.prepare(`
    INSERT OR IGNORE INTO coin_swaps (
      id, coin_address, chain_id, tx_hash, block_timestamp, activity_type,
      sender_address, recipient_address, amount_decimal, amount_usdc, coin_amount,
      raw_json, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(swap.id),
    coinAddress,
    chainId,
    swap.transactionHash ?? null,
    ts,
    swap.activityType ?? null,
    sender || null,
    recipient || null,
    amountDecimal,
    amountUsdc,
    coinAmount,
    JSON.stringify(swap),
    new Date().toISOString(),
  );

  if (result.changes > 0) {
    if (sender) upsertAddressStats(sender, ts, swap.activityType, amountUsdc, swap.senderProfile?.handle);
    if (recipient) upsertAddressStats(recipient, ts, null, amountUsdc, undefined);
    if (sender && recipient && sender !== recipient) upsertInteraction(sender, recipient, ts);
  }

  return result.changes;
}

function upsertAddressStats(address: string, ts: string, side?: string | null, usd = 0, handle?: string) {
  db.prepare(`
    INSERT INTO addresses (
      address, first_seen_at, last_seen_at, swap_count, buy_count, sell_count,
      volume_usdc, last_profile_handle, intelligence_score, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(address) DO UPDATE SET
      last_seen_at=excluded.last_seen_at,
      swap_count=addresses.swap_count + 1,
      buy_count=addresses.buy_count + excluded.buy_count,
      sell_count=addresses.sell_count + excluded.sell_count,
      volume_usdc=addresses.volume_usdc + excluded.volume_usdc,
      last_profile_handle=COALESCE(excluded.last_profile_handle, addresses.last_profile_handle),
      intelligence_score=(addresses.swap_count + 1) * 0.5 + ((addresses.volume_usdc + excluded.volume_usdc) / 1000.0),
      updated_at=excluded.updated_at
  `).run(
    address,
    ts,
    ts,
    side === "BUY" ? 1 : 0,
    side === "SELL" ? 1 : 0,
    usd,
    handle ?? null,
    new Date().toISOString(),
  );
}

function upsertInteraction(a: string, b: string, ts: string) {
  const [x, y] = [a, b].sort();
  db.prepare(`
    INSERT INTO address_interactions (a_address, b_address, interaction_count, last_seen_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(a_address, b_address) DO UPDATE SET
      interaction_count=interaction_count + 1,
      last_seen_at=excluded.last_seen_at
  `).run(x, y, ts);
}

export function rebuildAddressClusters() {
  const rows = db.prepare(`
    SELECT a_address, b_address
    FROM address_interactions
    WHERE interaction_count >= ?
  `).all(env.CLUSTER_MIN_INTERACTIONS) as Array<{ a_address: string; b_address: string }>;

  const graph = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!graph.has(row.a_address)) graph.set(row.a_address, new Set());
    if (!graph.has(row.b_address)) graph.set(row.b_address, new Set());
    graph.get(row.a_address)!.add(row.b_address);
    graph.get(row.b_address)!.add(row.a_address);
  }

  const visited = new Set<string>();
  const clusters: string[][] = [];
  for (const node of graph.keys()) {
    if (visited.has(node)) continue;
    const stack = [node];
    const component: string[] = [];
    visited.add(node);
    while (stack.length) {
      const n = stack.pop()!;
      component.push(n);
      for (const nei of graph.get(n) ?? []) {
        if (!visited.has(nei)) {
          visited.add(nei);
          stack.push(nei);
        }
      }
    }
    if (component.length >= 2) clusters.push(component);
  }

  db.prepare("DELETE FROM address_cluster_members").run();
  db.prepare("DELETE FROM address_clusters").run();

  const insertCluster = db.prepare(`
    INSERT INTO address_clusters (id, heuristic, label, member_count, score, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertMember = db.prepare(`
    INSERT INTO address_cluster_members (cluster_id, address, weight)
    VALUES (?, ?, ?)
  `);

  clusters.forEach((members, i) => {
    const id = `cluster-${i + 1}`;
    insertCluster.run(id, "shared-swap-counterparty", `interaction_component_${members.length}`, members.length, members.length, new Date().toISOString());
    for (const m of members) insertMember.run(id, m, 1);
  });

  return clusters.length;
}

export function refreshCoinAnalytics() {
  const rows = db.prepare(`
    SELECT
      coin_address,
      SUM(CASE WHEN datetime(block_timestamp) >= datetime('now', '-1 hour') THEN 1 ELSE 0 END) AS swap_count_1h,
      COUNT(DISTINCT CASE WHEN datetime(block_timestamp) >= datetime('now', '-1 hour') THEN sender_address END) AS unique_traders_1h,
      SUM(CASE WHEN datetime(block_timestamp) >= datetime('now', '-1 hour') AND activity_type = 'BUY' THEN 1 ELSE 0 END) AS buy_count_1h,
      SUM(CASE WHEN datetime(block_timestamp) >= datetime('now', '-1 hour') AND activity_type = 'SELL' THEN 1 ELSE 0 END) AS sell_count_1h,
      SUM(CASE WHEN datetime(block_timestamp) >= datetime('now', '-1 hour') AND activity_type = 'BUY' THEN amount_usdc ELSE 0 END) AS buy_volume_usdc_1h,
      SUM(CASE WHEN datetime(block_timestamp) >= datetime('now', '-1 hour') AND activity_type = 'SELL' THEN amount_usdc ELSE 0 END) AS sell_volume_usdc_1h,
      SUM(CASE WHEN datetime(block_timestamp) >= datetime('now', '-2 hours') AND datetime(block_timestamp) < datetime('now', '-1 hour') THEN 1 ELSE 0 END) AS swap_count_prev_1h,
      COUNT(*) AS swap_count_24h,
      COUNT(DISTINCT sender_address) AS unique_traders_24h,
      SUM(CASE WHEN activity_type = 'BUY' THEN 1 ELSE 0 END) AS buy_count_24h,
      SUM(CASE WHEN activity_type = 'SELL' THEN 1 ELSE 0 END) AS sell_count_24h,
      SUM(CASE WHEN activity_type = 'BUY' THEN amount_usdc ELSE 0 END) AS buy_volume_usdc_24h,
      SUM(CASE WHEN activity_type = 'SELL' THEN amount_usdc ELSE 0 END) AS sell_volume_usdc_24h
    FROM coin_swaps
    WHERE datetime(block_timestamp) >= datetime('now', '-1 day')
    GROUP BY coin_address
  `).all() as Array<any>;

  const upsert = db.prepare(`
    INSERT INTO coin_analytics (
      coin_address,
      swap_count_1h, unique_traders_1h, buy_count_1h, sell_count_1h,
      buy_volume_usdc_1h, sell_volume_usdc_1h, net_flow_usdc_1h,
      swap_count_prev_1h, momentum_score_1h, momentum_acceleration_1h,
      swap_count_24h, unique_traders_24h, buy_count_24h, sell_count_24h,
      buy_volume_usdc_24h, sell_volume_usdc_24h, net_flow_usdc_24h, momentum_score, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(coin_address) DO UPDATE SET
      swap_count_1h=excluded.swap_count_1h,
      unique_traders_1h=excluded.unique_traders_1h,
      buy_count_1h=excluded.buy_count_1h,
      sell_count_1h=excluded.sell_count_1h,
      buy_volume_usdc_1h=excluded.buy_volume_usdc_1h,
      sell_volume_usdc_1h=excluded.sell_volume_usdc_1h,
      net_flow_usdc_1h=excluded.net_flow_usdc_1h,
      swap_count_prev_1h=excluded.swap_count_prev_1h,
      momentum_score_1h=excluded.momentum_score_1h,
      momentum_acceleration_1h=excluded.momentum_acceleration_1h,
      swap_count_24h=excluded.swap_count_24h,
      unique_traders_24h=excluded.unique_traders_24h,
      buy_count_24h=excluded.buy_count_24h,
      sell_count_24h=excluded.sell_count_24h,
      buy_volume_usdc_24h=excluded.buy_volume_usdc_24h,
      sell_volume_usdc_24h=excluded.sell_volume_usdc_24h,
      net_flow_usdc_24h=excluded.net_flow_usdc_24h,
      momentum_score=excluded.momentum_score,
      updated_at=excluded.updated_at
  `);

  for (const r of rows) {
    const buyVol1h = Number(r.buy_volume_usdc_1h ?? 0);
    const sellVol1h = Number(r.sell_volume_usdc_1h ?? 0);
    const swapCount1h = Number(r.swap_count_1h ?? 0);
    const unique1h = Number(r.unique_traders_1h ?? 0);
    const prev1h = Number(r.swap_count_prev_1h ?? 0);
    const netFlow1h = buyVol1h - sellVol1h;
    const momentum1h = netFlow1h * 0.2 + unique1h * 4 + swapCount1h * 2;
    const accel1h = swapCount1h / Math.max(1, prev1h);

    const buyVol24h = Number(r.buy_volume_usdc_24h ?? 0);
    const sellVol24h = Number(r.sell_volume_usdc_24h ?? 0);
    const swapCount24h = Number(r.swap_count_24h ?? 0);
    const unique24h = Number(r.unique_traders_24h ?? 0);
    const netFlow24h = buyVol24h - sellVol24h;
    const momentum24h = netFlow24h * 0.1 + unique24h * 2 + swapCount24h;

    upsert.run(
      r.coin_address,
      swapCount1h,
      unique1h,
      Number(r.buy_count_1h ?? 0),
      Number(r.sell_count_1h ?? 0),
      buyVol1h,
      sellVol1h,
      netFlow1h,
      prev1h,
      momentum1h,
      accel1h,
      swapCount24h,
      unique24h,
      Number(r.buy_count_24h ?? 0),
      Number(r.sell_count_24h ?? 0),
      buyVol24h,
      sellVol24h,
      netFlow24h,
      momentum24h,
      new Date().toISOString(),
    );
  }

  return rows.length;
}

function watchlistAlertCandidates() {
  const wl = db.prepare(`
    SELECT w.list_name, w.coin_address, w.label, c.symbol, c.name, c.chain_id, c.volume_24h,
           a.swap_count_1h, a.net_flow_usdc_1h, a.momentum_score_1h, a.momentum_acceleration_1h,
           a.swap_count_24h, a.net_flow_usdc_24h
    FROM coin_watchlist w
    LEFT JOIN coins c ON c.address = w.coin_address
    LEFT JOIN coin_analytics a ON a.coin_address = w.coin_address
    WHERE w.enabled = 1
  `).all() as Array<any>;

  const nowHour = new Date().toISOString().slice(0, 13);
  const alerts: Array<{ type: string; entity_id: string; severity: string; message: string; fingerprint: string }> = [];

  for (const w of wl) {
    const label = w.label || w.symbol || w.name || w.coin_address;
    const addr = w.coin_address;
    const listName = w.list_name || "default";

    const moveSummary = db.prepare(`
      SELECT
        COUNT(*) AS large_swaps_1h,
        MAX(amount_usdc) AS max_swap_usdc,
        SUM(amount_usdc) AS total_large_swap_usdc
      FROM coin_swaps
      WHERE coin_address = ?
        AND datetime(block_timestamp) >= datetime('now', '-1 hour')
        AND amount_usdc >= ?
    `).get(addr, env.WATCHLIST_MIN_SWAP_USD) as any;

    const largeSwaps1h = Number(moveSummary?.large_swaps_1h ?? 0);
    const maxSwap1h = Number(moveSummary?.max_swap_usdc ?? 0);
    const totalLarge1h = Number(moveSummary?.total_large_swap_usdc ?? 0);
    if (largeSwaps1h > 0) {
      alerts.push({
        type: "WATCHLIST_MOVE",
        entity_id: addr,
        severity: maxSwap1h >= env.WATCHLIST_MIN_SWAP_USD * 8 ? "high" : "medium",
        message: addCoinLinkToMessage(
          `[${listName}] ${label} large-swaps1h=${largeSwaps1h} maxSwap=${maxSwap1h.toFixed(2)} totalLargeSwapUsd=${totalLarge1h.toFixed(2)}`,
          addr,
          w.chain_id,
        ),
        fingerprint: `watch_move:${listName}:${addr}:${nowHour}`,
      });
    }

    const swaps1h = Number(w.swap_count_1h ?? 0);
    const netFlow1h = Number(w.net_flow_usdc_1h ?? 0);
    const momentum1h = Number(w.momentum_score_1h ?? 0);
    const accel1h = Number(w.momentum_acceleration_1h ?? 0);
    if (swaps1h >= env.WATCHLIST_MIN_SWAPS_1H || Math.abs(netFlow1h) >= env.WATCHLIST_MIN_NET_FLOW_USD_1H) {
      alerts.push({
        type: "WATCHLIST_SUMMARY",
        entity_id: addr,
        severity: momentum1h >= env.ALERT_MIN_MOMENTUM_1H * 1.5 || accel1h >= env.ALERT_MIN_ACCELERATION_1H * 1.5 ? "high" : "medium",
        message: addCoinLinkToMessage(
          `[${listName}] ${label} swaps1h=${swaps1h} netFlow1h=${netFlow1h.toFixed(2)} momentum1h=${momentum1h.toFixed(2)} accel1h=${accel1h.toFixed(2)} volume24h=${Number(w.volume_24h ?? 0).toFixed(2)}`,
          addr,
          w.chain_id,
        ),
        fingerprint: `watch_summary:${listName}:${addr}:${nowHour}`,
      });
    }
  }

  return alerts;
}

export function generateAlerts() {
  const alerts: Array<{ type: string; entity_id: string; severity: string; message: string; fingerprint: string }> = [];

  const hotCoins = db.prepare(`
    SELECT a.coin_address, c.chain_id,
           a.swap_count_1h, a.swap_count_prev_1h,
           a.momentum_score_1h, a.momentum_acceleration_1h,
           a.swap_count_24h, a.momentum_score
    FROM coin_analytics a
    LEFT JOIN coins c ON c.address = a.coin_address
    WHERE a.swap_count_1h >= ?
      AND a.momentum_score_1h >= ?
      AND a.momentum_acceleration_1h >= ?
    ORDER BY a.momentum_score_1h DESC
    LIMIT ?
  `).all(
    env.ALERT_COIN_SWAPS_1H,
    env.ALERT_MIN_MOMENTUM_1H,
    env.ALERT_MIN_ACCELERATION_1H,
    env.ALERT_MAX_COIN_ALERTS_PER_RUN,
  ) as Array<any>;

  for (const c of hotCoins) {
    alerts.push({
      type: "COIN_ACTIVITY_SPIKE",
      entity_id: c.coin_address,
      severity: Number(c.momentum_score_1h) >= env.ALERT_MIN_MOMENTUM_1H * 2 ? "high" : "medium",
      message: addCoinLinkToMessage(
        `Fast momentum: ${c.coin_address} swaps1h=${c.swap_count_1h} prev1h=${c.swap_count_prev_1h} accel1h=${Number(c.momentum_acceleration_1h).toFixed(2)} momentum1h=${Number(c.momentum_score_1h).toFixed(2)} (swaps24h=${c.swap_count_24h})`,
        c.coin_address,
        c.chain_id,
      ),
      fingerprint: `coin_spike_fast:${c.coin_address}:${new Date().toISOString().slice(0, 13)}`,
    });
  }

  const whales = db.prepare(`
    SELECT s.id, s.coin_address, c.chain_id, s.sender_address, s.amount_usdc
    FROM coin_swaps s
    LEFT JOIN coins c ON c.address = s.coin_address
    WHERE s.amount_usdc >= ?
      AND datetime(s.block_timestamp) >= datetime('now', '-1 day')
    ORDER BY s.amount_usdc DESC
    LIMIT 3
  `).all(env.ALERT_WHALE_SWAP_USD * 1.5) as Array<any>;

  for (const w of whales) {
    alerts.push({
      type: "WHALE_SWAP",
      entity_id: w.coin_address,
      severity: Number(w.amount_usdc) > env.ALERT_WHALE_SWAP_USD * 3 ? "high" : "medium",
      message: addCoinLinkToMessage(
        `Whale swap ${w.id} on ${w.coin_address} by ${w.sender_address} amount_usdc=${Number(w.amount_usdc).toFixed(2)}`,
        w.coin_address,
        w.chain_id,
      ),
      fingerprint: `whale:${w.id}`,
    });
  }

  alerts.push(...watchlistAlertCandidates());

  const insert = db.prepare(`
    INSERT OR IGNORE INTO alerts (kind, type, entity_id, severity, message, payload_json, fingerprint, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let newCount = 0;
  for (const a of alerts) {
    const r = insert.run(a.type, a.type, a.entity_id, a.severity, a.message, null, a.fingerprint, new Date().toISOString());
    if (r.changes > 0) {
      newCount += 1;
      const line = `${new Date().toISOString()} [ALERT:${a.severity}] ${a.message}`;
      console.log(line);
      appendAlertLog(line);
    }
  }
  return newCount;
}

export async function pollOnce() {
  const syncedRecent = await syncRecentCoins(env.TRACKED_COIN_COUNT);
  const syncedTop = await syncTopVolumeCoins(env.TRACKED_COIN_COUNT);
  const swaps = await ingestCoinSwapsForTrackedCoins(env.TRACKED_COIN_COUNT, env.SWAPS_PER_COIN);
  const clusters = rebuildAddressClusters();
  const analytics = refreshCoinAnalytics();
  const alerts = generateAlerts();
  return { syncedRecent, syncedTop, swaps, clusters, analytics, alerts };
}

export async function runPollingLoop() {
  console.log(`Starting polling loop interval=${env.POLL_INTERVAL_SEC}s`);
  while (true) {
    const started = Date.now();
    try {
      console.log(`[poll] ${new Date().toISOString()} ${JSON.stringify(await pollOnce())}`);
    } catch (err) {
      console.error("poll failed", err);
    }
    const elapsed = Date.now() - started;
    await new Promise((r) => setTimeout(r, Math.max(1000, env.POLL_INTERVAL_SEC * 1000 - elapsed)));
  }
}

export function recentCoins(limit = 20) {
  return db.prepare(`
    SELECT address, symbol, name, created_at, volume_24h, market_cap,
           CASE WHEN chain_id = 84532 THEN 'https://zora.co/coin/base-sepolia:' || lower(address)
                ELSE 'https://zora.co/coin/base:' || lower(address)
           END AS coin_url
    FROM coins
    ORDER BY datetime(created_at) DESC
    LIMIT ?
  `).all(limit);
}

export function firstKnownCoin() {
  return db.prepare(`
    SELECT address, symbol, name, created_at, volume_24h, market_cap,
           CASE WHEN chain_id = 84532 THEN 'https://zora.co/coin/base-sepolia:' || lower(address)
                ELSE 'https://zora.co/coin/base:' || lower(address)
           END AS coin_url
    FROM coins
    WHERE created_at IS NOT NULL
    ORDER BY datetime(created_at) ASC
    LIMIT 1
  `).get();
}

export function topVolumeCoins(limit = 20) {
  return db.prepare(`
    SELECT address, symbol, name, created_at, volume_24h, market_cap,
           CASE WHEN chain_id = 84532 THEN 'https://zora.co/coin/base-sepolia:' || lower(address)
                ELSE 'https://zora.co/coin/base:' || lower(address)
           END AS coin_url
    FROM coins
    ORDER BY volume_24h DESC
    LIMIT ?
  `).all(limit);
}

export function topAnalytics(limit = 20) {
  return db.prepare(`
    SELECT a.coin_address,
           a.swap_count_1h, a.net_flow_usdc_1h, a.momentum_score_1h, a.momentum_acceleration_1h,
           a.swap_count_24h, a.unique_traders_24h, a.net_flow_usdc_24h, a.momentum_score,
           CASE WHEN c.chain_id = 84532 THEN 'https://zora.co/coin/base-sepolia:' || lower(a.coin_address)
                ELSE 'https://zora.co/coin/base:' || lower(a.coin_address)
           END AS coin_url
    FROM coin_analytics a
    LEFT JOIN coins c ON c.address = a.coin_address
    ORDER BY a.momentum_score_1h DESC, a.momentum_score DESC
    LIMIT ?
  `).all(limit);
}

export function watchlistAddCoin(coinAddress: string, listName = "default", label?: string, notes?: string) {
  const addr = normAddress(coinAddress);
  if (!addr || !addr.startsWith("0x")) throw new Error("Invalid coin address");
  db.prepare(`
    INSERT INTO coin_watchlist (list_name, coin_address, label, notes, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(list_name, coin_address) DO UPDATE SET
      enabled=1,
      label=COALESCE(excluded.label, coin_watchlist.label),
      notes=COALESCE(excluded.notes, coin_watchlist.notes),
      updated_at=excluded.updated_at
  `).run(listName, addr, label ?? null, notes ?? null, new Date().toISOString(), new Date().toISOString());
  return { listName, coinAddress: addr, coinUrl: coinLink(addr, env.ZORA_CHAIN_ID) };
}

export function watchlistRemoveCoin(coinAddress: string, listName = "default") {
  const addr = normAddress(coinAddress);
  const r = db.prepare(`DELETE FROM coin_watchlist WHERE list_name=? AND coin_address=?`).run(listName, addr);
  return r.changes;
}

export function watchlistList(listName = "default") {
  return db.prepare(`
    SELECT w.list_name, w.coin_address, w.label, w.notes, w.enabled, w.updated_at,
           c.symbol, c.name, c.volume_24h,
           a.swap_count_1h, a.net_flow_usdc_1h, a.momentum_score_1h, a.momentum_acceleration_1h,
           a.swap_count_24h, a.unique_traders_24h, a.net_flow_usdc_24h, a.momentum_score,
           CASE WHEN c.chain_id = 84532 THEN 'https://zora.co/coin/base-sepolia:' || lower(w.coin_address)
                ELSE 'https://zora.co/coin/base:' || lower(w.coin_address)
           END AS coin_url
    FROM coin_watchlist w
    LEFT JOIN coins c ON c.address = w.coin_address
    LEFT JOIN coin_analytics a ON a.coin_address = w.coin_address
    WHERE w.list_name = ?
    ORDER BY w.enabled DESC, COALESCE(a.momentum_score, 0) DESC, w.updated_at DESC
  `).all(listName);
}

export function watchlistRecentMoves(listName = "default", limit = 25) {
  return db.prepare(`
    SELECT w.list_name, w.coin_address, COALESCE(w.label, c.symbol, c.name, w.coin_address) label,
           s.activity_type, s.amount_usdc, s.sender_address, s.recipient_address, s.block_timestamp,
           CASE WHEN c.chain_id = 84532 THEN 'https://zora.co/coin/base-sepolia:' || lower(w.coin_address)
                ELSE 'https://zora.co/coin/base:' || lower(w.coin_address)
           END AS coin_url
    FROM coin_watchlist w
    JOIN coin_swaps s ON s.coin_address = w.coin_address
    LEFT JOIN coins c ON c.address = w.coin_address
    WHERE w.list_name = ? AND w.enabled = 1
    ORDER BY datetime(s.block_timestamp) DESC
    LIMIT ?
  `).all(listName, limit);
}

export function latestAlerts(limit = 20) {
  return db.prepare(`
    SELECT type, entity_id, severity, message, created_at,
           CASE WHEN entity_id LIKE '0x%' THEN 'https://zora.co/coin/base:' || lower(entity_id)
                ELSE NULL
           END AS coin_url
    FROM alerts
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}

function formatUsd(v: number) {
  if (!Number.isFinite(v) || v <= 0) return "n/a";
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/**
 * Generate a snarky one-liner commentary for a coin alert.
 */
function generateCommentary(ctx: {
  name: string;
  symbol: string;
  marketCap: number;
  trend: string;
  severity: string;
  type: string;
  buyRatio?: number;
  swapCount?: number;
}): string {
  const n = ctx.name.toLowerCase();
  const s = ctx.symbol.toLowerCase();

  // Political/scam token detection
  const politicalKeywords = ["trump", "maga", "potus", "melania", "ivanka", "republican", "democrat", "biden", "obama", "kamala"];
  const reserveKeywords = ["reserve", "treasury", "federal", "national", "sovereign", "vanguard"];
  const cryptoParodyKeywords = ["bitcoin", "ethereum", "solana", "satoshi", "nakamoto", "doge", "shib", "pepe"];
  const usdKeywords = ["usd", "usr", "dollar"];

  const isPolitical = politicalKeywords.some(k => n.includes(k) || s.includes(k));
  const isReserve = reserveKeywords.some(k => n.includes(k) || s.includes(k));
  const isCryptoParody = cryptoParodyKeywords.some(k => n.includes(k) || s.includes(k));
  const isFakeUsd = usdKeywords.some(k => s.includes(k)) && ctx.marketCap < 1_000_000;

  // Commentary pools
  const politicalLines = [
    "another day, another politician-themed casino chip 🎰",
    "the founding fathers did NOT die for this",
    "sir this is a blockchain not a ballot box",
    "making portfolios great again (they won't)",
    "democracy was a mistake and this coin proves it",
  ];

  const reserveLines = [
    "\"digital reserve\" is doing a lot of heavy lifting here",
    "the eagle on the logo doesn't make it legitimate",
    "backed by the full faith and credit of some guy's laptop",
    "Fort Knox called, they don't know this coin either",
    "strategic reserve of copium",
  ];

  const cryptoParodyLines = [
    "if you squint hard enough it almost looks original",
    "the real one called, they want their name back",
    "ctrl+c ctrl+v energy",
    "identity theft is not a joke, Jim",
  ];

  const fakeUsdLines = [
    "pegged to absolutely nothing",
    "stable in name only",
    "the dollar at home",
    "Fed chair just shed a single tear",
  ];

  const pumpLines = [
    "vertical line go brrrr (for now)",
    "this chart has that pre-rug glow ✨",
    "somebody's buying and it might even be a real person",
    "momentum looking spicy but so did my last three losses",
    "number go up (narrator: it would not last)",
  ];

  const dumpLines = [
    "and there it goes 🫡",
    "liquidation speedrun any%",
    "the chart is doing that thing again",
    "gravity: undefeated",
    "exit liquidity has left the chat",
  ];

  const microCapLines = [
    "market cap smaller than my grocery bill",
    "three guys in a discord and a dream",
    "liquidity you could measure with a teaspoon",
    "one sell and this thing is going to zero",
  ];

  const genericLines = [
    "another one for the pile",
    "looks like every other coin from today tbh",
    "the trenches remain undefeated",
    "i've seen this movie before, it doesn't end well",
    "somewhere a wallet is about to learn an expensive lesson",
  ];

  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

  if (isPolitical) return pick(politicalLines);
  if (isReserve) return pick(reserveLines);
  if (isCryptoParody) return pick(cryptoParodyLines);
  if (isFakeUsd) return pick(fakeUsdLines);
  if (ctx.marketCap < 500) return pick(microCapLines);
  if (ctx.trend === "up") return pick(pumpLines);
  if (ctx.trend === "down") return pick(dumpLines);
  return pick(genericLines);
}

function buildDispatchPayload(
  rows: Array<{ id: number; type: string; entity_id: string | null; severity: string; message: string }>,
  suppressedCount = 0,
) {
  const coinCtxStmt = db.prepare(`
    SELECT c.symbol, c.name, c.chain_id, c.market_cap, a.momentum_acceleration_1h
    FROM coins c
    LEFT JOIN coin_analytics a ON a.coin_address = c.address
    WHERE c.address = ?
    LIMIT 1
  `);

  const chartCoinMap = new Map<string, { coinAddress: string; symbol: string | null; name: string | null }>();
  const alertContexts: Array<{ symbol: string; name: string; coinAddress: string; marketCap: number; trend: string; severity: string; type: string; message: string }> = [];

  const lines = rows.map((r) => {
    const sev = r.severity.toUpperCase();
    const ctx = r.entity_id ? (coinCtxStmt.get(r.entity_id) as any) : null;

    const symbol = String(ctx?.symbol ?? "").trim();
    const name = String(ctx?.name ?? "").trim();
    const coinLabel = symbol || name
      ? `${symbol || "?"} / ${name || symbol || "?"}`
      : "unknown / unknown";

    const accel = Number(ctx?.momentum_acceleration_1h ?? 1);
    const trend = accel > 1.05 ? { emoji: "📈", word: "up" } : accel < 0.95 ? { emoji: "📉", word: "down" } : { emoji: "➡️", word: "flat" };
    const marketCapUsd = Number(ctx?.market_cap ?? 0);

    const link = coinLink(r.entity_id, ctx?.chain_id);
    const cleaned = cleanAlertMessage(r.message, r.entity_id, link);
    const finalMessage = `${cleaned}${link ? ` [open coin](${link})` : ""}`;

    const mcap = r.entity_id ? ` • mcap $${formatUsd(marketCapUsd)}` : "";
    const coinMeta = r.entity_id ? ` ${coinLabel}${mcap} • ${trend.emoji} momentum ${trend.word}` : "";

    if (r.entity_id && r.entity_id.startsWith("0x") && !chartCoinMap.has(r.entity_id)) {
      chartCoinMap.set(r.entity_id, {
        coinAddress: r.entity_id,
        symbol: symbol || null,
        name: name || null,
      });
    }

    // Collect context for batch LLM commentary
    if (r.entity_id) {
      alertContexts.push({
        symbol: symbol || "unknown",
        name: name || "unknown",
        coinAddress: r.entity_id,
        marketCap: marketCapUsd,
        trend: trend.word,
        severity: sev,
        type: r.type,
        message: r.message,
      });
    }

    return `- [${sev}] ${r.type}${coinMeta} — ${finalMessage}`;
  });

  const dedupeNote = suppressedCount > 0 ? `, deduped ${suppressedCount}` : "";
  return {
    message: `🚨 zora-intelligence alerts (${rows.length}${dedupeNote})\n${lines.join("\n")}`,
    chartCoins: [...chartCoinMap.values()],
    alertContexts,
  };
}

export type DispatchAlertsRich = {
  message: string;
  media: Array<{ coinAddress: string; symbol: string | null; name: string | null; filePath: string; arweaveUrl?: string }>;
};

function applyDispatchDiversity(rows: Array<{ id: number; type: string; entity_id: string | null; severity: string; message: string; created_at: string }>, limit: number) {
  const dedupedRows = dedupeAlertRows(rows);
  const mode = String(env.ALERT_DIVERSITY_MODE ?? "on").toLowerCase();
  const enabled = ["1", "true", "yes", "on"].includes(mode);

  const entityMetaStmt = db.prepare(`
    SELECT
      MAX(sent_discord_at) AS last_sent_at,
      SUM(CASE WHEN datetime(sent_discord_at) >= datetime('now', ?) THEN 1 ELSE 0 END) AS recent_count,
      MAX(c.market_cap) AS market_cap
    FROM alerts a
    LEFT JOIN coins c ON c.address = a.entity_id
    WHERE a.sent_discord_at IS NOT NULL
      AND a.entity_id = ?
  `);

  const metaByEntity = new Map<string, { lastSentAt?: string | null; recentCount?: number; marketCap?: number }>();
  for (const row of dedupedRows) {
    const entity = String(row.entity_id ?? "").toLowerCase();
    if (!entity || metaByEntity.has(entity)) continue;
    const r = entityMetaStmt.get(`-${Math.max(1, env.ALERT_NOVELTY_WINDOW_HOURS)} hours`, entity) as any;
    metaByEntity.set(entity, {
      lastSentAt: r?.last_sent_at ?? null,
      recentCount: Number(r?.recent_count ?? 0),
      marketCap: Number(r?.market_cap ?? 0),
    });
  }

  const selected = selectDiverseAlerts(dedupedRows, limit, {
    enabled,
    perCoinCooldownMin: Math.max(0, env.ALERT_PER_COIN_COOLDOWN_MIN),
    maxPerCoinPerDispatch: Math.max(1, env.ALERT_MAX_PER_COIN_PER_DISPATCH),
    noveltyWindowHours: Math.max(1, env.ALERT_NOVELTY_WINDOW_HOURS),
    largeCapPenaltyAboveUsd: Math.max(0, env.ALERT_LARGE_CAP_PENALTY_ABOVE_USD),
  }, metaByEntity);

  return {
    selected,
    suppressedCount: Math.max(0, rows.length - selected.length),
  };
}

/**
 * Refresh coin metadata (mcap, volume) from Zora API for a set of addresses.
 * Non-blocking — failures are silently ignored.
 */
async function refreshCoinData(addresses: string[]) {
  const unique = [...new Set(addresses.filter(a => a?.startsWith("0x")))];
  for (const address of unique.slice(0, 10)) { // cap at 10 to avoid rate limits
    try {
      const res = await getCoin({ address, chain: env.ZORA_CHAIN_ID });
      const token = res?.data?.zora20Token;
      if (token) upsertCoin(token);
    } catch { /* non-blocking */ }
  }
}

export async function dispatchPendingAlerts(limit = 12) {
  const fetchLimit = Math.max(limit, limit * 4);
  const rows = getUnsentAlerts(fetchLimit);
  if (!rows.length) return null;

  const { selected, suppressedCount } = applyDispatchDiversity(rows, limit);

  // Refresh coin data before building payload so mcap is current
  await refreshCoinData(selected.map(r => r.entity_id).filter(Boolean) as string[]);

  const payload = buildDispatchPayload(selected, suppressedCount);

  // Generate LLM commentary for the batch
  let commentary = "";
  if (payload.alertContexts.length > 0) {
    try {
      commentary = await generateBatchCommentary(payload.alertContexts);
    } catch { /* non-blocking */ }
  }

  markAlertsSent(rows.map((r) => r.id));
  const commentLine = commentary ? `\n\n_${commentary}_` : "";
  return payload.message + commentLine;
}

export async function dispatchPendingAlertsRich(limit = 12): Promise<DispatchAlertsRich | null> {
  const fetchLimit = Math.max(limit, limit * 4);
  const rows = getUnsentAlerts(fetchLimit);
  if (!rows.length) return null;

  const { selected, suppressedCount } = applyDispatchDiversity(rows, limit);

  // Refresh coin data before building payload so mcap is current
  await refreshCoinData(selected.map(r => r.entity_id).filter(Boolean) as string[]);

  const payload = buildDispatchPayload(selected, suppressedCount);
  const media: DispatchAlertsRich["media"] = [];

  for (const coin of payload.chartCoins.slice(0, 4)) {
    try {
      const mediaDir = process.env.OPENCLAW_MEDIA_DIR || path.join(process.env.HOME || "/tmp", ".openclaw", "media");
      const filePath = path.join(mediaDir, `alert-price-volume-${normAddress(coin.coinAddress)}.png`);
      const { buildPriceVolumeChart } = await import("./price-volume-lib.js");
      await buildPriceVolumeChart({
        coinAddress: coin.coinAddress,
        hours: 24,
        bucketMinutes: 15,
        outFile: filePath,
      });
      // Upload chart to Arweave for permanent on-chain hosting
      let arweaveUrl: string | undefined;
      try {
        arweaveUrl = await uploadToArweave(filePath);
      } catch (err) {
        console.error(`Arweave upload failed for ${coin.coinAddress}:`, err);
      }

      media.push({
        coinAddress: coin.coinAddress,
        symbol: coin.symbol,
        name: coin.name,
        filePath,
        arweaveUrl,
      });
    } catch (err) {
      console.error(`alert chart generation failed for ${coin.coinAddress}:`, err);
    }
  }

  // Generate LLM commentary for the batch
  let commentary = "";
  if (payload.alertContexts.length > 0) {
    try {
      commentary = await generateBatchCommentary(payload.alertContexts);
    } catch { /* non-blocking */ }
  }

  markAlertsSent(rows.map((r) => r.id));
  const commentLine = commentary ? `\n\n_${commentary}_` : "";
  return { message: payload.message + commentLine, media };
}
