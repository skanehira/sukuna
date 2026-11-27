import { z } from "zod";
import { timelineInputCommentSchema } from "../progress/schema";

export const sendConversationMessageSchema = z.object({
  text: z.string(),
  images: z.array(z.string()).max(20),
  mode: z.enum(["send", "interrupt"]),
  clientMessageId: z.string().min(1),
  timeline_comments: z.array(timelineInputCommentSchema).optional(),
});
