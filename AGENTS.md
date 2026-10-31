# Co-stroke_Wizard of Oz

This is an independent Node.js prototype, derived from co-Stroke at f17cc2162eeb4f18ea4c471ff38048b94fc816fe.

- Never push to StonesGate604/co-Stroke or deploy/update the original Cloud Run service co-stroke-model.
- Use npm ci --ignore-scripts, npm test, npm run build, npm start. In Windows PowerShell use npm.cmd.
- Preserve src/stroke-format.js, TimelinePlayer and TimelineView semantics where possible.
- No real AI calls, Python model installation, training or LLM integration is needed.
- The old Python model code and documentation remain only as upstream reference.
- Cloud Run must use Firestore; local file snapshots are only for one-process development.
- ACK only after durable transaction; do not auto-rebase stale destructive edits.
- Do not commit session links, .woz-data, .env, *.secret or cloud credentials.
- Cloud backend deployment was deferred by the user on 2026-10-31. Do not deploy it without a new request.
