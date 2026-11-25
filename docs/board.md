# Ticket board

> [!NOTE]
> The ticket board is a Labs feature. Each account turns it on in **Settings → Labs**, or a
> self-hosted server turns it on for everyone with `TICKET_BOARD_ENABLED=true` on the API and
> worker. See [Configuration](./self-host-configuration.md).

The board is a shared list of tickets that you and your bots both work from. Open it from **Board**
in the account menu, or from **Board** in Settings on mobile.

Tickets move through **To do**, **In progress**, **In review**, **Blocked**, **Done** and
**Won't do**. Each has a title, description, owner, priority and comments.

Assign a ticket to a bot and it starts working on it. Bots can also create, update and comment on
tickets themselves. Ticket work stays out of your chats, but a bot that needs you still posts a
card in its chat.

A week after a ticket is marked **Done** or **Won't do**, it moves to the archive and leaves the
board. Open **Archive** at the top of the board to see archived tickets. Moving one back out of
Done or Won't do returns it to the board.

A ticket can link the pull requests that deliver it, the issues it tracks, and the repository
the work lives in: paste any of these links on the ticket, or let the bot link the ones it opens
or tracks. Each pull request shows whether it is open, merged or closed, and each issue whether it
is open or closed. If the repository sends pull request and issue events to one of your bots (the
URL and key of a [Git event routine](./routines.md#git-event)), links follow on their own.
Whenever a merge is recorded, by those events or by a bot, and no linked pull request is left
open, the ticket moves to **Done**. Closing an issue never moves the ticket.
