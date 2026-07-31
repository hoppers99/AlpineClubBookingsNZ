import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"

vi.setConfig({ testTimeout: 30_000 })

const INCLUDED_DATASETS = [
  ["Members", "src/app/(admin)/admin/members/_components/member-filter-toolbar.tsx"],
  ["Bookings", "src/components/admin/booking-filters.tsx"],
  ["Payments", "src/app/(admin)/admin/payments/page.tsx"],
  ["Subscriptions", "src/app/(admin)/admin/subscriptions/page.tsx"],
  ["Audit Log", "src/app/(admin)/admin/audit-log/page.tsx"],
  ["Reports", "src/app/(admin)/admin/reports/page.tsx"],
  ["Refund Requests", "src/app/(admin)/admin/refund-requests/page.tsx"],
  ["Waitlist", "src/app/(admin)/admin/waitlist/page.tsx"],
  ["Xero Operations", "src/app/(admin)/admin/xero/_components/operations-panel.tsx"],
  ["Xero Inbound Events", "src/app/(admin)/admin/xero/_components/inbound-events-panel.tsx"],
  ["Family Groups", "src/app/(admin)/admin/family-groups/page.tsx"],
  ["Issue Reports", "src/app/(admin)/admin/issue-reports/page.tsx"],
  ["Deletion Requests", "src/app/(admin)/admin/deletion-requests/deletion-requests-client.tsx"],
  ["Membership Cancellations", "src/app/(admin)/admin/membership-cancellations/page.tsx"],
  ["Member Applications", "src/app/(admin)/admin/member-applications/page.tsx"],
  ["Booking Request Approvals", "src/components/admin/booking-requests/booking-approvals-panel.tsx"],
  ["Booking Request Changes", "src/components/admin/booking-requests/booking-change-requests-panel.tsx"],
  ["Public Booking Requests", "src/components/admin/booking-requests/public-booking-requests-panel.tsx"],
  ["Induction Register", "src/components/admin/induction-register-table.tsx"],
  ["Promo Redemptions", "src/app/(admin)/admin/promo-codes/promo-redemptions-panel.tsx"],
  ["Lockers", "src/app/(admin)/admin/lockers/page.tsx"],
] as const

function conditionalAncestor(node: ts.Node): ts.Node | null {
  let current = node.parent
  while (current && !ts.isSourceFile(current)) {
    if (
      ts.isConditionalExpression(current) ||
      ts.isIfStatement(current) ||
      ts.isSwitchStatement(current) ||
      (ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    ) {
      return current
    }
    current = current.parent
  }
  return null
}

describe("admin dataset Reset inventory contract", () => {
  it("keeps the audited inventory explicit", () => {
    expect(INCLUDED_DATASETS).toHaveLength(21)
    expect(new Set(INCLUDED_DATASETS.map(([name]) => name)).size).toBe(21)
    expect(new Set(INCLUDED_DATASETS.map(([, path]) => path)).size).toBe(21)
  })

  it.each(INCLUDED_DATASETS)(
    "%s always renders exactly one shared Reset control",
    (_name, relativePath) => {
      const source = readFileSync(resolve(process.cwd(), relativePath), "utf8")
      const sourceFile = ts.createSourceFile(
        relativePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      )
      const resetControls: ts.JsxSelfClosingElement[] = []
      const legacyClearText: string[] = []

      function visit(node: ts.Node) {
        if (
          ts.isJsxSelfClosingElement(node) &&
          node.tagName.getText(sourceFile) === "DatasetResetButton"
        ) {
          resetControls.push(node)
        }
        if (ts.isJsxText(node) && /^Clear\b/.test(node.getText().trim())) {
          legacyClearText.push(node.getText().trim())
        }
        ts.forEachChild(node, visit)
      }
      visit(sourceFile)

      expect(resetControls, `${relativePath} Reset count`).toHaveLength(1)
      expect(
        conditionalAncestor(resetControls[0]),
        `${relativePath} conditionally hides Reset`,
      ).toBeNull()
      expect(legacyClearText, `${relativePath} retains visible Clear text`).toEqual(
        [],
      )
    },
  )
})
