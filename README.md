# moms-jar

A digital version of the paper "Mom's Jar". Family members add slips from their phones into a shared bank, and one slip is released to Mom each day.

This repo and the published site hold no personal content. Slips, photos, and names live only in the hosted database (Supabase), protected by the database's own access rules.

- `index.html`: the app (sign-in and the admin's People screen so far)
- `api.js`: the app's only connection to the outside world, the real Supabase project
- `signin.js`: invite link and sign-in helpers, as plain functions
- `logic.js`: date and release math, as plain functions
- `config.js`: public Supabase connection settings (no secrets)
- `db/migrations/`: database tables and access rules, in order
- `supabase/functions/redeem-invite/`: the server function that swaps an invite link for a sign-in
- The build spec is kept locally, not in this repo.

## Tests

```
node --test        # date and release math, and config checks
npm run test:db    # privacy tests, against the moms-jar-test project only
```

The privacy tests need a secrets file outside the repo (`~/.moms-jar/test.env`) holding the test project's secret key and database login. Without it they are skipped. They rebuild the test project from `db/migrations` on every run, try every privacy rule through the public API the way someone with browser tools would, and clean up after themselves.

## Sign-in

Everyone signs in with a personal invite link from the admin, plus a short backup code for when copy and paste doesn't work. There are no passwords, and public sign-ups are switched off. Each device that uses a link gets its own sign-in. Making a new link turns off the old one and signs out every device that used it. The admin's People screen shows how many devices use each link and when they were last active.

## Privacy

- Who can see what is enforced by the database's own access rules (`db/migrations`), not just by the app.
- A **private** slip is visible only to the person who wrote it, and to Mom once it has been released. Other family members, including the admin, can't see it in the app or by poking at the database through the API. The same goes for its photo.
- Mom sees only slips released to her. Her stars and read flags are visible only to her.
- **The database owner (CJ) could technically see private slips in Supabase's own dashboard**, the way the owner of any database can see what's in it. The app never shows them.

## Setup on phones

To be written once the phone types are known.
