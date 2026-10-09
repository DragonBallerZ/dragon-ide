# Decide how much the agent may do

The permission chip in the chat composer cycles through four modes:

| Mode | What OpenCode may do |
| --- | --- |
| **Read-Only** | Plan and answer. It may not change files or run commands. Kept to the open project. |
| **Ask** *(default)* | It asks in the chat before each edit or command. Choose **Allow once**, **Always allow** or **Deny**. Kept to the open project. |
| **Project Only** | It edits files and runs commands without asking, but only inside the open project — never the rest of your disk. |
| **Full Access** | It edits files and runs commands without asking, and can reach your whole disk. |

The choice is saved per workspace (`dragon.permissionMode`).
