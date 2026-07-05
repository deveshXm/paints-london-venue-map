# PAINTS Agentic Matching Spec

Date: 2026-07-04

## Goal

Build a fully agentic matching system for PAINTS matched events.

The system should work with very little user data now, but improve later when PAINTS adds personality, vibe, interests, or richer preference data.

The system creates:

```text
matched users + venue + backup venue / meeting point + storyline = PAINTS matched event
```

## Current User Data

For beta, assume PAINTS only has:

```text
name
age
location / district
gender
gender mix preference
age preference
selected category
availability
price preference, if available
travel-time preference: 15 min / 30 min / 45 min / an hour or more
```

No personality questionnaire exists yet.

The agents must not pretend personality data exists.

If future data is added, such as personality, vibe, interests, creative taste, or social style, the agent should use it. If any field is missing, the agent should continue without it and adjust its judgment pro-rata.

## Agent Structure

Use a maximum of 3 agents.

## Decision Boundary

Backend filtering should be minimal before the agent runs.

Backend may batch or reject only for eligibility and safety:

```text
category
availability
group size rule
user exists and is not already placed in this run
venue exists
venue coordinates
explicit capacity is enough for the group where capacity is known
same-time PAINTS primary-venue collision
primary and backup are different venues
backup ideally starts 5-10 minutes from primary, but distance loosens pro-rata if needed
```

The agent decides fit and tradeoffs:

```text
location fit
travel-time fit
age preference fit
gender mix fit
price fit
recent user repeat fallback
recent venue repeat fallback
operational caveats
match_quality
fallback_reason
```

Simple rule:

```text
Backend controls eligibility and safety.
Agent controls taste, matching judgment, and fallback tradeoffs.
```

### 1. Group Agent

The Group Agent creates the best group from a batch of users.

It receives a small prompt:

```text
batch_id
city
category
date/time window
group size rules
hard filters
```

It should not receive every possible user in the prompt. It explores users with tools, like a top-down map.

It outputs:

```text
selected users
group size
category
date/time
confidence
short internal reasoning
```

The Group Agent should use available data only.

Current beta group judgment:

```text
location fit
availability fit
category fit
age preference fit
gender mix preference fit
price compatibility
travel-time preference fit
```

Later, if richer fields exist, it can add:

```text
personality fit
vibe fit
conversation style
interests
creative taste
past event ratings
```

Group Agent tools:

```text
search_users
get_user_details
create_group
```

`search_users` is the top-down view. The agent can search by district, radius, age, price preference, and limit. The backend does not programmatically cluster users by district or postcode.

It should return a compact map-style view:

```text
total available users
matching user rows
latitude / longitude
district
age
price preference
travel-time preference
recent people
```

The Group Agent can rotate around the data by changing district, near/radius, price, age range, and limit.

Example:

```text
search_users(district="Chelsea", limit=50)
search_users(near={lat:51.49,lng:-0.17,radius_km:3}, limit=80)
search_users(price="££", age_min=25, age_max=35, limit=80)
```

`get_user_details` is the zoom-in view. It should return only the details needed for matching.

`create_group` commits the selected users to one pending group. If another agent has already placed one of those users into a group for the same date/time, it returns a conflict and the Group Agent chooses a different set.

For each user, include:

```text
basic profile fields
selected category
availability
price preference, if available
last 4 venues attended
all users they met across their last 4 events
last event feedback only
```

Do not pass full event history, full feedback history, chat logs, or private notes.

Hard filters for Group Agent:

```text
respect category and availability
respect category group size rules
user is not already placed into another group in the same run
```

Soft preferences for Group Agent:

```text
location / travel-time fit
age preference
gender mix preference
price compatibility
do not repeat users who met across their last 4 events where possible
```

If 2+ users share category and availability, the system should not leave them unmatched just because soft preferences are imperfect. It should choose the closest viable match and mark it internally:

```text
match_quality: ideal / good / fallback
fallback_reason: short internal reason, such as age preference mismatch, travel-time stretch, price mismatch, or repeat-user fallback
```

Do not create user-facing copy that says "PAINTS picked this because..." or exposes internal scoring.

