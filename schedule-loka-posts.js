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
const PROMO_ROOT_FOLDER_ID = process.env.PROMO_ROOT_FOLDER_ID || ""; // PROMO is retired: leave unset
const PROMO_CAPTION = process.env.PROMO_CAPTION || "__PROMO_RETIRED__";

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

// ---------------------------------------------------------------------------
// STORY track: one "LAYA 365 story" post per day at 11:00 PM Manila, read from
// story-365-part1..4.json (365 posts written with the booking link, repeating
// every 365 days; the workflow downloads the files before the script runs).
// Stateless like the other tracks: the post is picked from a fixed daily grid,
// nothing is stored. Instagram-style: image post with the story as caption, hook line first, DM line instead of a link.
// ---------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const STORY_LINK_LINE = "Pick a time at laya365.com/contact";
const STORY_DM_LINE = "Send us a DM and we'll find a time.";
const STORY_WITH_IMAGE = true;
const STORY_IMAGE_URL = "https://raw.githubusercontent.com/workwithsahara/laya-meta-buffer-scheduler/main/laya-story-image.jpg";

// Instagram and TikTok story posts now use a 10 second video (laya-story-video.mp4 in the
// laya-meta-buffer-scheduler repo). If the video is not reachable the still image is used, so
// no post is ever missed. Posts already in the queue with the image are upgraded to the video.
const STORY_VIDEO_URL = "https://raw.githubusercontent.com/workwithsahara/laya-meta-buffer-scheduler/main/laya-story-video.mp4";
let STORY_VIDEO_READY = false;
async function checkStoryVideo() {
  try {
    const res = await fetch(STORY_VIDEO_URL, { method: "HEAD" });
    STORY_VIDEO_READY = res.ok;
  } catch (e) {
    STORY_VIDEO_READY = false;
  }
  console.log(`STORY media: ${STORY_VIDEO_READY ? "video found, Instagram/TikTok story posts will be video" : "video NOT found, using the image"}.`);
}
function storyMedia() { return STORY_VIDEO_READY ? STORY_VIDEO_URL : STORY_IMAGE_URL; }
const STORY_HOOKS = [
  "Did I get your attention?",
  "Okay, now that I have you.",
  "Scary, right? Not as scary as a page that went quiet.",
];
let STORY_POSTS = [];
for (let i = 1; i <= 4; i++) {
  try {
    STORY_POSTS = STORY_POSTS.concat(JSON.parse(fs.readFileSync(path.join(__dirname, `story-365-part${i}.json`), "utf8")));
  } catch (err) {
    console.warn(`STORY: could not load story-365-part${i}.json (${err.message}). Track disabled.`);
    STORY_POSTS = [];
    break;
  }
}
const STORY_SET = new Set();
STORY_POSTS.forEach((t) => {
  STORY_SET.add(t.trim());
  STORY_SET.add(t.split(STORY_LINK_LINE).join(STORY_DM_LINE).trim());
});
const STORY_EPOCH_START = new Date("2026-10-10T15:00:00Z"); // 11:00 PM Manila. Never change once live.
const STORY_START_INDEX = 0; // index of the story posted in slot 0
const STORY_INTERVAL_MS = 24 * 60 * 60 * 1000;
let STORY_INTROS = [];
try {
  STORY_INTROS = JSON.parse(fs.readFileSync(path.join(__dirname, "story-hooks-365.json"), "utf8"));
} catch (err) {
  console.warn(`STORY: could not load story-hooks-365.json (${err.message}). Using the old rotating hook lines.`);
  STORY_INTROS = [];
}
const STORY_IDENTITY = "We're LAYA 365. We write a full year of posts for small business owners and build their websites.";
function storyUseIntros() { return STORY_INTROS.length > 0 && STORY_INTROS.length === STORY_POSTS.length; }
// Instagram/TikTok caption: an intro line that follows the scary video and leads into this story,
// then the story, with one line saying who we are (only when the story does not already name LAYA).
function storyIgCaption(idx, body) {
  if (!storyUseIntros()) return STORY_HOOKS[idx % STORY_HOOKS.length] + "\n\n" + body;
  let text = body;
  if (!/LAYA/.test(body)) {
    const paras = body.split("\n\n");
    paras.splice(Math.max(paras.length - 1, 0), 0, STORY_IDENTITY);
    text = paras.join("\n\n");
  }
  return STORY_INTROS[idx] + "\n\n" + text;
}
let STORY_TEXT_IDX = null;
function storyTextIndex() {
  if (STORY_TEXT_IDX) return STORY_TEXT_IDX;
  const m = new Map();
  STORY_POSTS.forEach((t, idx) => {
    const dm = t.split(STORY_LINK_LINE).join(STORY_DM_LINE);
    m.set(t.trim(), idx);
    m.set(dm.trim(), idx);
    for (const h of STORY_HOOKS) m.set((h + "\n\n" + dm).trim(), idx);
    if (storyUseIntros()) m.set(storyIgCaption(idx, dm).trim(), idx);
  });
  STORY_TEXT_IDX = m;
  return m;
}
function storyDesiredCaption(text) {
  const idx = storyTextIndex().get((text || "").trim());
  if (idx === undefined) return null;
  return storyIgCaption(idx, STORY_POSTS[idx].split(STORY_LINK_LINE).join(STORY_DM_LINE));
}
function isStory(text) {
  return storyTextIndex().has((text || "").trim());
}
function storyTimeForSlot(slot) { return new Date(STORY_EPOCH_START.getTime() + slot * STORY_INTERVAL_MS); }
function storySlotForTime(date) { return Math.round((date.getTime() - STORY_EPOCH_START.getTime()) / STORY_INTERVAL_MS); }
function storyIndexForSlot(slot) { return (((STORY_START_INDEX + slot) % STORY_POSTS.length) + STORY_POSTS.length) % STORY_POSTS.length; }
function storyText(slot) {
  const idx = storyIndexForSlot(slot);
  const t = STORY_POSTS[idx];
  if (!STORY_WITH_IMAGE) return t;
  return storyIgCaption(idx, t.split(STORY_LINK_LINE).join(STORY_DM_LINE));
}

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
        edges { node { id dueAt text assets { type } } }
      }
    }
  `;
  const data = await bufferRequest(query, { organizationId: ORG_ID, channelIds: [channelId] });
  return data.posts.edges.map((e) => ({
    id: e.node.id,
    dueAt: new Date(e.node.dueAt),
    text: e.node.text || "",
    hasVideo: (e.node.assets || []).some((a) => a.type === "video"),
  }));
}

// Swap the still image for the video on story posts that are already queued.
async function upgradeQueuedStories(posts) {
  if (!STORY_VIDEO_READY) return;
  const todo = posts.filter((p) => p.id && isStory(p.text) && p.dueAt.getTime() > Date.now() + 15 * 60 * 1000 && (!p.hasVideo || storyDesiredCaption(p.text) !== (p.text || "").trim()));
  if (todo.length === 0) return;
  console.log(`Upgrading ${todo.length} queued story post(s) from image to video / new caption.`);
  const mutation = `
    mutation EditPost($input: EditPostInput!) {
      editPost(input: $input) {
        ... on PostActionSuccess { post { id } }
        ... on InvalidInputError { message }
        ... on UnexpectedError { message }
        ... on NotFoundError { message }
        ... on UnauthorizedError { message }
        ... on LimitReachedError { message }
      }
    }
  `;
  for (const p of todo) {
    const input = {
      id: p.id,
      assets: [{ video: { url: STORY_VIDEO_URL } }],
      mode: "customScheduled",
      schedulingType: "automatic",
      dueAt: p.dueAt.toISOString(),
    };
    const wantText = storyDesiredCaption(p.text);
    if (wantText && wantText !== (p.text || "").trim()) input.text = wantText;
    if (DRY_RUN) {
      console.log(`[DRY RUN] Would upgrade post ${p.id} (${p.dueAt.toISOString()}) to video.`);
      continue;
    }
    try {
      const data = await bufferRequest(mutation, { input });
      if (data.editPost && data.editPost.message) throw new Error(data.editPost.message);
      console.log(`Upgraded post ${p.id} (${p.dueAt.toISOString()}) to video.`);
    } catch (err) {
      console.error(`Could not upgrade post ${p.id}: ${err.message}. It stays as the image.`);
    }
  }
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
  const isVideo = typeof fileId === "string" && /\.mp4$/i.test(fileId);
  const input = {
    channelId,
    mode: "customScheduled",
    schedulingType: "automatic",
    dueAt: dueAtIso,
    text: title,
    assets: [
      isVideo
        ? { video: { url: fileId } }
        : {
            image: {
              url: /^https?:/.test(fileId) ? fileId : `https://lh3.googleusercontent.com/d/${fileId}`,
              metadata: { altText: title || "Loka" },
            },
          },
    ],
    // TikTok doesn't require an explicit "type" the way Facebook/Instagram do.
  };
  if (process.env.POST_NOW_STORY) { input.mode = "shareNow"; delete input.dueAt; }
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

