import Foundation

struct PathwayQuestionReply: Equatable, Sendable {
    struct Answer: Equatable, Sendable {
        let question: String
        let answer: String
    }

    let answers: [Answer]
    var copyText: String {
        answers.map { "\($0.question)\n\($0.answer)" }.joined(separator: "\n\n")
    }

    static func isGenerated(messageID: String?, creationSource: String?) -> Bool {
        creationSource == "server" && messageID?.hasPrefix("message:question-answer:") == true
    }

    init?(text: String?, messageID: String?, creationSource: String?) {
        guard Self.isGenerated(messageID: messageID, creationSource: creationSource),
              let text, let data = text.data(using: .utf8),
              let envelope = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              envelope["request_user_input_async"] is String,
              let entries = envelope["answers"] as? [[String: Any]], !entries.isEmpty else { return nil }
        var answers: [Answer] = []
        for entry in entries {
            guard let question = entry["question"] as? String else { return nil }
            let answer: String
            if let value = entry["answer"] as? String {
                answer = value
            } else if let values = entry["answer"] as? [String], !values.isEmpty,
                      values.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
                answer = values.joined(separator: "\n")
            } else { return nil }
            answers.append(Answer(question: question, answer: answer))
        }
        self.answers = answers
    }
}
