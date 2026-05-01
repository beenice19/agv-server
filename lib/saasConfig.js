require("dotenv").config();

const requiredServerKeys = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
};

function isValueReady(value) {
  return Boolean(value) && !String(value).includes("PASTE_");
}

function getSaasReadiness() {
  const status = {};

  for (const [key, value] of Object.entries(requiredServerKeys)) {
    status[key] = isValueReady(value);
  }

  const readyCount = Object.values(status).filter(Boolean).length;
  const totalCount = Object.keys(status).length;

  return {
    ready: readyCount === totalCount,
    readyCount,
    totalCount,
    status,
  };
}

module.exports = {
  getSaasReadiness,
};