# Progress
Round: 4

| Task | Status | Attempts | Last failure |
|------|--------|----------|--------------|
| 1.1 | done | 1 | |
| 1.2 | done | 1 | product owner checked the icon in Chrome |
| 1.3 | blocked | 1 | passes only on a real pull request |
| 1.4 | done | 1 | |
| 1.5 | done | 2 | product owner accepted OpenAI and Gemini as unproven; task moved to Before store release |
| 1.6 | done | 3 | recorded; YouTube moved to P1 |
| F1 | done | 1 | review 1: panel disable lost on browser restart |
| F2 | done | 1 | review 2: coverage skipped tsx |
| F3 | done | 1 | review 6: icon test name overclaimed |
| F4 | done | 1 | review 7: description promised videos |
| F5 | done | 1 | product owner: build output must show in Finder |
| F6 | done | 1 | review r2 1: worker must start on browser restart |
| F7 | done | 1 | verify r2: no test for key file ignore or framework pin |
| F8 | done | 1 | review r2 2 to 6, 9: spec gaps |
| F9 | done | 1 | review r2 7, 8: content entry move, .DS_Store |
| F10 | done | 1 | review r3 1 to 4, 6: spec gaps |
| F11 | done | 1 | review r3 7: color-scheme |
| F14 | done | 1 | review r4 1 to 9: spec text; code had no findings |
| F13 | done | 1 | verify r3: no maxOutput value, first text figure too low |
| F12 | done | 1 | review r3 5: logged close; Chrome closes the panel itself, FR20 removed |

Changed tests:
- 'keeps the side panel disabled until a tab opens it': asserted the install listener, but the setting must apply on every worker start.
- icon test renamed: color type proves an alpha channel, not a transparent background.

Rejected findings:
- review 2, functions threshold: the only uncovered function is the empty content script entry, and the coverage rule is lines and branches.
- review 3, remove web-ext: `npm run dev` uses it to open Chrome with the extension; findings are dev-only and do not reach the build.
