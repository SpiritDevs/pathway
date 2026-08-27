import SwiftUI

struct AdminAuthorizationApprovalView: View {
    let request: AdminAuthorizationRequest
    let appModel: PathwayAppModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    securityHeader
                    requestDetails
                    confirmationNotice

                    if let errorMessage {
                        errorBanner(errorMessage)
                            .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }
                .frame(maxWidth: 620)
                .padding(.horizontal, 24)
                .padding(.vertical, 28)
                .frame(maxWidth: .infinity)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(request.isImpersonationRenewal ? "Confirm renewal" : "Confirm admin access")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                decisionActions
            }
        }
        .interactiveDismissDisabled()
        .presentationDetents([.large])
        .presentationDragIndicator(.hidden)
        .animation(.default, value: appModel.adminAuthorizationDecisionState)
    }

    private var securityHeader: some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 40, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 76, height: 76)
                .background(Color.accentColor, in: Circle())
                .accessibilityHidden(true)

            VStack(spacing: 8) {
                Text(request.isImpersonationRenewal ? "Renew this impersonation session?" : "Authorize this admin session?")
                    .font(.title2.weight(.bold))
                    .multilineTextAlignment(.center)

                Text(request.isImpersonationRenewal
                    ? "Your active Pathway impersonation session is requesting another 60 minutes. Check the target and session details before deciding."
                    : "Someone is requesting access to the Pathway Admin Dashboard. Check the session details before deciding.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var requestDetails: some View {
        VStack(spacing: 0) {
            if request.isImpersonationRenewal {
                detailRow(
                    title: "Target user",
                    value: renewalTarget,
                    systemImage: "person.crop.circle"
                )
                Divider().padding(.leading, 44)
            }
            detailRow(title: "Browser", value: request.browser ?? "Not provided", systemImage: "safari")
            Divider().padding(.leading, 44)
            detailRow(title: "Operating system", value: request.os ?? "Not provided", systemImage: "desktopcomputer")
            Divider().padding(.leading, 44)
            detailRow(title: "IP address", value: request.ipAddress ?? "Not provided", systemImage: "network")
            Divider().padding(.leading, 44)
            detailRow(
                title: "Requested",
                value: request.requestedDate.formatted(date: .abbreviated, time: .shortened),
                systemImage: "clock"
            )
        }
        .padding(.horizontal, 16)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(request.isImpersonationRenewal ? "Impersonation renewal details" : "Admin session details")
    }

    private var confirmationNotice: some View {
        Label {
            Text("Confirming may ask for Face ID, Touch ID, or your device passcode. Pathway will not authorize the browser until verification succeeds.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } icon: {
            Image(systemName: "faceid")
                .foregroundStyle(Color.accentColor)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
    }

    private var decisionActions: some View {
        VStack(spacing: 12) {
            Button {
                Task { await appModel.approveAdminAuthorizationRequest(request) }
            } label: {
                HStack {
                    if currentDecision == .approved {
                        ProgressView()
                            .tint(.white)
                    }
                    Text(currentDecision == .approved ? "Confirming…" : "Yes, I confirm it’s me")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(isDeciding)
            .accessibilityHint(request.isImpersonationRenewal
                ? "Verifies your identity, then renews the impersonation session for 60 minutes"
                : "Verifies your identity, then authorizes the requesting browser")

            Button(role: .destructive) {
                Task { await appModel.denyAdminAuthorizationRequest(request) }
            } label: {
                HStack {
                    if currentDecision == .denied {
                        ProgressView()
                    }
                    Text(currentDecision == .denied
                        ? "Denying…"
                        : request.isImpersonationRenewal
                            ? "No, end this impersonation"
                            : "No, I don’t know this session")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(isDeciding)
            .accessibilityHint("Denies this request and revokes the requesting browser session")
        }
        .frame(maxWidth: 620)
        .padding(.horizontal, 24)
        .padding(.top, 16)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }

    private var isDeciding: Bool {
        currentDecision != nil
    }

    private var renewalTarget: String {
        let value = [request.targetUserName, request.targetUserEmail]
            .compactMap { $0 }
            .joined(separator: " — ")
        return value.isEmpty ? "Not provided" : value
    }

    private var currentDecision: AdminAuthorizationDecision? {
        guard
            case let .deciding(requestID, decision) = appModel.adminAuthorizationDecisionState,
            requestID == request.requestId
        else { return nil }
        return decision
    }

    private var errorMessage: String? {
        guard
            case let .failed(requestID, message) = appModel.adminAuthorizationDecisionState,
            requestID == request.requestId
        else { return nil }
        return message
    }

    private func detailRow(title: String, value: String, systemImage: String) -> some View {
        LabeledContent {
            Text(value)
                .foregroundStyle(.primary)
                .multilineTextAlignment(.trailing)
        } label: {
            Label(title, systemImage: systemImage)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 14)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(value)
    }

    private func errorBanner(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.footnote)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
            .accessibilityLabel("Authorization error. \(message)")
    }
}
