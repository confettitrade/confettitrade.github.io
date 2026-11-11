# Confetti Simple (desktop): notes for the lead

Branch `site/desktop-simple` (worktree `C:/Users/B/cf_desk`), made from `origin/main` at `f051e8f`.
Not pushed, not published.

## 0. Summary

Desktop Simple brings the Simple view (cream paper, one-look trading) to screens wider than
640px. Same product as phone: three-column layout (coin list, chart+direction, order panel).
Switches automatically based on viewport width; `?mode=simple` forces it at any size.

## 1. Files changed

**simple.css** (+419 lines)
- Added `@media (min-width: 641px)` block with desktop-specific rules
- Three-column layout: `.sm-left` (320px), `.sm-center` (flex), `.sm-right` (400px)
- Hides Pro elements when `[data-mode="simple"]`: header, pts-bar, main, mobileBar, etc.
- Same cream paper look tokens as phone
- Responsive breakpoints: 641px+ shows desktop, ≤640px shows phone

**simple-boot.js** (+12 lines)
- Added `FLAG_DK = 'confetti.trade.simpleDesktopFlag'`
- Desktop defaults to Pro unless `?mode=simple` or a saved choice
- `isDesktop()` helper for 641px+ viewport check
- Phone behavior unchanged

**simple.js** (+385 lines)
- Added `isDesktop()`, `flagDkOf()`, `wantMode()` for desktop detection
- Desktop-specific paint functions: `paintDesktopLeft()`, `paintDesktopCenter()`, `paintDesktopRight()`
- Three-column state in `DK` object (panel, built, R refs)
- `drawChart()` refactored to work with both phone `R.*` and desktop `DK.CR.*` elements
- `loadSparks()` updated to check `DK.R.rows` in addition to `R.rows`
- Desktop order panel, add-money panel with right column
- Escape key closes open panel on desktop
- Resize handler switches between desktop/phone modes dynamically

**trade.html** (and identical **index.html**)
- Updated simple.css tag: removed `media="(max-width: 640px)"`, now loads at all sizes
- Bumped version tags: `simple.css?v=simple5`, `simple-boot.js?v=simple4`, `simple.js?v=simple5`
- Added desktop-only elements: `#smBody`, `#smLeft`, `#smCenter`, `#smRight`, etc.

## 2. The flag

**Desktop Simple flag**: `config.json ui.simpleDesktop`
- `"off"` (default / absent): desktop shows Pro
- `"optin"`: `?mode=simple` opts in, saved choice persists
- `"default"`: desktop defaults to Simple

**Phone Simple flag**: unchanged (`ui.simplePhones`)

To enable desktop Simple site-wide: set `ui.simpleDesktop: "default"` in config.json.

## 3. How to try it

After merging, access via:
- `https://confetti.trade/?mode=simple` on any desktop browser
- A saved choice (from `?mode=simple`) persists in localStorage

## 4. Rollback

Fastest first:
1. `"ui": { "simpleDesktop": "off" }` in config.json (desktop stays Pro)
2. Revert simple.css to phone-only `@media (max-width: 640px)` block
3. Revert all files from this branch

## 5. Checks

| Test | Result |
|------|--------|
| Phone Simple unchanged | ✓ Same as before |
| Desktop Pro unchanged | ✓ Shows dark theme, no Simple |
| Desktop Simple 1440x900 | ✓ Three-column layout, chart renders |
| Desktop Simple 1920x1080 | ✓ Responsive, centered |
| Sparklines load | ✓ All coins show sparklines |
| Chart renders | ✓ Area chart with price line |
| Direction buttons work | ✓ Opens order panel or prompts wallet |
| Resize switches modes | ✓ Crossing 640px triggers re-layout |

## 6. What is left

- Order panel actions require wallet connection (as designed)
- Add Money flow uses same rails as phone (Relay, deBridge)
- Position cards show in left column when a trade is open
- Candles button switches to Pro view (as designed)

## 7. Previews

Included in handoff zip:
- `desktop_home_1440x900.png` - home screen, no coin selected
- `desktop_coin_1440x900.png` - BTC selected, chart visible
- `desktop_home_1920x1080.png` - wider screen
- `desktop_coin_1920x1080.png` - BTC on wider screen
- `phone_home_390x844.png` - phone for comparison
- `phone_coin_390x844.png` - phone coin view for comparison
