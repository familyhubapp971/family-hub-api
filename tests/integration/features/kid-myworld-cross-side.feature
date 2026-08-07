Feature: Kid ↔ Parent My World data consistency (FHS-405)

  A parent write via the authenticated API surface must be immediately
  visible when the kid reads via the kid-scoped API. Both sides share
  the same lib/myworld.ts functions and the same Postgres rows, so these
  cross-side tests lock that invariant against regressions.

  Background:
    Given a family with an admin parent and a kid "Iman" set up for cross-side tests

  Scenario: parent places a sticker, kid sees it
    When the admin parent POSTs a sticker for Iman on day 0
    Then the parent sticker response status is 200
    When kid "Iman" GETs /api/kid/habits
    Then the kid habits response status is 200
    And the sticker appears in the kid habits response for day 0

  Scenario: parent finalizes the week, kid sees it finalized
    When the admin parent finalizes Iman's week
    Then the finalize response status is 200
    When kid "Iman" GETs /api/kid/weeks
    Then the kid cross-side weeks response status is 200
    And Iman's week is finalized in the kid weeks list

  Scenario: parent banks stickers into savings, kid sees the balance
    When the admin parent banks 2 stickers into Iman's savings
    Then the savings POST response status is 201
    When kid "Iman" GETs /api/kid/financial/savings
    Then the kid cross-side savings response status is 200
    And Iman's savedStickers reflects the 2 banked stickers

  Scenario: parent creates an investment, kid sees it active
    When the admin parent creates an investment of 10 stickers for Iman
    Then the investment POST response status is 201
    When kid "Iman" GETs /api/kid/financial/investments
    Then the kid cross-side investments response status is 200
    And the investment is listed as active for Iman
    And the kid can read the investment's multiplier

  Scenario: parent finalizes with an auto_save action, kid reads the action
    When the admin parent finalizes Iman's sticker week
    Then the sticker-week finalize response status is 200
    When kid "Iman" GETs the finalized week's actions
    Then the kid cross-side week actions response status is 200
    And an auto_save action with stickersUsed greater than 0 is present
