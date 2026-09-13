# Project workspaces

Creating a project by name gives it a private working folder inside Pathway on the connected
environment. Files stay there across app restarts. Pathway does not create a project folder in
your home directory, and a name-only project does not need a Git repository.

In the action palette’s Environment section, choose **Add directory** when you want to use your
own folder. You can keep earlier files in the Pathway workspace or copy them into the attached
directory. Copying never overwrites existing destination files. Stop any active agent work before
changing directories.

After attachment, the project directory appears above the retained Pathway workspace. Both stay
connected so your agent can reference earlier files. the disconnect button beside **Temporary directory** removes that
connection but preserves the files on the environment. You can only disconnect it after attaching
your own directory. Your project and thread history stay the same.

Git and worktree controls become available for the attached project directory. All folder choices
refer to the environment running the project, including when you connect remotely.

Click **Temporary directory** to browse its files in the sidebar. Cmd-click on macOS or Ctrl-click
on other platforms opens it in the environment’s file manager. Editor and project-script actions
are shown after you attach your own directory.
