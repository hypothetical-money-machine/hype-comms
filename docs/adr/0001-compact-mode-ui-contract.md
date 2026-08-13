# 1. Compact mode UI contract

- **Status:** Accepted
- **Date:** 2026-08-03

## Context

Hype Comms is a desktop-first chat client. The default shell spends roughly 300 horizontal
pixels on persistent chrome — the workspace rail and the conversation sidebar — that a user
consults intermittently and reads continuously. On a laptop panel, or in a window tiled beside
an editor, that chrome costs more than it returns: message bodies wrap earlier, threads scroll
sooner, and attachments are cropped.

Zen Browser solved the same problem by collapsing its sidebar into a hover-revealed overlay,
keeping the browsing surface content-maximal without removing navigation. The interaction
transfers cleanly to a chat client, where the navigation targets are conversations rather than
tabs, and where the shell is the application rather than one document among many.

Compact mode is also the first shared interaction pattern the Hypothetical Money Machine apps
will implement independently. `hypecreds`, `broker-bot`, and `hmm-write` do not share a
renderer, a component library, or a language runtime with this repository, so the pattern
cannot be shipped as a package. It has to be specified as behavior.

## Decision

Compact mode is a dedicated persisted boolean preference. It is not derived from window size,
theme, or layout density, and it is not stored in renderer-owned state.

The implementation clones the existing theme preference chain, which already carries a
user-owned, main-process-authoritative setting from disk to first paint:

- **Contract.** `packages/contracts/src/compact-mode.ts` exports `compactModePreferenceSchema`
  (`z.boolean()`) and `CompactModePreference`. The shared Zod package remains the source of
  truth for the IPC wire shape.
- **Store.** `CompactModePreferenceStore` writes an atomic JSON file at
  `hype-comms-settings/compact-mode.json` under the Electron user data path, beside `theme.json`.
  Unreadable or invalid content falls back to `false` rather than failing launch.
- **Controller.** `CompactModeController` in the main process owns the resolved value, persists
  changes, and applies the native side effects — notably `setMinimumSize`.
- **IPC.** Three trusted channels, `compact-mode:state`, `compact-mode:set`, and
  `compact-mode:changed`, follow the established request/response plus broadcast shape. The main
  process verifies the sender and re-parses the payload with the contract schema before writing.
- **Pre-paint.** The main process passes the initialized preference to the sandboxed renderer as
  a `webPreferences.additionalArguments` entry, which the preload re-validates and the renderer
  applies as a `data-compact` attribute on `<html>` before React mounts. Asynchronous IPC cannot
  run before first paint, so without this the shell would flash its chrome on every launch.
- **Reveal.** `useCompactChrome` owns hover reveal, a 300 ms hide delay, and a pin counter.
  Chrome-anchored popovers report their open state through `onOpenChange` and hold a pin while
  open, so the sidebar cannot slide away underneath an open menu.

## Cross-app behavior contract

Other Hypothetical Money Machine apps implement compact mode in their own stacks. The
implementation is theirs; the following behavior is not negotiable, because a user who learns
the interaction in one app must not have to relearn it in another.

1. A single root-level attribute or class drives all hiding. Components never decide to hide
   themselves, and never read the preference to do so.
2. Edge hover reveals hidden chrome as an overlay drawn above content. Revealing never reflows,
   resizes, or scrolls the content beneath it.
3. Chrome never auto-hides while a popover, menu, or dialog anchored inside it is open, or while
   focus is inside it. The open/focus signal is explicit, not inferred from hit testing.
4. Hiding is delayed roughly 300 ms after the pointer leaves. Instantaneous hiding flickers on
   the pixel-wide gaps between chrome elements and on diagonal pointer paths.
5. A keyboard shortcut toggles the mode, and the reveal affordance is reachable by keyboard and
   assistive technology: a real `<button>` with an accurate `aria-expanded`, not a bare hover
   region.
6. The preference persists across launches and is applied before first paint. A flash of chrome
   on launch is a defect, not a cosmetic detail.
7. Motion is gated behind `prefers-reduced-motion`. When motion is reduced, the overlay appears
   and disappears without transition, and any animated affordance is replaced by a static one.
8. Activity a user would otherwise miss while chrome is hidden — unread messages, alerts — may
   briefly flash a minimal edge indicator. It must never trigger a full reveal; the application
   does not take the viewport back from the user without input.

## Consequences

- This is the first motion in the Hype Comms renderer. `prefers-reduced-motion` had no
  consumers before compact mode, and every future transition inherits the gating established
  here.
- The window minimum width is relaxed from 960 px to 640 px while compact mode is enabled,
  since the rail and sidebar no longer need room. Leaving compact mode has to widen a window
  the user shrank below 960 px, which is a visible resize the user did not request. That is
  accepted as the cost of allowing genuinely narrow windows.
- Three components — the conversation switcher, workspace search, and the channel create
  popover — grew an optional `onOpenChange` prop. The prop is deliberately generic: it is the
  "chrome-anchored popover" signal from point 3 above, not a compact-mode callback, and any new
  popover placed in the rail or sidebar is expected to emit it.
- The preference chain is now duplicated twice (theme, compact mode). A third persisted
  preference should extract the shared store/controller/IPC shape rather than clone it again.
