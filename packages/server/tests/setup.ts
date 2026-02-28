import os from "node:os";
import path from "node:path";
import { initIntelligenceEngine } from "../src/services/intelligence.js";

// Initialize the intelligence engine with a temp DB for tests.
const testIntelDb = path.join(os.tmpdir(), `fleet-intel-test-${process.pid}.db`);
initIntelligenceEngine({ dbPath: testIntelDb });
