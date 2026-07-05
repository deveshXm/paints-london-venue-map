export const groupRules = {
  "Show & Tell Drinks": { min: 2, max: 6 },
  "Market Days": { min: 2, max: 6 },
  "Creative Walks": { min: 2, max: 6 },
  "Museum & Gallery Days": { min: 2, max: 4 },
  "Books & Coffee": { min: 2, max: 4 },
};

export const adjustedGroupSizeOverflow = 2;

export function validateGroup(group, batchUsers, week) {
  const ids = Array.isArray(group.user_ids) ? [...new Set(group.user_ids.map(String))] : [];
  const users = ids.map((id) => batchUsers.find((user) => String(user.id) === id)).filter(Boolean);
  const category = users[0]?.category;
  const rule = groupRules[category] || { min: 2, max: 4 };
  if (users.length < rule.min || users.length > rule.max) return null;
  if (users.some((user) => user.category !== category)) return null;
  if (users.some((user) => user.availability !== users[0].availability)) return null;
  return normalizeGroup({
    ...group,
    category,
    availability: users[0].availability,
    user_ids: users.map((user) => user.id),
    match_quality: group.match_quality || "good",
  }, week);
}

export function validateAdjustedGroup(group, availableUsers, week) {
  const ids = Array.isArray(group.user_ids) ? [...new Set(group.user_ids.map(String))] : [];
  const users = ids.map((id) => availableUsers.find((user) => String(user.id) === id)).filter(Boolean);
  const category = group.category || majorityValue(users.map((user) => user.category)) || users[0]?.category;
  const availability = group.availability || majorityValue(users.map((user) => user.availability)) || users[0]?.availability;
  const rule = groupRules[category] || { min: 2, max: 4 };
  const compromisedMetrics = normalizeCompromisedMetrics(group.compromised_metrics);
  if (!category || !availability) return null;
  if (users.length < rule.min || users.length > rule.max + adjustedGroupSizeOverflow) return null;
  if (users.length !== ids.length) return null;
  if (group.match_quality && !["good", "fallback"].includes(group.match_quality)) return null;

  const mismatches = users.flatMap((user) => {
    const issues = [];
    if (user.category !== category) issues.push({ user_id: String(user.id), metric: "category", from: user.category, to: category });
    if (user.availability !== availability) issues.push({ user_id: String(user.id), metric: "day/time", from: user.availability, to: availability });
    return issues;
  });
  if (users.length > rule.max) {
    mismatches.push({
      user_id: "group",
      metric: "group size",
      from: `${rule.max}`,
      to: `${users.length}`,
    });
  }
  if (mismatches.length && !mismatches.every((mismatch) => hasCompromise(compromisedMetrics, mismatch))) return null;

  return normalizeGroup({
    ...group,
    category,
    availability,
    user_ids: users.map((user) => user.id),
    match_quality: mismatches.length ? "fallback" : group.match_quality || "good",
    fallback_reason: group.fallback_reason || compromiseSummary(mismatches),
    adjusted_match: true,
    compromised_metrics: compromisedMetrics,
  }, week);
}

function normalizeGroup(group, week) {
  return {
    id: group.id || `g-${week}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    week,
    category: group.category,
    availability: group.availability,
    area: group.area || "London",
    user_ids: group.user_ids,
    match_quality: group.match_quality || "good",
    fallback_reason: group.fallback_reason || "",
    adjusted_match: Boolean(group.adjusted_match),
    compromised_metrics: normalizeCompromisedMetrics(group.compromised_metrics),
  };
}

function normalizeCompromisedMetrics(metrics) {
  if (!Array.isArray(metrics)) return [];
  return metrics
    .map((metric) => ({
      user_id: String(metric.user_id || ""),
      metric: String(metric.metric || ""),
      from: String(metric.from || ""),
      to: String(metric.to || ""),
      severity: metric.severity ? String(metric.severity) : "",
    }))
    .filter((metric) => metric.user_id && metric.metric && metric.from && metric.to);
}

function hasCompromise(metrics, mismatch) {
  const wantedMetric = normalizeMetricName(mismatch.metric);
  return metrics.some((metric) => {
    if (String(metric.user_id) !== String(mismatch.user_id)) return false;
    const actualMetric = normalizeMetricName(metric.metric);
    if (actualMetric !== wantedMetric) return false;
    return String(metric.from) === String(mismatch.from) && String(metric.to) === String(mismatch.to);
  });
}

function normalizeMetricName(metric) {
  const text = String(metric || "").toLowerCase();
  if (text.includes("time") || text.includes("day") || text.includes("availability")) return "day/time";
  return text;
}

function majorityValue(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function compromiseSummary(mismatches) {
  if (!mismatches.length) return "";
  const labels = [...new Set(mismatches.map((mismatch) => mismatch.metric))].join(", ");
  return `Adjusted match: compromised ${labels}.`;
}
