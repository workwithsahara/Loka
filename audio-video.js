"use strict";
/**
 * Audio videos for LAYA / Loka quote images.
 *
 * Turns a Google Drive quote image into a short MP4 that carries the shared
 * audio track (one Drive file for every post), hosts the MP4 on the "media"
 * branch of a GitHub repo, and hands Buffer the public URL.
 *
 * Safe by design: if anything is missing the caller keeps posting the plain image.
 *
 * Env:
 *   AUDIO_VIDEO          "on" to enable (anything else = off, plain images)
 *   AUDIO_FILE_ID        Drive file id of the audio (default: the LAYA track)
 *   GOOGLE_DRIVE_API_KEY Drive API key (the audio and images are link-shared)
 *   MEDIA_REPO           owner/repo that hosts the videos on branch "media"
 *   GITHUB_TOKEN         only needed in the repo that renders (MEDIA_REPO itself)
 *   AUDIO_VIDEO_SECONDS  video length, default 15
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ENABLED = process.env.AUDIO_VIDEO === "on";
const AUDIO_FILE_ID = process.env.AUDIO_FILE_ID || "1ceVmBKxcOI-ZGzm_K1xeUQ2U6KdLnbfR";
const DRIVE_KEY = process.env.GOOGLE_DRIVE_API_KEY || "";
const MEDIA_REPO = process.env.MEDIA_REPO || "workwithsahara/laya-meta-buffer-scheduler";
const MEDIA_BRANCH = "media";
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const SECONDS = parseInt(process.env.AUDIO_VIDEO_SECONDS || "15", 10);
const CAN_RENDER = ENABLED && !!GH_TOKEN && process.env.GITHUB_REPOSITORY === MEDIA_REPO;
const AUDIO_SERVICES = new Set(["tiktok", "instagram", "facebook", "threads"]);

let audioInfo = null; // { path, version }
let branchReady = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function driveMeta(fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=md5Checksum,modifiedTime&key=${DRIVE_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Drive metadata ${fileId}: ${res.status}`);
  return res.json();
}

// Version tag of the audio, so changing the audio file re-renders every video.
async function audioVersion() {
  const m = await driveMeta(AUDIO_FILE_ID);
  return (m.md5Checksum || m.modifiedTime || "v1").replace(/[^a-z0-9]/gi, "").slice(0, 8);
}

function mediaUrl(fileId, version) {
  return `https://raw.githubusercontent.com/${MEDIA_REPO}/${MEDIA_BRANCH}/quotes/${fileId}-${version}.mp4`;
}

// Existence is checked through the GitHub API (one directory listing per run), never by
// requesting the raw URL: raw.githubusercontent.com caches a "not found" answer for a few
// minutes, which would make Buffer fail to fetch a video we have only just uploaded.
let existing = null; // Set of file names already on the media branch
async function loadExisting() {
  if (existing) return existing;
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${MEDIA_REPO}/contents/quotes?ref=${MEDIA_BRANCH}&per_page=1000`, { headers });
  if (res.status === 404) {
    existing = new Set();
  } else if (res.ok) {
    existing = new Set((await res.json()).map((f) => f.name));
  } else {
    throw new Error(`Cannot list the media branch: ${res.status}`);
  }
  return existing;
}
async function videoExists(name) {
  return (await loadExisting()).has(name);
}

async function driveDownload(fileId, dest) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${DRIVE_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Drive download ${fileId}: ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function getAudio() {
  if (audioInfo) return audioInfo;
  const version = await audioVersion();
  const file = path.join(os.tmpdir(), `laya-audio-${version}.mp3`);
  if (!fs.existsSync(file)) await driveDownload(AUDIO_FILE_ID, file);
  audioInfo = { path: file, version };
  return audioInfo;
}

const GH = (p, opts = {}) =>
  fetch(`https://api.github.com/repos/${MEDIA_REPO}${p}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
  });

async function ensureBranch() {
  if (branchReady) return;
  const r = await GH(`/git/ref/heads/${MEDIA_BRANCH}`);
  if (r.status === 404) {
    const base = await GH(`/git/ref/heads/main`);
    if (!base.ok) throw new Error(`Cannot read main branch: ${base.status}`);
    const sha = (await base.json()).object.sha;
    const c = await GH(`/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${MEDIA_BRANCH}`, sha }) });
    if (!c.ok) throw new Error(`Cannot create media branch: ${c.status} ${await c.text()}`);
    console.log("AUDIO VIDEO: created the media branch.");
  } else if (!r.ok) {
    throw new Error(`Cannot read media branch: ${r.status}`);
  }
  branchReady = true;
}

async function uploadVideo(name, buf) {
  await ensureBranch();
  const p = `/contents/quotes/${name}`;
  let sha;
  const ex = await GH(`${p}?ref=${MEDIA_BRANCH}`);
  if (ex.ok) sha = (await ex.json()).sha;
  const body = { message: `Add audio video ${name}`, content: buf.toString("base64"), branch: MEDIA_BRANCH };
  if (sha) body.sha = sha;
  const r = await GH(p, { method: "PUT", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Upload ${name}: ${r.status} ${await r.text()}`);
  (await loadExisting()).add(name);
}

function renderMp4(imgPath, audioPath, outPath) {
  const fade = Math.max(SECONDS - 1.5, 0.5);
  execFileSync(
    "ffmpeg",
    [
      "-y", "-loglevel", "error",
      "-loop", "1", "-i", imgPath,
      "-i", audioPath,
      "-t", String(SECONDS),
      "-vf", "scale='trunc(min(1080,iw)/2)*2':-2,format=yuv420p",
      "-c:v", "libx264", "-tune", "stillimage", "-preset", "veryfast", "-r", "30", "-pix_fmt", "yuv420p",
      "-af", `afade=t=out:st=${fade}:d=1.5`,
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
      "-shortest", "-movflags", "+faststart",
      outPath,
    ],
    { stdio: "inherit" }
  );
}

// Returns the public MP4 URL for a Drive image, rendering it first if this repo is allowed to.
// Returns null when the video is not available yet.
async function getAudioVideoUrl(fileId) {
  if (!ENABLED) return null;
  const audio = await getAudio();
  const name = `${fileId}-${audio.version}.mp4`;
  const url = mediaUrl(fileId, audio.version);
  if (await videoExists(name)) return url;
  if (!CAN_RENDER) return null;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "av-"));
  const img = path.join(tmp, "img");
  const out = path.join(tmp, "out.mp4");
  try {
    await driveDownload(fileId, img);
    renderMp4(img, audio.path, out);
    const buf = fs.readFileSync(out);
    await uploadVideo(name, buf);
    console.log(`AUDIO VIDEO: rendered ${name} (${Math.round(buf.length / 1024)} KB).`);
    return url;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function mustWait(dueAtIso) {
  // If the post is more than 24h away it is better to retry next run than to post a silent image.
  return new Date(dueAtIso).getTime() > Date.now() + 24 * 3600 * 1000;
}

// Used by createPost: swaps a Drive image id for its audio video URL when possible.
async function maybeVideo({ fileId, service, noAudio, dueAtIso }) {
  if (!ENABLED || noAudio || !fileId || typeof fileId !== "string" || /^https?:/.test(fileId)) return fileId;
  if (!AUDIO_SERVICES.has(service)) return fileId;
  let reason = "video not ready yet";
  try {
    const url = await getAudioVideoUrl(fileId);
    if (url) return url;
  } catch (e) {
    reason = e.message;
    console.warn(`AUDIO VIDEO: ${reason}`);
  }
  if (mustWait(dueAtIso)) throw new Error(`AV_NOT_READY: ${reason}`);
  console.warn(`AUDIO VIDEO: ${reason}. Posting the plain image instead.`);
  return fileId;
}

// Swaps already-queued quote IMAGE posts for their audio video, in place (same time, same caption).
// Only touches posts whose image comes from Google Drive and that are due more than 3 hours away.
// Stories, text posts and posts that already carry a video are left alone.
async function swapQueued({ bufferRequest, orgId, channelId, service, dryRun }) {
  if (!ENABLED || !AUDIO_SERVICES.has(service)) return;
  const query = `
    query Posts($organizationId: OrganizationId!, $channelIds: [ChannelId!]) {
      posts(input: { organizationId: $organizationId, filter: { channelIds: $channelIds, status: [scheduled] } }, first: 100) {
        edges { node { id dueAt assets { type ... on ImageAsset { source } } } }
      }
    }`;
  let edges;
  try {
    edges = (await bufferRequest(query, { organizationId: orgId, channelIds: [channelId] })).posts.edges;
  } catch (e) {
    console.warn(`AUDIO VIDEO: could not read queued posts (${e.message}).`);
    return;
  }
  const todo = [];
  for (const { node } of edges) {
    const assets = node.assets || [];
    if (assets.length !== 1 || assets[0].type !== "image") continue;
    const m = /googleusercontent\.com\/d\/([A-Za-z0-9_-]+)/.exec(assets[0].source || "");
    if (!m) continue;
    const due = new Date(node.dueAt);
    if (due.getTime() < Date.now() + 3 * 3600 * 1000) continue;
    todo.push({ id: node.id, due, fileId: m[1] });
  }
  if (todo.length === 0) return;
  console.log(`AUDIO VIDEO: swapping ${todo.length} queued image post(s) for audio videos.`);
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
    }`;
  let done = 0;
  for (const p of todo) {
    try {
      const url = await getAudioVideoUrl(p.fileId);
      if (!url) { console.log(`  Video not ready for post ${p.id}, leaving the image for now.`); continue; }
      const input = { id: p.id, assets: [{ video: { url } }], mode: "customScheduled", schedulingType: "automatic", dueAt: p.due.toISOString() };
      if (service === "instagram") input.metadata = { instagram: { type: "reel", shouldShareToFeed: true } };
      else if (service === "facebook") input.metadata = { facebook: { type: "post" } };
      if (dryRun) { console.log(`  [DRY RUN] Would swap post ${p.id} (${p.due.toISOString()}) to video.`); continue; }
      const data = await bufferRequest(mutation, { input });
      if (data.editPost && data.editPost.message) throw new Error(data.editPost.message);
      done++;
      console.log(`  Swapped post ${p.id} (${p.due.toISOString()}) to video.`);
    } catch (e) {
      console.warn(`  Could not swap post ${p.id}: ${e.message}. It stays as the image.`);
    }
  }
  if (!dryRun) console.log(`AUDIO VIDEO: swapped ${done}/${todo.length}.`);
}

module.exports = { ENABLED, CAN_RENDER, AUDIO_SERVICES, getAudioVideoUrl, maybeVideo, mustWait, swapQueued };
