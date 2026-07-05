import { validateAdjustedGroup, validateGroup } from "../matching-rules.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const week = 12;
const users = [
  {
    id: "hassan",
    category: "Books & Coffee",
    availability: "Saturday afternoon",
    district: "Camden",
    age: 31,
    price_preference: "££",
  },
  {
    id: "lucy",
    category: "Books & Coffee",
    availability: "Saturday afternoon",
    district: "Islington",
    age: 29,
    price_preference: "££",
  },
  {
    id: "deepa",
    category: "Books & Coffee",
    availability: "Saturday morning",
    district: "Hackney",
    age: 33,
    price_preference: "££",
  },
  {
    id: "gareth",
    category: "Books & Coffee",
    availability: "Saturday evening",
    district: "Hackney",
    age: 35,
    price_preference: "££",
  },
  {
    id: "isla",
    category: "Show & Tell Drinks",
    availability: "Friday evening",
    district: "Hackney",
    age: 28,
    price_preference: "££",
  },
  {
    id: "maya",
    category: "Books & Coffee",
    availability: "Saturday afternoon",
    district: "Camden",
    age: 30,
    price_preference: "££",
  },
  {
    id: "omar",
    category: "Books & Coffee",
    availability: "Saturday afternoon",
    district: "Islington",
    age: 32,
    price_preference: "££",
  },
  {
    id: "nina",
    category: "Books & Coffee",
    availability: "Saturday afternoon",
    district: "Hackney",
    age: 34,
    price_preference: "££",
  },
];

const strictMismatch = validateGroup({
  user_ids: ["hassan", "lucy", "deepa"],
  area: "North London",
}, users, week);
assert(!strictMismatch, "Strict grouping should still reject mixed availability.");

const adjustedTimeGroup = validateAdjustedGroup({
  user_ids: ["hassan", "lucy", "deepa", "gareth"],
  category: "Books & Coffee",
  availability: "Saturday afternoon",
  area: "North London",
  reason: "Closest shared category group with adjacent Saturday slots.",
  match_quality: "fallback",
  fallback_reason: "Deepa and Gareth are shifted into Saturday afternoon.",
  compromised_metrics: [
    { user_id: "deepa", metric: "time slot", from: "Saturday morning", to: "Saturday afternoon" },
    { user_id: "gareth", metric: "time slot", from: "Saturday evening", to: "Saturday afternoon" },
  ],
}, users, week);
assert(adjustedTimeGroup, "Adjusted grouping should allow mixed availability when compromises are recorded.");
assert(adjustedTimeGroup.adjusted_match === true, "Adjusted group should be explicitly marked.");
assert(adjustedTimeGroup.compromised_metrics.length === 2, "Adjusted group should preserve compromised metrics.");

const missingCompromise = validateAdjustedGroup({
  user_ids: ["hassan", "lucy", "deepa"],
  category: "Books & Coffee",
  availability: "Saturday afternoon",
  match_quality: "fallback",
}, users, week);
assert(!missingCompromise, "Adjusted grouping should reject mismatches without compromised metrics.");

const adjustedCategoryGroup = validateAdjustedGroup({
  user_ids: ["hassan", "lucy", "isla"],
  category: "Books & Coffee",
  availability: "Saturday afternoon",
  match_quality: "fallback",
  fallback_reason: "Isla is shifted from drinks to the closest available bookshop event.",
  compromised_metrics: [
    { user_id: "isla", metric: "category", from: "Show & Tell Drinks", to: "Books & Coffee" },
    { user_id: "isla", metric: "day/time", from: "Friday evening", to: "Saturday afternoon" },
  ],
}, users, week);
assert(adjustedCategoryGroup, "Adjusted grouping should allow category fallback when explicitly recorded.");

const oversizedWithoutCompromise = validateAdjustedGroup({
  user_ids: ["hassan", "lucy", "deepa", "gareth", "maya"],
  category: "Books & Coffee",
  availability: "Saturday afternoon",
  match_quality: "fallback",
  fallback_reason: "Five people is used to avoid leaving one person out.",
  compromised_metrics: [
    { user_id: "deepa", metric: "time slot", from: "Saturday morning", to: "Saturday afternoon" },
    { user_id: "gareth", metric: "time slot", from: "Saturday evening", to: "Saturday afternoon" },
  ],
}, users, week);
assert(!oversizedWithoutCompromise, "Adjusted overflow group should require a group size compromise.");

const oversizedWithCompromise = validateAdjustedGroup({
  user_ids: ["hassan", "lucy", "deepa", "gareth", "maya"],
  category: "Books & Coffee",
  availability: "Saturday afternoon",
  match_quality: "fallback",
  fallback_reason: "Five people is used to avoid leaving one person out.",
  compromised_metrics: [
    { user_id: "deepa", metric: "time slot", from: "Saturday morning", to: "Saturday afternoon" },
    { user_id: "gareth", metric: "time slot", from: "Saturday evening", to: "Saturday afternoon" },
    { user_id: "group", metric: "group size", from: "4", to: "5" },
  ],
}, users, week);
assert(oversizedWithCompromise, "Adjusted grouping should allow normal max + 2 with group size compromise.");

const tooLarge = validateAdjustedGroup({
  user_ids: ["hassan", "lucy", "deepa", "gareth", "maya", "omar", "nina"],
  category: "Books & Coffee",
  availability: "Saturday afternoon",
  match_quality: "fallback",
  fallback_reason: "Too many users for Books & Coffee.",
  compromised_metrics: [
    { user_id: "deepa", metric: "time slot", from: "Saturday morning", to: "Saturday afternoon" },
    { user_id: "gareth", metric: "time slot", from: "Saturday evening", to: "Saturday afternoon" },
    { user_id: "group", metric: "group size", from: "4", to: "7" },
  ],
}, users, week);
assert(!tooLarge, "Adjusted grouping should still reject more than normal max + 2.");

console.log("adjusted grouping ok");
