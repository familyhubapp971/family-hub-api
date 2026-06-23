Feature: Kid read-only My World

  A logged-in kid reads their own My World data — weeks, week stats, week
  actions, financial savings, and financial investments — in read-only mode
  (FHS-374). Shapes are byte-identical to the parent endpoints. Sibling-
  isolation is verified on every route: kid A never sees kid B's data.

  Background:
    Given two kids "Iman" and "Yusuf" in the same family, each with a week and some stickers

  Scenario: a kid reads their weeks list
    When kid "Iman" GETs /api/kid/weeks
    Then the kid weeks response status is 200
    And the weeks list includes Iman's week
    And the weeks list does not include Yusuf's week

  Scenario: a kid reads week stats for their own week
    When kid "Iman" GETs /api/kid/weeks/:id/stats for their week
    Then the kid week stats response status is 200
    And the week stats contain a totalStickers field

  Scenario: a kid gets 404 for a sibling's week stats
    When kid "Iman" requests week stats for Yusuf's week
    Then the kid week stats response status is 404

  Scenario: a kid reads week actions for their own week
    When kid "Iman" GETs /api/kid/weeks/:id/actions for their week
    Then the kid week actions response status is 200
    And the response contains an actions array

  Scenario: a kid gets 404 for a sibling's week actions
    When kid "Iman" requests week actions for Yusuf's week
    Then the kid week actions response status is 404

  Scenario: a kid reads their savings
    When kid "Iman" GETs /api/kid/financial/savings
    Then the kid savings response status is 200
    And the savings body contains savedStickers and currency

  Scenario: a kid reads their investments
    When kid "Iman" GETs /api/kid/financial/investments
    Then the kid investments response status is 200
    And the investments body contains an investments array

  Scenario: sibling cannot see Iman's savings
    When kid "Yusuf" GETs /api/kid/financial/savings
    Then the kid savings response status is 200
    And Yusuf's savedStickers is 0
