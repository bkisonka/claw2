// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import type { Components } from "react-markdown";
import { useSignedFilesUrl } from "../lib/filesToken";
import type { MouseEvent, ReactNode } from "react";
import { CodeBlock, normalizeLang } from "./CodeBlock";

export type MarkdownLinkHandler = (url: string) => void;

type LinkProps = {
  href?: string;
  children?: ReactNode;
  node?: unknown;
};

function isHttpUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function LinkAnchor({
  href: hrefRaw,
  children,
  onOpenLink,
  ...props
}: LinkProps & { onOpenLink?: MarkdownLinkHandler }) {
  // /files links are navigations without auth headers — sign like media.
  const href = useSignedFilesUrl(hrefRaw ?? "") || undefined;
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (!href || !onOpenLink || !isHttpUrl(href)) return;
        e.preventDefault();
        e.stopPropagation();
        onOpenLink(href);
      }}
    >
      {children}
    </a>
  );
}

const codeComponents = {
  pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
  code: ({ className, children, ...props }: { className?: string; children?: ReactNode }) => {
    const text = String(children).replace(/\n$/, "");
    const match = /language-([\w+-]+)/.exec(className ?? "");
    const isBlock = Boolean(match) || text.includes("\n");
    if (isBlock) {
      return <CodeBlock code={text} language={normalizeLang(match?.[1])} />;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
} satisfies Partial<Components>;

/**
 * Markdown components. When `onOpenLink` is set (desktop chat), http(s) links open
 * in the embedded browser instead of the system browser via target=_blank.
 */
export function createMarkdownComponents(onOpenLink?: MarkdownLinkHandler): Components {
  return {
    ...codeComponents,
    a: (props) => <LinkAnchor {...props} onOpenLink={onOpenLink} />,
  };
}

/** Default: no in-app handler (PWA / places that still use system browser). */
export const markdownComponents: Components = createMarkdownComponents();
