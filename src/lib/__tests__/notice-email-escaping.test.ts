import { describe, expect, it } from "vitest";
import { EMAIL_AUDIT_DEFAULTS } from "@/lib/email-message-audit-defaults";
import { plainTextEmailTemplate } from "@/lib/email-templates/layout";
import { renderTemplateString } from "@/lib/email-message-renderer";

// Regression guard for the club-editable "notice-published" email message. The
// admin can override the body, and the token-substitution layer substitutes the
// notice title/URL. A notice title is member-authored free text, so a title like
// `<img onerror=...>` must NEVER reach the rendered email HTML as live markup.
// The override render path is
//   plainTextEmailTemplate(renderTemplateString(bodyText, data))
// exactly as prepareEmailMessage runs it — renderTemplateString does the raw
// {{token}} substitution and plainTextEmailTemplate HTML-escapes every block, so
// the substituted value arrives escaped.
describe("notice-published email token escaping", () => {
  const MALICIOUS_TITLE = '<img src=x onerror="alert(1)">';

  function renderOverrideBody(noticeTitle: string): string {
    const { defaultBody } = EMAIL_AUDIT_DEFAULTS["notice-published"];
    const substituted = renderTemplateString(defaultBody, {
      firstName: "Alex",
      CLUB_NAME: "Alpine Club",
      noticeTitle,
      noticeUrl: "https://club.test/notices/n1",
      BASE_URL: "https://club.test",
    });
    return plainTextEmailTemplate(substituted);
  }

  it("HTML-escapes a malicious {{noticeTitle}} in the rendered email body", () => {
    const html = renderOverrideBody(MALICIOUS_TITLE);

    // The title must never appear as live markup (raw <img ... onerror=...>)...
    expect(html).not.toContain(MALICIOUS_TITLE);
    expect(html).not.toContain("<img src=x onerror=");
    // ...it must arrive fully escaped instead.
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("still renders a benign title as readable text", () => {
    const html = renderOverrideBody("Hut closed this weekend");
    expect(html).toContain("Hut closed this weekend");
  });
});
