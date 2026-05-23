import path from "node:path";
import dotenv from "dotenv";

const packageRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");

dotenv.config({ path: path.join(packageRoot, ".env") });
dotenv.config({ path: path.join(packageRoot, ".env.local"), override: true });

for (const key of ["ZORA_INTEL_DB_PATH", "INTEL_DB_PATH", "DB_PATH"]) {
  const value = process.env[key]?.trim();
  if (value && value !== ":memory:" && !path.isAbsolute(value)) {
    process.env[key] = path.resolve(packageRoot, value);
  }
}
