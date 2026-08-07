- **Contributors can now check a pull request's body before opening it.** Two of the
  automated checks read the pull request's own description rather than the code, and each
  one reports only its first problem — so a description with three formatting mistakes took
  three full rounds of the ~15-minute check suite to discover them all, and editing the
  description does not restart those checks on its own. `npm run pr:check -- <file>` now
  runs both checks against a local file in about a second, reports both at once, and needs
  no network. The failure messages also say what to fix rather than only which field is
  wrong. Nothing about the checks themselves changed, so no existing pull request is
  affected.
