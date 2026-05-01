require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { supabaseAdmin, isSupabaseAdminReady } = require("./lib/supabaseAdmin");

const app = express();
const PORT = 8790;

app.use(cors());
app.use(express.json());

function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (
    !supabaseUrl ||
    !supabaseAnonKey ||
    String(supabaseUrl).includes("PASTE_") ||
    String(supabaseAnonKey).includes("PASTE_")
  ) {
    return null;
  }

  return createClient(supabaseUrl, supabaseAnonKey);
}

app.get("/", (req, res) => {
  res.send("AGV Supabase Auth Test Server Running");
});

app.get("/api/supabase/status", (req, res) => {
  res.json({
    ok: true,
    supabaseUrlReady:
      Boolean(process.env.SUPABASE_URL) &&
      !String(process.env.SUPABASE_URL).includes("PASTE_"),
    supabaseAnonReady:
      Boolean(process.env.SUPABASE_ANON_KEY) &&
      !String(process.env.SUPABASE_ANON_KEY).includes("PASTE_"),
    supabaseServiceReady: isSupabaseAdminReady(),
  });
});

app.post("/api/supabase/signup", async (req, res) => {
  try {
    if (!isSupabaseAdminReady() || !supabaseAdmin) {
      return res.status(500).json({
        ok: false,
        error: "Supabase service role is not configured on SERVER .env",
      });
    }

    const { email, password, displayName } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: "Email and password are required",
      });
    }

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        display_name: displayName || "AGV User",
      },
    });

    if (error) {
      return res.status(400).json({
        ok: false,
        error: error.message,
      });
    }

    res.json({
      ok: true,
      user: {
        id: data.user.id,
        email: data.user.email,
      },
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

app.post("/api/supabase/login", async (req, res) => {
  try {
    const supabase = getSupabaseClient();

    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error: "Supabase anon key is not configured on SERVER .env",
      });
    }

    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: "Email and password are required",
      });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(401).json({
        ok: false,
        error: error.message,
      });
    }

    res.json({
      ok: true,
      user: {
        id: data.user.id,
        email: data.user.email,
      },
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`AGV SUPABASE AUTH TEST SERVER RUNNING ON ${PORT}`);
});