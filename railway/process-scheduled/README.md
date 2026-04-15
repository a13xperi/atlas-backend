# Scheduled Drafts Railway Cron

Use this directory as the root for a dedicated Railway cron service.

Required variables:
- `PROCESS_SCHEDULED_URL` — full URL for `POST /api/drafts/process-scheduled`
- `CRON_SECRET` — shared secret sent as `X-Cron-Secret`

Recommended API service variable:
- `ENABLE_DRAFT_SCHEDULER=false` — disables the in-process polling loop so only the cron service posts scheduled drafts

Notes:
- Set the Railway service root to `railway/process-scheduled`
- Keep the main API service deployed separately as the always-on web service
- Manual runs of `POST /api/drafts/process-scheduled` must also send the same `X-Cron-Secret` header
