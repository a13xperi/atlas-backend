import { createClient } from "@supabase/supabase-js";
import { config } from "./config";
import { logger } from "./logger";

const supabaseUrl = config.SUPABASE_URL;
const supabaseServiceRoleKey = config.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  logger.warn(
    "[supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — Supabase Auth disabled"
  );
}

export const supabaseAdmin = supabaseUrl && supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;
