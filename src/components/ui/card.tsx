import * as React from "react"

import { cn } from "@/lib/utils"

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-xl border bg-card text-card-foreground shadow",
      className
    )}
    {...props}
  />
))
Card.displayName = "Card"

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-6", className)}
    {...props}
  />
))
CardHeader.displayName = "CardHeader"

/**
 * The level a card title may claim in the page's heading outline.
 *
 * There is deliberately **no default**. A card's correct level depends on the
 * page it sits on — a card that is a page's main section is not the same level
 * as a card nested inside another card's content — and a silently wrong level
 * is worse for a screen-reader user than no heading at all (#2796).
 */
type CardTitleHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

type CardTitleProps = React.HTMLAttributes<HTMLDivElement> & {
  /**
   * Opt in to heading semantics at this exact level, so the title appears in a
   * screen reader's heading list and `getByRole("heading", …)` can find it.
   *
   * Omit it and `CardTitle` renders exactly what it has always rendered: a
   * plain `<div>` with no `role`, no `aria-level`, and the same classes. That
   * default is pinned byte-for-byte by
   * `src/components/ui/__tests__/card-title-heading.test.tsx`.
   *
   * This is the ARIA form (`role="heading" aria-level={n}`) rather than a
   * native `<h2>` on purpose: `.app-theme-scope :is(h1, h2, h3, h4)` in
   * `src/app/globals.css` puts real heading tags on `--font-heading`, and that
   * rule is unlayered, so a native heading inside a card would restyle the
   * title. A `<div>` carrying the role is identical to look at and identical
   * to assistive technology. See `docs/STAGING_ACCESSIBILITY.md` →
   * "#2796 Card Heading Semantics".
   *
   * Pick the level from the page's real outline: find the page `<h1>`, do not
   * skip a level, and go one deeper for a card nested inside another card.
   */
  headingLevel?: CardTitleHeadingLevel
}

const CardTitle = React.forwardRef<HTMLDivElement, CardTitleProps>(
  ({ className, headingLevel, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("font-semibold leading-none tracking-tight", className)}
      {...(headingLevel === undefined
        ? {}
        : { role: "heading", "aria-level": headingLevel })}
      {...props}
    />
  )
)
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0", className)}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
