import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

const missing = [
  !SUPABASE_URL && "SUPABASE_URL",
  !SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY",
].filter(Boolean);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(", ")}. ` +
      "Set them in backend/.env (see backend/.env.example).",
  );
}

// Service role key bypasses RLS as it is backend-only and never expose to the browser.
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
