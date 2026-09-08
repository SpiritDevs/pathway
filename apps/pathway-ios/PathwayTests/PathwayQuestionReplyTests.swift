import Foundation
@testable import Pathway
import Testing

struct PathwayQuestionReplyTests {
    private let messageID = "message:question-answer:request-1"
    private let text = #"{"request_user_input_async":"call-1","answers":[{"question":"Which regions?","answer":["Sydney","Melbourne"]},{"question":"When?","answer":"Today"}]}"#

    @Test func formatsAndCopiesStringAndArrayAnswers() throws {
        let reply = try #require(PathwayQuestionReply(text: text, messageID: messageID, creationSource: "server"))
        #expect(reply.answers.count == 2)
        #expect(reply.answers[0].answer == "Sydney\nMelbourne")
        #expect(reply.copyText == "Which regions?\nSydney\nMelbourne\n\nWhen?\nToday")
    }

    @Test func doesNotInterpretPastedJSONAsAReply() {
        #expect(PathwayQuestionReply(text: text, messageID: messageID, creationSource: "mobile") == nil)
        #expect(PathwayQuestionReply(text: text, messageID: "message-1", creationSource: "server") == nil)
        #expect(PathwayQuestionReply(text: text, messageID: messageID, creationSource: nil) == nil)
    }

    @Test(arguments: ["[]", "[42]", #"[" "]"#, #"["Sydney",42]"#, "null", "{}"])
    func malformedAnswersKeepRawText(answer: String) {
        let text = "{\"request_user_input_async\":\"call\",\"answers\":[{\"question\":\"Region?\",\"answer\":\(answer)}]}"
        #expect(PathwayQuestionReply(text: text, messageID: messageID, creationSource: "server") == nil)
    }

    @Test func generatedIdentityDoesNotDependOnValidJSON() {
        #expect(PathwayQuestionReply.isGenerated(messageID: messageID, creationSource: "server"))
        #expect(!PathwayQuestionReply.isGenerated(messageID: messageID, creationSource: "mobile"))
        #expect(PathwayQuestionReply(text: "broken", messageID: messageID, creationSource: "server") == nil)
    }
}
