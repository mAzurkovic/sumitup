# Sum it up! Requirements

Keywords MUST, MUST NOT, SHOULD, MAY per RFC 2119.

UI mocks: [mocks/index.html](mocks/index.html). Mocks validate layout, flow, and wording only. Visual style and UI library are decided at design. Model names and sample text in mocks are placeholders.

## User Stories

- As a reader of long pages, I want a summary in a side panel, so I save reading time.
- As a reader of a dense passage, I want a summary of only the text I highlighted, so I understand that part without leaving it.
- As a reader who wants more or less depth, I want to pick a detail level, so the summary matches the time I have.
- As a reader with follow-up questions, I want to chat about the content, so I understand its concepts.
- As a user paying with my own API key, I want no AI call without my click, so I control my spend.

## Functional Requirements

### Distribution and access

- FR1. Distribution: the extension MUST be published on the Chrome Web Store under the name "Sum it up!", free to install.
- FR2. Accounts: the extension MUST NOT require sign-in, an account, or payment to the developer.
- FR3. AI usage: all AI calls MUST use an API key supplied by the user.

### Provider, model, and key setup

- FR4. Location: all setup and key management MUST live in the side panel. The extension MUST NOT have a separate settings or options page.
- FR5. Providers: the user MUST be able to select Anthropic, OpenAI, or Google Gemini from a provider dropdown at the top of the panel.
- FR6. Models: each provider MUST offer a fixed list of models shipped with the extension, with one marked as default.
- FR7. Model selection: the user MUST be able to switch model from the same dropdown, labeled "Model" outside the dropdown.
- FR8. Persistence: the selected provider and model MUST persist across pages and browser restarts.
- FR9. Multiple keys: the extension MUST store one key per provider, so switching to a provider with a saved key needs no re-entry.
- FR10. No key saved: when the panel opens for a provider with no saved key, the panel MUST show an inline key field, a link to that provider's key page, a notice that page content is sent to the selected provider, and a Save button.
- FR11. Key validation: on Save, the extension MUST validate the key with a test call to the provider.
- FR12. Rejected key: when validation fails, the extension MUST NOT store the key. The panel MUST show the matching FR46 message.
- FR13. After first save: when the key is accepted and a summary was requested, the requested summary MUST start with no further click.
- FR14. Saved key display: a saved key MUST display masked, showing at most its last 4 characters.
- FR15. Key deletion: the user MUST be able to delete a saved key from the dropdown. Deleting the selected provider's key MUST return the panel to the FR10 state.
- FR16. Model switch: switching model MUST NOT regenerate the current summary automatically. It applies to the next generation and to chat answers.
- FR17. Model switch action: after a model switch, the panel MUST show a "Summarize with <model>" button above the current summary.

### Whole page summary

- FR18. Toolbar click, panel closed, no summary for this page: the side panel MUST open on that tab and the summary MUST start.
- FR19. Toolbar click, panel closed, summary exists: the panel MUST reopen with the same summary and chat, with no new API call.
- FR20. Removed. With the panel open, Chrome handles toolbar clicks itself and the extension receives no event. The panel's own "Sum it up" button starts a summary.
- FR21. Toolbar click, panel open: the panel MUST close.
- FR22. Collapse: the chevron in the panel MUST close the panel. Reopening MUST show the same summary and chat with no new API call.
- FR23. Per tab: the panel MUST open only on the tab where the user opened it. Other tabs MUST stay closed until the user opens the panel there.
- FR24. Heading: the panel MUST show "Page summary" for a page summary and "Selected text summary" for a selection summary.
- FR25. Content scope: page summaries MUST use the page's main content. Navigation, ads, footers, and comments MUST be excluded. Test: NFR5.
- FR26. Too little text: when extractable content is under 200 words, the panel MUST show "Not enough text to summarize" and make no API call.
- FR27. Long content: when content exceeds the selected model's input limit, the extension MUST show a confirm prompt with an estimated token count before any API call.
- FR28. Long content confirmed: the extension MUST split the content, summarize all parts, and merge them into one summary.
- FR29. Long content cancelled: the extension MUST make no API call and MUST show a "Sum it up?" button in the panel.
- FR30. Waiting: from click until first text appears, the panel MUST show "Summarizing" with a spinner.
- FR31. Streaming: summary text MUST stream into the panel as it generates.
- FR32. Stop: a Stop button MUST be visible during generation. Clicking it MUST end the generation, keep the text so far, label it "Incomplete", and show a Retry button.
- FR33. PDFs: PDF documents open in Chrome MUST show the FR46 restricted page message.
- FR77. Panel closed during generation: closing the panel MUST end the generation, keep the text so far, and label it "Incomplete". Reopening MUST show that text and a Retry button with no new API call.

