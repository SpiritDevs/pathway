# The visible originating thread suppresses local delivery

A client does not play a sound or post an operating-system notification when its window is focused
on the thread that produced the Attention Event. The event still appears in the Notification Tray.
A client showing another thread and other enabled devices remain free to deliver the alert. This
avoids interrupting a user who can already see the state change without turning one client's focus
into an account-wide read or suppression signal.
