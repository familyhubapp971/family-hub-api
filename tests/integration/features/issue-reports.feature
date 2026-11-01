Feature: Report an issue with photos (FHS-717)
  Real Postgres on :5433. The family comes from the real x-tenant-slug lookup,
  and every database call runs as the limited app role, the way production
  does, so the family lock (RLS) applies to the report itself and the founder
  reads cross families only through their own database functions.

  Background:
    Given the issue report test DB is clean
    And a grown-up "Mum" is an adult in family "issues-alpha"

  Scenario: A grown-up reports a problem in words
    When Mum reports "The save button does nothing" on screen "today"
    Then the report answers 201 with an id
    And family "issues-alpha" holds 1 issue report with 0 photos

  Scenario: A grown-up reports a problem with a photo and the founder sees it
    When Mum reports "Look at this" on screen "meals" with 1 PNG photo
    Then the report answers 201 with an id
    When the founder lists the issue reports
    Then the founder sees the report from "issues-alpha Family" by "Mum" with 1 photo
    And the founder gets the photo back byte for byte as "image/png"

  Scenario: A photo with no words is accepted
    When Mum reports "" on screen "today" with 1 JPEG photo
    Then the report answers 201 with an id
    And family "issues-alpha" holds 1 issue report with 1 photos

  Scenario: An empty report is refused
    When Mum reports "" on screen "today"
    Then the report answers 400

  Scenario: A fourth photo is refused
    When Mum reports "Too many" on screen "today" with 4 JPEG photos
    Then the report answers 400
    And family "issues-alpha" holds 0 issue report with 0 photos

  Scenario: A text file named like a photo is refused
    When Mum reports "Fake" on screen "today" with a text file named "fake.jpg"
    Then the report answers 400

  Scenario: A file under another field name is refused
    When Mum reports "See file" on screen "today" with a photo in a field named "image"
    Then the report answers 400
    And family "issues-alpha" holds 0 issue report with 0 photos

  Scenario: A photo over 1 MB is refused
    When Mum reports "Huge" on screen "today" with a 1.2 MB JPEG photo
    Then the report answers 413

  Scenario: A request over 3.5 MB is refused
    When Mum reports "Three huge" on screen "today" with 3 photos of 1.2 MB
    Then the report answers 413

  Scenario: Line breaks count as one character each
    When Mum reports 2000 typed characters with line breaks on screen "today"
    Then the report answers 201 with an id
    And the saved description is exactly what Mum typed

  Scenario: Hidden control characters never break a report
    When Mum reports words with a zero byte in them on screen "today"
    Then the report answers 201 with an id
    And the saved description is "broken"
    When Mum reports "Fine words" on a screen name with a zero byte in it
    Then the report answers 400

  Scenario: A child cannot report
    Given a child "Sam" with a sign-in is in family "issues-alpha"
    When Sam reports "I broke it" on screen "today"
    Then the report answers 403

  Scenario: A grown-up cannot report into another family
    Given a second family "issues-beta" exists
    When Mum reports "Sneaky" on screen "today" to family "issues-beta"
    Then the report answers 403
    And family "issues-beta" holds 0 issue report with 0 photos

  Scenario: Tenant isolation: family B cannot read family A's reports
    Given a second family "issues-beta" exists
    When Mum reports "Private to us" on screen "today" with 1 PNG photo
    Then the app role pinned to "issues-beta" sees 0 issue reports and 0 photos
    And the app role pinned to "issues-alpha" sees 1 issue reports and 1 photos
    And the app role pinned to "issues-beta" cannot add a report for "issues-alpha"

  Scenario: A photo cannot sit in a different family from its report
    Given a second family "issues-beta" exists
    And Mum has reported "Ours" on screen "today" with 0 PNG photo
    Then a photo of that report filed under "issues-beta" is refused by the database

  Scenario: A family can send 30 reports a day
    Given family "issues-alpha" already sent 30 reports in the last 24 hours
    When Mum reports "One more" on screen "today"
    Then the report answers 429
    And family "issues-alpha" holds 30 issue report with 0 photos

  Scenario: Reports older than 24 hours do not count
    Given family "issues-alpha" already sent 29 reports in the last 24 hours and 5 before that
    When Mum reports "One more" on screen "today"
    Then the report answers 201 with an id

  Scenario: A slow upload holds no database connection
    When Mum starts a report with a photo and the upload stalls
    Then no app database connection is in use
    And the founder can still list the issue reports
    When the rest of the upload arrives
    Then the slow report answers 201

  Scenario: Founder issue routes need the page token
    Given Mum has reported "Broken" on screen "today" with 1 PNG photo
    When someone calls the three founder issue routes without a token
    Then all three answer 401

  Scenario: The founder marks a report fixed, then reopens it
    Given Mum has reported "Broken" on screen "today" with 0 PNG photo
    When the founder marks the report "fixed"
    Then the report is "fixed" with a fixed time
    And the founder list shows it as "fixed"
    When the founder reopens the report
    Then the report is "new" with no fixed time

  Scenario: Old new reports stay on the founder list
    Given family "issues-alpha" has an unfixed report from 30 days ago and 501 newer fixed reports
    When the founder lists the issue reports
    Then the list holds the old unfixed report and the newest 500 fixed ones

  Scenario: Marking an unknown report is not found
    When the founder marks a report that does not exist "fixed"
    Then the founder issue API answers 404

  Scenario: A photo asked for under a different report is not found
    Given Mum has reported "First" on screen "today" with 1 PNG photo
    And Mum has reported "Second" on screen "meals" with 0 PNG photo
    When the founder asks for the first report's photo under the second report
    Then the founder issue API answers 404