// If Buffer rejects the story video, post the image instead so the day is not missed.
async function createPostWithFallback(args) {
  try {
    await createPost(args);
  } catch (err) {
    if (args.fileId === STORY_VIDEO_URL && !/limit/i.test(err.message)) {
      console.warn(`Story video was rejected (${err.message}). Posting the image instead.`);
      await createPost({ ...args, fileId: STORY_IMAGE_URL });
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
// After a story is posted now, remove any copy of the same story that is still queued for its normal
// slot, so the story does not go out twice.
async function deleteQueuedStorySlot(channelId, slot) {
  let posts;
  try {
    posts = await getScheduledPosts(channelId);
  } catch (err) {
    console.error(`Could not check queued stories for ${channelId}: ${err.message}`);
    return;
  }
  const dupes = posts.filter((p) => p.id && isStory(p.text) && storySlotForTime(p.dueAt) === slot);
  const mutation = `
    mutation DeletePost($input: DeletePostInput!) {
      deletePost(input: $input) {
        ... on DeletePostSuccess { id }
        ... on VoidMutationError { message }
      }
    }
  `;
  for (const p of dupes) {
    try {
      const data = await bufferRequest(mutation, { input: { id: p.id } });
      if (data.deletePost && data.deletePost.message) throw new Error(data.deletePost.message);
      console.log(`Removed queued copy ${p.id} (${p.dueAt.toISOString()}) so the story is not posted twice.`);
    } catch (err) {
      console.error(`Could not remove queued copy ${p.id}: ${err.message}`);
    }
  }
}

async function postStoryNow() {
  const slot = parseInt(process.env.POST_NOW_STORY, 10);
  const title = storyText(slot);
  console.log(`POST NOW (story slot ${slot}), media: ${storyMedia()}`);
  await createPostWithFallback({ channelId: CHANNEL_ID, fileId: storyMedia(), title, dueAtIso: new Date().toISOString() });
  console.log("POSTED NOW to Loka TikTok");
      await deleteQueuedStorySlot(channelId, slot);
}

async function main() {
  console.log(`Run started ${new Date().toISOString()}${DRY_RUN ? " [DRY RUN]" : ""}`);
  await checkStoryVideo();
  if (process.env.POST_NOW_STORY) { await postStoryNow(); return; }

  const mainTrack = makeTrack(MAIN_INTERVAL_HOURS);
  const promoTrack = makeTrack(PROMO_INTERVAL_HOURS);

  const [mainImages, promoImages] = await Promise.all([
    listDriveImages(MAIN_ROOT_FOLDER_ID),
    PROMO_ROOT_FOLDER_ID ? listDriveImages(PROMO_ROOT_FOLDER_ID) : Promise.resolve([]),
  ]);
  console.log(`MAIN track: ${mainImages.length} images. PROMO track: ${promoImages.length} images.`);

  const limit = await getOrgScheduledPostLimit();
  console.log(`Buffer scheduled-post limit for this channel: ${limit}`);

  const scheduled = await getScheduledPosts(CHANNEL_ID);
  await upgradeQueuedStories(scheduled);
  const storyScheduled = scheduled.filter((p) => isStory(p.text));
  const mainScheduled = scheduled.filter((p) => p.text !== PROMO_CAPTION && !isStory(p.text));
  const promoScheduled = scheduled.filter((p) => p.text === PROMO_CAPTION);
  console.log(
    `Channel ${CHANNEL_ID}: ${scheduled.length}/${limit} total slots used ` +
      `(MAIN: ${mainScheduled.length}, PROMO: ${promoScheduled.length}, STORY: ${storyScheduled.length}).`
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

  // STORY candidates: next empty daily slot on the fixed 11 PM Manila grid.
  const nowStorySlot = Math.max(1, Math.ceil((Date.now() + LEAD_BUFFER_MS - STORY_EPOCH_START.getTime()) / STORY_INTERVAL_MS));
  const latestStorySlot = storyScheduled.length
    ? Math.max(...storyScheduled.map((p) => storySlotForTime(p.dueAt)))
    : -1;
  let nextStorySlot = Math.max(nowStorySlot, latestStorySlot + 1);
  let storyFailed = false;

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
    // With no PROMO images the PROMO track is simply off (never picked).
    const promoCandidateTime = promoImages.length > 0 ? promoTrack.timeForSlotIndex(nextPromoSlot) : new Date(8.64e15);

    // Whichever track's next slot is chronologically earlier goes first —
    // this is what naturally interleaves the two cadences into one queue.
    const useMain = mainCandidateTime.getTime() <= promoCandidateTime.getTime();

    const storyTime = STORY_POSTS.length > 0 && !storyFailed ? storyTimeForSlot(nextStorySlot) : null;
    const useStory = storyTime !== null && storyTime.getTime() < Math.min(mainCandidateTime.getTime(), promoCandidateTime.getTime());

    let fileId, title, dueAt, trackLabel;
    if (useStory) {
      fileId = storyMedia();
      title = storyText(nextStorySlot);
      dueAt = storyTime;
      trackLabel = "STORY";
    } else if (useMain) {
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
      await createPostWithFallback({ channelId: CHANNEL_ID, fileId, title, dueAtIso });
      console.log(`  (${trackLabel})`);
      filled++;
      consecutiveFailures = 0;
    } catch (err) {
      console.error(`Failed to schedule ${trackLabel} slot (${dueAtIso}): ${err.message}`);
      if (trackLabel === "STORY" && !/limit/i.test(err.message)) {
        storyFailed = true;
        console.error("  STORY track paused for the rest of this run.");
        continue;
      }
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

    if (useStory) {
      nextStorySlot++;
    } else if (useMain) {
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
