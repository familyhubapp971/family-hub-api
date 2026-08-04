Feature: GET/PATCH /api/kid/tasks (FHS-355)

  A logged-in kid sees and ticks only their OWN tasks: never another member's.

  Background:
    Given a family with kid task "Brush teeth" and a grown-up task "Pay bills"

  Scenario: a kid sees only their own tasks
    When the kid GETs /api/kid/tasks with their token
    Then the kid tasks response status is 200
    And the kid tasks include "Brush teeth"
    And the kid tasks do not include "Pay bills"

  Scenario: a kid can tick their own task
    When the kid ticks their own task
    Then the tick response status is 200
    And that task is marked done

  Scenario: a kid cannot tick another members task
    When the kid tries to tick the grown-up task
    Then the tick response status is 404
