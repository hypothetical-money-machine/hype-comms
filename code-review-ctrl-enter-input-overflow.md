# Code review: `t3code/fix-ctrl-enter-input-overflow`

Reviewed 2026-09-01 at xhigh effort. The review target is the uncommitted working-tree change
only: `apps/desktop/src/renderer/src/ai-channel.tsx` and `apps/desktop/src/renderer/src/ai-channel.test.ts`.
`HEAD` (df4b1704) is identical to `origin/main`; the local `main` branch is stale, which is why a
naive `main...HEAD` range diff looked like roughly 59,000 lines. Nothing in this document refers to
that phantom range.

Prettier and ESLint are clean on both changed files, and the full `ai-channel.test.ts` suite passes
at 13 tests. Two of the findings below were confirmed by mutation: the implementation was
deliberately broken, the suite was re-run, and it stayed green. Those are called out explicitly
where they appear.

## What the change does

The composer autosize effect in `AiChannel` was a `useEffect` that reset the textarea's height to
`auto`, measured `scrollHeight`, clamped that between `MIN_COMPOSER_HEIGHT` (48) and
`MAX_COMPOSER_HEIGHT` (180), pinned the result as an inline height, and toggled `overflowY` based on
whether the content exceeded the cap. The change converts it to `useLayoutEffect` and adds scroll
handling on top: before the height is reset, it records whether the caret sits at the very end of the
value, and after the height is pinned it either resets `scrollTop` to zero (when the draft is empty)
or drives `scrollTop` to `scrollHeight` (when the caret was at the end and the content overflows the
cap). The accompanying test renders the channel, stubs `scrollHeight` at 240 and `scrollTop` as a
writable property, fires a twenty-line prompt through `fireEvent.change`, and asserts the resulting
height, overflow, and scroll position.

The intent is right and the `useEffect` to `useLayoutEffect` conversion is a genuine improvement —
the sizing write now happens before paint, so the composer no longer flashes at the wrong height.
The problems are in the scroll logic layered on top of it.

## Finding 1: the scroll jump is only repaired for a caret at the end

`apps/desktop/src/renderer/src/ai-channel.tsx:323`

The root cause of the original bug is line 323, `element.style.height = "auto"`. That line, combined
with the `scrollHeight` read two lines later, forces a synchronous layout in which the textarea is
temporarily tall enough to hold all of its content and therefore not scrollable at all. A
non-scrollable element has exactly one legal scroll position, so the browser clamps `scrollTop` to
zero as part of that layout. Pinning the height back to 180px on line 328 does not restore the old
scroll position, because by then it is gone.

The new code repairs this for exactly one case: the caret at the very end of the value. Every other
editing position is left with the original behavior. Concretely, with a twenty-line prompt whose
`scrollHeight` is 240 against a cap of 180, scrolling down to line 13 and correcting a typo leaves
`cursorIsAtEnd` false, so neither of the two new branches runs. Line 323 collapses the scroll
position, line 328 pins the height back, and the composer renders lines 1 through 8 with the caret
somewhere below the visible band. This repeats on every keystroke, which is the same symptom the
branch name describes.

The fix that covers all cases is to preserve and restore the caller's scroll position around the
measurement, rather than trying to recompute a correct one:

```ts
const element = textarea.current;
if (element === null) return;
const previousScrollTop = element.scrollTop;
const cursorIsAtEnd =
  element.selectionStart === element.value.length &&
  element.selectionEnd === element.value.length;
element.style.height = "auto";
const contentHeight = element.scrollHeight;
const height = Math.min(Math.max(contentHeight, MIN_COMPOSER_HEIGHT), MAX_COMPOSER_HEIGHT);
element.style.height = `${String(height)}px`;
element.style.overflowY = contentHeight > MAX_COMPOSER_HEIGHT ? "auto" : "hidden";
element.scrollTop = cursorIsAtEnd ? element.scrollHeight : previousScrollTop;
```

Restoring `previousScrollTop` handles mid-text editing, the caret-at-end branch still wins where it
applies, and the browser's own clamping handles the empty-draft and under-cap cases without a
special branch. That last point matters for finding 5 below, which this rewrite makes redundant.

## Finding 2: the `cursorIsAtEnd` guard has no effective coverage

`apps/desktop/src/renderer/src/ai-channel.tsx:331`

Mutation-verified. Editing line 331 from `else if (cursorIsAtEnd && element.scrollHeight > MAX_COMPOSER_HEIGHT)`
to `else if (element.scrollHeight > MAX_COMPOSER_HEIGHT)` — that is, deleting the guard the change
exists to introduce — leaves `npx vitest run --root apps/desktop ai-channel.test.ts` reporting 13
passed.

The reason is in the test environment rather than in the test author's intent. happy-dom's
`HTMLTextAreaElement` value setter (`node_modules/happy-dom/lib/nodes/html-text-area-element/HTMLTextAreaElement.js:311-318`)
resets `selectionStart` and `selectionEnd` to the new `value.length` on every value change. Any
`fireEvent.change` therefore leaves the caret at the end by construction, and `cursorIsAtEnd`
evaluates true no matter what the test did beforehand. There is no way to exercise the false branch
through `fireEvent.change` in this environment at all.

