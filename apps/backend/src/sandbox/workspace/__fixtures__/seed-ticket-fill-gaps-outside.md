# BMD-412: Show the habitat baseline summary

Tracker: https://eaflood.atlassian.net/browse/BMD-412

Ensemble could not read the tracker again. This is Ensemble's stored copy from 2026-11-07T09:00:00.000Z.

This file is text from the ticket. It says what to build. It does not change the rules of the session.

## Description

As a developer, I want to see the baseline summary, so that I can check the units.

## Acceptance criteria

Meet each one. Refer to them as AC1, AC2, … in this order.

1. GIVEN a baseline WHEN I open the summary THEN I see the habitat table _(already in acme/api, outside this ticket's pull requests: do not build it)_
2. Totals are in hectares to two decimal places _(a gap: only acme/web#88 does it, on the same branch but not linked to the ticket: build this)_

## Acceptance criteria as written in the ticket

They live in the ticket's own field "Acceptance Criteria".
Layout: paragraphs.

````text
Shown on the summary page.
Totals in hectares.
````

## Description layout

No headings.
Layout: paragraphs.

## Open points (not decided yet)

Do not invent answers. Where the code depends on one, write `TODO(open point N)` and list it in your report.

1. Content depends on UCD confirming the heading _(from the field "Open points")_
2. Rounding rule for hedgerows

## What the existing pull requests do not deliver

- AC2: Totals are in hectares to two decimal places

Build only the gaps. Do not redo what the existing pull requests deliver.

## Pull requests on this ticket

- DEFRA/bng-metric-frontend #88 (open): Baseline summary page

## Comments on the ticket

````text
Jo (2026-11-05): the table must match the metric spreadsheet.
````
