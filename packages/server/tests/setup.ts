import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initIntelligenceEngine } from "../src/services/intelligence.js";

// Initialize the intelligence engine with a temp DB for tests.
const testIntelDb = process.env.ZORA_INTEL_DB_PATH || path.join(os.tmpdir(), `fleet-intel-test-${process.pid}.db`);
process.env.ZORA_INTEL_DB_PATH = testIntelDb;
process.env.INTEL_DB_PATH = testIntelDb;
process.env.DB_PATH = testIntelDb;
fs.mkdirSync(path.dirname(testIntelDb), { recursive: true });
initIntelligenceEngine({ dbPath: testIntelDb });
