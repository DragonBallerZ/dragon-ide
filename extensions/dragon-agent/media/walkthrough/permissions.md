# Decide how much the agent may do

The permission chip in the chat composer cycles through three modes:

| Mode | What OpenCode may do |
| --- | --- |
| **Read-Only** | Plan and answer. It may not change files or run commands. |
| **Ask** *(default)* | It asks in the chat before each edit or command. Choose **Allow once**, **Always allow** or **Deny**. |
| **Full Access** | It edits files and runs commands without asking. |

The choice is saved per workspace (`dragon.permissionMode`).
