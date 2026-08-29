- **The setup wizard's First Admin step can now create an administrator (#251).**
  A short form beneath the step's check — email, first and last name, and
  whether to send a setup invite — creates the account through the same
  membership API Admin → Members uses, so nothing is stored twice. It is the
  first inline editor in the wizard that CREATES something rather than editing a
  setting the check reports on, and the only one written for the wizard rather
  than lifted from a settings page: the member editor needs a member picked
  before it can show anything, so there was no section to embed.

  The invite is ticked by default on purpose. A new account is created with a
  password nobody knows, so without an invite the person cannot sign in until
  somebody sends one. If the email cannot be sent — mail is often not configured
  yet at this point in setup — you are told so plainly and the account is still
  there; the step's count moves either way, and the step's detail, its badge and
  the rail's percentage catch up the moment the create succeeds.

  Creating an administrator does not tick the step off. **Mark this step done**
  is still the one action that records that a person agreed, as on every other
  inline editor.

  **It does not retire the account the installer created**, and that is
  deliberate rather than unfinished: you are almost certainly signed in as that
  account, so switching it off from inside the wizard would sign you out of the
  wizard. Retire it from Admin → Members once somebody else can get in.

  Handing out administrator access stays a full administrator's decision. A
  membership officer reaches this step — it is a membership step — and is now
  told that in place of a form whose save the API would have refused.

- **The First Admin step no longer claims its default was "set when the site was
  installed" (#251).** The wizard shows one of two sentences on a step nobody has
  confirmed yet, chosen by where the step's facts came from. This step was on the
  wrong one: it promised "check it below, change it if it is wrong" when there was
  nothing below it at all, and the seeded administrator's address and password are
  not a shipped default — they are two of the deployment's own environment
  variables, chosen by whoever installed the site. It now shows the same sentence
  the other deployment-read steps do, which asks you to check the facts are right
  for your club and then confirm.
