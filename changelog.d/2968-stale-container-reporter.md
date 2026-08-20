- New `npm run stale-containers` report names Docker containers an earlier agent
  lane left behind, with the issue each belongs to and whether that issue is
  closed. It never removes anything and has no age rule, so a long-running lane
  cannot lose its database to a timer. It refuses to call anything debris unless
  the name is agent-owned and the number really is a closed issue — a
  pull-request number, a year, a port, an ambiguous name or an unreachable
  GitHub all report as unclassified rather than as safe to remove — and it never
  prints a project-wide teardown for a Compose project that still holds a
  container it is protecting. Lane close-out now includes tearing down the
  Docker infrastructure the lane started. (#2794)
