# moms-jar

A digital version of the paper "Mom's Jar": one slip unlocks each day.

This repo and the published site hold no personal content. The deployed app is an empty jar. Slips and photos arrive in a `.jarpack` file made with `builder.html` and loaded onto the phone by hand. `.jarpack` files and `packs/` are gitignored.

- `index.html`: the app (coming in step 3)
- `builder.html`: the page for writing slips and exporting a pack (coming in step 2)
- `logic.js`: all date and unlock math, as plain functions
- The build spec is kept locally, not in this repo.

## Tests

```
node --test
```

## Setup on her phone

To be written once the phone type is known (spec section 10).