### Video

- FR34. YouTube: on a YouTube watch page, the summary MUST use the video's existing transcript or captions.
- FR35. No captions: on a YouTube watch page without captions, the panel MUST show "No transcript available for this video" and make no API call.
- FR36. Other video: on sites with video other than YouTube watch pages, the summary MUST use page text only. The panel MUST show "Video not included in this summary".
- FR37. Video audio and frames MUST NOT be sent to any provider.

### Highlight summary

- FR38. Button: selecting 20 or more words on a page MUST show a small "Sum it up!" button above the selection on all sites.
- FR39. Short selection: selecting under 20 words MUST NOT show the button.
- FR40. Editable areas: the button MUST NOT appear for text in input fields, password fields, or editable areas.
- FR41. Popup: clicking the button MUST open a popup above the selection containing a summary of the selected text only, at most 3 sentences, always at short level.
- FR42. Popup with no key: clicking the button with no saved key MUST open the panel in the FR10 state. After a valid save, the selection summary MUST start.
- FR43. Popup close: Esc or a click outside the popup MUST close it.
- FR44. More: the popup MUST show a "More" link at the bottom. Clicking it MUST open the panel with a selection summary at the panel's current level, and chat scoped to the selection.
- FR45. Switch to page: a selection summary MUST show a "Summarize whole page" link. Clicking it MUST show the page summary, using the cache when one exists. Chat MUST clear when the scope changes between selection and page.

### Failure handling

- FR46. Each failure MUST show this inline message and action in the panel or popup:

