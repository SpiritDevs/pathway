# Thread alert subscriptions use cascading overrides

Thread alert eligibility resolves through a global -> project -> thread cascade. The global setting
is explicitly enabled or disabled; project and thread settings are `inherit`, `enabled`, or
`disabled`, and the closest explicit value wins. This supports broad defaults and exceptions without
copying a setting onto every thread. The thread bell displays the effective state, while its menu
also reveals the thread's explicit value so inherited behavior is not mistaken for a local choice.
