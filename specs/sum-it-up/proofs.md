# Sum it up! Proofs

Run 2026-10-31 on Chrome for Testing 156 (Playwright 1.64.1), macOS, with a throwaway extension. Panel opening, close, and worker restart were repeated on Chrome 141, and the real build loads there.

## Panel opening

| Case | Result |
|---|---|
| Real click on page, content script message, worker calls `setOptions` and `open` | PASS, panel opens |
| Same, worker stopped first, so the click wakes it | PASS, panel opens |
| Control: content script timer, no click | Refused: "may only be called in response to a user gesture" |
| Control: script-dispatched `.click()` from a timer | Refused, same error |
| Real click, `open` called 8s later | Refused, same error |
| Real toolbar clicks by product owner, 4 opens on one tab | PASS, every `open` succeeded with no `await` before it |
| Second tab while the panel is open on the first | PASS, panel not shown, and no panel ever opened for that tab |
| Real toolbar click on Proof in the extensions menu, panel open | PASS, panel closes. Chrome does it: logs show `onClosed` and no `action.onClicked`. |
| Chrome's panel toggle (`>`) | PASS, panel closes, with no `action.onClicked` |
| Panel calling `sidePanel.close` from a port message | PASS, including after stopping the worker with the panel open, where it reconnects its port |
| Global `setOptions({enabled: false})` at every worker start, with a panel open. Not tested across a real browser restart. | PASS on 156 and 141, open panel stays open and a new tab can still open one |

- FR42 and FR44 hold. No requirement change.
- FR20 cannot work, because a toolbar click with the panel open never reaches the extension. FR20 is removed, and the panel's own button starts a summary. A pinned icon was not tested.
- Playwright's page evaluation counts as a user gesture. Tests that check gestures need timers or real input.
- Page-click cases use Playwright input through DevTools. Toolbar opens use real OS clicks. The close test sends the message directly, because the log from the manual session cannot show which control closed the panel.

## Toolbar icon

Product owner loaded the real build in Chrome and checked the icon by eye: looks right.

## Providers

First run had no account credit and spent no tokens. Second run had credit, on a 1098-word page with a 100-word cap, from the extension worker. Estimated cost: under $0.50.

| Case | Result |
|---|---|
| Worker fetch to all 3 providers | PASS, no CORS failures |
| Anthropic `GET /v1/models` | 200 with or without the browser header |
| Anthropic `POST /v1/messages`, no browser header | 401: "CORS requests must set 'anthropic-dangerous-direct-browser-access' header". Header is required. |
| Anthropic bad key | 401 |
| Anthropic no credit | **400** `invalid_request_error` "Your credit balance is too low" |
| OpenAI `GET /v1/models` and `POST /v1/responses`, fake key | 401. Both endpoints exist. |
| Gemini models and `streamGenerateContent` with `x-goog-api-key`, fake key | **400** `INVALID_ARGUMENT` "API key not valid". Header is read. |
| Anthropic retired model | 404 `not_found_error` |
| Anthropic `thinking: {type: "disabled"}` on Sonnet 5.5 | 400. `between_tools` is the only way to turn thinking off, and it was slower. |
| Claude streaming from the worker | PASS. Text arrives in `content_block_delta` with `text_delta`. Finish is `message_delta` with `stop_reason`, then `message_stop`. |
| Abort mid-stream | PASS, `AbortError` and the partial text is kept |
| OpenAI and Gemini first text time | NOT RUN: deferred by product owner |
| OpenAI and Gemini with valid keys | NOT RUN: deferred by product owner |

### Claude first text time and length

20 runs each unless noted, from this machine, run in sequence. Word counts include bullet markers.

| Model and settings | First text, median | First text, slowest | Words, range |
|---|---|---|---|
| `claude-sonnet-5-5`, effort low | 973ms | 1601ms | 117 to 131 |
| `claude-sonnet-5-5`, effort low, `between_tools` | 1302ms | 1798ms | 91 to 117 |
| `claude-sonnet-5-5`, defaults, 5 runs | 877ms | 1093ms | 125 to 131 |
| `claude-haiku-5-5`, effort low | 899ms | 1264ms | 97 to 120 |
| `claude-opus-5-5`, effort low, 5 runs | 1383ms | 1910ms | 94 to 102 |

A later `claude-haiku-5-5` check at low effort measured 1215 to 3583ms. NFR1 holds for Claude on this page size: every run is under 4s against a 5s limit. Longer pages and other networks are not covered.

A later `claude-haiku-5-5` check at low effort also tried low output limits: `max_tokens` 300 stopped once with no text, and 500 stopped once at 91 words. Thinking counts toward the limit, so the design uses 4000.

