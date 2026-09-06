import XCTest

/// Runs the actual adaptive shell and Calendar/Email views against deterministic model adapters.
/// These checks prove native interactions, not cloud authorization or remote server delivery.
final class PathwayParityUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        executionTimeAllowance = 120
    }

    @MainActor func testShellRoutesCalendarAndEmail() {
        let app = launch()
        let planning = app.buttons["calendar-event-planning"]
        reveal(planning, in: app)
        XCTAssertTrue(planning.exists)
        capture(app, "Calendar in the adaptive shell")
        navigate("email", title: "Email", in: app)
        let mail = app.buttons["email-message-parity-company:online:same"]
        reveal(mail, in: app)
        XCTAssertTrue(mail.exists)
        capture(app, "Email in the adaptive shell")
        navigate("calendar", title: "Calendar", in: app)
        XCTAssertTrue(app.navigationBars["Calendar"].firstMatch.waitForExistence(timeout: 5))
        if app.buttons["rail-destination-calendar"].exists {
            let sidebar = app.descendants(matching: .any)["context-sidebar-calendar"].firstMatch
            XCTAssertTrue(sidebar.exists)
            sidebar.staticTexts["Week"].firstMatch.tap()
            XCTAssertTrue(app.segmentedControls.buttons["Week"].isSelected)
        }
    }

    @MainActor func testCalendarCreateEditDelete() {
        let app = launch()
        app.buttons["New event"].tap()
        let title = app.textFields["calendar-event-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.tap(); title.typeText("Parity created event")
        app.navigationBars["New event"].buttons["Save"].tap()
        let row = event(named: "Parity created event", in: app)
        reveal(row, in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()
        let edit = app.buttons["Edit event"]
        reveal(edit, in: app); edit.tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        replace(title, with: "Parity edited event")
        app.navigationBars["Edit event"].buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["Parity edited event"].waitForExistence(timeout: 5))
        capture(app, "Edited Calendar event")
        let delete = app.buttons["Delete event"]
        reveal(delete, in: app); delete.tap()
        confirm("Delete event", in: app)
        XCTAssertTrue(app.navigationBars["Calendar"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(event(named: "Parity edited event", in: app).exists)
    }

    @MainActor func testCalendarDeniedSavePreservesDraftAndMirroredEventIsReadOnly() {
        let app = launch(extra: ["--parity-deny-calendar"])
        let mirror = app.buttons["calendar-event-mirror"]
        reveal(mirror, in: app); mirror.tap()
        XCTAssertTrue(app.staticTexts["Mirrored appointment"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Edit event"].exists)
        XCTAssertFalse(app.buttons["Delete event"].exists)
        back(from: "Event", in: app)
        let planning = app.buttons["calendar-event-planning"]
        reveal(planning, in: app); planning.tap()
        let edit = app.buttons["Edit event"]
        reveal(edit, in: app); edit.tap()
        let title = app.textFields["calendar-event-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        replace(title, with: "Unsaved calendar draft")
        app.navigationBars["Edit event"].buttons["Save"].tap()
        let failure = app.staticTexts["Calendar save denied by fixture."]
        reveal(failure, in: app)
        XCTAssertTrue(failure.waitForExistence(timeout: 5))
        capture(app, "Calendar denied save")
        app.navigationBars["Edit event"].buttons["Cancel"].tap()
        XCTAssertTrue(app.staticTexts["Planning review"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Unsaved calendar draft"].exists)
    }

    @MainActor func testEmailReadUnreadAndOfflineFailure() {
        let app = launch(extra: ["--parity-email"])
        let online = app.buttons["email-message-parity-company:online:same"]
        reveal(online, in: app); online.tap()
        let toggle = app.buttons["email-read-toggle"]
        reveal(toggle, in: app)
        XCTAssertEqual(toggle.label, "Mark read")
        toggle.tap()
        XCTAssertTrue(toggle.wait(for: \.label, toEqual: "Mark unread", timeout: 5))
        toggle.tap()
        XCTAssertTrue(toggle.wait(for: \.label, toEqual: "Mark read", timeout: 5))
        back(from: "Message", in: app)
        let offline = app.buttons["email-message-parity-company:offline:same"]
        reveal(offline, in: app); offline.tap()
        reveal(toggle, in: app); toggle.tap()
        let error = app.staticTexts["The source environment is offline. Reconnect and try again."]
        reveal(error, in: app)
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.label, "Mark read")
        capture(app, "Email source failure retains unread state")
    }

    @MainActor func testEmailTagSettingsCreateEditDelete() {
        let app = launch(extra: ["--parity-email"])
        app.buttons["Email settings"].tap()
        let newTag = app.textFields["New tag name"]
        reveal(newTag, in: app); newTag.tap(); newTag.typeText("Release")
        let create = app.buttons["Create tag"]
        reveal(create, in: app); create.tap()
        let tag = app.buttons["Release"]
        reveal(tag, in: app); XCTAssertTrue(tag.waitForExistence(timeout: 5)); tag.tap()
        let name = app.textFields["Name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        replace(name, with: "Release ready")
        app.buttons["Save"].tap()
        let edited = app.buttons["Release ready"]
        reveal(edited, in: app); XCTAssertTrue(edited.waitForExistence(timeout: 5))
        capture(app, "Email tag settings")
        edited.tap(); app.buttons["Delete tag"].tap()
        confirm("Delete tag", in: app)
        XCTAssertTrue(app.navigationBars["Email settings"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Release ready"].exists)
    }

    @MainActor func testEmailCaptureRetentionPersistsAndAnalyticsLoads() {
        let app = launch(extra: ["--parity-email"])
        app.buttons["Email settings"].tap()
        app.buttons["Parity server"].tap()
        let form = app.descendants(matching: .any)["email-capture-settings"].firstMatch
        XCTAssertTrue(form.waitForExistence(timeout: 5))
        let maximum = app.textFields["Maximum messages"]
        reveal(maximum, in: app, within: form)
        XCTAssertTrue(maximum.waitForExistence(timeout: 5))
        replace(maximum, with: "321")
        XCTAssertEqual(maximum.value as? String, "321")
        let save = app.buttons["Save capture settings"]
        reveal(save, in: app, within: form)
        waitForSettledFrame(save)
        capture(app, "Capture retention before Save")
        save.tap()
        capture(app, "Capture retention after Save")
        back(from: "Parity server", in: app)
        app.buttons["Parity server"].tap()
        reveal(maximum, in: app, within: form)
        XCTAssertEqual(maximum.value as? String, "321")
        let analytics = app.buttons["Capture analytics"]
        reveal(analytics, in: app, down: true, within: form)
        waitForSettledFrame(analytics)
        analytics.tap()
        XCTAssertTrue(app.navigationBars["Capture analytics"].waitForExistence(timeout: 5))
        let report = app.descendants(matching: .any)["email-capture-analytics"].firstMatch
        XCTAssertTrue(report.waitForExistence(timeout: 5))
        let latency = app.staticTexts["Average, 42 ms"]
        reveal(latency, in: app, within: report)
        XCTAssertTrue(latency.waitForExistence(timeout: 5))
        capture(app, "Capture analytics")
    }

    @MainActor private func launch(extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitest-parity"] + extra
        app.launch()
        let title = extra.contains("--parity-email") ? "Email" : "Calendar"
        XCTAssertTrue(app.navigationBars[title].firstMatch.waitForExistence(timeout: 10))
        return app
    }

    @MainActor private func navigate(_ id: String, title: String, in app: XCUIApplication) {
        let rail = app.buttons["rail-destination-\(id)"]
        if rail.exists { reveal(rail, in: app); rail.tap() }
        else {
            let more = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "choose another view")).firstMatch
            XCTAssertTrue(more.waitForExistence(timeout: 5)); more.tap()
            let destination = app.buttons.matching(NSPredicate(format: "label == %@", title)).firstMatch
            reveal(destination, in: app); destination.tap()
        }
        XCTAssertTrue(app.navigationBars[title].firstMatch.waitForExistence(timeout: 5))
    }

    @MainActor private func event(named title: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "calendar-event-", title)).firstMatch
    }

    @MainActor private func replace(_ field: XCUIElement, with value: String) {
        field.tap()
        let existing = field.value as? String ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count) + value)
    }

    @MainActor private func back(from title: String, in app: XCUIApplication) {
        app.navigationBars[title].buttons.element(boundBy: 0).tap()
    }

    @MainActor private func confirm(_ title: String, in app: XCUIApplication) {
        let sheet = app.sheets.buttons[title]
        if sheet.waitForExistence(timeout: 2) { sheet.tap() }
        else { app.buttons.matching(identifier: title).allElementsBoundByIndex.last?.tap() }
    }

    @MainActor private func waitForSettledFrame(_ element: XCUIElement) {
        var previous = CGRect.null
        var stableSince = Date()
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let current = element.frame
            if current != previous { previous = current; stableSince = Date(); return false }
            return element.isHittable && Date().timeIntervalSince(stableSince) >= 0.5
        }, object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 5), .completed)
    }

    @MainActor private func reveal(_ element: XCUIElement, in app: XCUIApplication, down: Bool = false, within container: XCUIElement? = nil) {
        for _ in 0..<7 {
            if let container {
                let visible = visibleScrollBounds(container, in: app)
                guard !visible.isNull, visible.width >= 44, visible.height >= 80 else {
                    XCTFail("The scroll container has no usable area above the keyboard")
                    return
                }
                if element.exists && element.isHittable,
                   visible.insetBy(dx: 8, dy: 8).contains(CGPoint(x: element.frame.midX, y: element.frame.midY)) { return }
                let top = visible.minY + visible.height * 0.2
                let bottom = visible.minY + visible.height * 0.8
                let origin = app.coordinate(withNormalizedOffset: .zero)
                let start = origin.withOffset(CGVector(dx: visible.midX - app.frame.minX, dy: (down ? top : bottom) - app.frame.minY))
                let end = origin.withOffset(CGVector(dx: visible.midX - app.frame.minX, dy: (down ? bottom : top) - app.frame.minY))
                start.press(forDuration: 0.05, thenDragTo: end)
                continue
            }
            if element.exists && element.isHittable { return }
            let bottom = app.keyboards.firstMatch.exists ? 0.50 : 0.75
            let top = app.keyboards.firstMatch.exists ? 0.25 : 0.35
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: down ? top : bottom))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: down ? bottom : top))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
    }

    @MainActor private func visibleScrollBounds(_ container: XCUIElement, in app: XCUIApplication) -> CGRect {
        var visible = container.frame.intersection(app.frame)
        for keyboard in app.keyboards.allElementsBoundByIndex where keyboard.exists {
            let covered = visible.intersection(keyboard.frame)
            if !covered.isNull && !covered.isEmpty {
                visible.size.height = max(0, covered.minY - visible.minY)
            }
        }
        return visible
    }

    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
