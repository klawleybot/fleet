/**
 * Mark comment IDs as replied in the state file.
 * 
 * Usage:
 *   npx tsx scripts/mark-comments-replied.ts <id1> [id2] [id3] ...
 *   echo '["id1","id2"]' | npx tsx scripts/mark-comments-replied.ts --stdin
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(__dirname, "../.data/zora-notif-state.json");

interface StateFile {
  lastCheckedAt: string;
  repliedCommentIds: string[];
}

function loadState(): StateFile {
  if (!existsSync(STATE_PATH)) {
    return { lastCheckedAt: new Date(0).toISOString(), repliedCommentIds: [] };
  }
  return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
}

async function main() {
  let ids: string[];

  if (process.argv.includes("--stdin")) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
      throw new Error("Expected stdin JSON array of comment ID strings");
    }
    ids = parsed;
  } else {
    ids = process.argv.slice(2).filter(a => !a.startsWith("--"));
  }

  if (ids.length === 0) {
    console.error("No comment IDs provided");
    process.exit(1);
  }

  const state = loadState();
  const existing = new Set(state.repliedCommentIds);

  let added = 0;
  for (const id of ids) {
    if (id && !existing.has(id)) {
      state.repliedCommentIds.push(id);
      existing.add(id);
      added++;
    }
  }

  // Update timestamp
  state.lastCheckedAt = new Date().toISOString();

  // Keep only last 500
  state.repliedCommentIds = state.repliedCommentIds.slice(-500);

  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`Added ${added} new ID(s). Total tracked: ${state.repliedCommentIds.length}`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
