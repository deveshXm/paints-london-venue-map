# PAINTS London Venue Sourcing District Agent Brief

Current date: 2026-07-04.

You are sourcing one London borough/district for PAINTS using the attached PAINTS v6 criteria at:
`/Users/yoda/.codex/attachments/1c9d4bb5-1dd7-4d6f-b5fd-3a94ad3b3b9d/pasted-text.txt`

Research live/current sources on the web. Do not invent operational details. If a detail is not found, write `UNVERIFIED - host must confirm`.

## Target

Aim for 30-35 qualifying venues in your assigned district, across these categories:
- Show & Tell Drinks
- Market Days
- Creative Walks
- Museum & Gallery Days
- Books & Coffee

Quality beats volume. Do not include venues below PAINTS score 65. Do not pad.

## Creative Walk Constraint

Creative Walks must only use PAINTS-approved parks/routes from the v6 safety list. If the borough does not contain a qualifying route, include fewer Creative Walks and explain in rejected candidates or notes.

## Required Output File

Write a single JSON file at:
`/Users/yoda/Documents/Paints London Venues/agent_outputs/<district_slug>.json`

Use this exact top-level shape:

```json
{
  "district": "District name",
  "run_date": "2026-07-04",
  "agent_notes": ["short caveat or finding"],
  "venues": [],
  "rejected_candidates": []
}
```

Each venue object must contain:

```json
{
  "venue_name": "",
  "district": "",
  "neighbourhood_station": "",
  "category": "",
  "tier": "A or B",
  "price": "£ / ££ / £££",
  "paints_fit_score": 0,
  "score_aesthetic_25": 0,
  "score_category_fit_20": 0,
  "score_story_15": 0,
  "score_operational_15": 0,
  "score_press_15": 0,
  "score_geography_10": 0,
  "score_obviousness_penalty_minus10": 0,
  "google_maps_location": "",
  "latitude": null,
  "longitude": null,
  "opening_hours": "",
  "walk_in_policy": "",
  "group_suitability_8_12": "",
  "capacity_notes": "",
  "best_time_slot": "",
  "why_fits_paints": "",
  "anecdote_story": "",
  "serve_or_on_view": "",
  "safety_notes": "",
  "backup_venue": "",
  "backup_walk_time": "",
  "backup_score": null,
  "risks_watchouts": "",
  "source_urls_citations": ""
}
```

Each rejected candidate object must contain:

```json
{
  "venue_name": "",
  "district": "",
  "category": "",
  "reason_rejected": "",
  "source_urls_citations": ""
}
```

## Verification Standard

- Cite sources as plain URLs separated by spaces.
- Include Google Maps links and coordinates for every included venue.
- Mark unknown hours, walk-in policy, group suitability, or capacity as `UNVERIFIED - host must confirm`.
- For current exhibition claims, use recent/current official or press pages when available.
- Use the score floor: Tier A >= 75, Tier B 65-74.
- If no qualifying backup exists within PAINTS radius, state that in `backup_venue` / `backup_walk_time` and demote primary to Tier B.

Final response back to parent should be short: district, file path, venue count, rejected count, and biggest caveat.
