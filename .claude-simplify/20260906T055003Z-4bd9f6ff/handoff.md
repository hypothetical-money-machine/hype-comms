Four reviews came back with strong convergence, and one of their headline findings turned out to be wrong on inspection. Here's the handoff.

## What the reviewers agreed on

Three of the four independently landed on the same thing: the extraction stopped one level too low. It pulled out the eight-line measurement body but left the wiring duplicated — each component still declared a size constant, a style constant, a ref callback that autosized, and a `useLayoutEffect` keyed on `[draft]` that autosized again. The refactor removed 8 duplicated lines and added about 12 duplicated ones.

So the main fix is a `useComposerAutosize(draft, size)` hook in `composer-autosize.ts` that owns the ref, the attach-time sizing, the per-edit resize, and the CSS custom properties. It returns `{ ref, assign, style }`. Both components now destructure one hook call instead of hand-wiring five call sites. The repo already exports hooks from non-`use-` files (`fenced-blockquote-context.tsx`, `unread-divider.tsx`), so keeping it in the existing module rather than adding a second file fits.

Alongside that: `composerSizeStyle` now returns `CSSProperties` with an `as CSSProperties` cast, matching the two places the codebase already does this (`theme-designer.tsx:78`, `channel-create-popover.tsx:185`) instead of a bespoke intersection type; the size constants became `as const` literals, which drops the type import at both call sites; the AI composer's style prop moved from the `<textarea>` onto the `.ai-channel-composer-field` wrapper so both components attach the variables at the same level; the border arithmetic got a comment naming the global `border-box` rule as the reason it exists; and the test fixture is parameterized so the third test stops re-inlining the metrics block its own helper already builds, with the unexplained `62` now written as `240 - CLIENT_HEIGHT`.

## The finding I did not apply, and why

Two agents argued forcefully that the whole `composerSizeStyle` plus CSS-variable mechanism is inert scaffolding, since JS writes an explicit in-range `style.height` on every path. One recommended deleting it outright; the other recommended CSS owning the clamp with `getComputedStyle` reading it back.

That's wrong, and the diff hid why. The rule is a _grouped_ selector — `.composer-field > .composer-highlight, .composer-field > textarea` at `styles.css:3987`. The highlight is a plain div that mirrors the draft for mention chips, it is never JS-sized, and `max-height: var(--composer-max-height)` is the only thing capping it. Removing the variables would let it grow past 132px and drag the shared grid row with it. The mechanism stays.

Also skipped, all for stated reasons rather than disagreement: `field-sizing: content` (a genuinely interesting observation — Electron 43 supports it and it would delete this entire module, but it hands pixel heights to the browser and invalidates the new assertions, so it's a behavior change, not cleanup); measuring into an offscreen mirror to generalize `cursorIsAtEnd` into "keep the caret visible" (same reason); a `WeakMap` value-to-height cache to skip redundant runs (goes stale on width changes, and it's an optimization, not a simplification); skipping the trailing `scrollTop` write (no real saving — reading `scrollTop` forces layout too, so the flush happens either way); the hardcoded `48px` on the AI send/cancel buttons at `styles.css:5704` and the `isTimelineAtBottom` duplication at `ai-channel.tsx:81`, both pre-existing and outside the diff; and a shared fake-textarea test helper, which would mean touching `message-read-tracking.test.ts`.

I kept the `composerSizeStyle` unit test that one agent wanted deleted as implementation detail. The variables have no CSS fallback value anywhere, so pinning their names is the only thing connecting the TypeScript to the stylesheet.

## Verification you'll want to run

Bash was denied twice in this session (`npm run typecheck` and a `node -e` read of package.json), so **nothing was compiled, formatted, or tested** — every claim above is from reading code. Please run `npm run format` then `npm run check:fast`.

Two specific things to watch. Prettier's line-breaking on the three-property renamed destructuring in both components is my best guess at its output rather than something I verified, so `format:check` may want a cosmetic adjustment. And the hook's returned ref is typed `RefObject<HTMLTextAreaElement | null>` to keep the existing null guards necessary under typescript-eslint; if `@types/react` 19.2 disagrees on that overload, the fix is local to `composer-autosize.ts:16`.

Behavior should be unchanged throughout. The hook registers its layout effect at the top of each component, so it still runs before the selection-restore effect in `message-composer`; `assign` has primitive dependencies from module constants, so its identity is as stable as the `useCallback([])` it replaced; and the attach-time call is preserved because the AI composer really does unmount its textarea when the channel leaves the ready state, which is what the new remount test covers.
