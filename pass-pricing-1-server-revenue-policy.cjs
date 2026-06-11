const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "index.js");

if (!fs.existsSync(file)) {
  console.error("PASS PRICING-1 FAILED: index.js not found.");
  process.exit(1);
}

let src = fs.readFileSync(file, "utf8");

const stamp = Date.now();
const backup = path.join(process.cwd(), `index.BEFORE-PASS-PRICING-1.${stamp}.js`);
fs.writeFileSync(backup, src, "utf8");

const marker = "/* AGV PASS PRICING-1 — REVENUE POLICY FOUNDATION */";

if (src.includes(marker)) {
  console.log("PASS PRICING-1 already installed.");
  console.log("Backup created:", backup);
  process.exit(0);
}

const pricingBlock = `
${marker}
const AGV_REVENUE_POLICY = Object.freeze({
  ok: true,
  service: "AGV Revenue Policy Foundation",
  pass: "PASS PRICING-1",
  currency: "USD",
  monthlySubscriptionPurpose: "Platform access",
  subscriptionRule: "Monthly subscriptions provide access to the AGV platform, rooms, host tools, viewer tools, event controls, and plan features. Monthly subscription pricing does not include unlimited broadcast delivery.",
  agvTicketPlatformFeePercent: 7,
  ticketFeeRule: "Paid ticketed events include a 7% AGV ticket platform fee. This is AGV monetization revenue and is separate from broadcast delivery and payment processing.",
  broadcastDeliveryFeeRule: "Broadcast delivery fees are billed separately based on audience size, watch time, streaming usage, Cloudflare delivery, storage, and related broadcast infrastructure costs.",
  paymentProcessingRule: "Payment processing fees are passed through separately and are not included in the AGV 7% ticket platform fee.",
  largeEventRule: "Large audience broadcasts, international events, conventions, high-viewer programs, and unusual streaming loads may require a custom quote before going live.",
  planPricingPurpose: {
    free: "Free platform access for limited testing and basic use.",
    creator: "Creator platform access for independent creators and smaller paid events.",
    ministryPro: "Ministry / Pro platform access for ministries, teachers, podcasters, and professional programs.",
    convention: "Convention platform access for larger organized events. Large audience delivery may still require a custom quote."
  },
  feeModel: {
    monthlySubscription: "Platform access",
    ticketPlatformFee: "7% AGV monetization fee",
    broadcastDeliveryFee: "Separate usage-based fee to cover Cloudflare and streaming delivery",
    paymentProcessing: "Passed through separately",
    largeEvents: "Custom quote"
  },
  customerFacingSummary: "AGV monthly plans provide platform access. Paid ticketed events include a 7% AGV platform fee. Broadcast delivery fees are billed separately based on audience size, watch time, and streaming usage. Standard payment processing fees are passed through separately. Large audience events may require a custom quote."
});

function agvRevenuePolicyResponse(extra = {}) {
  return {
    ...AGV_REVENUE_POLICY,
    ...extra,
    timestamp: new Date().toISOString()
  };
}

app.get("/api/revenue-policy", (req, res) => {
  res.json(agvRevenuePolicyResponse({
    endpoint: "/api/revenue-policy"
  }));
});

app.get("/api/pricing-policy", (req, res) => {
  res.json(agvRevenuePolicyResponse({
    endpoint: "/api/pricing-policy"
  }));
});

app.get("/api/agv-fees", (req, res) => {
  res.json(agvRevenuePolicyResponse({
    endpoint: "/api/agv-fees"
  }));
});
/* END AGV PASS PRICING-1 */
`;

function insertBeforeListen(source, block) {
  const targets = [
    "\napp.listen(",
    "\r\napp.listen(",
    "\nserver.listen(",
    "\r\nserver.listen("
  ];

  for (const target of targets) {
    const index = source.indexOf(target);
    if (index !== -1) {
      return source.slice(0, index) + "\n" + block + "\n" + source.slice(index);
    }
  }

  return source + "\n" + block + "\n";
}

src = insertBeforeListen(src, pricingBlock);

fs.writeFileSync(file, src, "utf8");

console.log("PASS PRICING-1 INSTALLED SUCCESSFULLY");
console.log("Updated:", file);
console.log("Backup:", backup);
console.log("");
console.log("Added routes:");
console.log("GET /api/revenue-policy");
console.log("GET /api/pricing-policy");
console.log("GET /api/agv-fees");
