Feature: Kid Learn activity → Parent Learn Insights cross-side consistency (FHS-405)

  Background:
    Given a family with an admin parent and a kid "Iman" set up for learn-insights cross-side tests

  Scenario: kid answers Learn questions, parent insights show progress and accuracy
    When kid "Iman" answers 3 Science questions correctly and 1 incorrectly
    Then the learn answer responses are all 200
    When the admin parent GETs learn insights for Iman
    Then the learn insights response status is 200
    And the Science subject shows progressPct greater than 0
    And the Science accuracyPct is 75
    And the Science lastActive is set

  Scenario: kid earns a Science certificate, parent insights certificate count goes up
    When kid "Iman" answers 10 Science questions correctly to earn a certificate
    Then all 10 learn answer responses are 200
    When the admin parent GETs learn insights for Iman after the certificate
    Then the learn insights after-certificate response status is 200
    And the Science certificatesEarned is 1

  Scenario: kid completes a World Flags learn chunk, parent insights reflect the continent
    When kid "Iman" completes the first Africa learn chunk
    Then the world-flags learn-complete response status is 200
    When the admin parent GETs learn insights for Iman after the continent
    Then the learn insights after-continent response status is 200
    And the World Flags subject shows continentsExplored of 1
    And Africa appears in exploredContinents
