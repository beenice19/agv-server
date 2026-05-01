require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function isSupabaseAdminReady() {
  return (
    Boolean(supabaseUrl) &&
    Boolean(supabaseServiceRoleKey) &&
    !String(supabaseUrl).includes("PASTE_") &&
    !String(supabaseServiceRoleKey).includes("PASTE_")
  );
}

const supabaseAdmin = isSupabaseAdminReady()
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;

module.exports = {
  supabaseAdmin,
  isSupabaseAdminReady,
};