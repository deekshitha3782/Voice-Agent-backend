import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Only load .env files if not using railway run
// (railway run automatically provides DATABASE_URL)
if (!process.env.RAILWAY_ENVIRONMENT_NAME) {
  // Load .env (production values like postgres.railway.app)
  config({ path: path.join(__dirname, "../.env") });
}

export {}; // Make this a module

