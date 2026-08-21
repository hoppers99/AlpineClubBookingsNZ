- **The file-size check no longer keeps a list, so it stops causing merge
  conflicts (#2979).** The check that stops large source files quietly getting
  larger used to work from a written-down list of every file that was already
  too big, with the length each one was allowed to keep. That list was a real
  file in the repository, and every change that touched one of those files had
  to edit it — so the moment two pieces of work were in progress at once, they
  collided on it. On one day in August, five of nine parallel pieces of work
  were all editing the same list.

  Worse, those collisions had to be resolved by hand, and twice that produced a
  wrong number. In one case two pieces of work each recorded a different allowed
  length for the same file, and whichever was kept was wrong for the file that
  actually resulted. In another, the recorded length was three lines *below*
  what the untouched file already was, so the check would have failed on work
  nobody had done.

  The list is now gone. The check works out how long each file was by reading it
  from `origin/main` when it runs, so there is nothing written down for two
  branches to disagree about. The rule itself has not changed at all: a file
  that was within its budget may not go over it, a file that was already over
  may not grow, and shrinking is always allowed. Two loopholes close as a side
  effect — renaming a file (including from `.ts` to `.js`) no longer leaves its
  allowance behind, and a file that shrinks can no longer creep back up to its
  old size unnoticed.

  For a contributor, the practical effect is that `npm run quality:budget:update`
  is gone, because there is no longer anything to regenerate; a size increase
  that is genuinely necessary is explained in the pull request instead. The
  overall figure the list used to give away — how many files are over budget and
  by how much in total — is now produced on demand by
  `npm run quality:budget -- --report`, and appears in `npm run quality:report`
  as before. The check also measures each file against the point where the
  branch was cut rather than against the tip of `origin/main`, so work is judged
  on what it changed rather than on how far `main` has moved underneath it.
