# Chrome Web Store listing

Paste each field into the item's **Store listing** tab in the Chrome Web Store developer dashboard.

## Name

Sum it up!

## Summary (132 characters max)

Summarize any page or selected text in the side panel, then ask questions about it. Uses your own Anthropic API key.

## Category

Productivity

## Language

English

## Description

Sum it up! summarizes the page you are reading, or the text you select, without leaving the tab.

Page summaries
• Click the toolbar button to open the side panel and get a summary of the page's main content. Navigation, ads, and comments are left out.
• Choose a detail level: Short (3 to 5 bullets), Medium (key points under headings), In-depth (section by section), or ELI5 (everyday words, with an analogy).
• Ask follow-up questions in the chat. Answers come only from the page. If the page does not cover a question, the answer says so.

Selected text
• Select 20 or more words on any page, and a "Sum it up!" button appears.
• Click it for a summary of up to 3 sentences in a small popup, or click More to open the panel with a full summary and chat about the selection.

Your key, your provider
• Sum it up! uses your own Anthropic API key. Anthropic bills you directly for what you use. Claude Haiku 5.5 is the default, and you can switch to Claude Sonnet 5.5 or Claude Opus 5.5.
• Page content is sent to the provider you select, only when you click. Nothing is sent on page load, navigation, or selection.
• Your key stays on this device. There is no Sum it up! server, no account, and no analytics.

Very long pages ask before they spend tokens, and show an estimate first.

Get an API key at console.anthropic.com.

## Privacy policy URL

https://github.com/mAzurkovic/sumitup/blob/main/store/privacy-policy.md

## Images

All files are in `store/images/`. Screenshots and promo tiles are 24-bit PNGs with no alpha channel.

| Dashboard field | File | Size |
|---|---|---|
| Store icon | `store-icon.png` (96×96 artwork with 16px transparent padding) | 128×128 |
| Screenshots, in this order | `screenshot-1-page-summary.png`, `screenshot-2-selection.png`, `screenshot-3-detail-levels.png`, `screenshot-4-models.png`, `screenshot-5-setup.png` | 1280×800 |
| Small promo tile | `promo-small.png` | 440×280 |
| Marquee promo tile | `promo-marquee.png` | 1400×560 |
| Global promo video | None. The field is optional. | |

The screenshots show the real extension, with summary text scripted by the test provider.