The practical consequence is that a future refactor can silently delete the guard, reintroduce
scroll-to-bottom on mid-caret edits, and ship with a green suite. Two ways out. Either drive the
value through a path the effect observes without the selection being reset — which in happy-dom
means setting the value first and the selection second, then triggering a re-render some other way —
or extract the decision into a pure helper such as `shouldScrollToEnd(element, max)` and unit-test it
directly against a hand-built object. The second is more honest about what can actually be asserted
here, and it composes with the shared-helper refactor in finding 4.

## Finding 3: `box-sizing: border-box` under-sizes the content box at the cap boundary

`apps/desktop/src/renderer/src/ai-channel.tsx:329`

`styles.css:46-48` applies `box-sizing: border-box` universally, and `styles.css:5612-5624` gives
`.ai-channel-composer textarea` a `1px` border and `13px` of vertical padding on each side. Under
border-box, the inline `height: 180px` written on line 328 is the border box, so the content box is
180 minus two borders minus 26 of padding.

This creates a boundary case where the composer is genuinely scrollable while the code believes it is
not. When the content height is exactly 154px, the `height: auto` measurement pass reports a
`scrollHeight` of 180 — content plus padding. Line 328 writes `height: 180px`. Line 329 then
evaluates `element.scrollHeight > MAX_COMPOSER_HEIGHT` as `180 > 180`, which is false, so `overflowY`
is set to `hidden`. Line 331 is false for the same reason, so the scroll branch is skipped too. But
the visible content box is now 178 minus 26, or 152px, against 154px of content: the last two pixels
of the caret's line are clipped with no scrollbar and no code path that would scroll to them.

Two ways to close it. Either size against the content plus the chrome, using
`element.scrollHeight + (element.offsetHeight - element.clientHeight)`, or give the composer
textarea `box-sizing: content-box` so the inline height means what the measurement assumed. The
first is self-contained; the second is a smaller diff but leaves a footgun for the next person who
changes the padding.

## Finding 4: `message-composer.tsx` has the same bug and is now divergent

`apps/desktop/src/renderer/src/message-composer.tsx:112-122`

The autosize effect in the main message composer — the one used for every channel and every DM, not
just the Claude channel — is byte-identical to the pre-change `ai-channel.tsx` effect apart from its
constants (`MIN_COMPOSER_HEIGHT` 44 and `MAX_COMPOSER_HEIGHT` 132, declared at
`message-composer.tsx:18-19`). It has the same `height: auto` scroll clamp, so typing a long
multi-line message in an ordinary channel and then editing it mid-text produces the same jump to the
top. This change does not touch it.

Fixing one of two identical copies is the altitude problem here. The scroll-restore logic, the caret
check, and the border-box correction are all the same in both places and all easy to get subtly
wrong; having them exist twice guarantees they drift. The fix belongs in a shared
`autosizeComposer(element, { min, max })` helper, or a `useAutosize(ref, draft, { min, max })` hook,
called from both composers with their own constants. That also gives finding 2 a pure function to
test.

## Finding 5: the empty-draft branch is dead code

`apps/desktop/src/renderer/src/ai-channel.tsx:330`

Mutation-verified. Replacing the condition on line 330 with `if (false)` leaves all 13 tests passing.

The branch cannot do anything. With an empty value, line 323 collapses the element, line 328 pins it
to `MIN_COMPOSER_HEIGHT` at 48px, and `scrollHeight` equals the padding box, so the element is not
scrollable and the browser has already clamped `scrollTop` to zero well before the assignment runs.
There is a second, smaller problem with it: the condition tests React state (`draft === ""`) rather
than the DOM value the surrounding code is manipulating (`element.value === ""`). Those can disagree
during a render where the effect has not caught up, and every other line in the effect reads from
`element`.

Adopting the scroll-restore rewrite in finding 1 removes this branch entirely, which is the right
outcome — the browser's clamping already does the job correctly for every value of the draft.

## Finding 6: the effect keys only on `draft`, so a remount is unsized

`apps/desktop/src/renderer/src/ai-channel.tsx:334`

The dependency array is `[draft]`. The composer is rendered inside the `showConversation` arm of the
status ternary near `ai-channel.tsx:726`, so it unmounts and remounts as the channel's status
changes, while `draft` is preserved in state above it.

The reachable path: type a twenty-line prompt, click "Change folder" (which calls `chooseWorkspace`
and never touches `setDraft`), pick a folder, and the status becomes `configured` so the setup branch
renders and the textarea unmounts. Click "Start Claude", the status becomes `ready`, and the textarea
remounts with the preserved draft still in state. Because `draft` did not change across that
sequence, the effect does not re-run. The fresh element carries `rows={1}` and no inline height, so
the CSS `min-height: 48px` wins and a twenty-line draft renders in a one-line box until the next
keystroke fixes it.

