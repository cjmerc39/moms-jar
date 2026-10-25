# moms-jar

A digital version of the paper "Mom's Jar". Family members add slips from their phones into a shared bank, and one slip is released to Mom each day.

This repo and the published site hold no personal content. Slips, photos, and names live only in the hosted database (Supabase), protected by the database's own access rules.

- `index.html`: the app (coming in a later step)
- `logic.js`: date and release math, as plain functions
- `config.js`: public Supabase connection settings (no secrets)
- The build spec is kept locally, not in this repo.

## Tests

```
node --test
```

## Privacy

To be written with the access rules (step 3), including a plain statement that the database owner could technically see private slips in Supabase's own dashboard, and that the app never shows them.

## Setup on phones

To be written once the phone types are known.
