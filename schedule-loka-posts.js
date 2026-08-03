/**
 * loka-buffer-scheduler
 * -----------------------------------------------------------------------
 * Evergreen, single-channel (TikTok) Buffer scheduler for the Loka brand.
 *
 * How it works:
 *  1. Lists all images in the Drive root folder, sorted by filename
 *     (q001.png, q002.png, q003.png, ...). This ordered list is the
 *     evergreen content library — it repeats forever once it reaches
 *     the end.
 *  2. Asks Buffer what's already scheduled on the Loka TikTok channel.
 *  3. Fills forward from the latest already-scheduled date (or from
 *     today, if nothing is scheduled yet) up to the channel's live
 *     scheduled-post limit (usually 10 on a free Buffer plan).
 *  4. Mapping rule: the very first time this ever runs, q001 = today,
 *     q002 = tomorrow, etc. Once the library is exhausted, it wraps
 *     back to q001 and keeps going (true evergreen — never runs out).
 *
 * Required environment variables (set as GitHub repo secrets):
 *   BUFFER_API_KEY       Loka's Buffer personal API key
 *   BUFFER_ORG_ID        62d93da01b88d20cfa1863e7
 *   BUFFER_CHANNEL_ID    6a70d99999afb44349f4dcb6  (sira.ulo.siya, TikTok)
 *   GOOGLE_DRIVE_API_KEY Shared Drive API key (same one used by the other repos)
 *   ROOT_FOLDER_ID       1PRW-dm8eEJpS2794W4gjaUENoTn_jnhT
 *
 * Optional:
 *   DRY_RUN=true          Logs planned actions without creating posts
 *   POST_CAPTION          Fixed caption text (defaults to brand name only)
 */

const BUFFER_API_KEY = process.env.BUFFER_API_KEY;
const BUFFER_ORG_ID = process.env.BUFFER_ORG_ID;
const BUFFER_CHANNEL_ID = process.env.BUFFER_CHANNEL_ID;
const GOOGLE_DRIVE_API_KEY = process.env.GOOGLE_DRIVE_API_KEY;
const ROOT_FOLDER_ID = process.env.ROOT_FOLDER_ID;
const DRY_RUN = process.env.DRY_RUN === "true";
const POST_CAPTION = process.env.POST_CAPTION || "Loka";

const BUFFER_GRAPHQL_URL = "https://graph.buffer.com";
const DRIVE_API_URL = "https://www.googleapis.com/drive/v3/files";
const MAX_SCHEDULED_POSTS = 10; // Buffer free-plan cap per channel

function assertEnv() {
  const required = {
    BUFFER_API_KEY,
    BUFFER_ORG_ID,
    BUFFER_CHANNEL_ID,
    GOOGLE_DRIVE_API_KEY,
    ROOT_FOLDER_ID,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

async function bufferGraphQL(query, variables = {}) {
  const res = await fetch(BUFFER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BUFFER_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Buffer API error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// 1. List and sort Drive images (q001.png, q002.png, ...)
async function listDriveImages() {
  const q = encodeURIComponent(
    `'${ROOT_FOLDER_ID}' in parents and mimeType contains 'image/' and trashed = false`
  );
  const fields = encodeURIComponent("files(id,name)");
  const url = `${DRIVE_API_URL}?q=${q}&fields=${fields}&pageSize=1000&key=${GOOGLE_DRIVE_API_KEY}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!json.files) {
    throw new Error(`Drive API error: ${JSON.stringify(json)}`);
  }
  return json.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// 2. Find the latest already-scheduled due date on the Loka TikTok channel
async function getLatestScheduledDate() {
  const query = `
    query GetScheduled($orgId: OrganizationId!, $channelIds: [ChannelId!]) {
      posts(
        input: {
          organizationId: $orgId
          channelIds: $channelIds
          statuses: [SCHEDULED]
        }
        first: 100
      ) {
        edges {
          node {
            dueAt
          }
        }
      }
    }
  `;
  const data = await bufferGraphQL(query, {
    orgId: BUFFER_ORG_ID,
    channelIds: [BUFFER_CHANNEL_ID],
  });
  const dueDates = (data.posts?.edges || []).map((e) => new Date(e.node.dueAt));
  if (!dueDates.length) return null;
  return new Date(Math.max(...dueDates.map((d) => d.getTime())));
}

function countScheduled(latestDate, images) {
  // Approximation: if we know the latest scheduled date, assume one
  // post per day has been scheduled since "today" up to that date.
  if (!latestDate) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((latestDate - today) / 86400000);
  return Math.max(0, diffDays + 1);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function createPost(image, dueAt) {
  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      postCreate(input: $input) {
        post { id dueAt }
      }
    }
  `;
  const input = {
    organizationId: BUFFER_ORG_ID,
    channelId: BUFFER_CHANNEL_ID,
    text: POST_CAPTION,
    media: { photo: image.driveViewUrl },
    scheduling: { type: "SCHEDULED", dueAt: dueAt.toISOString() },
  };
  if (DRY_RUN) {
    console.log(
      `[DRY RUN] Would schedule ${image.name} for ${dueAt.toISOString().slice(0, 10)}`
    );
    return;
  }
  const data = await bufferGraphQL(mutation, { input });
  console.log(
    `Scheduled ${image.name} -> ${data.postCreate.post.dueAt}`
  );
}

async function main() {
  assertEnv();

  const images = await listDriveImages();
  if (!images.length) {
    console.log("No images found in Drive folder. Nothing to do.");
    return;
  }
  console.log(`Found ${images.length} images in the Loka library.`);

  const latestScheduled = await getLatestScheduledDate();
  const alreadyScheduledCount = countScheduled(latestScheduled, images);
  const slotsToFill = MAX_SCHEDULED_POSTS - alreadyScheduledCount;

  if (slotsToFill <= 0) {
    console.log(
      `Channel already has ${alreadyScheduledCount} scheduled posts (limit ${MAX_SCHEDULED_POSTS}). Nothing to add this run.`
    );
    return;
  }

  console.log(
    `${alreadyScheduledCount} already scheduled. Filling ${slotsToFill} more slot(s).`
  );

  const today = new Date();
  today.setHours(9, 0, 0, 0); // default posting time 9am, adjust as needed

  for (let i = 0; i < slotsToFill; i++) {
    const dayOffset = alreadyScheduledCount + i;
    const dueAt = addDays(today, dayOffset);
    // Evergreen wrap-around: cycle through the library forever
    const imageIndex = dayOffset % images.length;
    const image = images[imageIndex];
    image.driveViewUrl = `https://drive.google.com/uc?export=view&id=${image.id}`;
    await createPost(image, dueAt);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
