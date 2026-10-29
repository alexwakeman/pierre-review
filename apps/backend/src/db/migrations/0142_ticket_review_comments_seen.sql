-- What a ticket review run was given of the ticket's comments: {ids, count, hash} of the people's
-- comments (docs/TRACKERS.md § Ticket comments). NOT part of the run's fingerprint: a new comment never
-- makes a run stale; the state route counts the comments the run did not see.
ALTER TABLE `ticket_reviews` ADD `comments_seen` text;
