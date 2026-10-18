import { memo } from "react";

import type { DeletedBy, Msg } from "../../../workers/protocol";
import { clockTime, cn, handleColour } from "~/lib/utils";

export interface MessageRowProps {
  msg: Msg;
  /** Your own handle: colours you brand orange and changes which actions show. */
  self: string;
  blocked: boolean;
  /** Null while the message is still in the room. */
  deleted: DeletedBy | null;
  reported: boolean;
  onReport: (msg: Msg) => void;
  onBlock: (who: string) => void;
  onWithdraw: (msg: Msg) => void;
  onMention?: (who: string) => void;
}

function Row({
  msg,
  self,
  blocked,
  deleted,
  reported,
  onReport,
  onBlock,
  onWithdraw,
  onMention,
}: MessageRowProps) {
  const mine = msg.who === self;
  const actionable = !mine && !deleted && !blocked;
  // A withdrawn message still renders, so the conversation around it reads.
  const withdrawable = mine && !deleted;

  const mentioned =
    !mine &&
    !deleted &&
    !blocked &&
    Boolean(self) &&
    msg.body.toLowerCase().includes(`@${self.toLowerCase()}`);

  let body = msg.body;
  if (deleted === "author") body = "message withdrawn by its author";
  else if (deleted) body = "message removed by a moderator";
  else if (blocked) body = "you blocked this person";

  return (
    <div
      className={cn(
        "row",
        deleted && "deleted",
        blocked && "blocked",
        mentioned && "flagged",
      )}
    >
      {blocked ? (
        <span className="row-handle">blocked:</span>
      ) : onMention && !mine ? (
        <button
          type="button"
          className="row-handle cursor-pointer border-0 bg-transparent p-0 text-left hover:underline"
          style={{ color: handleColour(msg.who, self) }}
          title={`Mention @${msg.who}`}
          onClick={() => onMention(msg.who)}
        >
          {msg.who}:
        </button>
      ) : (
        <span
          className="row-handle"
          style={{ color: handleColour(msg.who, self) }}
        >
          {msg.who}:
        </span>
      )}
      <span className="row-body">{body}</span>
      <span className="row-time">{clockTime(msg.at)}</span>

      {actionable ? (
        <div className="row-act">
          <button
            type="button"
            className="row-btn disabled:cursor-default disabled:opacity-60"
            disabled={reported}
            aria-label={
              reported
                ? `Message from ${msg.who} already reported`
                : `Report message from ${msg.who}`
            }
            onClick={() => onReport(msg)}
          >
            {reported ? "reported" : "report"}
          </button>
          <button
            type="button"
            className="row-btn danger"
            aria-label={`Block ${msg.who}`}
            title="Hides their messages on this device. They stay in the room."
            onClick={() => onBlock(msg.who)}
          >
            block
          </button>
        </div>
      ) : null}

      {withdrawable ? (
        <div className="row-act">
          <button
            type="button"
            className="row-btn"
            aria-label="Withdraw this message"
            title="Takes it out of the room for everyone. Moderators keep a record."
            onClick={() => onWithdraw(msg)}
          >
            withdraw
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Memoised because the log is never rebuilt: appending one message must leave
 * every existing row's element untouched, which only holds if the props of the
 * untouched rows are referentially stable.
 */
export const MessageRow = memo(Row);
