import XCTest

final class PathwayConversationUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        executionTimeAllowance = 75
    }
    @MainActor
    func testTranscriptToolsChangesAndChildNavigation() {
        let app = launchFixture()
        let fold = app.buttons["thread-work-run-completed"]
        reveal(fold, in: app, down: true)
        XCTAssertTrue(fold.waitForExistence(timeout: 5))
        capture(app, "Conversation folded work")
        fold.tap()
        let command = app.buttons["thread-activity-command"]
        reveal(command, in: app)
        XCTAssertTrue(command.waitForExistence(timeout: 5))
        command.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Executed 12 tests")).firstMatch.waitForExistence(timeout: 5))
        capture(app, "Conversation expanded tools")
        app.buttons["agent-thread-changes"].tap()
        XCTAssertTrue(app.navigationBars["Changes"].waitForExistence(timeout: 5))
        capture(app, "Conversation changed files")
        app.buttons["Done"].tap()
        app.buttons["agent-thread-composer-collapsed"].tap()
        let draft = app.textViews["agent-thread-composer-field"]
        XCTAssertTrue(draft.waitForExistence(timeout: 5))
        draft.tap(); draft.typeText("Retained parent draft")
        app.buttons["agent-thread-actions"].tap()
        app.buttons["agent-thread-open-child-sim-child"].tap()
        XCTAssertTrue(app.staticTexts["Review conversation controls"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["agent-thread-jump-bottom"].exists)
        capture(app, "Subagent conversation")
        XCTAssertTrue(app.navigationBars.buttons.element(boundBy: 0).exists)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.staticTexts["Bring conversations to mobile"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textViews["agent-thread-composer-field"].value as? String, "Retained parent draft")
    }

    @MainActor
    func testModelFavourites() {
        let app = launchFixture()
        app.buttons["agent-thread-composer-collapsed"].tap()
        app.buttons["agent-thread-composer-options"].tap()
        app.buttons["Favourite models"].tap()
        let toggle = app.buttons["model-favourite-codex-gpt-5.4-mini"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        if toggle.value as? String != "Favourite" { toggle.tap() }
        capture(app, "Favourite model settings")
        app.navigationBars.buttons["Composer options"].tap()
        app.buttons["Done"].tap()
        app.buttons["agent-thread-model-picker"].tap()
        let favourite = app.buttons["gpt-5.4-mini · Codex"]
        XCTAssertTrue(favourite.waitForExistence(timeout: 5))
        XCTAssertLessThan(favourite.frame.midY, app.buttons["Codex"].frame.midY)
        XCTAssertFalse(app.buttons["Edit favourites"].exists)
        capture(app, "Starred favourites above providers")
        favourite.tap()
        XCTAssertEqual(app.buttons["agent-thread-model-picker"].value as? String, "gpt-5.4-mini")
        app.buttons["agent-thread-composer-options"].tap()
        app.buttons["Favourite models"].tap()
        XCTAssertEqual(toggle.value as? String, "Favourite")
        toggle.tap()
    }

    @MainActor
    func testComposerModelEditAndFork() {
        let app = launchFixture()
        app.buttons["agent-thread-composer-collapsed"].tap()
        let field = app.textViews["agent-thread-composer-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText("Keep my draft")
        app.buttons["agent-thread-model-picker"].tap()
        app.buttons["Codex"].tap()
        app.buttons["gpt-5.4-mini"].tap()
        XCTAssertEqual(app.buttons["agent-thread-model-picker"].value as? String, "gpt-5.4-mini")
        capture(app, "Conversation composer and model")
        app.buttons["agent-thread-send"].tap()
        let sent = app.staticTexts["Keep my draft"]
        reveal(sent, in: app)
        XCTAssertTrue(sent.waitForExistence(timeout: 5))
        sent.press(forDuration: 1)
        app.buttons["Edit and restart"].tap()
        let edit = app.textViews["thread-message-edit-input"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        edit.tap(); edit.typeText(" and edit it")
        capture(app, "Edit latest message")
        app.buttons["Save and restart"].tap()
        XCTAssertTrue(app.staticTexts["Keep my draft and edit it"].waitForExistence(timeout: 5))
        app.buttons["agent-thread-actions"].tap()
        app.buttons["Fork thread"].tap()
        XCTAssertTrue(app.staticTexts["Review conversation controls"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testQuestionOptionsAndCustomAnswer() {
        let app = launchFixture(questions: true)
        let option = app.buttons["thread-question-option-direction-0"]
        reveal(option, in: app)
        XCTAssertTrue(option.waitForExistence(timeout: 5))
        capture(app, "Question option picker")
        option.tap()
        app.buttons["thread-question-next-question"].tap()
        let answer = app.textFields["thread-question-custom-notes"]
        XCTAssertTrue(answer.waitForExistence(timeout: 5))
        answer.tap(); answer.typeText("Keep subagents easy to find")
        capture(app, "Question custom answer")
        app.buttons["thread-question-submit-question"].tap()
        XCTAssertTrue(app.staticTexts["Answer sent"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testSlashModelSuggestions() {
        let app = launchFixture()
        app.buttons["agent-thread-composer-collapsed"].tap()
        let field = app.textViews["agent-thread-composer-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText("/model mini")
        let option = app.buttons["agent-thread-suggestion-model:codex:gpt-5.4-mini"]
        XCTAssertTrue(option.waitForExistence(timeout: 5))
        capture(app, "Composer model suggestions")
        option.tap()
        XCTAssertEqual(app.buttons["agent-thread-model-picker"].value as? String, "gpt-5.4-mini")
        XCTAssertFalse(app.buttons["agent-thread-send"].isEnabled)
        XCTAssertFalse(app.buttons["agent-thread-suggestion-model:codex:gpt-5.4-mini"].exists)
    }

    @MainActor
    func testSubagentQuickPicker() {
        let app = launchFixture(agents: true)
        let pill = app.buttons["agent-thread-subagents"]
        XCTAssertTrue(pill.waitForExistence(timeout: 5))
        XCTAssertEqual(pill.value as? String, "1 working")
        pill.tap()
        XCTAssertTrue(app.buttons["agent-thread-subagent-agent-working"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["agent-thread-subagent-agent-working"].label.contains("Working"))
        XCTAssertTrue(app.buttons["agent-thread-subagent-agent-review"].label.contains("Finished"))
        XCTAssertTrue(app.buttons["agent-thread-subagent-agent-failed"].label.contains("Failed"))
        capture(app, "Subagent quick picker")
        app.buttons["agent-thread-subagent-agent-review"].tap()
        XCTAssertTrue(app.staticTexts["Review conversation controls"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["agent-thread-subagents"].exists)
    }

    @MainActor
    func testImagePasteFromMenuAndMessageField() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitest-conversation", "--conversation-paste"]
        app.launch()
        let expand = app.buttons["agent-thread-composer-collapsed"]
        XCTAssertTrue(expand.waitForExistence(timeout: 5))
        expand.tap()
        let field = app.textViews["agent-thread-composer-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        app.buttons["agent-thread-add-attachment"].tap()
        app.buttons["Paste"].tap()
        let failed = app.buttons["Retry Pasted image.png"]
        XCTAssertTrue(failed.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Remove Pasted image.png"].exists)
        XCTAssertFalse(app.alerts.firstMatch.exists)
        XCTAssertEqual(field.value as? String, "Please review this screenshot.")
        capture(app, "Minimal failed image thumbnail")
        failed.tap()
        XCTAssertTrue(app.alerts["Upload failed"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["The upload URL was unavailable."].exists)
        capture(app, "Native upload failure dialog")
        app.buttons["Retry"].tap()
        XCTAssertTrue(failed.waitForExistence(timeout: 5))
        failed.tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 3))
        app.buttons["Cancel"].tap()
        XCTAssertTrue(failed.waitForNonExistence(timeout: 3))
        field.tap()
        field.press(forDuration: 1)
        let paste = app.menuItems["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 3))
        capture(app, "Paste directly into message")
        paste.tap()
        XCTAssertTrue(app.buttons["Retry Pasted image.png"].waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "Please review this screenshot.")
        capture(app, "Image pasted from message field")
        field.tap()
        field.typeText(" More detail")
        XCTAssertTrue((field.value as? String)?.contains("More detail") == true)
    }

    @MainActor private func launchFixture(questions: Bool = false, agents: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitest-conversation"] + (questions ? ["--conversation-questions"] : []) + (agents ? ["--conversation-agents"] : [])
        app.launch()
        XCTAssertTrue(app.buttons["agent-thread-actions"].waitForExistence(timeout: 10))
        return app
    }
    @MainActor private func reveal(_ element: XCUIElement, in app: XCUIApplication, down: Bool = false) {
        for _ in 0..<5 {
            if element.isHittable { return }
            if down { app.scrollViews.firstMatch.swipeDown() } else { app.scrollViews.firstMatch.swipeUp() }
        }
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
