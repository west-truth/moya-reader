# Stable seamless comic page flow

The seamless image-archive reader now keeps page shells in normal document flow for the active episode. Already visited images remain mounted and their blob URLs remain valid while that episode is active. Other reader modes keep their existing virtualization.

## Why

The previous reader combined estimated heights, absolute virtual row positions, late image measurements, and a 20-image cache. A successful request or a short animation frame did not prove that the correct image stayed in the correct screen position. A production-data probe with 120 ms endpoint delay found transient row overlaps/gaps even when frame timings looked healthy.

The reference was the page-retention approach in Suwayomi WebUI's `BasePager` and `ReaderVerticalPager`, inspected at commit `637af3c9a0e0bb6883868a56ae630852cf3de9d8`. Mangayomi's page dimension estimates and ordered prefetch were also inspected at `7319eede7428e8ccba8bcf624f823339306bb9c2`. This implementation is independently written; no upstream source was copied.

## Behavior

- Unloaded shells use a fixed viewport-based estimate, independent of images arriving elsewhere.
- Image geometry is decoded before the image is published. Geometry and image state update together.
- A React pre-mutation snapshot captures the first visible page immediately before the DOM changes. The post-mutation correction preserves its screen position, including when the browser clamps the scroll offset after content shrinks. Capturing when a download finishes was too early because a user could scroll before React committed.
- At most three image loads run concurrently. The visible neighborhood determines new work. In-flight work inside the active episode is allowed to complete rather than being repeatedly aborted on every scroll.
- Completed images in the active episode are retained. Once the episode changes, old pages are pruned to the normal cache limit. No full-book prefetch is introduced.
- One failed image displays an inline page error instead of unmounting the entire episode.
- The first viewport measurement does not initiate a competing focal-position restoration.

## Verification

- Fixed-document tests: 26 files, 92 tests passed.
- Web-local checks: typecheck, 143 tests, production build, static artifact verification passed.
- Browser regression: delayed image arrival with 168 position checks; 200-page episode resume at page 80; scrolling beyond the old 20-image cache without removing/reloading the original image; next/previous episode transitions; viewport resize; inline failure; append retention and actual image replacement. Existing text pagination regressions also passed.
- An isolated candidate web container used the production API and the actual “무한의 마법사” content, desktop Chromium at 390×844. API writes were intercepted so the probe did not save reading progress. With 300 ms added to page/resource responses, a 55-down/55-up wheel sequence found no sampled page gaps/overlaps beyond 3 px, no tracked inter-frame page displacement over 450 px (wheel input was 320 px), and no removal of 41 observed images. Metadata requests: 41, cancelled/failed: 0; image requests: 43, cancelled/failed: 0.

## Limits

This intentionally trades memory for stable backward scrolling. The active episode retains visited image URLs and DOM nodes; a very long single episode can consume substantially more memory than the former 20-image cache. Episode changes release old images. These browser checks do not establish stability on every device, external network, or an hours-long session. In particular, the production-data probe measures sampled geometry and mounted images, not subjective smoothness on the user's Chrome session.

## Reader UX follow-up

- Single-page and spread comic modes accept taps in the outer thirds to turn pages; the center third still toggles immersive controls. RTL comics reverse the visual tap direction. Pinch/zoom, drags, controls, and continuous scrolling keep their existing behavior.
- The comic footer exposes previous/next episode buttons alongside a draggable per-episode seek bar. On mobile the episode buttons collapse to icon-sized controls.
- Comic page modes can use instant, short slide, or book-style transitions. Continuous modes do not animate page changes, so the stabilized scroll path does not gain per-frame work.
- Paginated text can render one page, two pages above 760 px, or automatically use two pages above 1100 px. A turn advances or reverses a full spread. Narrow screens fall back to one page without changing the saved preference.
- The text reader adds an optional book-style transition and preserves the existing instant and smooth choices. Both readers honor reduced-motion preferences.
- Browser regression covers text spread adjacency and reverse turns, narrow-screen fallback, mobile comic tap turns, footer episode navigation, delayed image geometry (168 checks, no anomalies), and the previous long-comic retention/replacement cases.