### 1b. Adjusted Group Agent

After the strict Group Agent pass, run one adjusted grouping pass for users still unmatched.

This agent exists because the product should still suggest the closest real match when an exact match is not available.

Adjusted Group Agent tools:

```text
search_unmatched_users
search_existing_groups
add_users_to_group
create_adjusted_group
```

The Adjusted Group Agent can:

```text
add an unmatched user to an existing group if size allows
create a new adjusted group from unmatched users
compromise availability before category when that creates a better real event
compromise category only when the user would otherwise remain unmatched
as last priority, exceed normal category max by up to +2 users to avoid leaving people out
```

Every compromise must be stored internally:

```text
adjusted_match: true
match_quality: fallback
fallback_reason
compromised_metrics:
  user_id
  metric: day/time, category, age, gender mix, price, travel time, recent repeat
  from
  to
  severity, optional
```

Examples:

```text
Deepa: time slot Saturday morning -> Saturday afternoon
Gareth: time slot Saturday evening -> Saturday afternoon
Greta: gender mix women-only -> mixed
Greta: age preference 38-48 -> group includes 27/29
group: group size 4 -> 5
```

Do not show this as a user-facing warning yet. Store it so operators can review quality.

### 2. Event Agent

The Event Agent creates the event for the group.

It receives a small prompt:

```text
final group
category
date/time
agent-selected search lens
group size
price preference
hard filters
soft preferences
match_quality / fallback_reason from the group
```

It should not receive every venue in the prompt. It explores venues with tools, like a top-down map.

It chooses:

```text
primary venue
second venue as backup / meeting point
event title
storyline / anecdote / theme
user-facing reveal copy
operational caveats
```

The user-facing copy should explain the place, not PAINTS' internal reasoning.

Users should see:

```text
storyline
anecdote
theme of the place
what is served / on view
meeting point notes
location reveal timing
```

Users should not see:

```text
why PAINTS picked it
internal scoring logic
agent reasoning
```

Event Agent tools:

```text
search_venues_map
get_venue_details
web_search
create_event
```

`search_venues_map` is the top-down venue view. The agent can search by category, city, date/time, area, radius, group size, price, PAINTS score, and limit.

The tool should not hide venues for soft preference reasons. It may rank or label useful context, but should not remove venues because of price, travel time, recent attendance, or imperfect operational fit. Those are agent decisions.

It should return a compact map-style view:

```text
total available venues
venue clusters
cluster centers
venue counts
average PAINTS score
backup density
sample venues
```

The tool should return enough information for efficient agent choice:

```text
venue id
name
category
district / nearest station
price
PAINTS score
rating summary, if available
opening-hours summary
walk-in / group-fit summary
storyline / anecdote summary
coordinates
nearby venue ids, starting with 5-10 minutes away and expanding if needed
recent operational flags
recent PAINTS usage summary
```

The Event Agent can rotate around the venue data by changing area, radius, category, price, and limit.

Example:

```text
search_venues_map(area="Chelsea", radius="1 mile", limit=40)
search_venues_map(area="Fulham", radius="1.5 miles", limit=40)
search_venues_map(area="South Kensington", radius="1 mile", limit=40)
```

`get_venue_details` is the zoom-in view for shortlisted venues.

`web_search` is available for live checking when stored data is unclear, such as opening hours, temporary closure, current exhibition, market dates, or current venue context.

`create_event` atomically reserves only the primary venue. If the primary was already taken by another PAINTS event for the same date/time, it returns a conflict and the agent picks another primary. Backup venues are checked for existence, coordinates, distinctness, and explicit capacity, but are not locked.

The agent chooses two venues from the same venue system:

```text
Venue A = primary
Venue B = backup
```

Do not treat backup venues as a separate database.

Hard filters for Event Agent:

```text
correct category
usable location
valid coordinates
PAINTS score >= 65
not confirmed for another PAINTS event at same date/time
backup venue ideally starts 5-10 minutes walking distance from primary venue, then expands if needed
```

Soft preferences for Event Agent:

