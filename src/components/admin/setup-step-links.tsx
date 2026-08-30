import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * A readiness check's EXTRA destinations (#221, epic #213 C6).
 *
 * A check carries one `href` — "the settings page for this step" — and that
 * single field serves nineteen of the twenty steps: seventeen name a settings
 * page, and two (`runtime-env`, `feature-flags`) name nothing at all, because
 * there is no screen on which to fix a runtime environment variable. The lodges
 * step is the one it does not serve. It needs a list whose length is the club's
 * own: one link per lodge, into that lodge's own setup flow, so per-lodge
 * completeness is reported separately from the club's without becoming extra
 * steps in the journey.
 *
 * Those three figures are MEASURED by `setup-readiness.test.ts`, not counted by
 * hand. This paragraph said "eighteen of the twenty" until #221's review, and
 * nothing in the suite disagreed with it.
 *
 * ONE component rather than a copy on each surface. The readiness cards
 * (`/admin/setup`) and the wizard's step frame (`/admin/setup/wizard`) render
 * the same checks, and a second copy is how the two would end up disagreeing
 * about where a lodge's setup lives.
 *
 * Renders nothing at all for a check with no extra links, so every other step
 * is untouched by its existence.
 */
export function SetupStepLinks({
  links,
  testId,
}: {
  links: readonly { label: string; href: string }[] | undefined;
  testId?: string;
}) {
  if (!links || links.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" data-testid={testId}>
      {links.map((link) => (
        <li key={link.href}>
          <Button asChild variant="outline" size="sm">
            <a href={link.href}>
              <ExternalLink className="h-4 w-4" />
              {link.label}
            </a>
          </Button>
        </li>
      ))}
    </ul>
  );
}
