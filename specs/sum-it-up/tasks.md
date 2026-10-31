# Sum it up! Tasks

Inputs: [design.md](design.md), [requirements.md](requirements.md), [mocks/](mocks/index.html). No code exists yet, so all paths are new and come from design.md. App paths are under `src/`.

Every subtask ships with its Vitest tests unless it names another check.

## 1. Project setup and proofs [serial]

Proofs run first. A failed proof stops the build and goes back to the product owner.

- [ ] 1.1 Scaffold the project: `package.json` with `wxt` pinned exact at 0.21.5, `wxt.config.ts` with `srcDir: "src"`, manifest per design, `tsconfig.json`, `git init`, `.gitignore` including `.env.local`. `npm run build` output loads in Chrome 141+.
- [ ] 1.2 Add `src/lib/theme.css` with the design's variables, `src/assets/logo.svg` copied from `specs/sum-it-up/mocks/logo.svg`, and `scripts/build-icons` for 16, 32, 48, 128px PNGs. Toolbar shows the icon, and the 16px result is reviewed by eye.
- [ ] 1.3 Add `.github/workflows/ci.yml` running `tsc`, Vitest, and `wxt build` on pull requests, with the Playwright step added in 5.2. Workflow passes on a test pull request.
- [ ] 1.4 Prove OQ1 in `specs/sum-it-up/proofs.md`: `sidePanel.open` from a content script message, toolbar open and close with no `await` before `open`, and per-tab enablement. Results recorded, and a failure on FR42 or FR44 stops the build.
- [ ] 1.5 Prove OQ3 and OQ4 in `proofs.md`, using keys from `.env.local`: worker fetch and streaming for all 3 providers, Anthropic browser header, key check by listing models, `x-goog-api-key`, and first text time on the 3 default models. Results recorded, and each failure has a named fix.
- [ ] 1.6 Prove OQ2 in `proofs.md` on 5 live YouTube videos: caption track read after in-page navigation, track fetch, and transcript panel fallback. Results recorded with how often the fallback ran.

## 2. Providers and text tools [parallel]

Subtasks [parallel], except 2.3 runs before 2.4 and 2.5.

- [ ] 2.1 Add `src/lib/models.ts`: the 9 design models, defaults, input limits with Google's from `inputTokenLimit`, per-model thinking and effort settings. Test: each provider has exactly one default.
- [ ] 2.2 Add `src/lib/text.ts`: `countWords`, `estimateTokens`, `splitParagraphs`, `matchParts`. Tests cover the 20-word and 200-word boundaries, no-space languages, and no part dropped by a split.
- [ ] 2.3 Add `src/lib/providers/types.ts` (`ProviderAdapter`, `ProviderError`), `sse.ts`, and `anthropic.ts`. Tests map 401, 403, 429, 5xx, 404, offline, 30s no first text, and a stream with no finish event to the right `kind`.
- [ ] 2.4 Add `src/lib/providers/openai.ts` on `/v1/responses` with `validateKey`. Tests cover text deltas, finish event, and the same error mapping.
- [ ] 2.5 Add `src/lib/providers/gemini.ts` on `streamGenerateContent` with `x-goog-api-key`. Tests cover text deltas, finish event, the same error mapping, and no key in the URL.
- [ ] 2.6 Add `src/lib/prompts.ts`: prompts for Short, Medium, In-depth, ELI5, popup, part summary, merge, and chat, with content in delimiters and closing delimiters escaped. Test: page text cannot close the delimiter.

## 3. Content reading and generation [serial, needs 1 and 2]

- [ ] 3.1 Add `src/lib/session.ts`: `tab:<tabId>` state in `storage.session`, summary cache keyed by URL, scope, level, model, and eviction of least recently used `source`. Tests cover the cache key, eviction keeping summaries and chat, and cleanup.
- [ ] 3.2 Add `src/entrypoints/extract.ts`: Readability on a cloned document, word count, video flag, PDF detection, with Readability out of the content script bundle. Fixture pages return main content without navigation, ads, footers, or comments.
- [ ] 3.3 Add `src/lib/youtube.ts`: `MAIN` world caption read with video ID check, track fetch, transcript panel fallback, per proof 1.6. Tests on saved fixtures return text, no tracks, and read failure.
- [ ] 3.4 Add `src/lib/summarize.ts`: single call, split at 80% of the limit, 3 parts at a time, streamed merge, abort, and no retries. Tests cover confirm threshold, all parts used, one part failing, and partial text kept on abort.
- [ ] 3.5 Add `src/lib/chat.ts`: grounded prompt, `matchParts` above the limit, fixed reply with no call on no match, oldest-first history trim. Tests cover under and over the limit, and no-match makes zero calls.
- [ ] 3.6 Add `src/entrypoints/background.ts` core: `setAccessLevel` on install, key and settings handlers, `panel:<tabId>` and `selection` ports, `tabId` from `sender.tab.id`, abort on disconnect. Tests: keys never reach the `selection` port, and disconnect stores `incomplete` (FR77).