### Refusal fallback request

Run 2026-11-01 through the real adapter, from Node on this machine and not the extension worker, with `anthropic-version: 2026-10-21`, effort low, and `max_tokens` 4000. One short question, run twice, because the first run's output was hidden.

| Model | Fallback sent | Result | First text, second run |
|---|---|---|---|
| `claude-sonnet-5-5` | `fallbacks: "default"`, `anthropic-beta: server-side-fallback-2026-07-01` | PASS, accepted, text streamed | 1522ms |
| `claude-opus-5-5` | Same | PASS, accepted, text streamed | 1018ms |
| `claude-haiku-5-5` | None | PASS, text streamed | 1045ms |

- `fallbacks` stays on both models.
- This proves the request is accepted. No refusal was triggered, so a real switch to the fallback model is not proven. A test with a scripted stream covers the event order from the API docs.
- `validateKey` passed with the real key, and a bad key mapped to `auth`.

### Failures and fixes

- P1. Bad Gemini key gives 400, not 401 or 403, so FR46 shows the wrong message. Fix: map Gemini `API_KEY_INVALID` to `auth`.
- P2. No Anthropic credit gives 400, not 429. Fix: map the credit error to `rate`, so the user sees "Provider limit reached". Other providers need the same check with valid keys.
- P3. The design has no `ProviderError.kind` for other 400s. Fix: add a kind and an FR46 row.
- P6. Most runs exceed the 100-word cap with this basic prompt, so NFR4 fails as tested. Fix: tighten the prompts and measure them in the eval. Effort does not fix it.
- P4. The API docs define `stop_reason: "refusal"` with HTTP 200. Neither FR46 nor the design handles it, and the stream finishes normally. Fix: add a kind and an FR46 row. Not triggered in this proof.

## Example: page to summary and chat

Run 2026-11-01 on one test page written for this proof, not a live website. The built `extract.js` ran in headless Chrome. The real adapter then made 3 short `claude-haiku-5-5` calls from Node.

| Part of the page | Sample text | In the extracted text |
|---|---|---|
| Article paragraphs and section headings | "When a forager honeybee finds a rich patch of flowers" | Kept, as 7 paragraphs |
| Site `<nav>` and `<nav>` inside the article | "News", "The dance" link | Removed |
| `.ad-slot`, `<ins class="adsbygoogle">`, `#taboola-below-article` inside the article | "Buy premium bee suits" | Removed |
| Last section titled "12 Comments" | "Bees are overrated" | Removed |
| Site footer | "Copyright 2026" | Removed |

Result: `wordCount` 271, `hasVideo` false, `isPdf` false.

Short summary, 78 words against a cap of 100, 4 bullets against 3 to 5:

> - **Waggle dance:** Forager bees tell nestmates where food is by running in a straight line while shaking their abdomen, then circling back.
> - **Coding:** The run's angle to vertical matches the food's angle to the sun. Run length and waggle time indicate distance, about one second per kilometre.
> - **Adjustment:** Dancers correct the angle over time as the sun moves.
> - **Learning:** A field study found young bees dance less precisely, and precision improves after following experienced dancers, suggesting social learning.

| Chat question | Answer | Calls |
|---|---|---|
| "What does one second of waggling mean?" | "According to the content, about one second of waggling means roughly one kilometre of flight." | 1 |
| "What is the capital of France?" | "This page doesn't cover that" | 1, the model gave the fixed reply |
| "quantum physics?", with the limit set to 300 tokens so the page counts as long | "This page doesn't cover that" | 0 |

- One page and one run. This does not measure word caps or extraction quality across pages, which the eval does.

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

- Track fetch: 0 of 6. Every track URL carries `exp=xpe`. Caption track fetching does not work today.
- Fallback ran 6 of 6 times and returned text 4 of 6 times.
- Both failures have chapters, but chapters are not the proven cause. In the test profile, a real click gives the same result: YouTube's own `get_transcript` call returns 400 and the panel stays empty after 25s. Calling `get_transcript` from the page returned 400 on all 3 videos tried.
- `ytInitialPlayerResponse` is stale after in-page navigation. `#movie_player.getPlayerResponse()` matches the URL.
- Product owner's signed-in Chrome loaded the transcript for `arj7oStGLkU`, so that failure comes from the test profile, not from the video. `8jPQjjsBbIc` was not rechecked.
- Not tested: a video with no captions.

### Outcome

- P5. Track fetch adds no value, so the YouTube read becomes panel only. YouTube is now P1 (see the requirements appendix), so this does not block the first release.
