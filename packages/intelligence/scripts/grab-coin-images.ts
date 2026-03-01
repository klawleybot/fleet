/**
 * Grab thumbnail images for top trending coins from Zora.
 * Downloads to a temp directory for use as image generation inputs.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(__dirname, "../.data/zora-intelligence.db");
const OUT_DIR = resolve(__dirname, "../.data/coin-thumbnails");

async function main() {
  const db = new Database(process.env.INTEL_DB_PATH || DEFAULT_DB, { readonly: true });

  // Get top 5 coins by swap activity
  const topCoins = db.prepare(`
    SELECT c.address, c.symbol, c.name, c.raw_json
    FROM coin_analytics ca
    JOIN coins c ON c.address = ca.coin_address
    WHERE ca.swap_count_24h >= 10
    ORDER BY ca.swap_count_24h DESC
    LIMIT 5
  `).all() as any[];

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const downloaded: string[] = [];

  for (const coin of topCoins) {
    try {
      // Try to get image from raw_json metadata
      const raw = JSON.parse(coin.raw_json || "{}");
      const imageUrl = raw.mediaContent?.previewImage?.medium
        || raw.mediaContent?.previewImage?.small
        || raw.profileImage
        || raw.image;

      if (!imageUrl) {
        // Fall back to Zora OG image
        const ogUrl = `https://zora.co/api/og-image/coin/base:${coin.address}`;
        const outPath = resolve(OUT_DIR, `${coin.symbol.replace(/[^a-zA-Z0-9]/g, "_")}.png`);
        const resp = await fetch(ogUrl);
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          writeFileSync(outPath, buf);
          downloaded.push(outPath);
          console.log(`✅ ${coin.symbol}: OG image → ${outPath}`);
        }
        continue;
      }

      const ext = imageUrl.includes(".gif") ? "gif" : "png";
      const outPath = resolve(OUT_DIR, `${coin.symbol.replace(/[^a-zA-Z0-9]/g, "_")}.${ext}`);

      const resp = await fetch(imageUrl);
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        writeFileSync(outPath, buf);
        downloaded.push(outPath);
        console.log(`✅ ${coin.symbol}: ${imageUrl.slice(0, 60)}... → ${outPath}`);
      }
    } catch (err) {
      console.error(`⚠️ ${coin.symbol}: failed -`, (err as Error).message);
    }
  }

  db.close();

  console.log(`\nDownloaded ${downloaded.length} images to ${OUT_DIR}`);
  console.log(JSON.stringify({ images: downloaded }));
}

main().catch(console.error);