## 4. Worker flows and UI [serial, needs 3]

Build to the mocks. Subtasks 4.3 to 4.5 are [parallel] once 4.6's state type exists.

- [ ] 4.1 Add toolbar and navigation handling to `background.ts`: `action.onClicked` calling `setOptions` and `open` before any `await`, `toolbarClick`, fragment-only URL ignored, reload clears that URL's cache. Tests cover FR57 and FR60 URL cases.
- [ ] 4.2 Add `src/entrypoints/content/`: closed Shadow DOM button and popup, 20-word rule, editable area skip, `isTrusted` check, `textContent` rendering, "More", Esc and outside click. Matches mocks 05 and 06, and a script-dispatched click makes no call.
- [ ] 4.3 Add `Header`, `LevelSelect`, `ModelMenu`, `KeySetup` in `src/entrypoints/sidepanel/`, with labels above dropdowns, `appearance: base-select`, Popover API, masked key, Delete. Matches mocks 01 and 04, including dark theme.
- [ ] 4.4 Add `SummaryCard`, `StatusCard`, `ScopeLink`, `ModelSwitchAction`, `Markdown.tsx`. Matches mocks 03, 07, 08, and a test confirms `Markdown` output has no raw HTML, images, or live links.
- [ ] 4.5 Add `ScrollColumn`, `ChatMessages`, `ChatInput`, summary divider. Matches mocks 02 and 09: box fixed in every state, disabled until a summary is on screen, newest message scrolls into view.
- [ ] 4.6 Add `src/entrypoints/sidepanel/App.tsx`: the 9-state panel reducer, port connection with reconnect, `?tabId=` read, restore on reopen, error banner over an existing summary. Tests cover every transition in the design's state diagram.

## 5. End-to-end tests and release [serial, needs 4]

- [ ] 5.1 Add `tests/fake-provider.ts`, a local server scripting streams and every FR46 failure, and the build variable that points test builds at it. Production build has only the real hosts, confirmed by a test on build output.
- [ ] 5.2 Add `playwright.config.ts` and `tests/e2e/summary.spec.ts`, with `--load-extension`: setup, page summary, levels, cache, Stop, panel close, per-tab, navigation, reload. Tests pass, and the step is added to `ci.yml`.
- [ ] 5.3 Add `tests/e2e/selection-chat.spec.ts`: 20-word rule, popup, "More", no-key flow, scope switch, chat, scrolling, long page confirm. Tests pass.
- [ ] 5.4 Add `tests/e2e/failures-privacy.spec.ts`: every FR46 message and action, FR47, FR48, NFR2, NFR3, and NFR11 with a network log. Tests pass.
- [ ] 5.5 Add `evals/pages.json` (50 pages), 5 prompt injection pages, 20 off-content questions, and `npm run eval` reporting NFR1, NFR4, NFR5 review sheet, NFR10, NFR12, FR64, FR76, 5 live YouTube videos. Report runs with keys from `.env.local`.
- [ ] 5.6 Add `.github/workflows/release.yml` building `wxt zip` on a version tag and attaching it to a GitHub Release, plus `store/` listing text, NFR14 disclosure, and privacy policy. Test tag produces a zip that loads in Chrome.

## Dependencies

- 1 blocks everything. 1.4, 1.5, and 1.6 can change later tasks, so read `proofs.md` before starting 2.
- 2 and 3 share no files, but 3 uses the APIs from 2.
- 3.6 blocks 4.1 and 4.2.
- 4.6 defines the panel state type used by 4.3, 4.4, 4.5, so write that type first.
- 5.1 blocks 5.2, 5.3, 5.4.
- 1.3 is extended by 5.2.

## Open Questions

- OQ1. 1.5 and 5.5 need real API keys for all 3 providers in `.env.local`. Without one, that provider stays unproven. Owner: product owner.
- OQ2. 1.3 and 5.6 need a GitHub repo. Owner: product owner, before 1.3.
