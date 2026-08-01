import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Link to member detail only after membership:view has resolved true.
 * Finance-only subscription viewers still see the member label as plain text,
 * so the UI does not advertise a route their role cannot safely open.
 */
export function MemberDetailLink({
  canViewMembership,
  href,
  className,
  children,
}: {
  canViewMembership: boolean | undefined;
  href: string;
  className?: string;
  children: ReactNode;
}) {
  if (canViewMembership !== true) {
    return <span>{children}</span>;
  }

  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
