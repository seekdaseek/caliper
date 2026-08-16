const m = require("/opt/caliper/model.json");
const s = Object.keys(m.thresholds || {});
if (!s.length) { console.error("no thresholds in model.json"); process.exit(1); }
process.stdout.write(s.join(","));
