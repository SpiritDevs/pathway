# Project connections

A Pathway project can have connections on several computers. Pathway normally joins checkouts
automatically when their Git repository matches.

If two project entries were created because their Git remotes disagreed, open the project you want
to keep in **Settings > Projects** and choose **Merge project**. Select the duplicate and then select
the correct Git repository. Pathway moves the duplicate's connections, threads, and issues into the
project you kept.

The selected repository becomes authoritative for every connection. Online environments update the
checkout's Git remote immediately; offline environments apply the choice when they reconnect. Files
and branches in the checkout are not changed.
