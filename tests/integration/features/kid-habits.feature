Feature: Kid interactive habits

  A logged-in kid reads their OWN weekly habits + stickers and may place a
  sticker on today only — never a sibling's habits, never a past/finalized
  week (FHS-363). Real kid token against real Postgres.

  Background:
    Given a family with kid "Iman" (habit "Read a book"), sibling "Yusuf" (habit "Tidy room"), and a finalized past week for Iman

  Scenario: a kid reads only their own habits for the current week
    When the kid GETs /api/kid/habits with their token
    Then the kid habits response status is 200
    And the kid habits include "Read a book"
    And the kid habits do not include "Tidy room"

  Scenario: a kid places a sticker on today
    When the kid places a "gold-star" sticker on today
    Then the place-sticker response status is 200
    And the kid habits then show a sticker today

  Scenario: a kid cannot sticker a finalized week
    When the kid places a "heart" sticker on day 0 of the finalized week
    Then the place-sticker response status is 403

  Scenario: a kid cannot place a sticker on a sibling's habit
    When sibling "Yusuf" tries to sticker Iman's habit today
    Then the place-sticker response status is 404

  Scenario: a kid removes today's sticker
    When the kid places then removes a sticker on today
    Then the remove-sticker response status is 204
    And the kid habits then show no sticker today
