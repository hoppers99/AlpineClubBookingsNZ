- **Making the public site visible now checks the same three things the setup
  wizard's own button does, not just one of them (#246).** The wizard's
  **Make the public site visible** button was already refused while
  whether this installation is the club's live site or a copy was undeclared,
  a required runtime variable was missing, or the auth secret was too weak —
  but that refusal lived only in the button. A request that reached the
  server directly — a script, or the older **Finish setup** control on the
  Site Style page — could still publish the site with a broken runtime
  environment or a weak auth secret, because the server itself only ever
  checked the first of the three.

  The server now checks all three, in the same order the wizard reports them,
  and refuses with the same explanation the wizard's own **About this
  server** panel gives: who fixes it, and the one line to send them. Nothing
  changes for a club whose deployment is already healthy.
