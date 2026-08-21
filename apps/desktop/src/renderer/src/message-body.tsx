import type { User } from "@hype-comms/contracts";
import {
  Children,
  createContext,
  Fragment,
  isValidElement,
  memo,
  useContext,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { segmentMessageBody, type ChannelReferenceTarget } from "./channel-references";
import { useFencedBlockquoteMode } from "./fenced-blockquote-context";
import type { FencedBlockquoteMode } from "./fenced-blockquote-runtime";
import { expandFencedBlockquotes } from "./fenced-blockquotes";
import { segmentMentions } from "./mentions";

interface MarkdownSyntaxNode {
  children?: MarkdownSyntaxNode[];
  type: string;
  value?: string;
}

function remarkLiteralHtml() {
  return (tree: MarkdownSyntaxNode): void => {
    const visit = (node: MarkdownSyntaxNode): void => {
      if (node.type === "html" && node.value !== undefined) node.type = "text";
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

function normalizeHttpsUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizeFragmentUrl(value: string | undefined): string | null {
  return value !== undefined && /^#[a-z0-9][a-z0-9._:-]*$/iu.test(value) ? value : null;
}

function readableText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(readableText).join("");
  if (isValidElement<{ readonly children?: ReactNode }>(node)) {
    return readableText(node.props.children);
  }
  return "";
}

function externalLinkDestination(children: ReactNode, safeUrl: string): ReactNode {
  const label = readableText(children).trim();
  if (normalizeHttpsUrl(label) === safeUrl) return null;
  return <span className="markdown-link-destination"> ({safeUrl})</span>;
}

function mentionChip(text: string, userId: string, key: string): ReactNode {
  return (
    <span key={key} className="mention-chip" data-mention-user-id={userId}>
      {text}
    </span>
  );
}

function annotateMessageText(
  children: ReactNode,
  channels: readonly ChannelReferenceTarget[],
  members: readonly User[],
  onOpenChannel: ((conversationId: string) => void) | undefined,
): ReactNode {
  if (onOpenChannel === undefined && members.length === 0) return children;

  return Children.map(children, (child, childIndex) => {
    if (typeof child !== "string") return child;
    const channelSegments =
      onOpenChannel === undefined
        ? [{ kind: "text" as const, text: child }]
        : segmentMessageBody(child, channels);
    return channelSegments.flatMap((segment, segmentIndex) => {
      const keyPrefix = `${String(childIndex)}-${String(segmentIndex)}`;
      if (segment.kind === "channel") {
        return [
          <button
            key={keyPrefix}
            type="button"
            className="channel-reference"
            onClick={() => onOpenChannel?.(segment.conversationId)}
          >
            {segment.text}
          </button>,
        ];
      }
      return segmentMentions(segment.text, members).map((mentionSegment, mentionIndex) => {
        const key = `${keyPrefix}-${String(mentionIndex)}`;
        return mentionSegment.kind === "mention" ? (
          mentionChip(mentionSegment.text, mentionSegment.userId, key)
        ) : (
          <Fragment key={key}>{mentionSegment.text}</Fragment>
        );
      });
    });
  });
}

const ChannelReferencesEnabledContext = createContext(true);

function ChannelAwareText({
  children,
  channels,
  members,
  onOpenChannel,
}: {
  readonly children: ReactNode;
  readonly channels: readonly ChannelReferenceTarget[];
  readonly members: readonly User[];
  readonly onOpenChannel: ((conversationId: string) => void) | undefined;
}) {
  const referencesEnabled = useContext(ChannelReferencesEnabledContext);
  return annotateMessageText(
    children,
    channels,
    referencesEnabled ? members : [],
    referencesEnabled ? onOpenChannel : undefined,
  );
}

interface MarkdownBodyProps {
  readonly body: string;
  readonly className: string;
  readonly fencedBlockquoteMode?: FencedBlockquoteMode;
  readonly suffix?: ReactNode;
  readonly channels?: readonly ChannelReferenceTarget[];
  readonly members?: readonly User[];
  readonly onOpenChannel?: (conversationId: string) => void;
}

export const MarkdownBody = memo(function MarkdownBody({
  body,
  className,
  fencedBlockquoteMode,
  suffix,
  channels = [],
  members = [],
  onOpenChannel,
}: MarkdownBodyProps) {
  const contextualFencedBlockquoteMode = useFencedBlockquoteMode();
  const renderedBody = expandFencedBlockquotes(
    body,
    fencedBlockquoteMode ?? contextualFencedBlockquoteMode,
  );
  const renderText = (children: ReactNode): ReactNode => (
    <ChannelAwareText channels={channels} members={members} onOpenChannel={onOpenChannel}>
      {children}
    </ChannelAwareText>
  );
  const components: Components = {
    p: ({ children, node, ...props }) => {
      void node;
      return <p {...props}>{renderText(children)}</p>;
    },
    h1: ({ children, node, ...props }) => {
      void node;
      return <h1 {...props}>{renderText(children)}</h1>;
    },
    h2: ({ children, node, ...props }) => {
      void node;
      return <h2 {...props}>{renderText(children)}</h2>;
    },
    h3: ({ children, node, ...props }) => {
      void node;
      return <h3 {...props}>{renderText(children)}</h3>;
    },
    h4: ({ children, node, ...props }) => {
      void node;
      return <h4 {...props}>{renderText(children)}</h4>;
    },
    h5: ({ children, node, ...props }) => {
      void node;
      return <h5 {...props}>{renderText(children)}</h5>;
    },
    h6: ({ children, node, ...props }) => {
      void node;
      return <h6 {...props}>{renderText(children)}</h6>;
    },
    li: ({ children, node, ...props }) => {
      void node;
      return <li {...props}>{renderText(children)}</li>;
    },
    strong: ({ children, node, ...props }) => {
      void node;
      return <strong {...props}>{renderText(children)}</strong>;
    },
    em: ({ children, node, ...props }) => {
      void node;
      return <em {...props}>{renderText(children)}</em>;
    },
    del: ({ children, node, ...props }) => {
      void node;
      return <del {...props}>{renderText(children)}</del>;
    },
    th: ({ children, node, ...props }) => {
      void node;
      return <th {...props}>{renderText(children)}</th>;
    },
    td: ({ children, node, ...props }) => {
      void node;
      return <td {...props}>{renderText(children)}</td>;
    },
    a: ({ children, href, node, ...props }) => {
      void node;
      const linkChildren = (
        <ChannelReferencesEnabledContext.Provider value={false}>
          {children}
        </ChannelReferencesEnabledContext.Provider>
      );
      const fragmentUrl = normalizeFragmentUrl(href);
      if (fragmentUrl !== null) {
        return (
          <a {...props} href={fragmentUrl}>
            {linkChildren}
          </a>
        );
      }
      const safeUrl = normalizeHttpsUrl(href);
      return safeUrl === null ? (
        <span>{linkChildren}</span>
      ) : (
        <a {...props} href={safeUrl} target="_blank" rel="noreferrer noopener">
          {linkChildren}
          {externalLinkDestination(children, safeUrl)}
        </a>
      );
    },
    img: ({ alt, src, title }) => {
      const label = alt?.trim() === "" || alt === undefined ? "Image" : alt;
      const safeUrl = normalizeHttpsUrl(src);
      return safeUrl === null ? (
        <span className="markdown-image-alt" title={title}>
          {label}
        </span>
      ) : (
        <a href={safeUrl} target="_blank" rel="noreferrer noopener" title={title}>
          <span className="markdown-image-alt">{label}</span>
          {externalLinkDestination(label, safeUrl)}
        </a>
      );
    },
  };

  return (
    <div
      className={`${className} markdown-body${suffix === undefined ? "" : " markdown-body-with-suffix"}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkLiteralHtml]}
        skipHtml
        components={components}
      >
        {renderedBody}
      </ReactMarkdown>
      {suffix}
    </div>
  );
});

/**
 * Renders the Markdown message format shared by stored and optimistic messages. Raw HTML remains
 * literal text, remote images become source links without loading, external links remain
 * credential-free HTTPS URLs with visible destinations, and recognized `#channel` references keep
 * their in-app navigation behavior outside links and code spans.
 */
export const MessageBody = memo(function MessageBody({
  body,
  fencedBlockquoteMode,
  suffix,
  channels = [],
  members = [],
  onOpenChannel,
}: {
  readonly body: string;
  readonly fencedBlockquoteMode?: FencedBlockquoteMode;
  readonly suffix?: ReactNode;
  readonly channels?: readonly ChannelReferenceTarget[];
  readonly members?: readonly User[];
  readonly onOpenChannel?: (conversationId: string) => void;
}) {
  return (
    <MarkdownBody
      body={body}
      className="message-body"
      fencedBlockquoteMode={fencedBlockquoteMode}
      suffix={suffix}
      channels={channels}
      members={members}
      onOpenChannel={onOpenChannel}
    />
  );
});
