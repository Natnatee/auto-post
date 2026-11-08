# Worker

Python standard library only. Run from repository root with `python -m worker.main --once`
or `python worker/main.py --once`. Without `--once`, the worker polls continuously.
`--once` still contacts Supabase and can publish if all live gates are enabled; it is
not a dry-run flag. Tests inject mocks and do not contact either service.

Environment:

- `SUPABASE_URL`: HTTPS project origin.
- `SUPABASE_SECRET_KEY`, falling back to `SUPABASE_SERVICE_ROLE_KEY`.
  Opaque keys use `apikey` only; legacy JWT keys also use Bearer authorization.
- `WORKER_MODE`: `simulation` (default) or `live`.
- `POLL_SECONDS`: default 5; `LEASE_SECONDS`: default 300.
- `FACEBOOK_PAGE_ACCESS_TOKEN`: server-side Page access token.
- `FACEBOOK_PAGE_ID`: must match the snapshot destination.
- `FACEBOOK_GRAPH_VERSION`: default `v27.0`.
- `FACEBOOK_LIVE_ENABLED`: only exact `true` enables the live gate; default false.

The persisted snapshot mode is authoritative; the target mode must agree.
Simulation snapshots never sign storage objects or call Facebook, even on live
workers. Live snapshots cannot be simulated by a simulation worker. Legacy jobs
without snapshots can only simulate, never publish. Live dispatch also requires
at least a 120-second lease. Supported snapshot content is text or one unique
JPEG/PNG object (maximum 10 MiB), or one unique MP4 (maximum 2 GiB); repeated
references to the same object are deduplicated. Video-first projects publish only
the MP4 with the caption; companion JPEG/PNG cover/gallery objects remain in the
library and are not attached or used as thumbnails. Multiple videos, unsupported
formats, and multiple distinct images without a video are blocked.
Videos use Page `/videos` with a signed `file_url`; acceptance returns a video ID,
not a guarantee that asynchronous processing is complete.

The worker signs private `social-media` objects for 3600 seconds, never downloads
media, and rejects signed URLs outside the configured HTTPS project origin.
Both HTTP clients refuse redirects, use 20-second timeouts, and bound response
reads to 1 MiB. Credentials, raw Graph bodies and exception bodies are not logged.

## SQL/API contract (migration 006)

`claim_target(p_lease_seconds)` returns a target containing `id`, `lease_token`,
`execution_mode`, and `content_snapshot`. Snapshot schema version 1 contains
`project_id`, `workspace_id`, `title`, `description`, `hashtags`, `price`,
`execution_mode`, `destination` (`platform`, `page_id`, `page_name`), and `assets`
(`id`, `object_path`, `mime_type`, `size_bytes`, `role`, `position`). Object paths
start with an owner UUID, not a URL or bucket prefix.

Immediately before Facebook publication the worker requires literal `true` from
`begin_target_dispatch(p_target_id, p_lease_token)`. SQL must persist dispatch intent
and prevent another claim/publication after ambiguous delivery or lease expiry.
`finish_target` receives exactly these seven parameters:

- `p_target_id`, `p_lease_token`, `p_status`, `p_error`, `p_published_url`
- `p_external_post_id`, `p_delivery_uncertain`

Statuses include `simulated`, `published`, `failed`, and `blocked`. Timeouts, 5xx,
unrecognized Graph errors and malformed success responses are blocked with
`p_delivery_uncertain=true`. Photo success requires `post_id`, not just photo `id`.
There is no automatic publication retry, including after a failed finish call;
server-side lease recovery preserves uncertainty in migration 006. Live remains
disabled pending explicit user content approval; see ../PUBLISHING.md.

Tests: `python -m unittest discover -s tests -p 'worker*test.py' -v`
