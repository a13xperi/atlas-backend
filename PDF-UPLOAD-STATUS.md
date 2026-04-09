# PDF Upload Status

- Checked: 2026-04-09 21:57:32 UTC
- Request: `curl -I https://api-production-9bef.up.railway.app/api/content/upload`
- Result: `404 Not Found`
- Conclusion: The production backend does not currently expose `/api/content/upload`. A `200 OK` or `405 Method Not Allowed` would have indicated the endpoint exists; `404` indicates it is missing from the deployed app.

## Response Headers

```http
HTTP/2 404
access-control-allow-credentials: true
x-railway-cdn-edge: fastly/cache-cph2320020-CPH
content-type: application/json; charset=utf-8
date: Thu, 09 Apr 2026 21:57:32 GMT
etag: W/"8a-MPoiDbWflPXAfIr//VLFh5OfVpA"
server: railway-edge
vary: Origin
x-powered-by: Express
x-railway-edge: railway/europe-west4-drams3a
x-railway-request-id: kHj7808vQOSkn8_5nbOCzg
x-ratelimit-limit: 100
x-ratelimit-remaining: 99
x-ratelimit-reset: 1775771913
x-request-id: c56209cd-f082-47a6-a13c-c8c85fc3e24b
x-cache: MISS
x-cache-hits: 0
x-served-by: cache-cph2320020-CPH
```
