# iOS conversation regression investigation

Investigated against main `d53cfdf12` (TestFlight 1.0.15 build 23).

## Confirmed findings

- **Cloud queue controls were lost between release and main.** Release commit
  `3e42a644c` added Cloud rows, reorder and steer to the native queue sheet. The saved
  build-21 release branch contains them. Main's later conversation integration at
  `f4e404909` has an environment-only queue sheet and explicitly admits Cloud submissions
  into the transcript. The release branch is not an ancestor of main; comparing only
  main's commits misses shipped behavior. `d53cfdf12` restores the Cloud queue path.
- **The new-thread model button became plain text.** `c6d062493` consolidated composer
  options and removed the direct model picker. `d53cfdf12` gives both composers the same
  settings sheet, including Save and Cancel.
- **The diff bubble remains connected.** It counts file-change items, shows additions
  and deletions, and opens `AgentThreadChangesView`. The user confirmed it remains visible.

## Working orb was a web feature

The user clarified that the remembered orb was on the web client. Commit `5efd4f45f`
introduced that control there. The native conversation had an arrow-only return-to-latest
button, so this was a difference between clients, not an iOS regression.

The change prepared for 1.0.16 build 24 adds an activity-aware native return-to-latest button using synchronized
run state. Queued/waiting or disconnected runs do not claim active progress. The still orb
does not schedule continuous redraws. Existing scroll-follow behavior is retained.
The composer opens model settings through its model name; the environment browser is
available in the thread menu. The separate settings and browser toolbar buttons are removed.

## Verification gap

The native conversation UI tests had no positive assertion for a working return-to-latest
control. Their model-picker checks still expected the former immediate-selection menu.
The focused tests now cover working/idle return-to-latest, coexistence with the diff bubble,
and the new settings sheet's Save/Cancel and favourites paths.

The iOS simulator build-for-testing passed, and all seven selected
`PathwayThreadActivityTests` methods passed. The user asked to skip simulator UI checks,
so the interaction tests have not been run.

This investigation covers the reported native conversation controls. It is not a claim
that every previously shipped feature has been audited.
