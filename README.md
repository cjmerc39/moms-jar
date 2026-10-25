# moms-jar

A digital version of the paper "Mom's Jar". Family members add slips from their phones into a shared bank, and one slip is released to Mom each day.

This repo and the published site hold no personal content. Slips, photos, and names live only in the hosted database (Supabase), protected by the database's own access rules.

- `index.html`: the app (coming in a later step)
- `logic.js`: date and release math, as plain functions
- `config.js`: public Supabase connection settings (no secrets)
- The build spec is kept locally, not in this repo.

## Tests

```
node --test        # date and release math, and config checks
npm run test:db    # privacy tests, against the moms-jar-test project only
```

The privacy tests need a secrets file outside the repo (`~/.moms-jar/test.env`) holding the test project's secret key and database login. Without it they are skipped. They rebuild the test project from `db/migrations` on every run, try every privacy rule through the public API the way someone with browser tools would, and clean up after themselves.

## Privacy

- Who can see what is enforced by the database's own access rules (`db/migrations`), not just by the app.
- A **private** slip is visible only to the person who wrote it, and to Mom once it has been released. Other family members, including the admin, can't see it in the app or by poking at the database through the API. The same goes for its photo.
- Mom sees only slips released to her. Her stars and read flags are visible only to her.
- **The database owner (CJ) could technically see private slips in Supabase's own dashboard**, the way the owner of any database can see what's in it. The app never shows them.

## Setup on phones

To be written once the phone types are known.
