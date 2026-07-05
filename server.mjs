import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, run, tool, webSearchTool } from "@openai/agents";
import { z } from "zod";
import { adjustedGroupSizeOverflow, groupRules, validateAdjustedGroup, validateGroup } from "./matching-rules.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
const usersPath = path.join(dataDir, "users.json");
const eventsPath = path.join(dataDir, "events.json");
const statePath = path.join(dataDir, "state.json");

loadEnvFiles([
  path.join(__dirname, ".env"),
  path.join(path.dirname(__dirname), "Paints London Venues", ".env"),
]);

const port = Number(process.env.PORT || 8765);
const model = process.env.OPENAI_MODEL || "gpt-5.5";
const agentModelSettings = {
  reasoning: { effort: "medium" },
  text: { verbosity: "medium" },
};
const agentMaxTurns = Number(process.env.PAINTS_AGENT_MAX_TURNS || 100);
const groupMaxGroupsPerPass = Number(process.env.PAINTS_GROUP_MAX_GROUPS_PER_PASS || 25);
const groupMaxPassesPerBatch = Number(process.env.PAINTS_GROUP_MAX_PASSES_PER_BATCH || 8);
const eventAgentConcurrency = Number(process.env.PAINTS_EVENT_AGENT_CONCURRENCY || 10);
const jobs = new Map();
let activeJobId = "";
let dbMutationQueue = Promise.resolve();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
};

const venues = await loadVenues();

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/api/state") {
      sendJson(response, 200, await readDb());
      return;
    }
    if (request.method === "POST" && request.url === "/api/state") {
      const body = await readJsonBody(request);
      const db = await replaceDb({
        users: Array.isArray(body.users) ? body.users : [],
        events: Array.isArray(body.events) ? body.events : [],
        week: Number.isFinite(Number(body.week)) ? Number(body.week) : 1,
      });
      sendJson(response, 200, db);
      return;
    }
    if (request.method === "POST" && request.url === "/api/users") {
      const body = await readJsonBody(request);
      const db = await updateDb((current) => {
        current.users.push(body.user);
        return current;
      });
      sendJson(response, 200, db);
      return;
    }
    if (request.method === "POST" && request.url === "/api/reset") {
      sendJson(response, 200, await replaceDb({ users: [], events: [], week: 1 }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/run-agents") {
      await handleRunAgents(request, response);
      return;
    }
    if (request.method === "GET" && request.url.startsWith("/api/jobs/")) {
      const jobId = decodeURIComponent(request.url.split("/").at(-1) || "");
      const job = jobs.get(jobId);
      if (!job) {
        sendJson(response, 404, { error: "Job not found." });
        return;
      }
      sendJson(response, 200, publicJob(job));
      return;
    }
    if (request.method === "POST" && request.url.startsWith("/api/jobs/") && request.url.endsWith("/cancel")) {
      const jobId = decodeURIComponent(request.url.split("/").at(-2) || "");
      const job = jobs.get(jobId);
      if (!job) {
        sendJson(response, 404, { error: "Job not found." });
        return;
      }
      job.cancel_requested = true;
      updateJob(job, { status: job.status === "completed" ? "completed" : "cancelling" });
      sendJson(response, 200, publicJob(job));
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    await serveStatic(request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message || "Server error" });
  }
});

server.listen(port, () => {
  console.log(`PAINTS agent server running at http://localhost:${port}/`);
});

async function handleRunAgents(request, response) {
  if (activeJobId) {
    sendJson(response, 409, {
      error: "Another PAINTS agent run is already active. Please wait for it to finish.",
      job_id: activeJobId,
    });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    sendJson(response, 200, {
      error: "OPENAI_API_KEY is not set. Start the server with OPENAI_API_KEY=... npm start",
    });
    return;
  }

  const body = await readJsonBody(request);
  const currentDb = await readDb();
  const job = createJob({
    users: Array.isArray(body.users) ? body.users : currentDb.users,
    events: Array.isArray(body.events) ? body.events : currentDb.events,
    week: Number.isFinite(Number(body.week)) ? Number(body.week) : currentDb.week,
  });

  activeJobId = job.id;
  runAgentJob(job).catch((error) => {
    console.error("PAINTS agent job failed", error);
    if (job.status === "cancelled") return;
    updateJob(job, {
      status: "failed",
      phase: "failed",
      error: error.message || "Agent job failed.",
      finished_at: new Date().toISOString(),
    });
  }).finally(() => {
    if (activeJobId === job.id) activeJobId = "";
  });

  sendJson(response, 202, publicJob(job));
}

