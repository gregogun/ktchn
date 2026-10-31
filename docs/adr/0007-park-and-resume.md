# Park and resume, not live waiting

When a run needs the owner, it parks: it ends cleanly, saves its question and agent session, and frees its sandbox. The owner's answer resumes it from that session. The alternative, keeping the run alive while it waits for a reply, is simpler to picture. But it is lost on any restart and holds a sandbox open for hours. Parking survives restarts and costs nothing while it waits. Replies are matched to runs by the Telegram message they answer, not by interpreting them.
