import SwiftUI

struct MobileTrialStatus: Identifiable, Sendable {
    static let totalTrialDays = 14

    let expiryDate: Date
    let daysRemaining: Int
    let upgradeURL: URL

    var id: Date { expiryDate }

    var isExpired: Bool {
        daysRemaining == 0
    }

    var remainingFraction: Double {
        min(
            max(Double(daysRemaining) / Double(Self.totalTrialDays), 0),
            1
        )
    }

    var expiryText: String {
        expiryDate.formatted(date: .long, time: .omitted)
    }

    init?(bootstrap: MobileDashboardBootstrap?) {
        guard
            let bootstrap,
            bootstrap.companyData.subscriptionPlan?.uppercased() == "TRIAL",
            let expiryValue = bootstrap.companyData.details?.trialExpiryDate,
            let expiryDate = Self.parseDate(expiryValue)
        else {
            return nil
        }

        self.expiryDate = expiryDate
        daysRemaining = max(0, Int(ceil(expiryDate.timeIntervalSinceNow / 86_400)))

        let locale = bootstrap.companyData.locale ?? bootstrap.userData.locale ?? "en"
        upgradeURL = AppConfiguration.pathwaySiteURL
            .appending(path: locale)
            .appending(path: "billing")
            .appending(path: "plan-options")
    }

    private static func parseDate(_ value: String) -> Date? {
        let fractionalStyle = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        let standardStyle = Date.ISO8601FormatStyle()
        return (try? fractionalStyle.parse(value)) ?? (try? standardStyle.parse(value))
    }
}

struct TrialCountdownButton: View {
    let trial: MobileTrialStatus
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            TrialCountdownRing(trial: trial, size: 32, lineWidth: 3)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Shows trial details and subscription options")
    }

    private var accessibilityLabel: String {
        if trial.isExpired {
            return "Trial expired"
        }
        return "\(trial.daysRemaining) days left in your trial"
    }
}

private struct TrialCountdownRing: View {
    let trial: MobileTrialStatus
    let size: CGFloat
    let lineWidth: CGFloat

    private var tint: Color {
        trial.isExpired ? .red : .orange
    }

    var body: some View {
        ZStack {
            Circle()
                .stroke(tint.opacity(0.18), lineWidth: lineWidth)

            Circle()
                .trim(from: 0, to: max(trial.remainingFraction, 0.04))
                .stroke(
                    tint,
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))

            Text("\(trial.daysRemaining)")
                .font(.system(size: size * 0.36, weight: .bold, design: .rounded))
                .foregroundStyle(Color.primary)
                .monospacedDigit()
                .minimumScaleFactor(0.7)
        }
        .frame(width: size, height: size)
    }
}

struct TrialSubscriptionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    let trial: MobileTrialStatus

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    TrialCountdownRing(trial: trial, size: 92, lineWidth: 8)
                        .padding(.top, 10)

                    VStack(spacing: 8) {
                        Text(trial.isExpired ? "Your trial has expired" : "Your trial is in progress")
                            .font(.title2.bold())
                            .multilineTextAlignment(.center)

                        Text(expiryDescription)
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }

                    trialProgressCard

                    VStack(spacing: 12) {
                        Button(action: openSubscriptionFlow) {
                            Text("View plans & subscribe")
                                .font(.headline)
                                .frame(maxWidth: .infinity)
                                .frame(height: 50)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.orange)

                        Button("Not now", action: dismiss.callAsFunction)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 28)
            }
            .navigationTitle("Pathway trial")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: dismiss.callAsFunction)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var expiryDescription: String {
        if trial.isExpired {
            return "Your trial expired on \(trial.expiryText). Choose a plan to keep using Pathway."
        }
        return "Your trial ends on \(trial.expiryText). Subscribe before then to keep uninterrupted access."
    }

    private var trialProgressCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(trial.isExpired ? "Trial ended" : "\(trial.daysRemaining) days left in your trial")
                    .font(.headline)

                Spacer(minLength: 8)

                Text("14-day trial")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            ProgressView(value: trial.remainingFraction)
                .tint(trial.isExpired ? .red : .orange)
                .scaleEffect(x: 1, y: 1.6, anchor: .center)
        }
        .padding(18)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .combine)
    }

    private func openSubscriptionFlow() {
        openURL(trial.upgradeURL)
        dismiss()
    }
}
