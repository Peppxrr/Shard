# Automatic storage cleanup

Automatic cleanup deletes the oldest ordinary clips when they exceed the
**Keep clips under** limit in Settings → Storage. It can be turned off; older
settings files that used a zero limit for "off" migrate to `autoCleanup: false`.

What counts and what can be deleted:

- Only unprotected replay clips count toward the limit and can be deleted.
  Edited exports are included only when **Include edited clips** is on.
- Favorites and recordings never count and are never deleted automatically.
- Videos of at least a quarter of the limit (5 GB at the default 20 GB) are kept
  separately, so one long replay or import cannot evict many short clips.
- Every saved, imported, or exported video gets 24 hours before it can be
  deleted. Arrival time is stored separately from capture time so old Medal
  imports are not immediately discarded. Existing databases receive a 24-hour
  grace period during migration.
- The five newest managed clips are always kept.
- Cleanup starts only above the actual limit and stops as soon as usage is back
  under it. There is no hidden lower watermark.

Routine growth versus large changes:

- An overage of at most a quarter of the limit is ordinary growth. Saves,
  imports, exports, settings changes, and a five-minute timer trigger a pass
  that deletes the oldest eligible clips until usage is under the limit.
- A larger overage means the library or the limit changed sharply (a lowered
  limit, a bulk import, enabling cleanup on a full library, or files that stayed
  locked for a long time). Cleanup deletes nothing and reports `needs-review`
  with the planned count and bytes. **Clean up now** asks for confirmation and
  sends the confirmed byte amount; the pass is refused if the plan has since
  grown beyond it.
- Unsaved changes to the cleanup settings are previewed against the current
  library ("Saving will delete…") without deleting anything.

Safety mechanics: passes are serialized and drained at shutdown. Each deletion
re-plans from the database, acquires the library path lock, and only proceeds if
the clip is still the first planned removal, so favorites, manual deletions, and
new arrivals during a pass are respected. A busy oldest file stops the pass;
newer files are not substituted. Deletions are bounded by what was added or by
how far the limit was lowered, so retries and restarts cannot multiply damage.

Settings and Capture show managed usage against the limit plus bytes kept
separately. Kept videos still occupy disk space, so total library usage can
exceed the limit. This is not a filesystem quota and does not reclaim space from
active recordings, unindexed files, or caches.

Implementation: `app/src/shared/storage-policy.ts`, `app/src/main/storage.ts`,
and the retention column in `app/src/main/library.ts`. The core receives only
`limitGb`/`clipsDir` and does not delete clips. Verify with
`npm --prefix app run verify -- storage themes`.
