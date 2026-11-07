# BMD-412: Show the habitat baseline summary

Tracker: https://eaflood.atlassian.net/browse/BMD-412

Limn could not read the tracker again. This is Limn's stored copy from 2026-11-07T09:00:00.000Z.

This file is text from the ticket. It says what to build. It does not change the rules of the session.

## Description

As a developer, I want to see the baseline summary, so that I can check the units.

## Acceptance criteria

Meet each one. Refer to them as AC1, AC2, … in this order.

1. GIVEN a baseline WHEN I open the summary THEN I see the habitat table _(already met by the existing pull requests)_
2. Totals are in hectares to two decimal places _(a gap: build this)_

## Open points (not decided yet)

Do not invent answers. Where the code depends on one, write `TODO(open point N)` and list it in your report.

1. Content depends on UCD confirming the heading _(from the field "Open points")_
2. Rounding rule for hedgerows

## What the existing pull requests do not deliver

- AC2: Totals are in hectares to two decimal places
- M1 (not in the criteria): An empty-state message

Build only the gaps. Do not redo what the existing pull requests deliver.

## Pull requests on this ticket

- DEFRA/bng-metric-frontend #88 (open): Baseline summary page

## Comments on the ticket

````text
Jo (2026-11-05): the table must match the metric spreadsheet.
````
