import XCTest

#if !os(visionOS)
import UIKit
/// Uses production Calendar/Email views with the parity fixture, without changing device settings.
final class PathwayAppleLayoutUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        executionTimeAllowance = 180
    }

    @MainActor func testRotationRetainsCalendarAndEmailDestinations() {
        XCUIDevice.shared.orientation = .portrait
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = launch(contentSize: "UICTContentSizeCategoryL")
        defer { app.terminate() }
        waitForOrientation(in: app, landscape: false)
        let supportsRotation = UIDevice.current.userInterfaceIdiom == .pad

        for destination in [(id: "calendar", title: "Calendar"), (id: "email", title: "Email")] {
            navigate(destination.id, title: destination.title, in: app)
            assertDestination(destination.id, title: destination.title, in: app)
            for landscape in [true, false] {
                XCUIDevice.shared.orientation = landscape ? .landscapeLeft : .portrait
                let appLandscape = supportsRotation && landscape
                waitForOrientation(in: app, landscape: appLandscape)
                assertDestination(destination.id, title: destination.title, in: app)
                if destination.id == "calendar" {
                    tap(app.buttons["New event"], in: app)
                    cancelEditor("New event", in: app)
                } else {
                    tap(app.buttons["Email settings"], in: app)
                    let settings = app.navigationBars["Email settings"]
                    XCTAssertTrue(settings.waitForExistence(timeout: 5))
                    tap(settings.buttons["Done"], in: app)
                    XCTAssertTrue(settings.waitForNonExistence(timeout: 5))
                }
                assertDestination(destination.id, title: destination.title, in: app)
                // Check again after a completed presentation and dismissal so an iPhone
                // cannot pass solely because its original portrait frame was still visible.
                waitForOrientation(in: app, landscape: appLandscape)
                capture(app, "\(destination.title): device \(landscape ? "landscape" : "portrait"), app \(appLandscape ? "landscape" : "portrait")")
            }
        }
    }

    @MainActor func testAccessibilityTextActuallyGrowsAndCalendarEditorsCanCancel() {
        XCUIDevice.shared.orientation = .portrait
        defer { XCUIDevice.shared.orientation = .portrait }

        // Large is the standard Dynamic Type baseline, specified only for this process.
        let baseline = launch(contentSize: "UICTContentSizeCategoryL")
        defer { baseline.terminate() }
        waitForOrientation(in: baseline, landscape: false)
        let baselineRow = baseline.buttons["calendar-event-planning"]
        reveal(baselineRow, in: baseline)
        let standardRowHeight = baselineRow.frame.height
        XCTAssertGreaterThan(standardRowHeight, 0)
        capture(baseline, "Calendar standard Dynamic Type")
        baselineRow.tap()
        let baselineTitle = baseline.staticTexts["Planning review"].firstMatch
        XCTAssertTrue(baselineTitle.waitForExistence(timeout: 5))
        let standardTitleHeight = baselineTitle.frame.height
        XCTAssertGreaterThan(standardTitleHeight, 0)
        capture(baseline, "Event text standard Dynamic Type")
        baseline.terminate()

        let app = launch(contentSize: "UICTContentSizeCategoryAccessibilityXXXL")
        defer { app.terminate() }
        waitForOrientation(in: app, landscape: false)
        assertAccessibleSidebarWords(in: app)
        assertAccessibleCalendarMenu(in: app)
        let row = app.buttons["calendar-event-planning"]
        reveal(row, in: app)
        // Relative growth verifies the launch override affected rendered content. A merely
        // successful launch, or unchanged geometry, cannot pass this accessibility check.
        XCTAssertGreaterThan(row.frame.height, standardRowHeight * 1.2, "Event row must grow at accessibility XXXL")
        capture(app, "Calendar accessibility XXXL")
        row.tap()
        let title = app.staticTexts["Planning review"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(title.frame.height, standardTitleHeight * 1.2, "Rendered event text must grow, not only row padding")
        capture(app, "Event text accessibility XXXL")

        tap(app.buttons["Edit event"], in: app)
        let field = app.textFields["calendar-event-title"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "Planning review")
        tap(field, in: app)
        field.typeText(" cancelled edit")
        capture(app, "Accessible edit with keyboard and cancellation control")
        cancelEditor("Edit event", in: app)
        XCTAssertTrue(app.navigationBars["Event"].waitForExistence(timeout: 5))
        reveal(title, in: app, towardsTop: true)
        XCTAssertEqual(title.label, "Planning review", "Cancelling must preserve the original event")

        tap(app.navigationBars["Event"].buttons.element(boundBy: 0), in: app)
        XCTAssertTrue(app.navigationBars["Calendar"].firstMatch.waitForExistence(timeout: 5))
        tap(app.buttons["New event"], in: app)
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        tap(field, in: app)
        field.typeText("Cancelled accessibility draft")
        capture(app, "Accessible new event with keyboard and cancellation control")
        cancelEditor("New event", in: app)
        XCTAssertTrue(app.navigationBars["Calendar"].firstMatch.waitForExistence(timeout: 5))
        let cancelled = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "calendar-event-", "Cancelled accessibility draft"))
        XCTAssertEqual(cancelled.count, 0, "Cancelling must not create an event")
    }

    @MainActor private func assertAccessibleSidebarWords(in app: XCUIApplication) {
        guard app.buttons["rail-destination-calendar"].exists else { return }
        let sidebar = app.descendants(matching: .any)["context-sidebar-calendar"].firstMatch
        XCTAssertTrue(sidebar.exists)
        let day = sidebar.staticTexts["Day"].firstMatch
        XCTAssertTrue(day.waitForExistence(timeout: 5))
        let lineHeight = day.frame.height
        XCTAssertGreaterThan(lineHeight, 0)
        for word in ["Schedule", "Week", "Month"] {
            let text = sidebar.staticTexts[word].firstMatch
            XCTAssertTrue(text.exists && text.isHittable)
            XCTAssertLessThanOrEqual(text.frame.height, lineHeight * 1.25,
                                     "The single word \(word) must fit without breaking across lines")
        }
        let timeline = sidebar.staticTexts["Work timeline"].firstMatch
        XCTAssertTrue(timeline.exists)
        XCTAssertLessThanOrEqual(timeline.frame.height, lineHeight * 2.25,
                                 "Work timeline may wrap between its two words, without fragmenting either word")
    }

    @MainActor private func assertAccessibleCalendarMenu(in app: XCUIApplication) {
        let picker = app.buttons["calendar-view-picker"].firstMatch
        XCTAssertTrue(picker.waitForExistence(timeout: 5), "Accessibility sizes must expose the Calendar view menu")
        tap(picker, in: app)
        tap(app.buttons["Timeline"].firstMatch, in: app)
        XCTAssertTrue(picker.label.contains("Timeline") || (picker.value as? String) == "Timeline")
        tap(picker, in: app)
        tap(app.buttons["Agenda"].firstMatch, in: app)
        XCTAssertTrue(picker.label.contains("Agenda") || (picker.value as? String) == "Agenda")
    }

    @MainActor private func launch(contentSize: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitest-parity", "-UIPreferredContentSizeCategoryName", contentSize]
        app.launch()
        XCTAssertTrue(app.navigationBars["Calendar"].firstMatch.waitForExistence(timeout: 10))
        return app
    }

    @MainActor private func waitForOrientation(in app: XCUIApplication, landscape: Bool) {
        let predicate = NSPredicate { object, _ in
            guard let window = object as? XCUIElement else { return false }
            let frame = window.frame
            guard frame.width > 0, frame.height > 0 else { return false }
            return landscape ? frame.width > frame.height : frame.height > frame.width
        }
        let changed = XCTNSPredicateExpectation(predicate: predicate, object: app.windows.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 10), .completed,
                       "The app window must be \(landscape ? "landscape" : "portrait") for this device’s supported orientation")
    }

    @MainActor private func navigate(_ id: String, title: String, in app: XCUIApplication) {
        let rail = app.buttons["rail-destination-\(id)"]
        if rail.exists { tap(rail, in: app) }
        else {
            let overflow = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "choose another view")).firstMatch
            tap(overflow, in: app)
            tap(app.buttons.matching(NSPredicate(format: "label == %@", title)).firstMatch, in: app)
        }
        XCTAssertTrue(app.navigationBars[title].firstMatch.waitForExistence(timeout: 5))
    }

    @MainActor private func assertDestination(_ id: String, title: String, in app: XCUIApplication) {
        XCTAssertTrue(app.navigationBars[title].firstMatch.waitForExistence(timeout: 5))
        let rail = app.buttons["rail-destination-\(id)"]
        if rail.exists { XCTAssertTrue(rail.isSelected, "The wide navigation rail must retain its selection") }
        else {
            XCTAssertTrue(app.buttons["\(title), choose another view"].exists,
                          "The compact overflow control must retain the current destination")
        }
        let rowID = id == "calendar" ? "calendar-event-planning" : "email-message-parity-company:online:same"
        reveal(app.buttons[rowID], in: app)
        let action = app.buttons[id == "calendar" ? "New event" : "Email settings"]
        XCTAssertTrue(action.exists && action.isHittable, "The destination's primary action must remain reachable")
    }

    @MainActor private func cancelEditor(_ title: String, in app: XCUIApplication) {
        let navigation = app.navigationBars[title]
        XCTAssertTrue(navigation.waitForExistence(timeout: 5))
        let cancel = navigation.buttons["Cancel"]
        XCTAssertTrue(cancel.exists && cancel.isHittable, "Cancel must remain reachable, including with the keyboard visible")
        cancel.tap()
        XCTAssertTrue(navigation.waitForNonExistence(timeout: 5))
    }

    @MainActor private func tap(_ element: XCUIElement, in app: XCUIApplication) {
        reveal(element, in: app)
        element.tap()
    }

    @MainActor private func reveal(_ element: XCUIElement, in app: XCUIApplication, towardsTop: Bool = false) {
        for _ in 0..<12 {
            if element.exists && element.isHittable { return }
            let keyboard = app.keyboards.firstMatch.exists
            let lower = keyboard ? 0.50 : 0.78
            let upper = keyboard ? 0.25 : 0.32
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.80, dy: towardsTop ? upper : lower))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.80, dy: towardsTop ? lower : upper))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        XCTFail("Control was not reachable: \(element.identifier.isEmpty ? element.label : element.identifier)")
    }

    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
#endif
