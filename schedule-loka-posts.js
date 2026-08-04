#!/usr/bin/env node
/**
 * Loka (TikTok) → Buffer queue top-up (TWO TRACKS, ONE CHANNEL)
 * -----------------------------------------------------------------------
 * Manages TWO independent evergreen content tracks on the SAME TikTok
 * channel, sharing the ONE Buffer queue for that channel:
 *
 *   MAIN track:   q001.png, q002.png, ... — no caption — every
 *                 MAIN_INTERVAL_HOURS (default 6h)
 *   PROMO track:  Day001.png .. Day365.png — fixed marketing caption —
 *                 every PROMO_INTERVAL_HOURS (default 4h)
 *
 * Buffer caps the TOTAL number of scheduled (not-yet-sent) posts per
 * channel — it doesn't know or care about "tracks". Running two separate
 * scripts against the same channel would have them blindly compete for
 * the same limited slots and clobber each other's scheduling math. This
 * script avoids that by managing both tracks together in one process:
 * it reads the channel's current queue ONCE, classifies each existing
 * post into MAIN or PROMO by comparing its caption text against
 * PROMO_CAPTION, then interleaves new posts from both tracks in true
 * chronological order until the shared limit is reached.
 *
 * Each track has its own fixed EPOCH_START + interval, exactly like the
 * single-track version — this keeps image selection stateless and
 * deterministic across runs (no persisted counter needed). Both tracks
 * currently share the same epoch anchor; only their intervals differ.
 *
 * Required environment variables (set as repo/CI secrets):
 *   BUFFER_API_KEY          Loka's Buffer personal API key
 *   BUFFER_ORG_ID           Loka's Buffer organization ID
 *   BUFFER_CHANNEL_ID       Loka's TikTok channel ID
 *   GOOGLE_DRIVE_API_KEY    API key with Drive API enabled (read-only is fine)
 *   ROOT_FOLDER_ID          Drive folder for the MAIN track (q001.png, ...)
 *   PROMO_ROOT_FOLDER_ID    Drive folder for the PROMO track (Day001.png, ...)
 *   PROMO_CAPTION           Fixed caption text used on every PROMO post
 * Optional:
 *   MAIN_CAPTION           Caption for MAIN track posts (default: empty)
 *   MAIN_INTERVAL_HOURS    Default 6
 *   PROMO_INTERVAL_HOURS   Default 4
 *   DRY_RUN                 "true" to log without creating posts
 *
 * Requires Node.js 18+ (uses global fetch).
 */

const BUFFER_API_KEY = requireEnv("BUFFER_API_KEY");
const ORG_ID = requireEnv("BUFFER_ORG_ID");
const CHANNEL_ID = requireEnv("BUFFER_CHANNEL_ID");
const DRIVE_API_KEY = requireEnv("GOOGLE_DRIVE_API_KEY");
const MAIN_ROOT_FOLDER_ID = requireEnv("ROOT_FOLDER_ID");
const PROMO_ROOT_FOLDER_ID = requireEnv("PROMO_ROOT_FOLDER_ID");
const PROMO_CAPTION = requireEnv("PROMO_CAPTION");

const MAIN_CAPTION = process.env.MAIN_CAPTION || "";
const MAIN_INTERVAL_HOURS = parseInt(process.env.MAIN_INTERVAL_HOURS || "6", 10);
const PROMO_INTERVAL_HOURS = parseInt(process.env.PROMO_INTERVAL_HOURS || "4", 10);
const DRY_RUN = process.env.DRY_RUN === "true";

// Fixed anchor so image selection is stateless/deterministic across runs
// for BOTH tracks. Never change this once posts are live, or every
// future slot's image mapping shifts.
const EPOCH_START = new Date("2026-08-03T00:00:00Z");
const LEAD_BUFFER_MS = 5 * 60 * 1000; // 5-minute lead so dueAt is always in the future

const BUFFER_GRAPHQL_URL = "https://api.buffer.com/graphql";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Google Drive helpers
// ---------------------------------------------------------------------------
async function listDriveImages(folderId) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`
  );
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "1000");
  url.searchParams.set("key", DRIVE_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Drive file list failed for ${folderId}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const files = data.files || [];
  return files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// ---------------------------------------------------------------------------
// Track helper (each track = its own interval on the shared epoch)
// ---------------------------------------------------------------------------
function makeTrack(intervalHours) {
  const intervalMs = intervalHours * 3600000;
  return {
    intervalHours,
    intervalMs,
    slotIndexForTime(date) {
      return Math.floor((date.getTime() - EPOCH_START.getTime()) / intervalMs);
    },
    timeForSlotIndex(slotIndex) {
      return new Date(EPOCH_START.getTime() + slotIndex * intervalMs);
    },
  };
}

// ---------------------------------------------------------------------------
// Buffer GraphQL helpers
// ---------------------------------------------------------------------------
async function bufferRequest(query, variables) {
  const res = await fetch(BUFFER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BUFFER_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) {
    throw new Error(`Buffer API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

async function getOrgScheduledPostLimit() {
  const query = `
    query Account {
      account { organizations { id limits { scheduledPosts } } }
    }
  `;
  const data = await bufferRequest(query, {});
  const org = data.account.organizations.find((o) => o.id === ORG_ID);
  return org ? org.limits.scheduledPosts : 10;
}

// Returns [{ dueAt: Date, text: string }] for every currently-scheduled
// post on the channel, so we can classify each into a track by caption.
async function getScheduledPosts(channelId) {
  const query = `
    query Posts($organizationId: OrganizationId!, $channelIds: [ChannelId!]) {
      posts(input: { organizationId: $organizationId, filter: { channelIds: $channelIds, status: [scheduled] } }, first: 100) {
        edges { node { dueAt text } }
      }
    }
  `;
  const data = await bufferRequest(query, { organizationId: ORG_ID, channelIds: [channelId] });
  return data.posts.edges.map((e) => ({
    dueAt: new Date(e.node.dueAt),
    text: e.node.text || "",
  }));
}