| Failure | Message | Action |
|---|---|---|
| Invalid or revoked key (401, 403, or the provider's invalid-key error) | API key rejected | Link opens the provider dropdown |
| Rate limit, quota, or no credit (429, 402, or the provider's out-of-credit error) | Provider limit reached | Retry button |
| Provider down (5xx), no first output within 30s, or cut off before any text | Provider unavailable | Retry button |
| Offline | No connection | Retry button |
| Output cut off mid-stream | Partial text labeled "Incomplete" | Retry button |
| Restricted page (any page Chrome blocks extensions from reading, including chrome://, Chrome Web Store, new tab, PDFs) | Sum it up can't read this page | None |
| Model retired by provider | Model unavailable | Link opens the provider dropdown |
| Provider rejects the request for any other reason (other 4xx) | Provider rejected the request | Retry button |
| Provider declines the content on safety grounds | Provider declined this content | Link opens the provider dropdown |
| YouTube video has caption tracks, but the transcript cannot be read | Couldn't read the transcript | Retry button |

- FR47. Existing content: a failure MUST NOT remove a summary already on screen.
- FR48. Retries: the extension MUST NOT retry any failed call automatically.

### Detail levels

- FR49. Levels: the panel MUST offer a level dropdown with Short, Medium, In-depth, and ELI5, in that order, labeled "Detail level" outside the dropdown.
- FR50. Short: output MUST be 3 to 5 bullets, 100 words max.
- FR51. Medium: output MUST be key points grouped under headings, 300 words max.
- FR52. In-depth: output MUST be a section-by-section summary with key concepts explained, 800 words max.
- FR75. ELI5: output MUST explain the content in everyday words with at least one everyday analogy, 150 words max.
- FR76. ELI5 readability: English ELI5 output MUST score Flesch-Kincaid grade 5 or lower on at least 90% of the NFR4 test set.
- FR53. Default: the first-use level MUST be Short.
- FR54. Remembered level: the last level used MUST persist across pages and browser restarts.
- FR55. Level switch: switching level MUST generate a summary at the new level, unless FR56 applies.
- FR56. Cache: summaries MUST be cached per URL, level, and model until the tab closes. A cached result MUST display with no API call.
- FR57. Reload: reloading a page MUST discard that URL's cached summaries.

### Navigation

- FR58. New page: when the URL changes in a tab with the panel open, the panel MUST clear the summary and chat and show "New page. Sum it up?" with a button, where the summary was.
- FR59. No auto-summary: navigation MUST NOT trigger an API call.
- FR60. What counts: any URL change MUST count as navigation, including single-page app route changes. Changes only to the URL fragment (for example, a table of contents link) MUST NOT count.
- FR61. Panel closed: navigation with the panel closed MUST show nothing on the page.

### Chat

- FR62. Location: a chat text box MUST stay fixed at the bottom of the panel in every panel state and at every detail level.
- FR63. Grounding: chat MUST answer only from the summarized content (page, transcript, or selection).
- FR64. Not covered: a question the content does not cover MUST get the fixed reply "This page doesn't cover that". General-knowledge answers MUST NOT be given. Test: at least 19 of 20 off-content test questions get the fixed reply.
- FR65. History scope: chat history MUST last only for the current page in that tab. It MUST clear on navigation, tab close, and browser restart.
- FR66. No saving: chat history MUST NOT be written to disk.
- FR67. Level change: changing detail level MUST NOT clear chat.
- FR71. Availability: the chat text box MUST be disabled until a summary, complete or labeled "Incomplete", is on screen. Text kept after a provider refusal does not count.
- FR72. Scrolling: the summary and chat messages MUST scroll together as one column in the panel, with no separate scroll area for either.
- FR73. Fixed controls: the panel heading, level dropdown, and model dropdown MUST stay visible while the column scrolls.
- FR74. New messages: each new chat message MUST scroll into view.
- FR78. Long content: when content exceeds the selected model's input limit, chat MUST send only the parts of the original content that best match the question, up to that limit.

### Language

- FR68. Summaries: summaries MUST use the language of the content.
- FR69. Chat: chat answers MUST use the language of the user's question. The FR64 fixed reply is English only.
- FR70. UI: extension UI text MUST be English only in v1.

## Non-Functional Requirements

- NFR1. Performance: first summary text MUST appear within 5s of click at P95, on content under the model's input limit, excluding provider outages.
- NFR2. Performance: panel open and selection button appearance MUST complete within 200ms.
- NFR3. Performance: the extension MUST add no more than 50ms to page load.
- NFR4. Quality: word caps in FR50 to FR52 and FR75 MUST be met on at least 95% of a 50-page test set (Wikipedia, news, blogs, YouTube).
- NFR5. Quality: main content extraction MUST be correct on at least 90% of the same test set, by manual review.
- NFR6. Security: API keys MUST be stored in local browser storage on the device only.
- NFR7. Security: API keys MUST NOT sync across devices or Chrome profiles.
- NFR8. Privacy: page content and keys MUST go only from the extension directly to the selected provider, with no developer-run server in between.
- NFR9. Privacy: the extension MUST NOT include analytics or telemetry.
- NFR10. Privacy: network log during the 50-page test set MUST show requests only to the selected provider, plus YouTube transcript requests on YouTube watch pages.
- NFR11. Privacy: content MUST NOT be sent to any provider before an explicit user click. Test: network log shows zero provider requests during page load, navigation, and text selection.
- NFR12. Security: page content MUST be treated as data, never as instructions. Test: 0 of 5 test pages with embedded instructions change the output's behavior.
- NFR13. Security: model output MUST render as plain formatted text, with no scripts and no auto-loaded remote content.
- NFR14. Compliance: the Chrome Web Store privacy disclosure MUST state that page content goes to the user's selected provider.
- NFR15. Simplicity: every setup control MUST be reachable from the panel's top dropdown, with at most 1 click to open it.

## Appendix: P1 fast follow

Built after the core website use cases ship. Requirements stay as written, and these do not block the first release.

- FR34, FR35: YouTube video summaries from transcripts.
- FR46 row "Couldn't read the transcript".
- YouTube pages in the NFR4 and NFR5 test sets, and YouTube transcript requests in NFR10.
- FR5 and FR9: OpenAI and Google Gemini as providers, the provider dropdown, and one key per provider.

Until then, YouTube pages are treated like other sites with video under FR36: page text only, with "Video not included in this summary". Reason: YouTube already offers its own video summaries.

Until then, Anthropic is the only provider, with one saved key and no provider choice. The FR46 links that open "the provider dropdown" open the top dropdown in the panel, which holds the model and key.

## Out of Scope

- Browsers other than Chrome.
- Developer-hosted AI, accounts, billing, paid tiers.
- Live model lists and custom model IDs.
- Any provider other than Anthropic, OpenAI, Google Gemini.
- PDF summaries.
- Video summaries from audio or frames, and captions on sites other than YouTube.
- Saved summaries or chat history across sessions.
- General-knowledge chat answers.
- Per-site controls for the highlight button.
- UI translation.
- Usage metrics and a summary accuracy target.

## Open Questions

None. Model list and minimum Chrome version are decided in [design.md](design.md).
