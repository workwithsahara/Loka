# loka-buffer-scheduler

Evergreen, TikTok-only Buffer scheduler for the **Loka** brand. Pulls
images from a Google Drive folder (`q001.png`, `q002.png`, ...) and
schedules them one per day, cycling back to `q001` once the library
is exhausted — never runs out, never needs manual top-up.

## Setup (first time only)

### 1. Create the repo the right way
On GitHub: **Add file → Create new file**, and type the FULL path into
the filename box first:

```
.github/workflows/schedule-loka-posts.yml
```

GitHub creates the `.github` and `workflows` folders automatically.
Paste in the workflow content. Commit to `main`.

Repeat **Create new file** (plain filename this time, no folders
needed) for:
- `schedule-loka-posts.js`
- `README.md`

### 2. Add repo secrets
**Settings → Secrets and variables → Actions → New repository secret**,
one at a time:

| Secret | Value |
|---|---|
| `BUFFER_API_KEY` | Loka's Buffer personal API key |
| `BUFFER_ORG_ID` | `62d93da01b88d20cfa1863e7` |
| `BUFFER_CHANNEL_ID` | `6a70d99999afb44349f4dcb6` (sira.ulo.siya, TikTok) |
| `GOOGLE_DRIVE_API_KEY` | the shared Drive API key used across all the other repos |
| `ROOT_FOLDER_ID` | `1PRW-dm8eEJpS2794W4gjaUENoTn_jnhT` |

### 3. Make sure the Drive folder is public-readable
The Drive folder (`1PRW-dm8eEJpS2794W4gjaUENoTn_jnhT`) must be shared
as **"Anyone with the link — Viewer."** An API key can only read
publicly shared files, not private ones.

### 4. Test, then trust it
1. **Actions tab → "Schedule Loka TikTok Posts" → Run workflow**,
   check the `dry_run` box, run. Review the log — it should report
   how many images it found and what it *would* schedule.
2. Run again with `dry_run` unchecked. This is the real run — it
   creates live scheduled posts on Buffer.
3. From here it runs automatically once a day, forever. Add new
   images to the Drive folder any time — no code or secret changes
   needed; the library just gets longer before it wraps around.

## Notes
- Posting time defaults to 9:00 AM (UTC-based day boundary in the
  script). Adjust in `schedule-loka-posts.js` if you want a different
  local time.
- Buffer's free plan caps scheduled posts at ~10 per channel — the
  script reads this live and never over-schedules.
- If TikTok posts start failing, check Buffer's API status page first
  — TikTok occasionally changes upload requirements on their end.