function createJob(input) {
  const now = new Date().toISOString();
  const job = {
    id: `job-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    status: "queued",
    phase: "queued",
    created_at: now,
    updated_at: now,
    finished_at: "",
    cancel_requested: false,
    input,
    users: input.users,
    events: input.events,
    week: input.week,
    log: "Queued PAINTS agent run.",
    error: "",
    progress: {
      total_users: input.users.length,
      batches_total: 0,
      batches_done: 0,
      groups_created: 0,
      groups_total: 0,
      planned_events: 0,
      events_created: 0,
      event_groups_done: 0,
      failed_units: 0,
      conflicts: 0,
    },
    failures: [],
  };
  jobs.set(job.id, job);
  return job;
}

async function runAgentJob(job) {
  updateJob(job, { status: "running", phase: "starting", log: "Starting PAINTS agent run." });
  const users = job.input.users;
  const existingEvents = job.input.events;
  const week = job.input.week;

  if (users.length < 2) {
    updateJob(job, {
      status: "completed",
      phase: "completed",
      users,
      events: existingEvents,
      week,
      log: "Need at least 2 users before agents can create a matched event.",
      finished_at: new Date().toISOString(),
    });
    return;
  }

  const batches = batchUsers(users, week);
  job.progress.batches_total = batches.length;
  const groups = [];
  const groupFailures = [];

  for (const batch of batches) {
    throwIfCancelled(job);
    updateJob(job, { phase: "grouping", log: `Grouping ${batch.category} / ${batch.availability}...` });
    const result = await collectGroupsForBatch(batch, week, job);
    groups.push(...result.groups);
    groupFailures.push(...result.failures);
    job.progress.batches_done += 1;
    job.progress.groups_created = groups.length;
    job.progress.failed_units = groupFailures.length;
    updateJob(job);
  }

  throwIfCancelled(job);
  const adjustedResult = await runAdjustedGroupAgent({
    users,
    groups,
    week,
    job,
  });
  groups.splice(0, groups.length, ...adjustedResult.groups);
  groupFailures.push(...adjustedResult.failures);
  job.progress.groups_created = groups.length;
  job.progress.failed_units = groupFailures.length;
  updateJob(job, {
    phase: "grouping",
    log: adjustedResult.adjusted_count
      ? `Adjusted grouping recovered ${adjustedResult.recovered_user_count} users across ${adjustedResult.adjusted_count} groups.`
      : "Strict grouping complete. No adjusted grouping needed.",
  });

  const events = [...existingEvents];
  const updatedUsers = users.map((user) => ({ ...user }));
  const reservations = reservationSet(events);
  let saveQueue = Promise.resolve();

  async function saveSnapshot() {
    saveQueue = saveQueue.then(() => replaceDb({ users: updatedUsers, events, week: week + 1 }));
    await saveQueue;
  }

  job.progress.groups_total = groups.length;
  job.progress.failed_units = groupFailures.length;
  job.failures.push(...groupFailures);
  updateJob(job, { phase: "events", log: `Running ${Math.min(eventAgentConcurrency, groups.length)} concurrent venue agents for ${groups.length} groups...` });

  await runVenueAgentRacePool({
    groups,
    users: updatedUsers,
    events,
    week,
    job,
    reservations,
    onEventCreated: async (event) => {
      events.push(event);
      applyEventToUsers(updatedUsers, event);
      job.progress.planned_events += 1;
      job.progress.events_created += 1;
      await saveSnapshot();
    },
    onGroupDone: (result) => {
      job.progress.event_groups_done += 1;
      job.progress.conflicts += result.conflicts || 0;
      if (!result.created) job.progress.failed_units += 1;
      updateJob(job);
    },
  });

  const saved = await replaceDb({ users: updatedUsers, events, week: week + 1 });
  updateJob(job, {
    status: "completed",
    phase: "completed",
    users: saved.users,
    events: saved.events,
    week: saved.week,
    log: `Real agents created ${job.progress.events_created} events from ${groups.length} groups across ${batches.length} batches. ${job.progress.planned_events} primary venues claimed. ${job.progress.failed_units} units failed. ${job.progress.conflicts} venue conflicts retried.`,
    finished_at: new Date().toISOString(),
  });
}

async function runVenueAgentRacePool({ groups, users, events, week, job, reservations, onEventCreated, onGroupDone }) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, eventAgentConcurrency), groups.length || 1);

  async function worker() {
    while (nextIndex < groups.length) {
      throwIfCancelled(job);
      const group = groups[nextIndex];
      nextIndex += 1;
      let result = { created: false, conflicts: 0 };
      try {
        result = await runVenueAgent(group, users, events, week, reservations);
        if (result.created) await onEventCreated(result.event);
      } catch (error) {
        result = { created: false, conflicts: result.conflicts || 0, failure: error.message || "Venue Agent failed." };
      } finally {
        if (!result.created) {
          job.failures.push({
            group_id: group.id,
            user_ids: group.user_ids,
            category: group.category,
            availability: group.availability,
            status: "venue_agent_failed",
            reason: result.failure || "Venue Agent ended without creating an event.",
            conflicts: result.conflicts || 0,
            trace: result.trace || [],
            final_output: result.final_output || "",
          });
        }
        onGroupDone(result);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

async function runVenueAgent(group, users, events, week, reservations) {
  const groupUsers = group.user_ids.map((id) => users.find((user) => user.id === id)).filter(Boolean);
  if (groupUsers.length < 2) return { created: false, conflicts: 0, failure: "Group has fewer than 2 users." };

  const dateTime = `${group.availability} · Week ${week}`;
  let claimedPrimaryId = "";
  let claimedBackupId = "";
  let claimedBackupMeta = {};
  let createdEvent = null;
  let conflicts = 0;
  const trace = [];

  function remember(entry) {
    trace.push({ at: new Date().toISOString(), ...entry });
    if (trace.length > 80) trace.shift();
  }

  function releaseClaims() {
    if (claimedPrimaryId) reservations.delete(reservationKey(dateTime, claimedPrimaryId));
    claimedPrimaryId = "";
    claimedBackupId = "";
    claimedBackupMeta = {};
  }

  const agent = new Agent({
    name: "PAINTS Venue Agent",
    model,
    modelSettings: agentModelSettings,
    instructions: [
      "You choose the event venue for one PAINTS group.",
      "Goal: create a real event, but protect PAINTS quality before using fallback.",
      "Work in quality passes. Do not claim the first acceptable venue if clearly better options are available.",
      "Pass 1 primary: same category, strong PAINTS score, believable opening hours for the group time, price compatible with most users, good story, and sensible geography.",
      "Pass 2 primary: broaden geography before weakening category or operational fit.",
      "Pass 3 primary: only then accept lower score, price stretch, or operational uncertainty; mark fallback_reason clearly.",
      "Avoid venues whose stored hours obviously conflict with the event time unless web search or the venue notes make the fit plausible.",
      "Price compatibility matters. Do not choose $$$ for mostly $ users unless there is no cleaner option.",
      "Capacity matters as an operational signal. Use capacity fields, capacity_notes, best_for, and walk_in_policy. Unknown capacity is allowed for small groups, but mention it in fallback_reason.",
      "Primary venue quality matters more than backup perfection, but bad backups still hurt the product.",
      "Backup search ladder: first same category and 5-10 min walk; then same category 10-15; then same category 15-25; then different category nearby; then citywide fallback.",
      "Avoid backup walks over 20 minutes unless there is no same-category or nearby operationally plausible backup.",
      "Avoid backup category mismatch unless the backup is clearly operationally useful and fallback_reason explains the tradeoff.",
      "Backup venues are not booking locks. A venue may be backup for this event and primary/backup for another event at the same time.",
      "If claiming primary returns conflict, another agent won the race. Pick another primary and continue.",
      "If backup is weak, keep the good primary and keep searching backups before changing primary.",
      "Do not fail just because obvious venues are taken. Search citywide and across categories if needed.",
      "Call create_event only after both primary and backup are claimed. Use match_quality fallback only when a real quality tradeoff remains.",
      "The storyline is user-facing: tell them the place theme/anecdote, not why PAINTS selected it.",
      "Return strict JSON at the end: {\"title\":\"...\",\"storyline\":\"...\",\"meeting_point_notes\":\"...\",\"match_quality\":\"ideal|good|fallback\",\"fallback_reason\":\"...\"}",
    ].join("\n"),
    tools: [
      tool({
        name: "search_primary_venues",
        description: "Search available primary venues. Agent chooses category, area, price, score, or near filters; backend only excludes already-booked primaries.",
        parameters: z.object({
          area: z.string().optional(),
          category: z.string().optional(),
          district: z.string().optional(),
          near: z.object({
            lat: z.number(),
            lng: z.number(),
            radius_km: z.number().min(0).max(100),
          }).optional(),
          price: z.string().optional(),
          min_score: z.number().min(0).max(100).optional(),
          limit: z.number().int().min(1).max(80).optional(),
        }),
        async execute({ area, category, district, near, price, min_score, limit = 50 }) {
          const results = primaryVenueOptionsForGroup(group, users, events, week, reservations, { area, category, district, near, price, min_score, limit });
          remember({ tool: "search_primary_venues", area: area || "", category: category || "any", district: district || "", price: price || "", min_score: min_score || "", count: results.length });
          return results;
        },
      }),
      tool({
        name: "claim_primary_venue",
        description: "Try to atomically claim a primary venue for this event. If conflict, search/pick another primary.",
        parameters: z.object({
          primary_venue_id: z.string(),
        }),
        async execute({ primary_venue_id }) {
          if (claimedPrimaryId) return { ok: false, error: "Primary already claimed. Continue with backup search or create_event." };
          const validation = validatePrimaryVenue(group, primary_venue_id, week, reservations);
          if (!validation.ok) {
            if (validation.conflict) conflicts += 1;
            remember({ tool: "claim_primary_venue", venue_id: primary_venue_id, ok: false, error: validation.error });
            return { ok: false, error: validation.error };
          }
          claimedPrimaryId = String(primary_venue_id);
          reservations.add(reservationKey(dateTime, claimedPrimaryId));
          remember({ tool: "claim_primary_venue", venue_id: claimedPrimaryId, ok: true });
          return { ok: true, primary: compactVenue(venueById(claimedPrimaryId)) };
        },
      }),
      tool({
        name: "search_backup_near_primary",
        description: "Search backup venues around the claimed primary. Start near the primary, then expand min/max as needed; distance is a preference, not a backend blocker.",
        parameters: z.object({
          backup_minutes_min: z.number().min(0).max(180).optional(),
          backup_minutes_max: z.number().min(1).max(180).optional(),
          category: z.string().optional(),
          limit: z.number().int().min(1).max(80).optional(),
        }),
        async execute({ backup_minutes_min = 5, backup_minutes_max = 10, category, limit = 40 }) {
          if (!claimedPrimaryId) return { error: "Claim a primary venue first." };
          const results = backupOptionsForPrimary(group, claimedPrimaryId, week, reservations, { backup_minutes_min, backup_minutes_max, category, limit });
          remember({ tool: "search_backup_near_primary", primary_venue_id: claimedPrimaryId, category: category || "any", backup_minutes_min, backup_minutes_max, count: results.length });
          return results;
        },
      }),
      tool({
        name: "claim_backup_venue",
        description: "Try to atomically claim a backup venue near the claimed primary.",
        parameters: z.object({
          backup_venue_id: z.string(),
          match_quality: z.enum(["ideal", "good", "fallback"]).optional(),
          fallback_reason: z.string().optional(),
        }),
        async execute({ backup_venue_id, match_quality, fallback_reason }) {
          if (!claimedPrimaryId) return { ok: false, error: "Claim a primary venue first." };
          if (claimedBackupId) return { ok: false, error: "Backup already claimed. Create the event." };
          const validation = validateBackupVenue(group, claimedPrimaryId, backup_venue_id, week, reservations, { match_quality, fallback_reason });
          if (!validation.ok) {
            if (validation.conflict) conflicts += 1;
            remember({ tool: "claim_backup_venue", venue_id: backup_venue_id, ok: false, error: validation.error });
            return { ok: false, error: validation.error };
          }
          claimedBackupId = String(backup_venue_id);
          claimedBackupMeta = { match_quality, fallback_reason };
          remember({ tool: "claim_backup_venue", venue_id: claimedBackupId, ok: true, match_quality: match_quality || "", fallback_reason: fallback_reason || "" });
          return { ok: true, backup: compactVenue(venueById(claimedBackupId)) };
        },
      }),
      tool({
        name: "create_event",
        description: "Create the event after primary and backup are claimed.",
        parameters: z.object({
          title: z.string().optional(),
          storyline: z.string().optional(),
          meeting_point_notes: z.string().optional(),
          match_quality: z.enum(["ideal", "good", "fallback"]).optional(),
          fallback_reason: z.string().optional(),
        }),
        async execute(choice) {
          if (!claimedPrimaryId || !claimedBackupId) return { ok: false, error: "Claim primary and backup before creating event." };
          const created = createEvent({
            group,
            groupUsers,
            choice: {
              ...claimedBackupMeta,
              ...choice,
              primary_venue_id: claimedPrimaryId,
              backup_venue_id: claimedBackupId,
            },
            events,
            week,
          });
          if (!created.event) {
            remember({ tool: "create_event", ok: false, error: created.conflict ? "Primary venue conflict at create_event." : "Claimed venues failed event validation.", primary_venue_id: claimedPrimaryId, backup_venue_id: claimedBackupId });
            return { ok: false, error: "Claimed venues failed event validation." };
          }
          createdEvent = created.event;
          remember({ tool: "create_event", ok: true, event_id: created.event.id, primary_venue_id: claimedPrimaryId, backup_venue_id: claimedBackupId });
          return { ok: true, event: created.event };
        },
      }),
      webSearchTool({ searchContextSize: "medium" }),
    ],
  });

  try {
    const result = await run(
      agent,
      JSON.stringify({
        week,
        group: {
          id: group.id,
          category: group.category,
          availability: group.availability,
          area: group.area,
          users: groupUsers.map(compactUser),
        },
        instruction: "Race to claim the best primary venue, then claim a backup near that primary, then create the event.",
      }),
      { maxTurns: agentMaxTurns },
    );

    if (createdEvent) return { created: true, event: createdEvent, conflicts, trace };
    const parsed = parseJsonObject(result.finalOutput);
    if (claimedPrimaryId && claimedBackupId) {
      const created = createEvent({
        group,
        groupUsers,
        choice: {
          ...claimedBackupMeta,
          ...parsed,
          primary_venue_id: claimedPrimaryId,
          backup_venue_id: claimedBackupId,
        },
        events,
        week,
      });
      if (created.event) {
        remember({ tool: "post_agent_create_event", ok: true, event_id: created.event.id, primary_venue_id: claimedPrimaryId, backup_venue_id: claimedBackupId });
        return { created: true, event: created.event, conflicts, trace };
      }
      remember({ tool: "post_agent_create_event", ok: false, primary_venue_id: claimedPrimaryId, backup_venue_id: claimedBackupId });
    }
    const failure = venueAgentFailureReason({ claimedPrimaryId, claimedBackupId, trace, finalOutput: result.finalOutput });
    releaseClaims();
    return { created: false, conflicts, failure, trace, final_output: String(result.finalOutput || "").slice(0, 1000) };
  } catch (error) {
    remember({ tool: "agent_error", ok: false, error: error.message || "Venue Agent failed." });
    releaseClaims();
    return { created: false, conflicts, failure: error.message || "Venue Agent failed.", trace };
  }
}

function venueAgentFailureReason({ claimedPrimaryId, claimedBackupId, trace, finalOutput }) {
  const last = trace.at(-1);
  if (!claimedPrimaryId) return "Venue Agent ended without claiming a primary venue.";
  if (!claimedBackupId) return "Venue Agent claimed a primary venue but ended without claiming a backup venue.";
  if (last?.tool === "create_event" && last.ok === false) return `Venue Agent claimed both venues but create_event failed: ${last.error}`;
  if (last?.tool === "post_agent_create_event" && last.ok === false) return "Venue Agent claimed both venues but final event validation failed after agent output.";
  return `Venue Agent ended without creating an event. Last tool: ${last?.tool || "none"}. Final output: ${String(finalOutput || "").slice(0, 240)}`;
}

async function runBatchEventPlannerAgent(groups, users, events, week, job, reservations) {
  if (!groups.length) return [];
  const assignments = [];
  const groupsById = new Map(groups.map((group) => [String(group.id), group]));
  const planningReservations = new Set(reservations);
  const agent = new Agent({
    name: "PAINTS Batch Event Planner Agent",
    model,
    modelSettings: agentModelSettings,
    instructions: [
      "You plan primary venues for many PAINTS groups at once.",
      "Primary venue quality is the main decision. Choose the best primary first, then find a backup near that chosen primary.",
      "Your job is to avoid every group chasing the same obvious primary venues.",
      "Use search_groups to see the groups, search_primary_venues_for_group to inspect broad primary venue options, search_backups_for_primary only after choosing a primary, and assign_primary_with_backup to allocate one event.",
      "Create as many allocations as possible. Do not stop after one group.",
      "Backend tools enforce only safety and collisions. You decide the venue fit and tradeoffs.",
      "If no ideal primary is available nearby, expand geography before changing time. Do not change the primary just because the first backup search is thin; search more backups around the chosen primary.",
      "If the best primary/backup is imperfect, still allocate the closest viable fallback and explain fallback_reason internally.",
      "Return strict JSON at the end: {\"assignments\":[{\"group_id\":\"...\",\"primary_venue_id\":\"...\",\"backup_venue_id\":\"...\"}]}",
    ].join("\n"),
    tools: [
      tool({
        name: "search_groups",
        description: "See groups that still need venue pair allocation.",
        parameters: z.object({
          limit: z.number().int().min(1).max(80).optional(),
        }),
        async execute({ limit = 50 }) {
          const assignedGroupIds = new Set(assignments.map((assignment) => assignment.group_id));
          return groups
            .filter((group) => !assignedGroupIds.has(String(group.id)))
            .slice(0, limit)
            .map((group) => compactGroup(group, users));
        },
      }),
      tool({
        name: "search_primary_venues_for_group",
        description: "Find available primary venues for one group. This does not require a backup yet; use it to choose the main venue first.",
        parameters: z.object({
          group_id: z.string(),
          area: z.string().optional(),
          limit: z.number().int().min(1).max(60).optional(),
        }),
        async execute({ group_id, area, limit = 40 }) {
          const group = groupsById.get(String(group_id));
          if (!group) return { error: "Unknown group_id." };
          return primaryVenueOptionsForGroup(group, users, events, week, planningReservations, { area, category: group.category, limit });
        },
      }),
      tool({
        name: "search_backups_for_primary",
        description: "Find backup venues around the already chosen primary. If this returns thin options, expand backup_minutes_min/max before changing the primary.",
        parameters: z.object({
          group_id: z.string(),
          primary_venue_id: z.string(),
          backup_minutes_min: z.number().min(1).max(30).optional(),
          backup_minutes_max: z.number().min(1).max(180).optional(),
          limit: z.number().int().min(1).max(60).optional(),
        }),
        async execute({ group_id, primary_venue_id, backup_minutes_min = 5, backup_minutes_max = 10, limit = 30 }) {
          const group = groupsById.get(String(group_id));
          if (!group) return { error: "Unknown group_id." };
          return backupOptionsForPrimary(group, primary_venue_id, week, planningReservations, { backup_minutes_min, backup_minutes_max, limit });
        },
      }),
      tool({
        name: "assign_primary_with_backup",
        description: "Allocate one primary venue plus backup venue to one group for this batch if both are still free.",
        parameters: z.object({
          group_id: z.string(),
          primary_venue_id: z.string(),
          backup_venue_id: z.string(),
          title: z.string().optional(),
          storyline: z.string().optional(),
          meeting_point_notes: z.string().optional(),
          match_quality: z.enum(["ideal", "good", "fallback"]).optional(),
          fallback_reason: z.string().optional(),
        }),
        async execute(choice) {
          const group = groupsById.get(String(choice.group_id));
          if (!group) return { ok: false, error: "Unknown group_id." };
          if (assignments.some((assignment) => assignment.group_id === String(group.id))) return { ok: false, error: "Group already has a planned event." };
          const validation = reservePlannedVenuePair({ group, choice, users, week, reservations: planningReservations });
          if (!validation.ok) return { ok: false, error: validation.error };
          const assignment = {
            ...choice,
            group_id: String(group.id),
            user_ids: group.user_ids,
            category: group.category,
            availability: group.availability,
            area: group.area,
            primary_venue_id: String(choice.primary_venue_id),
            backup_venue_id: String(choice.backup_venue_id),
          };
          assignments.push(assignment);
          return { ok: true, assignment };
        },
      }),
    ],
  });

  const result = await run(
    agent,
    JSON.stringify({
      week,
      groups_to_plan: groups.length,
      first_view: groups.slice(0, 12).map((group) => compactGroup(group, users)),
      instruction: "Choose primary venues first, then backups, and allocate as many valid events as possible.",
    }),
    { maxTurns: agentMaxTurns },
  );

  if (assignments.length) return assignments;
  const parsed = parseJsonObject(result.finalOutput);
  if (!Array.isArray(parsed.assignments)) return [];
  for (const assignment of parsed.assignments) {
    const group = groupsById.get(String(assignment.group_id));
    if (!group) continue;
    const validation = reservePlannedVenuePair({ group, choice: assignment, users, week, reservations: planningReservations });
    if (validation.ok) assignments.push({
      ...assignment,
      group_id: String(group.id),
      user_ids: group.user_ids,
      category: group.category,
      availability: group.availability,
      area: group.area,
      primary_venue_id: String(assignment.primary_venue_id),
      backup_venue_id: String(assignment.backup_venue_id),
    });
  }
  return assignments;
}

async function runEventFinalizerPool({ assignments, users, events, week, job, onEventCreated, onGroupDone }) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, eventAgentConcurrency), assignments.length || 1);

  async function worker() {
    while (nextIndex < assignments.length) {
      throwIfCancelled(job);
      const assignment = assignments[nextIndex];
      nextIndex += 1;
      let result = { created: false, conflicts: 0 };
      try {
        result = await runEventFinalizerAgent(assignment, users, events, week);
        if (result.created) await onEventCreated(result.event);
      } catch (error) {
        job.failures.push({
          group_id: assignment.group_id,
          status: "agent_timeout",
          reason: error.message || "Event Finalizer Agent failed.",
        });
      } finally {
        onGroupDone(result);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

function throwIfCancelled(job) {
  if (!job.cancel_requested) return;
  updateJob(job, {
    status: "cancelled",
    phase: "cancelled",
    log: "Agent run cancelled.",
    finished_at: new Date().toISOString(),
  });
  throw new Error("Agent run cancelled.");
}

function updateJob(job, changes = {}) {
  Object.assign(job, changes, { updated_at: new Date().toISOString() });
}

function publicJob(job) {
  return {
    job_id: job.id,
    status: job.status,
    phase: job.phase,
    created_at: job.created_at,
    updated_at: job.updated_at,
    finished_at: job.finished_at,
    progress: job.progress,
    failures: job.failures,
    log: job.log,
    error: job.error,
    users: job.status === "completed" ? job.users : undefined,
    events: job.status === "completed" ? job.events : undefined,
    week: job.status === "completed" ? job.week : undefined,
  };
}

async function runAdjustedGroupAgent({ users, groups, week, job = null }) {
  const workingGroups = groups.map((group) => ({ ...group, user_ids: [...group.user_ids] }));
  const failures = [];
  let adjustedCount = 0;

  function applyAdjustedCandidate(candidate) {
    const candidateIds = Array.isArray(candidate.user_ids) ? candidate.user_ids.map(String) : [];
    const assigned = assignedUserIds(workingGroups);
    const containingIndex = workingGroups.findIndex((group) => {
      const groupIds = new Set((group.user_ids || []).map(String));
      return groupIds.size > 0 && [...groupIds].every((id) => candidateIds.includes(id));
    });

    if (containingIndex >= 0) {
      const base = workingGroups[containingIndex];
      const addedIds = candidateIds.filter((id) => !(base.user_ids || []).map(String).includes(id));
      if (!addedIds.length) return { ok: false, error: "Candidate does not add any users." };
      if (addedIds.some((id) => assigned.has(id))) return { ok: false, error: "One or more added users are already grouped." };
      const valid = validateAdjustedGroup({
        ...base,
        ...candidate,
        user_ids: candidateIds,
        category: candidate.category || base.category,
        availability: candidate.availability || base.availability,
        compromised_metrics: [
          ...(base.compromised_metrics || []),
          ...(candidate.compromised_metrics || []),
        ],
      }, users, week);
      if (!valid) return { ok: false, error: "Adjusted group failed validation." };
      workingGroups[containingIndex] = valid;
      adjustedCount += 1;
      return { ok: true, group: valid };
    }

    if (candidateIds.some((id) => assigned.has(id))) return { ok: false, error: "One or more users are already grouped." };
    const valid = validateAdjustedGroup({
      ...candidate,
      match_quality: "fallback",
    }, users, week);
    if (!valid) return { ok: false, error: "Adjusted group failed validation." };
    workingGroups.push(valid);
    adjustedCount += 1;
    return { ok: true, group: valid };
  }

  const agent = new Agent({
    name: "PAINTS Adjusted Group Agent",
    model,
    modelSettings: agentModelSettings,
    instructions: [
      "You recover users left unmatched after the strict PAINTS grouping pass.",
      "Strict groups already preferred exact category and exact availability. Your job is the closest possible adjusted match, not perfection.",
      "Use search_unmatched_users and search_existing_groups to inspect the pool.",
      "Prefer adding unmatched users to an existing same-category group if size allows.",
      "Then prefer creating a new adjusted same-category group from unmatched users.",
      "Only change category when otherwise the user would remain unmatched.",
      "Availability can be compromised before category when that gives users a real event.",
      "Every mismatch must be recorded in compromised_metrics with user_id, metric, from, and to.",
      "Do not duplicate a user across groups.",
      "Normal category max size is still ideal. As the last priority only, you may go up to normal max + 2 to accommodate users.",
      "If you exceed normal max size, compromised_metrics must include {\"user_id\":\"group\",\"metric\":\"group size\",\"from\":\"normal max\",\"to\":\"actual size\"}.",
      "If there are 2+ users who can be matched with reasonable compromises, create the adjusted match.",
      "Return strict JSON at the end: {\"adjusted_groups\":[{\"user_ids\":[\"...\"],\"category\":\"...\",\"availability\":\"...\",\"area\":\"...\",\"fallback_reason\":\"...\",\"compromised_metrics\":[{\"user_id\":\"...\",\"metric\":\"...\",\"from\":\"...\",\"to\":\"...\"}]}]}",
    ].join("\n"),
    tools: [
      tool({
        name: "search_unmatched_users",
        description: "Search users not currently assigned to a group. Filters are optional and agent-controlled.",
        parameters: z.object({
          category: z.string().optional(),
          availability: z.string().optional(),
          district: z.string().optional(),
          near: z.object({
            lat: z.number(),
            lng: z.number(),
            radius_km: z.number().min(0).max(100),
          }).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
        async execute({ category, availability, district, near, limit = 80 }) {
          const assigned = assignedUserIds(workingGroups);
          let available = users.filter((user) => !assigned.has(String(user.id)));
          if (category) available = available.filter((user) => user.category === category);
          if (availability) available = available.filter((user) => user.availability === availability);
          return searchUsersForAgent(available, { district, near, limit });
        },
      }),
      tool({
        name: "search_existing_groups",
        description: "See current strict/adjusted groups that can possibly receive more users.",
        parameters: z.object({
          category: z.string().optional(),
          availability: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
        async execute({ category, availability, limit = 80 }) {
          return workingGroups
            .filter((group) => !category || group.category === category)
            .filter((group) => !availability || group.availability === availability)
            .map((group) => {
              const rule = groupRules[group.category] || { min: 2, max: 4 };
              return {
                ...compactGroup(group, users),
                normal_room_left: Math.max(0, rule.max - group.user_ids.length),
                overflow_room_left: Math.max(0, rule.max + adjustedGroupSizeOverflow - group.user_ids.length),
                normal_max_size: rule.max,
                adjusted_max_size: rule.max + adjustedGroupSizeOverflow,
              };
            })
            .filter((group) => group.overflow_room_left > 0)
            .slice(0, limit);
        },
      }),
      tool({
        name: "add_users_to_group",
        description: "Add unmatched users to an existing group as an adjusted match. Every category/availability mismatch must be recorded.",
        parameters: z.object({
          group_id: z.string(),
          add_user_ids: z.array(z.string()).min(1).max(8),
          fallback_reason: z.string(),
          compromised_metrics: compromisedMetricsSchema(),
        }),
        async execute({ group_id, add_user_ids, fallback_reason, compromised_metrics }) {
          const index = workingGroups.findIndex((group) => String(group.id) === String(group_id));
          if (index < 0) return { ok: false, error: "Unknown group_id." };
          const base = workingGroups[index];
          const result = applyAdjustedCandidate({
            ...base,
            user_ids: [...base.user_ids, ...add_user_ids.map(String)],
            fallback_reason,
            compromised_metrics,
          });
          if (!result.ok) return { ok: false, error: `${result.error} Include required compromised_metrics for each mismatch and stay within adjusted size limits.` };
          return { ok: true, group: compactGroup(result.group, users) };
        },
      }),
      tool({
        name: "create_adjusted_group",
        description: "Create a new adjusted group from currently unmatched users. Every category/availability mismatch must be recorded.",
        parameters: z.object({
          user_ids: z.array(z.string()).min(2).max(8),
          category: z.string(),
          availability: z.string(),
          area: z.string().optional(),
          fallback_reason: z.string(),
          compromised_metrics: compromisedMetricsSchema(),
        }),
        async execute(candidate) {
          const result = applyAdjustedCandidate(candidate);
          if (!result.ok) return { ok: false, error: `${result.error} Include required compromised_metrics for each mismatch and stay within adjusted size limits.` };
          return { ok: true, group: compactGroup(result.group, users) };
        },
      }),
    ],
  });

  const beforeAssigned = assignedUserIds(workingGroups);
  const unmatched = users.filter((user) => !beforeAssigned.has(String(user.id)));
  if (unmatched.length < 1) return { groups: workingGroups, failures, adjusted_count: 0, recovered_user_count: 0 };

  try {
    if (job) updateJob(job, { phase: "grouping", log: `Running adjusted grouping for ${unmatched.length} unmatched users...` });
    const result = await run(
      agent,
      JSON.stringify({
        week,
        unmatched_user_count: unmatched.length,
        unmatched_first_view: unmatched.slice(0, 20).map(compactUser),
        existing_groups_first_view: workingGroups.slice(0, 20).map((group) => compactGroup(group, users)),
        instruction: "Recover the best possible adjusted groups. Record the compromised metric for every mismatch.",
      }),
      { maxTurns: agentMaxTurns },
    );
    const parsed = parseJsonObject(result.finalOutput);
    if (Array.isArray(parsed.adjusted_groups)) {
      for (const candidate of parsed.adjusted_groups) applyAdjustedCandidate(candidate);
    }
  } catch (error) {
    failures.push({
      status: "adjusted_group_agent_failed",
      reason: error.message || "Adjusted Group Agent failed.",
    });
  }

  const afterAssigned = assignedUserIds(workingGroups);
  users
    .filter((user) => !afterAssigned.has(String(user.id)))
    .forEach((user) => {
      failures.push({
        user_id: user.id,
        status: "unmatched_after_adjusted_grouping",
        reason: "No strict or adjusted group could be created without duplicating users or breaking group size rules.",
      });
    });
  return {
    groups: workingGroups,
    failures,
    adjusted_count: adjustedCount,
    recovered_user_count: [...afterAssigned].filter((id) => !beforeAssigned.has(id)).length,
  };
}

async function collectGroupsForBatch(batch, week, job = null) {
  const groups = [];
  const failures = [];
  const assignedUserIds = new Set();
  const rule = groupRules[batch.category] || { min: 2, max: 4 };

  for (let pass = 1; pass <= groupMaxPassesPerBatch; pass += 1) {
    if (job) throwIfCancelled(job);
    const remainingUsers = batch.users.filter((user) => !assignedUserIds.has(String(user.id)));
    if (remainingUsers.length < rule.min) break;

    const passBatch = {
      ...batch,
      pass,
      max_groups: groupMaxGroupsPerPass,
      users: remainingUsers,
    };

    let batchGroups = [];
    try {
      batchGroups = await runGroupAgent(passBatch, week);
    } catch (error) {
      failures.push({
        batch: [batch.category, batch.availability].join(" / "),
        pass,
        status: "agent_timeout",
        reason: error.message || "Group Agent failed.",
      });
      break;
    }

    let acceptedThisPass = 0;
    for (const group of batchGroups) {
      const valid = validateGroup(group, remainingUsers, week);
      if (!valid) continue;
      if (valid.user_ids.some((id) => assignedUserIds.has(String(id)))) continue;
      valid.user_ids.forEach((id) => assignedUserIds.add(String(id)));
      groups.push(valid);
      acceptedThisPass += 1;
    }

    if (!acceptedThisPass) break;
  }

  return { groups, failures };
}

async function runGroupAgent(batch, week) {
  const rule = groupRules[batch.category] || { min: 2, max: 4 };
  const createdGroups = [];
  const agent = new Agent({
    name: "PAINTS Group Agent",
    model,
    modelSettings: agentModelSettings,
    instructions: [
      "You create PAINTS user groups from the available users only.",
      "Use search_users to zoom around the available user pool, inspect users, and call create_group for every group you want to create.",
      "Create as many good groups as possible, up to max_groups for this pass.",
      "Continue grouping until fewer than 2 viable users remain or max_groups is reached.",
      "Do not stop after one good group.",
      "Hard filters: same category, same availability, and group size within the supplied rule.",
      "Location, age preference, gender mix, price, travel-time preference, and recent people are soft preferences, but group quality matters.",
      "Prefer groups with nearby districts, compatible price expectations, and similar travel tolerance before using fallback groupings.",
      "Never leave 2+ eligible users unmatched just because soft preferences are imperfect.",
      "If the best group is not ideal, still create the closest viable group and mark it with match_quality fallback plus a short fallback_reason.",
      "Return strict JSON at the end: {\"groups\":[{\"user_ids\":[\"...\"],\"area\":\"...\",\"reason\":\"...\",\"match_quality\":\"ideal|good|fallback\",\"fallback_reason\":\"...\"}]}",
    ].join("\n"),
    tools: [
      tool({
        name: "search_users",
        description: "Search available users. This is an agent-controlled map/list search, not a backend clustering rule.",
        parameters: z.object({
          district: z.string().optional(),
          near: z.object({
            lat: z.number(),
            lng: z.number(),
            radius_km: z.number().min(0).max(100),
          }).optional(),
          price: z.string().optional(),
          age_min: z.number().int().min(18).max(100).optional(),
          age_max: z.number().int().min(18).max(100).optional(),
          limit: z.number().int().min(1).max(80).optional(),
        }),
        async execute({ district, near, price, age_min, age_max, limit = 50 }) {
          return searchUsersForAgent(batch.users, { district, near, price, age_min, age_max, limit });
        },
      }),
      tool({
        name: "get_user_details",
        description: "Fetch full available details for selected users.",
        parameters: z.object({
          user_ids: z.array(z.string()).min(1).max(12),
        }),
        async execute({ user_ids }) {
          const wanted = new Set(user_ids.map(String));
          return batch.users.filter((user) => wanted.has(String(user.id))).map(compactUser);
        },
      }),
      tool({
        name: "create_group",
        description: "Create a proposed group after checking local hard filters.",
        parameters: z.object({
          user_ids: z.array(z.string()).min(rule.min).max(rule.max),
          area: z.string().optional(),
          reason: z.string().optional(),
          match_quality: z.enum(["ideal", "good", "fallback"]).optional(),
          fallback_reason: z.string().optional(),
        }),
        async execute({ user_ids, area, reason, match_quality, fallback_reason }) {
          if (createdGroups.length >= batch.max_groups) return { ok: false, error: "max_groups reached for this pass." };
          const candidate = {
            user_ids,
            area: area || "London",
            reason: reason || "",
            match_quality,
            fallback_reason,
          };
          const valid = validateGroup(candidate, batch.users, week);
          if (!valid) return { ok: false, error: "Group failed hard filters." };
          const alreadyUsed = new Set(createdGroups.flatMap((group) => group.user_ids));
          if (valid.user_ids.some((id) => alreadyUsed.has(id))) return { ok: false, error: "One or more users are already grouped in this run." };
          createdGroups.push({
            ...candidate,
            user_ids: valid.user_ids,
            match_quality: valid.match_quality,
            fallback_reason: valid.fallback_reason,
          });
          return { ok: true, group: createdGroups.at(-1) };
        },
      }),
    ],
  });

  const result = await run(
    agent,
    JSON.stringify({
      week,
      category: batch.category,
      availability: batch.availability,
      area_cluster: batch.area,
      group_size_rule: rule,
      pass: batch.pass || 1,
      max_groups: batch.max_groups || groupMaxGroupsPerPass,
      available_user_count: batch.users.length,
      first_view: batch.users.slice(0, 12).map(compactUser),
    }),
    { maxTurns: agentMaxTurns },
  );
  if (createdGroups.length) return createdGroups;
  const parsed = parseJsonObject(result.finalOutput);
  return Array.isArray(parsed.groups) ? parsed.groups : [];
}

async function runEventFinalizerAgent(assignment, users, events, week) {
  const group = {
    id: assignment.group_id,
    user_ids: assignment.user_ids || [],
    category: assignment.category,
    availability: assignment.availability,
    area: assignment.area,
    match_quality: assignment.match_quality,
    fallback_reason: assignment.fallback_reason,
  };
  const groupUsers = group.user_ids.map((id) => users.find((user) => user.id === id)).filter(Boolean);
  if (groupUsers.length < 2) return { created: false, conflicts: 0 };
  let createdEvent = null;
  const agent = new Agent({
    name: "PAINTS Event Finalizer Agent",
    model,
    modelSettings: agentModelSettings,
    instructions: [
      "You finalize one PAINTS event from a venue pair already allocated by the Batch Event Planner Agent.",
      "Do not search the whole venue database. Use the allocated primary and second venue unless live public context makes it unusable.",
      "Use get_venue_details and web search if needed for current context.",
      "Call create_event with user-facing title, storyline, and meeting point notes.",
      "The storyline is user-facing: tell them the place theme/anecdote, not why PAINTS selected it.",
      "Return strict JSON at the end: {\"title\":\"...\",\"storyline\":\"...\",\"meeting_point_notes\":\"...\",\"match_quality\":\"ideal|good|fallback\",\"fallback_reason\":\"...\"}",
    ].join("\n"),
    tools: [
      tool({
        name: "get_venue_details",
        description: "Fetch details for the allocated primary and second venue.",
        parameters: z.object({}),
        async execute() {
          return [assignment.primary_venue_id, assignment.backup_venue_id].map(venueById).filter(Boolean).map((venue) => ({
            ...compactVenue(venue),
            google_maps: venue.google_maps,
            source_urls: venue.source_urls,
            why_go: venue.why_go,
            safety_notes: venue.safety_notes,
            risks: venue.risks,
          }));
        },
      }),
      tool({
        name: "create_event",
        description: "Create the final event using the allocated venue pair.",
        parameters: z.object({
          title: z.string().optional(),
          storyline: z.string().optional(),
          meeting_point_notes: z.string().optional(),
          match_quality: z.enum(["ideal", "good", "fallback"]).optional(),
          fallback_reason: z.string().optional(),
        }),
        async execute(choice) {
          const created = createEvent({
            group,
            groupUsers,
            choice: {
              ...choice,
              primary_venue_id: assignment.primary_venue_id,
              backup_venue_id: assignment.backup_venue_id,
              match_quality: choice.match_quality || assignment.match_quality,
              fallback_reason: choice.fallback_reason || assignment.fallback_reason,
            },
            events,
            week,
          });
          if (created.conflict) return { ok: false, error: "Allocated venue pair is no longer free." };
          if (!created.event) return { ok: false, error: "Allocated venue pair failed hard filters." };
          createdEvent = created.event;
          return { ok: true, event: created.event };
        },
      }),
      webSearchTool({ searchContextSize: "medium" }),
    ],
  });

  const result = await run(
    agent,
    JSON.stringify({
      week,
      group: {
        id: group.id,
        category: group.category,
        availability: group.availability,
        area: group.area,
        users: groupUsers.map(compactUser),
      },
      allocated_pair: {
        primary: compactVenue(venueById(assignment.primary_venue_id)),
        second: compactVenue(venueById(assignment.backup_venue_id)),
      },
      instruction: "Finalize this event from the allocated venue pair.",
    }),
    { maxTurns: agentMaxTurns },
  );

  if (createdEvent) return { created: true, event: createdEvent, conflicts: 0 };
  const parsed = parseJsonObject(result.finalOutput);
  const created = createEvent({
    group,
    groupUsers,
    choice: {
      ...parsed,
      primary_venue_id: assignment.primary_venue_id,
      backup_venue_id: assignment.backup_venue_id,
      match_quality: parsed.match_quality || assignment.match_quality,
      fallback_reason: parsed.fallback_reason || assignment.fallback_reason,
    },
    events,
    week,
  });
  if (created.event) return { created: true, event: created.event, conflicts: 0 };

  const fallback = createEvent({
    group,
    groupUsers,
    choice: {
      primary_venue_id: assignment.primary_venue_id,
      backup_venue_id: assignment.backup_venue_id,
      title: assignment.title || `${group.category} in ${venueById(assignment.primary_venue_id)?.district || "London"}`,
      storyline: assignment.storyline || venueById(assignment.primary_venue_id)?.anecdote || venueById(assignment.primary_venue_id)?.why_go || "",
      meeting_point_notes: assignment.meeting_point_notes || `Meet at ${venueById(assignment.primary_venue_id)?.name}. Second venue is ${venueById(assignment.backup_venue_id)?.name}.`,
      match_quality: assignment.match_quality || "fallback",
      fallback_reason: assignment.fallback_reason || "Finalizer could not improve the planned event copy, so the allocated venue pair was used.",
    },
    events,
    week,
  });
  if (fallback.event) return { created: true, event: fallback.event, conflicts: 0 };
  return { created: false, conflicts: fallback.conflict ? 1 : 0 };
}

async function runEventAgent(group, users, events, week, reservations = null) {
  const groupUsers = group.user_ids.map((id) => users.find((user) => user.id === id)).filter(Boolean);
  if (groupUsers.length < 2) return { created: false, conflicts: 0 };

  let createdEvent = null;
  let conflicts = 0;
  const agent = new Agent({
    name: "PAINTS Event Agent",
    model,
    modelSettings: agentModelSettings,
    instructions: [
      "You choose the event venues for one already-approved PAINTS group.",
      "Use search_venues_map to zoom around local venue options, get_venue_details for shortlists, and web search when you need live public context such as opening hours.",
      "Choose two venues from the same venue pool: one primary and one second venue. Backup distance starts as a preference, then loosens if needed.",
      "Hard filters: valid coordinates, explicit capacity is enough for the group, primary and backup are different, and the primary venue is not already used at the same date/time. Category, score, backup reuse, and backup distance are pro-rata preferences.",
      "Price, user travel time, and recently attended venues are strong soft preferences. Use the cleanest option first; if no ideal option exists, choose the closest viable fallback and explain fallback_reason internally.",
      "Call create_event when you are ready. If create_event reports a conflict, pick another pair and call create_event again.",
      "The storyline is user-facing: tell them the place theme/anecdote, not why PAINTS selected it.",
      "Return strict JSON at the end: {\"primary_venue_id\":\"...\",\"backup_venue_id\":\"...\",\"title\":\"...\",\"storyline\":\"...\",\"meeting_point_notes\":\"...\",\"match_quality\":\"ideal|good|fallback\",\"fallback_reason\":\"...\"}",
    ].join("\n"),
    tools: [
      tool({
        name: "search_venues_map",
        description: "Search available PAINTS venues for this group. Results exclude only backend safety conflicts by default, not soft preference mismatches.",
        parameters: z.object({
          area: z.string().optional(),
          limit: z.number().int().min(1).max(80).optional(),
          include_recent_user_venues: z.boolean().optional(),
        }),
        async execute({ area, limit = 30, include_recent_user_venues = true }) {
          const areaText = String(area || "").toLowerCase();
          return searchVenuesMap({
            category: group.category,
            users: groupUsers,
            events,
            week,
            excludeHistory: !include_recent_user_venues,
            limit: 80,
          })
            .filter((venue) => !areaText || `${venue.name} ${venue.district} ${venue.neighbourhood}`.toLowerCase().includes(areaText))
            .slice(0, limit)
            .map(compactVenue);
        },
      }),
      tool({
        name: "get_venue_details",
        description: "Fetch richer local details for selected venues.",
        parameters: z.object({
          venue_ids: z.array(z.string()).min(1).max(12),
        }),
        async execute({ venue_ids }) {
          const wanted = new Set(venue_ids.map(String));
          return venues.filter((venue) => wanted.has(String(venue.id))).map((venue) => ({
            ...compactVenue(venue),
            google_maps: venue.google_maps,
            source_urls: venue.source_urls,
            why_go: venue.why_go,
            safety_notes: venue.safety_notes,
            risks: venue.risks,
          }));
        },
      }),
      tool({
        name: "search_venue_pairs",
        description: "Find primary/second venue pairs that already satisfy the 5-10 minute walking-distance rule.",
        parameters: z.object({
          area: z.string().optional(),
          limit: z.number().int().min(1).max(40).optional(),
          include_recent_user_venues: z.boolean().optional(),
        }),
        async execute({ area, limit = 20, include_recent_user_venues = true }) {
          const areaText = String(area || "").toLowerCase();
          const candidates = searchVenuesMap({
            category: group.category,
            users: groupUsers,
            events,
            week,
            excludeHistory: !include_recent_user_venues,
            limit: 120,
          }).filter((venue) => !areaText || `${venue.name} ${venue.district} ${venue.neighbourhood}`.toLowerCase().includes(areaText));
          return venuePairs(candidates, groupUsers)
            .slice(0, limit)
            .map(({ primary, backup, walkMinutes, groupDistance }) => ({
              primary: compactVenue(primary),
              second: compactVenue(backup),
              walk_minutes_between_venues: Math.round(walkMinutes),
              primary_distance_from_group_km: Number(groupDistance.toFixed(1)),
            }));
        },
      }),
      tool({
        name: "create_event",
        description: "Atomically reserve the chosen primary venue for this group/date/time. Backup venues are not locked.",
        parameters: z.object({
          primary_venue_id: z.string(),
          backup_venue_id: z.string(),
          title: z.string().optional(),
          storyline: z.string().optional(),
          meeting_point_notes: z.string().optional(),
          match_quality: z.enum(["ideal", "good", "fallback"]).optional(),
          fallback_reason: z.string().optional(),
        }),
        async execute(choice) {
          const created = createEvent({ group, groupUsers, choice, events, week, reservations });
          if (created.conflict) {
            conflicts += 1;
            return { ok: false, error: "Primary venue is already reserved for this date/time. Pick another primary." };
          }
          if (!created.event) return { ok: false, error: "Venue pair failed local hard filters. Pick another pair." };
          createdEvent = created.event;
          return { ok: true, event: created.event };
        },
      }),
      webSearchTool({ searchContextSize: "medium" }),
    ],
  });

  const result = await run(
    agent,
    JSON.stringify({
      week,
      group: {
        id: group.id,
        category: group.category,
        availability: group.availability,
        area: group.area,
        users: groupUsers.map(compactUser),
      },
      instruction: "Create one event by choosing and reserving a valid venue pair.",
    }),
    { maxTurns: agentMaxTurns },
  );
  if (createdEvent) return { created: true, event: createdEvent, conflicts };

  const parsed = parseJsonObject(result.finalOutput);
  if (parsed.primary_venue_id && parsed.backup_venue_id) {
    const created = createEvent({ group, groupUsers, choice: parsed, events, week, reservations });
    if (created.conflict) conflicts += 1;
    if (created.event) return { created: true, event: created.event, conflicts };
  }

  const fallbackCandidates = searchVenuesMap({
    category: group.category,
    users: groupUsers,
    events,
    week,
    excludeHistory: false,
    limit: 120,
  });
  const [fallbackPair] = venuePairs(fallbackCandidates, groupUsers);
  if (fallbackPair) {
    const created = createEvent({
      group,
      groupUsers,
      choice: {
        primary_venue_id: String(fallbackPair.primary.id),
        backup_venue_id: String(fallbackPair.backup.id),
        title: `${group.category} in ${fallbackPair.primary.district}`,
        storyline: fallbackPair.primary.anecdote || fallbackPair.primary.why_go || "",
        meeting_point_notes: `Meet at ${fallbackPair.primary.name}. Second venue is ${fallbackPair.backup.name}.`,
        match_quality: "fallback",
        fallback_reason: "Agent could not commit an ideal pair, so the system used the closest valid venue pair.",
      },
      events,
      week,
      reservations,
    });
    if (created.conflict) conflicts += 1;
    if (created.event) return { created: true, event: created.event, conflicts };
  }

  return { created: false, conflicts };
}

function createEvent({ group, groupUsers, choice, events, week, reservations = null }) {
  const primary = venueById(choice.primary_venue_id);
  const backup = venueById(choice.backup_venue_id);
  if (!primary || !backup || String(primary.id) === String(backup.id)) return {};
  if (!validPoint(primary) || !validPoint(backup)) return {};
  if (!hasEnoughCapacity(primary, groupUsers.length) || !hasEnoughCapacity(backup, groupUsers.length)) return {};

  const dateTime = `${group.availability} · Week ${week}`;
  const primaryKey = reservationKey(dateTime, primary.id);
  const taken = reservations
    ? reservations.has(primaryKey)
    : events.some((event) => {
        if (event.date_time !== dateTime) return false;
        return String(event.primary_venue_id) === String(primary.id);
      });
  if (taken) return { conflict: true };
  if (reservations) {
    reservations.add(primaryKey);
  }

  return {
    event: {
      id: `e-${week}-${events.length + 1}-${Math.random().toString(16).slice(2, 7)}`,
      week,
      title: choice.title || `${primary.category || group.category} in ${primary.district}`,
      category: primary.category || group.category,
      date_time: dateTime,
      area: primary.district,
      user_ids: groupUsers.map((user) => user.id),
      primary_venue_id: String(primary.id),
      backup_venue_id: String(backup.id),
      match_quality: eventMatchQuality(group, groupUsers, primary, choice),
      fallback_reason: eventFallbackReason(group, groupUsers, primary, choice),
      adjusted_match: Boolean(group.adjusted_match || choice.adjusted_match),
      compromised_metrics: group.compromised_metrics || choice.compromised_metrics || [],
      storyline: choice.storyline || primary.anecdote || primary.why_go || "",
      meeting_point_notes: choice.meeting_point_notes || `Meet at ${primary.name}. Backup is ${backup.name}.`,
      created_at: new Date().toISOString(),
      created_by: "openai_agents",
    },
  };
}

function reservationSet(events) {
  return new Set(
    events
      .map((event) => reservationKey(event.date_time, event.primary_venue_id))
      .filter(Boolean),
  );
}

function reservationKey(dateTime, venueId) {
  return `${dateTime}|${String(venueId)}`;
}

function parseJsonObject(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]);
  } catch {
    return {};
  }
}

function compromisedMetricsSchema() {
  return z.array(z.object({
    user_id: z.string(),
    metric: z.string(),
    from: z.string(),
    to: z.string(),
    severity: z.string().optional(),
  })).default([]);
}

function assignedUserIds(groups) {
  return new Set(groups.flatMap((group) => group.user_ids || []).map(String));
}

function batchUsers(users, week) {
  const buckets = new Map();
  users
    .filter((user) => !user.pending_group_week || user.pending_group_week < week)
    .forEach((user) => {
      const key = [user.category, user.availability].join("|");
      if (!buckets.has(key)) {
        buckets.set(key, {
          category: user.category,
          availability: user.availability,
          area: "London",
          users: [],
        });
      }
      buckets.get(key).users.push(user);
    });
  return [...buckets.values()].filter((batch) => batch.users.length >= (groupRules[batch.category]?.min || 2));
}

function searchUsersForAgent(users, { district, near, price, age_min, age_max, limit }) {
  const districtText = String(district || "").trim().toLowerCase();
  return users
    .filter((user) => !districtText || String(user.district || "").toLowerCase().includes(districtText))
    .filter((user) => !price || user.price_preference === price)
    .filter((user) => !Number.isFinite(Number(age_min)) || Number(user.age) >= Number(age_min))
    .filter((user) => !Number.isFinite(Number(age_max)) || Number(user.age) <= Number(age_max))
    .map((user) => ({
      user,
      distance: near && validPoint(user)
        ? distanceKm(Number(near.lat), Number(near.lng), Number(user.latitude), Number(user.longitude))
        : 0,
    }))
    .filter(({ distance }) => !near || distance <= Number(near.radius_km))
    .sort((a, b) => a.distance - b.distance || Number(a.user.age || 0) - Number(b.user.age || 0))
    .slice(0, limit)
    .map(({ user, distance }) => ({
      ...compactUser(user),
      distance_from_search_km: near ? Number(distance.toFixed(1)) : undefined,
    }));
}

function searchVenuesMap({ category, users, events, week, excludeHistory, limit }) {
  const center = averagePoint(users);
  const usedVenueIds = new Set(users.flatMap((user) => user.last_venue_ids || []).map(String));
  const dateTime = `${users[0]?.availability || ""} · Week ${week}`;
  const reserved = new Set(events.filter((event) => event.date_time === dateTime).map((event) => event.primary_venue_id).map(String));

  return venues
    .filter((venue) => venue.category === category)
    .filter(validPoint)
    .filter((venue) => Number(venue.paint_score) >= 65)
    .filter((venue) => !reserved.has(String(venue.id)))
    .filter((venue) => !excludeHistory || !usedVenueIds.has(String(venue.id)))
    .map((venue) => ({
      ...venue,
      distance: distanceKm(center.latitude, center.longitude, Number(venue.latitude), Number(venue.longitude)),
    }))
    .sort((a, b) => a.distance - b.distance || Number(b.paint_score) - Number(a.paint_score))
    .slice(0, limit);
}

function venuePairs(candidates, users) {
  const center = averagePoint(users);
  const pairs = [];
  for (const primary of candidates) {
    for (const backup of candidates) {
      if (String(primary.id) === String(backup.id)) continue;
      const walkMinutes = walkingMinutes(primary, backup);
      if (walkMinutes < 5 || walkMinutes > 10) continue;
      pairs.push({
        primary,
        backup,
        walkMinutes,
        groupDistance: distanceKm(center.latitude, center.longitude, Number(primary.latitude), Number(primary.longitude)),
      });
    }
  }
  return pairs.sort((a, b) => a.groupDistance - b.groupDistance || Number(b.primary.paint_score) - Number(a.primary.paint_score));
}

function eventMatchQuality(group, users, primary, choice) {
  if (choice.match_quality) return choice.match_quality;
  return group.match_quality || "good";
}

function eventFallbackReason(group, users, primary, choice) {
  if (choice.fallback_reason) return choice.fallback_reason;
  return group.fallback_reason || "";
}

function applyEventToUsers(users, event) {
  users.forEach((user) => {
    if (!event.user_ids.includes(user.id)) return;
    const others = event.user_ids.filter((id) => id !== user.id);
    user.last_venue_ids = [event.primary_venue_id, ...(user.last_venue_ids || [])].slice(0, 4);
    user.last_event_history = [
      {
        event_id: event.id,
        user_ids: others,
      },
      ...(user.last_event_history || []),
    ].slice(0, 4);
    user.last_event_user_ids = [...new Set(user.last_event_history.flatMap((history) => history.user_ids || []))];
    user.last_event_feedback = {
      event_id: event.id,
      venue_rating: null,
      group_rating: null,
      note: "No feedback yet.",
    };
    user.pending_group_week = 0;
  });
}

function compactUser(user) {
  return {
    id: user.id,
    name: user.name,
    age: user.age,
    gender: user.gender,
    district: user.district,
    latitude: user.latitude,
    longitude: user.longitude,
    category: user.category,
    availability: user.availability,
    price_preference: user.price_preference,
    gender_mix_preference: user.gender_mix_preference,
    age_preference: user.age_preference,
	    travel_time_preference: user.travel_time_preference,
	    last_venue_ids: user.last_venue_ids || [],
	    last_event_user_ids: user.last_event_user_ids || [],
	    last_event_history: user.last_event_history || [],
	    last_event_feedback: user.last_event_feedback || null,
	  };
	}

function compactGroup(group, users) {
  const groupUsers = group.user_ids.map((id) => users.find((user) => user.id === id)).filter(Boolean);
  const center = averagePoint(groupUsers);
  return {
    id: String(group.id),
    category: group.category,
    availability: group.availability,
    area: group.area,
    size: groupUsers.length,
    center,
    match_quality: group.match_quality,
    fallback_reason: group.fallback_reason,
    adjusted_match: Boolean(group.adjusted_match),
    compromised_metrics: group.compromised_metrics || [],
    users: groupUsers.map(compactUser),
  };
}

function compactVenue(venue) {
  if (!venue) return null;
  return {
    id: String(venue.id),
    name: venue.name,
    district: venue.district,
    neighbourhood: venue.neighbourhood,
    category: venue.category,
    price: venue.price,
    paint_score: venue.paint_score,
    opening_hours: venue.opening_hours,
    walk_in_policy: venue.walk_in_policy,
    capacity_total: venue.capacity_total,
    capacity_seated: venue.capacity_seated,
    capacity_standing: venue.capacity_standing,
    capacity_table: venue.capacity_table,
    capacity_notes: venue.capacity_notes,
    capacity_fit: capacityFitSummary(venue),
    group_fit: venue.best_for,
    storyline: venue.anecdote || venue.why_go,
    latitude: venue.latitude,
    longitude: venue.longitude,
  };
}

function venuePairOptionsForGroup(group, users, events, week, reservations, limit) {
  const groupUsers = group.user_ids.map((id) => users.find((user) => user.id === id)).filter(Boolean);
  const candidates = searchVenuesMap({
    category: group.category,
    users: groupUsers,
    events,
    week,
    excludeHistory: false,
    limit: 160,
  });
  return venuePairs(candidates, groupUsers)
    .filter(({ primary, backup }) => {
      const dateTime = `${group.availability} · Week ${week}`;
      return !reservations.has(reservationKey(dateTime, primary.id));
    })
    .slice(0, limit)
    .map(({ primary, backup, walkMinutes, groupDistance }) => ({
      primary: compactVenue(primary),
      second: compactVenue(backup),
      walk_minutes_between_venues: Math.round(walkMinutes),
      primary_distance_from_group_km: Number(groupDistance.toFixed(1)),
    }));
}

function primaryVenueOptionsForGroup(group, users, events, week, reservations, { area, category, district, near, price, min_score, limit }) {
  const groupUsers = group.user_ids.map((id) => users.find((user) => user.id === id)).filter(Boolean);
  const areaText = areaFilterText(area);
  const categoryText = String(category || "").toLowerCase();
  const districtText = String(district || "").trim().toLowerCase();
  const dateTime = `${group.availability} · Week ${week}`;
  const center = near ? { latitude: Number(near.lat), longitude: Number(near.lng) } : averagePoint(groupUsers);
  return venues
    .filter(validPoint)
    .filter((venue) => !categoryText || String(venue.category || "").toLowerCase() === categoryText)
    .filter((venue) => !districtText || String(venue.district || "").toLowerCase().includes(districtText))
    .filter((venue) => !price || venue.price === price)
    .filter((venue) => !Number.isFinite(Number(min_score)) || Number(venue.paint_score || 0) >= Number(min_score))
    .filter((venue) => !reservations.has(reservationKey(dateTime, venue.id)))
    .filter((venue) => !areaText || `${venue.name} ${venue.district} ${venue.neighbourhood}`.toLowerCase().includes(areaText))
    .map((venue) => ({
      ...venue,
      distance: distanceKm(center.latitude, center.longitude, Number(venue.latitude), Number(venue.longitude)),
    }))
    .filter((venue) => !near || venue.distance <= Number(near.radius_km))
    .sort((a, b) => a.distance - b.distance || Number(b.paint_score || 0) - Number(a.paint_score || 0))
    .slice(0, limit)
    .map((venue) => {
      const backups5To10 = backupOptionsForPrimary(group, venue.id, week, reservations, { backup_minutes_min: 5, backup_minutes_max: 10, limit: 8 });
      const backups3To15 = backupOptionsForPrimary(group, venue.id, week, reservations, { backup_minutes_min: 0, backup_minutes_max: 180, limit: 8 });
      return {
        ...compactVenue(venue),
        distance_from_group_km: Number(venue.distance.toFixed(1)),
        strict_backup_count: backups5To10.length,
        expanded_backup_count: backups3To15.length,
      };
    });
}

function backupOptionsForPrimary(group, primaryVenueId, week, reservations, { backup_minutes_min, backup_minutes_max, category, limit }) {
  const primary = venueById(primaryVenueId);
  if (!primary) return [];
  const categoryText = String(category || "").toLowerCase();
  return venues
    .filter((venue) => String(venue.id) !== String(primary.id))
    .filter((venue) => !categoryText || String(venue.category || "").toLowerCase() === categoryText)
    .filter(validPoint)
    .map((venue) => ({
      venue,
      walkMinutes: walkingMinutes(primary, venue),
    }))
    .filter(({ walkMinutes }) => walkMinutes >= backup_minutes_min && walkMinutes <= backup_minutes_max)
    .sort((a, b) => a.walkMinutes - b.walkMinutes || Number(b.venue.paint_score) - Number(a.venue.paint_score))
    .slice(0, limit)
    .map(({ venue, walkMinutes }) => ({
      ...compactVenue(venue),
      walk_minutes_from_primary: Number(walkMinutes.toFixed(1)),
    }));
}

function reservePlannedVenuePair({ group, choice, users, week, reservations }) {
  const primary = venueById(choice.primary_venue_id);
  const backup = venueById(choice.backup_venue_id);
  if (!primary || !backup) return { ok: false, error: "Unknown venue id." };
  if (String(primary.id) === String(backup.id)) return { ok: false, error: "Primary and second venue must be different." };
  if (!validPoint(primary) || !validPoint(backup)) return { ok: false, error: "Venue coordinates missing." };
  const dateTime = `${group.availability} · Week ${week}`;
  const primaryKey = reservationKey(dateTime, primary.id);
  if (reservations.has(primaryKey)) return { ok: false, error: "Primary venue is already allocated for this date/time." };
  reservations.add(primaryKey);
  return { ok: true };
}

function validatePrimaryVenue(group, primaryVenueId, week, reservations) {
  const primary = venueById(primaryVenueId);
  if (!primary) return { ok: false, error: "Unknown primary venue id." };
  if (!validPoint(primary)) return { ok: false, error: "Primary venue coordinates missing." };
  if (!hasEnoughCapacity(primary, group.user_ids.length)) return { ok: false, error: "Primary venue explicit capacity is too small for this group." };
  const key = reservationKey(`${group.availability} · Week ${week}`, primary.id);
  if (reservations.has(key)) return { ok: false, conflict: true, error: "Primary venue is already claimed for this date/time." };
  return { ok: true };
}

function validateBackupVenue(group, primaryVenueId, backupVenueId, week, reservations, choice = {}) {
  const primary = venueById(primaryVenueId);
  const backup = venueById(backupVenueId);
  if (!primary || !backup) return { ok: false, error: "Unknown primary or backup venue id." };
  if (String(primary.id) === String(backup.id)) return { ok: false, error: "Backup must be different from primary." };
  if (!validPoint(primary)) return { ok: false, error: "Primary venue coordinates missing." };
  if (!validPoint(backup)) return { ok: false, error: "Backup venue coordinates missing." };
  if (!hasEnoughCapacity(backup, group.user_ids.length)) return { ok: false, error: "Backup venue explicit capacity is too small for this group." };
  return { ok: true };
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const fullPath = path.normalize(path.join(__dirname, requested));
  const relativePath = path.relative(__dirname, fullPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    sendText(response, 403, "Forbidden");
    return;
  }
  try {
    const body = await fs.readFile(fullPath);
    const contentType = mimeTypes[path.extname(fullPath)] || "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType });
    if (request.method !== "HEAD") response.end(body);
    else response.end();
  } catch {
    sendText(response, 404, "Not found");
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function sendText(response, status, text) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}

async function loadVenues() {
  const source = await fs.readFile(path.join(__dirname, "venues-data.js"), "utf8");
  const json = source.replace(/^window\.PAINTS_VENUES\s*=\s*/, "").replace(/;\s*$/, "");
  return JSON.parse(json);
}

async function readDb() {
  await fs.mkdir(dataDir, { recursive: true });
  const [users, events, state] = await Promise.all([
    readJsonFile(usersPath, []),
    readJsonFile(eventsPath, []),
    readJsonFile(statePath, { week: 1 }),
  ]);
  return {
    users: Array.isArray(users) ? users : [],
    events: Array.isArray(events) ? events : [],
    week: Number.isFinite(Number(state.week)) ? Number(state.week) : 1,
  };
}

async function replaceDb(db) {
  return mutateDb(() => writeDb(db));
}

async function updateDb(mutator) {
  return mutateDb(async () => {
    const current = await readDb();
    const next = await mutator(current);
    return writeDb(next || current);
  });
}

async function mutateDb(operation) {
  const nextMutation = dbMutationQueue.then(operation, operation);
  dbMutationQueue = nextMutation.catch(() => {});
  return nextMutation;
}

async function writeDb(db) {
  await fs.mkdir(dataDir, { recursive: true });
  const saved = {
    users: Array.isArray(db.users) ? db.users : [],
    events: Array.isArray(db.events) ? db.events : [],
    week: Number.isFinite(Number(db.week)) ? Number(db.week) : 1,
  };
  await Promise.all([
    writeJsonFile(usersPath, saved.users),
    writeJsonFile(eventsPath, saved.events),
    writeJsonFile(statePath, { week: saved.week }),
  ]);
  return saved;
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  const tempPath = `${filePath}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

function venueById(id) {
  return venues.find((venue) => String(venue.id) === String(id));
}

function areaFilterText(area) {
  const rawAreaText = String(area || "").trim().toLowerCase();
  return ["", "all", "any", "london", "all london", "whole london", "citywide"].includes(rawAreaText) ? "" : rawAreaText;
}

function averagePoint(items) {
  const valid = items.filter(validPoint);
  if (!valid.length) return { latitude: 51.5074, longitude: -0.1278 };
  return {
    latitude: valid.reduce((sum, item) => sum + Number(item.latitude), 0) / valid.length,
    longitude: valid.reduce((sum, item) => sum + Number(item.longitude), 0) / valid.length,
  };
}

function validPoint(item) {
  return Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude));
}

