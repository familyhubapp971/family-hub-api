Feature: Who is allowed to touch a child's money and the family's settings

  FHS-625. The app decides which doors to show from the caller's role, so the
  server has to be the thing that actually refuses. This walks every role
  against every money and settings endpoint, so a browser check can never be
  the only gate.

  The rule: any grown-up (admin or adult) may do the everyday things that can
  be undone. Only an admin may do the ones that cannot, or that change the
  whole family. A child may act on their own money and nobody else's.

  What is asserted is the permission boundary, not the success shape: a
  refusal must be exactly 403, and an allowed call must not be turned away.
  What each endpoint returns on success is each endpoint's own feature file.

  Background:
    Given the test Postgres has clean money-permission tables
    And a users mirror row exists for every role in the money-permission test
    And a family exists with an admin, an adult, a teen, a guest and a child
    And the child has enough stickers to spend this week

  Scenario Outline: An everyday money move is refused to anyone who is not a grown-up
    When "<role>" tries to "<endpoint>" for the child
    Then the money-permission call is refused

    Examples:
      | role  | endpoint           |
      | teen  | bank stickers      |
      | guest | bank stickers      |
      | teen  | open an investment |
      | guest | open an investment |

  Scenario Outline: An everyday money move is open to any grown-up
    When "<role>" tries to "<endpoint>" for the child
    Then the money-permission call is allowed

    Examples:
      | role  | endpoint           |
      | adult | bank stickers      |
      | admin | bank stickers      |
      | adult | open an investment |

  Scenario Outline: Anything that cannot be undone is refused to everyone but an admin
    When "<role>" tries to "<endpoint>" for the child
    Then the money-permission call is refused

    Examples:
      | role  | endpoint           |
      | adult | set a balance      |
      | teen  | set a balance      |
      | guest | set a balance      |
      | adult | close the week     |
      | teen  | close the week     |
      | guest | close the week     |
      | adult | reopen the week    |
      | teen  | reopen the week    |
      | guest | reopen the week    |
      | adult | edit the week cash |
      | teen  | edit the week cash |
      | guest | edit the week cash |

  Scenario Outline: An admin may do the things that cannot be undone
    When "admin" tries to "<endpoint>" for the child
    Then the money-permission call is allowed

    Examples:
      | endpoint           |
      | set a balance      |
      | edit the week cash |
      | close the week     |

  Scenario Outline: Family-wide settings are refused to everyone but an admin
    When "<role>" tries to "<endpoint>"
    Then the money-permission call is refused

    Examples:
      | role  | endpoint             |
      | adult | rename the family    |
      | teen  | rename the family    |
      | guest | rename the family    |
      | adult | change the currency  |
      | teen  | change the currency  |
      | guest | change the currency  |
      | adult | export our data      |
      | teen  | export our data      |
      | guest | export our data      |
      | adult | change earning rules |
      | teen  | change earning rules |
      | guest | change earning rules |

  Scenario Outline: An admin may change the family-wide settings
    When "admin" tries to "<endpoint>"
    Then the money-permission call is allowed

    Examples:
      | endpoint             |
      | rename the family    |
      | change the currency  |
      | export our data      |
      | change earning rules |

  Scenario Outline: Reading the settings is open to the whole family
    When "<role>" reads "<endpoint>"
    Then the money-permission call is allowed

    Examples:
      | role  | endpoint      |
      | admin | earning rules |
      | adult | earning rules |
      | teen  | earning rules |
      | guest | earning rules |
      | admin | the settings  |
      | adult | the settings  |
      | teen  | the settings  |
      | guest | the settings  |

  Scenario: An admin may reopen a week they closed
    When "admin" tries to "close the week" for the child
    And "admin" tries to "reopen the week" for the child
    Then the money-permission call is allowed

  Scenario: A child may bank their own stickers
    When the child banks her own stickers
    Then the money-permission call is allowed

  Scenario: A child may not touch another child's money
    Given the family has a second child
    When the child tries to bank stickers for the other child
    Then the money-permission call is refused
