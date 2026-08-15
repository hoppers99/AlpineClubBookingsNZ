- **The diagnostics assistant now neutralises hidden characters in deployed
  source excerpts the same way it already did for every other evidence block
  (#2379).** When an administrator asks the read-only diagnostics assistant to
  explain something, it is shown verbatim excerpts of the deployed code, docs and
  schema as untrusted evidence. Those excerpts — and their file paths and
  labels — were only lightly cleaned: an excerpt could carry an invisible or
  line-break character that a person never sees but a language model reads, and
  use it to disguise a line as if the assistant itself had spoken and granted a
  permission.

  Excerpt text, paths and labels now pass through the same defusal the page,
  tool-result and conversation blocks already use: line breaks and control
  characters are normalised, invisible and look-alike characters are removed or
  folded, and a line that tries to pass itself off as a conversation turn has that
  disguise stripped. Genuine code is untouched — angle brackets, generics and JSX
  in a real excerpt are preserved exactly, because this is the one channel that
  must show source faithfully.

  The frozen instruction the assistant is given also named the source-evidence
  block by the wrong tag, so the one channel with the weakest cleaning was the one
  it was never told to distrust by name. The name is corrected, and a new census
  test now fails the build if any evidence block a renderer emits is ever missing
  from that instruction again.

  No administrator-facing behaviour changes. The gates that decide what the
  assistant may read still live entirely on the server and were never affected;
  this only closes a way that untrusted evidence text could try to influence how
  the assistant reasons about what it was shown.
