# Sum it up! Proofs

Run 2026-10-31 on Chrome for Testing 156 (Playwright 1.64.1), macOS, with a throwaway extension. Minimum version 141 was not tested directly.

## Panel opening

| Case | Result |
|---|---|
| Real click on page, content script message, worker calls `setOptions` and `open` | PASS, panel opens |
| Same, worker stopped first, so the click wakes it | PASS, panel opens |
| Control: content script timer, no click | Refused: "may only be called in response to a user gesture" |
| Control: script-dispatched `.click()` from a timer | Refused, same error |
| Real click, `open` called 8s later | Refused, same error |
| Toolbar click open, second click close, per-tab behavior | NOT RUN: needs a real toolbar click |

- FR42 and FR44 hold. No requirement change.
- Playwright's page evaluation counts as a user gesture. Tests that check gestures need timers or real input.
- "Real click" here is Playwright input through DevTools. OS-level input is part of the toolbar check.

## Providers

No tokens spent: the Anthropic account has no credit.

| Case | Result |
|---|---|
| Worker fetch to all 3 providers | PASS, no CORS failures |
| Anthropic `GET /v1/models` | 200 with or without the browser header |
| Anthropic `POST /v1/messages`, no browser header | 401: "CORS requests must set 'anthropic-dangerous-direct-browser-access' header". Header is required. |
| Anthropic bad key | 401 |
| Anthropic no credit | **400** `invalid_request_error` "Your credit balance is too low" |
| OpenAI `GET /v1/models` and `POST /v1/responses`, fake key | 401. Both endpoints exist. |
| Gemini models and `streamGenerateContent` with `x-goog-api-key`, fake key | **400** `INVALID_ARGUMENT` "API key not valid". Header is read. |
| Claude streaming, event names, abort, 404 on retired model | NOT RUN: needs credit |
| First text time on default models | NOT RUN: needs credit for Anthropic, keys for OpenAI and Gemini |
| OpenAI and Gemini with valid keys | NOT RUN: deferred by product owner |

### Failures and fixes

- P1. Bad Gemini key gives 400, not 401 or 403, so FR46 shows the wrong message. Fix: map Gemini `API_KEY_INVALID` to `auth`.
- P2. No Anthropic credit gives 400, not 429. Fix: map the credit error to `rate`, so the user sees "Provider limit reached". Other providers need the same check with valid keys.
- P3. The design has no `ProviderError.kind` for other 400s. Fix: add a kind and an FR46 row.
- P4. The API docs define `stop_reason: "refusal"` with HTTP 200. Neither FR46 nor the design handles it, and the stream finishes normally. Fix: add a kind and an FR46 row. Not triggered in this proof.

## YouTube

Signed-out Chromium profile, 5 videos plus 1 in-page navigation.

| Video | Caption tracks | Track fetch (`fmt=json3`) | Transcript panel |
|---|---|---|---|
| `dQw4w9WgXcQ` | 6 | 200, empty | 199 words, 0.5s |
| `arj7oStGLkU` | 50 | 200, empty | Failed |
| `jNQXAC9IVRw` | 2 | 200, empty | 39 words, 0.4s |
| `8jPQjjsBbIc` | 41 | 200, empty | Failed |
| `kJQP7kiw5Fk` | 6 | 200, empty | 653 words, 0.5s |
| In-page navigation to `6hh17h-Wd4Y` | 1 | 200, empty | 6118 words, 0.7s |

- Track fetch: 0 of 6. Every track URL carries `exp=xpe`. The first design step does not work today.
- Fallback ran 6 of 6 times and returned text 4 of 6 times.
- Both failures are videos with chapters. A real click gives the same result: YouTube's own `get_transcript` call returns 400 and the panel stays empty after 25s. Calling `get_transcript` from the page returned 400 on all 3 videos tried.
- `ytInitialPlayerResponse` is stale after in-page navigation. `#movie_player.getPlayerResponse()` matches the URL.
- Not tested: a video with no captions, and a signed-in profile. A signed-out automated profile can change YouTube's behavior.

### Fix needed

- P5. Design step 3 adds no value. Decision needed on whether the panel-only read, which failed on 2 of 5 videos, is enough for FR34.
