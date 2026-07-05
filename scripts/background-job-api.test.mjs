const baseUrl = process.env.PAINTS_TEST_BASE_URL || "http://localhost:8765";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  return { response, body };
}

const oneUser = {
  id: "job-test-1",
  name: "Job Test",
  age: 30,
  gender: "Woman",
  district: "Islington",
  latitude: 51.546,
  longitude: -0.103,
  category: "Books & Coffee",
  availability: "Thursday 7pm",
  price_preference: "££",
  gender_mix_preference: "Mixed",
  age_preference: "Similar age",
  travel_time_preference: "30 min",
  last_venue_ids: [],
  last_event_user_ids: [],
  pending_group_week: 0,
};

await request("/api/reset", { method: "POST", body: "{}" });
await request("/api/state", {
  method: "POST",
  body: JSON.stringify({ users: [oneUser], events: [], week: 1 }),
});

const startedAt = Date.now();
const { response: runResponse, body: runBody } = await request("/api/run-agents", {
  method: "POST",
  body: "{}",
});
const elapsed = Date.now() - startedAt;

assert(runResponse.status === 202, `Expected /api/run-agents to return 202, got ${runResponse.status}`);
assert(runBody.job_id, "Expected /api/run-agents to return job_id");
assert(elapsed < 1500, `Expected /api/run-agents to return quickly, took ${elapsed}ms`);

const { response: jobResponse, body: job } = await request(`/api/jobs/${runBody.job_id}`);
assert(jobResponse.status === 200, `Expected /api/jobs/:id to return 200, got ${jobResponse.status}`);
assert(["queued", "running", "completed"].includes(job.status), `Unexpected job status ${job.status}`);
assert(typeof job.progress === "object", "Expected job progress object");
assert(typeof job.progress.planned_events === "number", "Expected job progress to include planned_events");

for (let attempt = 0; attempt < 20; attempt += 1) {
  const { body: latest } = await request(`/api/jobs/${runBody.job_id}`);
  if (latest.status === "completed") {
    assert(latest.log.includes("Need at least 2 users"), "Expected completed one-user job to explain not enough users");
    await request("/api/reset", { method: "POST", body: "{}" });
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

throw new Error("Expected one-user background job to complete quickly");