async function createPost({ channelId, fileId, title, dueAtIso }) {
  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id status dueAt } }
        ... on LimitReachedError { message }
        ... on InvalidInputError { message }
        ... on UnexpectedError { message }
      }
    }
  `;
  const input = {
    channelId,
    mode: "customScheduled",
    schedulingType: "automatic",
    dueAt: dueAtIso,
    text: title,
    assets: [
      {
        image: {
          url: `https://lh3.googleusercontent.com/d/${fileId}`,
          metadata: { altText: title || "Loka" },
        },
      },
    ],
    // TikTok doesn't require an explicit "type" the way Facebook/Instagram do.
  };
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would create post: dueAt=${dueAtIso} caption="${title}"`);
    return;
  }
  const data = await bufferRequest(mutation, { input });
  const payload = data.createPost;
  if (payload.message) {
    throw new Error(`createPost failed: ${payload.message}`);
  }
  console.log(`Scheduled: dueAt=${dueAtIso} caption="${title}" -> post ${payload.post.id}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Run started ${new Date().toISOString()}${DRY_RUN ? " [DRY RUN]" : ""}`);

  const mainTrack = makeTrack(MAIN_INTERVAL_HOURS);
  const promoTrack = makeTrack(PROMO_INTERVAL_HOURS);

  const [mainImages, promoImages] = await Promise.all([
    listDriveImages(MAIN_ROOT_FOLDER_ID),
    listDriveImages(PROMO_ROOT_FOLDER_ID),
  ]);
  console.log(`MAIN track: ${mainImages.length} images. PROMO track: ${promoImages.length} images.`);

  const limit = await getOrgScheduledPostLimit();
  console.log(`Buffer scheduled-post limit for this channel: ${limit}`);

  const scheduled = await getScheduledPosts(CHANNEL_ID);
  const mainScheduled = scheduled.filter((p) => p.text !== PROMO_CAPTION);
  const promoScheduled = scheduled.filter((p) => p.text === PROMO_CAPTION);
  console.log(
    `Channel ${CHANNEL_ID}: ${scheduled.length}/${limit} total slots used ` +
      `(MAIN: ${mainScheduled.length}, PROMO: ${promoScheduled.length}).`
  );

  const nowMainSlot = Math.ceil((Date.now() + LEAD_BUFFER_MS - EPOCH_START.getTime()) / mainTrack.intervalMs);
  const nowPromoSlot = Math.ceil((Date.now() + LEAD_BUFFER_MS - EPOCH_START.getTime()) / promoTrack.intervalMs);

  const latestMainSlot = mainScheduled.length
    ? Math.max(...mainScheduled.map((p) => mainTrack.slotIndexForTime(p.dueAt)))
    : -1;
  const latestPromoSlot = promoScheduled.length
    ? Math.max(...promoScheduled.map((p) => promoTrack.slotIndexForTime(p.dueAt)))
    : -1;

  let nextMainSlot = Math.max(nowMainSlot, latestMainSlot + 1);
  let nextPromoSlot = Math.max(nowPromoSlot, latestPromoSlot + 1);

  const slotsToFill = limit - scheduled.length;
  if (slotsToFill <= 0) {
    console.log("Channel already at its scheduled-post limit. Nothing to add this run.");
    return;
  }
  console.log(`Filling ${slotsToFill} more slot(s) total, interleaving MAIN (${MAIN_INTERVAL_HOURS}h) and PROMO (${PROMO_INTERVAL_HOURS}h).`);

  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
  let filled = 0;

  while (filled < slotsToFill) {
    const mainCandidateTime = mainTrack.timeForSlotIndex(nextMainSlot);
    const promoCandidateTime = promoTrack.timeForSlotIndex(nextPromoSlot);

    // Whichever track's next slot is chronologically earlier goes first —
    // this is what naturally interleaves the two cadences into one queue.
    const useMain = mainCandidateTime.getTime() <= promoCandidateTime.getTime();

    let fileId, title, dueAt, trackLabel;
    if (useMain) {
      const imageIndex = ((nextMainSlot % mainImages.length) + mainImages.length) % mainImages.length;
      fileId = mainImages[imageIndex].id;
      title = MAIN_CAPTION;
      dueAt = mainCandidateTime;
      trackLabel = "MAIN";
    } else {
      const imageIndex = ((nextPromoSlot % promoImages.length) + promoImages.length) % promoImages.length;
      fileId = promoImages[imageIndex].id;
      title = PROMO_CAPTION;
      dueAt = promoCandidateTime;
      trackLabel = "PROMO";
    }

    const dueAtIso = dueAt.toISOString();

    try {
      await createPost({ channelId: CHANNEL_ID, fileId, title, dueAtIso });
      console.log(`  (${trackLabel})`);
      filled++;
      consecutiveFailures = 0;
    } catch (err) {
      console.error(`Failed to schedule ${trackLabel} slot (${dueAtIso}): ${err.message}`);
      consecutiveFailures++;
      if (/limit/i.test(err.message)) {
        console.log("Buffer reports the scheduled-post limit is reached. Stopping cleanly.");
        break;
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`Stopping after ${consecutiveFailures} consecutive failures.`);
        break;
      }
    }

    if (useMain) {
      nextMainSlot++;
    } else {
      nextPromoSlot++;
    }
  }

  console.log(`Run complete. ${filled} post(s) scheduled this run.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
