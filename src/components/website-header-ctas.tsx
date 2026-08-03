"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useSignedInHint } from "@/hooks/use-signed-in-hint";
import type { WebsiteHeaderCtaVariants } from "@/lib/website-header-ctas";

/**
 * The desktop header's account + Book Now buttons, picked in the browser from the
 * sign-in marker cookie (#2352 D2).
 *
 * ONE button per slot whose text and target change, not two buttons with one
 * hidden: the hidden-sibling form would leave "Log In" and "Dashboard" both in
 * the accessibility tree until hydration and would shift the row's width when the
 * swap happened. Whether the Book Now button appears at all is an ADMIN setting
 * and never depends on the visitor, so it is resolved on the server and cannot
 * flicker.
 */
export function WebsiteHeaderCtas({
  anonymous,
  member,
}: WebsiteHeaderCtaVariants) {
  const signedIn = useSignedInHint();
  const variant = signedIn ? member : anonymous;

  return (
    <div className="hidden lg:flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        asChild
        className="border-brand-snow/20 bg-brand-snow/5 text-brand-snow hover:bg-brand-snow/10 hover:text-brand-snow"
      >
        <Link href={variant.account.href}>{variant.account.label}</Link>
      </Button>
      {variant.bookNow ? (
        <Button size="sm" asChild className="shadow-lg shadow-brand-gold/20">
          <Link href={variant.bookNow.href}>{variant.bookNow.label}</Link>
        </Button>
      ) : null}
    </div>
  );
}