```text
price compatibility where known
user travel-time preference
do not use venues attended by selected users in their last 4 events where possible
closest fair location for the group
group size suitability where known
opening hours suitability / caveats
```

If no ideal venue pair exists after hard filters, the Event Agent should still choose the closest viable pair and mark it internally:

```text
match_quality: ideal / good / fallback
fallback_reason: short internal reason
```

### 3. Final Check Agent

The Final Check Agent is optional but recommended.

It should be lightweight. It is not a full creative walk safety reviewer.

It checks only whether the proposed event obeys the operational rules:

```text
group size is valid
category is valid
primary venue came from search_venues_map results for this run
backup venue came from the same venue system as the primary venue
primary venue was reserved successfully at create_event time
backup venue was checked for explicit capacity and operational suitability, but not reserved
primary venue was not attended by selected users in their last 4 events, unless fallback was explicitly used
backup venue was not attended by selected users in their last 4 events, unless fallback was explicitly used
venue hours look valid from stored data plus latest available web refresh
backup walking distance is ideal first, not a backend hard blocker
price is compatible
event copy is user-facing and does not expose internal reasoning
```

## Group Sizes

Use category config for group sizes:

```text
each category defines min group size
each category defines max group size
the Group Agent receives the group size rule for that category
```

## Category Prompt Config

Each category should have its own short prompt config.

The agents receive the category config for the batch they are working on.

Category config should define:

```text
group size rule
venue type rules
price expectations
meeting point rules
backup venue rule
user-facing tone
what details matter for the event story
what details should be verified with web_search
```

This keeps the agents generic while letting each category behave differently.

If there are not enough users to form a valid group:

```text
do not create a fake event
strict pass first tries exact category and availability
adjusted pass then tries closest possible group by loosening day/time, then category if needed
only keep users in "forming group" state when no 2+ user adjusted match is viable
if 2+ users can be matched with a reasonable compromise, create the adjusted group and store compromised_metrics
```

## Batch Scaling

Do not run one giant agent over all users.

Create batches by:

```text
city
date
time slot
category
```

Do not create district clusters programmatically. If locality matters, the Group Agent uses `search_users` with district or near/radius filters and decides when to zoom out.

Example batches:

```text
London / Friday 7pm / Show & Tell Drinks
London / Saturday 11am / Market Days
London / Sunday 2pm / Museum & Gallery Days
```

Run one Group Agent per batch/pass.

The Group Agent starts wherever it thinks quality is strongest, using `search_users` to zoom in/out. Area is an agent-controlled search lens, not a backend pre-filter.

Then run one Event Agent per created group.

Before Event Agents run, the Adjusted Group Agent gets one recovery pass across users left unmatched by strict batches. This prevents cases like Saturday morning and Saturday evening users being abandoned when a Saturday afternoon group has room and is clearly the closest product experience.

This scales because each agent only explores:

```text
users relevant to that batch
venues visible through search tools
shortlisted details
```

## 1000-User Scaling

For 1000 users, keep the product agentic without running one huge prompt.

High-level flow:

```text
1000 users
backend batches by city + category + availability
Group Agent works each bucket in passes
successful groups reserve users
Event Agents run per group, in parallel with a concurrency cap
create_event reserves venue pairs
Final Check Agent audits the final schedule
```

Architecture principle:

```text
do not scale by making one giant agent think about 1000 users
scale by deterministic orchestration + agentic judgment inside bounded jobs
```

The backend owns control:

```text
batching
run lock / queue
pass limits
timeouts
retries
JSON/database writes
user assignment conflicts
venue reservation conflicts
partial success
operator status
```

The agents own judgment:

```text
who should be grouped together
which tradeoffs are acceptable
which venue pair feels best
when to use fallback
how to write the event storyline
```

Backend batching remains minimal:

```text
city
category
availability / time slot
```

Do not pre-split into tiny postcode groups. That would reduce match quality.

If one category/time bucket is small:

```text
run one Group Agent pass
agent sees the available pool through search_users
agent creates as many groups as possible
```

If one category/time bucket is large, such as 100-300 users:

