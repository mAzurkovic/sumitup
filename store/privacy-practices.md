# Chrome Web Store privacy practices

Paste each answer into the item's **Privacy practices** tab in the Chrome Web Store developer dashboard.

## Single purpose

Sum it up! summarizes the web page or selected text the user asks about, and answers the user's questions about it, with an AI provider the user chooses and pays for with their own API key.

## Permission justifications

**sidePanel**
The summary and chat appear in Chrome's side panel, next to the page they describe.

**storage**
Keeps the user's API key, model, and detail level on the device, and keeps each tab's summaries and chat until the tab closes, so reopening the panel costs no new request.

**scripting**
When the user clicks to summarize, the extension runs a script in that tab to read the page's main text. It runs only on that click.

**Host permission (`<all_urls>`)**
The user can summarize any page they visit, so the extension must be able to read the main text of any page when the user asks. A content script on each page shows the "Sum it up!" button when the user selects 20 or more words. It reads the selection on the device only, and sends nothing until the user clicks.

## Remote code

No, I am not using remote code. All code is in the extension package.

## Data usage

Check these boxes:

- **Website content**: page text and selected text, sent to the provider the user selects, only when the user clicks to summarize or asks a question.
- **Authentication information**: the user's API key, sent only to that provider with each request. It is stored on the device and never sent anywhere else.

Leave all other boxes unchecked.

Check all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Disclosure

Page content goes to the user's selected AI provider (Anthropic) when the user asks for a summary or asks a question. The extension shows this in the panel next to the API key: "Page content is sent to the provider you select. Your key stays on this device."

## Privacy policy URL

https://github.com/mAzurkovic/sumitup/blob/main/store/privacy-policy.md