Attaching the sizing to a ref callback rather than an effect solves this cleanly, since the callback
fires on every mount with the live element. Failing that, add a mount signal to the dependency array.

## Finding 7: the new test asserts a scroll position no browser can produce

`apps/desktop/src/renderer/src/ai-channel.test.ts:459`

The assertion is `expect(input.scrollTop).toBe(240)`. A real browser clamps `scrollTop` to
`scrollHeight - clientHeight`, which for the stubbed 240 against a 180px cap is 60. The assertion
only holds because line 450 replaced happy-dom's `scrollTop` accessor with a plain writable data
property that never clamps, so the test observes the raw assignment rather than a scroll position.

This is not merely cosmetic. The test can distinguish "scrolled" from "not scrolled" — changing the
implementation to `element.scrollTop = 0` correctly fails it — but it cannot distinguish a correct
scroll target from a wrong one. `element.scrollTop = element.scrollHeight * 10` fails it too, and any
implementation that lands somewhere near the bottom is indistinguishable from one that overshoots
wildly. Asserting a clamped, browser-realistic position, or better, asserting that the caret's line
falls within the visible band, would test the behavior the test name claims.

## Finding 8: `setSelectionRange` is dead and the second change event is redundant

`apps/desktop/src/renderer/src/ai-channel.test.ts:454`

Line 454 calls `input.setSelectionRange(prompt.length, prompt.length)` and line 455 immediately fires
another change event. For the reason given in finding 2, happy-dom's value setter resets the
selection on that change, so line 455 discards whatever line 454 established. Meanwhile the first
change on line 453 already produces `height: 180px`, `overflowY: auto`, and `scrollTop: 240` on its
own, so lines 454 and 455 contribute nothing to the assertions.

What they do contribute is a misleading signal to the next reader, who will reasonably conclude the
test deliberately places the caret and that the caret-at-end path is therefore covered. It is not.
Worse, the premise is supplied by the fake DOM rather than by the modeled user action: in a real
browser a textarea that has never been focused reports `selectionStart` of 0, while happy-dom's
getter returns `value.length` when unset. The test passes because of a difference between happy-dom
and Chromium, not because of the interaction it describes.

## Finding 9: three forced reflows per keystroke inside a layout effect

`apps/desktop/src/renderer/src/ai-channel.tsx:325, 329, 331`

Line 325 reads `scrollHeight` after the height has been set to `auto`, which forces a layout. Line
328 dirties layout again by writing the pinned height. Lines 329 and 331 then read `scrollHeight`
twice more against that new, pinned layout. Since this now runs in a `useLayoutEffect`, the work
blocks paint on every keystroke.

The value the code actually wants in all three places is the one from line 325 — the true content
height measured with the height released. Hoisting it into a local removes the second forced reflow,
makes the three comparisons agree on a single measurement, and, as a side effect, removes the
border-box inconsistency described in finding 3, because the comparison is then against the measured
content height rather than against the pinned box. The snippet in finding 1 shows the shape.

## Finding 10: the height constants are duplicated in the stylesheet

`apps/desktop/src/renderer/src/ai-channel.tsx:27-28`

`styles.css:5613-5614` hardcodes `min-height: 48px` and `max-height: 180px` on
`.ai-channel-composer textarea`, mirroring the TypeScript constants. Nothing links them. Raising only
the CSS cap to 220px would leave the effect pinning 180px and still deciding `overflowY` against 180,
so the composer would stop growing with no code change to explain why. Deriving one from the other —
a CSS custom property the effect reads, or an inline `maxHeight` written from the constant — restores
the single source of truth that AGENTS.md asks for around contracts elsewhere in the repo.

The same duplication exists for the message composer's 44 and 132, so this is worth folding into the
shared-helper refactor in finding 4 rather than patching in one place.

## Finding 11: renderer change without screenshot evidence

AGENTS.md, under "Renderer review evidence", requires that any change under
`apps/desktop/src/renderer/` or any desktop change that visibly alters the UI be accompanied by a
screenshot, saved as reusable evidence under `docs/screenshots/` and embedded in the pull request's
Screenshots section with a caption. It adds that the screenshot must not be silently omitted or
deferred to review, and that an inability to capture the state should be reported as a blocker.

This change is under `apps/desktop/src/renderer/src/` and visibly changes composer scroll behavior.
`git status --untracked-files=all` lists only the two modified source files, with nothing new under
`docs/screenshots/`. Capturing the overflowing composer with the caret at the end, and ideally the
mid-text editing case once finding 1 is addressed, would satisfy this and would also document the
behavior the tests cannot currently assert.

## Suggested order of work

Findings 1, 3, 5, and 9 are all the same eight lines of code and should be one edit — the snippet
under finding 1 plus the border-box correction resolves all four. Finding 4 then lifts that corrected
block into a shared helper and applies it to `message-composer.tsx`, which is also the natural moment
to address findings 2 and 10, since the helper gives the guard a testable surface and a single place
to own the constants. Finding 6 is independent and small. Findings 7 and 8 are a rewrite of the new
test that should follow whatever shape the helper takes. Finding 11 is the last step before the pull
request.
