# Domain docs

Use this guide when an engineering skill needs domain documentation while exploring the repository.

## Read first

Read `CONTEXT.md` at the repository root. If `CONTEXT-MAP.md` is present, read it first and then
read each context file that applies to the work.

If neither file exists, continue without comment. Do not propose a new file before it is needed.
The `/domain-modeling` skill creates domain documents when a term needs a documented definition.

## Layout

A single-context repository uses:

```text
/
├── CONTEXT.md
└── src/
```

A multi-context repository uses:

```text
/
├── CONTEXT-MAP.md
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    └── billing/
        ├── CONTEXT.md
```

## Vocabulary

Use the terms defined in the relevant `CONTEXT.md` in issue titles, proposals, hypotheses, and
test names. Avoid interchangeable synonyms when the glossary defines one term.

If the glossary has no term for a concept, check whether the project already uses another name.
Otherwise, record the gap for `/domain-modeling`.