function hasEnoughCapacity(venue, groupSize) {
  const capacities = [venue.capacity_table, venue.capacity_seated, venue.capacity_total, venue.capacity_standing]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!capacities.length) return true;
  return Math.max(...capacities) >= groupSize;
}

function capacityFitSummary(venue) {
  const capacities = {
    table: numericCapacity(venue.capacity_table),
    seated: numericCapacity(venue.capacity_seated),
    total: numericCapacity(venue.capacity_total),
    standing: numericCapacity(venue.capacity_standing),
  };
  const known = Object.entries(capacities).filter(([, value]) => Number.isFinite(value));
  if (!known.length) return "unknown";
  return known.map(([label, value]) => `${label}:${value}`).join(", ");
}

function numericCapacity(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function walkingMinutes(a, b) {
  return (distanceKm(Number(a.latitude), Number(a.longitude), Number(b.latitude), Number(b.longitude)) / 4.8) * 60;
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const earthRadius = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return earthRadius * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function toRad(value) {
  return (value * Math.PI) / 180;
}

function loadEnvFiles(files) {
  for (const file of files) {
    if (!fsSync.existsSync(file)) continue;
    const lines = fsSync.readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      const rawValue = trimmed.slice(index + 1).trim();
      if (!key || process.env[key]) continue;
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
    }
  }
}