```text
run Group Agent pass 1 over the full remaining bucket
agent creates up to max_groups for that pass
backend reserves selected users
remove assigned users from the available pool
run Group Agent pass 2 over the remaining users
repeat until fewer than 2 eligible users remain or the run budget is reached
```

The agent still sees the whole remaining eligible pool through tools. The pass limit is a work-budget control, not a quality filter.

Recommended defaults:

```text
Group Agent max turns: 100
Event Agent max turns: 100
Group Agent max groups per pass: 25-40
Group Agent max passes per batch: 8 by default, configurable by run budget
Group Agent max visible users in prompt: compact first view only
search_users limit: tool-controlled, expandable by agent
parallel Event Agents: 10-30 at a time
large bucket threshold: around 100-150 users
```

For a 300-user bucket:

```text
pass 1 creates up to 30 groups
pass 2 creates up to 30 more groups
pass 3 handles leftovers
```

This keeps the agentic feature because:

```text
the agent chooses groups
the agent can inspect any remaining eligible user
the agent can cross geography when it thinks quality is better
the backend only prevents duplicate assignment and collisions
```

Partial success is required.

If one group or event fails:

```text
keep all successful groups/events
mark the failed unit with status and reason
continue with the next group/event
do not fail the whole batch
```

Run-level safety:

```text
only one full matching run should write to the same event schedule at once
if another run starts, return "run already active" or queue it
do not let two button clicks spend tokens on the same users at the same time
```

Runtime shape:

```text
POST /api/run-agents returns a job_id immediately
the browser never waits on the full agent run
GET /api/jobs/:job_id returns phase, progress, failures, and final saved state
POST /api/jobs/:job_id/cancel requests cancellation
successful events are written as they complete
```

Event scaling shape:

```text
Group Agent creates groups
Venue Agents run concurrently for groups
each Venue Agent claims primary first
then claims backup near that primary
events are saved as claims succeed
```

Default Venue Agent concurrency:

```text
10 agents at once
```

The Venue Agents are allowed to race. Race conflicts are normal.

Primary venue is the main quality decision.

Model settings:

```text
model: gpt-5.5
reasoning effort: medium
text verbosity: medium
```

Each Venue Agent should work like this:

```text
1. search freely for the strongest primary venue for the group
2. claim the primary venue atomically
3. if primary is taken, choose another primary
4. search backup venues around the claimed primary
5. check backup eligibility without locking it
6. if backup is operationally weak, keep the primary and search another backup
7. create the event
```

Quality ladder:

```text
primary pass 1: same category, strong score, plausible hours, price-compatible, good story, sensible geography
primary pass 2: broaden geography before weakening category, hours, or price
primary pass 3: accept lower score / price stretch / operational uncertainty only with fallback_reason
backup pass 1: same category, 5-10 min walk
backup pass 2: same category, 10-15 min walk
backup pass 3: same category, 15-25 min walk
backup pass 4: different category or longer walk only if the primary is worth keeping and fallback_reason explains it
```

Backup behavior:

```text
1. search ideal 5-10 minute backups first
2. if backup options are thin, expand backup radius/time tolerance first
3. do not change the primary just because the first backup search is hard
4. only change primary if the primary itself is weak, unavailable, or unsafe
```

The backend does not rank venues for taste. It only rejects unsafe choices:

```text
missing coordinates
explicit capacity too small for the group
primary and backup venue are the same
primary venue already booked at the same date/time
```

Everything else is agentic and pro-rata:

```text
category match
same time
area
price
PAINTS score
backup category
backup distance
backup already used as someone else's backup
backup also being used as another event's primary
```

The goal is to create an event whenever any valid primary and valid backup exist. Backup distance works like primary venue fit: ideal distance matters, but it is agentic/pro-rata, not a backend blocker. Backup venues are not locked. A venue can be backup for one event and primary/backup for another event at the same time, as long as explicit capacity is not too small and the agent marks any uncertainty. If the ideal category or nearby backup is unavailable, the Venue Agent should loosen scope in priority order and mark `match_quality` / `fallback_reason`.

Progress should include:

```text
phase
total users
batches done / total
groups created
venue pairs planned
event groups done / total
events created
failed units
venue conflicts retried
current log message
```

Useful statuses:

```text
group_created
event_created
waiting_for_more_users
agent_timeout
venue_pair_not_found
venue_collision_retry
fallback_created
audit_failed
```

The product should expose only friendly state to users. Internal statuses are for operators, debugging, and future quality tuning.

## Group Agent Pass Rules

For each pass, the Group Agent should receive:

```text
batch id
category
availability
remaining user count
group size rules
max_groups for this pass
current pass number
compact first view of the pool
tools for map/search/detail/create_group
```

The Group Agent instruction should be explicit:

```text
Create as many good groups as possible, up to max_groups.
Continue grouping until fewer than 2 viable users remain or max_groups is reached.
Do not stop after one good group.
Use match_quality and fallback_reason for imperfect groups.
```

The backend should enforce:

```text
user exists
same category
same availability
group size rule
user not already assigned in this run
```

For the Adjusted Group Agent, backend enforcement changes to:

```text
user exists
normal group size is ideal
adjusted group size can go up to normal max + 2 only as last priority
group size overflow must have a compromised_metrics entry
user not already assigned in this run
every category or availability mismatch has a compromised_metrics entry
```

The backend should not enforce:

```text
district
age preference
gender mix preference
price preference
travel-time preference
recent user repeat
```

Those remain agent judgment.

## Event Agent Scaling

Run one Event Agent per created group.

Event Agents can run in parallel, but with a concurrency cap to avoid cost spikes and API pressure:

```text
10-30 Event Agents at a time for 1000-user runs
```

For the JSON prototype, Event Agents may run sequentially because JSON files do not provide real atomic venue reservations.

For production, Event Agents can run concurrently only when `create_event` writes through a database transaction or uniqueness constraint.

Each Event Agent should receive:

```text
final group
category
availability
area suggested by Group Agent
match_quality / fallback_reason from group
tools for venue pair search, venue details, web_search, and create_event
```

The Event Agent should prefer nearby backup searches early because they return cleaner primary/backup options, but it can expand distance when needed.

If `create_event` reports a venue collision:

```text
the Event Agent chooses another venue pair
backend prevents the collision
successful events remain saved
```

The backend should not fail the entire run because one Event Agent times out or fails. It should record that group as unresolved and continue.

## 1000-User Success Criteria

For a 1000-user London run, success means:

```text
no duplicate user assignment in the same run
no duplicate venue booking at the same date/time
every event has primary and backup venue
backup venue exists and is different from primary; 5-10 minutes is ideal, not hard
events have match_quality
fallback events have fallback_reason
adjusted events have adjusted_match and compromised_metrics
successful partial output is saved even if some units fail
unmatched users have a clear internal status
operator can see failures by group/event, not only one batch-level error
```

Quality target:

```text
small buckets: match all users where 2+ eligible users exist
large buckets: maximize coverage while preserving group quality
leftovers: only users who truly cannot form a 2+ same category/time group, or who remain after run-budget limits
```

## Simple Venue Reservation

Keep reservation simple.

Do not lock every venue an agent sees.

All agents can see the same venue candidates.

The only hard reservation happens when an Event Agent calls `create_event`.

```text
search_venues_map = browse
get_venue_details = inspect
create_event = reserve
```

At `create_event`, the backend does an atomic reservation:

```text
primary venue + date/time must be free
backup venue must exist, be different from primary, have coordinates, and not have explicit capacity below group size
if primary is free and both venues pass safety checks, create event and reserve only the primary
if primary is taken, return conflict
```

Use a database uniqueness rule for safety:

```text
venue_id
date_time_slot
reservation_role: primary / backup
event_id
```

Simple flow:

```text
1. Backend creates a batch.
2. Backend finds users eligible by category and availability.
3. Group Agent explores users with search_users.
4. Group Agent creates a group.
5. Event Agent calls search_venues_map.
6. Backend excludes only venues that fail safety/eligibility checks, such as same-time PAINTS collisions.
7. Event Agent inspects venues and uses web_search only if needed.
8. Event Agent chooses primary and backup.
9. create_event tries to reserve the primary venue atomically and checks the backup without locking it.
10. If successful, event is created.
11. If conflict, create_event returns the conflict and the agent chooses another pair.
```

