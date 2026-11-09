# PermitZero — Demo Video Review

## 1. Asset

- File: `demo-permitzero/demo-permitzero-subtitled.mp4` (and `demo-permitzero.mp4`).
- Duration: 80 seconds (ffprobe: 80.000s, h264 + aac).
- Subtitles: `demo-permitzero/subtitles.srt` (15 cues).
- Script: `demo-permitzero/SCRIPT.md` (6 scenes).

## 2. Timestamped claims vs implementation

| Time | Subtitle / claim | Source path | Match? |
| --- | --- | --- | --- |
| 00:00–00:08 | "PermitZero. Authority before action. Runtime authorization and transaction control for AI agents." | README.md title | Match |
| 00:08–00:18 | "Sign in with a token. Paste an agent, operator, or approver token. Who you are decides what you may see and do." | `apps/web` auth flow, `apps/api/src` auth | Match (role-based access) |
| 00:18–00:32 | "Good to see you, Jordan. Enforcement health: database up, cache up, queue healthy. Two requests need your decision." | `GET /health/ready`, `apps/web` dashboard | Match (health endpoints exist; "Jordan" is a demo persona) |
| 00:32–00:48 | "New request. Choose a tool, enter the purpose, amount, currency, destination, and agent ID. Then submit for authorization." | `apps/web` new-request form, `POST /v1/actions` | Match |
| 00:48–01:08 | "Action detail. The request is masked for privacy. Policy reasons: amount exceeds limit, dual approval required. Risk signals flagged. Approve to continue." | `apps/api/src/intake.ts`, `packages/policy`, model hints | Match (masking, policy reasons, risk signals are implemented) |
| 01:08–01:20 | "Execution receipt. Verified. Audit-complete, append-only, hash-chained." | `packages/broker`, `verifyAuditChain` | Match |

## 3. Discrepancies / notes

- The video communicates the product and the control-plane framing; it does not demonstrate
  the INV-2042 suspicious-invoice denial path or the broker's permit-rejection cases.
  Those are covered by `DEMO-EXPECTED-RESULTS.md` and unit tests, not by the video.
- The video's "masked for privacy" claim corresponds to redaction in the console; verify
  against `apps/web` action detail rendering before relying on it in a pitch.
- No claim in the video asserts real money movement, certification, or live bank
  connectivity — consistent with the safety boundaries in README §5. Good.
- The video does not show the Meta model being called live; consistent with
  `MODEL_ENABLED=false` default. Do not imply a live Meta call in the demo.
- Subtitles and script are internally consistent with the 80s runtime.

## 4. Recommendations (optional, not required)

- A new, clearly labelled version of the video could add a short segment showing the
  denied/escalated path for INV-2042 and a broker permit-rejection, to demonstrate the
  actual security boundary rather than only the success path. Preserve the originally
  submitted video (`demo-permitzero.mp4` / subtitled) unchanged.
- Keep the demonstration focused on the security innovation; avoid burying it in a
  feature tour.

## 5. Verdict

The submitted video's claims are consistent with the implementation and with the
honest limitations disclosed in README §5 and LIMITATIONS.md. No mismatch found that
requires a correction; the main gap is coverage depth (success path only), not
factual inaccuracy.