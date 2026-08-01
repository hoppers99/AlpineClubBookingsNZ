- **"Don't show photos" now genuinely takes committee photos off the public
  website, and a half-finished sign-in can no longer fetch a private member
  photo (#2242).** Three related problems were found on the member-photo and
  stored-image surfaces during the review of the Tokoroa club's copy of the
  system. All three are fixed.

  The committee photo setting on the Page Content and Committee admin screens
  offers "Don't show photos", "Show photos (circular)" and "Show photos
  (square)". Choosing "Don't show photos" took the images off the committee page
  and stopped the club's public data feed mentioning them — but it did **not**
  stop the images themselves being handed out to anyone who asked for them by
  member id. An administrator dealing with a request to take someone's picture
  down would reasonably have believed the picture was no longer public. It now
  is no longer public: the setting stops the image being served to the outside
  world as well as hiding it from the roster. It changes nothing for the member
  themselves or for an administrator with membership access, who both still see
  the photo on their own screens.

  Separately, the part of the system that hands out a private member photo was
  doing its own permission check instead of using the club's shared one. That
  meant it missed two protections everything else applies: someone who had
  entered a correct password but not yet completed their second sign-in step,
  and someone who had been told they must change their password before
  continuing, were both refused everywhere else in the admin area but could
  still fetch private member photos. Both are now refused here too, and — as
  before — the refusal is a plain "not found", so nobody can use this to work
  out which member numbers are real.

  Finally, photographs carry hidden information: most phones record the exact
  location a picture was taken, along with the camera and often the owner's
  name. The club system already removed that from member profile photos, but not
  from images uploaded through the image library, the image manager, or restored
  from a configuration bundle — all of which end up on the public website, in
  some cases cached for a year. Those three now have the same information
  removed before the image is stored. Where an image is unusual enough that the
  system cannot be certain it cleaned it, the upload is still accepted (blocking
  a legitimate club photo would be worse) and a warning is written to the system
  log so an operator can see it. Animated GIFs, AVIF images and SVG drawings have
  no cleaning step available at all, so they are always recorded in that log
  rather than being wrongly reported as cleaned.

  Nothing an administrator does day to day changes, and no existing image is
  altered — the cleaning applies to images uploaded from now on.
