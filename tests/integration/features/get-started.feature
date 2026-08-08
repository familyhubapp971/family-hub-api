Feature: GET/POST /api/onboarding/get-started (FHS-634)
  Real Postgres on :5433. The dashboard "Getting started" guide kept its
  state in the browser, so a parent who had already set the family up was
  told "0 of 4 done: add your kids" the first time they signed in on
  another browser. The steps now come from the family's own data and the
  dismissal is stored against the parent.

  Background:
    Given the test Postgres has clean tenants, members, habits, and users tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member

  Scenario: A brand-new family has none of the four steps done
    When the admin reads the setup guide for "khan"
    Then the response status is 200
    And the steps are kids "false", pins "false", rate "false", habits "false"
    And the guide is not dismissed

  Scenario: Steps tick from what the family actually has, not what was tapped
    Given a kid member "Iman" exists in tenant "khan" with a PIN
    And "Iman" has a habit of their own in tenant "khan"
    And tenant "khan" has chosen its sticker rate
    When the admin reads the setup guide for "khan"
    Then the response status is 200
    And the steps are kids "true", pins "true", rate "true", habits "true"

  Scenario: The starter habits seeded at sign-up do not count as picking habits
    Given a kid member "Iman" exists in tenant "khan" with a PIN
    And tenant "khan" has a family-level starter habit with no owner
    When the admin reads the setup guide for "khan"
    Then the steps are kids "true", pins "true", rate "false", habits "false"

  Scenario: A family that already changed its sticker rate is not asked again
    Given a kid member "Iman" exists in tenant "khan" with a PIN
    And tenant "khan" runs on a sticker rate of 100 with no record of when it was set
    When the admin reads the setup guide for "khan"
    Then the steps are kids "true", pins "true", rate "true", habits "false"

  Scenario: A child's own rate override also counts as choosing
    Given a kid member "Iman" exists in tenant "khan" with a PIN
    And "Iman" has their own sticker rate of 75
    When the admin reads the setup guide for "khan"
    Then the steps are kids "true", pins "true", rate "true", habits "false"

  Scenario: An archived habit does not count as picking a habit
    Given a kid member "Iman" exists in tenant "khan" with a PIN
    And "Iman" has a habit of their own in tenant "khan"
    And every habit in tenant "khan" is archived
    When the admin reads the setup guide for "khan"
    Then the steps are kids "true", pins "true", rate "false", habits "false"

  Scenario: A teen counts as a kid
    Given a teen member "Yusra" exists in tenant "khan" with a PIN
    When the admin reads the setup guide for "khan"
    Then the steps are kids "true", pins "true", rate "false", habits "false"

  Scenario: The PIN step waits until every kid has one
    Given a kid member "Iman" exists in tenant "khan" with a PIN
    And a kid member "Sara" exists in tenant "khan" with no PIN
    When the admin reads the setup guide for "khan"
    Then the steps are kids "true", pins "false", rate "false", habits "false"

  Scenario: Hiding the guide sticks for that parent on the next request
    When the admin dismisses the setup guide for "khan"
    Then the response status is 200
    And reading the setup guide for "khan" as the admin says it is dismissed

  Scenario: Dismissing twice is not an error and keeps the first timestamp
    When the admin dismisses the setup guide for "khan"
    And the admin dismisses the setup guide for "khan" again
    Then the response status is 200
    And the recorded dismissal time did not move

  Scenario: One parent hiding it does not hide it for the other parent
    Given a second admin "Yusuf" of tenant "khan"
    When the admin dismisses the setup guide for "khan"
    Then reading the setup guide for "khan" as "Yusuf" says it is not dismissed

  Scenario: A non-admin member is refused
    Given an adult member "Yusuf" who is the caller of tenant "khan"
    When the adult reads the setup guide for "khan"
    Then the response status is 403

  Scenario: Tenant isolation: another family's setup never ticks these steps
    Given a tenant "patel" exists with a kid with a PIN, a habit and a chosen rate
    When the admin reads the setup guide for "khan"
    Then the steps are kids "false", pins "false", rate "false", habits "false"
