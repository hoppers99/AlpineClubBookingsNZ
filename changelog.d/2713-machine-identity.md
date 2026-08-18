- **Automated agents now act as their own GitHub account (#2713).** Until now
  every automated session drove GitHub as the repository owner, so a comment
  approving a sensitive change could not be told apart from one an agent had
  written — and the merge gate for money, schema, auth and booking-capacity work
  is exactly such a comment. Agents authenticate as a separate machine account
  from now on, which cannot change branch protection, so an approval is
  identified by who wrote it rather than by what it says.
