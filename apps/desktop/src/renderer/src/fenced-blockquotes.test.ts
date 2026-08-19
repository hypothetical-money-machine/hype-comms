import { describe, expect, it } from "vitest";

import { expandFencedBlockquotes } from "./fenced-blockquotes";

describe("expandFencedBlockquotes", () => {
  it("leaves both fence styles literal when disabled", () => {
    const source = '"""\nquoted\n"""\n\n>>>\nother\n>>>';
    expect(expandFencedBlockquotes(source, "off")).toBe(source);
  });

  it("expands only the selected double-quote fences", () => {
    expect(
      expandFencedBlockquotes('Before\n\n"""\nFirst\n\n- Second\n"""\n\nAfter', "double-quote"),
    ).toBe("Before\n\n> First\n>\n> - Second\n\nAfter");
    expect(expandFencedBlockquotes(">>>\nOther\n>>>", "double-quote")).toBe(">>>\nOther\n>>>");
  });

  it("expands only the selected greater-than fences", () => {
    expect(expandFencedBlockquotes(">>>\nFirst\n\nSecond\n>>>", "greater-than")).toBe(
      "> First\n>\n> Second",
    );
    expect(expandFencedBlockquotes('"""\nOther\n"""', "greater-than")).toBe('"""\nOther\n"""');
  });

  it("supports multiple fenced quotes", () => {
    expect(expandFencedBlockquotes('"""\nOne\n"""\n\n"""\nTwo\n"""', "double-quote")).toBe(
      "> One\n\n> Two",
    );
  });

  it("leaves unclosed fences literal", () => {
    const source = '"""\nNot closed';
    expect(expandFencedBlockquotes(source, "double-quote")).toBe(source);
  });

  it("does not recognize quote fences inside fenced code", () => {
    const source = '```python\n"""\nA docstring\n"""\n```';
    expect(expandFencedBlockquotes(source, "double-quote")).toBe(source);
  });

  it("does not close a quote on the selected marker inside fenced code", () => {
    expect(
      expandFencedBlockquotes('"""\n```text\n"""\n```\nStill quoted\n"""', "double-quote"),
    ).toBe('> ```text\n> """\n> ```\n> Still quoted');
  });

  it("recognizes indented code fences while looking for the quote closing fence", () => {
    expect(
      expandFencedBlockquotes('"""\n  ```text\n"""\n   ```\nStill quoted\n"""', "double-quote"),
    ).toBe('>   ```text\n> """\n>    ```\n> Still quoted');
  });

  it("does not close a quote on its marker inside a list code fence", () => {
    expect(
      expandFencedBlockquotes('"""\n- ```text\n  """\n  ```\nStill quoted\n"""', "double-quote"),
    ).toBe('> - ```text\n>   """\n>   ```\n> Still quoted');
  });

  it("does not close a quote on its marker inside a nested blockquote code fence", () => {
    expect(
      expandFencedBlockquotes('"""\n> ```text\n> """\n> ```\nStill quoted\n"""', "double-quote"),
    ).toBe('> > ```text\n> > """\n> > ```\n> Still quoted');
  });

  it("preserves CRLF line endings when expanding a quote", () => {
    expect(expandFencedBlockquotes('"""\r\nFirst\r\n\r\nSecond\r\n"""', "double-quote")).toBe(
      "> First\r\n>\r\n> Second",
    );
  });
});