This avoids locking 30-40 browsed venues and keeps race conditions simple.

## Venue Availability Meaning

When the spec says a venue is "free at that time," it means two things:

### 1. PAINTS availability

There is no other PAINTS event using that venue at the same date/time.

This includes:

```text
matched events
verified host events
PAINTS hosted events
primary venue usage
backup venue usage
```

### 2. Real-world availability

The venue appears to be operationally usable at that time.

The system should refresh from available web data where possible:

```text
opening hours
closed days
bank holiday notes
temporary closure
private hire warnings
current exhibition dates, where relevant
walk-in policy, where available
```

If the latest web data is unclear, mark:

```text
UNVERIFIED - host must confirm
```

For beta, unverified details can still be allowed only if the product team accepts that operational risk.

## Backup Venue Rule

The 5-10 minute walking distance preference applies to the backup venue, not the main venue.

The main venue should be chosen based on:

```text
user location / district
category
price
opening hours
walk-in suitability
group size
venue quality
PAINTS fit
```

The backup venue should be:

```text
5-10 minutes walking distance from the primary venue when possible, then expand if needed
available as a backup option
open or likely open at the event time
same category where required
operationally acceptable
```

For markets, walks, museums, and galleries, meeting point logic can differ by category, but the same no-collision and availability principle applies.

## Venue Hard Filters

For beta, backend venue safety filters are hard filters. Preference filters are not hard filters.

The Event Agent only sees venues through `search_venues_map`. The tool should return venues that already pass backend safety checks:

```text
usable location
valid coordinates
Google Maps link
explicit capacity not below group size where capacity is known
not confirmed as another PAINTS primary venue at same date/time
```

The tool should not remove venues for:

```text
category mismatch
PAINTS score
price mismatch
travel-time stretch
recent user venue attendance
group size uncertainty
opening-hours uncertainty
```

Those should be shown as context for the Event Agent to judge. If they cannot all be satisfied, the event can still be created as the closest viable fallback with `match_quality` and `fallback_reason`.

## User-Facing Event Reveal

Location and group reveal happens 24 hours before the event.

Reveal copy should include:

```text
venue name
meeting point
storyline or anecdote
theme of the place
what users will see / drink / browse / notice
backup note
chat availability
SOS / red flag availability
```

Example:

```text
You’ll meet at a small independent wine bar tucked near London Fields, known for low-intervention bottles, candlelit tables, and the kind of room where conversation can start without trying too hard.
```

## End-to-End Flow

```text
1. Users sign up and choose category / availability.
2. Backend creates matching batches by city, date, time, and category.
3. Group Agent explores users through search_users.
4. Group Agent creates as many strong groups as possible for the pass.
5. Backend reserves assigned users for this run.
6. If users remain in a large bucket, backend starts another Group Agent pass.
7. Event Agent explores venues through search_venues_map and search_venue_pairs.
8. Event Agent chooses primary venue and second venue as backup / meeting point.
9. Event Agent uses web_search only when stored venue data is unclear.
10. create_event atomically reserves both venues.
11. If create_event returns conflict, Event Agent chooses another pair.
12. Successful events are saved even if later groups fail.
13. Final Check Agent validates the final schedule for duplicates, collisions, missing data, and fallback labeling.
14. Users see the event card.
15. Location and group reveal happens 24 hours before.
16. Chat opens.
17. Event happens.
18. Ratings feed future matching.
```

## Product Principle

PAINTS should feel fully agentic:

```text
AI forms the group.
AI chooses the event.
AI writes the story.
AI adapts when data is missing.
```

But the backend should still control:

```text
confirmed venue reservations
confirmed event creation
eligible venue search results
payments
chat
notifications
audit logs
user privacy
```

The simple rule:

```text
Backend controls eligibility and safety.
Agents decide fit, taste, and fallback tradeoffs from valid options.
```
