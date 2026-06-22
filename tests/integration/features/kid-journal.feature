Feature: Kid journal

  A logged-in kid writes their OWN journal for a day and reads their own past
  entries — never a sibling's (FHS-366). Real kid token against real Postgres.

  Background:
    Given a family with kid "Iman" and sibling "Yusuf"

  Scenario: a kid saves and reads back their journal
    When the kid "Iman" saves a journal entry for today with body "Great day"
    Then the journal save status is 200
    And reading "Iman" journal for today shows body "Great day"

  Scenario: a sibling does not see another kid's journal
    When the kid "Iman" saves a journal entry for today with body "Great day"
    Then reading "Yusuf" journal for today shows no entry

  Scenario: an invalid journal date is rejected
    When the kid "Iman" reads their journal for date "not-a-date"
    Then the journal read status is 400
